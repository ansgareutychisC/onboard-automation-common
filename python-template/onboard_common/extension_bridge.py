"""onboard_common.extension_bridge

Async client for the unified browser extension. Talks to either:
  - a Cloudflare Worker (worker-template/) via HTTPS + WebSocket
  - a local Python daemon (scripts/run_bridge.py) via HTTP + WebSocket

Both backends expose the same REST API:
    GET  /health
    GET  /api/extensions
    POST /api/command           { cmd: {...}, timeout: 30.0 }
    GET  /api/poll?agentId=...  (extension-side)
    POST /api/result            (extension-side)
    POST /api/send-http         (enqueue command for HTTP-polling extension)
    GET  /api/result/:id        (poll for result by cmdId)

This client uses POST /api/command for the primary path. If that returns
503 (extension not connected via WS) or times out, it falls back to
POST /api/send-http + GET /api/result/:id (the SOS HTTP queue).

All command methods are async. Use `asyncio.run(...)` or your event loop.
"""

from __future__ import annotations
import asyncio
import json
import logging
import uuid
from typing import Any, Optional

import aiohttp

from .protocol import (
    PROTOCOL_VERSION, CommandType, Command, CommandResult, DEFAULT_TIMEOUT_MS,
)
from .exceptions import (
    BridgeConnectionError, BridgeNotConnectedError, BridgeTimeoutError,
    BridgeCommandError, BridgeAuthError, BridgeProtocolError,
)

logger = logging.getLogger("onboard_common.extension_bridge")


class ExtensionBridge:
    """Async client for the unified browser extension."""

    def __init__(
        self,
        base_url: str = "http://127.0.0.1:8787",
        *,
        auth_token: str = "",
        default_timeout: float = 30.0,
        session: Optional[aiohttp.ClientSession] = None,
    ):
        """
        :param base_url: bridge daemon URL (e.g. http://127.0.0.1:8787 or
            https://your-worker.workers.dev)
        :param auth_token: Bearer token for the bridge (matches BRIDGE_TOKEN
            on the worker, or daemon auth_token)
        :param default_timeout: fallback timeout if a command doesn't specify one
        :param session: optional pre-built aiohttp session
        """
        self.base_url = base_url.rstrip("/")
        self.auth_token = auth_token
        self.default_timeout = default_timeout
        self._session = session
        self._owns_session = session is None

    async def __aenter__(self) -> "ExtensionBridge":
        await self.connect()
        return self

    async def __aexit__(self, *exc):
        await self.close()

    async def connect(self) -> None:
        if self._session is None:
            self._session = aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=300.0),  # 5 min for long-running XHR intercepts
            )
        # Health check
        try:
            async with self._session.get(f"{self.base_url}/health") as resp:
                if resp.status != 200:
                    raise BridgeConnectionError(f"bridge health check failed: HTTP {resp.status}")
                data = await resp.json()
                if not data.get("ok"):
                    raise BridgeConnectionError(f"bridge health check returned ok=false: {data}")
        except aiohttp.ClientError as e:
            raise BridgeConnectionError(f"cannot reach bridge at {self.base_url}: {e}") from e

    async def close(self) -> None:
        if self._session and self._owns_session:
            await self._session.close()
            self._session = None

    # -----------------------------------------------------------------
    # Status / discovery
    # -----------------------------------------------------------------

    async def is_extension_connected(self) -> bool:
        """Check if at least one extension (context=worker) is connected."""
        data = await self._get_json("/api/extensions")
        exts = data.get("extensions", [])
        return any(e.get("context") == "worker" and e.get("readyState") == 1 for e in exts)

    async def wait_for_extension(self, timeout: float = 300.0, poll_interval: float = 1.0) -> None:
        """Block until an extension connects, or raise BridgeTimeoutError."""
        loop = asyncio.get_event_loop()
        deadline = loop.time() + timeout
        while loop.time() < deadline:
            if await self.is_extension_connected():
                return
            await asyncio.sleep(poll_interval)
        raise BridgeTimeoutError(f"No extension connected after {timeout}s")

    # -----------------------------------------------------------------
    # Low-level command dispatch
    # -----------------------------------------------------------------

    async def _send_command(self, cmd: Command, timeout: Optional[float] = None) -> CommandResult:
        """Send a command via POST /api/command (primary) or fall back to HTTP queue."""
        timeout_s = timeout or (cmd.timeout_ms / 1000 if cmd.timeout_ms else self.default_timeout)
        try:
            return await self._send_command_ws(cmd, timeout_s)
        except (BridgeNotConnectedError, asyncio.TimeoutError) as e:
            logger.debug("WS path failed (%s), falling back to HTTP queue", e)
            return await self._send_command_http(cmd, timeout_s)

    async def _send_command_ws(self, cmd: Command, timeout_s: float) -> CommandResult:
        headers = self._auth_headers()
        headers["content-type"] = "application/json"
        body = json.dumps({"cmd": cmd.to_dict(), "timeout": timeout_s})
        try:
            async with self._session.post(
                f"{self.base_url}/api/command",
                headers=headers,
                data=body,
                timeout=aiohttp.ClientTimeout(total=timeout_s + 10),
            ) as resp:
                if resp.status == 503:
                    raise BridgeNotConnectedError("no extension connected via WS")
                if resp.status == 401:
                    raise BridgeAuthError("bridge rejected auth token")
                if resp.status != 200:
                    text = await resp.text()
                    raise BridgeProtocolError(f"bridge returned HTTP {resp.status}: {text}")
                data = await resp.json()
                return CommandResult.from_dict(data)
        except asyncio.TimeoutError:
            raise
        except aiohttp.ClientError as e:
            raise BridgeConnectionError(f"failed to send command: {e}") from e

    async def _send_command_http(self, cmd: Command, timeout_s: float) -> CommandResult:
        """Fallback: enqueue via /api/send-http, poll /api/result/:id."""
        headers = self._auth_headers()
        headers["content-type"] = "application/json"
        body = json.dumps({"cmd": cmd.to_dict()})
        try:
            async with self._session.post(
                f"{self.base_url}/api/send-http",
                headers=headers,
                data=body,
                timeout=aiohttp.ClientTimeout(total=10),
            ) as resp:
                if resp.status != 200:
                    raise BridgeProtocolError(f"/api/send-http returned {resp.status}")
                enqueue_data = await resp.json()
                cmd_id = enqueue_data["id"]
        except (aiohttp.ClientError, KeyError) as e:
            raise BridgeConnectionError(f"failed to enqueue command: {e}") from e

        # Poll for result
        loop = asyncio.get_event_loop()
        deadline = loop.time() + timeout_s + 30  # grace
        while loop.time() < deadline:
            try:
                async with self._session.get(
                    f"{self.base_url}/api/result/{cmd_id}",
                    headers=self._auth_headers(),
                    timeout=aiohttp.ClientTimeout(total=10),
                ) as resp:
                    if resp.status == 200:
                        data = await resp.json()
                        return CommandResult.from_dict(data)
                    if resp.status == 404:
                        await asyncio.sleep(1.0)
                        continue
                    raise BridgeProtocolError(f"/api/result/{cmd_id} returned {resp.status}")
            except aiohttp.ClientError:
                await asyncio.sleep(1.0)
        raise BridgeTimeoutError(f"Command {cmd.type} ({cmd_id}) timed out after {timeout_s}s (HTTP fallback)")

    def _auth_headers(self) -> dict[str, str]:
        h = {}
        if self.auth_token:
            h["authorization"] = f"Bearer {self.auth_token}"
        return h

    # -----------------------------------------------------------------
    # Typed command methods — one per CommandType
    # -----------------------------------------------------------------

    async def fetch(
        self,
        url: str,
        *,
        method: str = "GET",
        headers: Optional[dict] = None,
        body: Optional[str] = None,
        credentials: str = "include",
        timeout_ms: Optional[int] = None,
    ) -> CommandResult:
        """Service-worker fetch. Use page_fetch() for zstd-bearing endpoints."""
        return await self._send_command(Command(
            type=CommandType.FETCH,
            payload={"url": url, "method": method, "headers": headers or {},
                     "body": body, "credentials": credentials},
            timeout_ms=timeout_ms or DEFAULT_TIMEOUT_MS[CommandType.FETCH],
        ))

    async def page_fetch(
        self,
        tab_id: int,
        url: str,
        *,
        method: str = "GET",
        headers: Optional[dict] = None,
        body: Optional[str] = None,
        credentials: str = "include",
        timeout_ms: Optional[int] = None,
    ) -> CommandResult:
        """Page-context fetch (handles zstd natively). Requires a tab to be open."""
        return await self._send_command(Command(
            type=CommandType.PAGE_FETCH,
            payload={"tabId": tab_id, "url": url, "method": method, "headers": headers or {},
                     "body": body, "credentials": credentials},
            timeout_ms=timeout_ms or DEFAULT_TIMEOUT_MS[CommandType.PAGE_FETCH],
        ))

    async def tabs_open(self, url: str, *, active: bool = True) -> CommandResult:
        return await self._send_command(Command(
            type=CommandType.TABS_OPEN,
            payload={"url": url, "active": active},
            timeout_ms=DEFAULT_TIMEOUT_MS[CommandType.TABS_OPEN],
        ))

    async def tabs_close(self, tab_id: int) -> CommandResult:
        return await self._send_command(Command(
            type=CommandType.TABS_CLOSE, payload={"tabId": tab_id},
        ))

    async def tabs_list(self) -> CommandResult:
        return await self._send_command(Command(type=CommandType.TABS_LIST, payload={}))

    async def tabs_focus(self, tab_id: int) -> CommandResult:
        return await self._send_command(Command(
            type=CommandType.TABS_FOCUS, payload={"tabId": tab_id},
        ))

    async def form_fill(self, tab_id: int, selector: str, value: str) -> CommandResult:
        return await self._send_command(Command(
            type=CommandType.FORM_FILL,
            payload={"tabId": tab_id, "selector": selector, "value": value},
        ))

    async def form_click(self, tab_id: int, selector: str) -> CommandResult:
        return await self._send_command(Command(
            type=CommandType.FORM_CLICK,
            payload={"tabId": tab_id, "selector": selector},
        ))

    async def form_wait(self, tab_id: int, selector: str, *, timeout_ms: int = 30_000) -> CommandResult:
        return await self._send_command(Command(
            type=CommandType.FORM_WAIT,
            payload={"tabId": tab_id, "selector": selector},
            timeout_ms=timeout_ms,
        ))

    async def form_eval(self, tab_id: int, function: str, args: Optional[list] = None) -> CommandResult:
        """Run a function body in the page's main world via CDP Runtime.evaluate."""
        return await self._send_command(Command(
            type=CommandType.FORM_EVAL,
            payload={"tabId": tab_id, "function": function, "args": args or []},
        ))

    async def xhr_intercept(
        self,
        tab_id: int,
        url_pattern: str,
        *,
        method: Optional[str] = None,
        timeout_ms: int = 30_000,
    ) -> CommandResult:
        """One-shot capture of the first XHR matching the regex url_pattern."""
        return await self._send_command(Command(
            type=CommandType.XHR_INTERCEPT,
            payload={"tabId": tab_id, "urlPattern": url_pattern, "method": method},
            timeout_ms=timeout_ms,
        ))

    async def cookies_get(self, url: str, name: str) -> CommandResult:
        return await self._send_command(Command(
            type=CommandType.COOKIES_GET, payload={"url": url, "name": name},
        ))

    async def cookies_get_all(self, url: str) -> CommandResult:
        return await self._send_command(Command(
            type=CommandType.COOKIES_GET_ALL, payload={"url": url},
        ))

    async def cookies_set(self, url: str, cookies: list[dict]) -> CommandResult:
        return await self._send_command(Command(
            type=CommandType.COOKIES_SET, payload={"url": url, "cookies": cookies},
        ))

    async def screenshot(self, tab_id: int, *, format: str = "png") -> CommandResult:
        return await self._send_command(Command(
            type=CommandType.SCREENSHOT,
            payload={"tabId": tab_id, "format": format},
        ))

    async def get_captcha_token(
        self,
        tab_id: int,
        *,
        provider: Optional[str] = None,
    ) -> CommandResult:
        """
        Get a captcha token. If provider is None, auto-detects among
        hcaptcha, recaptcha, turnstile, cloudflare.
        """
        payload = {"tabId": tab_id}
        if provider:
            payload["provider"] = provider
        return await self._send_command(Command(
            type=CommandType.CAPTCHA_GET_TOKEN, payload=payload,
        ))

    async def sandbox_open(self) -> CommandResult:
        return await self._send_command(Command(
            type=CommandType.SANDBOX_OPEN, payload={},
        ))

    async def sandbox_fetch(
        self,
        url: str,
        *,
        method: str = "GET",
        headers: Optional[dict] = None,
        body: Optional[str] = None,
        credentials: str = "include",
        timeout_ms: int = 120_000,
    ) -> CommandResult:
        """Route a fetch to the sandbox page (page-context, native zstd)."""
        return await self._send_command(Command(
            type=CommandType.SANDBOX_FETCH,
            payload={"url": url, "method": method, "headers": headers or {},
                     "body": body, "credentials": credentials},
            timeout_ms=timeout_ms,
        ))

    # -----------------------------------------------------------------
    # Activatable debug commands
    # -----------------------------------------------------------------

    async def debug_har_start(self, tab_id: int) -> CommandResult:
        """Start HAR capture on a tab. Returns a sessionId."""
        return await self._send_command(Command(
            type=CommandType.DEBUG_HAR_START,
            payload={"tabId": tab_id},
        ))

    async def debug_har_stop(self, session_id: str) -> CommandResult:
        """Stop HAR capture. Returns the complete HAR 1.2 JSON blob."""
        return await self._send_command(Command(
            type=CommandType.DEBUG_HAR_STOP,
            payload={"sessionId": session_id},
            timeout_ms=DEFAULT_TIMEOUT_MS[CommandType.DEBUG_HAR_STOP],
        ))

    async def debug_console_start(self, tab_id: int) -> CommandResult:
        """Start mirroring page console.* to the backend (as MSG.EVENT messages)."""
        return await self._send_command(Command(
            type=CommandType.DEBUG_CONSOLE_START,
            payload={"tabId": tab_id},
        ))

    async def debug_console_stop(self, session_id: str) -> CommandResult:
        return await self._send_command(Command(
            type=CommandType.DEBUG_CONSOLE_STOP,
            payload={"sessionId": session_id},
        ))

    async def debug_network_start(
        self,
        tab_id: int,
        *,
        url_pattern: Optional[str] = None,
    ) -> CommandResult:
        """Start continuous network capture (vs one-shot xhr_intercept)."""
        payload = {"tabId": tab_id}
        if url_pattern:
            payload["urlPattern"] = url_pattern
        return await self._send_command(Command(
            type=CommandType.DEBUG_NETWORK_START, payload=payload,
        ))

    async def debug_network_stop(self, session_id: str) -> CommandResult:
        return await self._send_command(Command(
            type=CommandType.DEBUG_NETWORK_STOP,
            payload={"sessionId": session_id},
        ))

    async def debug_trace_start(
        self,
        tab_id: int,
        *,
        categories: str = "devtools.timeline,v8,disabled-by-default-devtools.timeline",
    ) -> CommandResult:
        """Start CDP Tracing (performance timeline)."""
        return await self._send_command(Command(
            type=CommandType.DEBUG_TRACE_START,
            payload={"tabId": tab_id, "categories": categories},
        ))

    async def debug_trace_stop(self, session_id: str) -> CommandResult:
        return await self._send_command(Command(
            type=CommandType.DEBUG_TRACE_STOP,
            payload={"sessionId": session_id},
            timeout_ms=DEFAULT_TIMEOUT_MS[CommandType.DEBUG_TRACE_STOP],
        ))

    async def debug_dom_snapshot(
        self,
        tab_id: int,
        *,
        include_shadow: bool = True,
        max_depth: int = 0,
    ) -> CommandResult:
        """One-shot DOM tree as HTML."""
        return await self._send_command(Command(
            type=CommandType.DEBUG_DOM_SNAPSHOT,
            payload={"tabId": tab_id, "includeShadow": include_shadow, "maxDepth": max_depth},
        ))

    async def debug_storage_dump(self, tab_id: int, *, include_cookies: bool = True) -> CommandResult:
        """Dump localStorage + sessionStorage + cookies for a tab."""
        return await self._send_command(Command(
            type=CommandType.DEBUG_STORAGE_DUMP,
            payload={"tabId": tab_id, "includeCookies": include_cookies},
        ))

    async def debug_screenshot_fullpage(
        self,
        tab_id: int,
        *,
        format: str = "png",
        quality: Optional[int] = None,
    ) -> CommandResult:
        """Full-page screenshot (not just viewport)."""
        return await self._send_command(Command(
            type=CommandType.DEBUG_SCREENSHOT_FULL,
            payload={"tabId": tab_id, "format": format, "quality": quality},
        ))

    async def _get_json(self, path: str) -> dict:
        async with self._session.get(
            f"{self.base_url}{path}",
            headers=self._auth_headers(),
            timeout=aiohttp.ClientTimeout(total=10),
        ) as resp:
            return await resp.json()
