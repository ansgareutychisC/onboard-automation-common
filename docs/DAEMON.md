# Dev Daemon — Agent-Driven Extension Debugging

`python-dev-daemon/bridge.py` is the local backend that lets an agent (or a
terminal) drive the **Onboard Automation Bridge extension in the user's real
browser** — the "extension as remote-debug sandbox" mode.

It is a verbatim port of notion-onboarding-automation v0.8.4's
`scripts/run_bridge_aiohttp.py` (the battle-tested implementation — 5+ P0 WS
reconnect fixes, watchdog, heartbeat, HTTP-poll fallback are all preserved),
with two portability shims: a local `CommandResult` dataclass and guarded
lazy imports for the optional `notion_onboarding` package (only needed for
the notion-specific account-dashboard flows).

## Run

```bash
python3 python-dev-daemon/bridge.py            # 0.0.0.0:3000 by default
```

Port 3000 matters in the Z.ai sandbox: it's the Caddy gateway's default
proxy target, so the sandbox **preview URL serves this daemon** —
`https://preview-<bot-id>.space-z.ai/` in a browser shows the dashboard, and
the extension connects its WebSocket to `wss://preview-<bot-id>.space-z.ai/`
(the extension's `buildWsUrl` already forces path `/` for `*.space-z.ai` —
the gateway only upgrades WS there).

## Connect the extension

Popup → **Server Connection** → paste the preview URL (or
`ws://127.0.0.1:3000` when running locally) → **Connect**. Status dot turns
green; the dashboard's Extensions panel shows the agent.

## Drive the browser (from a terminal or the agent sandbox)

```bash
# any of the 23 extension commands:
curl -X POST http://127.0.0.1:3000/api/command \
  -H 'Content-Type: application/json' \
  -d '{"type":"eval","function":"() => ({ url: location.href, title: document.title })"}'

# convenience wrappers:
curl -X POST .../api/eval   -d '{"function":"() => document.title"}'
curl -X POST .../api/fetch  -d '{"url":"https://api.improvmx.com/..."}'
curl -X POST .../api/open   -d '{"url":"https://app.notion.com/signup"}'
curl -X POST .../api/cookies -d '{"url":"https://app.notion.com"}'
```

`POST /api/command` waits for the extension's result (up to 60s) and returns
it as JSON. Results of `eval`/`form.eval` come back with full return values;
`fetch` returns status + body; `cookies` returns the cookie list —
everything the agent needs to inspect the live session without you
exporting JSON logs.

## Endpoints

| Route | Purpose |
|---|---|
| `GET /` | dashboard (accounts/workspaces/extensions status) |
| `GET /health` | JSON health check |
| `GET /api/extensions` | connected extension agents (WS + HTTP-poll) |
| `POST /api/command` | **drive the browser** — any command, waits for result |
| `POST /api/eval` `/api/fetch` `/api/open` `/api/cookies` `/api/screenshot` `/api/captcha-token` | convenience wrappers |
| `GET /api/poll` `POST /api/result` | extension HTTP fallback (when WS dies) |
| `WS /` or `/ws` | the extension's WebSocket |

## Persistence

SQLite at `python-dev-daemon/bridge.db` (gitignored) — accounts, workspaces,
jobs tables (same schema as the old Worker's D1). Delete the file to reset.

## Debugging etiquette (agent-facing)

- Prefer **read-only** inspection: `eval` (DOM state), `fetch` (API probes),
  `cookies.getAll`, screenshot. The extension's value is replaying the web
  client's REST calls — not virtual clicking — except captcha/anti-bot
  interactions that genuinely need a user-shaped event.
- One command at a time; read the result before the next.
- Don't hammer: the user's real browser is on the other end.
