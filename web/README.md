# Web UX — Onboard Automation Dashboard

Next.js 16 + Tailwind 4 + shadcn/ui single-page dashboard that drives the
Python backend on `:3001` (backend/api). Everything the backend can do is
triggerable from here — but the REST API remains the primary interface
(API-first; the dashboard is just a consumer).

## What's in here

- `src/app/page.tsx` — the dashboard: accounts table (signup IP + geo),
  single signup, batch mode, live job queue, chat (model/effort select)
- `src/lib/onboard-api.ts` — typed API client
- `src/components/ui/*` — the shadcn components the page uses
- `Caddyfile` — gateway: `:81` → `:3000`, `?XTransformPort=3001` → backend

## Run (inside the Z-Container sandbox)

The app lives at `/home/z/my-project` (the platform's Next.js project root)
with this folder's files copied over it; the dev server auto-runs on :3000.
For a fresh checkout elsewhere:

```bash
bun install
bun run dev          # :3000
python3 ../backend/api/serve_daemon.py   # :3001 (the API it talks to)
```

Client-side fetches use ONLY relative paths + `?XTransformPort=3001`
(gateway rule) — never `http://localhost:3001`.

## API surface (summary — full reference: docs/BACKEND-API.md)

| Method | Path | Purpose |
|---|---|---|
| GET | /api/health · /api/stats · /api/models · /api/ips | meta |
| GET | /api/accounts[/{id}] | list / detail (?reveal=1 for full tokens) |
| POST | /api/signup | warm-session signup (+tail) |
| POST | /api/batch | N accounts, cooldown, country rotation |
| POST | /api/accounts/{id}/tail | (re)provision |
| POST | /api/accounts/{id}/chat | one chat turn |
| POST | /api/accounts/{id}/export-session | regen notion_tail session file |
| GET | /api/jobs[/{id}] · POST /api/jobs/{id}/cancel | queue |
