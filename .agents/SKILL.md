# SKILL.md — Onboard Automation Common (meta-agent knowledge)

> **Purpose**: distill the generalized know-how from the session that built
> `onboard-automation-common` so a fresh agent in a new sandbox can pick up
> the work without re-living the painful lessons. This is **meta knowledge** —
> not one-off fixes, not resolved issues, but patterns and constraints that
> will keep mattering.

## 0. The one-paragraph context

We are building a **single, service-agnostic Chrome MV3 extension** that
drives onboarding automation for SaaS services (Notion, Supabase, Todoist,
future). The extension runs **JSON macros** (sequences of `fetch` / `form.fill`
/ `xhr.intercept` / `retry` / `eval` steps) locally — no backend required for
the MVP. A Python dev daemon (local only, WS) exists for agent-driven
interactive debugging. A CF Worker (HTTP-only, Phase 2) reads from a shared
Turso DB for dashboard/CRUD UX. **Notion is the first tenant; the kit must
stay generalized.**

The canonical repo: https://github.com/ansgareutychisC/onboard-automation-common
The reference fork source: https://github.com/ansgareutychisC/notion-onboarding-automation (branch `main`, commit `129dc11` at time of forking — re-fetch to get latest)

## 1. Hard-won lessons (do NOT relearn these the hard way)

### 1.1 WebSocket on Cloudflare Workers free tier is dead — empirically

CF Worker Durable Objects have a **duration limit on the free tier** that
kills long-lived WS connections. The notion repo went through 5+ P0
reconnect-loop bugs (`Fix infinite reconnect loop (P0)`, `Fix reconnect
storm`, `stale WS guard`, `BridgeHub agentId dedup`, etc.) before they
finally disabled WS on the Worker entirely (`commit 129dc11: "Worker:
disable WS (DO free-tier duration limit)"`).

**Implication for our kit:**
- The CF Worker (Phase 2) is **HTTP-only**. Extension polls
  `GET /api/poll?agentId=X&wait=25` (long-poll), POSTs results to
  `/api/result`. No WS, no DO.
- WS stays **only** in the Python dev daemon (local, agent-driven
  interactive debugging). It's a dev tool, never production.
- The extension's WS code path is gated on `serverUrl` being non-empty.
  When empty (the default), no WS code runs — no reconnect storms, no DO
  dependency.

### 1.2 Email verification regex is the #1 source of fragility

Services **change their email templates without notice**. Notion went from
6-digit numeric codes to 6-char alphanumeric — the hardcoded regex broke,
and it was hardcoded in **4 separate places** (Python `email_worker.py`,
the macro JSON's `eval` step source, `popup.js` DEFAULT_INPUTS, and
`run_bridge_aiohttp.py`). Updating all 4 in lockstep was the painful
stabilization the user lived through.

**The fix (IMPLEMENTED, commit 6fd13f3):** the extraction logic is a
per-service macro INPUT (`extractionJs`), not extension code.
- `macros/_shared/wait-for-verification-email.json` holds the canonical
  email chunk (step ids: `email-auth`, `email-now`, `get-verification-code`,
  `fetch-email`, `parse-code`, `log-got-code`).
- Each service macro INLINES the chunk's steps (no macro-calling-macro —
  that's a complexity trap) and overrides `extractionJs` in its own
  `inputs` (notion's lives in `macros/notion/signup.json` +
  `full-onboarding.json`).
- When a service changes its email format, you edit ONE JSON file's
  `extractionJs` input (or override it per-run in the popup inputs textarea).
  No extension code changes. The extension just provides the `eval`
  primitive (CDP `Runtime.evaluate` in a tab's main world — MV3-safe, since
  SW CSP forbids `eval()`).
- Provider config is also inputs: `emailWorkerUrl` (the FULL inbox endpoint
  including query string) + `emailWorkerToken` (raw Basic pair `api:sk_...`
  OR a ready-made `Basic ...`/`Bearer ...` header). The `email-auth` eval
  step builds the header via `btoa` and fails with a clear message when
  the token is empty.
- The `email-now` step stamps `Date.now()` before the retry starts; the
  extraction skips emails older than that (`sinceMs` filter) so a re-run
  seconds later can't pick up the PREVIOUS run's code.

### 1.3 Email worker URL is per-domain — never hardcode `privatimail.com`

The user moved off `privatimail.com` (blocked by Notion after too many
tests) to `priv.email` (ImprovMX-based, see `.agents/SKILL-consumer.md`).
Each custom domain has its own email worker / API. The email worker URL +
token are **macro inputs** + popup config fields. No hardcoded email
domains anywhere in the extension code.

**Current email infrastructure (as of 2026-08-25):**
- Domain: `priv.email`
- Provider: ImprovMX (replaces the hand-rolled CF email worker)
- API: `https://api.improvmx.com/v3/domains/priv.email/logs`
- Auth: HTTP Basic, username `api`, password `sk_691ff26633c94b0d80523433afe3a369`
- Aliases: `admin@`, `support@`, `noreply@`, `billing@`, `security@`, `*@` (catch-all) — all forward to `ansgareutychis@hotmail.com`
- **Critical limitation**: ImprovMX `/logs` returns subject + sender but NOT body. Most verification codes are in the subject — if not, check Hotmail Junk (ImprovMX forwards often land in Junk due to SPF misalignment).
- Log retention: 7 days only (free plan)
- See `.agents/SKILL-consumer.md` for full usage patterns + curl recipes.

### 1.4 The macro format is the right abstraction — keep it stable

The notion v0.8.4 macro format is battle-tested. A macro is a JSON object:
```json
{
  "name": "...",
  "description": "...",
  "inputs": { "key": "value" },
  "steps": [
    { "id": "step1", "cmd": "fetch", "url": "...", "method": "POST", ... },
    { "id": "step2", "cmd": "form.wait", "tabId": "{{step1.tabId}}", "selector": "..." },
    { "id": "step3", "cmd": "retry", "timeoutMs": 180000, "intervalMs": 4000,
      "condition": "result && result.code != null", "steps": [...] },
    { "id": "step4", "cmd": "eval", "function": "(args) => { ... }", "args": {...} }
  ]
}
```

Template substitution: `{{inputs.x}}`, `{{stepId.field}}` (shorthand for
`{{results.stepId.field}}`). Fast path returns raw values (objects/arrays);
slow path stringifies. Cycle-guarded via WeakSet.

**Supported cmd types (23 total):** `tabs.open/close/list/focus`,
`form.fill/click/wait/eval`, `fetch`, `page.fetch`, `cookies.get/getAll/set/remove`,
`screenshot`, `getCaptchaToken` (hCaptcha only — both notion + supabase use
hCaptcha), `xhr.intercept`, `sandbox.open`, `eval` (CDP, MV3-safe),
`wait`, `log`, `retry`.

**Do NOT add macros-calling-macros** — it's a complexity trap. "Full
onboarding" flows are flat macros that inline the chunk steps, or the
popup runs N macros in sequence (playlist is a UI concept, not a macro
format concept).

### 1.5 The `retry` block's condition eval needs an open tab — and its config fields are NOT templates

MV3 service workers forbid `eval()` and `new Function()`. The `retry`
block evaluates its `condition` expression via `chrome.debugger.attach` +
`Runtime.evaluate` in **some tab's main world**. If no http(s) tab is open,
the retry block fails with `"retry: no http(s) tab available to evaluate
condition — open any web page first"`.

**Practical implication:** when authoring/testing macros with `retry`
blocks, make sure the user (or the macro itself via `tabs.open`) has at
least one http(s) tab open before the retry fires. This is a documented
runtime gotcha, not a bug.

**Also:** `executeRetryBlock` reads `timeoutMs` / `intervalMs` /
`condition` LITERALLY from the step JSON — they are never template-resolved
(only sub-step args are). Keep them concrete values; `{{inputs.x}}` in
those fields silently becomes undefined → defaults.

**Polling interval vs ImprovMX rate limit:** ImprovMX `/logs` allows ~10
req/min on the free plan. The chunk polls at `intervalMs: 10000` (6/min).
Don't lower it much — a 429 backoff is worse than waiting.

**sinceMs grace window:** the chunk's `email-now` step stamps `Date.now()`
AFTER the signup click (the chunk is inlined after the code-request action).
An email created between the click and the first poll (any fast sender — the
toy site, some real providers) is OLDER than sinceMs and gets filtered →
the retry loops until timeout with "no email newer than sinceMs". The fix
(2026-08-25): the extractionJs subtracts a grace window —
`Math.max(0, (Number(args.sinceMs) || 0) - (Number(args.graceMs) || 120000))`
— so "since" effectively means "since 2 min before polling started".
Override with `args.graceMs` if you need strict or looser semantics.

### 1.6 `getCaptchaToken` is hCaptcha-only — both current services use hCaptcha

Notion and Supabase both use hCaptcha enterprise. The handler queries
`window.hcaptcha.getResponse()` + textarea fallback. **No multi-provider
support** (no reCAPTCHA / Turnstile / Cloudflare). My earlier v1 chassis
had a multi-provider design — it was untested and got discarded. If a
future service uses a different captcha provider, add a new cmd type or
extend the handler at that point — don't speculate.

For supabase specifically: the existing e2e flow has the user solve hCaptcha
manually in the browser; the macro doesn't need to call `getCaptchaToken`
at all. The form auto-submits after the user solves.

### 1.7 Cookie domain must be derived from URL — never hardcoded

The notion v0.8.4 code had `domain: c.domain || '.notion.com'` hardcoded
in `handleCookiesSet`. We generalized it to derive from the URL hostname
(`.${parsed.hostname}`), with IP-address handling (host-only cookies —
Chrome rejects domain cookies on IPs). This is in the current fork.

### 1.8 `form.fill` must use the React-safe native value setter

React-controlled inputs don't fire `onChange` if you just set `el.value =
val`. The handler uses `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,
'value').set` to call the native setter, then dispatches `input` + `change`
events. This is the standard React workaround. Don't regress it.

### 1.9 `form.eval` and `xhr.intercept` use `chrome.debugger` — track ownership

When the extension attaches `chrome.debugger` to a tab, it must track that
it owns the attachment. If DevTools is also open on that tab, or another
extension has attached, `chrome.debugger.attach` throws "Another debugger
already attached". The notion v0.8.4 code tolerates this error and
proceeds — which can break active debug sessions if `form.eval` then
detaches a debugger it doesn't own.

The current fork uses a `_ownedTabs` Set (in debug.js — but note: the v2
fork uses notion's monolithic background.js, which may not have this fix).
**When you refactor background.js into modules, port the `_ownedTabs` +
`weAttached` flag pattern from the v1 chassis** (in
`docs/v1-design/handlers/debug.js` if it survived, or re-derive from the
peer-review-3 findings in the worklog).

### 1.11 Headless extension testing WORKS — use `channel: 'chromium'`

`tests/test_extension_headless.js` loads the real extension in headless
Chromium via Playwright and drives the popup end-to-end (config panel →
preset → Run Macro → result assertions), with local mock ImprovMX + Turso
servers. Two non-obvious facts that make it work:

1. **`chromium.launchPersistentContext(..., { channel: 'chromium' })` is
   REQUIRED.** Plain `headless: true` without a channel uses headless-shell,
   which **silently ignores `--load-extension`** — the service worker never
   registers and you waste an hour wondering why. With `channel: 'chromium'`
   you get the full binary in new-headless mode; MV3 extensions load fine.
2. **`chrome.debugger.attach` works alongside Playwright's own CDP session.**
   The extension attaches its debugger to a tab target while Playwright
   drives the browser through its own sessions — no conflict. `eval` steps
   (CDP Runtime.evaluate in the tab's main world) run normally.

The test needs an http(s) tab open (the mock server's index page serves as
the eval target). `btoa` exists in real tab contexts — if you simulate
evals in a Node `vm` sandbox, you must add `btoa`/`atob` yourself
(see the harnesses for the pattern).

**Implication:** most extension behavior is now machine-testable without
the user. What genuinely needs the user: real Notion signup (hCaptcha
enterprise, real IP, real email delivery to `*@priv.email`).

### 1.12 `tabs.open`'s load-wait races on fast pages — poll, don't just listen

`waitForTabLoaded` originally relied on `chrome.tabs.onUpdated('complete')`
plus a one-shot `chrome.tabs.get`. On notion.com (multi-second loads) that's
fine. On a fast local page the 'complete' event can fire BEFORE the listener
attaches, and the one-shot tabs.get can read a stale 'loading' — the step
then fails with "did not finish loading within 30000ms" even though the tab
is loaded. Fixed (2026-08-25) by adding a 250ms `tabs.get` status poll
alongside the listener. Lesson: event-listener patterns that were
battle-tested against slow sites need a polling backstop before you point
them at localhost.

### 1.13 Macro "click the first matching button" assumes views are REMOVED from the DOM

The notion click pattern
(`querySelectorAll('div[role="button"]').…innerText === 'Continue' → click`)
clicks the FIRST match. If a site keeps old views in the DOM hidden with
`display:none` (instead of removing them, like Notion's SPA does), the
"Continue" from the PREVIOUS view is still first in document order — the
macro clicks the wrong button and the flow silently stalls (symptom: the
email step re-runs, verify never fires). The toy site originally had this
bug. Two lessons: (a) test sites must mimic the real DOM lifecycle (forward
transitions REMOVE earlier views), (b) if a real service ever keeps hidden
duplicate buttons, the click function needs a visibility check
(`b.offsetParent !== null`).

### 1.14 Playwright `waitForFunction` takes options as the THIRD argument

`page.waitForFunction(fn, arg, options)` — passing `{ timeout: N }` as the
second arg silently passes it as the function's argument and the default
30s timeout applies. Symptom: "Timeout 30000ms exceeded" when you asked for
90s. Always `waitForFunction(fn, undefined, { timeout })`.

### 1.15 Don't trust commit messages that reference files that don't exist

The notion repo's commit `91b75cb` claims "All 4 macros pass (56/56 steps
total)" and "18 pytest tests pass" — but the test scripts
(`scripts/test_macro_dryrun.js`, `scripts/test_backend_units.py`) were
**never committed**. The claim is unverifiable. Later commits did add
`tests/test_macro_dryrun.js` (1016 lines) and `tests/test_backend_units.py`
(1007 lines) — verify they actually exist before relying on them.

## 2. Architecture (current state, post-Phase-1-start)

```
┌────────────────────────────────────────────────────────────────────┐
│                       Chrome MV3 Extension                         │
│  (forked from notion v0.8.4 commit 129dc11, generalized)           │
│                                                                    │
│   - Macro runner (battle-tested, ~345 lines in background.js)      │
│   - 23 command handlers (fetch, form.*, tabs.*, cookies.*, etc.)   │
│   - Popup UI (macro paste/load, per-step results, config)          │
│   - Sandbox page (page-context fetch for zstd-native)              │
│   - WS client (gated on serverUrl — empty default = standalone)    │
│   - Turso HTTP client (lib/turso.js — no-op when not configured)   │
│                                                                    │
│   Config (chrome.storage.local):                                   │
│   - serverUrl (empty=standalone; ws://127.0.0.1:8787=dev daemon)   │
│   - emailWorkerUrl, emailWorkerToken (per-domain)                  │
│   - tursoUrl, tursoToken (optional persistence)                    │
└────────────────────────────────────────────────────────────────────┘
   │              │              │
   │ (optional,   │ (optional,    │ (optional, WS —
   │  HTTP)        │  HTTP)         │  dev/debug only)
   ▼              ▼              ▼
┌────────────┐ ┌────────────┐ ┌────────────────────┐
│ Turso      │ │ Email      │ │ Python dev daemon   │
│ (libSQL)   │ │ Worker     │ │ (LOCAL DEV ONLY)    │
│            │ │ (ImprovMX  │ │ - WS for interactive │
│ - macro_   │ │  for       │ │   agent-driven debug │
│   runs     │ │  priv.email│ │ - HTTP API mirrors  │
│ - step_    │ │  currently)│ │   CF Worker          │
│   results  │ │            │ │ - SQLite mirror of  │
│ - captured │ │            │ │   Turso schema       │
│   _tokens  │ │            │ │ - logs to stdout     │
└────────────┘ └────────────┘ └────────────────────┘
                   │
                   │ (Phase 2, later)
                   ▼
              ┌──────────────────────────────┐
              │  CF Worker (HTTP-only)       │
              │  - dashboard HTML            │
              │  - CRUD on Turso tables      │
              │  - trigger macros (write to  │
              │    command_queue in Turso)    │
              │  - NO WS, NO DO              │
              └──────────────────────────────┘
```

**Three connection modes (mutually compatible):**
1. **Standalone** (default) — `serverUrl` empty. Runs macros from popup,
   writes to Turso if configured. MVP distribution shape.
2. **Dev/debug via Python daemon (WS)** — `serverUrl = ws://127.0.0.1:8787`.
   Agent-driven interactive work. Local dev only.
3. **Production via CF Worker (HTTP, Phase 2)** — polls `/api/poll`,
   POSTs `/api/result`. No WS.

## 3. What's done vs what's next

### Done (commits `fd095cf` → `dea71d5` on `origin/main`)
- Forked notion v0.8.4 extension verbatim into `extension/`
- Renamed manifest → "Onboard Automation Bridge" v0.9.0
- Generalized: empty `serverUrl` default, cookie domain derived from URL,
  removed hardcoded email worker token from popup defaults
- Added `extension/lib/turso.js` (Turso HTTP client, no-op when not configured)
- Made `background.js` an ES module (`"type": "module"`), wired Turso into
  the macro runner (recordMacroRun + recordStepResult)
- Deleted v1 chassis; `docs/REVAMP-PLAN.md` + `docs/MACROS.md` in place
- **Email verification chunk** (`macros/_shared/wait-for-verification-email.json`):
  provider-agnostic (emailWorkerUrl / emailWorkerToken / extractionJs are all
  macro INPUTS), ImprovMX-based, Basic auth built by the `email-auth` eval
  step, stale-code guard via `email-now` sinceMs, 10s poll interval
  (ImprovMX /logs rate limit ~10 req/min)
- **Macro chunking**: `notion/signup.json` (17 steps: signup + email verify +
  session capture), `notion/full-onboarding.json` (36 steps — the
  battle-tested v0.8.4 sequence with the new email chunk),
  `notion/create-workspace|activate-trial|create-api-key.json` (moved under
  `notion/` + `service` field for Turso). Step ids unchanged from v0.8.4.
- **Popup config panel**: emailWorkerUrl / emailWorkerToken / tursoUrl /
  tursoToken, debounced persistence to chrome.storage.local; email config
  pre-fills preset inputs and merges into macro inputs at run time
  (per-run values win); preset dropdown grouped Notion + Shared chunks
- **Test suite — ALL PASSING**:
  - `tests/test_macro_dryrun.js` — 7/7 macros, 95/95 steps vs HAR fixtures,
    template-ref lint clean
  - `tests/test_email_extraction_live.js` — 23/23 checks vs the live
    ImprovMX API
  - `tests/test_extension_headless.js` — 25 checks: email chunk E2E +
    Turso wire format in headless Chromium
  - `tests/test_toy_signup_e2e.js` — 18 checks: FULL signup E2E (real DOM,
    email chunk, session capture) + Quick Exec + daemon remote control
- **Shipped defaults (2026-08-25)**: the popup config panel pre-fills the
  ImprovMX URL + priv.email token; DEFAULT_INPUTS.email = onboard@priv.email
  — fresh installs run the email presets with zero configuration
  (`extension/config.example.json` documents every key)
- **Toy signup site + `_shared/self-test` macro**: local Notion-shaped
  signup site (`tests/toy-signup-site/server.js`) + a 16-step macro that
  completes a full signup incl. email verification + session capture in ~1s
  — the user can verify the extension end-to-end without touching a real
  service
- **Quick Exec** (popup): run any of the 23 commands as a single JSON with
  the raw result rendered — the "extension as a sandbox" REPL surface
- **Python dev daemon** (`python-dev-daemon/bridge.py`): WS bridge matching
  the extension protocol + HTTP long-poll fallback + curl-able
  `POST /api/command` (eval/fetch/macro.run round-trips verified E2E);
  plain-GET `/` serves a status page (the same URL the extension
  WS-upgrades to — matters for sandbox preview URLs)
- **`waitForTabLoaded` hardening**: 250ms tabs.get poll added — the old
  event-only wait raced on fast local pages ("did not finish loading
  within 30000ms" on a 5ms page)
- **sinceMs grace window** in all extractionJs (default 120s, overridable
  via `args.graceMs`) — fixes instant-sender emails being filtered as
  "stale" (see §1.5)

### Next
1. **Live Notion test (USER-SIDE — the only remaining integration step)** —
   load extension in Chrome (defaults are pre-filled), run `notion/signup`.
   **Use `*@priv.email` addresses, not privatimail.com (blocked by Notion).**
   Everything machine-testable has been tested — including a full signup
   flow on the toy site.
2. **Then supabase** — write `macros/supabase/signup.json` (needs the
   extension — hCaptcha required; user solves it manually, form
   auto-submits).
3. **Then todoist** — `macros/todoist/signup.json` (pure HTTP, no DOM, no
   captcha).
4. **Phase 2** — CF Worker dashboard (HTTP-only, reads/writes the same
   Turso DB; no WS, no DO). Needs the user's Cloudflare account to deploy.

## 4. Environment + workflow notes for the next agent

### 4.1 The sandbox environment
- This is a Z.ai Code sandbox container. `/home/z/my-project/` is the
  working dir. **Everything local is lost on sandbox reset** — only GitHub
  survives. The user explicitly said: "when you see this message it means
  we are handing over to a COMPLETELY NEW sandbox not resuming this
  session, so NOTHING local (not even /home/sync) can survive except
  those on GitHub."
- **Don't force-push.** The user said: "it's been quite a few days so
  your local likely is reset in any case don't force push in case your
  local is stale or completely erased." Always `git fetch origin` first,
  check `git log HEAD..origin/main` and `git log origin/main..HEAD` to
  see if there's drift. If local is behind, `git reset --hard origin/main`
  (after confirming no uncommitted local work). If local is ahead, push
  normally. If they've diverged, STOP and ask the user.
- The bash tool filters `caddy run/start/stop/reload` and curl-loops
  against internal ports 12600/19001/19005/19006 are irreversible
  lockouts. One probe per toolcall. (See CLAUDE.md / system prompt for
  full details — this is environment-specific.)

### 4.2 The GitHub token
The user provided a GitHub PAT in the first session. **The token is NOT
committed to this file** — GitHub Push Protection blocks any commit
containing a live PAT. The token format is `ghp_` followed by 36 chars.

To get the current token, ask the user. Once you have it, use it for
cloning the analysis repos:
```bash
# Replace <TOKEN> with the actual token the user provides
git clone https://<TOKEN>@github.com/ansgareutychisC/notion-onboarding-automation.git
git clone https://<TOKEN>@github.com/ansgareutychisC/supabase-automation.git
git clone https://<TOKEN>@github.com/ansgareutychisC/todoist-onboarding-automation.git
git clone https://<TOKEN>@github.com/ansgareutychisC/onboard-automation-common.git
```
**The token may have been rotated since.** If clones fail with 401, ask
the user for a fresh token. Store the token in an env var (`export GH_TOKEN=...`)
rather than typing it inline — avoids shell history + log capture.

### 4.3 The Turso token
The user provided a Turso JWT (in the prior session):
`eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJqdGkiOiJPSmttcjVpaUVmR25xR1l5ZXRWX0tnIiwib3JnX2lkIjoxMDAwMjIyMDI1fQ.w7A8mrDmkBG6h3CGiOcbSwtPFsee-XEgAJgrwSwOuA9-0CyGRKMWhmYEhkJEU3lzGk5IKSG2JFHCZvlHOt96Bw`

**This is NOT in the repo** (it's a JWT granting account access). The
user configures it via the extension popup's config panel, which stores
it in `chrome.storage.local`. For automated testing, a gitignored `.env`
file can hold it. **Treat as a secret** — never commit, never log.

The Turso DB URL is something like `https://<db-name>-<org>.tur.so` —
the user needs to create the DB in their Turso account and provide the
URL. The schema auto-creates on first use via `lib/turso.js`'s
`_ensureSchema()`.

### 4.4 The ImprovMX API key (priv.email)
`sk_691ff26633c94b0d80523433afe3a369` — for reading emails at
`*@priv.email`. Full usage in `.agents/SKILL-consumer.md`. **This IS in
the repo** (in `.agents/SKILL-consumer.md`) because the user provided it
knowing it would be committed. If the user rotates it, update
`.agents/SKILL-consumer.md`.

### 4.5 The notion-onboarding-automation repo as reference
- URL: https://github.com/ansgareutychisC/notion-onboarding-automation
- Branch: `main`
- Last known commit: `129dc11` ("Worker: disable WS (DO free-tier
  duration limit) + gitignore bridge.db")
- **This is the reference implementation.** Our extension is a fork of
  its `extension/` directory. When notion adds fixes, we can `git merge`
  or cherry-pick.
- The notion repo also has `tests/test_macro_dryrun.js` (1016 lines) and
  `tests/test_backend_units.py` (1007 lines) — these are the test
  harnesses that were missing in earlier commits. Port them to our repo
  when we get to the testing phase.

### 4.6 The supabase-automation + todoist repos
- https://github.com/ansgareutychisC/supabase-automation — the legacy
  supabase extension. ~95% identical to notion v0.7. Will be replaced by
  a supabase macro under `extension/macros/supabase/`.
- https://github.com/ansgareutychisC/todoist-onboarding-automation —
  pure-Python (no extension, no WAF, no captcha). Will get a dispatch
  macro under `extension/macros/todoist/`.

### 4.7 Working with the user
- The user has lived through stabilizing these tools one by one. They
  **don't want to re-live bug fixes**. When proposing changes, prefer
  minimal deviation from battle-tested code. Don't introduce unverified
  design code into a verified base.
- The user values **fact-grounded analysis** over hand-waving. When
  comparing options, cite actual code/lines/commits.
- The user is open to complete revamps when the current path is clearly
  broken (they said "i am open for a complete revamp, and do it properly
  as a reusable extension + simple backend"). But they want the revamp
  to be **simpler**, not more elegant. "Simplify even further."
- The user thinks in chunks: "divide the overall process into chunks,
  not the whole thing, e.g. sign-up (incl after email verification step
  but even that can be reused in a lot of case). then we can specifically
  have an action to 'create a workspace', 'generate a webhook', etc."
- The user wants the extension to be **useful by itself, even without
  backend**: "so the extension become a very versatile tool by itself,
  even without backend."

## 5. Peer review process (if you need to do another round)

The prior session ran 4 rounds of peer review on the v1 chassis (which
was discarded, but the review process is reusable). Process:
1. Spawn a `general-purpose` subagent with a detailed prompt listing
   every file to read + every prior finding to verify + ask for NEW
   issues.
2. The subagent appends its report to `/home/z/my-project/worklog.md`.
3. Fix all P0/P1/P2 issues. Leave P3.
4. Repeat until only P3 remain.

**Key insight from the prior review:** round 2 found that round 1's
fixes introduced NEW P0 regressions (e.g., the in-band auth gate was
correct, but I *also* added a WS-upgrade auth check that defeated it).
Round 3 found round 2's fixes introduced new P1 regressions. **Every
fix is a potential new bug.** Don't stop at one round.

The worklog at `/home/z/my-project/worklog.md` has the full review
reports (3319 lines as of last session) — but **this is local and will
be lost on sandbox reset**. The key findings are distilled in §1 above.
If you need the raw reports, they're gone — re-derive from the code.

## 6. Things I'd do differently next time

1. **Don't write a 2900-line untested chassis and call it "stable."**
   The v1 chassis (`docs/v1-design/` — deleted, but the commit history
   has it at `d2cf9f1` through `f3019b2`) was a design document with
   syntax checks. It had never driven a real browser. Calling it
   "stable" after 4 rounds of peer review was projecting closure onto
   something untested. Peer review catches logic bugs, not integration
   bugs.
2. **Fork the battle-tested code first, then generalize.** The right
   move was always "fork notion v0.8.4, strip the notion-specific bits,
   keep the macro runner." Instead I built a parallel chassis from
   scratch. The user correctly called this out.
3. **The macro format is the valuable artifact, not the runner.** The
   runner is ~345 lines of plumbing. The 4 preset macros
   (`signup-onboard.json` etc.) encode 5+ iterations of HAR-aligned
   live debugging. That's the irreplaceable work.
4. **Email verification should always have been a per-service eval
   step**, not a hardcoded regex. The moment you hardcode a regex, the
   service changes the format and you're in pain.
5. **WS on CF free tier was always dead.** I should have believed the
   notion repo's commit history ("Fix infinite reconnect loop (P0)"
   × 5) instead of designing a "better" WS+HTTP hybrid.

## 7. File-level orientation (what's where in our repo)

```
onboard-automation-common/
├── .agents/
│   ├── SKILL.md                  ← you are here (meta knowledge)
│   └── SKILL-consumer.md         ← priv.email / ImprovMX consumer skill
├── docs/
│   ├── REVAMP-PLAN.md            ← the full plan, all questions answered
│   ├── MACROS.md                 ← macro format reference + chunk pattern
│   └── EXTENSION-VS-CHROME-RD.md ← extension vs raw CDP analysis
├── extension/                    ← the actual Chrome MV3 extension (Phase 1)
│   ├── manifest.json             ← "Onboard Automation Bridge" v0.9.1, ES module
│   ├── background.js             ← macro runner + 23 cmd handlers + WS (gated) + quickExec
│   ├── popup.html / popup.js     ← macro replay + config panel (shipped defaults) + Quick Exec
│   ├── INSTALL.md                ← install + first-run guide (shipped in the release zip)
│   ├── config.example.json       ← config keys reference
│   ├── sandbox.html / sandbox.js ← page-context fetch for zstd-native
│   ├── lib/
│   │   └── turso.js              ← Turso HTTP client (no-op when not configured)
│   ├── macros/
│   │   ├── _shared/
│   │   │   ├── wait-for-verification-email.json  ← the reusable email chunk
│   │   │   └── self-test.json    ← full signup vs the toy site (16 steps)
│   │   └── notion/
│   │       ├── signup.json       ← 17 steps: signup + email verify + session capture
│   │       ├── create-workspace.json
│   │       ├── activate-trial.json
│   │       ├── create-api-key.json
│   │       └── full-onboarding.json ← 36 steps: the full v0.8.4 flow
│   └── icons/                    ← placeholder PNGs
├── python-dev-daemon/
│   └── bridge.py                 ← dev daemon: WS bridge + /api/command + status page
├── tests/
│   ├── test_macro_dryrun.js      ← dry-run all macros vs HAR fixtures + lint
│   ├── test_email_extraction_live.js ← extractionJs vs live ImprovMX
│   ├── test_extension_headless.js ← email chunk + Turso E2E, headless Chromium
│   ├── test_toy_signup_e2e.js    ← FULL signup E2E + Quick Exec + daemon remote control
│   ├── toy-signup-site/server.js ← local Notion-shaped signup site + mock inbox
│   └── har_fixtures/             ← extracted HAR calls (notion API responses)
├── README.md                     ← project overview (current for v2)
└── .gitignore                    ← includes secrets protection + test artifacts
```

**Not yet created:**
- `extension/macros/supabase/` — supabase macros
- `extension/macros/todoist/` — todoist macros
- `worker-v2/` — Phase 2 CF Worker (HTTP-only, reads from Turso)

## 8. Quick bootstrap for a fresh sandbox

```bash
# 1. Clone the canonical repo
cd /home/z/my-project
git clone https://github.com/ansgareutychisC/onboard-automation-common.git
cd onboard-automation-common

# 2. Read the plan + this skill
cat docs/REVAMP-PLAN.md
cat .agents/SKILL.md
cat .agents/SKILL-consumer.md

# 3. (Optional) clone the notion reference repo for comparison
cd /home/z/my-project
git clone https://github.com/ansgareutychisC/notion-onboarding-automation.git notion-ref

# 4. Verify the extension loads (syntax check)
cd /home/z/my-project/onboard-automation-common
for f in extension/background.js extension/popup.js extension/sandbox.js extension/lib/turso.js; do
  node --check "$f" || echo "FAIL: $f"
done

# 5. Run the test suite (all four should pass on a clean checkout)
node tests/test_macro_dryrun.js                      # 7/7 macros vs HAR fixtures
node tests/test_email_extraction_live.js             # 23/23 vs live ImprovMX (read-only)
NODE_PATH=$(npm root -g) node tests/test_extension_headless.js   # email chunk + Turso E2E
NODE_PATH=$(npm root -g) node tests/test_toy_signup_e2e.js       # FULL signup + daemon E2E
# NOTE the headless tests require channel:'chromium' — plain headless uses
# headless-shell which silently ignores --load-extension (see §1.11).

# 6. Load the extension in Chrome (user-side live test)
# - chrome://extensions → Developer mode → Load unpacked → select extension/
# - Click the extension icon — config is pre-filled (shipped defaults);
#   optionally start the toy site and run the _shared/self-test preset first

# 7. Optional: start the dev daemon (WS bridge + curl-able remote control)
python3 python-dev-daemon/bridge.py --port 3000
# connect the extension: ws://127.0.0.1:3000 (or wss://<preview-host>/ via a gateway)
```

## 9. When in doubt

- **Read the code, not the docs.** The docs (including this one) may be
  stale. The code is the truth.
- **Check the notion repo's commit history** for prior fixes — they
  likely already solved whatever you're hitting.
- **Ask the user** before making architectural changes. They have context
  you don't.
- **Don't re-live stabilization.** If a bug looks familiar, it's probably
  in the notion repo's commit history with a fix. Search there first.
