// extension/background.js
//
// Service worker. Loads all handler modules, registers them in a dispatcher,
// and wires the connection module to the dispatcher.
//
// The background.js is intentionally THIN — all logic lives in lib/ and
// handlers/. This makes it easy to test individual handlers in isolation
// and to add new handlers without touching the orchestrator.

import { CMD, validateCommand, timeoutFor } from "./lib/protocol.js";
import { initLogger, info, warn, error, getEntries, clearEntries, withCommandLogging } from "./lib/logger.js";
import { initConnection, connect, disconnect, getConnectionState, startWatchdog } from "./lib/connection.js";
import { sendError } from "./lib/send.js";

const AGENT_ID_KEY = "agentId";
const CONFIG_KEYS = ["serverUrl", "autoConnect", "authToken"];

// ---------------------------------------------------------------------------
// Persistent agent ID — survives MV3 service worker restarts
// ---------------------------------------------------------------------------

let agentId = "";
try {
  const stored = await chrome.storage.local.get(AGENT_ID_KEY);
  if (stored[AGENT_ID_KEY]) {
    agentId = stored[AGENT_ID_KEY];
  } else {
    agentId = "ext-" + Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 4);
    await chrome.storage.local.set({ [AGENT_ID_KEY]: agentId });
  }
} catch (err) {
  agentId = "ext-fallback" + Math.random().toString(36).slice(2, 8);
}

// ---------------------------------------------------------------------------
// Logger initialization — popup sink only.
// Server sink is handled by send.js (sendLog), which is wired up by
// connection.js when initConnection() is called below.
// ---------------------------------------------------------------------------

initLogger({
  agentId,
  popupSink: (msg) => {
    try { chrome.runtime.sendMessage(msg); } catch {}
  },
});

// ---------------------------------------------------------------------------
// Command dispatcher — register all handlers
// ---------------------------------------------------------------------------

const dispatcher = {};

async function loadHandlers() {
  const modules = [
    "./handlers/fetch.js",
    "./handlers/tabs.js",
    "./handlers/form.js",
    "./handlers/xhr.js",
    "./handlers/cookies.js",
    "./handlers/screenshot.js",
    "./handlers/captcha.js",
    "./handlers/sandbox.js",
    "./handlers/debug.js",
  ];
  for (const path of modules) {
    try {
      const mod = await import(path);
      // Each handler module exports a registerXxxHandlers(dispatcher) function
      const registerFn = Object.values(mod).find(
        (v) => typeof v === "function" && v.name.startsWith("register")
      );
      if (registerFn) {
        registerFn(dispatcher);
      } else {
        warn("handler-module-no-register", { path });
      }
    } catch (err) {
      error("handler-load-failed", { path, error: String(err) });
    }
  }
  info("handlers-loaded", { count: Object.keys(dispatcher).length });
}

await loadHandlers();

// ---------------------------------------------------------------------------
// Command entry point — called by connection.js when a command arrives
// ---------------------------------------------------------------------------

async function handleCommand(msg) {
  const validationError = validateCommand(msg);
  if (validationError) {
    warn("invalid-command", { error: validationError });
    if (msg?.id) {
      sendError(msg.id, `Invalid command: ${validationError}`, {}, { traceId: msg.traceId });
    }
    return;
  }

  if (msg.type === CMD.PING) return;  // ping is handled inline by connection.js

  const handler = dispatcher[msg.type];
  if (!handler) {
    sendError(msg.id, `No handler registered for command type: ${msg.type}`, {}, { traceId: msg.traceId });
    return;
  }

  const ctx = { commandId: msg.id, traceId: msg.traceId, tabId: msg.tabId ?? null };
  const timeout = timeoutFor(msg);
  const wrapped = withCommandLogging(msg.type, handler);

  try {
    await Promise.race([
      wrapped(msg, ctx),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Command ${msg.type} timed out after ${timeout}ms`)), timeout)
      ),
    ]);
  } catch (err) {
    sendError(msg.id, err.message ?? String(err), { timeoutMs: timeout }, { ...ctx, durationMs: timeout });
  }
}

// ---------------------------------------------------------------------------
// Connection initialization
// ---------------------------------------------------------------------------

initConnection({
  agentId,
  onCommand: handleCommand,
  onStatusChange: () => {/* status broadcast is internal to connection.js */},
});

startWatchdog();

// ---------------------------------------------------------------------------
// Config + auto-connect
// ---------------------------------------------------------------------------

async function loadConfig() {
  try {
    const cfg = await chrome.storage.local.get(CONFIG_KEYS);
    return {
      serverUrl: cfg.serverUrl || "",
      autoConnect: cfg.autoConnect !== false,  // default true
      authToken: cfg.authToken || "",
    };
  } catch {
    return { serverUrl: "", autoConnect: false, authToken: "" };
  }
}

async function saveConfig(partial) {
  await chrome.storage.local.set(partial);
}

const initialConfig = await loadConfig();
info("initial-config", {
  serverUrl: initialConfig.serverUrl ? "[set]" : "[empty]",
  autoConnect: initialConfig.autoConnect,
});

if (initialConfig.autoConnect && initialConfig.serverUrl) {
  connect(initialConfig.serverUrl, initialConfig.authToken);
}

// ---------------------------------------------------------------------------
// Popup message handler
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return;

  switch (msg.type) {
    case "connect":
      saveConfig({ serverUrl: msg.serverUrl, authToken: msg.authToken || "", autoConnect: true });
      connect(msg.serverUrl, msg.authToken || "").then(() => sendResponse({ ok: true }));
      return true;

    case "disconnect":
      disconnect();
      sendResponse({ ok: true });
      return false;

    case "getStatus":
      sendResponse({
        status: getConnectionState(),
        logEntries: getEntries(50),
        agentId,
      });
      return false;

    case "clearLog":
      clearEntries();
      sendResponse({ ok: true });
      return false;

    case "getConfig":
      loadConfig().then((cfg) => sendResponse(cfg));
      return true;

    default:
      return false;
  }
});

// Auto-connect on SW startup / browser startup (covers MV3 lifecycle gaps)
chrome.runtime.onStartup.addListener(async () => {
  const cfg = await loadConfig();
  if (cfg.autoConnect && cfg.serverUrl) connect(cfg.serverUrl, cfg.authToken);
});

chrome.runtime.onInstalled.addListener(async () => {
  const cfg = await loadConfig();
  if (cfg.autoConnect && cfg.serverUrl) connect(cfg.serverUrl, cfg.authToken);
});

info("background-ready", { agentId, handlerCount: Object.keys(dispatcher).length });
