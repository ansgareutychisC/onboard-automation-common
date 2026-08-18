# Revamp Plan — onboard-automation-common v2

**Status:** Draft, pending user approval
**Date:** 2026-08-18
**Author:** Super Z (with warm context from prior sessions)

## 1. What we learned from the notion v0.7 stabilization

The notion repo went through 28 commits and 5 version tags (v0.7.0 → v0.7.5) trying to stabilize. The commit messages tell the story:

- `Worker: disable WS (DO free-tier duration limit)` — CF Worker Durable Objects can't sustain WS on the free tier. WS is empirically dead for this use case.
- `Stateless Worker architecture: D1 command queue, no DO needed` — they pivoted to HTTP polling via D1.
- `Fix infinite reconnect loop (P0)` + `Fix reconnect storm` + `stale WS guard` — the hybrid WS+HTTP fallback had multiple P0 regressions.
- `P0: Fix email code regex — Notion changed from 6-digit to 6-char alphanumeric` — email templates change without notice. The regex broke.
- `Robust multi-layer code extraction with validation + LLM escape hatch` — they added fallback layers, but the "LLM escape hatch" is a TODO, not implemented.
- `Python bridge: full standalone backend with local SQLite` — they built a Python alternative, but it can't stay running from the sandbox.

**Email verification is the single biggest source of fragility.** The regex is hardcoded in 4 places:
1. `notion_onboarding/signup/email_worker.py:76-110` (Python side, 3-layer extraction)
2. `extension/macros/signup-onboard.json:113-118` (JS source embedded in an `eval` step — invisible to the user)
3. `extension/popup.js:250-258` (DEFAULT_INPUTS — the popup's default regex string)
4. `scripts/run_bridge_aiohttp.py:1165-1167` (daemon-side fallback)

When Notion changed 6-digit → 6-char alphanumeric, all 4 places had to be updated in lockstep. The user lived through this. We must not repeat it.

## 2. Refined design — principles

1. **Extension-first.** The extension is the primary tool. It runs standalone — no backend required for testing or for running preset macros.
2. **HTTP-only for production (CF Worker).** WS is empirically dead on CF free tier (DO duration limit, 5+ P0 reconnect bugs). The CF Worker dashboard uses HTTP only — extension polls a Turso `command_queue` table, no WS, no DO.
3. **WS stays for the Python dev daemon (local only).** The Python daemon is strictly a local dev/test tool — NOT for production. It exposes WS so an agent (or a developer) can drive the extension interactively for debugging, probing, reverse-engineering, and macro authoring. The daemon is also a reference implementation: its HTTP API surface mirrors the CF Worker's, so tests pass against either. When an agent like me needs to inspect a live browser state, we point the extension at the Python daemon via WS and send commands like `tabs.list` / `form.eval` / `screenshot` / `debug.har.start` interactively — the logs are right there in the terminal.
4. **Macro-chunked.** Each operation is a standalone JSON macro file. Signup, email-verify, create-workspace, create-webhook, activate-trial — each is its own file. Verified individually, then composed into flows.
5. **Email verification is a first-class reusable chunk** — not embedded in a signup macro. Takes configurable inputs: email worker URL, token, address, regex, subject filter, poll interval, timeout. Other macros call it via a "playlist" or reference its outputs.
6. **Turso direct for MVP.** Extension writes per-step results + captured tokens directly to Turso (libSQL HTTP API). No backend, no CF Worker, no Python daemon required for the MVP. Generous free tier, survives container recycles.
7. **CF Worker dashboard comes later** (Phase 2). Reads from the same Turso DB. Provides CRUD UX + can trigger macros by writing to a `command_queue` table the extension polls. No WS — pure HTTP via Turso.
8. **Per-service preset macros.** When a chunk is verified end-to-end against a live service, it gets saved under `extension/macros/<service>/<chunk>.json`. The popup shows a per-service preset picker.
9. **Detailed logs always on.** Every step logs structured events. Extension keeps a ring buffer (500 entries). Optionally pushes to Turso for permanent record. The popup renders a per-step checklist + raw log.

## 3. Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│                       Chrome MV3 Extension                         │
│                                                                    │
│   ┌──────────────┐  ┌──────────────┐  ┌────────────────────────┐ │
│   │ Macro Runner │  │ Popup UI     │  │ HTTP Client (fetch)     │ │
│   │ (fork from   │  │ - macro paste│  │ - Turso HTTP API       │ │
│   │  notion v0.7)│  │ - preset load│  │ - email worker HTTP    │ │
│   │              │  │ - step logs │  │ - target service HTTP  │ │
│   │              │  │ - config    │  │ - (Phase 2) Worker HTTP│ │
│   └──────────────┘  └──────────────┘  └────────────────────────┘ │
│   ┌──────────────────────────────────────────────────────────┐  │
│   │ WS Client (optional — for dev/debug with Python daemon)   │  │
│   │ Connect to ws://127.0.0.1:8787 (or any agent-controlled   │  │
│   │ Python daemon). Receive commands, send results back.      │  │
│   │ DISABLED when devUrl is empty.                            │  │
│   └──────────────────────────────────────────────────────────┘  │
│                                                                    │
│   Config (chrome.storage.local):                                   │
│   - emailWorkerUrl, emailWorkerToken, emailDomain (REQUIRED)       │
│   - codeRegex (with sensible default, overridable per macro)      │
│   - tursoUrl, tursoToken (OPTIONAL — empty = no persistence)      │
│   - workerUrl (OPTIONAL — empty = no command source, Phase 2)    │
│   - devUrl (OPTIONAL — empty = standalone; WS to Python daemon)   │
└────────────────────────────────────────────────────────────────────┘
   │              │              │              │
   │ (optional,   │ (optional,    │ (optional,    │ (optional, WS —
   │  HTTP)        │  HTTP)         │  HTTP)         │  dev/debug only)
   ▼              ▼              ▼              ▼
┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────────────┐
│ Turso      │ │ CF Worker │ │ Email      │ │ Python dev daemon   │
│ (libSQL)   │ │ (Phase 2) │ │ Worker     │ │ (LOCAL DEV ONLY)    │
│            │ │            │ │ (existing) │ │ - WS for interactive │
│ - macro_   │ │ - dashboard│ │            │ │   agent-driven debug │
│   runs     │ │ - CRUD     │ │            │ │ - HTTP API mirrors  │
│ - step_    │ │ - trigger  │ │            │ │   CF Worker          │
│   results  │ │   via D1   │ │            │ │ - SQLite mirror of  │
│ - accounts │ │   queue    │ │            │ │   Turso schema       │
│            │ │ - NO WS    │ │            │ │ - logs to stdout     │
│            │ │ - NO DO    │ │            │ │   (agent can tail)   │
└────────────┘ └────────────┘ └────────────┘ └────────────────────┘
```

**Three connection modes for the extension (mutually compatible):**

1. **Standalone** — `devUrl` empty, `workerUrl` empty. Runs macros from the popup, writes results to Turso (if `tursoUrl` set). No command source. This is the MVP distribution shape: ship the extension + a JSON macro, user runs it.
2. **Dev/debug via Python daemon (WS)** — `devUrl = ws://127.0.0.1:8787`. An agent (or developer) starts the Python daemon locally, the extension connects via WS, the agent sends commands interactively (`tabs.list`, `form.eval`, `screenshot`, `debug.har.start`). Logs stream to the daemon's stdout — agent can tail them directly. **Strictly local dev/test, never production.** This is the workflow for: initial macro authoring against a new service, debugging a broken step, reverse-engineering an API by probing the live browser.
3. **Production via CF Worker (HTTP, Phase 2)** — `workerUrl = https://your-worker.workers.dev`. Extension polls `GET /api/poll` for queued commands, POSTs results to `/api/result`. No WS. Used when you want fleet-scale orchestration (multiple browsers, multiple accounts, dashboard-triggered flows).

The WS code in the extension is GATED on `devUrl` being set. When it's empty, no WS code runs — no reconnect storms, no DO dependency. The WS path is purely additive to the standalone mode.

## 4. Macro chunking strategy

Each macro is a self-contained JSON file. The directory structure:

```
extension/macros/
  _shared/
    wait-for-verification-email.json    ← THE reusable email chunk (critical)
    poll-email-worker.json               ← low-level polling primitive
    clear-cookies-for-domain.json        ← pre-signup cleanup
  notion/
    signup.json                          ← notion-specific signup
    create-workspace.json
    activate-trial.json
    create-api-key.json
    full-onboarding.json                 ← playlist runs the above in order
  supabase/
    signup.json
    create-org.json
    create-pat.json
    full-onboarding.json
  todoist/
    signup.json                          ← pure HTTP, no DOM, no captcha
    create-team.json
    disable-email-spam.json
```

**Composition:** the macro format doesn't natively support macros-calling-macros (and we should NOT add that — it's a complexity trap). Instead, "full-onboarding.json" is a flat macro that inlines the steps from each chunk (the chunks are also runnable standalone for testing). The popup's "preset picker" can run them in sequence.

Alternative (simpler): the popup just runs N macros in sequence. The "playlist" is a UI concept, not a macro format concept.

## 5. Email verification — the critical reusable chunk

This is the user's #1 concern. Current state: hardcoded in 4 places, regex broke when Notion changed the format, "LLM escape hatch" is a TODO.

**Fix:** the extraction logic is just an `eval` step in the macro. Each service's macro defines its own extraction JS — notion's knows Notion's format, supabase's knows supabase's, todoist's knows todoist's. No generic multi-layer regex baked into the extension — the extension just runs whatever JS the macro provides via the existing `eval` cmd (CDP `Runtime.evaluate` in a tab's main world, MV3-safe).

**Per-domain email worker:** each custom domain has its own email worker (we don't always use `privatimail.com`). The email worker URL is a macro input — configured per-service, per-domain. The popup's config panel lets the user set the default; individual macros can override.

**Macro: `extension/macros/_shared/wait-for-verification-email.json`**

```jsonc
{
  "name": "Wait for verification email",
  "description": "Polls the email worker for a verification code/link. Service-agnostic — the extraction logic is an eval step the calling macro overrides. The email worker URL is an input (each custom domain has its own worker).",
  "inputs": {
    "emailWorkerUrl": "",      // popup pre-fills from chrome.storage.local; each domain has its own worker
    "emailWorkerToken": "",   // popup pre-fills
    "address": "",            // the email address to poll
    "extractionJs": "",       // the JS function body that extracts the code from the email body — per-service
    "subjectFilter": "",      // optional regex to filter emails by subject
    "pollIntervalMs": 3000,
    "timeoutMs": 180000,
    "sinceMs": 0              // only consider emails received after this timestamp
  },
  "steps": [
    {
      "id": "poll-for-code",
      "cmd": "retry",
      "timeoutMs": "{{inputs.timeoutMs}}",
      "intervalMs": "{{inputs.pollIntervalMs}}",
      "condition": "result && result.code != null",
      "steps": [
        {
          "id": "fetch-emails",
          "cmd": "fetch",
          "url": "{{inputs.emailWorkerUrl}}/emails?address={{inputs.address}}&limit=5&include_body=true",
          "method": "GET",
          "headers": { "Authorization": "Bearer {{inputs.emailWorkerToken}}" }
        },
        {
          "id": "extract-code",
          "cmd": "eval",
          "function": "{{inputs.extractionJs}}",
          "args": {
            "body": "{{fetch-emails.body}}",
            "subjectFilter": "{{inputs.subjectFilter}}",
            "sinceMs": "{{inputs.sinceMs}}"
          }
        }
      ]
    }
  ]
}
```

**The `extractionJs` is provided by the calling service's macro** — it's a function body like:

```js
// Notion's extraction (lives in macros/notion/signup.json as an input override)
(args) => {
  const emails = JSON.parse(args.body).results || [];
  for (const em of emails.reverse()) {
    const emMs = Date.parse(em.date || em.created_at || 0) || 0;
    if (args.sinceMs && emMs < args.sinceMs) continue;
    const text = (em.text_body || '') + '\n' + (em.html_body || '');
    // Notion changed from 6-digit to 6-char alphanumeric — use the new pattern
    const m = text.match(/(?:login code|verification code|temporary code|passcode)[^0-9A-Za-z]{0,30}([0-9A-Za-z]{6})/i);
    if (m && m[1]) return { code: m[1], source: 'notion-contextual', emailId: em.id };
  }
  return { code: null, source: 'not-found', emailCount: emails.length };
}
```

```js
// Todoist's extraction (lives in macros/todoist/signup.json — different format, different regex)
(args) => {
  const emails = JSON.parse(args.body).results || [];
  for (const em of emails.reverse()) {
    const text = (em.text_body || '') + '\n' + (em.html_body || '');
    // Todoist uses a UUID email_token in a verify link
    const m = text.match(/https:\/\/app\.todoist\.com\/api\/v\d+(?:\.\d+)?\/verify_email\?email_token=([0-9a-fA-F-]{36})/i);
    if (m && m[1]) return { code: m[1], source: 'todoist-verify-link', emailId: em.id };
  }
  return { code: null, source: 'not-found', emailCount: emails.length };
}
```

**Why this fixes the user's pain:**
- The extraction logic is per-service, per-macro — notion's regex lives in `macros/notion/signup.json`, todoist's lives in `macros/todoist/signup.json`. When Notion changes the format, you edit ONE JSON file. No extension code changes.
- The extension just provides the `eval` primitive (already exists) — no service-specific extraction logic baked in.
- Each custom domain's email worker URL is a popup config field + macro input — no hardcoded `privatimail.com`.
- If a service's email format is too complex for a single regex, the `extractionJs` can be arbitrarily complex JS — full DOM parsing, multi-layer fallback, even fetch additional URLs. Whatever the macro author writes, the extension runs.
- A micro-service for email parsing is overkill — the extension is already a JS runtime. We just use it.

## 6. Implementation plan — next session

### Phase 1: Extension + Turso MVP (no backend, ~1 session)

**Step 1: Fork and gate the notion v0.7 extension** (~45 min)
- Copy `notion-onboarding-automation/extension/` (at `origin/main`, commit `129dc11`) into `onboard-automation-common/extension-v2/`
- Rename manifest to "Onboard Automation Bridge"
- KEEP the WS connection logic in `background.js` — but GATE it on `devUrl` being non-empty. When `devUrl` is empty (the default), no WS code runs, no reconnect attempts, no DO dependency. The extension is purely standalone.
- KEEP the HTTP polling fallback logic too — it's needed for Phase 2 (CF Worker HTTP mode). Also gated on `workerUrl`.
- Add a new config field `devUrl` (WS to Python daemon) alongside the existing `workerUrl` (HTTP to CF Worker).
- The macro runner, command handlers, popup UI all stay verbatim from notion v0.7 — battle-tested, no changes.
- Result: extension supports 3 modes (standalone / dev-WS / production-HTTP) via config flags, no code paths removed.

**Step 2: Add Turso HTTP client** (~1 hr)
- New file `extension/lib/turso.js` — wraps Turso's HTTP API
- Methods: `execute(sql, args)`, `query(sql, args)` — returns rows
- Reads `tursoUrl` + `tursoToken` from `chrome.storage.local`
- If either is empty, all Turso methods become no-ops (extension still works standalone)
- Schema (created on first use):
  ```sql
  CREATE TABLE IF NOT EXISTS macro_runs (
    id TEXT PRIMARY KEY,           -- UUID generated by extension
    service TEXT,                  -- "notion" / "supabase" / "todoist"
    macro_name TEXT,               -- "signup" / "create-workspace" / etc.
    inputs TEXT,                   -- JSON
    started_at INTEGER,
    finished_at INTEGER,
    ok INTEGER,                    -- 0 or 1
    error TEXT
  );
  CREATE TABLE IF NOT EXISTS step_results (
    run_id TEXT,
    step_id TEXT,
    step_cmd TEXT,
    ok INTEGER,
    result TEXT,                  -- JSON
    duration_ms INTEGER,
    PRIMARY KEY (run_id, step_id)
  );
  CREATE TABLE IF NOT EXISTS captured_tokens (
    service TEXT,
    email TEXT,
    token_type TEXT,              -- "pat" / "access_token" / "session_cookie" / etc.
    token_value TEXT,
    captured_at INTEGER,
    PRIMARY KEY (service, email, token_type)
  );
  ```

**Step 3: Refactor email verification into a reusable chunk** (~1 hr)
- Create `extension/macros/_shared/wait-for-verification-email.json` (as specified in §5 above)
- Extract the multi-layer extraction JS into a single `eval` function in this macro
- Remove the duplicate regex from `signup-onboard.json` (replaced by a `{{wait-for-verification-email.code}}` reference — or inline the chunk's steps into the signup macro)
- Add a `codeRegex` field to the popup's config panel, with the default regex pre-filled but editable

**Step 4: Break signup-onboard.json into chunks** (~1 hr)
- Split the 34-step monolith into:
  - `notion/signup.json` — tabs.open + form.fill + form.click + xhr.intercept signup response
  - `_shared/wait-for-verification-email.json` — the reusable chunk from Step 3
  - `notion/create-workspace.json` — already exists as a separate file
  - `notion/activate-trial.json` — already exists
  - `notion/create-api-key.json` — already exists
  - `notion/full-onboarding.json` — flat playlist that inlines all the above in order
- Each chunk is independently runnable for testing

**Step 5: Popup config panel** (~1 hr)
- Add a "Config" section to `popup.html` with fields:
  - Email Worker URL (default: `https://mail-api.privatimail.com`)
  - Email Worker Token (default: empty — user pastes)
  - Email Domain (default: `privatimail.com`)
  - Code Regex (default: the multi-layer pattern, editable)
  - Turso URL (optional)
  - Turso Token (optional)
- All persisted to `chrome.storage.local`
- The macro `inputs` are pre-filled from these config values when a macro runs

**Step 6: Per-step logging UI** (~30 min — already mostly exists in notion v0.7)
- Keep the existing per-step checklist UI from notion v0.7's popup
- Add: each step's result is optionally pushed to Turso `step_results` table (if Turso configured)
- Add: a "raw log" tab that shows the structured log entries (timestamped, filterable by level)

### Phase 2: CF Worker dashboard (optional, later)
- Deploy a CF Worker that reads from the same Turso DB
- Provides HTML dashboard for CRUD UX on `macro_runs`, `step_results`, `captured_tokens`
- Can trigger macros by writing to a `command_queue` table in Turso (extension polls this table every N seconds via HTTP fetch)
- No WS, no DO — pure HTTP via Turso

### Phase 3: Backend-only flows (todoist)
- Write `extension/macros/todoist/signup.json` — pure `fetch` steps, no DOM, no captcha
- The macro runner already supports this — no extension changes needed
- If todoist's pure-HTTP flow doesn't need the extension at all, just run the macro via the extension for unified logging + Turso persistence

## 7. What we keep from notion v0.7 vs what we rewrite

**Keep (battle-tested, works):**
- The macro runner (`background.js:1186-1530` — `handleMacroRun`, `executeMacroStep`, `executeRetryBlock`, `resolveTemplate*`, `summarizeResult`)
- The 16 command handlers (`fetch`, `page.fetch`, `tabs.*`, `form.*`, `xhr.intercept`, `cookies.*`, `screenshot`, `getCaptchaToken`, `sandbox.open`, `eval`, `wait`, `log`, `retry`)
- The popup's macro replay UI (paste JSON, run, see per-step results)
- The 4 notion preset macros as reference (we'll chunk them but the step content is verified)
- The `chrome.debugger` CDP integration for `form.eval` and `xhr.intercept`

**Rewrite:**
- Connection layer: rip out WS entirely, replace with "extension is standalone, optionally polls a Turso `command_queue` table"
- Email verification: extract from 4 hardcoded places into 1 reusable macro chunk with configurable regex
- popup config: add the email worker + Turso config panel
- Persistence: add Turso HTTP client (new)

**Discard:**
- The notion-specific manifest name + branding
- The CF Worker DO (free-tier WS doesn't work — empirically confirmed)
- My untested v1 chassis (`onboard-automation-common/extension/` etc.) — keep as design reference under `docs/v1-design/` only

**Keep as dev tool (not production):**
- The Python daemon (`scripts/run_bridge_aiohttp.py` from notion v0.7, + `daemon_bridge.py` launcher) — strictly local dev/test, exposes WS for agent-driven interactive debugging. Not deployed. Not for production. The agent starts it on demand, points the extension at `ws://127.0.0.1:8787`, sends commands interactively, tails the logs. HTTP API surface mirrors the Phase 2 CF Worker so tests pass against either.
- The WS reconnection logic in the extension — kept but gated on `devUrl`. When devUrl is empty (default), no WS code runs. The 5+ P0 reconnect bugs from notion v0.7 only fire when WS is actually in use (dev mode), where they're tolerable because the agent can see the logs and recover. Production (CF Worker HTTP mode) doesn't touch the WS path.

## 8. Concrete file structure (target)

```
onboard-automation-common/
  extension-v2/                          ← the actual extension (Phase 1)
    manifest.json                        ← "Onboard Automation Bridge", no service-specific branding
    background.js                        ← fork from notion v0.7, WS gated on devUrl
    popup.html                           ← + config panel
    popup.js                             ← + config panel + Turso write hooks
    sandbox.html / sandbox.js            ← keep for zstd-native fetch
    lib/
      macro-runner.js                    ← extracted from background.js (or keep inline)
      turso.js                           ← NEW — Turso HTTP client
      url.js                              ← shared URL helpers
      logger.js                           ← structured logger (optional extract)
    handlers/                             ← keep from notion v0.7 (or inline)
      fetch.js, tabs.js, form.js, xhr.js,
      cookies.js, screenshot.js, captcha.js,
      sandbox.js, debug.js, eval.js
    macros/                               ← the chunked macros
      _shared/
        wait-for-verification-email.json  ← THE critical reusable chunk
        poll-email-worker.json
        clear-cookies-for-domain.json
      notion/
        signup.json
        create-workspace.json
        activate-trial.json
        create-api-key.json
        full-onboarding.json
      supabase/                           ← draft in Phase 1, verify in Phase 2
        signup.json
        create-org.json
        create-pat.json
      todoist/                            ← draft in Phase 3
        signup.json
        create-team.json
    icons/

  python-dev-daemon/                     ← LOCAL DEV ONLY (Phase 1, alongside extension)
    run_bridge.py                        ← fork from notion v0.7's run_bridge_aiohttp.py
    daemon_bridge.py                     ← double-fork launcher (survives shell exits)
    onboard_common/                      ← the Python client (for agent use)
      extension_bridge.py                ← async client with run_macro() + all commands
      protocol.py                        ← Python types matching the macro JSON schema
      exceptions.py                      ← typed exception hierarchy
    requirements.txt
    README.md                            ← "LOCAL DEV ONLY — not for production"

  worker-v2/                              ← Phase 2 (CF Worker dashboard, HTTP-only)
    src/
      index.ts                            ← Hono router, reads from Turso
      dashboard.ts                        ← HTML dashboard
    wrangler.toml
    migrations/                            ← empty — Turso holds the schema

  docs/
    v1-design/                             ← my old untested chassis, kept as reference
      extension/, worker-template/, python-template/, docs/
    REVAMP-PLAN.md                         ← this file
    MACROS.md                              ← fork from notion v0.7, updated for chunking
    EMAIL-VERIFICATION.md                  ← the multi-layer extraction strategy, documented
    ARCHITECTURE-v2.md                     ← the diagram in §3 above, expanded

  scripts/
    test_macro_dryrun.js                  ← the missing test harness from notion v0.7
    test_macro_dryrun.py                  ← Python port
    test_email_extraction.py              ← unit test the multi-layer regex
```

## 9. Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Turso HTTP API rate limits | The extension writes once per macro run (a few rows). Far below limits. |
| Macro runner bugs from the fork | The fork is verbatim from notion v0.7 which has been live-tested. We're stripping code, not adding it. |
| Email regex still breaks when a service changes | Multi-layer fallback (user regex → contextual keyword → bare pattern → future LLM). The user can edit the regex in the popup without code changes. |
| Turso token leaks | Stored in `chrome.storage.local` (encrypted at rest by Chrome). Token is scoped to the Turso DB only. |
| No backend means no orchestration across multiple extensions | Acceptable for MVP. Phase 2 adds the `command_queue` table in Turso for orchestration. |

## 10. Open questions for the user — ANSWERED

1. **Turso account** — ✅ User provided a token. The token is NOT committed to git (it's a JWT granting account access). It will be configured via the popup's config panel and stored in `chrome.storage.local`. For automated testing, a `.env` file (gitignored) can hold it.
2. **Repo structure** — ✅ "Keep current, just update in place, no one uses anything here, replace with whatever it should be." So: delete the v1 `extension/`, `worker-template/`, `python-template/`, and v1 docs in-place. Fork notion v0.7's extension into the same `extension/` path. No `docs/v1-design/` reference folder — the v1 chassis is just gone.
3. **Email worker** — ✅ "Each custom domain has its own worker, we don't always just use privatimail.com." The email worker URL is a per-macro input + a popup config field. No hardcoded `privatimail.com` anywhere.
4. **Code regex pattern** — ✅ "Keep it flexible. WE DON'T KNOW WHAT THE NEXT SERVICE USES! Once we know we write that regex which should be part of that macro definition. One of the action should support this extraction. Ideally we can run eval and js so we can do anything on extension side for these email processing, almost like what the backend is doing for the email processing we just do it directly inside extension." → The extraction logic is an `eval` step in each service's macro. No generic multi-layer regex baked into the extension. The extension just provides the `eval` primitive (already exists via CDP `Runtime.evaluate`).
5. **WS scope** — ✅ Confirmed: WS stays for Python dev daemon (local only). CF Worker is HTTP-only. Extension gates WS on `devUrl`.
6. **Start** — ✅ "Start this, keep notion as the first tenant, but then supabase, todoist, and we will onboard more, so keep your kit generalized." → Begin Phase 1 implementation now. Notion is the first service to verify; the kit must remain generalized for supabase, todoist, and future services.

## 11. Next session kickoff checklist

Before starting Phase 1 implementation:
- [ ] User confirms the plan (especially §10 questions)
- [ ] Pull the latest notion v0.7 commit (`git fetch && git checkout origin/main` in the analysis repo)
- [ ] Verify the macro runner code at `background.js:1186-1530` is still the shape we expect
- [ ] Create the `extension-v2/` directory in the repo
- [ ] Start with Step 1 (fork + strip) — this is the foundation everything else builds on
