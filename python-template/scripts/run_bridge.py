#!/usr/bin/env python3
"""scripts.run_bridge

Local aiohttp daemon that relays between Python clients and the browser
extension via WebSocket + HTTP. Use this for local dev; use the
worker-template/ Cloudflare Worker for production.

The daemon mirrors the same REST API as the worker:
    GET  /health
    GET  /api/extensions
    POST /api/command
    GET  /api/poll       (extension polls)
    POST /api/result     (extension posts results)
    POST /api/send-http  (client enqueues for HTTP-polling extension)
    GET  /api/result/:id (client polls for result)
    WS   /ws             (extension connects here)

Usage:
    python scripts/run_bridge.py --host 0.0.0.0 --port 8787

    # As a daemon (double-forked, survives shell exits):
    python scripts/run_bridge.py --daemon --pid-file /tmp/bridge.pid --log-file /tmp/bridge.log

Security:
    All /api/* routes and the /ws handler require `Authorization: Bearer <token>`
    matching --auth-token (if set). If --auth-token is empty (default for
    local dev), auth is disabled with a warning. NEVER run with empty
    --auth-token on a public-facing host.
"""

from __future__ import annotations
import argparse
import asyncio
import json
import logging
import os
import signal
import sys
import time
import uuid
from typing import Any, Optional

import aiohttp
from aiohttp import web, WSMsgType

logger = logging.getLogger("bridge_daemon")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

MAX_QUEUE = 1000  # ISSUE-7 fix: cap the HTTP command queue (DoS protection)
MAX_HTTP_RESULTS = 1000  # cap the http_results map (DoS protection)
HTTP_RESULT_TTL_S = 300  # 5 min — results older than this are evicted
SWEEP_INTERVAL_S = 60  # sweeper runs every 60s

# ---------------------------------------------------------------------------
# State — single-extension for local dev (round-robin is overkill here)
# ---------------------------------------------------------------------------

class BridgeState:
    def __init__(self, auth_token: str = ""):
        self.auth_token = auth_token
        self.ws_conn: Optional[web.WebSocketResponse] = None  # background SW
        self.sandbox_conn: Optional[web.WebSocketResponse] = None  # sandbox page
        # ISSUE-6 fix: track which ws connection each pending command was sent to,
        # so on disconnect we only fail futures for THAT connection (not all).
        self.pending: dict[str, tuple[asyncio.Future, Optional[web.WebSocketResponse]]] = {}
        self.http_command_queue: list[dict] = []
        self.http_results: dict[str, dict] = {}
        self.commands_received = 0
        self.commands_completed = 0
        self.commands_failed = 0
        self.recent_logs: list[dict] = []
        self.started_at = time.time()

    def add_log(self, entry: dict) -> None:
        self.recent_logs.append(entry)
        if len(self.recent_logs) > 200:
            self.recent_logs.pop(0)


STATE: Optional[BridgeState] = None


# ---------------------------------------------------------------------------
# Auth middleware — ISSUE-2 fix
# ---------------------------------------------------------------------------

@web.middleware
async def auth_middleware(request: web.Request, handler):
    """Require Authorization: Bearer <token> on /api/* routes (skip if no token set)."""
    if not STATE.auth_token:
        # No token configured — auth disabled (local dev only). Log once on first request.
        if not getattr(auth_middleware, "_warned", False):
            logger.warning("AUTH DISABLED — --auth-token not set. Do not run on a public host.")
            auth_middleware._warned = True  # type: ignore
        return await handler(request)
    # /health and / are public (liveness + status page)
    if request.path in ("/health", "/", "/ws", ""):
        return await handler(request)
    # /api/* requires Bearer token
    if request.path.startswith("/api/"):
        auth = request.headers.get("authorization", "")
        token = auth[7:] if auth.startswith("Bearer ") else ""
        if token != STATE.auth_token:
            return web.json_response({"ok": False, "error": "unauthorized"}, status=401)
    return await handler(request)


# ---------------------------------------------------------------------------
# HTTP routes
# ---------------------------------------------------------------------------

async def health(request: web.Request) -> web.Response:
    return web.json_response({
        "ok": True,
        "service": "onboard-automation-bridge-daemon",
        "protocolVersion": "1.0",
        "uptime_seconds": time.time() - STATE.started_at,
        "extension_connected": STATE.ws_conn is not None and not STATE.ws_conn.closed,
        "sandbox_connected": STATE.sandbox_conn is not None and not STATE.sandbox_conn.closed,
        "commands_received": STATE.commands_received,
        "commands_completed": STATE.commands_completed,
        "commands_failed": STATE.commands_failed,
    })


async def get_extensions(request: web.Request) -> web.Response:
    exts = []
    if STATE.ws_conn and not STATE.ws_conn.closed:
        exts.append({"context": "worker", "readyState": 1, "agentId": getattr(STATE.ws_conn, "_agent_id", "")})
    if STATE.sandbox_conn and not STATE.sandbox_conn.closed:
        exts.append({"context": "page", "readyState": 1, "agentId": getattr(STATE.sandbox_conn, "_agent_id", "")})
    return web.json_response({"extensions": exts, "pendingCount": len(STATE.pending), "queuedCommands": len(STATE.http_command_queue)})


async def send_command(request: web.Request) -> web.Response:
    body = await request.json()
    cmd = body.get("cmd", {})
    timeout = body.get("timeout", 30.0)
    cmd_id = cmd.get("id") or ("cmd_" + uuid.uuid4().hex[:12])
    cmd["id"] = cmd_id

    # Route to sandbox for sandbox.fetch, else to worker
    target_ws = STATE.sandbox_conn if cmd.get("type") == "sandbox.fetch" else STATE.ws_conn
    if not target_ws or target_ws.closed:
        return web.json_response({"ok": False, "id": cmd_id, "error": "No extension connected (context=" + ("page" if cmd.get("type") == "sandbox.fetch" else "worker") + ")"}, status=503)

    # ISSUE-30 fix: use get_running_loop (not deprecated get_event_loop)
    loop = asyncio.get_running_loop()
    future: asyncio.Future = loop.create_future()
    # ISSUE-6 fix: store the target_ws with the future so disconnect can fail only the right ones
    STATE.pending[cmd_id] = (future, target_ws)
    STATE.commands_received += 1

    try:
        await target_ws.send_json(cmd)
    except Exception as e:
        STATE.pending.pop(cmd_id, None)
        # ISSUE-R4-1 fix: ws.send_json() throws when the WS transitioned OPEN→CLOSING
        # between the check and now. The command was NEVER sent. Treat as
        # "Extension disconnected" (503) so the Python client falls back to the
        # HTTP queue — safe because the command was never delivered (no
        # duplicate-execution risk).
        return web.json_response({"ok": False, "id": cmd_id, "error": f"Extension disconnected (failed to send: {e})"}, status=503)

    # Set up timeout. ISSUE-30 fix: store the task so it isn't GC'd.
    timeout_task: Optional[asyncio.Task] = None

    async def _timeout():
        await asyncio.sleep(timeout + 5)
        if cmd_id in STATE.pending:
            STATE.pending.pop(cmd_id)
            if not future.done():
                future.set_exception(asyncio.TimeoutError(f"Command {cmd.get('type')} ({cmd_id}) timed out after {timeout}s"))

    timeout_task = asyncio.create_task(_timeout())

    try:
        # ISSUE-R2-11 fix: the future always RESOLVES with the result dict (even
        # when ok:false). The HTTP handler returns 200 with {ok:false, error:...}
        # so the Python client gets a typed BridgeCommandError via raise_for_error().
        result = await future
        return web.json_response({"ok": result.get("ok", False), "id": cmd_id, **{k: v for k, v in result.items() if k not in ("ok", "id", "_received_at")}})
    except asyncio.TimeoutError as e:
        # ISSUE-R3-4 fix: 504 for timeouts (Python client raises BridgeTimeoutError)
        return web.json_response({"ok": False, "id": cmd_id, "error": str(e)}, status=504)
    except ConnectionError as e:
        # ISSUE-R3-5 fix: 503 for mid-command disconnect (Python client falls back to HTTP)
        return web.json_response({"ok": False, "id": cmd_id, "error": str(e)}, status=503)
    except Exception as e:
        return web.json_response({"ok": False, "id": cmd_id, "error": str(e)}, status=500)
    finally:
        if timeout_task and not timeout_task.done():
            timeout_task.cancel()


async def poll_for_commands(request: web.Request) -> web.Response:
    """Extension polls for queued commands (SOS HTTP mode)."""
    agent_id = request.query.get("agentId", "")
    # ISSUE-24 fix (daemon side): cap wait_s at 60s
    wait_s = min(int(request.query.get("wait", "25")), 60)
    deadline = time.time() + wait_s
    while time.time() < deadline:
        if STATE.http_command_queue:
            cmds = [STATE.http_command_queue.pop(0) for _ in range(min(50, len(STATE.http_command_queue)))]
            return web.json_response({"commands": [c["cmd"] for c in cmds]})
        await asyncio.sleep(0.5)
    return web.json_response({"commands": []})


async def post_result(request: web.Request) -> web.Response:
    """Extension posts a result (WS or HTTP)."""
    body = await request.json()
    cmd_id = body.get("id")
    if not cmd_id:
        return web.json_response({"ok": False, "error": "missing id"}, status=400)

    # ISSUE-9 fix (daemon side): stamp received-at time so the sweeper can evict
    body["_received_at"] = time.time()
    STATE.http_results[cmd_id] = body
    # Cap the results map (DoS protection)
    if len(STATE.http_results) > MAX_HTTP_RESULTS:
        # Evict oldest by _received_at
        oldest = min(STATE.http_results.items(), key=lambda kv: kv[1].get("_received_at", 0))
        STATE.http_results.pop(oldest[0], None)

    fut_entry = STATE.pending.pop(cmd_id, None)
    if fut_entry:
        fut, _ws = fut_entry
        if not fut.done():
            # ISSUE-R2-11 fix: always RESOLVE (not raise) with the full body, even
            # when ok:false. The send_command HTTP handler returns 200 with the
            # {ok:false} body so the Python client gets a typed BridgeCommandError.
            fut.set_result(body)
            STATE.commands_completed += 1
    return web.json_response({"ok": True})


async def send_http(request: web.Request) -> web.Response:
    """Client enqueues a command for an HTTP-polling extension."""
    body = await request.json()
    cmd = body.get("cmd", {})
    cmd_id = cmd.get("id") or ("cmd_" + uuid.uuid4().hex[:12])
    cmd["id"] = cmd_id
    # ISSUE-7 fix: cap the queue. If full, return 503 (don't silently drop oldest).
    if len(STATE.http_command_queue) >= MAX_QUEUE:
        return web.json_response({"ok": False, "error": f"HTTP command queue full ({MAX_QUEUE})"}, status=503)
    STATE.http_command_queue.append({"id": cmd_id, "cmd": cmd, "queued_at": time.time()})
    return web.json_response({"id": cmd_id})


async def get_result_by_id(request: web.Request) -> web.Response:
    cmd_id = request.match_info["id"]
    if cmd_id in STATE.http_results:
        return web.json_response(STATE.http_results.pop(cmd_id))
    return web.Response(status=404, text="not ready")


async def status_page(request: web.Request) -> web.StreamResponse:
    html = """
    <!DOCTYPE html><html><head><meta charset=utf-8><meta http-equiv=refresh content=5>
    <title>Bridge Daemon</title><style>body{font-family:monospace;background:#1a1a1a;color:#e0e0e0;padding:20px}</style>
    </head><body><h1>Bridge Daemon</h1><pre id=status>Loading...</pre>
    <script>fetch('/health').then(r=>r.json()).then(d=>document.getElementById('status').textContent=JSON.stringify(d,null,2))</script>
    </body></html>
    """
    return web.Response(text=html, content_type="text/html")


# ---------------------------------------------------------------------------
# WebSocket handler (extension connects here)
# ---------------------------------------------------------------------------

async def ws_handler(request: web.Request) -> web.WebSocketResponse:
    # ISSUE-R2-1 fix: do NOT check auth at the WS upgrade. The browser's
    # WebSocket() API cannot send custom headers (Authorization), and the
    # extension's _buildWsUrl doesn't append ?token=. Auth happens via the
    # in-band AUTH message below (the same mechanism the DO uses).
    # The HTTP auth middleware (auth_middleware) covers the /api/* routes;
    # the WS path relies on the authenticated flag gated by the AUTH message.
    ws = web.WebSocketResponse(max_msg_size=50 * 1024 * 1024, heartbeat=15.0, autoping=True)
    await ws.prepare(request)

    conn_context = "worker"  # updated on connect message
    conn_agent_id = ""
    # ISSUE-1 fix: track authenticated state. If auth_token is set, the client
    # MUST send an `auth` message before `connect`/`result`/`event` are accepted.
    authenticated = not STATE.auth_token  # no token = always authenticated (local dev)

    async for msg in ws:
        if msg.type == WSMsgType.TEXT:
            try:
                data = json.loads(msg.data)
            except json.JSONDecodeError:
                continue
            msg_type = data.get("type")

            # ISSUE-1 fix: pre-auth gate. Only `auth` is processed before authenticated.
            if not authenticated:
                if msg_type == "auth":
                    if data.get("token") == STATE.auth_token:
                        authenticated = True
                        await ws.send_json({"type": "auth-ok"})
                    else:
                        await ws.close(code=1008, message=b"Invalid token")
                        return ws
                    continue
                # Drop all other messages until authenticated
                continue

            if msg_type == "connect":
                conn_context = data.get("context", "worker")
                conn_agent_id = data.get("agentId", "")
                ws._agent_id = conn_agent_id  # type: ignore
                if conn_context == "page":
                    STATE.sandbox_conn = ws
                else:
                    STATE.ws_conn = ws
                logger.info("extension connected: agentId=%s context=%s", conn_agent_id, conn_context)
                continue

            if msg_type == "result":
                cmd_id = data.get("id")
                if cmd_id:
                    data["_received_at"] = time.time()
                    STATE.http_results[cmd_id] = data
                    fut_entry = STATE.pending.pop(cmd_id, None)
                    if fut_entry:
                        fut, _ws = fut_entry
                        if not fut.done():
                            # ISSUE-R2-11 fix: always RESOLVE with the full body,
                            # even when ok:false. The send_command handler returns
                            # 200 with {ok:false} so the Python client gets a
                            # typed BridgeCommandError via raise_for_error().
                            fut.set_result(data)
                            STATE.commands_completed += 1
                continue

            if msg_type == "log":
                STATE.add_log(data)
                logger.info("[ext:%s] %s %s", conn_agent_id, data.get("message"), data.get("data") or "")
                continue

            if msg_type == "pong":
                continue

            if msg_type == "event":
                logger.debug("[ext:%s] event: %s", conn_agent_id, data.get("event"))
                continue

        elif msg.type == WSMsgType.ERROR:
            logger.error("ws error: %s", ws.exception())
            break

    # Cleanup
    if conn_context == "page" and STATE.sandbox_conn is ws:
        STATE.sandbox_conn = None
    elif STATE.ws_conn is ws:
        STATE.ws_conn = None
    # ISSUE-6 fix: only fail pending commands that were sent to THIS ws connection.
    # Previously the code failed ALL pending commands on any disconnect.
    for cmd_id, (fut, target_ws) in list(STATE.pending.items()):
        if target_ws is ws and not fut.done():
            fut.set_exception(ConnectionError("Extension disconnected"))
            STATE.pending.pop(cmd_id, None)
    logger.info("extension disconnected: agentId=%s context=%s", conn_agent_id, conn_context)
    return ws


# ---------------------------------------------------------------------------
# Sweeper — drop stale queued commands + http_results
# ---------------------------------------------------------------------------

async def _sweeper():
    """Background task that drops stale entries from http_command_queue and http_results."""
    while True:
        await asyncio.sleep(SWEEP_INTERVAL_S)
        now = time.time()
        # Drop queued commands older than 5 min
        STATE.http_command_queue[:] = [c for c in STATE.http_command_queue if now - c.get("queued_at", 0) < HTTP_RESULT_TTL_S]
        # Drop stale http_results
        stale_ids = [cid for cid, r in STATE.http_results.items() if now - r.get("_received_at", 0) > HTTP_RESULT_TTL_S]
        for cid in stale_ids:
            STATE.http_results.pop(cid, None)


# ---------------------------------------------------------------------------

def build_app(auth_token: str = "") -> web.Application:
    global STATE
    STATE = BridgeState(auth_token=auth_token)
    app = web.Application(middlewares=[auth_middleware])
    app.router.add_get("/", status_page)
    app.router.add_get("/health", health)
    app.router.add_get("/api/extensions", get_extensions)
    app.router.add_post("/api/command", send_command)
    app.router.add_get("/api/poll", poll_for_commands)
    app.router.add_post("/api/result", post_result)
    app.router.add_post("/api/send-http", send_http)
    app.router.add_get("/api/result/{id}", get_result_by_id)
    app.router.add_get("/ws", ws_handler)
    # Also accept WS at "" (root path) for Caddy XTransformPort compatibility
    app.router.add_get("", ws_handler)

    # Start the sweeper as a cleanup-context task
    async def _start_sweeper(app):
        task = asyncio.create_task(_sweeper())
        yield
        task.cancel()
        try: await task
        except asyncio.CancelledError: pass

    app.cleanup_ctx.append(_start_sweeper)
    return app


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1", help="bind host (use 0.0.0.0 for external)")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--auth-token", default="", help="Bearer token for /api/* + /ws auth. REQUIRED if binding to 0.0.0.0.")
    parser.add_argument("--daemon", action="store_true", help="double-fork into background")
    parser.add_argument("--pid-file", default="/tmp/bridge_daemon.pid")
    parser.add_argument("--log-file", default="/tmp/bridge_daemon.log")
    parser.add_argument("--log-level", default="INFO")
    args = parser.parse_args()

    logging.basicConfig(level=args.log_level, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")

    # Safety check: refuse to bind externally without auth
    if args.host not in ("127.0.0.1", "localhost", "::1") and not args.auth_token:
        logger.error("REFUSING TO START: --host %s without --auth-token is insecure. Use --auth-token <secret> or bind to 127.0.0.1.", args.host)
        sys.exit(1)

    if args.daemon:
        # Inline double-fork (avoid importing daemonize.py which may not be on path)
        from pathlib import Path
        if os.fork() > 0: os._exit(0)
        os.setsid()
        if os.fork() > 0: os._exit(0)
        sys.stdout.flush(); sys.stderr.flush()
        devnull = os.open("/dev/null", os.O_RDWR)
        os.dup2(devnull, 0)
        log_fd = os.open(args.log_file, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
        os.dup2(log_fd, 1); os.dup2(log_fd, 2); os.close(log_fd)
        os.close(devnull)
        Path(args.pid_file).write_text(str(os.getpid()))
        logger.info("daemonized, pid=%s", os.getpid())

    app = build_app(auth_token=args.auth_token)

    # Graceful shutdown
    async def _shutdown(app):
        if STATE.ws_conn and not STATE.ws_conn.closed:
            await STATE.ws_conn.close()
        if STATE.sandbox_conn and not STATE.sandbox_conn.closed:
            await STATE.sandbox_conn.close()

    app.on_shutdown.append(_shutdown)

    logger.info("starting bridge daemon on %s:%s (auth=%s)", args.host, args.port, "enabled" if args.auth_token else "DISABLED")
    web.run_app(app, host=args.host, port=args.port, print=None)


if __name__ == "__main__":
    main()
