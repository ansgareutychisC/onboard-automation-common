#!/usr/bin/env python3
"""
Run the Notion Onboarding Bridge as a long-running mini-service using aiohttp.

Standalone Python backend: NO Worker dependency, NO Cloudflare D1.
All dashboard data is persisted in a local SQLite file at `bridge.db`
(repo root), with the same schema as the Worker's D1 migrations
(0001 + 0002 + 0003).

Usage:
    python scripts/run_bridge_aiohttp.py [--port 3000] [--host 0.0.0.0]

HTTP endpoints:
    GET  /              — dashboard (served from dashboard/index.html)
    GET  /styles.css    — dashboard stylesheet
    GET  /app.js        — dashboard JavaScript
    GET  /bridge-status — legacy inline HTML status page (bridge-only view)
    GET  /health        — JSON health check
    GET  /api/token     — auth token for the extension

Native SQLite-backed dashboard API:
    GET  /api/accounts                    — list all accounts
    GET  /api/accounts/{id}               — single account (by id/email/user_id)
    POST /api/accounts/batch              — batch account creation
    GET  /api/workspaces                  — list all workspaces (joined w/ accounts)
    GET  /api/jobs                        — list recent jobs
    GET  /api/extensions                  — extension status (recent heartbeats)
    POST /api/signup-ext                  — create account + run signup via extension
    POST /api/accounts/{id}/retry         — retry a failed account
    POST /api/accounts/{id}/workspaces    — create workspace on existing account
    POST /api/accounts/{id}/workspaces/batch
    POST /api/relogin                     — re-login an existing account
    POST /api/clear-notion-cookies        — clear Notion cookies in the browser
    GET  /api/notion-cookies              — check existing Notion cookies

Bridge command API (extension-driving):
    POST /api/command, /api/open, /api/eval, /api/screenshot,
         /api/cookies, /api/fetch, /api/captcha-token, /api/sandbox-fetch

HTTP polling mode (in-memory — no SQLite):
    GET  /api/poll?agentId=X&wait=N       — extension polls for commands
    POST /api/result                      — extension posts a command result

WebSocket:
    ws://<host>:<port>/ws  (the extension connects here)

For remote access via the preview URL (port 3000 is the Caddy gateway's
default proxy target, so no XTransformPort query param is needed):
    wss://preview-<bot-id>.space-z.ai/ws
    https://preview-<bot-id>.space-z.ai/health
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import signal
import socket
import sqlite3
import sys
import time
import uuid
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from aiohttp import web, WSMsgType

log = logging.getLogger("notion_onboarding.bridge")

# Path to the dashboard directory — ships WITH the daemon
# (python-dev-daemon/dashboard/). DB_PATH lands next to the daemon too.
DAEMON_DIR = Path(__file__).resolve().parent
REPO_ROOT = DAEMON_DIR.parent          # repo root (for relative default CWDs)
DASHBOARD_DIR = DAEMON_DIR / "dashboard"

# Local SQLite database — same schema as the Worker's D1 migrations.
# Created on first run; persisted across restarts.
DB_PATH = REPO_ROOT / "bridge.db"

# In-memory command queue for HTTP-polling mode (when the extension can't
# hold a WebSocket open — e.g. behind a strict corp proxy). The bridge's
# WebSocket path is preferred; this is the fallback.
INMEM_QUEUE: dict[str, list[dict]] = {}  # agentId → [cmd, cmd, ...]
INMEM_RESULTS: dict[str, dict] = {}       # cmdId  → result dict
INMEM_HEARTBEATS: dict[str, float] = {}   # agentId → last heartbeat ts

# Shared state — accessible from both HTTP and WebSocket handlers
STATE = {
    "started_at": time.time(),
    "extension_connected": False,
    "extension_info": {},
    "commands_received": 0,
    "commands_completed": 0,
    "commands_failed": 0,
    "last_command_at": None,
    "recent_logs": [],
}

# Pending command futures: {command_id: asyncio.Future}
PENDING: dict[str, asyncio.Future] = {}
# The active WebSocket connection (extension service worker)
WS_CONN: web.WebSocketResponse | None = None
# The sandbox page WebSocket connection (page context, zstd-native)
SANDBOX_CONN: web.WebSocketResponse | None = None

# Multi-extension support: map agentId → WS connection.
# Each extension instance gets a persistent agentId (saved in chrome.storage.local).
# Commands can be routed to a specific agentId via cmd.agentId.
EXTENSION_CONNS: dict[str, web.WebSocketResponse] = {}  # agentId → ws
WS_CONN = None  # legacy: points to the last connected extension (for backward compat)

MAX_LOG = 200


def add_log(level: str, message: str, data: dict | None = None):
    """Add a log entry to the recent logs ring buffer."""
    entry = {
        "ts": time.time(),
        "level": level,
        "message": message,
        "data": data or {},
    }
    STATE["recent_logs"].append(entry)
    if len(STATE["recent_logs"]) > MAX_LOG:
        STATE["recent_logs"].shift(0) if hasattr(STATE["recent_logs"], "shift") else STATE["recent_logs"].pop(0)
    log.info("[%s] %s %s", level, message, data or "")


# ---------------------------------------------------------------------- #
# SQLite database — local persistence (replaces the Worker's D1)
# ---------------------------------------------------------------------- #
# Same schema as worker/migrations/0001_init.sql + 0002_webhooks.sql +
# 0003_drop_email_unique.sql. SQLite is synchronous, so all access goes
# through asyncio.to_thread() to stay non-blocking on the event loop.

_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    user_id TEXT,
    token_v2 TEXT,
    notion_device_id TEXT,
    all_cookies TEXT,
    verification_code TEXT,
    status TEXT DEFAULT 'created',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_accounts_email ON accounts(email);
CREATE INDEX IF NOT EXISTS idx_accounts_user_id ON accounts(user_id);

CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    space_id TEXT,
    name TEXT,
    icon TEXT DEFAULT '',
    plan_type TEXT DEFAULT 'personal',
    trial_active INTEGER DEFAULT 0,
    trial_ends_at INTEGER,
    api_key TEXT,
    api_key_bot_id TEXT,
    api_key_expires_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workspaces_account ON workspaces(account_id);
CREATE INDEX IF NOT EXISTS idx_workspaces_space_id ON workspaces(space_id);

CREATE TABLE IF NOT EXISTS chat_threads (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    thread_id TEXT,
    title TEXT,
    model TEXT DEFAULT 'default',
    reasoning_effort TEXT DEFAULT 'medium',
    pinned INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_threads_workspace ON chat_threads(workspace_id);

CREATE TABLE IF NOT EXISTS webhooks (
    id                       TEXT PRIMARY KEY,
    workspace_id             TEXT NOT NULL,
    notion_subscription_id   TEXT,
    notion_integration_id    TEXT,
    notion_bot_id            TEXT,
    callback_url             TEXT NOT NULL,
    status                   TEXT DEFAULT 'pending',
    event_types              TEXT,
    api_version              TEXT DEFAULT '2026-03-11',
    verification_token       TEXT,
    last_delivery_at         INTEGER,
    delivery_count           INTEGER DEFAULT 0,
    last_delivery_payload    TEXT,
    created_at               INTEGER NOT NULL,
    updated_at               INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_webhooks_workspace    ON webhooks(workspace_id);
CREATE INDEX IF NOT EXISTS idx_webhooks_subscription ON webhooks(notion_subscription_id);
CREATE INDEX IF NOT EXISTS idx_webhooks_status       ON webhooks(status);

CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    account_id TEXT,
    workspace_id TEXT,
    stage TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    options TEXT,
    result TEXT,
    error TEXT,
    started_at INTEGER,
    finished_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_account ON jobs(account_id);

CREATE TABLE IF NOT EXISTS command_queue (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    cmd TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    result TEXT,
    picked_at INTEGER,
    completed_at INTEGER,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_command_queue_agent_status ON command_queue(agent_id, status);
"""


def _connect_db() -> sqlite3.Connection:
    """Open a SQLite connection with sane defaults.

    `check_same_thread=False` because we'll call it from many asyncio worker
    threads (via to_thread). `isolation_level=None` enables autocommit so
    we don't need to manage transactions explicitly — every execute() commits
    immediately, which is what we want for a low-traffic dashboard backend.
    """
    conn = sqlite3.connect(str(DB_PATH), check_same_thread=False, isolation_level=None)
    conn.row_factory = sqlite3.Row  # return dict-like rows
    conn.execute("PRAGMA journal_mode=WAL;")      # allow concurrent readers
    conn.execute("PRAGMA foreign_keys=ON;")
    conn.execute("PRAGMA busy_timeout=5000;")     # wait up to 5s on locks
    return conn


_DB_CONN: sqlite3.Connection | None = None


def _db() -> sqlite3.Connection:
    """Return the global SQLite connection (initialised in run())."""
    if _DB_CONN is None:
        raise RuntimeError("DB not initialised — call init_db() first")
    return _DB_CONN


def init_db() -> None:
    """Open the SQLite DB and create tables if they don't exist.

    Called from run() at startup. Idempotent — safe to call every boot.
    """
    global _DB_CONN
    _DB_CONN = _connect_db()
    _DB_CONN.executescript(_SCHEMA_SQL)
    log.info("SQLite initialised at %s", DB_PATH)


async def db_execute(sql: str, params: tuple = ()) -> sqlite3.Cursor:
    """Async wrapper around cursor.execute()."""
    return await asyncio.to_thread(_db().execute, sql, params)


async def db_executemany(sql: str, params_seq) -> sqlite3.Cursor:
    """Async wrapper around cursor.executemany()."""
    return await asyncio.to_thread(_db().executemany, sql, params_seq)


async def db_query_all(sql: str, params: tuple = ()) -> list[dict]:
    """Run a SELECT and return all rows as dicts."""
    def _run():
        cur = _db().execute(sql, params)
        rows = cur.fetchall()
        return [dict(r) for r in rows]
    return await asyncio.to_thread(_run)


async def db_query_one(sql: str, params: tuple = ()) -> dict | None:
    """Run a SELECT and return one row as a dict, or None."""
    def _run():
        cur = _db().execute(sql, params)
        row = cur.fetchone()
        return dict(row) if row else None
    return await asyncio.to_thread(_run)


async def db_execute_returning(sql: str, params: tuple = ()) -> dict | None:
    """Run an INSERT/UPDATE/DELETE; return the first matching row.

    Caller should append `RETURNING *` to the SQL.
    """
    return await db_query_one(sql, params)


# ---------------------------------------------------------------------- #
# HTTP handlers
# ---------------------------------------------------------------------- #

async def handle_health(request: web.Request) -> web.Response:
    """GET /health — JSON health check."""
    return web.json_response({
        "ok": True,
        "service": "notion-onboarding-bridge",
        "uptime_seconds": time.time() - STATE["started_at"],
        "extension_connected": STATE["extension_connected"],
        "sandbox_connected": SANDBOX_CONN is not None,
        "extension_info": STATE["extension_info"],
        "commands_received": STATE["commands_received"],
        "commands_completed": STATE["commands_completed"],
        "commands_failed": STATE["commands_failed"],
    })


async def handle_root(request: web.Request) -> web.StreamResponse:
    """GET / — dispatch based on Upgrade header.

    If the request has an Upgrade: websocket header, treat it as a WS
    connection (this is how Caddy routes WebSocket through XTransformPort —
    the path must be "/"). Otherwise serve the shared dashboard HTML
    (same files the Worker serves — see dashboard/index.html).
    """
    # Check for WebSocket upgrade headers
    upgrade = request.headers.get("Upgrade", "").lower()
    connection = request.headers.get("Connection", "").lower()
    if "websocket" in upgrade or "upgrade" in connection:
        return await handle_websocket(request)
    # Otherwise serve the shared dashboard
    return await handle_dashboard_index(request)


async def handle_dashboard_index(request: web.Request) -> web.Response:
    """GET / — serve the shared dashboard HTML.

    The dashboard lives in `dashboard/index.html` at the repo root and is
    served by both this bridge and the Worker (which imports
    `dashboard/dashboard.ts` and serves the same bytes). The HTML links to
    `/styles.css` and `/app.js`, which are served by the handlers below.
    """
    index_path = DASHBOARD_DIR / "index.html"
    try:
        html = index_path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return web.Response(
            text=f"dashboard/index.html not found at {index_path}. "
                 "Run from the repo root, or set NOTION_DASHBOARD_DIR.",
            status=500,
            content_type="text/plain",
        )
    return web.Response(text=html, content_type="text/html", charset="utf-8")


async def handle_dashboard_styles(request: web.Request) -> web.Response:
    """GET /styles.css — serve the dashboard stylesheet."""
    css_path = DASHBOARD_DIR / "styles.css"
    try:
        css = css_path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return web.Response(text="styles.css not found", status=404, content_type="text/plain")
    return web.Response(text=css, content_type="text/css", charset="utf-8")


async def handle_dashboard_js(request: web.Request) -> web.Response:
    """GET /app.js — serve the dashboard JavaScript."""
    js_path = DASHBOARD_DIR / "app.js"
    try:
        js = js_path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return web.Response(text="app.js not found", status=404, content_type="text/plain")
    return web.Response(text=js, content_type="application/javascript", charset="utf-8")


async def handle_bridge_status_page(request: web.Request) -> web.Response:
    """GET /bridge-status — legacy inline HTML status page (bridge-only view).

    This was the original `/` handler before the dashboard refactor. Kept
    here for debugging the bridge itself — shows uptime, command counters,
    recent logs, and the WebSocket URLs the extension should use.
    """
    uptime = time.time() - STATE["started_at"]
    ext_connected = STATE["extension_connected"]
    ext_info = STATE["extension_info"]
    port = request.app["port"]
    host = request.app["host"]

    # Build the WebSocket URL for the extension.
    # Port 3000 is Caddy's default proxy target — no XTransformPort needed.
    ws_url_local = f"ws://localhost:{port}/ws"
    if port == 3000:
        ws_url_remote = f"wss://preview-<bot-id>.space-z.ai/ws"
    else:
        ws_url_remote = f"wss://preview-<bot-id>.space-z.ai/ws?XTransformPort={port}"

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Notion Onboarding Bridge — status</title>
<meta http-equiv="refresh" content="5">
<style>
body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 720px; margin: 40px auto; padding: 0 20px; background: #fafafa; color: #1a1a1a; }}
h1 {{ color: #4285f4; margin-bottom: 8px; }}
.status {{ padding: 12px 16px; border-radius: 8px; margin: 16px 0; font-size: 14px; }}
.status.connected {{ background: #e6f4ea; color: #137333; }}
.status.disconnected {{ background: #fce8e6; color: #c5221f; }}
code {{ background: #f0f0f0; padding: 2px 6px; border-radius: 4px; font-family: 'SF Mono', Monaco, monospace; font-size: 13px; word-break: break-all; }}
pre {{ background: #1e1e1e; color: #d4d4d4; padding: 12px; border-radius: 8px; overflow-x: auto; font-size: 12px; }}
ul {{ line-height: 1.8; }}
.section {{ margin: 20px 0; padding: 16px; background: white; border-radius: 8px; border: 1px solid #eee; }}
.stats {{ display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; margin: 12px 0; }}
.stat {{ background: #f8f9fa; padding: 8px 12px; border-radius: 6px; text-align: center; }}
.stat-label {{ font-size: 10px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; }}
.stat-value {{ font-size: 20px; font-weight: 600; color: #1a1a1a; }}
.stat-value.failed {{ color: #db4437; }}
</style>
</head>
<body>
<h1>Notion Onboarding Bridge — status</h1>
<p style="color: #666; font-size: 14px;">Python backend service for the Chrome extension (bridge-only view; dashboard is at <a href="/">/</a>)</p>

<div class="status {'connected' if ext_connected else 'disconnected'}">
  Extension: <strong>{'✓ CONNECTED' if ext_connected else '✗ DISCONNECTED'}</strong>
  {f"— Agent: {ext_info.get('agentId', '?')}" if ext_connected else ""}
</div>

<div class="stats">
  <div class="stat">
    <div class="stat-label">Uptime</div>
    <div class="stat-value">{uptime:.0f}s</div>
  </div>
  <div class="stat">
    <div class="stat-label">Commands</div>
    <div class="stat-value">{STATE['commands_completed']}</div>
  </div>
  <div class="stat">
    <div class="stat-label">Failed</div>
    <div class="stat-value failed">{STATE['commands_failed']}</div>
  </div>
</div>

<div class="section">
  <h3>🔌 Connect the Chrome Extension</h3>
  <ol>
    <li>Load the extension in Chrome: <code>chrome://extensions/</code> → Developer mode → Load unpacked</li>
    <li>Click the extension icon in your toolbar</li>
    <li>Set Server URL to one of:
      <ul>
        <li><strong>Local:</strong> <code>{ws_url_local}</code></li>
        <li><strong>Remote:</strong> <code>{ws_url_remote}</code></li>
      </ul>
    </li>
    <li>Click <strong>Connect</strong></li>
  </ol>
</div>

<div class="section">
  <h3>📋 CLI Commands</h3>
  <pre>python automate.py signup-ext --email you@privatimail.com
python automate.py run-full-ext --email you@privatimail.com --workspace-name "My WS"</pre>
</div>

<div class="section">
  <h3>🔍 API Endpoints</h3>
  <ul>
    <li><code>GET /</code> — dashboard (served from <code>dashboard/</code>)</li>
    <li><code>GET /bridge-status</code> — this page (auto-refreshes every 5s)</li>
    <li><code>GET /health</code> — JSON health check</li>
    <li><code>GET /api/token</code> — auth token</li>
    <li><code>GET /api/accounts</code>, <code>/api/workspaces</code>, <code>/api/jobs</code>, <code>/api/extensions</code> — SQLite-backed dashboard data</li>
    <li><code>POST /api/signup-ext</code>, <code>/api/relogin</code>, <code>/api/accounts/&#123;id&#125;/retry</code>, <code>/api/accounts/&#123;id&#125;/workspaces</code> — native signup + workspace creation</li>
    <li><code>POST /api/command</code>, <code>/api/open</code>, <code>/api/eval</code>, <code>/api/screenshot</code>, <code>/api/cookies</code>, <code>/api/fetch</code>, <code>/api/captcha-token</code>, <code>/api/sandbox-fetch</code> — extension-driving</li>
    <li><code>GET /api/poll</code>, <code>POST /api/result</code> — HTTP polling fallback (in-memory)</li>
    <li><code>WS /ws</code> — WebSocket for extension</li>
  </ul>
  <p style="color:#666;font-size:12px;margin-top:.6rem">Backend: native Python + SQLite (<code>{DB_PATH}</code>). No Cloudflare Worker dependency.</p>
</div>

<div class="section">
  <h3>📊 Recent Logs</h3>
  <pre>{_format_logs(STATE['recent_logs'][-15:])}</pre>
</div>

</body>
</html>"""
    return web.Response(text=html, content_type="text/html")


async def handle_sandbox_page(request: web.Request) -> web.Response:
    """GET /sandbox — serve the sandbox HTML page.

    This page runs in the browser as a regular web page (not an extension page).
    Being a regular page means Chrome's full network stack handles zstd
    decompression natively — unlike extension pages or service workers.
    """
    ext_dir = os.path.join(os.path.dirname(__file__), '..', 'extension')
    html_path = os.path.join(ext_dir, 'sandbox.html')
    with open(html_path) as f:
        html = f.read()
    # Replace the script src to use the bridge's /sandbox.js endpoint
    html = html.replace('src="sandbox.js"', 'src="/sandbox.js"')
    return web.Response(text=html, content_type="text/html")


async def handle_sandbox_js(request: web.Request) -> web.Response:
    """GET /sandbox.js — serve the sandbox JavaScript."""
    ext_dir = os.path.join(os.path.dirname(__file__), '..', 'extension')
    js_path = os.path.join(ext_dir, 'sandbox.js')
    with open(js_path) as f:
        js = f.read()
    return web.Response(text=js, content_type="application/javascript")


async def handle_token(request: web.Request) -> web.Response:
    """GET /api/token — auth token for the extension."""
    return web.json_response({"token": ""})  # no auth in dev mode


async def handle_status_page(request: web.Request) -> web.Response:
    """GET / — HTML status page.

    DEPRECATED alias for `handle_bridge_status_page`. The `/` route now
    serves the shared dashboard (see `handle_dashboard_index`). This stub
    exists only so any out-of-tree callers that referenced `handle_status_page`
    by name still work.
    """
    return await handle_bridge_status_page(request)


def _format_logs(logs: list) -> str:
    if not logs:
        return "(no logs yet)"
    lines = []
    for e in logs[-15:]:
        t = time.strftime("%H:%M:%S", time.localtime(e["ts"]))
        lines.append(f"[{t}] {e['level'].upper():5s} {e['message']}")
    return "\n".join(lines)


# ---------------------------------------------------------------------- #
# WebSocket handler — extension connects here
# ---------------------------------------------------------------------- #

async def handle_websocket(request: web.Request) -> web.WebSocketResponse:
    """WS /ws — WebSocket endpoint for the Chrome extension + sandbox page."""
    global WS_CONN, SANDBOX_CONN

    ws = web.WebSocketResponse(max_msg_size=50 * 1024 * 1024)
    await ws.prepare(request)

    # Detect if this is the sandbox page or the extension service worker
    is_sandbox = False

    add_log("info", "WebSocket connection from extension")
    add_log("info", "Extension WebSocket connected")

    # Start a keepalive ping task — sends a 'ping' message to the extension
    # every 25s. This prevents the extension's watchdog from force-closing
    # the WS during long-running commands (e.g., xhr.intercept can wait
    # minutes for hCaptcha + email worker). The watchdog trips after 90s
    # of silence (no server→extension messages); a 25s ping keeps it happy.
    async def _ping_task():
        try:
            while True:
                await asyncio.sleep(25)
                if ws.closed:
                    return
                # Send a ping — the extension's 'pong' handler will respond
                # (and refresh the watchdog's lastServerMsgAt).
                try:
                    await ws.send_json({"type": "ping", "ts": int(time.time() * 1000)})
                except Exception:
                    return
        except asyncio.CancelledError:
            return

    ping_task = asyncio.create_task(_ping_task())

    try:
        async for msg in ws:
            if msg.type == WSMsgType.TEXT:
                try:
                    data = json.loads(msg.data)
                except json.JSONDecodeError:
                    add_log("warn", f"Invalid JSON from extension: {msg.data[:200]}")
                    continue

                msg_type = data.get("type", "")

                if msg_type == "auth":
                    add_log("debug", f"Extension auth: {data.get('token', '')[:20]}")

                elif msg_type == "connect":
                    # Check if this is the sandbox page (page context, zstd-native)
                    ctx = data.get("context", "")
                    if ctx == "page":
                        is_sandbox = True
                        SANDBOX_CONN = ws
                        add_log("info", f"Sandbox page connected: {data.get('agentId')}")
                    else:
                        agent_id = data.get("agentId", f"unknown-{id(ws)}")
                        EXTENSION_CONNS[agent_id] = ws
                        WS_CONN = ws  # legacy: last connected
                        STATE["extension_connected"] = True
                        STATE["extension_info"] = {
                            "agentId": agent_id,
                            "userAgent": data.get("userAgent"),
                            "hostname": data.get("hostname"),
                        }
                        # Also track all connected agents
                        STATE["connected_agents"] = list(EXTENSION_CONNS.keys())
                        # Write a heartbeat so /api/extensions sees this WS-connected
                        # extension immediately (not just after the first pong).
                        INMEM_HEARTBEATS[agent_id] = time.time()
                        add_log("info", f"Extension connected: {agent_id} (total: {len(EXTENSION_CONNS)})")

                elif msg_type == "result":
                    cmd_id = data.get("id")
                    if cmd_id and cmd_id in PENDING:
                        fut = PENDING.pop(cmd_id)
                        if not fut.done():
                            fut.set_result(data)
                        STATE["commands_completed"] += 1
                    else:
                        add_log("warn", f"Result for unknown command: {cmd_id}")

                elif msg_type == "log":
                    level = data.get("level", "info")
                    message = data.get("message", "")
                    log_data = data.get("data", {})
                    add_log(level, f"[ext] {message}", log_data)

                elif msg_type == "pong":
                    # Keepalive ping from the extension — refresh the in-memory
                    # heartbeat so /api/extensions continues to see this
                    # WS-connected extension. (Without this, the heartbeat
                    # would expire after 30s of silence.)
                    #
                    # We also need to track the agentId for this WS — it was
                    # set when the 'connect' message arrived earlier. Look it
                    # up by finding the ws in EXTENSION_CONNS.
                    ws_agent_id = next(
                        (aid for aid, w in EXTENSION_CONNS.items() if w is ws),
                        None,
                    )
                    if ws_agent_id:
                        INMEM_HEARTBEATS[ws_agent_id] = time.time()

                else:
                    add_log("debug", f"Unknown message type: {msg_type}")

            elif msg.type == WSMsgType.ERROR:
                add_log("error", f"WebSocket error: {ws.exception()}")

    except Exception as e:
        add_log("error", f"WebSocket handler error: {e}")
    finally:
        ping_task.cancel()
        if is_sandbox:
            SANDBOX_CONN = None
            add_log("info", "Sandbox page disconnected")
        else:
            # Remove from EXTENSION_CONNS by finding this ws
            disconnected_agents = [aid for aid, w in EXTENSION_CONNS.items() if w is ws]
            for aid in disconnected_agents:
                del EXTENSION_CONNS[aid]
            # Update legacy WS_CONN
            if WS_CONN is ws:
                WS_CONN = None
            STATE["extension_connected"] = len(EXTENSION_CONNS) > 0
            STATE["connected_agents"] = list(EXTENSION_CONNS.keys())
            # Only fail pending commands if NO extensions are connected
            if not EXTENSION_CONNS:
                for fut in PENDING.values():
                    if not fut.done():
                        fut.set_exception(ConnectionError("Extension disconnected"))
                PENDING.clear()
            add_log("info", f"Extension disconnected (agents removed: {disconnected_agents}, remaining: {len(EXTENSION_CONNS)})")

    return ws


# ---------------------------------------------------------------------- #
# Command sending (used by signup_with_extension)
# ---------------------------------------------------------------------- #

async def send_command(cmd: dict, timeout: float = 30.0) -> dict:
    """Send a command to the extension and wait for the result.

    Hybrid WS+HTTP dispatch:
      1. Write the command to INMEM_QUEUE so HTTP polling can pick it up
         (even if the WS dies — Chrome MV3 service workers can be killed
         between WS-send and WS-recv, which would lose the command).
      2. If a WS extension is connected, also send via WS for low latency.
      3. Wait on the PENDING future (resolved by either WS 'result' or
         POST /api/result from HTTP polling).

    If cmd contains 'agentId', routes to that specific extension.
    Otherwise, sends to the last connected extension (legacy behavior).
    """
    # Extract agentId for routing (don't send it to the extension)
    target_agent = cmd.pop("agentId", None)

    # Find the target connection (None if no WS extension connected)
    target_ws: web.WebSocketResponse | None = None
    if target_agent:
        target_ws = EXTENSION_CONNS.get(target_agent)
        if target_ws and target_ws.closed:
            target_ws = None
        if target_ws is None and not INMEM_HEARTBEATS.get(target_agent):
            # No WS AND no recent HTTP heartbeat for this specific agent —
            # extension truly offline
            available = list(EXTENSION_CONNS.keys()) + list(INMEM_HEARTBEATS.keys())
            raise ConnectionError(
                f"Extension '{target_agent}' not connected. Available WS: "
                f"{list(EXTENSION_CONNS.keys())}, HTTP-polling: {list(INMEM_HEARTBEATS.keys())}"
            )
    else:
        # No specific agentId — use any connected extension (WS preferred,
        # HTTP polling fallback).
        if WS_CONN and not WS_CONN.closed:
            target_ws = WS_CONN
            target_agent = next(
                (aid for aid, w in EXTENSION_CONNS.items() if w is WS_CONN),
                None,
            )
        else:
            # Pick any active HTTP-polling agent
            now = time.time()
            HEARTBEAT_WINDOW_SEC = 30
            active = [aid for aid, ts in INMEM_HEARTBEATS.items() if now - ts <= HEARTBEAT_WINDOW_SEC]
            if active:
                target_agent = active[0]
                target_ws = None
            else:
                raise ConnectionError(
                    "Extension is not connected (no WS, no HTTP polling). "
                    f"WS agents: {list(EXTENSION_CONNS.keys())}, "
                    f"HTTP heartbeats: {dict(INMEM_HEARTBEATS)}"
                )

    cmd_id = str(uuid.uuid4())
    cmd["id"] = cmd_id
    fut: asyncio.Future = asyncio.get_event_loop().create_future()
    PENDING[cmd_id] = fut

    STATE["commands_received"] += 1
    STATE["last_command_at"] = time.time()

    # 1. Enqueue for HTTP polling (best-effort — survives WS death)
    poll_agent = target_agent or "default"
    INMEM_QUEUE.setdefault(poll_agent, []).append(cmd.copy())

    add_log("info", f"→ {cmd.get('type')} (id={cmd_id[:8]})" + (f" → {target_agent}" if target_agent else ""))

    # 2. Also send via WS if available (for low latency — if the SW dies
    #    mid-send, the HTTP polling path will still deliver)
    if target_ws and not target_ws.closed:
        try:
            await target_ws.send_json(cmd)
        except Exception as e:
            add_log("warn", f"WS send failed (HTTP polling will still deliver): {e}")

    try:
        result = await asyncio.wait_for(fut, timeout=timeout)
        # Command was completed — remove from INMEM_QUEUE (if still there)
        q = INMEM_QUEUE.get(poll_agent)
        if q:
            INMEM_QUEUE[poll_agent] = [c for c in q if c.get("id") != cmd_id]
        return result
    except asyncio.TimeoutError:
        PENDING.pop(cmd_id, None)
        # Remove from INMEM_QUEUE so it doesn't get picked up late
        q = INMEM_QUEUE.get(poll_agent)
        if q:
            INMEM_QUEUE[poll_agent] = [c for c in q if c.get("id") != cmd_id]
        INMEM_RESULTS.pop(cmd_id, None)
        STATE["commands_failed"] += 1
        return {"ok": False, "error": f"Command {cmd.get('type')} timed out after {timeout}s"}


async def sandbox_fetch(url: str, method: str = "GET", body: str | None = None,
                        headers: dict | None = None, credentials: str = "include",
                        timeout: float = 120.0) -> dict:
    """Send a fetch command to the sandbox PAGE context (handles zstd natively).

    The sandbox page runs in a full Chrome page context where Chrome's network
    stack handles zstd/gzip/deflate decompression. Use this for endpoints that
    return zstd-compressed responses (like runInferenceTranscript).
    """
    if SANDBOX_CONN is None:
        raise ConnectionError("Sandbox page is not connected")

    cmd_id = str(uuid.uuid4())
    fut: asyncio.Future = asyncio.get_event_loop().create_future()
    PENDING[cmd_id] = fut

    add_log("info", f"→ sandbox.fetch {method} {url[:60]} (id={cmd_id[:8]})")
    await SANDBOX_CONN.send_json({
        "type": "sandbox.fetch",
        "id": cmd_id,
        "url": url,
        "method": method,
        "headers": headers or {},
        "body": body,
        "credentials": credentials,
        "timeoutMs": int(timeout * 1000),
    })

    try:
        result = await asyncio.wait_for(fut, timeout=timeout + 5)
        return result
    except asyncio.TimeoutError:
        PENDING.pop(cmd_id, None)
        return {"ok": False, "error": f"Sandbox fetch timed out after {timeout}s"}


# ---------------------------------------------------------------------- #
# Remote command endpoints — lets the Python backend drive the extension
# via HTTP calls to the daemon. This is the "remote portal" API.
# ---------------------------------------------------------------------- #

async def handle_api_command(request: web.Request) -> web.Response:
    """POST /api/command — send any command to the extension.

    Body: {"type": "fetch"|"tabs.open"|..., ...command fields, "timeout": 30.0}
    Returns: the extension's result as JSON.
    """
    if WS_CONN is None:
        return web.json_response({"ok": False, "error": "Extension not connected"}, status=503)
    try:
        cmd = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "Invalid JSON body"}, status=400)
    timeout = cmd.pop("timeout", 60.0)
    try:
        result = await send_command(cmd, timeout=timeout)
        return web.json_response(result)
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)


async def handle_api_open(request: web.Request) -> web.Response:
    """POST /api/open — open a URL in a new tab. Convenience wrapper.

    Body: {"url": "https://...", "active": true}
    Returns: {"ok": true, "tabId": N, "url": "..."}
    """
    if WS_CONN is None:
        return web.json_response({"ok": False, "error": "Extension not connected"}, status=503)
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "Invalid JSON"}, status=400)
    url = body.get("url")
    if not url:
        return web.json_response({"ok": False, "error": "Missing 'url'"}, status=400)
    active = body.get("active", True)
    try:
        result = await send_command({"type": "tabs.open", "url": url, "active": active}, timeout=60)
        return web.json_response(result)
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)


async def handle_api_eval(request: web.Request) -> web.Response:
    """POST /api/eval — execute JS in a tab and return the result.

    Body: {"tabId": N, "function": "return document.title", "args": [...]}
    Returns: {"ok": true, "result": <whatever the function returned>}
    """
    if WS_CONN is None:
        return web.json_response({"ok": False, "error": "Extension not connected"}, status=503)
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "Invalid JSON"}, status=400)
    tab_id = body.get("tabId")
    function = body.get("function")
    if tab_id is None or not function:
        return web.json_response({"ok": False, "error": "Missing 'tabId' or 'function'"}, status=400)
    args = body.get("args", [])
    try:
        result = await send_command({
            "type": "form.eval",
            "tabId": tab_id,
            "function": function,
            "args": args,
        }, timeout=30)
        return web.json_response(result)
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)


async def handle_api_screenshot(request: web.Request) -> web.Response:
    """POST /api/screenshot — take a screenshot of a tab.

    Body: {"tabId": N}
    Returns: {"ok": true, "dataUrl": "data:image/png;base64,..."}
    """
    if WS_CONN is None:
        return web.json_response({"ok": False, "error": "Extension not connected"}, status=503)
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "Invalid JSON"}, status=400)
    tab_id = body.get("tabId")
    if tab_id is None:
        return web.json_response({"ok": False, "error": "Missing 'tabId'"}, status=400)
    try:
        result = await send_command({"type": "screenshot", "tabId": tab_id}, timeout=15)
        return web.json_response(result)
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)


async def handle_api_cookies(request: web.Request) -> web.Response:
    """POST /api/cookies — get all cookies for a URL.

    Body: {"url": "https://app.notion.com"}
    Returns: {"ok": true, "cookies": [...]}
    """
    if WS_CONN is None:
        return web.json_response({"ok": False, "error": "Extension not connected"}, status=503)
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "Invalid JSON"}, status=400)
    url = body.get("url")
    if not url:
        return web.json_response({"ok": False, "error": "Missing 'url'"}, status=400)
    try:
        result = await send_command({"type": "cookies.getAll", "url": url}, timeout=15)
        return web.json_response(result)
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)


async def handle_api_fetch(request: web.Request) -> web.Response:
    """POST /api/fetch — execute fetch() from the extension's browser context.

    Body: {"url": "...", "method": "GET", "headers": {...}, "body": "...", "timeoutMs": 30000}
    Returns: {"ok": true, "status": 200, "body": "...", "headers": {...}}
    """
    if WS_CONN is None:
        return web.json_response({"ok": False, "error": "Extension not connected"}, status=503)
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "Invalid JSON"}, status=400)
    url = body.get("url")
    if not url:
        return web.json_response({"ok": False, "error": "Missing 'url'"}, status=400)
    cmd = {
        "type": "fetch",
        "url": url,
        "method": body.get("method", "GET"),
        "headers": body.get("headers", {}),
        "credentials": body.get("credentials", "include"),
        "timeoutMs": body.get("timeoutMs", 30000),
    }
    if "body" in body:
        cmd["body"] = body["body"]
    try:
        result = await send_command(cmd, timeout=body.get("timeoutMs", 30000) / 1000 + 5)
        return web.json_response(result)
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)


async def handle_api_captcha_token(request: web.Request) -> web.Response:
    """POST /api/captcha-token — read the hCaptcha response token from a tab.

    Body: {"tabId": N}
    Returns: {"ok": true, "token": "P1_eyJ...", "source": "hcaptcha.getResponse"}
             {"ok": false, "error": "...", "captchaPresent": true/false}
    """
    if WS_CONN is None:
        return web.json_response({"ok": False, "error": "Extension not connected"}, status=503)
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "Invalid JSON"}, status=400)
    tab_id = body.get("tabId")
    if tab_id is None:
        return web.json_response({"ok": False, "error": "Missing 'tabId'"}, status=400)
    try:
        result = await send_command({"type": "getCaptchaToken", "tabId": tab_id}, timeout=15)
        return web.json_response(result)
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)


async def handle_api_sandbox_fetch(request: web.Request) -> web.Response:
    """POST /api/sandbox-fetch — execute fetch() from the sandbox PAGE context.

    The sandbox page runs in a full Chrome page context where Chrome's network
    stack handles zstd/gzip/deflate decompression natively. Use this for
    endpoints that return zstd-compressed responses (like runInferenceTranscript).

    Body: {"url": "...", "method": "POST", "headers": {...}, "body": "...", "credentials": "include"}
    Returns: {"ok": true, "status": 200, "body": "...", "headers": {...}}
    """
    if SANDBOX_CONN is None:
        return web.json_response({"ok": False, "error": "Sandbox page not connected. Open the sandbox page: chrome-extension://<ext-id>/sandbox.html"}, status=503)
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "Invalid JSON"}, status=400)
    url = body.get("url")
    if not url:
        return web.json_response({"ok": False, "error": "Missing 'url'"}, status=400)
    try:
        result = await sandbox_fetch(
            url=url,
            method=body.get("method", "GET"),
            body=body.get("body"),
            headers=body.get("headers", {}),
            credentials=body.get("credentials", "include"),
            timeout=body.get("timeout", 120),
        )
        return web.json_response(result)
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)


# ---------------------------------------------------------------------- #
# AiohttpBridgeAdapter — adapter that lets `signup_with_extension()` from
# notion_onboarding.signup_ext drive the extension via this bridge's
# WebSocket connections (instead of spinning up its own WS server).
# ---------------------------------------------------------------------- #
# `signup_with_extension(bridge, ...)` calls these methods on `bridge`:
#   bridge.tabs_open(url, active=True) → CommandResult(.ok, .data, .error)
#   bridge.form_wait(tab_id, selector, timeout_ms=...)
#   bridge.form_fill(tab_id, selector, value)
#   bridge.form_eval(tab_id, function, args)
#   bridge.xhr_intercept(tab_id, url_pattern, timeout_ms=...)
#   bridge.cookies_get_all(url)
#   bridge.tabs_close(tab_id)
#
# We re-implement each one on top of the bridge's existing `send_command`
# function, and shim the CommandResult dataclass so the caller doesn't
# need to import notion_onboarding.

# --- portability shim (onboard-automation-common) -------------------------
# The original daemon imported CommandResult from the notion_onboarding
# package. We define it locally so this daemon runs standalone.
from dataclasses import dataclass, field as _dc_field
from typing import Any as _Any

@dataclass
class CommandResult:
    ok: bool
    error: str | None = None
    data: dict | None = None


def _notion_onboarding_available() -> bool:
    """True when the (optional) notion_onboarding package is importable."""
    try:
        import notion_onboarding  # noqa: F401
        return True
    except ImportError:
        return False


class AiohttpBridgeAdapter:
    """Mimics `notion_onboarding.extension_bridge.ExtensionBridge` for use
    with `signup_with_extension()`, but routes commands through this
    aiohttp bridge's existing WebSocket connection(s).

    Pass an optional `agent_id` to target a specific connected extension.
    If None, falls back to the legacy last-connected extension.
    """

    def __init__(self, agent_id: str | None = None):
        self.agent_id = agent_id

    async def _send(self, cmd: dict, timeout: float = 60.0) -> CommandResult:
        """Send a command via the bridge's WS, return a CommandResult."""
        if self.agent_id:
            cmd["agentId"] = self.agent_id
        try:
            result = await send_command(cmd, timeout=timeout)
        except ConnectionError as e:
            return CommandResult(ok=False, error=str(e))
        ok = bool(result.get("ok", False))
        if ok:
            return CommandResult(ok=True, data=result)
        return CommandResult(ok=False, error=result.get("error", "Unknown error"), data=result)

    async def tabs_open(self, url: str, *, active: bool = True) -> CommandResult:
        return await self._send({"type": "tabs.open", "url": url, "active": active}, timeout=60)

    async def tabs_close(self, tab_id: int) -> CommandResult:
        return await self._send({"type": "tabs.close", "tabId": tab_id})

    async def form_wait(self, tab_id: int, selector: str, *, timeout_ms: int = 30000) -> CommandResult:
        return await self._send(
            {"type": "form.wait", "tabId": tab_id, "selector": selector, "timeoutMs": timeout_ms},
            timeout=timeout_ms / 1000 + 5,
        )

    async def form_fill(self, tab_id: int, selector: str, value: str) -> CommandResult:
        return await self._send({"type": "form.fill", "tabId": tab_id, "selector": selector, "value": value})

    async def form_eval(self, tab_id: int, function: str, args: list | None = None) -> CommandResult:
        return await self._send({
            "type": "form.eval", "tabId": tab_id, "function": function, "args": args or [],
        })

    async def xhr_intercept(
        self, tab_id: int, url_pattern: str, *,
        method: str | None = None, timeout_ms: int = 30000,
    ) -> CommandResult:
        return await self._send({
            "type": "xhr.intercept", "tabId": tab_id,
            "urlPattern": url_pattern, "method": method, "timeoutMs": timeout_ms,
        }, timeout=timeout_ms / 1000 + 10)

    async def cookies_get_all(self, url: str) -> CommandResult:
        return await self._send({"type": "cookies.getAll", "url": url})


# ---------------------------------------------------------------------- #
# Helpers for the native API handlers
# ---------------------------------------------------------------------- #

def _json_response(data: Any, status: int = 200) -> web.Response:
    """Wrap web.json_response with permissive CORS (dashboard is same-origin,
    but be defensive for any cross-origin tooling)."""
    return web.json_response(data, status=status, headers={"Access-Control-Allow-Origin": "*"})


def _error_response(msg: str, status: int = 400, **extra) -> web.Response:
    return _json_response({"ok": False, "error": msg, **extra}, status=status)


async def _check_extension_connected() -> dict | None:
    """Pre-flight check: returns None if at least one extension is connected,
    else returns an error dict suitable for _error_response.

    Checks BOTH WS connections (EXTENSION_CONNS) AND HTTP-polling heartbeats
    (INMEM_HEARTBEATS, within last 30s). An extension may be connected via
    HTTP polling only (if WS died) and that's still a valid connection.
    """
    if EXTENSION_CONNS:
        return None  # WS-connected — pass
    # Check HTTP-polling heartbeats (within 30s)
    now = time.time()
    HEARTBEAT_WINDOW_SEC = 30
    active_http = [aid for aid, ts in INMEM_HEARTBEATS.items() if now - ts <= HEARTBEAT_WINDOW_SEC]
    if active_http:
        return None  # HTTP-polling — pass
    return {"error": "No browser extension connected. Load the extension + click Connect, then retry.", "status": 503}


def _build_email_worker():
    """Construct an EmailWorkerClient from env vars, or with the default token.

    The default token below is the shared privatimail.com instance (same as
    the Todoist onboarding automation). Override via $EMAIL_WORKER_TOKEN if
    you ever rotate it. Hardcoded so a fresh session works out-of-the-box.
    """
    try:
        from notion_onboarding.signup import EmailWorkerClient
    except ImportError as e:
        log.warning("Could not import EmailWorkerClient: %s", e)
        return None
    # Default token is the shared privatimail.com instance (overridable via env).
    DEFAULT_TOKEN = "Rr6wmFK1FRPkYQv3ZZb6eIbcoG3fincB"
    token = os.environ.get("EMAIL_WORKER_TOKEN") or DEFAULT_TOKEN
    base = os.environ.get("EMAIL_WORKER_URL", "https://mail-api.privatimail.com")
    try:
        return EmailWorkerClient(base_url=base, token=token)
    except Exception as e:
        log.warning("Could not build EmailWorkerClient: %s", e)
        return None


async def _check_notion_cookies() -> list[dict]:
    """Ask the extension for all cookies on app.notion.com. Returns [] if
    no extension is connected or no cookies present."""
    if not EXTENSION_CONNS:
        return []
    try:
        result = await send_command({"type": "cookies.getAll", "url": "https://app.notion.com"}, timeout=15)
        return result.get("cookies", []) if result.get("ok") else []
    except Exception as e:
        log.warning("cookies.getAll failed: %s", e)
        return []


async def _clear_notion_cookies() -> dict:
    """Send a cookies.remove command to the extension. Returns the result dict."""
    if not EXTENSION_CONNS:
        return {"ok": False, "error": "Extension not connected"}
    try:
        result = await send_command({"type": "cookies.remove", "url": "https://app.notion.com"}, timeout=20)
        return result
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ---------------------------------------------------------------------- #
# Native dashboard API — replaces the Worker proxy
# ---------------------------------------------------------------------- #

async def handle_list_accounts(request: web.Request) -> web.Response:
    """GET /api/accounts — list all accounts (most recent first)."""
    rows = await db_query_all(
        "SELECT id, email, user_id, status, verification_code, "
        "created_at, updated_at FROM accounts ORDER BY created_at DESC LIMIT 100"
    )
    return _json_response({"accounts": rows})


async def handle_get_account(request: web.Request) -> web.Response:
    """GET /api/accounts/{id} — fetch one account (by id, email, or user_id)."""
    acct_id = request.match_info["account_id"]
    row = await db_query_one(
        "SELECT * FROM accounts WHERE id = ? OR email = ? OR user_id = ?",
        (acct_id, acct_id, acct_id),
    )
    if not row:
        return _error_response("Account not found", status=404)
    return _json_response({"account": row})


async def handle_list_workspaces(request: web.Request) -> web.Response:
    """GET /api/workspaces — list workspaces joined with their owning account."""
    rows = await db_query_all(
        "SELECT w.*, a.email as account_email, a.user_id as account_user_id, "
        "a.status as account_status "
        "FROM workspaces w LEFT JOIN accounts a ON w.account_id = a.id "
        "ORDER BY w.created_at DESC LIMIT 200"
    )
    # Add per-workspace thread counts (one extra round-trip; cheap).
    thread_rows = await db_query_all(
        "SELECT workspace_id, COUNT(*) as thread_count FROM chat_threads GROUP BY workspace_id"
    )
    tc_map = {r["workspace_id"]: r["thread_count"] for r in thread_rows}
    for w in rows:
        w["thread_count"] = tc_map.get(w["id"], 0)
    return _json_response({"workspaces": rows})


async def handle_list_jobs(request: web.Request) -> web.Response:
    """GET /api/jobs — list the 50 most recent jobs."""
    rows = await db_query_all("SELECT * FROM jobs ORDER BY created_at DESC LIMIT 50")
    return _json_response({"jobs": rows})


async def handle_extensions(request: web.Request) -> web.Response:
    """GET /api/extensions — extension status (connected via WS or HTTP poll).

    We expose BOTH the WebSocket-connected extensions (EXTENSION_CONNS) and
    the HTTP-polling extensions (recent INMEM_HEARTBEATS entries). The
    dashboard treats any entry as "active".
    """
    now = time.time()
    exts: list[dict] = []
    # WebSocket-connected extensions
    for agent_id, ws in EXTENSION_CONNS.items():
        exts.append({
            "agentId": agent_id,
            "status": "connected-ws",
            "lastSeen": int(now * 1000),
            "secondsSinceSeen": 0,
        })
    # HTTP-polling extensions (heartbeats within last 30s).
    # 30s window matches the Worker's /api/extensions endpoint and covers
    # both HTTP polling (every 10s) and WS pong refresh (every 10s —
    # the WS handler also writes a heartbeat on each pong).
    HEARTBEAT_WINDOW_SEC = 30
    for agent_id, ts in list(INMEM_HEARTBEATS.items()):
        if now - ts > HEARTBEAT_WINDOW_SEC:
            continue
        if any(e["agentId"] == agent_id for e in exts):
            continue  # already counted via WS
        exts.append({
            "agentId": agent_id,
            "status": "connected-http",
            "lastSeen": int(ts * 1000),
            "secondsSinceSeen": int(now - ts),
        })
    # Pending command count (SQLite command_queue — for HTTP polling mode)
    pending_row = await db_query_one("SELECT COUNT(*) as cnt FROM command_queue WHERE status = 'pending'")
    pending = pending_row["cnt"] if pending_row else 0
    return _json_response({
        "extensions": exts,
        "pending": pending,
        "httpQueue": pending,
        "mode": "python-sqlite",
    })


async def handle_notion_cookies(request: web.Request) -> web.Response:
    """GET /api/notion-cookies — check for existing Notion session cookies."""
    cookies = await _check_notion_cookies()
    return _json_response({"ok": True, "cookies": cookies, "hasSession": len(cookies) > 0})


async def handle_clear_notion_cookies(request: web.Request) -> web.Response:
    """POST /api/clear-notion-cookies — clear all Notion cookies from the browser."""
    result = await _clear_notion_cookies()
    if not result.get("ok"):
        return _error_response(result.get("error", "Failed to clear cookies"), status=502)
    return _json_response({"ok": True, "message": "Notion session cookies cleared"})


# ---------------------------------------------------------------------- #
# POST handlers — signup / retry / create-workspace / batch / relogin
# ---------------------------------------------------------------------- #
# These mirror the Worker's endpoints in worker/src/index.ts (lines 283-1117)
# but are implemented natively in Python against the local SQLite DB +
# notion_onboarding Python package.

async def _run_signup_pipeline(
    *, account_id: str, job_id: str, email: str,
    ws_name: str, ws_icon: str,
    is_login: bool = False, close_tab: bool = True,
) -> None:
    """Background task: run browser-orchestrated signup → workspace → onboarding.

    Mirrors worker/src/index.ts signup-ext ctx.waitUntil block.
    Updates the SQLite DB as it progresses; failures set the account +
    job status to 'failed' with the error message.
    """
    steps: list[dict] = []
    try:
        from notion_onboarding import signup_with_extension, build_client_from_result  # optional
        from notion_onboarding.workspace import create_space, create_space_view_for
        from notion_onboarding.onboarding import OnboardingAutomation
        from notion_onboarding.exceptions import NotionAPIError
    except ImportError as e:
        await db_execute(
            "UPDATE jobs SET status = ?, error = ?, finished_at = ?, updated_at = ? WHERE id = ?",
            ("failed", f"Python pkg import error: {e}", int(time.time() * 1000), int(time.time() * 1000), job_id),
        )
        await db_execute(
            "UPDATE accounts SET status = ?, updated_at = ? WHERE id = ?",
            ("failed", int(time.time() * 1000), account_id),
        )
        add_log("error", f"signup-ext import failed: {e}")
        return

    now_ms = lambda: int(time.time() * 1000)

    try:
        # Step 1: browser signup (opens tab, fills email, hCaptcha auto-solve,
        # intercepts XHRs, captures cookies)
        steps.append({"step": "browser_signup", "status": "running"})
        adapter = AiohttpBridgeAdapter()
        email_worker = _build_email_worker()
        signup_result = await signup_with_extension(
            adapter,
            email=email,
            email_worker=email_worker,
            is_login=is_login,
            close_tab_on_success=close_tab,
            email_wait_timeout=180.0,
            captcha_wait_timeout=300.0,
        )
        steps[-1]["status"] = "done"

        # Persist captured cookies + userId
        await db_execute(
            "UPDATE accounts SET user_id = ?, status = ?, token_v2 = ?, "
            "notion_device_id = ?, all_cookies = ?, verification_code = ?, updated_at = ? WHERE id = ?",
            (
                signup_result.user_id, "signed_up", signup_result.token_v2,
                signup_result.notion_device_id,
                json.dumps(signup_result.cookies),
                "",  # verification_code captured separately by email_worker
                now_ms(), account_id,
            ),
        )

        # Step 2: build NotionAppClient from captured cookies, create workspace
        steps.append({"step": "create_workspace", "status": "running"})
        client = build_client_from_result(signup_result)
        # Discover space_id if not set (the signup response sometimes omits it)
        sid = client.ensure_space_id()
        space_created = create_space(
            client,
            name=ws_name,
            icon=ws_icon,
            plan_type="personal",
            user_id=signup_result.user_id,
        )
        sid = space_created.space_id
        svid = space_created.space_view_id or create_space_view_for(
            client, space_id=sid, user_id=signup_result.user_id,
        )
        ws_id = str(uuid.uuid4())
        await db_execute(
            "INSERT INTO workspaces (id, account_id, space_id, name, icon, plan_type, "
            "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (ws_id, account_id, sid, ws_name, ws_icon, "personal", now_ms(), now_ms()),
        )
        steps[-1]["status"] = "done"

        # Step 3: finish onboarding screens (matches HAR Phase D + E)
        steps.append({"step": "onboarding", "status": "running"})
        try:
            auto = OnboardingAutomation.from_existing_client(client)
            auto.finish_onboarding_screens(
                signup_result.user_id,
                space_id=sid,
                space_view_id=svid,
                email=email,
                space_name=ws_name,
            )
            steps[-1]["status"] = "done"
        except NotionAPIError as e:
            # Non-fatal: workspace is created, onboarding screens are secondary
            steps[-1]["status"] = "skipped"
            steps[-1]["error"] = str(e)
            add_log("warn", f"finish_onboarding_screens skipped: {e}")

        await db_execute(
            "UPDATE accounts SET status = ?, updated_at = ? WHERE id = ?",
            ("onboarded", now_ms(), account_id),
        )
        await db_execute(
            "UPDATE jobs SET status = ?, result = ?, finished_at = ?, updated_at = ? WHERE id = ?",
            (
                "completed",
                json.dumps({"steps": steps, "userId": signup_result.user_id, "spaceId": sid}),
                now_ms(), now_ms(), job_id,
            ),
        )
        add_log("info", f"signup-ext completed for {email} (account={account_id[:8]}, space={sid[:8]})")
    except Exception as e:
        import traceback
        msg = str(e)
        stack = traceback.format_exc()
        add_log("error", f"signup-ext FAILED for {email}: {msg}\n{stack}")
        full_err = f"{msg}\n\nStack:\n" + "\n".join(stack.splitlines()[:10])
        await db_execute(
            "UPDATE jobs SET status = ?, error = ?, finished_at = ?, updated_at = ? WHERE id = ?",
            ("failed", full_err, now_ms(), now_ms(), job_id),
        )
        await db_execute(
            "UPDATE accounts SET status = ?, updated_at = ? WHERE id = ?",
            ("failed", now_ms(), account_id),
        )


async def handle_signup_ext(request: web.Request) -> web.Response:
    """POST /api/signup-ext — create account + run signup via extension.

    Body: { email?, workspaceName?, workspaceIcon?, isLogin?, closeTabOnSuccess?, force? }
    Returns 202 immediately with the jobId; the actual signup runs in the
    background and updates the SQLite DB as it progresses. Poll /api/jobs.
    """
    try:
        body = await request.json()
    except Exception:
        return _error_response("Invalid JSON body", status=400)

    email = body.get("email") or f"auto_{int(time.time() * 1000)}@{os.environ.get('EMAIL_DOMAIN', 'privatimail.com')}"
    ws_name = body.get("workspaceName") or "My Workspace"
    ws_icon = body.get("workspaceIcon") or "🏠"

    # Pre-flight extension check
    err = await _check_extension_connected()
    if err:
        return _error_response(err["error"], status=err["status"])

    # Cookie conflict check (skip if force=true)
    if not body.get("force"):
        existing = await _check_notion_cookies()
        if existing:
            return _json_response({
                "ok": False,
                "conflict": True,
                "error": "Existing Notion session detected. The browser has valid session cookies that will interfere with the signup flow. Clear them first?",
                "cookies": existing,
            }, status=409)

    # Insert account + job rows
    job_id = str(uuid.uuid4())
    account_id = str(uuid.uuid4())
    now_ms = int(time.time() * 1000)
    await db_execute(
        "INSERT INTO jobs (id, account_id, stage, status, options, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (job_id, account_id, "signup-ext", "running", json.dumps(body), now_ms, now_ms),
    )
    await db_execute(
        "INSERT INTO accounts (id, email, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        (account_id, email, "created", now_ms, now_ms),
    )

    # Kick off the background pipeline
    asyncio.create_task(_run_signup_pipeline(
        account_id=account_id, job_id=job_id, email=email,
        ws_name=ws_name, ws_icon=ws_icon,
        is_login=bool(body.get("isLogin")),
        close_tab=body.get("closeTabOnSuccess", True),
    ))

    return _json_response({
        "ok": True, "jobId": job_id, "accountId": account_id, "email": email,
        "status": "running",
        "hint": "Browser tab opening — solve the hCaptcha if prompted. Watch the job status.",
    }, status=202)


async def handle_retry(request: web.Request) -> web.Response:
    """POST /api/accounts/{id}/retry — retry a failed account.

    If the account already has user_id + token_v2 (signup succeeded but
    onboarding failed), skips the browser signup and goes straight to
    workspace creation + onboarding.
    """
    account_id = request.match_info["account_id"]
    row = await db_query_one("SELECT * FROM accounts WHERE id = ?", (account_id,))
    if not row:
        return _error_response("Account not found", status=404)
    if row["status"] in ("onboarded", "complete"):
        return _error_response(f"Account is already {row['status']} — nothing to retry", status=409)

    err = await _check_extension_connected()
    if err:
        return _error_response(err["error"], status=err["status"])

    try:
        body = await request.json()
    except Exception:
        body = {}
    ws_name = body.get("workspaceName") or "My Workspace"
    ws_icon = body.get("workspaceIcon") or "🏠"

    job_id = str(uuid.uuid4())
    now_ms = int(time.time() * 1000)
    await db_execute(
        "INSERT INTO jobs (id, account_id, stage, status, options, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (job_id, account_id, "retry", "running", json.dumps(body), now_ms, now_ms),
    )
    await db_execute(
        "UPDATE accounts SET status = ?, updated_at = ? WHERE id = ?",
        ("retrying", now_ms, account_id),
    )

    # If we already have cookies, skip the browser flow
    if row.get("user_id") and row.get("token_v2"):
        asyncio.create_task(_run_retry_from_cookies(
            account_id=account_id, job_id=job_id, email=row["email"],
            user_id=row["user_id"], token_v2=row["token_v2"],
            device_id=row.get("notion_device_id") or "",
            ws_name=ws_name, ws_icon=ws_icon,
        ))
    else:
        asyncio.create_task(_run_signup_pipeline(
            account_id=account_id, job_id=job_id, email=row["email"],
            ws_name=ws_name, ws_icon=ws_icon,
            is_login=False, close_tab=body.get("closeTabOnSuccess", True),
        ))

    return _json_response({
        "ok": True, "jobId": job_id, "accountId": account_id, "status": "retrying",
        "hint": "Watch the job status.",
    }, status=202)


async def _run_retry_from_cookies(
    *, account_id: str, job_id: str, email: str,
    user_id: str, token_v2: str, device_id: str,
    ws_name: str, ws_icon: str,
) -> None:
    """Retry path: skip browser signup, go straight to workspace + onboarding."""
    steps: list[dict] = [{"step": "reuse_signup", "status": "done", "note": "Using cookies from previous signup"}]
    now_ms = lambda: int(time.time() * 1000)
    try:
        from notion_onboarding import NotionAppClient
        from notion_onboarding.workspace import create_space, create_space_view_for
        from notion_onboarding.onboarding import OnboardingAutomation
        from notion_onboarding.exceptions import NotionAPIError

        client = NotionAppClient(
            token_v2=token_v2, user_id=user_id, device_id=device_id or None,
        )

        steps.append({"step": "create_workspace", "status": "running"})
        sid = client.ensure_space_id()
        space_created = create_space(
            client, name=ws_name, icon=ws_icon, plan_type="personal", user_id=user_id,
        )
        sid = space_created.space_id
        svid = space_created.space_view_id or create_space_view_for(
            client, space_id=sid, user_id=user_id,
        )
        ws_id = str(uuid.uuid4())
        await db_execute(
            "INSERT INTO workspaces (id, account_id, space_id, name, icon, plan_type, "
            "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (ws_id, account_id, sid, ws_name, ws_icon, "personal", now_ms(), now_ms()),
        )
        steps[-1]["status"] = "done"

        steps.append({"step": "onboarding", "status": "running"})
        try:
            auto = OnboardingAutomation.from_existing_client(client)
            auto.finish_onboarding_screens(
                user_id, space_id=sid, space_view_id=svid, email=email, space_name=ws_name,
            )
            steps[-1]["status"] = "done"
        except NotionAPIError as e:
            steps[-1]["status"] = "skipped"
            steps[-1]["error"] = str(e)

        await db_execute(
            "UPDATE accounts SET status = ?, updated_at = ? WHERE id = ?",
            ("onboarded", now_ms(), account_id),
        )
        await db_execute(
            "UPDATE jobs SET status = ?, result = ?, finished_at = ?, updated_at = ? WHERE id = ?",
            ("completed", json.dumps({"steps": steps, "userId": user_id, "spaceId": sid}),
             now_ms(), now_ms(), job_id),
        )
        add_log("info", f"retry-from-cookies completed for {email}")
    except Exception as e:
        import traceback
        msg = str(e)
        stack = traceback.format_exc()
        add_log("error", f"retry-from-cookies FAILED for {email}: {msg}\n{stack}")
        await db_execute(
            "UPDATE jobs SET status = ?, error = ?, finished_at = ?, updated_at = ? WHERE id = ?",
            ("failed", f"{msg}\n\nStack:\n" + "\n".join(stack.splitlines()[:10]), now_ms(), now_ms(), job_id),
        )
        await db_execute(
            "UPDATE accounts SET status = ?, updated_at = ? WHERE id = ?",
            ("failed", now_ms(), account_id),
        )


async def handle_create_workspace_on_account(request: web.Request) -> web.Response:
    """POST /api/accounts/{id}/workspaces — create a workspace on an existing account.

    Body: { name: string, icon?, planType? }
    """
    account_id = request.match_info["account_id"]
    try:
        body = await request.json()
    except Exception:
        return _error_response("Invalid JSON body", status=400)
    name = body.get("name")
    if not name:
        return _error_response("name is required", status=400)
    icon = body.get("icon") or "🏠"
    plan_type = body.get("planType") or "personal"

    account = await db_query_one(
        "SELECT * FROM accounts WHERE id = ? OR email = ? OR user_id = ?",
        (account_id, account_id, account_id),
    )
    if not account:
        return _error_response("account not found", status=404)

    err = await _check_extension_connected()
    if err:
        return _error_response(err["error"], status=err["status"])

    try:
        from notion_onboarding import NotionAppClient
        from notion_onboarding.workspace import create_space, create_space_view_for
        client = NotionAppClient(
            token_v2=account["token_v2"], user_id=account["user_id"],
            device_id=account.get("notion_device_id") or None,
        )
        sid = client.ensure_space_id()
        space_created = create_space(
            client, name=name, icon=icon, plan_type=plan_type,
            user_id=account["user_id"],
        )
        sid = space_created.space_id
        svid = space_created.space_view_id or create_space_view_for(
            client, space_id=sid, user_id=account["user_id"],
        )
        ws_id = str(uuid.uuid4())
        now_ms = int(time.time() * 1000)
        await db_execute(
            "INSERT INTO workspaces (id, account_id, space_id, name, icon, plan_type, "
            "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (ws_id, account["id"], sid, name, icon, plan_type, now_ms, now_ms),
        )
        return _json_response({
            "ok": True, "workspaceId": ws_id, "spaceId": sid, "spaceViewId": svid,
            "name": name, "icon": icon, "planType": plan_type,
        })
    except Exception as e:
        import traceback
        add_log("error", f"create-workspace failed: {e}\n{traceback.format_exc()}")
        return _error_response(str(e), status=502, hint="Make sure the browser extension is connected.")


async def handle_batch_workspaces_on_account(request: web.Request) -> web.Response:
    """POST /api/accounts/{id}/workspaces/batch — batch create workspaces.

    Body: { workspaces: [{ name, icon?, planType? }, ...] }
    Returns one result per workspace.
    """
    account_id = request.match_info["account_id"]
    try:
        body = await request.json()
    except Exception:
        return _error_response("Invalid JSON body", status=400)
    workspaces = body.get("workspaces") or []
    if not workspaces:
        return _error_response("workspaces array is required", status=400)

    account = await db_query_one(
        "SELECT * FROM accounts WHERE id = ? OR email = ? OR user_id = ?",
        (account_id, account_id, account_id),
    )
    if not account:
        return _error_response("account not found", status=404)

    err = await _check_extension_connected()
    if err:
        return _error_response(err["error"], status=err["status"])

    try:
        from notion_onboarding import NotionAppClient
        from notion_onboarding.workspace import create_space, create_space_view_for
        client = NotionAppClient(
            token_v2=account["token_v2"], user_id=account["user_id"],
            device_id=account.get("notion_device_id") or None,
        )
        client.ensure_space_id()
    except Exception as e:
        return _error_response(str(e), status=502)

    results: list[dict] = []
    for ws in workspaces:
        try:
            name = ws.get("name")
            if not name:
                results.append({"name": name, "ok": False, "error": "name is required"})
                continue
            icon = ws.get("icon") or "🏠"
            plan_type = ws.get("planType") or "personal"
            space_created = create_space(
                client, name=name, icon=icon, plan_type=plan_type,
                user_id=account["user_id"],
            )
            sid = space_created.space_id
            svid = space_created.space_view_id or create_space_view_for(
                client, space_id=sid, user_id=account["user_id"],
            )
            ws_id = str(uuid.uuid4())
            now_ms = int(time.time() * 1000)
            await db_execute(
                "INSERT INTO workspaces (id, account_id, space_id, name, icon, plan_type, "
                "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (ws_id, account["id"], sid, name, icon, plan_type, now_ms, now_ms),
            )
            results.append({"name": name, "ok": True, "workspaceId": ws_id, "spaceId": sid, "spaceViewId": svid})
        except Exception as e:
            results.append({"name": ws.get("name"), "ok": False, "error": str(e)})

    succeeded = sum(1 for r in results if r.get("ok"))
    return _json_response({
        "ok": succeeded == len(results),
        "total": len(results), "succeeded": succeeded,
        "failed": len(results) - succeeded,
        "results": results,
    })


async def handle_batch_accounts(request: web.Request) -> web.Response:
    """POST /api/accounts/batch — batch account creation.

    Body: { accounts: [{ email?, workspaceName?, workspaceIcon? }, ...] }
    Returns 202 with per-account jobIds; accounts run sequentially.
    """
    try:
        body = await request.json()
    except Exception:
        return _error_response("Invalid JSON body", status=400)
    accounts = body.get("accounts") or []
    if not accounts:
        return _error_response("accounts array is required", status=400)

    err = await _check_extension_connected()
    if err:
        return _error_response(err["error"], status=err["status"])

    batch_id = str(uuid.uuid4())
    results: list[dict] = []
    now_ms = int(time.time() * 1000)
    for acct in accounts:
        email = acct.get("email") or f"auto_{int(time.time() * 1000)}_{uuid.uuid4().hex[:6]}@{os.environ.get('EMAIL_DOMAIN', 'privatimail.com')}"
        ws_name = acct.get("workspaceName") or "My Workspace"
        ws_icon = acct.get("workspaceIcon") or "🏠"
        job_id = str(uuid.uuid4())
        account_id = str(uuid.uuid4())
        await db_execute(
            "INSERT INTO jobs (id, account_id, stage, status, options, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (job_id, account_id, "batch_signup", "pending",
             json.dumps({**acct, "batchId": batch_id}), now_ms, now_ms),
        )
        await db_execute(
            "INSERT INTO accounts (id, email, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            (account_id, email, "created", now_ms, now_ms),
        )
        results.append({"email": email, "ok": None, "jobId": job_id, "accountId": account_id,
                        "wsName": ws_name, "wsIcon": ws_icon, "status": "pending"})

    # Run sequentially (one tab at a time — hCaptcha conflicts)
    async def _run_batch():
        for r in results:
            now_ms_b = int(time.time() * 1000)
            await db_execute(
                "UPDATE jobs SET status = ?, started_at = ?, updated_at = ? WHERE id = ?",
                ("running", now_ms_b, now_ms_b, r["jobId"]),
            )
            await _run_signup_pipeline(
                account_id=r["accountId"], job_id=r["jobId"], email=r["email"],
                ws_name=r["wsName"], ws_icon=r["wsIcon"],
                is_login=False, close_tab=True,
            )
            # Pull final status
            job = await db_query_one("SELECT status, error, result FROM jobs WHERE id = ?", (r["jobId"],))
            r["status"] = job["status"] if job else "unknown"
            r["ok"] = (r["status"] == "completed")
            if not r["ok"]:
                r["error"] = job.get("error") if job else "unknown error"
            else:
                # Extract userId + spaceId from the result JSON
                try:
                    parsed = json.loads(job["result"]) if job and job.get("result") else {}
                    r["userId"] = parsed.get("userId", "")
                    r["spaceId"] = parsed.get("spaceId", "")
                except Exception:
                    pass

    asyncio.create_task(_run_batch())

    return _json_response({
        "ok": True, "batchId": batch_id, "total": len(results), "results": results,
        "hint": "Accounts are being created sequentially via browser. Poll GET /api/jobs to see per-account status.",
    }, status=202)


async def handle_relogin(request: web.Request) -> web.Response:
    """POST /api/relogin — re-login an existing account (fresh cookies).

    Body: { email, force? }
    """
    try:
        body = await request.json()
    except Exception:
        return _error_response("Invalid JSON body", status=400)
    email = body.get("email")
    if not email:
        return _error_response("Missing email", status=400)

    err = await _check_extension_connected()
    if err:
        return _error_response(err["error"], status=err["status"])

    # Cookie conflict check (skip if force=true)
    if not body.get("force"):
        existing = await _check_notion_cookies()
        if existing:
            return _json_response({
                "ok": False,
                "conflict": True,
                "error": "Existing Notion session detected. The browser has valid session cookies that will interfere with the re-login flow. Clear them first?",
                "cookies": existing,
            }, status=409)

    # Find the existing account row (or create one if missing — supports ad-hoc re-login)
    account = await db_query_one("SELECT * FROM accounts WHERE email = ?", (email,))
    if not account:
        account_id = str(uuid.uuid4())
        now_ms = int(time.time() * 1000)
        await db_execute(
            "INSERT INTO accounts (id, email, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            (account_id, email, "created", now_ms, now_ms),
        )
    else:
        account_id = account["id"]

    # Run the browser-orchestrated login in the background
    job_id = str(uuid.uuid4())
    now_ms = int(time.time() * 1000)
    await db_execute(
        "INSERT INTO jobs (id, account_id, stage, status, options, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (job_id, account_id, "relogin", "running", json.dumps(body), now_ms, now_ms),
    )

    async def _run_relogin():
        now_ms_b = lambda: int(time.time() * 1000)
        try:
            from notion_onboarding import signup_with_extension
            adapter = AiohttpBridgeAdapter()
            email_worker = _build_email_worker()
            result = await signup_with_extension(
                adapter, email=email, email_worker=email_worker,
                is_login=True, close_tab_on_success=True,
                email_wait_timeout=180.0, captcha_wait_timeout=300.0,
            )
            await db_execute(
                "UPDATE accounts SET user_id = ?, token_v2 = ?, notion_device_id = ?, "
                "all_cookies = ?, status = ?, updated_at = ? WHERE email = ?",
                (result.user_id, result.token_v2, result.notion_device_id,
                 json.dumps(result.cookies), "relogged_in", now_ms_b(), email),
            )
            await db_execute(
                "UPDATE jobs SET status = ?, result = ?, finished_at = ?, updated_at = ? WHERE id = ?",
                ("completed", json.dumps({"userId": result.user_id}), now_ms_b(), now_ms_b(), job_id),
            )
            add_log("info", f"relogin completed for {email}")
        except Exception as e:
            import traceback
            add_log("error", f"relogin FAILED for {email}: {e}\n{traceback.format_exc()}")
            await db_execute(
                "UPDATE jobs SET status = ?, error = ?, finished_at = ?, updated_at = ? WHERE id = ?",
                ("failed", str(e), now_ms_b(), now_ms_b(), job_id),
            )

    asyncio.create_task(_run_relogin())
    return _json_response({
        "ok": True, "jobId": job_id, "accountId": account_id, "email": email,
        "status": "running",
        "hint": "Browser tab opening — solve the hCaptcha if prompted. Watch the job status.",
    }, status=202)


# ---------------------------------------------------------------------- #
# HTTP polling fallback (in-memory) — for extensions that can't hold a WS
# ---------------------------------------------------------------------- #

async def handle_poll(request: web.Request) -> web.Response:
    """GET /api/poll?agentId=X&wait=N — extension long-polls for commands.

    Records a heartbeat (so /api/extensions can see active polling agents),
    then waits up to N seconds for a pending command for this agent.
    Commands come from the in-memory INMEM_QUEUE (no SQLite).

    De-duplication: if a command's future (PENDING) is already resolved
    (i.e., WS already delivered + got a result), the command is skipped
    and removed from the queue. This prevents the extension from
    executing the same command twice when both WS and HTTP polling are
    active.
    """
    agent_id = request.query.get("agentId") or "default"
    wait_sec = min(int(request.query.get("wait") or "3"), 10)
    INMEM_HEARTBEATS[agent_id] = time.time()

    deadline = time.time() + wait_sec
    while time.time() < deadline:
        q = INMEM_QUEUE.get(agent_id)
        if q:
            # Skip commands whose future is already resolved (WS delivered
            # them). This prevents double-execution when both paths are alive.
            while q:
                cmd = q.pop(0)
                cmd_id = cmd.get("id", "")
                fut = PENDING.get(cmd_id)
                if fut is None or fut.done():
                    # Either no future (orphaned) or already resolved — skip
                    INMEM_RESULTS.pop(cmd_id, None)
                    continue
                # Active future — deliver to extension
                INMEM_RESULTS.pop(cmd_id, None)
                return _json_response({"commands": [cmd]})
        await asyncio.sleep(0.5)
    return _json_response({"commands": []})


async def handle_post_result(request: web.Request) -> web.Response:
    """POST /api/result — extension posts a command result.

    Body: { id: <cmdId>, ...result fields }
    """
    try:
        body = await request.json()
    except Exception:
        return _error_response("Invalid JSON body", status=400)
    cmd_id = body.get("id")
    if not cmd_id:
        return _error_response("Missing id", status=400)
    INMEM_RESULTS[cmd_id] = body
    # Also resolve any pending WS future for this cmd (in case the extension
    # is mixing WS + HTTP polling modes).
    fut = PENDING.pop(cmd_id, None)
    if fut and not fut.done():
        fut.set_result(body)
    return _json_response({"ok": True})


# ---------------------------------------------------------------------- #
# Main server
# ---------------------------------------------------------------------- #

async def run(host: str, port: int) -> None:
    # Initialise the SQLite DB before anything else — every handler below
    # depends on it. Idempotent: safe to call on every boot.
    init_db()

    app = web.Application()
    app["host"] = host
    app["port"] = port

    # HTTP routes — the "/" handler checks for WS upgrade headers and
    # dispatches accordingly.
    app.router.add_get("/", handle_root)
    app.router.add_get("/health", handle_health)
    # Dashboard static files (served from dashboard/ — no longer shared
    # with the Worker, this bridge is now the sole backend).
    app.router.add_get("/styles.css", handle_dashboard_styles)
    app.router.add_get("/app.js", handle_dashboard_js)
    # Legacy bridge-only status page (kept for debugging the bridge itself).
    app.router.add_get("/bridge-status", handle_bridge_status_page)
    app.router.add_get("/api/token", handle_token)
    app.router.add_get("/sandbox", handle_sandbox_page)
    app.router.add_get("/sandbox.js", handle_sandbox_js)
    # Also allow /ws as an alias for direct local testing
    app.router.add_get("/ws", handle_websocket)

    # Remote portal API — let the Python backend drive the extension.
    app.router.add_post("/api/command", handle_api_command)
    app.router.add_post("/api/open", handle_api_open)
    app.router.add_post("/api/eval", handle_api_eval)
    app.router.add_post("/api/screenshot", handle_api_screenshot)
    app.router.add_post("/api/cookies", handle_api_cookies)
    app.router.add_post("/api/fetch", handle_api_fetch)
    app.router.add_post("/api/captcha-token", handle_api_captcha_token)
    app.router.add_post("/api/sandbox-fetch", handle_api_sandbox_fetch)

    # ── Native dashboard API (SQLite-backed) ──
    # These used to be proxied to the Cloudflare Worker; now they're
    # implemented in Python against the local bridge.db.
    app.router.add_get("/api/accounts", handle_list_accounts)
    app.router.add_get("/api/accounts/batch", handle_list_accounts)  # alias for GET
    app.router.add_post("/api/accounts/batch", handle_batch_accounts)
    app.router.add_get("/api/accounts/{account_id}", handle_get_account)
    app.router.add_post("/api/accounts/{account_id}/retry", handle_retry)
    app.router.add_post("/api/accounts/{account_id}/workspaces", handle_create_workspace_on_account)
    app.router.add_post("/api/accounts/{account_id}/workspaces/batch", handle_batch_workspaces_on_account)

    app.router.add_get("/api/workspaces", handle_list_workspaces)
    app.router.add_get("/api/jobs", handle_list_jobs)
    app.router.add_get("/api/extensions", handle_extensions)
    app.router.add_post("/api/signup-ext", handle_signup_ext)
    app.router.add_post("/api/relogin", handle_relogin)
    app.router.add_get("/api/notion-cookies", handle_notion_cookies)
    app.router.add_post("/api/clear-notion-cookies", handle_clear_notion_cookies)

    # ── HTTP polling fallback (in-memory) ──
    # The dashboard JS uses WebSocket (/ws) for live command routing, but
    # these endpoints exist for extensions that can only do HTTP polling.
    app.router.add_get("/api/poll", handle_poll)
    app.router.add_post("/api/result", handle_post_result)

    runner = web.AppRunner(app)
    await runner.setup()
    # Bind to 0.0.0.0 — Caddy's reverse_proxy connects via localhost, and
    # local dev connects via localhost too. IPv4 explicit avoids the "::"
    # trap on some systems.
    site = web.TCPSite(runner, "0.0.0.0", port)
    await site.start()

    print(f"\n{'='*60}")
    print(f"  Notion Onboarding Bridge is running (aiohttp + SQLite)")
    print(f"  HTTP:    http://{host}:{port}/")
    print(f"  WS:      ws://{host}:{port}/ws")
    print(f"  Health:  http://{host}:{port}/health")
    # Port 3000 is Caddy's default proxy target — no XTransformPort needed.
    # For other ports, the user must append ?XTransformPort=<port> to URLs.
    xtp = "" if port == 3000 else f"?XTransformPort={port}"
    print(f"  DB:      {DB_PATH}")
    print(f"{'='*60}")
    print(f"\n  Extension WebSocket URL:")
    print(f"    Local:  ws://localhost:{port}/ws")
    print(f"    Remote: wss://preview-<bot-id>.space-z.ai/ws{xtp}")
    print(f"\n  Dashboard:      https://preview-<bot-id>.space-z.ai/{xtp}")
    print(f"  Bridge status:  https://preview-<bot-id>.space-z.ai/bridge-status{xtp}")
    print(f"\n  Backend mode: native Python + SQLite (no Worker dependency)")
    print(f"  Email worker:   {'configured' if _build_email_worker() else 'NOT configured (EMAIL_WORKER_TOKEN missing)'}")
    print(f"\n  Press Ctrl+C to stop.\n")

    # Wait forever
    stop_event = asyncio.Event()

    def signal_handler():
        print("\nShutting down...")
        stop_event.set()

    loop = asyncio.get_event_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, signal_handler)
        except NotImplementedError:
            signal.signal(sig, lambda s, f: signal_handler())

    try:
        await stop_event.wait()
    finally:
        await runner.cleanup()
        print("Bridge stopped.")


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the Notion Onboarding Bridge server (aiohttp)")
    parser.add_argument("--host", default="0.0.0.0", help="Bind host (default: 0.0.0.0)")
    parser.add_argument("--port", type=int, default=3000, help="Port (default: 3000 — Caddy gateway default)")
    parser.add_argument("-v", "--verbose", action="store_true", help="Enable debug logging")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stdout,
    )

    try:
        asyncio.run(run(args.host, args.port))
        return 0
    except KeyboardInterrupt:
        return 0
    except Exception as e:
        print(f"FATAL: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
