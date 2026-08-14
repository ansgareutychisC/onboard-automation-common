# onboard-automation-common

A shared foundation for browser-driven onboarding automation tools. Consolidates the browser extension and bridge protocol from the legacy `notion-onboarding-automation` and `supabase-automation` projects into a single, service-agnostic base.

## Why This Exists

The legacy projects each duplicated ~3000 lines of extension + bridge code, differing only in ~5 lines of service-specific defaults (cookie domain, default URL, branding). Every bug fix had to be applied twice. Every new service would add another ~3000-line copy.

`onboard-automation-common` consolidates the shared 95%:
- The Chrome MV3 extension (2900 lines) is written **once**.
- The bridge wire protocol is specified **once**.
- The BridgeHub Durable Object + Python daemon are written **once**.
- The async Python client is written **once**.

Each service (Notion, Supabase, Todoist, your-next-service) only writes the 5% that's actually different: the signup flow, the vendor API client, the dashboard, the D1 schema.

## What's Included

```
onboard-automation-common/
├── extension/                      # Chrome MV3 extension (the main deliverable)
│   ├── manifest.json               # MV3, 8 permissions, no service branding
│   ├── background.js               # Orchestrator: load handlers, wire connection
│   ├── popup.{html,js}             # Config + status + structured log feed
│   ├── sandbox.{html,js}           # Page-context zstd-native fetcher
│   ├── lib/
│   │   ├── protocol.js             # Command/message types (single source of truth)
│   │   ├── connection.js           # WS+HTTP fallback, watchdog, idle healing, backoff
│   │   ├── logger.js               # Structured logger (commandId, tabId, durationMs, traceId)
│   │   └── send.js                 # sendResult/sendError/sendEvent/sendLog helpers
│   └── handlers/                   # 9 modules, one per command group
│       ├── fetch.js                # fetch + page.fetch (zstd handling)
│       ├── tabs.js                 # tabs.open/close/list/focus
│       ├── form.js                 # form.fill/click/wait/eval (React-safe + CDP)
│       ├── xhr.js                  # xhr.intercept (one-shot CDP Network capture)
│       ├── cookies.js              # cookies.get/getAll/set (no default domain)
│       ├── screenshot.js           # tabId-aware screenshot (fixes legacy bug)
│       ├── captcha.js              # multi-provider (hcaptcha/recaptcha/turnstile/cloudflare)
│       ├── sandbox.js              # sandbox.open
│       └── debug.js                # 11 activatable debug commands (HAR/console/network/trace/dom/storage/screenshot-fullpage)
│
├── worker-template/                # Cloudflare Worker + BridgeHub Durable Object
│   ├── src/
│   │   ├── index.ts                # Hono router with auth middleware
│   │   ├── bridge-hub.ts           # DO with cross-channel pending-future correlation
│   │   └── types.ts                # Protocol types (single source of truth for TS)
│   ├── wrangler.toml.example
│   ├── migrations/0001_init.sql    # Optional event_logs table
│   └── README.md
│
├── python-template/                # Async Python client + dev daemon
│   ├── onboard_common/
│   │   ├── extension_bridge.py     # Async client mirroring all commands
│   │   ├── protocol.py             # Python types matching TS
│   │   └── exceptions.py           # Bridge exception hierarchy
│   ├── scripts/
│   │   ├── run_bridge.py           # aiohttp daemon (dev)
│   │   └── daemonize.py            # Double-fork helper
│   └── README.md
│
└── docs/
    ├── PROTOCOL.md                 # Wire protocol spec
    ├── ARCHITECTURE.md             # 3-tier design + resiliency stack
    ├── DEBUGGING.md                # Activatable debug commands + usage patterns
    └── MIGRATION.md                # How to migrate a legacy service to this base
```

## Key Improvements Over Legacy Extensions

| Aspect | Legacy (notion/supabase) | Unified (this project) |
|--------|--------------------------|------------------------|
| Extension lines per service | ~2000 (duplicated) | 0 (shared) |
| Resiliency features | notion: full; supabase: partial | Full (best of both) |
| Debug capability | `xhr.intercept` only (one-shot) | 11 activatable debug commands |
| Captcha support | hCaptcha only | hCaptcha + reCAPTCHA + Turnstile + Cloudflare |
| Cookie domain | hardcoded per service | derived from URL or caller-specified |
| Screenshot tabId | ignored (captures active tab) | tabId-aware (focuses + restores) |
| Protocol versioning | none | `protocolVersion: "1.0"` + capability advertisement |
| Trace correlation | none | `traceId` flows through commands → logs → results → events |
| Logging | free-text | structured (commandId, tabId, durationMs, traceId) |
| Known bugs carried forward | screenshot ignores tabId; sandbox has stale hardcoded URL; dead permissions; cookie domain default | All fixed |

## Quick Start

### Use the Extension

1. Copy `extension/` to your machine.
2. Open `chrome://extensions`, enable Developer mode.
3. Click "Load unpacked", select the `extension/` directory.
4. Click the extension icon, paste your bridge server URL (e.g. `wss://your-worker.workers.dev`), click Connect.

### Deploy the Worker

```bash
cd worker-template/
cp wrangler.toml.example wrangler.toml
# Edit wrangler.toml — fill in database_id, name
npm install
wrangler login
wrangler d1 create onboard-automation-bridge-db
# Paste database_id into wrangler.toml
wrangler d1 migrations apply DB
wrangler deploy
```

### Use the Python Client

```bash
cd python-template/
pip install -r requirements.txt
```

```python
import asyncio
from onboard_common import ExtensionBridge

async def main():
    async with ExtensionBridge("http://127.0.0.1:8787") as bridge:
        await bridge.wait_for_extension(timeout=60)
        result = await bridge.tabs_open("https://example.com")
        tab_id = result.get("tabId")
        await bridge.form_fill(tab_id, "input[name=email]", "user@example.com")
        await bridge.form_click(tab_id, "button[type=submit]")

asyncio.run(main())
```

## Current Scope (What's Done)

This is the **most basic step** from the user's scope-down plan:
- ✅ Unified the extension into one service-agnostic dumb sandbox
- ✅ Robust client/server protocol with full resiliency stack (watchdog, idle healing, backoff, SOS HTTP fallback, cross-channel correlation)
- ✅ Widest possible debugging/execution/traceability capability built in (11 activatable debug commands) — activatable/deactivatable per command
- ✅ Compatible with all current services (notion, supabase) and likely future services (multi-provider captcha, no hardcoded domains, capability advertisement)

## Future Scope (Not Yet Done)

Per the user's plan, these come later:
- 🔲 One common gateway URL so the extension always connects to the same place (currently each service has its own worker.dev URL — user pastes manually)
- 🔲 Service-layer batch mode (orchestrate onboarding for multiple services in one run, with configurable ordering)
- 🔲 Backend unification (currently each service has its own worker — that's OK because backends don't cause friction)
- 🔲 Per-service switching in the popup (currently: paste a different worker URL to switch services)

## Documentation

- **[docs/PROTOCOL.md](docs/PROTOCOL.md)** — Wire protocol spec. The single source of truth for command shapes, result envelopes, message types, and HTTP routes.
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — 3-tier design (extension ↔ bridge ↔ orchestrator), resiliency stack, file inventory, comparison to legacy projects.
- **[docs/DEBUGGING.md](docs/DEBUGGING.md)** — The 11 activatable debug commands with usage patterns and "when to use what" decision table.
- **[docs/MIGRATION.md](docs/MIGRATION.md)** — Step-by-step guide for migrating a legacy service (notion/supabase) to this common base. Estimated 6–11 hours per service, removes ~3550 lines of duplication.

## License

Same as the parent project.
