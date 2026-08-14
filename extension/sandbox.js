// extension/sandbox.js
//
// Standalone page that runs in a full Chrome tab (not the service worker).
// Connects to the same bridge server as background.js but identifies itself
// with context:"page" so the server can route sandbox.fetch commands here
// (NOT to the background SW).
//
// Why this exists: Chrome's MV3 service worker fetch().text() cannot reliably
// decompress zstd responses (broken in Chrome 151+). The page-context fetch
// pipeline handles zstd natively via Chrome's network stack.
//
// Server URL is read from ?server= query param (passed by sandbox.open
// handler). If absent, falls back to chrome.storage.local["serverUrl"].

import { MSG, PROTOCOL_VERSION, CONTEXT, buildCapabilities } from "./lib/protocol.js";

const KEEPALIVE_INTERVAL_MS = 25_000;
const RECONNECT_DELAY_MS = 5_000;

const stats = { fetched: 0, bytes: 0, errors: 0 };
const logEntries = [];
let ws = null;
let reconnectTimer = null;
let keepaliveTimer = null;
let agentId = "sandbox-page";

function log(level, message, data = {}) {
  const entry = { ts: Date.now(), level, message, data, agentId };
  logEntries.push(entry);
  if (logEntries.length > 100) logEntries.shift();
  render();
  // Also send to server (best-effort)
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify({ type: MSG.LOG, ...entry })); } catch {}
  }
}

function getServerUrl() {
  // 1. ?server= query param (set by sandbox.open handler)
  const params = new URLSearchParams(location.search);
  const fromParam = params.get("server");
  if (fromParam) return fromParam;

  // 2. Fall back to chrome.storage.local["serverUrl"] (same as background SW)
  return new Promise((resolve) => {
    chrome.storage.local.get("serverUrl", (cfg) => {
      resolve(cfg.serverUrl || "");
    });
  });
}

function buildWsUrl(serverUrl) {
  let url = serverUrl.trim()
    .replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");
  if (!/^wss?:\/\//i.test(url)) url = "ws://" + url;
  try {
    const parsed = new URL(url);
    const isLocal = ["localhost", "127.0.0.1", "0.0.0.0", "::1"].includes(parsed.hostname);
    if (!isLocal && !parsed.searchParams.has("XTransformPort")) {
      parsed.searchParams.set("XTransformPort", "8787");
    }
    parsed.pathname = "/";
    return parsed.toString();
  } catch { return url; }
}

async function connect() {
  const serverUrl = await getServerUrl();
  if (!serverUrl) {
    log("error", "no-server-url", { hint: "Open via sandbox.open command or set serverUrl in popup" });
    return;
  }

  const wsUrl = buildWsUrl(serverUrl);
  log("info", "connecting", { wsUrl });
  setStatus("connecting");

  try {
    ws = new WebSocket(wsUrl);
  } catch (err) {
    log("error", "ws-construct-failed", { error: String(err) });
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    setStatus("connected");
    log("info", "ws-open", {});
    // Identify as sandbox page — context:"page" tells the server to route
    // sandbox.fetch commands here, NOT to the background SW.
    ws.send(JSON.stringify({ type: MSG.AUTH, token: "" }));
    ws.send(JSON.stringify({
      type: MSG.CONNECT,
      agentId,
      protocolVersion: PROTOCOL_VERSION,
      capabilities: ["sandbox.fetch", "ping"],
      context: CONTEXT.PAGE,
      userAgent: navigator.userAgent,
      hostname: "sandbox-page",
    }));
    keepaliveTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: MSG.PONG, ts: Date.now() }));
      }
    }, KEEPALIVE_INTERVAL_MS);
  };

  ws.onmessage = async (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    if (msg.type === "ping") {
      ws.send(JSON.stringify({ type: MSG.PONG, ts: Date.now() }));
      return;
    }

    if (msg.type === "sandbox.fetch") {
      await handleSandboxFetch(msg);
    }
  };

  ws.onerror = () => {
    log("warn", "ws-error", {});
  };

  ws.onclose = (event) => {
    log("info", "ws-close", { code: event.code });
    if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
    ws = null;
    setStatus("disconnected");
    if (event.code !== 1000) scheduleReconnect();
  };
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => connect(), RECONNECT_DELAY_MS);
}

async function handleSandboxFetch(msg) {
  const { id, url, method = "GET", headers = {}, body = null, credentials = "include", timeoutMs = 120_000 } = msg;
  const startedAt = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const opts = { method, headers, credentials, signal: controller.signal };
    if (body && !["GET", "HEAD"].includes(method.toUpperCase())) opts.body = body;
    const res = await fetch(url, opts);
    const text = await res.text();
    clearTimeout(timer);

    const respHeaders = {};
    res.headers.forEach((v, k) => { respHeaders[k] = v; });

    stats.fetched++;
    stats.bytes += text.length;
    render();

    log("info", "fetch-done", { url, status: res.status, bodyLen: text.length, encoding: respHeaders["content-encoding"] || "" });

    const result = {
      type: MSG.RESULT, id, ok: true,
      status: res.status,
      statusText: res.statusText,
      body: text,
      headers: respHeaders,
      finalUrl: res.url,
      contentEncoding: respHeaders["content-encoding"] || "",
      bodyLen: text.length,
      durationMs: Date.now() - startedAt,
    };
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(result));
    }
  } catch (err) {
    stats.errors++;
    render();
    log("error", "fetch-failed", { id, url, error: String(err) });
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: MSG.RESULT, id, ok: false,
        error: `sandbox.fetch failed: ${err.message ?? err}`,
        durationMs: Date.now() - startedAt,
      }));
    }
  }
}

function setStatus(s) {
  document.getElementById("status").textContent = s;
  const dot = document.getElementById("dot");
  dot.className = "dot " + s;
}

function render() {
  document.getElementById("fetched").textContent = stats.fetched;
  document.getElementById("bytes").textContent = stats.bytes;
  document.getElementById("errors").textContent = stats.errors;
  const logEl = document.getElementById("log");
  logEl.innerHTML = "";
  for (const e of logEntries.slice(-50)) {
    const div = document.createElement("div");
    div.className = "log-entry " + (e.level || "info");
    const ts = new Date(e.ts).toLocaleTimeString("en-US", { hour12: false });
    div.textContent = `${ts} ${e.level.toUpperCase()} ${e.message}` + (e.data && Object.keys(e.data).length ? " " + JSON.stringify(e.data) : "");
    logEl.appendChild(div);
  }
  logEl.scrollTop = logEl.scrollHeight;
}

connect();
