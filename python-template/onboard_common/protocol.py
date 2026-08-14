"""onboard_common.protocol

Python mirror of the wire protocol. Single source of truth for the Python
side. Keep in sync with extension/lib/protocol.js and worker-template/src/types.ts.
"""

from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any, Optional
import uuid

PROTOCOL_VERSION = "1.0"


class CommandType:
    PING = "ping"
    FETCH = "fetch"
    PAGE_FETCH = "page.fetch"
    TABS_OPEN = "tabs.open"
    TABS_CLOSE = "tabs.close"
    TABS_LIST = "tabs.list"
    TABS_FOCUS = "tabs.focus"
    FORM_FILL = "form.fill"
    FORM_CLICK = "form.click"
    FORM_WAIT = "form.wait"
    FORM_EVAL = "form.eval"
    XHR_INTERCEPT = "xhr.intercept"
    COOKIES_GET = "cookies.get"
    COOKIES_GET_ALL = "cookies.getAll"
    COOKIES_SET = "cookies.set"
    SCREENSHOT = "screenshot"
    CAPTCHA_GET_TOKEN = "captcha.getToken"
    SANDBOX_OPEN = "sandbox.open"
    SANDBOX_FETCH = "sandbox.fetch"
    DEBUG_HAR_START = "debug.har.start"
    DEBUG_HAR_STOP = "debug.har.stop"
    DEBUG_CONSOLE_START = "debug.console.start"
    DEBUG_CONSOLE_STOP = "debug.console.stop"
    DEBUG_NETWORK_START = "debug.network.start"
    DEBUG_NETWORK_STOP = "debug.network.stop"
    DEBUG_TRACE_START = "debug.trace.start"
    DEBUG_TRACE_STOP = "debug.trace.stop"
    DEBUG_DOM_SNAPSHOT = "debug.dom.snapshot"
    DEBUG_STORAGE_DUMP = "debug.storage.dump"
    DEBUG_SCREENSHOT_FULL = "debug.screenshot.fullpage"


class MessageType:
    AUTH = "auth"
    CONNECT = "connect"
    AUTH_OK = "auth-ok"
    RESULT = "result"
    LOG = "log"
    PONG = "pong"
    EVENT = "event"
    STATUS = "status"


class LogLevel:
    DEBUG = "debug"
    INFO = "info"
    WARN = "warn"
    ERROR = "error"


class Context:
    WORKER = "worker"
    PAGE = "page"


# Default timeouts (ms) — must match extension/lib/protocol.js
DEFAULT_TIMEOUT_MS = {
    CommandType.FETCH: 30_000,
    CommandType.PAGE_FETCH: 30_000,
    CommandType.TABS_OPEN: 60_000,
    CommandType.TABS_CLOSE: 5_000,
    CommandType.TABS_LIST: 5_000,
    CommandType.TABS_FOCUS: 5_000,
    CommandType.FORM_FILL: 10_000,
    CommandType.FORM_CLICK: 10_000,
    CommandType.FORM_WAIT: 30_000,
    CommandType.FORM_EVAL: 30_000,
    CommandType.XHR_INTERCEPT: 30_000,
    CommandType.COOKIES_GET: 5_000,
    CommandType.COOKIES_GET_ALL: 5_000,
    CommandType.COOKIES_SET: 5_000,
    CommandType.SCREENSHOT: 10_000,
    CommandType.CAPTCHA_GET_TOKEN: 15_000,
    CommandType.SANDBOX_OPEN: 5_000,
    CommandType.SANDBOX_FETCH: 120_000,
    CommandType.DEBUG_HAR_START: 5_000,
    CommandType.DEBUG_HAR_STOP: 10_000,
    CommandType.DEBUG_CONSOLE_START: 5_000,
    CommandType.DEBUG_CONSOLE_STOP: 10_000,
    CommandType.DEBUG_NETWORK_START: 5_000,
    CommandType.DEBUG_NETWORK_STOP: 10_000,
    CommandType.DEBUG_TRACE_START: 5_000,
    CommandType.DEBUG_TRACE_STOP: 30_000,
    CommandType.DEBUG_DOM_SNAPSHOT: 15_000,
    CommandType.DEBUG_STORAGE_DUMP: 10_000,
    CommandType.DEBUG_SCREENSHOT_FULL: 15_000,
}


@dataclass
class Command:
    """A command sent to the extension."""
    type: str
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    trace_id: Optional[str] = None
    timeout_ms: Optional[int] = None
    payload: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        d = {"type": self.type, "id": self.id, **self.payload}
        if self.trace_id:
            d["traceId"] = self.trace_id
        if self.timeout_ms:
            d["timeoutMs"] = self.timeout_ms
        d["protocolVersion"] = PROTOCOL_VERSION
        return d


@dataclass
class CommandResult:
    """Result of executing a command on the extension."""
    ok: bool
    data: dict[str, Any] = field(default_factory=dict)
    error: Optional[str] = None
    trace_id: Optional[str] = None
    duration_ms: Optional[int] = None

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "CommandResult":
        return cls(
            ok=bool(d.get("ok", False)),
            data={k: v for k, v in d.items() if k not in ("type", "id", "ok", "error", "traceId", "durationMs")},
            error=d.get("error"),
            trace_id=d.get("traceId"),
            duration_ms=d.get("durationMs"),
        )

    def get(self, key: str, default: Any = None) -> Any:
        return self.data.get(key, default)

    @property
    def status(self) -> Optional[int]:
        return self.data.get("status")

    @property
    def body(self) -> Optional[str]:
        return self.data.get("body")

    @property
    def headers(self) -> Optional[dict]:
        return self.data.get("headers")

    @property
    def final_url(self) -> Optional[str]:
        return self.data.get("finalUrl")

    def raise_for_error(self) -> None:
        """Raise an exception if the command failed."""
        if not self.ok:
            from .exceptions import BridgeCommandError
            raise BridgeCommandError(self.error or "Command failed", command_result=self)
