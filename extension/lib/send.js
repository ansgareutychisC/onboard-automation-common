// extension/lib/send.js
//
// Helpers for sending results, errors, events, and logs back to the server.
// Routes through the active connection (WS if open, HTTP fallback queue
// if not). Both paths share the same envelope shape so the server's
// pending-future correlation works cross-channel.
//
// IMPORTANT: this module has NO dependencies on logger.js (avoids circular
// import). Errors here are reported via console.error only.

import { MSG } from "./protocol.js";

let sendFn = null;  // injected by connection.js on connect

export function setSender(fn) {
  sendFn = fn;
}

export function _send(msg) {
  if (!sendFn) {
    console.error("[send] sendFn not set, dropping", msg.type, msg.id);
    return;
  }
  try {
    sendFn(msg);
  } catch (err) {
    console.error("[send] send failed", err, msg.type, msg.id);
  }
}

/**
 * Send a successful command result.
 * @param {string} id — command id (echoed from the command)
 * @param {object} payload — result fields (e.g. { status, body, headers, finalUrl })
 * @param {object} ctx — { commandId, traceId, durationMs } for correlation
 */
export function sendResult(id, payload, ctx = {}) {
  _send({
    type: MSG.RESULT,
    id,
    ok: true,
    traceId: ctx.traceId ?? null,
    durationMs: ctx.durationMs ?? null,
    ...payload,
  });
}

/**
 * Send a failure result for a command.
 */
export function sendError(id, errorMessage, extra = {}, ctx = {}) {
  _send({
    type: MSG.RESULT,
    id,
    ok: false,
    error: errorMessage,
    traceId: ctx.traceId ?? null,
    durationMs: ctx.durationMs ?? null,
    ...extra,
  });
}

/**
 * Send an async event from an activatable debug stream (e.g. a captured
 * console.log line, a network event, a trace event). These are NOT command
 * results — they are unsolicited and use MSG.EVENT. The server can choose
 * to fan them out to subscribers (e.g. a live dashboard).
 */
export function sendEvent(event, data, ctx = {}) {
  _send({
    type: MSG.EVENT,
    event,
    tabId: ctx.tabId ?? null,
    sessionId: ctx.sessionId ?? null,
    traceId: ctx.traceId ?? null,
    ts: Date.now(),
    data,
  });
}

/**
 * Send a structured log entry to the server (best-effort, non-blocking).
 * Silently skips if no sender is wired up yet (early during SW startup
 * before initConnection is called). The entry still goes to console + the
 * in-memory ring buffer regardless.
 */
export function sendLog(entry) {
  if (!sendFn) return;  // expected during early startup — not an error
  _send({ type: MSG.LOG, ...entry });
}
