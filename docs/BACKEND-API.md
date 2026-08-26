# BACKEND API — the productized onboarding flow

`backend/api/` is the API-first layer over the live-verified drivers.
No browser extension is involved anywhere: signup runs through ONE warm
Zenrows Browser Session (session-pinned residential IP), the tail runs
through notion_tail/notion_e2e in-process.

```
REST (FastAPI :3001)  →  JobRunner (queue, pacing)  →  ServiceDriver
                                                       ├─ NotionDriver (now)
                                                       └─ future: Supabase/Todoist/…
                                    ↓
                        SQLite (backend/api/data/onboard.db)
                        accounts · workspaces · api_keys · chats · pages
                        jobs · job_items · events  (+ full creds for replay)
```

## Run

```bash
python3 backend/api/serve_daemon.py     # double-forked, logs data/api.log
curl -s localhost:3001/api/health       # deps probe (node/playwright/ref…)
```

Env overrides: `ZENROWS_API_KEY`, `NOTION_REF_PATH`, `ONBOARD_DB`,
`ONBOARD_API_PORT`, `ONBOARD_DEFAULT_COUNTRY`.

## Endpoints

| Method | Path | Body / notes |
|---|---|---|
| GET | `/api/health` | deps + db path |
| GET | `/api/stats` | counts (accounts/provisioned/workspaces/trialing/keys/chats/jobs/IPs) |
| GET | `/api/models` | 31 surfaced models (codename, family, efforts, context) |
| GET | `/api/ips` | IP-hygiene table: ip, country, route, accounts-per-IP |
| GET | `/api/events?limit=50` | audit trail |
| GET | `/api/accounts` | `?limit&offset&reveal=1` — tokens masked unless reveal |
| GET | `/api/accounts/{id}` | detail: workspaces, api_keys, chats, pages |
| DELETE | `/api/accounts/{id}` | cascade delete |
| POST | `/api/accounts/{id}/export-session` | regenerate the notion_tail session file from stored creds (session replay) |
| POST | `/api/signup` | `{email?, country, attempts, run_tail, tail:{workspaces, chat_prompt, route, workspace_name, trial_pace_s}}` → `{job_id}` |
| POST | `/api/batch` | `{count 1..10, countries:[..], cooldown_seconds, attempts, tail:{..}}` → `{job_id}` |
| POST | `/api/accounts/{id}/tail` | `{workspaces, chat_prompt, route}` → `{job_id}` (idempotent) |
| POST | `/api/accounts/{id}/chat` | `{prompt, model?, effort?, space_id?, context_page_id?, thread_id?, route}` → `{job_id}` |
| GET | `/api/jobs` · `/api/jobs/{id}` | queue + per-item progress |
| POST | `/api/jobs/{id}/cancel` | cooperative cancel (checked between accounts / during cooldown) |

All long operations are **async jobs**: POST returns `{job_id, poll}` and
progress lands in `job_items.detail` (streamed step results) + `events`.

## Semantics worth knowing

- **Batch** is sequential BY DESIGN: the Zenrows browser plan allows one
  concurrent session and the target rate-limits identity creation per IP.
  Throughput comes from in-signup retries (new session = new IP + new email
  on captcha) and the inter-account cooldown (default 45 s). Countries
  rotate per account when `countries` has >1 entry.
- **Failure isolation**: one account's failure inside a batch marks that
  item failed and continues; the job itself ends `done` with a summary item.
- **Idempotent tail**: re-running reuses existing workspaces, skips active
  trials and valid api keys, appends new chat turns.
- **Credential persistence**: accounts row stores token_v2 (JWT), full
  cookie jar, device id, client version — everything needed to replay.
- **IP hygiene** (SKILL.md §9.5): `signup_ip`, `proxy_country`,
  `signup_route` on every account; `events` keeps the audit trail; `/api/ips`
  exposes accounts-per-IP.

## Extending to another service

Implement the `ServiceDriver` ABC (`drivers/base.py`):
`health / signup / init_session / provision / chat [+ list_models]` and
register it in `drivers/__init__.py`. The runner, DB, API and web UX are
service-agnostic — nothing else changes.

## Tests

```bash
python3 -m pytest backend/api/tests -q        # 10 unit/integration tests
```
Covers: DB upsert/sync/masking/ip-summary, runner (signup flow, batch
rotation + cooldown, failure isolation, cancel), API endpoints (health,
signup+poll, validation, chat, 404s, export-session, models/stats).
