// extension/lib/protocol.js
//
// Single source of truth for the bridge wire protocol.
// Loaded as an ES module by background.js, popup.js, sandbox.js.
// Mirrored by worker-template/src/types.ts and python-template/onboard_common/protocol.py.
//
// Protocol version is bumped on any breaking change to command shapes or
// message envelopes. The extension advertises its version in the `connect`
// message; the server MUST refuse mismatched versions with a clear error.

export const PROTOCOL_VERSION = "1.0";

// ---------------------------------------------------------------------------
// Server -> Extension messages
// ---------------------------------------------------------------------------

export const CMD = Object.freeze({
  // Heartbeat
  PING: "ping",

  // Fetch family — execute fetch() in different contexts
  FETCH: "fetch",              // service-worker context (handles zstd via DecompressionStream)
  PAGE_FETCH: "page.fetch",    // page main-world context (native zstd, required for Chrome 151+)

  // Tab family
  TABS_OPEN: "tabs.open",
  TABS_CLOSE: "tabs.close",
  TABS_LIST: "tabs.list",
  TABS_FOCUS: "tabs.focus",

  // Form family — DOM interaction in a tab
  FORM_FILL: "form.fill",      // React-safe input value setter
  FORM_CLICK: "form.click",
  FORM_WAIT: "form.wait",      // poll for selector to appear
  FORM_EVAL: "form.eval",      // CDP Runtime.evaluate in page main world (bypasses CSP)

  // Network capture
  XHR_INTERCEPT: "xhr.intercept",  // one-shot capture of a single matching request

  // Cookies
  COOKIES_GET: "cookies.get",
  COOKIES_GET_ALL: "cookies.getAll",
  COOKIES_SET: "cookies.set",

  // Visual capture
  SCREENSHOT: "screenshot",          // visible tab (tabId-aware, fixes legacy bug)

  // Captcha — multi-provider
  CAPTCHA_GET_TOKEN: "captcha.getToken",  // args.provider: hcaptcha|recaptcha|turnstile|cloudflare

  // Sandbox
  SANDBOX_OPEN: "sandbox.open",
  SANDBOX_FETCH: "sandbox.fetch",    // routed to sandbox page (page-context fetch, zstd-native)

  // Activatable debugging (toggle on/off per tab)
  DEBUG_HAR_START: "debug.har.start",
  DEBUG_HAR_STOP: "debug.har.stop",
  DEBUG_CONSOLE_START: "debug.console.start",
  DEBUG_CONSOLE_STOP: "debug.console.stop",
  DEBUG_NETWORK_START: "debug.network.start",
  DEBUG_NETWORK_STOP: "debug.network.stop",
  DEBUG_TRACE_START: "debug.trace.start",
  DEBUG_TRACE_STOP: "debug.trace.stop",
  DEBUG_DOM_SNAPSHOT: "debug.dom.snapshot",
  DEBUG_STORAGE_DUMP: "debug.storage.dump",
  DEBUG_SCREENSHOT_FULL: "debug.screenshot.fullpage",
});

// All known command types — used for capability advertisement.
export const ALL_COMMAND_TYPES = Object.freeze(Object.values(CMD));

// ---------------------------------------------------------------------------
// Extension -> Server messages
// ---------------------------------------------------------------------------

export const MSG = Object.freeze({
  AUTH: "auth",          // {type, token} — sent immediately on WS open
  CONNECT: "connect",    // {type, agentId, protocolVersion, capabilities, context, userAgent, hostname}
  AUTH_OK: "auth-ok",    // server -> ext only
  RESULT: "result",      // {type, id, ok, ...payload} — synchronous command result
  LOG: "log",            // {type, level, message, data, commandId?, tabId?, durationMs?}
  PONG: "pong",          // {type, ts} — keepalive reply (also used as unsolicited keepalive)
  EVENT: "event",        // {type, event, tabId, data} — async event from activatable debug streams
  STATUS: "status",      // {type, status} — periodic status broadcast (popup consumes)
});

// ---------------------------------------------------------------------------
// Log levels
// ---------------------------------------------------------------------------

export const LOG_LEVEL = Object.freeze({
  DEBUG: "debug",
  INFO: "info",
  WARN: "warn",
  ERROR: "error",
});

// ---------------------------------------------------------------------------
// Connection contexts — extension vs sandbox page
// ---------------------------------------------------------------------------

export const CONTEXT = Object.freeze({
  WORKER: "worker",   // background service worker (default)
  PAGE: "page",       // sandbox.html — page-context for zstd-native fetch
});

// ---------------------------------------------------------------------------
// Capability advertisement
//
// The extension sends this list in the `connect` message so the server can
// probe before sending commands that require optional permissions (e.g.
// `debugger` for CDP-based commands). Future extensions can advertise
// additional capabilities without changing the protocol.
// ---------------------------------------------------------------------------

export function buildCapabilities() {
  return ALL_COMMAND_TYPES.filter((t) => t !== "ping");
}

// ---------------------------------------------------------------------------
// Command envelope validation
//
// Every command from the server MUST have:
//   - type: string, one of CMD.*
//   - id:   string, server-generated correlation ID
// Optional fields:
//   - protocolVersion: string (defaults to "1.0" if absent for back-compat)
//   - traceId: string, server-generated end-to-end trace ID (flows to logs/results)
//   - timeoutMs: number, per-command timeout
// ---------------------------------------------------------------------------

export function validateCommand(msg) {
  if (!msg || typeof msg !== "object") return "command is not an object";
  if (typeof msg.type !== "string") return "command.type is not a string";
  if (!ALL_COMMAND_TYPES.includes(msg.type)) return `unknown command type: ${msg.type}`;
  if (typeof msg.id !== "string" || msg.id.length === 0) return "command.id is missing or empty";
  return null;
}

// ---------------------------------------------------------------------------
// Default timeouts (ms) — per command type
// ---------------------------------------------------------------------------

export const DEFAULT_TIMEOUT_MS = Object.freeze({
  [CMD.FETCH]: 30_000,
  [CMD.PAGE_FETCH]: 30_000,
  [CMD.TABS_OPEN]: 60_000,
  [CMD.TABS_CLOSE]: 5_000,
  [CMD.TABS_LIST]: 5_000,
  [CMD.TABS_FOCUS]: 5_000,
  [CMD.FORM_FILL]: 10_000,
  [CMD.FORM_CLICK]: 10_000,
  [CMD.FORM_WAIT]: 30_000,
  [CMD.FORM_EVAL]: 30_000,
  [CMD.XHR_INTERCEPT]: 30_000,
  [CMD.COOKIES_GET]: 5_000,
  [CMD.COOKIES_GET_ALL]: 5_000,
  [CMD.COOKIES_SET]: 5_000,
  [CMD.SCREENSHOT]: 10_000,
  [CMD.CAPTCHA_GET_TOKEN]: 15_000,
  [CMD.SANDBOX_OPEN]: 5_000,
  [CMD.SANDBOX_FETCH]: 120_000,
  [CMD.DEBUG_HAR_START]: 5_000,
  [CMD.DEBUG_HAR_STOP]: 10_000,
  [CMD.DEBUG_CONSOLE_START]: 5_000,
  [CMD.DEBUG_CONSOLE_STOP]: 10_000,
  [CMD.DEBUG_NETWORK_START]: 5_000,
  [CMD.DEBUG_NETWORK_STOP]: 10_000,
  [CMD.DEBUG_TRACE_START]: 5_000,
  [CMD.DEBUG_TRACE_STOP]: 30_000,
  [CMD.DEBUG_DOM_SNAPSHOT]: 15_000,
  [CMD.DEBUG_STORAGE_DUMP]: 10_000,
  [CMD.DEBUG_SCREENSHOT_FULL]: 15_000,
});

export function timeoutFor(msg) {
  if (typeof msg.timeoutMs === "number" && msg.timeoutMs > 0) return msg.timeoutMs;
  return DEFAULT_TIMEOUT_MS[msg.type] ?? 30_000;
}
