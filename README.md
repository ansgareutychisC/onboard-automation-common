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
│   ├── manifest.json                   # "Onboard Automation Bridge" v0.9.1, ES module SW
│   ├── background.js                   # Macro runner + 23 command handlers + WS (gated)
│   ├── popup.{html,js}                 # Macro replay UI + config panel + Quick Exec
│   ├── INSTALL.md                      # install + first-run guide (shipped in the zip)
│   ├── config.example.json             # config keys reference (defaults documented)
│   ├── sandbox.{html,js}               # Page-context fetch for zstd responses
│   ├── lib/
│   │   └── turso.js                    # Turso (libSQL) HTTP client — no-op when unconfigured
│   └── macros/
│       ├── _shared/
│       │   ├── wait-for-verification-email.json   # reusable email chunk (v3-mail Bearer API)
│       │   └── self-test.json          # full signup vs the local toy site (zero-risk E2E)
│       └── notion/
│           ├── signup.json             # signup + email verify + session capture (17 steps)
│           ├── create-workspace.json   # workspace on an existing account
│           ├── activate-trial.json     # 14-day trial (needs hCaptcha token)
│           ├── create-api-key.json     # PAT creation
│           └── full-onboarding.json    # full signup → onboarded (36 steps)
├── python-dev-daemon/
│   └── bridge.py                       # local dev daemon: WS bridge + curl-able /api/command
├── tests/
│   ├── test_macro_dryrun.js            # dry-run all macros vs HAR-captured responses
│   ├── test_email_extraction_live.js   # extractionJs vs the live ImprovMX API
│   ├── test_mail_api_live.js          # v3-mail Bearer API vs the live worker (16 checks)
│   ├── test_extension_headless.js      # E2E in headless Chromium (email chunk + Turso)
│   ├── test_toy_signup_e2e.js          # FULL signup E2E vs the toy site + daemon remote control
│   ├── toy-signup-site/
│   │   └── server.js                   # local "SaaS" signup site (Notion-like selectors + mock inbox)
│   └── har_fixtures/                   # extracted HAR calls (notion API responses)
├── docs/
│   ├── REVAMP-PLAN.md                  # the plan (Phase 1-3)
│   ├── MACROS.md                       # macro format reference + chunk pattern
│   └── EXTENSION-VS-CHROME-RD.md       # extension vs raw CDP analysis
└── .agents/
    ├── SKILL.md                        # meta-agent knowledge (read this first)
    └── SKILL-consumer.md               # reading *@priv.email programmatically (v3-mail primary)
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

### Use the Extension (zero-config)

1. Open `chrome://extensions`, enable Developer mode.
2. Click "Load unpacked", select the `extension/` directory.
3. Click the extension icon — the **Email & Storage Config** panel is already
   pre-filled with the priv.email v3-mail defaults (URL + Bearer token ship in
   the build), so you can run the email presets immediately. Optional:
   Turso URL/token for run-history persistence.

Suggested order: `_shared/self-test` (after starting the toy site — full
signup flow, no real service) → `notion/create-api-key` (simplest live flow,
needs an active Notion session) → `notion/signup` → `notion/full-onboarding`.

### Self-test without touching a real service

```bash
node tests/toy-signup-site/server.js    # local toy signup site + mock inbox
# then run the _shared/self-test preset in the extension popup
```

The toy site mimics the Notion signup flow's shape (same selectors, same SPA
transitions) and exposes a v3-mail-shaped inbox API (Bearer auth, body codes) — the self-test macro
completes a full signup + email verification + session capture in ~1s.

### Run the Test Suite

```bash
node tests/test_macro_dryrun.js                      # 7/7 macros vs HAR fixtures
node tests/test_email_extraction_live.js             # 23/23 vs live ImprovMX (read-only)
NODE_PATH=$(npm root -g) node tests/test_extension_headless.js   # email chunk + Turso E2E
NODE_PATH=$(npm root -g) node tests/test_toy_signup_e2e.js       # full signup + daemon E2E
```

All four pass: 7/7 macros (95/95 steps) in the dry-run, 23/23 live checks,
25 checks in the headless email-chunk E2E, and 18 checks in the toy-signup
E2E (defaults, full signup, Quick Exec, and daemon-driven remote control).

### Optional: the dev daemon (agent-driven remote control)

A verbatim port of the battle-tested notion v0.8.4 bridge — see
**[docs/DAEMON.md](docs/DAEMON.md)** for the full guide.

```bash
python3 python-dev-daemon/bridge.py            # 0.0.0.0:3000 (Caddy proxy target)
# connect the extension: ws://127.0.0.1:3000 locally, or the sandbox preview
# URL (wss://preview-<bot-id>.space-z.ai/) — the daemon serves the dashboard
# at / and the WS endpoint at / (and /ws).
curl -X POST http://127.0.0.1:3000/api/command \
  -H 'Content-Type: application/json' \
  -d '{"type":"eval","function":"() => ({ title: document.title })"}'
```

## What the extension connects to

| Connection | Default | Purpose |
|---|---|---|
| Email inbox API (ImprovMX) | **on** (shipped defaults) | reading verification codes for `*@priv.email` |
| Turso (libSQL) | **off** unless configured | run/step history persistence (optional) |
| Python dev daemon (WS) | **off** (`serverUrl` empty) | agent-driven interactive debugging — `python-dev-daemon/bridge.py` |
| CF Worker (Phase 2) | **not built yet** | HTTP-only production backend reading the same Turso DB |

No backend is required for the MVP — the extension is useful by itself.
The Phase 2 Worker needs your Cloudflare account to deploy (wrangler login
or a CF API token).

## Current State

- ✅ Phase 1: extension + Turso client, provider-agnostic email chunk,
  macro chunking, popup config panel **with shipped defaults**, Quick Exec
  (single-command sandbox mode), full automated test suite
- ✅ Toy signup site + `_shared/self-test` macro — full signup E2E without a
  real service
- ✅ Python dev daemon (`python-dev-daemon/bridge.py`) — WS bridge +
  curl-able `POST /api/command` remote control, verified end-to-end
- 🔲 Live Notion signup verification in a real browser (needs user-side
  testing: hCaptcha enterprise + real email delivery to `*@priv.email`)
- 🔲 Supabase macro (`macros/supabase/signup.json` — hCaptcha solved by user)
- 🔲 Todoist macro (`macros/todoist/signup.json` — pure HTTP, no DOM)
- 🔲 Phase 2: CF Worker dashboard (HTTP-only, reads the same Turso DB)

## Documentation

- **[docs/REVAMP-PLAN.md](docs/REVAMP-PLAN.md)** — the full plan with all 5
  open questions answered; §6 has the step-by-step.
- **[docs/MACROS.md](docs/MACROS.md)** — macro format reference, the shared
  chunk pattern, testing workflow.
- **[docs/EXTENSION-VS-CHROME-RD.md](docs/EXTENSION-VS-CHROME-RD.md)** —
  extension route vs. raw Chrome remote debugging: when each wins.
- **[.agents/SKILL.md](.agents/SKILL.md)** — meta knowledge for agents
  working on this repo. Read this first.
- **[.agents/SKILL-consumer.md](.agents/SKILL-consumer.md)** — how to read
  `*@priv.email` via the ImprovMX API.

## License

Same as the parent project.
