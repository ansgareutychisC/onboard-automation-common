# onboard-automation-common

A single, service-agnostic Chrome MV3 extension that drives onboarding
automation for SaaS services (Notion first; Supabase and Todoist next). The
extension runs **JSON macros** (sequences of `fetch` / `form.fill` /
`xhr.intercept` / `retry` / `eval` steps) locally in your real browser — no
backend required for the MVP.

> Forked from the battle-tested `notion-onboarding-automation` v0.8.4
> extension (commit `129dc11`) and generalized minimally. The macro runner and
> its 23 command handlers are kept verbatim wherever possible — the value is
> in the proven runtime, not in a rewrite.

## Why This Exists

The legacy projects each duplicated ~3000 lines of extension + bridge code.
Every Notion stabilization round had to be re-lived per service. This repo
consolidates the shared 95% once; each service contributes only its macros
(JSON files under `extension/macros/<service>/`).

Hard-won design principles (see `.agents/SKILL.md` for the full distilled
knowledge):

- **WebSocket is dead on Cloudflare Workers free tier** — empirically proven
  by 5+ P0 reconnect bugs in the notion repo. WS survives only in the local
  Python dev daemon (dev/debug), gated behind `serverUrl`. Production is
  HTTP-only (Phase 2, not built yet).
- **Email verification is the #1 fragility source.** Services change email
  templates without notice. The extraction logic is therefore a per-service
  **macro input** (`extractionJs`), never extension code.
- **The extension must be useful by itself**, even with no backend and no
  database configured.

## What's Included

```
onboard-automation-common/
├── extension/                          # The Chrome MV3 extension (Phase 1)
│   ├── manifest.json                   # "Onboard Automation Bridge" v0.9.0, ES module SW
│   ├── background.js                   # Macro runner + 23 command handlers + WS (gated)
│   ├── popup.{html,js}                 # Macro replay UI + Email & Storage config panel
│   ├── sandbox.{html,js}               # Page-context fetch for zstd responses
│   ├── lib/
│   │   └── turso.js                    # Turso (libSQL) HTTP client — no-op when unconfigured
│   └── macros/
│       ├── _shared/
│       │   └── wait-for-verification-email.json   # reusable email chunk (ImprovMX-based)
│       └── notion/
│           ├── signup.json             # signup + email verify + session capture (17 steps)
│           ├── create-workspace.json   # workspace on an existing account
│           ├── activate-trial.json     # 14-day trial (needs hCaptcha token)
│           ├── create-api-key.json     # PAT creation
│           └── full-onboarding.json    # full signup → onboarded (36 steps)
├── tests/
│   ├── test_macro_dryrun.js            # dry-run all macros vs HAR-captured responses
│   ├── test_email_extraction_live.js   # extractionJs vs the live ImprovMX API
│   ├── test_extension_headless.js      # full E2E in headless Chromium (Playwright)
│   └── har_fixtures/                   # extracted HAR calls (notion API responses)
├── docs/
│   ├── REVAMP-PLAN.md                  # the plan (Phase 1-3)
│   └── MACROS.md                       # macro format reference + chunk pattern
└── .agents/
    ├── SKILL.md                        # meta-agent knowledge (read this first)
    └── SKILL-consumer.md               # reading *@priv.email via ImprovMX API
```

## Three Connection Modes

1. **Standalone (default)** — `serverUrl` empty. Run macros from the popup;
   optionally persist runs to Turso if configured. No backend, no WS.
2. **Dev/debug via Python daemon (WS)** — `serverUrl = ws://127.0.0.1:8787`.
   Agent-driven interactive debugging. Local only. (Daemon not yet ported —
   Phase 1 leftover.)
3. **Production via CF Worker (HTTP, Phase 2)** — polls `/api/poll`, POSTs
   `/api/result`. No WS, no Durable Objects.

## Quick Start

### Use the Extension

1. Open `chrome://extensions`, enable Developer mode.
2. Click "Load unpacked", select the `extension/` directory.
3. Click the extension icon → fill the **Email & Storage Config** panel:
   - Email API URL: `https://api.improvmx.com/v3/domains/priv.email/logs?take=20`
   - Email API token: `api:sk_...` (ImprovMX key; see `.agents/SKILL-consumer.md`)
   - Turso URL/token: optional (persistence)
4. Pick a preset → edit inputs → **Run Macro**.

Suggested order: `_shared/wait-for-verification-email` (infra test) →
`notion/create-api-key` (simplest API flow, needs an active Notion session) →
`notion/signup` → `notion/full-onboarding`.

### Run the Test Suite

```bash
# 1. Static dry-run of every macro against HAR-captured Notion responses
node tests/test_macro_dryrun.js

# 2. Extraction logic vs the live ImprovMX API (read-only)
node tests/test_email_extraction_live.js

# 3. Full E2E: real extension in headless Chromium (needs Playwright + Chromium)
NODE_PATH=$(npm root -g) node tests/test_extension_headless.js
```

All three currently pass: 6/6 macros (79/79 steps) in the dry-run, 23/23 live
extraction checks, 21/21 headless E2E checks (extension load, config
persistence, nested preset fetch, real macro execution with
`chrome.debugger`-based eval, retry loop, Basic-auth email polling, code
extraction, and the Turso persistence wire format against a mock).

## Current State

- ✅ Phase 1: fork + generalize the extension, Turso client, email
  verification chunk (provider-agnostic, ImprovMX), macro chunking
  (`notion/` + `_shared/`), popup config panel, automated test suite
- 🔲 Live Notion signup verification in a real browser (needs user-side
  testing: hCaptcha enterprise + real email delivery to `*@priv.email`)
- 🔲 Supabase macro (`macros/supabase/signup.json` — hCaptcha solved by user)
- 🔲 Todoist macro (`macros/todoist/signup.json` — pure HTTP, no DOM)
- 🔲 Python dev daemon port (`python-dev-daemon/`)
- 🔲 Phase 2: CF Worker dashboard (HTTP-only, reads the same Turso DB)

## Documentation

- **[docs/REVAMP-PLAN.md](docs/REVAMP-PLAN.md)** — the full plan with all 5
  open questions answered; §6 has the step-by-step.
- **[docs/MACROS.md](docs/MACROS.md)** — macro format reference, the shared
  chunk pattern, testing workflow.
- **[.agents/SKILL.md](.agents/SKILL.md)** — meta knowledge for agents
  working on this repo. Read this first.
- **[.agents/SKILL-consumer.md](.agents/SKILL-consumer.md)** — how to read
  `*@priv.email` via the ImprovMX API.

## License

Same as the parent project.
