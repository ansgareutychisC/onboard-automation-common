# MIGRATION.md — Migrating a Legacy Service to onboard-automation-common

This guide walks through migrating a legacy onboarding-automation service (e.g. `notion-onboarding-automation` or `supabase-automation`) to use the unified `onboard-automation-common` base.

## Migration Strategy

The migration is **incremental** — you can adopt the common base piece-by-piece without a big-bang rewrite. Recommended order:

1. **Adopt the common extension** (highest value, lowest risk) — eliminates ~2000 lines of duplicated code.
2. **Adopt the common Python client** — eliminates ~500 lines of duplicated bridge client code.
3. **Adopt the common worker BridgeHub** — eliminates ~350 lines of duplicated DO code.
4. **(Optional) Adopt the common Python daemon** — eliminates ~700 lines of duplicated aiohttp code.

Steps 1–4 are independent — you can do them in any order, or stop at any step.

## Step 1: Adopt the Common Extension

### 1.1 Replace the extension/ directory

Copy the entire `onboard-automation-common/extension/` directory into your service repo, replacing the existing `extension/` directory:

```bash
cd /path/to/your-service/
rm -rf extension/
cp -r /path/to/onboard-automation-common/extension/ extension/
```

### 1.2 Update the manifest branding (optional)

Edit `extension/manifest.json`:

```json
{
  "name": "Your Service Onboarding Bridge",     // ← rename
  "description": "Browser automation proxy for Your Service onboarding.",
  // ...everything else stays the same
}
```

You do NOT need to change permissions, CSP, or `web_accessible_resources` — they're already minimal and service-agnostic.

### 1.3 Update the popup default URL (optional)

The popup's default server URL field is empty by default — the user must paste their worker URL. If you want to pre-fill it with your service's worker URL, edit `extension/popup.html`:

```html
<input type="text" id="server-url" placeholder="wss://your-service-worker.xxx.workers.dev" />
```

(The placeholder is just a hint — the actual default is empty so users don't accidentally connect to the wrong service.)

### 1.4 Remove service-specific code from the extension

The legacy extensions had ~5 lines of service-specific code:

| Legacy file | Service-specific line | Action |
|-------------|----------------------|--------|
| `background.js` | `domain: c.domain || '.notion.com'` (cookies.set default) | REMOVED — common extension derives domain from URL |
| `background.js` | `domain: c.domain || '.supabase.com'` | REMOVED — same |
| `popup.html` | `wss://notion-onboarding-worker.xxx.workers.dev` hardcoded | REMOVED — common extension reads from `chrome.storage.local` |
| `sandbox.js` | `wss://preview-chat-xxx.space-z.ai/?XTransformPort=8787` | REMOVED — common sandbox reads `?server=` query param |
| `getCaptchaToken` handler | hCaptcha-only | REPLACED — common handler supports hCaptcha/recaptcha/turnstile/cloudflare via `provider` arg |

### 1.5 Update the Python orchestrator to use new command names

The common extension renamed one command:

| Legacy | Common | Notes |
|--------|--------|-------|
| `getCaptchaToken` | `captcha.getToken` | Now takes optional `provider` arg |

Update your Python orchestrator:

```python
# Before:
token_result = await bridge.get_captcha_token(tab_id)

# After:
from onboard_common import ExtensionBridge
token_result = await bridge.get_captcha_token(tab_id, provider="hcaptcha")  # or None to auto-detect
```

### 1.6 Test the migrated extension

1. Load the unpacked extension in Chrome (`chrome://extensions` → Developer mode → Load unpacked).
2. Open the popup, paste your worker URL, click Connect.
3. Run your existing Python orchestrator — it should work without changes (except the `getCaptchaToken` → `captcha.getToken` rename if you adopted the common Python client).

## Step 2: Adopt the Common Python Client

### 2.1 Add the common package

Either:
- Copy `python-template/onboard_common/` into your service repo, OR
- Install as a pip package (once you publish it), OR
- Add as a git submodule.

### 2.2 Replace the legacy `extension_bridge.py`

```bash
# Before:
your_service_onboarding/extension_bridge.py     # 484-530 lines
your_service_onboarding/signup_ext.py           # uses extension_bridge

# After:
your_service_onboarding/extension_bridge.py     # DELETED — use onboard_common.ExtensionBridge
your_service_onboarding/signup_ext.py           # updated to import from onboard_common
```

### 2.3 Update imports

```python
# Before:
from your_service_onboarding.extension_bridge import ExtensionBridge, CommandResult

# After:
from onboard_common import ExtensionBridge, CommandResult
```

### 2.4 Update method signatures

The common `ExtensionBridge` has the same method names as the legacy clients, but a few differences:

| Legacy (notion) | Legacy (supabase) | Common | Notes |
|-----------------|-------------------|--------|-------|
| `bridge.tabs_open(url)` | `bridge.tabs_open(url)` | `await bridge.tabs_open(url)` | All methods are now async |
| `bridge.get_captcha_token(tab_id)` | `bridge.get_captcha_token(tab_id)` | `await bridge.get_captcha_token(tab_id, provider=None)` | `provider` arg added |
| `bridge.form_eval(tab_id, fn, args)` | `bridge.form_eval(tab_id, fn, args)` | `await bridge.form_eval(tab_id, fn, args)` | Same shape |

### 2.5 Update your signup flow

Your service-specific signup flow (e.g. `signup_ext.py`) stays in your service repo. Just update the imports and make sure all bridge calls are `await`ed:

```python
# your_service_onboarding/signup_ext.py
from onboard_common import ExtensionBridge, CommandType

async def signup_with_extension(bridge: ExtensionBridge, *, email: str, ...):
    tab_result = await bridge.tabs_open("https://your-service.com/signup")
    tab_id = tab_result.get("tabId")
    await bridge.form_wait(tab_id, "input[type=email]", timeout_ms=15000)
    await bridge.form_fill(tab_id, "input[type=email]", email)
    # ... your service-specific selectors and flow ...
```

## Step 3: Adopt the Common Worker BridgeHub

### 3.1 Replace `worker/src/bridge-hub.ts`

```bash
cp /path/to/onboard-automation-common/worker-template/src/bridge-hub.ts your-service/worker/src/bridge-hub.ts
cp /path/to/onboard-automation-common/worker-template/src/types.ts your-service/worker/src/types.ts
```

### 3.2 Update `worker/src/index.ts`

The common `index.ts` is a Hono router shell. Your service's existing routes (e.g. `/api/run`, `/api/accounts`, dashboard HTML) should be moved into a separate `service.ts` file and mounted:

```typescript
// your-service/worker/src/index.ts
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import { BridgeHub } from "./bridge-hub";
import { createServiceRouter } from "./service";  // ← your service routes

const app = new Hono<{ Bindings: Env }>();
app.use("*", cors({ origin: "*", allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"], allowHeaders: ["content-type", "authorization", "x-request-id"] }));

// Auth middleware (same as template)
app.use("/api/*", async (c, next) => {
  if (c.env.BRIDGE_NO_AUTH === "1") return next();
  const auth = c.req.header("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (token !== c.env.BRIDGE_TOKEN) return c.json({ error: "unauthorized" }, 401);
  return next();
});

// Bridge routes (proxy to BridgeHub DO) — copy from worker-template/src/index.ts
// ... app.get("/api/extensions", ...), app.post("/api/command", ...), etc.

// Your service routes
app.route("/api", createServiceRouter());

// Your dashboard
app.get("/", (c) => c.html(dashboardHTML()));

export default app;
export { BridgeHub };
```

### 3.3 Move service-specific routes into `service.ts`

Extract your service's routes (`/api/run`, `/api/accounts`, `/api/workspaces`, etc.) from the legacy `index.ts` into a new `service.ts`:

```typescript
// your-service/worker/src/service.ts
import { Hono } from "hono";
import type { Env } from "./types";

export function createServiceRouter() {
  const r = new Hono<{ Bindings: Env }>();

  r.post("/run", async (c) => {
    // Your existing /api/run pipeline logic
    // Use c.env.BRIDGE_HUB to send commands to the extension
    // Use c.env.DB for D1 queries
    // ...
  });

  r.get("/accounts", async (c) => {
    // Your existing /api/accounts logic
    // ...
  });

  return r;
}
```

### 3.4 Update `wrangler.toml`

The common template's `wrangler.toml.example` shows the required bindings. Merge with your service's existing config:

```toml
# your-service/worker/wrangler.toml
name = "your-service-onboarding-worker"
main = "src/index.ts"
compatibility_date = "2026-08-01"
workers_dev = true

[vars]
BRIDGE_NO_AUTH = "1"  # set to "0" + wrangler secret put BRIDGE_TOKEN for production
# Your service-specific vars:
EMAIL_WORKER_URL = "https://mail-api.privatimail.com"
EMAIL_DOMAIN = "privatimail.com"

[[d1_databases]]
binding = "DB"
database_name = "your-service-onboarding-db"
database_id = "your-existing-d1-id"
migrations_dir = "migrations"

[[durable_objects.bindings]]
name = "BRIDGE_HUB"
class_name = "BridgeHub"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["BridgeHub"]
```

## Step 4: Adopt the Common Python Daemon (Optional)

If you use the local aiohttp daemon for development, replace it with the common one:

```bash
cp /path/to/onboard-automation-common/python-template/scripts/run_bridge.py your-service/scripts/run_bridge.py
```

The common daemon has the same REST API as the worker, so your Python client works against either without changes.

## Post-Migration Cleanup

After completing steps 1–3 (or 4), delete the now-redundant files from your service repo:

```bash
# Delete legacy extension code (replaced by common extension/)
rm -rf extension/

# Delete legacy bridge client (replaced by onboard_common.ExtensionBridge)
rm your_service_onboarding/extension_bridge.py

# Delete legacy daemon (if you adopted the common one)
rm scripts/run_bridge_aiohttp.py
rm scripts/daemon_bridge.py

# Delete legacy BridgeHub (replaced by common bridge-hub.ts)
# (already overwritten in step 3.1)
```

## Verifying the Migration

Run your existing end-to-end tests — they should pass without modification (except for the `getCaptchaToken` → `captcha.getToken` rename if you adopted the common Python client):

```bash
cd your-service/
pytest tests/live_e2e_test.py
pytest tests/live_signup_e2e_test.py
```

If anything fails, check:

1. **Extension popup shows "connected"** — if not, verify the worker URL is correct and the worker is deployed.
2. **`/api/extensions` returns your extension** — if not, the WS upgrade may be failing (check worker logs).
3. **Commands timeout** — verify the extension's `context` is "worker" (sandbox.fetch commands need a "page" context connection; run `sandbox.open` first).

## What NOT to Migrate

These things should stay in your service repo — they are intentionally NOT in the common base:

- **Signup flow orchestration** (`signup_ext.py`, `signup/client.py`) — service-specific selectors, multi-step flows, captcha handling.
- **Service API client** (`client.py`) — vendor REST API wrappers, auth modes, error taxonomy.
- **D1 schema + migrations** (`worker/migrations/0002_*.sql` and beyond) — service-specific tables (accounts, workspaces, jobs, etc.).
- **Dashboard HTML** (`worker/src/dashboard.ts`) — service-specific UI (signup form, accounts table, inspector tabs).
- **Email worker integration** (`signup/email_worker.py`) — the email worker itself is vendor-agnostic, but the verification-link regex is service-specific.

## Estimated Migration Effort

| Step | Time | Lines removed | Lines added |
|------|------|---------------|-------------|
| 1. Common extension | 1–2 hours | ~2000 | ~50 (manifest branding) |
| 2. Common Python client | 2–4 hours | ~500 | ~50 (import changes) |
| 3. Common worker BridgeHub | 2–4 hours | ~350 | ~100 (route extraction) |
| 4. Common Python daemon (optional) | 1 hour | ~700 | 0 |
| **Total** | **6–11 hours** | **~3550** | **~200** |

After migration, adding a NEW service costs ~500 lines (signup flow + API client + D1 schema + dashboard) instead of ~3500 lines (everything duplicated).
