// extension/lib/connection.js
//
// Resilient connection to the bridge server.
//
// Built on the most mature pieces of the legacy notion/supabase extensions:
//   - WebSocket primary with 25s keepalive (MV3 SW dies after 30s idle)
//   - chrome.alarms watchdog — force-close WS after 90s of server silence
//   - chrome.idle browser-wake healing — reconnect with reset backoff on wake
//   - Exponential backoff with 60s cap: 1s, 2s, 4s, 8s, 16s, 32s, 60s, 60s, …
//   - HTTP SOS long-poll fallback — extension polls /api/poll when WS dies
//   - 3-retry exponential backoff (1s/2s/4s) on HTTP result POST
//   - Cross-channel pending-future correlation lives on the server side
//     (DO or aiohttp daemon) — this client just sends via whichever channel
//     is alive at the moment.
//
// All server URL handling is parameterized. No hardcoded worker URLs.
// The sandbox page reads its server URL from a ?server= query param.

import { MSG, PROTOCOL_VERSION, CONTEXT, buildCapabilities } from "./protocol.js";
import { info, warn, error } from "./logger.js";
import { setSender } from "./send.js";

const KEEPALIVE_INTERVAL_MS = 25_000;     // MV3 SW dies after 30s idle
const WATCHDOG_PERIOD_MIN = 1;            // chrome.alarms minimum granularity
const WATCHDOG_SILENCE_MS = 90_000;       // close WS if no server message for 90s
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;
const HTTP_POLL_WAIT_S = 25;              // long-poll wait seconds
const HTTP_RESULT_RETRIES = 3;
const HTTP_RESULT_BACKOFF_MS = [1_000, 2_000, 4_000];

const state = {
  context: CONTEXT.WORKER,
  status: "disconnected",   // disconnected | connecting | connected | connected-http | error
  serverUrl: "",            // raw URL as configured by user (http(s):// or ws(s)://)
  authToken: "",
  agentId: "",
  ws: null,
  reconnectAttempts: 0,
  httpPollActive: false,
  connectedAt: null,
  lastError: null,
  lastServerMsgAt: null,
  commandsReceived: 0,
  commandsCompleted: 0,
  commandsFailed: 0,
  onCommand: null,          // injected by background.js: (msg) => Promise<void>
  onStatusChange: null,     // injected: () => void
};

export function getConnectionState() {
  return {
    context: state.context,
    status: state.status,
    serverUrl: state.serverUrl,
    agentId: state.agentId,
    authToken: state.authToken ? "[set]" : "",
    connectedAt: state.connectedAt,
    lastError: state.lastError,
    lastServerMsgAt: state.lastServerMsgAt,
    commandsReceived: state.commandsReceived,
    commandsCompleted: state.commandsCompleted,
    commandsFailed: state.commandsFailed,
    reconnectAttempts: state.reconnectAttempts,
    wsAlive: !!(state.ws && state.ws.readyState === WebSocket.OPEN),
    httpPollActive: state.httpPollActive,
  };
}

export function initConnection({ agentId, onCommand, onStatusChange }) {
  state.agentId = agentId;
  state.onCommand = onCommand;
  state.onStatusChange = onStatusChange;
  // Wire send.js to use our internal _sendToServer so all outbound messages
  // (results, events, logs) flow through the active WS or HTTP fallback.
  setSender((msg) => _sendToServer(msg));
}

/**
 * Public raw send — exposed for modules that need to send messages without
 * going through the typed sendResult/sendError/sendEvent/sendLog helpers
 * in send.js. Used by background.js for one-off messages.
 */
export function sendRaw(msg) {
  _sendToServer(msg);
}

export async function connect(serverUrl, authToken = "") {
  if (!serverUrl) {
    error("connect-no-url", {});
    return;
  }
  state.serverUrl = serverUrl;
  state.authToken = authToken;
  state.status = "connecting";
  state.lastError = null;
  _broadcastStatus();

  const wsUrl = _buildWsUrl(serverUrl);
  info("ws-connecting", { wsUrl: _redact(wsUrl) });
  try {
    state.ws = new WebSocket(wsUrl);
  } catch (err) {
    error("ws-construct-failed", { error: String(err) });
    _scheduleReconnect();
    return;
  }

  state.ws.onopen = () => {
    state.status = "connected";
    state.connectedAt = Date.now();
    state.lastServerMsgAt = Date.now();
    state.reconnectAttempts = 0;
    state.httpPollActive = false;  // stop SOS polling if it was running
    info("ws-open", { agentId: state.agentId });

    // Send auth first, then connect with capabilities + protocol version
    _sendToServer({ type: MSG.AUTH, token: state.authToken });
    _sendToServer({
      type: MSG.CONNECT,
      agentId: state.agentId,
      protocolVersion: PROTOCOL_VERSION,
      capabilities: buildCapabilities(),
      context: state.context,
      userAgent: navigator.userAgent,
      hostname: "chrome-extension",
    });

    // Start keepalive — MV3 SW dies after 30s of WS inactivity
    _startKeepalive();
    _broadcastStatus();
  };

  state.ws.onmessage = (event) => {
    state.lastServerMsgAt = Date.now();
    let msg;
    try { msg = JSON.parse(event.data); }
    catch (err) {
      warn("ws-msg-parse-failed", { error: String(err), raw: event.data.slice(0, 200) });
      return;
    }
    _handleServerMessage(msg);
  };

  state.ws.onerror = (event) => {
    state.status = "error";
    state.lastError = "WebSocket error";
    warn("ws-error", {});
    _broadcastStatus();
  };

  state.ws.onclose = (event) => {
    info("ws-close", { code: event.code, reason: event.reason });
    _stopKeepalive();
    state.ws = null;

    if (event.code === 1000) {
      // Clean disconnect by user — do not reconnect
      state.status = "disconnected";
      state.lastError = null;
      _broadcastStatus();
      return;
    }

    // Abnormal close — start HTTP SOS immediately, schedule WS reconnect
    state.status = "connecting";
    _startHttpPolling();
    _scheduleReconnect();
    _broadcastStatus();
  };
}

export function disconnect() {
  _stopKeepalive();
  _stopHttpPolling();
  if (state.ws) {
    try { state.ws.close(1000, "user disconnect"); } catch {}
    state.ws = null;
  }
  state.status = "disconnected";
  state.reconnectAttempts = 0;
  _broadcastStatus();
  info("disconnect", {});
}

// ---------------------------------------------------------------------------
// URL handling
// ---------------------------------------------------------------------------

/**
 * Convert a user-provided URL into a WebSocket URL.
 *   - ws(s):// passthrough
 *   - http(s):// → ws(s)://
 *   - If host is not localhost and URL has no ?XTransformPort, append
 *     ?XTransformPort=8787 (Caddy preview gateway routing hint).
 *   - Force pathname = "/" (Caddy only upgrades WS at this path).
 */
function _buildWsUrl(serverUrl) {
  let url = serverUrl.trim();
  url = url.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");
  if (!/^wss?:\/\//i.test(url)) url = "ws://" + url;
  try {
    const parsed = new URL(url);
    const isLocal = ["localhost", "127.0.0.1", "0.0.0.0", "::1"].includes(parsed.hostname);
    if (!isLocal && !parsed.searchParams.has("XTransformPort")) {
      parsed.searchParams.set("XTransformPort", "8787");
    }
    parsed.pathname = "/";
    return parsed.toString();
  } catch {
    return url;
  }
}

function _httpBaseUrl() {
  let url = state.serverUrl.trim()
    .replace(/^ws:/i, "http:").replace(/^wss:/i, "https:");
  if (!/^https?:\/\//i.test(url)) url = "http://" + url;
  try {
    const parsed = new URL(url);
    // Strip /ws suffix if present (legacy convention)
    if (parsed.pathname.endsWith("/ws")) parsed.pathname = parsed.pathname.slice(0, -3);
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return url;
  }
}

function _redact(url) {
  // Strip query params from logs (may contain tokens)
  try { return new URL(url).origin + new URL(url).pathname; }
  catch { return url; }
}

// ---------------------------------------------------------------------------
// Keepalive + watchdog
// ---------------------------------------------------------------------------

let keepaliveTimer = null;

function _startKeepalive() {
  _stopKeepalive();
  keepaliveTimer = setInterval(() => {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      _sendToServer({ type: MSG.PONG, ts: Date.now() });
    }
  }, KEEPALIVE_INTERVAL_MS);
}

function _stopKeepalive() {
  if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
}

export function startWatchdog() {
  chrome.alarms.create("bridge-watchdog", { periodInMinutes: WATCHDOG_PERIOD_MIN });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== "bridge-watchdog") return;
    if (state.status === "connected" && state.lastServerMsgAt) {
      const silenceMs = Date.now() - state.lastServerMsgAt;
      if (silenceMs > WATCHDOG_SILENCE_MS) {
        warn("watchdog-timeout", { silenceMs });
        if (state.ws) {
          try { state.ws.close(4000, "watchdog: no server message in 90s"); } catch {}
        }
      }
    }
  });

  // Browser-wake healing: reset backoff and reconnect immediately on wake
  chrome.idle.onStateChanged.addListener((idleState) => {
    if (idleState === "active" && state.serverUrl) {
      info("idle-wake", { reconnectAttempts: state.reconnectAttempts });
      state.reconnectAttempts = 0;
      if (state.status !== "connected") {
        connect(state.serverUrl, state.authToken);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Reconnect with exponential backoff
// ---------------------------------------------------------------------------

let reconnectTimer = null;

function _scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  const attempt = state.reconnectAttempts + 1;
  state.reconnectAttempts = attempt;
  const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow(2, attempt - 1));
  info("reconnect-scheduled", { attempt, delayMs: delay });
  reconnectTimer = setTimeout(() => {
    if (state.serverUrl) connect(state.serverUrl, state.authToken);
  }, delay);
}

// ---------------------------------------------------------------------------
// HTTP SOS fallback (long-poll)
// ---------------------------------------------------------------------------

async function _startHttpPolling() {
  if (state.httpPollActive) return;
  state.httpPollActive = true;
  state.status = "connected-http";
  _broadcastStatus();

  while (state.httpPollActive) {
    try {
      const url = `${_httpBaseUrl()}/api/poll?agentId=${encodeURIComponent(state.agentId)}&wait=${HTTP_POLL_WAIT_S}`;
      const res = await fetch(url, { signal: AbortSignal.timeout((HTTP_POLL_WAIT_S + 10) * 1000) });
      if (!res.ok) {
        warn("http-poll-non-ok", { status: res.status });
        await _sleep(2000);
        continue;
      }
      const body = await res.json();
      const commands = body.commands ?? [];
      if (commands.length > 0) {
        state.lastServerMsgAt = Date.now();
        info("http-poll-received", { count: commands.length });
      }
      for (const cmd of commands) {
        state.commandsReceived++;
        try { await state.onCommand(cmd); }
        catch (err) { error("http-poll-cmd-error", { id: cmd.id, error: String(err) }); }
      }
    } catch (err) {
      if (err.name === "TimeoutError") {
        // normal — long-poll timed out, just continue
      } else {
        warn("http-poll-error", { error: String(err) });
        await _sleep(2000);
      }
    }
  }
  info("http-poll-stopped", {});
}

function _stopHttpPolling() {
  state.httpPollActive = false;
}

// ---------------------------------------------------------------------------
// Outbound send — WS if open, HTTP POST with retries otherwise
// ---------------------------------------------------------------------------

function _sendToServer(msg) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    try {
      state.ws.send(JSON.stringify(msg));
      return;
    } catch (err) {
      warn("ws-send-failed", { error: String(err) });
    }
  }
  // WS dead — fall through to HTTP POST (only for RESULT/LOG/EVENT)
  if (msg.type === MSG.RESULT || msg.type === MSG.LOG || msg.type === MSG.EVENT) {
    _sendViaHttp(msg);
  } else {
    warn("send-dropped-no-ws", { msgType: msg.type, id: msg.id });
  }
}

async function _sendViaHttp(msg) {
  const url = `${_httpBaseUrl()}/api/result`;
  let lastErr = null;
  for (let attempt = 0; attempt < HTTP_RESULT_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(msg),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return;
      lastErr = `HTTP ${res.status}`;
    } catch (err) {
      lastErr = String(err);
    }
    if (attempt < HTTP_RESULT_RETRIES - 1) {
      await _sleep(HTTP_RESULT_BACKOFF_MS[attempt]);
    }
  }
  warn("http-result-send-failed", { id: msg.id, error: lastErr });
}

// ---------------------------------------------------------------------------
// Inbound message dispatch
// ---------------------------------------------------------------------------

function _handleServerMessage(msg) {
  if (!msg || typeof msg.type !== "string") {
    warn("server-msg-invalid", { msg });
    return;
  }

  switch (msg.type) {
    case MSG.AUTH_OK:
      info("auth-ok", {});
      break;

    case "ping":
      _sendToServer({ type: MSG.PONG, ts: Date.now() });
      break;

    default:
      // Treat as a command — dispatch to background.js handler
      state.commandsReceived++;
      state.onCommand(msg).catch((err) => {
        error("command-dispatch-error", { id: msg.id, type: msg.type, error: String(err) });
      });
  }
}

// ---------------------------------------------------------------------------
// Status broadcast (to popup)
// ---------------------------------------------------------------------------

function _broadcastStatus() {
  if (state.onStatusChange) state.onStatusChange();
  try {
    chrome.runtime.sendMessage({ type: MSG.STATUS, status: getConnectionState() });
  } catch {}
}

function _sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
