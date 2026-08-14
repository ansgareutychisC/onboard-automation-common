// extension/lib/logger.js
//
// Structured logger. Every log entry has:
//   { ts, level, message, data?, commandId?, tabId?, durationMs?, agentId?, traceId? }
//
// Triple-sink:
//   1. console.log/warn/error (always)
//   2. in-memory ring buffer (MAX_LOG entries, popped to popup on demand)
//   3. best-effort WS broadcast to server via send.js (non-blocking)
//
// The popup renders logs as a table (with commandId / tabId / durationMs
// columns when present), not as free-text. This is a deliberate upgrade
// from the legacy notion/supabase extensions which only had free-text logs.

import { LOG_LEVEL } from "./protocol.js";
import { sendLog } from "./send.js";

const MAX_LOG = 500;

const state = {
  agentId: null,
  entries: [],
  popupSink: null,  // (msg) => void  — set by background.js
};

export function initLogger({ agentId, popupSink }) {
  state.agentId = agentId;
  state.popupSink = popupSink;
}

export function getEntries(limit = MAX_LOG) {
  return state.entries.slice(-limit);
}

export function clearEntries() {
  state.entries.length = 0;
  info("log-cleared", {});
}

export function log(level, message, data = {}, ctx = {}) {
  const entry = {
    ts: Date.now(),
    level,
    message,
    data,
    agentId: state.agentId,
    commandId: ctx.commandId ?? null,
    tabId: ctx.tabId ?? null,
    durationMs: ctx.durationMs ?? null,
    traceId: ctx.traceId ?? null,
  };

  // 1. ring buffer
  state.entries.push(entry);
  if (state.entries.length > MAX_LOG) state.entries.shift();

  // 2. console
  const consoleMsg = `[${entry.ts}] ${level.toUpperCase()} ${message}`;
  if (level === LOG_LEVEL.ERROR) console.error(consoleMsg, data);
  else if (level === LOG_LEVEL.WARN) console.warn(consoleMsg, data);
  else if (level === LOG_LEVEL.DEBUG) console.debug(consoleMsg, data);
  else console.log(consoleMsg, data);

  // 3. server (best-effort, non-blocking — send.js handles WS-or-HTTP routing)
  sendLog(entry);

  // 4. popup (best-effort)
  if (state.popupSink) {
    try { state.popupSink({ type: "log", entry }); } catch {}
  }
}

export const debug = (m, d = {}, c = {}) => log(LOG_LEVEL.DEBUG, m, d, c);
export const info = (m, d = {}, c = {}) => log(LOG_LEVEL.INFO, m, d, c);
export const warn = (m, d = {}, c = {}) => log(LOG_LEVEL.WARN, m, d, c);
export const error = (m, d = {}, c = {}) => log(LOG_LEVEL.ERROR, m, d, c);

/**
 * Wraps an async handler with structured start/done/error logging.
 * Returns a function that, when called, logs "command-received" then awaits
 * the handler. On success logs "{type}-done" with durationMs; on failure
 * logs "{type}-error" with the error message.
 */
export function withCommandLogging(commandType, handler) {
  return async (msg, ctx) => {
    const startedAt = Date.now();
    const logCtx = { commandId: msg.id, traceId: msg.traceId, tabId: msg.tabId ?? null };
    info("command-received", { type: commandType, id: msg.id, traceId: msg.traceId }, logCtx);
    try {
      const result = await handler(msg, ctx);
      const durationMs = Date.now() - startedAt;
      info(`${commandType}-done`, { durationMs, ok: result?.ok ?? true }, { ...logCtx, durationMs });
      return result;
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      error(`${commandType}-error`, { error: String(err?.message ?? err), stack: err?.stack }, { ...logCtx, durationMs });
      throw err;
    }
  };
}
