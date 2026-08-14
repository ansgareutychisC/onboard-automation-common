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
# State — single-extension for local dev (round-robin is overkill here)
# ---------------------------------------------------------------------------

class BridgeState:
    def __init__(self, auth_token: str = ""):
        self.auth_token = auth_token
        self.ws_conn: Optional[web.WebSocketResponse] = None  # background SW
        self.sandbox_conn: Optional[web.WebSocketResponse] = None  # sandbox page
        self.pending: dict[str, asyncio.Future] = {}
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
        exts.append({"context": "page", "readyState": 1, "agentId": "sandbox-page"})
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

    future: asyncio.Future = asyncio.get_event_loop().create_future()
    STATE.pending[cmd_id] = future
    STATE.commands_received += 1

    try:
        await target_ws.send_json(cmd)
    except Exception as e:
        STATE.pending.pop(cmd_id, None)
        return web.json_response({"ok": False, "id": cmd_id, "error": f"Failed to send: {e}"}, status=502)

    # Set up timeout
    async def _timeout():
        await asyncio.sleep(timeout + 5)
        if cmd_id in STATE.pending:
            STATE.pending.pop(cmd_id)
            future.set_exception(asyncio.TimeoutError(f"Command {cmd.get('type')} ({cmd_id}) timed out after {timeout}s"))

    asyncio.create_task(_timeout())

    try:
        result = await future
        return web.json_response({"ok": True, "id": cmd_id, **result})
    except asyncio.TimeoutError as e:
        return web.json_response({"ok": False, "id": cmd_id, "error": str(e)}, status=504)
    except Exception as e:
        return web.json_response({"ok": False, "id": cmd_id, "error": str(e)}, status=500)


async def poll_for_commands(request: web.Request) -> web.Response:
    """Extension polls for queued commands (SOS HTTP mode)."""
    agent_id = request.query.get("agentId", "")
    wait_s = int(request.query.get("wait", "25"))
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

    STATE.http_results[cmd_id] = body
    fut = STATE.pending.pop(cmd_id, None)
    if fut and not fut.done():
        if body.get("ok"):
            fut.set_result(body)
        else:
            fut.set_exception(Exception(body.get("error", "Command failed")))
        STATE.commands_completed += 1
    return web.json_response({"ok": True})


async def send_http(request: web.Request) -> web.Response:
    """Client enqueues a command for an HTTP-polling extension."""
    body = await request.json()
    cmd = body.get("cmd", {})
    cmd_id = cmd.get("id") or ("cmd_" + uuid.uuid4().hex[:12])
    cmd["id"] = cmd_id
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
    ws = web.WebSocketResponse(max_msg_size=50 * 1024 * 1024, heartbeat=15.0, autoping=True)
    await ws.prepare(request)

    conn_context = "worker"  # updated on connect message
    conn_agent_id = ""

    async for msg in ws:
        if msg.type == WSMsgType.TEXT:
            try:
                data = json.loads(msg.data)
            except json.JSONDecodeError:
                continue
            msg_type = data.get("type")

            if msg_type == "auth":
                if STATE.auth_token and data.get("token") != STATE.auth_token:
                    await ws.close(code=1008, message=b"Invalid token")
                    return ws
                await ws.send_json({"type": "auth-ok"})
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
                    STATE.http_results[cmd_id] = data
                    fut = STATE.pending.pop(cmd_id, None)
                    if fut and not fut.done():
                        if data.get("ok"):
                            fut.set_result(data)
                        else:
                            fut.set_exception(Exception(data.get("error", "Command failed")))
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
    # Fail any pending commands for this connection
    for cmd_id, fut in list(STATE.pending.items()):
        if not fut.done():
            fut.set_exception(ConnectionError("Extension disconnected"))
    logger.info("extension disconnected: agentId=%s context=%s", conn_agent_id, conn_context)
    return ws


# ---------------------------------------------------------------------------

def build_app(auth_token: str = "") -> web.Application:
    global STATE
    STATE = BridgeState(auth_token=auth_token)
    app = web.Application()
    app.router.add_get("/", status_page)
    app.router.add_get("/health", health)
    app.router.add_get("/api/extensions", get_extensions)
    app.router.add_post("/api/command", send_command)
    app.router.add_get("/api/poll", poll_for_commands)
    app.router.add_post("/api/result", post_result)
    app.router.add_post("/api/send-http", send_http)
    app.router.add_get("/api/result/{id}", get_result_by_id)
    app.router.add_get("/ws", ws_handler)
    # Also accept WS at "/" for Caddy XTransformPort compatibility
    app.router.add_get("", ws_handler)
    return app


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1", help="bind host (use 0.0.0.0 for external)")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--auth-token", default="")
    parser.add_argument("--daemon", action="store_true", help="double-fork into background")
    parser.add_argument("--pid-file", default="/tmp/bridge_daemon.pid")
    parser.add_argument("--log-file", default="/tmp/bridge_daemon.log")
    parser.add_argument("--log-level", default="INFO")
    args = parser.parse_args()

    logging.basicConfig(level=args.log_level, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")

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
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    async def _shutdown(app):
        if STATE.ws_conn and not STATE.ws_conn.closed:
            await STATE.ws_conn.close()
        if STATE.sandbox_conn and not STATE.sandbox_conn.closed:
            await STATE.sandbox_conn.close()

    app.on_shutdown.append(_shutdown)

    logger.info("starting bridge daemon on %s:%s", args.host, args.port)
    web.run_app(app, host=args.host, port=args.port, loop=loop, print=None)


if __name__ == "__main__":
    main()
