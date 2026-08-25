#!/usr/bin/env python3
"""
Onboard Automation Bridge — dev daemon (python-dev-daemon/bridge.py)

A LOCAL, agent-driven debugging backend for the Onboard Automation Bridge
extension. Ported (minimally) from notion-onboarding-automation v0.8.4's
scripts/run_bridge_aiohttp.py — same wire protocol, minus the notion-specific
dashboard/SQLite persistence (this is a dev tool, not production; production
is the Phase 2 CF Worker, HTTP-only, reading the same Turso DB).

What it speaks (matches extension/background.js exactly):
  WebSocket  /  (also /ws)   — the extension connects here
    ext → daemon: {type:'auth', token} · {type:'connect', agentId, userAgent}
                 · {type:'pong', ts} (every 10s) · {type:'result', id, ...}
                 · {type:'captureBuffer', ...} (if forwarding enabled)
    daemon → ext: {type:'ping'} (every 25s) · any command {id, type, ...args}
  HTTP (curl-able remote control):
    GET  /health                 — {ok, agents, uptime}
    GET  /  or /status           — this status page (auto-refresh)
    GET  /api/status             — JSON: agents + recent activity
    POST /api/command            — body: any command JSON (no id needed).
                                   Forwarded to the connected extension,
                                   waits for the result, returns it.
    GET  /api/poll?agentId&wait  — extension HTTP-fallback long-poll
    POST /api/result             — extension HTTP-fallback result post

Usage:
    python3 python-dev-daemon/bridge.py [--host 0.0.0.0] [--port 3000] [--token SECRET]

Connect from the extension popup:
    local:   ws://127.0.0.1:3000
    sandbox: wss://preview-<bot-id>.space-z.ai/   (port 3000 is the gateway's
             default proxy target; the gateway upgrades WS at path "/")

Security: it executes whatever commands you POST in your real browser. Bind
to 127.0.0.1 for local use; if you must expose it, set --token and configure
the same token in the extension (authToken in chrome.storage.local).
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import time
import uuid

try:
    from aiohttp import web, WSMsgType
except ImportError:
    raise SystemExit("aiohttp is required: pip install aiohttp")

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("bridge")

# -----------------------------------------------------------------------------
# State
# -----------------------------------------------------------------------------

STARTED_AT = time.time()
AUTH_TOKEN: str | None = None          # None = accept any token (local dev)
COMMAND_TIMEOUT_S = 90                  # how long /api/command waits for a result
MAX_HISTORY = 200

agents: dict[str, dict] = {}            # agentId → {ws, connectedAt, lastSeen, userAgent}
pending: dict[str, asyncio.Future] = {} # commandId → future resolved by 'result'
poll_queues: dict[str, asyncio.Queue] = {}  # agentId → queue for HTTP-poll delivery
history: list[dict] = []                # last N command/result events (status page)


def record(kind: str, **kw) -> None:
    history.append({"kind": kind, "ts": time.time(), **kw})
    if len(history) > MAX_HISTORY:
        del history[: len(history) - MAX_HISTORY]


# -----------------------------------------------------------------------------
# WebSocket handling
# -----------------------------------------------------------------------------

async def ws_handler(request: web.Request) -> web.WebSocketResponse | web.Response:
    # A plain browser GET on "/" (no WebSocket upgrade headers) gets the
    # status page — the same URL the extension WS-upgrades to. This matters
    # for the sandbox preview URL: visiting it in a browser shows the daemon
    # dashboard instead of an upgrade error.
    if request.headers.get("Upgrade", "").lower() != "websocket":
        return await handle_status_page(request)

    ws = web.WebSocketResponse(heartbeat=55)  # server-side ping/pong keepalive
    await ws.prepare(request)
    peer = request.remote
    agent_id = None
    log.info("ws connected from %s", peer)
    record("ws.connect", peer=peer)

    try:
        async for msg in ws:
            if msg.type != WSMsgType.TEXT:
                continue
            try:
                data = json.loads(msg.data)
            except (ValueError, TypeError):
                continue

            mtype = data.get("type")

            if mtype == "auth":
                token = data.get("token") or ""
                if AUTH_TOKEN and token != AUTH_TOKEN:
                    log.warning("ws auth FAILED from %s — closing 4001", peer)
                    await ws.close(code=4001, message=b"invalid token")
                    return ws
                log.info("ws auth ok from %s", peer)
                continue

            if mtype == "connect":
                agent_id = data.get("agentId") or f"anon-{uuid.uuid4().hex[:8]}"
                old = agents.get(agent_id)
                if old and old.get("ws") is not None and not old["ws"].closed:
                    try:
                        await old["ws"].close(code=4002, message=b"superseded by new connection")
                    except Exception:
                        pass
                agents[agent_id] = {
                    "ws": ws,
                    "connectedAt": time.time(),
                    "lastSeen": time.time(),
                    "userAgent": data.get("userAgent") or "",
                }
                poll_queues.setdefault(agent_id, asyncio.Queue())
                log.info("agent connected: %s (%s)", agent_id, peer)
                record("agent.connect", agentId=agent_id)
                continue

            if mtype == "pong":
                if agent_id and agent_id in agents:
                    agents[agent_id]["lastSeen"] = time.time()
                continue

            if mtype == "result":
                cid = data.get("id")
                fut = pending.get(cid)
                if fut and not fut.done():
                    payload = {k: v for k, v in data.items() if k not in ("type", "id")}
                    fut.set_result({"id": cid, **payload})
                record("result", agentId=agent_id, id=cid,
                       ok=payload_ok(data))
                continue

            if mtype == "captureBuffer":
                n = len(data.get("buffer") or [])
                log.info("captureBuffer from %s: %s events (reconnect=%s)",
                         agent_id, n, data.get("reconnect"))
                record("captureBuffer", agentId=agent_id, events=n)
                continue

            # Anything else (log etc.) — just note it.
            record("ws.msg", agentId=agent_id, type=mtype)
    finally:
        if agent_id and agents.get(agent_id, {}).get("ws") is ws:
            del agents[agent_id]
        log.info("ws disconnected: %s (agent=%s)", peer, agent_id)
        record("ws.disconnect", agentId=agent_id)
    return ws


def payload_ok(data: dict):
    if "ok" in data:
        return data.get("ok")
    return None


async def ping_loop() -> None:
    """Send {type:'ping'} to every agent every 25s (the extension replies
    with pong, refreshing lastSeen; MV3 service workers also stay alive)."""
    while True:
        await asyncio.sleep(25)
        for aid, info in list(agents.items()):
            ws = info.get("ws")
            if ws is None or ws.closed:
                agents.pop(aid, None)
                continue
            try:
                await ws.send_json({"type": "ping"})
            except Exception:
                agents.pop(aid, None)


# -----------------------------------------------------------------------------
# HTTP API
# -----------------------------------------------------------------------------

def any_agent() -> dict | None:
    for info in agents.values():
        if info.get("ws") is not None and not info["ws"].closed:
            return info
    return None


async def send_command(cmd: dict, agent_id: str | None = None) -> dict:
    """Deliver a command to an extension (WS preferred, poll queue fallback)
    and await its result. Raises TimeoutError on timeout."""
    cmd = {"id": cmd.get("id") or f"cmd-{uuid.uuid4().hex[:12]}", **cmd}
    if cmd.get("type") == "macro.run":
        cmd.setdefault("source", "daemon")

    info = agents.get(agent_id) if agent_id else any_agent()
    fut: asyncio.Future = asyncio.get_running_loop().create_future()
    pending[cmd["id"]] = fut

    record("command", id=cmd["id"], type=cmd.get("type"), agentId=agent_id)
    try:
        if info and info.get("ws") is not None and not info["ws"].closed:
            await info["ws"].send_json(cmd)
        else:
            # No live WS — queue for the HTTP-poll fallback
            q = poll_queues.get(agent_id or "")
            if q is None:
                raise RuntimeError("no extension connected (and no poll queue for this agentId)")
            await q.put(cmd)

        return await asyncio.wait_for(fut, timeout=COMMAND_TIMEOUT_S)
    finally:
        pending.pop(cmd["id"], None)


async def handle_command(request: web.Request) -> web.Response:
    """POST /api/command — body: any command JSON. Returns the extension's
    result. This is the curl-able remote-control surface."""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "body must be JSON"}, status=400)
    if not isinstance(body, dict) or not body.get("type"):
        return web.json_response({"ok": False, "error": 'body must be an object with a "type" field'}, status=400)
    agent_id = request.query.get("agentId")
    try:
        result = await send_command(body, agent_id)
    except TimeoutError:
        return web.json_response({"ok": False, "error": f"extension did not answer within {COMMAND_TIMEOUT_S}s",
                                  "hint": "is the extension connected? (see /api/status)"}, status=504)
    except RuntimeError as e:
        return web.json_response({"ok": False, "error": str(e),
                                  "hint": "connect the extension first (popup → serverUrl → Connect)"}, status=503)
    return web.json_response(result)


async def handle_poll(request: web.Request) -> web.Response:
    """GET /api/poll?agentId=X&wait=N — extension HTTP fallback long-poll."""
    agent_id = request.query.get("agentId") or "anon"
    wait_s = min(float(request.query.get("wait", "25")), 55)
    q = poll_queues.setdefault(agent_id, asyncio.Queue())
    # heartbeat so /api/status shows pollers
    agents.setdefault(agent_id, {"ws": None, "connectedAt": time.time(),
                                 "lastSeen": time.time(), "userAgent": "", "via": "http-poll"})
    agents[agent_id]["lastSeen"] = time.time()

    commands = []
    try:
        item = await asyncio.wait_for(q.get(), timeout=wait_s)
        commands.append(item)
        while not q.empty():
            commands.append(q.get_nowait())
    except TimeoutError:
        pass
    return web.json_response({"commands": commands})


async def handle_result(request: web.Request) -> web.Response:
    """POST /api/result — extension HTTP fallback result post."""
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "body must be JSON"}, status=400)
    cid = data.get("id")
    fut = pending.get(cid)
    if fut and not fut.done():
        payload = {k: v for k, v in data.items() if k not in ("type", "id")}
        fut.set_result({"id": cid, **payload})
    record("result.http", id=cid, ok=payload_ok(data))
    return web.json_response({"ok": True})


async def handle_health(request: web.Request) -> web.Response:
    return web.json_response({
        "ok": True,
        "uptimeS": round(time.time() - STARTED_AT, 1),
        "agents": len(agents),
        "pendingCommands": len(pending),
    })


async def handle_api_status(request: web.Request) -> web.Response:
    now = time.time()
    return web.json_response({
        "ok": True,
        "uptimeS": round(now - STARTED_AT, 1),
        "agents": [
            {
                "agentId": aid,
                "via": "ws" if (info.get("ws") is not None and not info["ws"].closed) else "http-poll",
                "connectedForS": round(now - info.get("connectedAt", now), 1),
                "lastSeenAgoS": round(now - info.get("lastSeen", now), 1),
                "userAgent": (info.get("userAgent") or "")[:120],
            }
            for aid, info in agents.items()
        ],
        "recent": history[-40:],
    })


STATUS_PAGE = """<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Onboard Bridge — dev daemon</title>
<style>
 body { font-family: ui-monospace, 'SF Mono', Menlo, monospace; background:#1e1e1e; color:#d4d4d4; margin:24px; font-size:13px; }
 h1 { font-size:16px; color:#79c0ff; } h2 { font-size:13px; color:#f4b400; margin-top:20px; }
 .ok { color:#7ee787; } .warn { color:#f4b400; } .err { color:#ff7b72; }
 table { border-collapse:collapse; } td,th { border:1px solid #444; padding:3px 8px; text-align:left; }
 pre { white-space:pre-wrap; }
 a { color:#79c0ff; }
</style></head>
<body>
<h1>Onboard Automation Bridge — dev daemon</h1>
<p class="__STATUS_CLASS__">__STATUS__</p>
<p>Connect the extension popup: <code>ws://127.0.0.1:__PORT__</code> (local) or
<code>wss://&lt;preview-host&gt;/</code> (sandbox preview URL — port __PORT__ is the gateway proxy target).</p>
<h2>Remote control</h2>
<pre>curl -X POST http://127.0.0.1:__PORT__/api/command -H 'Content-Type: application/json' \\
  -d '{"type":"tabs.list"}'

curl -X POST http://127.0.0.1:__PORT__/api/command -H 'Content-Type: application/json' \\
  -d '{"type":"eval","function":"() => ({ url: location.href, title: document.title })"}'</pre>
<h2>Agents</h2>
__AGENTS__
<h2>Recent activity</h2>
<pre>__RECENT__</pre>
<p><a href="/api/status">/api/status</a> · <a href="/health">/health</a> · auto-refresh 3s</p>
<script>setTimeout(()=>location.reload(),3000)</script>
</body></html>"""


async def handle_status_page(request: web.Request) -> web.Response:
    port = request.app["port"]
    now = time.time()
    if agents:
        status = f'<span class="ok">{len(agents)} agent(s) connected</span>'
    else:
        status = '<span class="warn">no extension connected yet — open the extension popup and Connect</span>'
    rows = "".join(
        f"<tr><td>{aid}</td><td>{'ws' if (i.get('ws') is not None and not i['ws'].closed) else 'http-poll'}</td>"
        f"<td>{round(now - i.get('lastSeen', now), 1)}s ago</td><td>{(i.get('userAgent') or '')[:80]}</td></tr>"
        for aid, i in agents.items()
    ) or "<tr><td colspan=4>(none)</td></tr>"
    agents_html = f"<table><tr><th>agentId</th><th>via</th><th>last seen</th><th>userAgent</th></tr>{rows}</table>"
    recent = "\n".join(
        f"{time.strftime('%H:%M:%S', time.localtime(h['ts']))}  {h['kind']:14s} "
        + " ".join(f"{k}={v}" for k, v in h.items() if k not in ("ts", "kind"))
        for h in history[-25:]
    ) or "(no activity yet)"
    html = (STATUS_PAGE.replace("__STATUS_CLASS__", "ok")
            .replace("__STATUS__", status)
            .replace("__PORT__", str(port))
            .replace("__AGENTS__", agents_html)
            .replace("__RECENT__", recent))
    return web.Response(text=html, content_type="text/html")


# -----------------------------------------------------------------------------

def main() -> None:
    ap = argparse.ArgumentParser(description="Onboard Automation Bridge dev daemon")
    ap.add_argument("--host", default="0.0.0.0", help="bind host (0.0.0.0 to allow the sandbox gateway)")
    ap.add_argument("--port", type=int, default=3000, help="bind port (3000 = sandbox gateway proxy target)")
    ap.add_argument("--token", default="", help="require this auth token from the extension (empty = accept all)")
    args = ap.parse_args()

    global AUTH_TOKEN
    AUTH_TOKEN = args.token or None

    app = web.Application()
    app["port"] = args.port
    app.router.add_get("/health", handle_health)
    app.router.add_get("/api/status", handle_api_status)
    app.router.add_get("/api/status/", handle_api_status)
    app.router.add_post("/api/command", handle_command)
    app.router.add_get("/api/poll", handle_poll)
    app.router.add_post("/api/result", handle_result)
    # The extension's buildWsUrl() sets path "/" for *.space-z.ai preview URLs
    # (the gateway only upgrades WS there); direct local connections may use
    # either "/" or "/ws". Plain GETs on "/" get the status page.
    app.router.add_get("/", ws_handler)
    app.router.add_get("/ws", ws_handler)
    app.router.add_get("/status", handle_status_page)

    async def on_startup(app):
        asyncio.create_task(ping_loop())

    app.on_startup.append(on_startup)

    log.info("dev daemon listening on %s:%s (token auth %s)",
             args.host, args.port, "ON" if AUTH_TOKEN else "OFF — accept all")
    web.run_app(app, host=args.host, port=args.port, print=None)


if __name__ == "__main__":
    main()
