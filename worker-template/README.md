# worker-template

A minimal Cloudflare Worker + Durable Object that bridges Python/TS orchestrators
to the unified browser extension. Contains **zero service-specific logic** —
it only relays commands and results.

## Files

- `src/index.ts` — Hono router with auth middleware. Proxies all `/api/*` routes
  to the BridgeHub DO.
- `src/bridge-hub.ts` — Durable Object holding extension connections and pending
  commands. Supports cross-channel correlation (command sent via WS can be
  answered via HTTP POST).
- `src/types.ts` — Protocol types (single source of truth for TS).
- `migrations/0001_init.sql` — Optional `event_logs` table. Add your own
  service tables as new migrations.

## Deploy

```bash
cp wrangler.toml.example wrangler.toml
# Edit wrangler.toml — fill in database_id, name, etc.

npm install
wrangler login
wrangler d1 create onboard-automation-bridge-db
# Paste the database_id into wrangler.toml

wrangler secret put BRIDGE_TOKEN       # for production auth
wrangler d1 migrations apply DB
wrangler deploy
```

The worker will be available at `https://<name>.<account>.workers.dev`.

## Add Service-Specific Routes

Create a new file `src/service.ts`:

```typescript
import { Hono } from "hono";
import type { Env } from "./types";

export function createServiceRouter() {
  const r = new Hono<{ Bindings: Env }>();
  r.post("/run", async (c) => {
    // Your service's pipeline logic
    // Use c.env.BRIDGE_HUB to send commands to the extension
    return c.json({ ok: true });
  });
  return r;
}
```

Mount it in `index.ts`:

```typescript
import { createServiceRouter } from "./service";
app.route("/api/svc", createServiceRouter());
```

## Add Service-Specific D1 Tables

Add a new migration `migrations/0002_<your-service>.sql`:

```sql
CREATE TABLE IF NOT EXISTS accounts (
    email TEXT PRIMARY KEY,
    token TEXT NOT NULL,
    -- ... your service-specific columns
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
```

Then `wrangler d1 migrations apply DB`.
