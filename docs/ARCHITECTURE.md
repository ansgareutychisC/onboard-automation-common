# ARCHITECTURE.md

## Overview

`onboard-automation-common` is a shared foundation for browser-driven onboarding automation tools. It consolidates the ~95%-identical browser extension and bridge protocol from the legacy `notion-onboarding-automation` and `supabase-automation` projects into a single, service-agnostic base.

```
┌────────────────────────────────────────────────────────────────────────────┐
│                          Service-specific code                             │
│  (notion-onboarding / supabase-automation / your-next-service)             │
│                                                                            │
│   - signup flow orchestration                                              │
│   - service API client (vendor REST calls)                                │
│   - service dashboard / inspector tabs                                     │
│   - service-specific D1 tables + migrations                               │
└───────────────────────────────┬────────────────────────────────────────────┘
                                │ uses
                                ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                      onboard-automation-common                             │
│                                                                            │
│  ┌─────────────────────┐  ┌──────────────────────┐  ┌───────────────────┐  │
│  │   extension/        │  │   worker-template/   │  │  python-template/ │  │
│  │                     │  │                      │  │                   │  │
│  │  - manifest.json    │  │  - BridgeHub DO      │  │  - ExtensionBridge│  │
│  │  - background.js    │  │  - Hono router shell │  │  - protocol.py    │  │
│  │  - lib/ (protocol,  │  │  - types.ts          │  │  - exceptions.py  │  │
│  │    connection,      │  │  - migrations/       │  │  - run_bridge.py  │  │
│  │    logger, send)    │  │    (event_logs only) │  │    (dev daemon)   │  │
│  │  - handlers/ (9     │  │                      │  │                   │  │
│  │    modules)         │  │  Mount your service  │  │  Import into your │  │
│  │  - popup.{html,js}  │  │  routes via          │  │  service's CLI /  │  │
│  │  - sandbox.{html,js}│  │  app.route()         │  │  pipeline         │  │
│  └─────────┬───────────┘  └──────────┬───────────┘  └─────────┬─────────┘  │
│            │                         │                       │            │
│            │     WebSocket +         │                       │ HTTP       │
│            │     HTTP fallback       │                       │ /api/*     │
│            └─────────────────────────┴───────────────────────┘            │
└────────────────────────────────────────────────────────────────────────────┘
```

## The Three Tiers

### Tier 1: Extension (Chrome MV3)

The extension is a **dumb interaction proxy**. It contains zero service-specific logic. Its only job is to:

1. Connect to a bridge server (WebSocket primary, HTTP long-poll fallback).
2. Receive commands (fetch, click, fill, screenshot, etc.).
3. Execute them in the browser using Chrome APIs.
4. Report results back.

The extension is **service-agnostic** — no notion.com, supabase.com, or any other domain is hardcoded. The server URL is configurable via the popup. Captcha supports hCaptcha, reCAPTCHA, Turnstile, and Cloudflare challenges.

### Tier 2: Bridge Server (Worker DO or Python Daemon)

The bridge server is a **stateless relay** between orchestrators and extensions. It:

1. Accepts WebSocket connections from extensions.
2. Accepts HTTP requests from orchestrators (`POST /api/command`).
3. Routes commands to extensions (round-robin across multiple connected extensions; sandbox.fetch goes only to `context:"page"` connections).
4. Correlates results back to the originating orchestrator request.
5. Provides an HTTP SOS queue for when an extension's WebSocket is dead.

The bridge server is **stateless** — it holds connection state and pending commands in memory (in the Durable Object for the Worker, or in module-level state for the daemon). All persistent state (accounts, jobs, event logs) lives in D1 and is owned by the service-specific code, not the bridge.

### Tier 3: Orchestrator (Python or Worker TS)

The orchestrator is **service-specific**. It:

1. Implements the signup/onboarding flow for a specific vendor (Notion, Supabase, Todoist, etc.).
2. Uses the `ExtensionBridge` Python client (or the equivalent TS in the Worker) to drive the browser.
3. Persists results to D1 via service-specific tables.
4. Exposes service-specific HTTP routes (`/api/run`, `/api/accounts`, dashboard, etc.).

## Why This Split?

The legacy projects (`notion-onboarding-automation`, `supabase-automation`) each duplicated ~3000 lines of extension + bridge code, differing only in ~5 lines of service-specific defaults (cookie domain, default URL, branding). Every bug fix had to be applied twice. Every new service would add another ~3000-line copy.

`onboard-automation-common` consolidates the shared 95%:
- The extension (1993 lines) is now written once.
- The bridge protocol (types + DO + daemon) is now written once.
- The Python client (extension_bridge.py) is now written once.

Each service only writes the 5% that's actually different: the signup flow, the vendor API client, the dashboard tabs, the D1 schema.

## Resiliency Stack

The connection between extension and bridge server is the most fragile component (MV3 service workers die after 30s; browsers sleep; networks drop). The unified extension includes the most mature resiliency stack from the legacy projects:

| Feature | Implementation | Source |
|---------|----------------|--------|
| 25s keepalive | Extension sends `pong` every 25s via `setInterval` | Both legacy projects |
| 90s watchdog | `chrome.alarms` force-closes WS if no server message in 90s | notion-onboarding only — adopted |
| Browser-wake healing | `chrome.idle.onStateChanged` resets backoff and reconnects on wake | notion-onboarding only — adopted |
| Exponential backoff | 1s, 2s, 4s, 8s, 16s, 32s, 60s cap | notion-onboarding only — adopted |
| HTTP SOS long-poll | Extension polls `GET /api/poll?wait=25` when WS dies | Both legacy projects |
| 3-retry HTTP result POST | 1s/2s/4s backoff on `/api/result` POST failures | notion-onboarding only — adopted |
| Cross-channel correlation | Command sent via WS can be answered via HTTP — server keys pending futures by cmdId, not connId | Both legacy projects |
| Server-side sweeper | Drops queued commands + results older than 5 min; closes zombie connections silent >90s | Both legacy projects |
| Persistent agent ID | `chrome.storage.local["agentId"]` survives SW restarts | Both legacy projects |

## Capability Advertisement

The extension announces its supported command types in the `connect` message:

```json
{
  "type": "connect",
  "agentId": "ext-abc123",
  "protocolVersion": "1.0",
  "capabilities": ["fetch", "page.fetch", "tabs.open", ...],
  "context": "worker",
  "userAgent": "...",
  "hostname": "chrome-extension"
}
```

Orchestrators can probe `GET /api/extensions` before sending commands that require optional permissions. Future extensions can advertise additional capabilities (e.g. `cdp.raw` for raw CDP passthrough) without changing the protocol.

## Sandbox Page (zstd Workaround)

Chrome's MV3 service worker `fetch().text()` cannot reliably decompress `zstd`-encoded responses. The bug was introduced in Chrome 143 (where `DecompressionStream("zstd")` was added but unreliable) and worsened in Chrome 151+ (where the workaround broke).

The unified extension includes a **sandbox page** (`sandbox.html` + `sandbox.js`) that runs in a full Chrome tab. It connects to the same bridge server with `context:"page"` and handles only `sandbox.fetch` commands — page-context fetch handles zstd natively via Chrome's network stack.

The bridge server routes `sandbox.fetch` commands only to `context:"page"` connections. This fixes a bug in the legacy notion-onboarding project where the BridgeHub DO round-robined `sandbox.fetch` to any connection (including the background SW, which can't handle zstd).

## File Inventory

```
onboard-automation-common/
├── extension/                      # Chrome MV3 extension (the main deliverable)
│   ├── manifest.json               # 41 lines — MV3, 8 permissions, no service branding
│   ├── background.js               # 219 lines — orchestrator: load handlers, wire connection
│   ├── popup.{html,js}             # 300 lines — config + status + log feed
│   ├── sandbox.{html,js}           # 275 lines — page-context zstd-native fetcher
│   ├── lib/
│   │   ├── protocol.js             # 179 lines — command/message/envelope types (single source of truth)
│   │   ├── connection.js           # 429 lines — WS+HTTP fallback, watchdog, idle healing, backoff
│   │   ├── logger.js               # 100 lines — structured logger with commandId/tabId/durationMs
│   │   └── send.js                 # 90 lines — sendResult/sendError/sendEvent/sendLog helpers
│   ├── handlers/
│   │   ├── fetch.js                # 120 lines — fetch + page.fetch (zstd handling)
│   │   ├── tabs.js                 # 73 lines  — tabs.open/close/list/focus
│   │   ├── form.js                 # 149 lines — form.fill/click/wait/eval (React-safe + CDP)
│   │   ├── xhr.js                  # 128 lines — xhr.intercept (one-shot CDP Network capture)
│   │   ├── cookies.js              # 69 lines  — cookies.get/getAll/set (no default domain)
│   │   ├── screenshot.js           # 65 lines  — tabId-aware screenshot (fixes legacy bug)
│   │   ├── captcha.js              # 114 lines — multi-provider (hcaptcha/recaptcha/turnstile/cloudflare)
│   │   ├── sandbox.js              # 33 lines  — sandbox.open
│   │   └── debug.js                # 504 lines — activatable debug commands (HAR/console/network/trace/dom/storage/screenshot-fullpage)
│   └── icons/                      # 4 placeholder PNGs
│
├── worker-template/                # Cloudflare Worker + BridgeHub DO
│   ├── src/
│   │   ├── index.ts                # Hono router with auth middleware
│   │   ├── bridge-hub.ts           # Durable Object: connections, pending, cross-channel correlation
│   │   └── types.ts                # Protocol types (single source of truth for TS)
│   ├── wrangler.toml.example       # Template config
│   ├── package.json
│   ├── tsconfig.json
│   └── migrations/
│       └── 0001_init.sql           # Optional event_logs table
│
├── python-template/                # Async Python client + dev daemon
│   ├── onboard_common/
│   │   ├── __init__.py             # Public API
│   │   ├── extension_bridge.py     # Async client mirroring all commands
│   │   ├── protocol.py             # Python types matching TS
│   │   └── exceptions.py           # Bridge exception hierarchy
│   ├── scripts/
│   │   ├── run_bridge.py           # aiohttp daemon (dev)
│   │   └── daemonize.py            # Double-fork helper
│   ├── requirements.txt
│   └── README.md
│
├── docs/
│   ├── PROTOCOL.md                 # Wire protocol spec (single source of truth)
│   ├── ARCHITECTURE.md             # This file
│   ├── DEBUGGING.md                # Activatable debug commands + when to use them
│   └── MIGRATION.md                # How to migrate a legacy service to this common base
│
└── README.md                       # Project overview
```

## Comparison to Legacy Projects

| Aspect | Legacy (notion/supabase) | Unified (this project) |
|--------|--------------------------|------------------------|
| Extension lines per service | ~2000 (duplicated) | ~2900 (shared) |
| Service-specific extension code | ~5 lines (cookie domain, default URL) | 0 lines (fully parameterized) |
| Resiliency features | notion: full; supabase: partial | full (best of both) |
| Bug fixes | applied twice | applied once |
| New service onboarding cost | ~3000 lines copy + service logic | service logic only (~500 lines) |
| Debug capability | `xhr.intercept` only (one-shot) | 11 activatable debug commands |
| Captcha support | hCaptcha only | hCaptcha + reCAPTCHA + Turnstile + Cloudflare |
| Cookie domain | hardcoded per service | derived from URL or caller-specified |
| Screenshot tabId | ignored (captures active tab) | tabId-aware (focuses + restores) |
| Protocol versioning | none | `protocolVersion: "1.0"` + capability advertisement |
| Trace correlation | none (per-hop IDs only) | `traceId` flows through commands → logs → results → events |
| Logging | free-text | structured (commandId, tabId, durationMs, traceId) |
