// extension/handlers/debug.js
//
// Activatable debugging commands. Each command is a toggle (start/stop) or
// one-shot capture. All use chrome.debugger (CDP) — the same permission
// already used by form.eval and xhr.intercept, so no new permissions needed.
//
// Design principles:
//   1. Sessions are per-tab, keyed by a server-generated sessionId.
//   2. Each session attaches chrome.debugger ONCE on start and detaches on
//      stop. Multiple concurrent sessions on the same tab share the debugger
//      attachment via a refcount.
//   3. Captured events are streamed back as MSG.EVENT messages (not
//      MSG.RESULT) — the start command returns a result immediately with
//      { sessionId }, then events flow until stop is called.
//   4. The stop command returns the full captured buffer as its result
//      (for HAR/trace/network/console — the streaming events are also sent
//      live, but the stop result is the canonical "complete" payload).
//
// Available commands:
//   debug.har.start / stop         — capture network as a HAR 1.2 JSON blob
//   debug.console.start / stop     — mirror page console.* as events
//   debug.network.start / stop     — continuous network capture (vs xhr.intercept one-shot)
//   debug.trace.start / stop       — CDP Tracing (performance.timeline events)
//   debug.dom.snapshot             — one-shot DOM tree as HTML
//   debug.storage.dump             — localStorage + sessionStorage + cookies for tab
//   debug.screenshot.fullpage      — full-page screenshot (not just visible viewport)

import { CMD } from "../lib/protocol.js";
import { sendResult, sendError } from "../lib/send.js";
import { sendEvent } from "../lib/send.js";
import { info, warn, error } from "../lib/logger.js";

// ---------------------------------------------------------------------------
// Debugger attachment refcount (per tab)
// ---------------------------------------------------------------------------

const _attachRefcount = new Map();  // tabId -> count
const _sessions = new Map();         // sessionId -> { tabId, kind, startedAt, buffer, listener }

async function _ensureAttached(tabId) {
  const count = _attachRefcount.get(tabId) || 0;
  if (count === 0) {
    try {
      await chrome.debugger.attach({ tabId }, "1.3");
    } catch (err) {
      if (!String(err?.message).includes("Another debugger")) throw err;
    }
  }
  _attachRefcount.set(tabId, count + 1);
}

async function _maybeDetach(tabId) {
  const count = _attachRefcount.get(tabId) || 0;
  if (count <= 1) {
    _attachRefcount.delete(tabId);
    try { await chrome.debugger.detach({ tabId }); } catch {}
  } else {
    _attachRefcount.set(tabId, count - 1);
  }
}

// ---------------------------------------------------------------------------
// debug.har.start / stop
// ---------------------------------------------------------------------------

export async function handleDebugHarStart(msg, ctx) {
  const { tabId } = msg;
  if (!tabId) { sendError(msg.id, "debug.har.start requires tabId", {}, ctx); return; }
  const sessionId = `har_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const session = { tabId, kind: "har", startedAt: Date.now(), buffer: { log: { version: "1.2", creator: { name: "onboard-automation-bridge", version: "1.0" }, entries: [] } }, listener: null };
  _sessions.set(sessionId, session);

  try {
    await _ensureAttached(tabId);
    await chrome.debugger.sendCommand({ tabId }, "Network.enable");

    const listener = async (source, method, params) => {
      if (source?.tabId !== tabId) return;
      if (method === "Network.requestWillBeSent") {
        const entry = {
          startedDateTime: new Date(params.timestamp * 1000).toISOString(),
          time: 0,
          request: {
            method: params.request.method,
            url: params.request.url,
            httpVersion: "HTTP/1.1",
            headers: params.request.headers,
            queryString: [],
            cookies: [],
            headersSize: -1,
            bodySize: params.request.postData?.length || 0,
            postData: params.request.postData || undefined,
          },
          response: { status: 0, statusText: "", httpVersion: "HTTP/1.1", headers: {}, cookies: [], content: { size: 0, mimeType: "" }, redirectURL: "", headersSize: -1, bodySize: -1 },
          cache: {},
          timings: { send: 0, wait: 0, receive: 0 },
          _requestId: params.requestId,
          _timestamp: params.timestamp,
        };
        session.buffer.log.entries.push(entry);
        sendEvent("har.request", { url: params.request.url, method: params.request.method }, { tabId, sessionId, traceId: ctx.traceId });
      }
      if (method === "Network.responseReceived") {
        const entry = session.buffer.log.entries.find((e) => e._requestId === params.requestId);
        if (entry) {
          entry.response.status = params.response.status;
          entry.response.statusText = params.response.statusText;
          entry.response.headers = params.response.headers;
          entry.response.content.mimeType = params.response.mimeType;
        }
      }
      if (method === "Network.loadingFinished" && params.requestId) {
        const entry = session.buffer.log.entries.find((e) => e._requestId === params.requestId);
        if (entry) {
          try {
            const bodyRes = await chrome.debugger.sendCommand({ tabId }, "Network.getResponseBody", { requestId: params.requestId });
            entry.response.content.text = bodyRes?.body || "";
            entry.response.content.size = bodyRes?.body?.length || 0;
          } catch {}
        }
      }
    };
    chrome.debugger.onEvent.addListener(listener);
    session.listener = listener;

    sendResult(msg.id, { sessionId, startedAt: session.startedAt }, ctx);
    info("har-start", { sessionId, tabId });
  } catch (err) {
    _sessions.delete(sessionId);
    sendError(msg.id, `debug.har.start failed: ${err.message ?? err}`, {}, ctx);
  }
}

export async function handleDebugHarStop(msg, ctx) {
  const { sessionId } = msg;
  const session = _sessions.get(sessionId);
  if (!session) { sendError(msg.id, `debug.har.stop: unknown sessionId ${sessionId}`, {}, ctx); return; }
  if (session.kind !== "har") { sendError(msg.id, `debug.har.stop: session ${sessionId} is not a har session`, {}, ctx); return; }

  try {
    if (session.listener) chrome.debugger.onEvent.removeListener(session.listener);
    await chrome.debugger.sendCommand({ tabId: session.tabId }, "Network.disable");
    await _maybeDetach(session.tabId);
    const durationMs = Date.now() - session.startedAt;
    sendResult(msg.id, { har: session.buffer, entryCount: session.buffer.log.entries.length, durationMs }, { ...ctx, durationMs });
    info("har-stop", { sessionId, entryCount: session.buffer.log.entries.length, durationMs });
    _sessions.delete(sessionId);
  } catch (err) {
    sendError(msg.id, `debug.har.stop failed: ${err.message ?? err}`, {}, ctx);
  }
}

// ---------------------------------------------------------------------------
// debug.console.start / stop
// ---------------------------------------------------------------------------

export async function handleDebugConsoleStart(msg, ctx) {
  const { tabId } = msg;
  if (!tabId) { sendError(msg.id, "debug.console.start requires tabId", {}, ctx); return; }
  const sessionId = `console_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const session = { tabId, kind: "console", startedAt: Date.now(), buffer: [], listener: null };
  _sessions.set(sessionId, session);

  try {
    await _ensureAttached(tabId);
    await chrome.debugger.sendCommand({ tabId }, "Runtime.enable");
    await chrome.debugger.sendCommand({ tabId }, "Log.enable");

    const listener = (source, method, params) => {
      if (source?.tabId !== tabId) return;
      if (method === "Runtime.consoleAPICalled") {
        const entry = {
          ts: Date.now(),
          type: params.type,            // log, warn, error, info, debug
          args: (params.args || []).map((a) => a.value ?? a.description ?? String(a)),
          stackTrace: params.stackTrace?.callFrames?.slice(0, 5) || [],
        };
        session.buffer.push(entry);
        sendEvent("console.log", entry, { tabId, sessionId, traceId: ctx.traceId });
      }
      if (method === "Log.entryAdded") {
        const entry = { ts: Date.now(), type: params.entry?.level, args: [params.entry?.text], stackTrace: params.entry?.stackTrace?.callFrames?.slice(0, 5) || [] };
        session.buffer.push(entry);
        sendEvent("console.log", entry, { tabId, sessionId, traceId: ctx.traceId });
      }
    };
    chrome.debugger.onEvent.addListener(listener);
    session.listener = listener;

    sendResult(msg.id, { sessionId, startedAt: session.startedAt }, ctx);
    info("console-start", { sessionId, tabId });
  } catch (err) {
    _sessions.delete(sessionId);
    sendError(msg.id, `debug.console.start failed: ${err.message ?? err}`, {}, ctx);
  }
}

export async function handleDebugConsoleStop(msg, ctx) {
  const { sessionId } = msg;
  const session = _sessions.get(sessionId);
  if (!session) { sendError(msg.id, `debug.console.stop: unknown sessionId ${sessionId}`, {}, ctx); return; }
  if (session.kind !== "console") { sendError(msg.id, `debug.console.stop: session ${sessionId} is not a console session`, {}, ctx); return; }

  try {
    if (session.listener) chrome.debugger.onEvent.removeListener(session.listener);
    await chrome.debugger.sendCommand({ tabId: session.tabId }, "Log.disable");
    await _maybeDetach(session.tabId);
    const durationMs = Date.now() - session.startedAt;
    sendResult(msg.id, { entries: session.buffer, count: session.buffer.length, durationMs }, { ...ctx, durationMs });
    info("console-stop", { sessionId, count: session.buffer.length, durationMs });
    _sessions.delete(sessionId);
  } catch (err) {
    sendError(msg.id, `debug.console.stop failed: ${err.message ?? err}`, {}, ctx);
  }
}

// ---------------------------------------------------------------------------
// debug.network.start / stop — continuous capture (multiple requests)
// ---------------------------------------------------------------------------

export async function handleDebugNetworkStart(msg, ctx) {
  const { tabId, urlPattern = null } = msg;
  if (!tabId) { sendError(msg.id, "debug.network.start requires tabId", {}, ctx); return; }
  const sessionId = `net_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const session = { tabId, kind: "network", startedAt: Date.now(), buffer: [], listener: null, urlPattern };
  _sessions.set(sessionId, session);

  let regex = null;
  if (urlPattern) {
    try { regex = new RegExp(urlPattern); }
    catch (err) { sendError(msg.id, `invalid urlPattern: ${err.message}`, {}, ctx); return; }
  }

  try {
    await _ensureAttached(tabId);
    await chrome.debugger.sendCommand({ tabId }, "Network.enable");

    const listener = async (source, method, params) => {
      if (source?.tabId !== tabId) return;
      if (method === "Network.requestWillBeSent") {
        if (regex && !regex.test(params.request.url)) return;
        const entry = { requestId: params.requestId, request: { method: params.request.method, url: params.request.url, headers: params.request.headers, postData: params.request.postData || null }, timestamp: params.timestamp };
        session.buffer.push(entry);
        sendEvent("network.request", entry, { tabId, sessionId, traceId: ctx.traceId });
      }
      if (method === "Network.responseReceived") {
        const entry = session.buffer.find((e) => e.requestId === params.requestId);
        if (entry) {
          entry.response = { status: params.response.status, statusText: params.response.statusText, headers: params.response.headers, mimeType: params.response.mimeType };
          sendEvent("network.response", { requestId: params.requestId, status: params.response.status, url: entry.request.url }, { tabId, sessionId, traceId: ctx.traceId });
        }
      }
      if (method === "Network.loadingFinished" && params.requestId) {
        const entry = session.buffer.find((e) => e.requestId === params.requestId);
        if (entry) {
          try {
            const bodyRes = await chrome.debugger.sendCommand({ tabId }, "Network.getResponseBody", { requestId: params.requestId });
            entry.responseBody = bodyRes?.body || null;
            entry.responseBase64Encoded = bodyRes?.base64Encoded || false;
            sendEvent("network.body", { requestId: params.requestId, bodyLen: entry.responseBody?.length || 0 }, { tabId, sessionId, traceId: ctx.traceId });
          } catch {}
        }
      }
    };
    chrome.debugger.onEvent.addListener(listener);
    session.listener = listener;

    sendResult(msg.id, { sessionId, startedAt: session.startedAt, urlFilter: urlPattern }, ctx);
    info("network-start", { sessionId, tabId, urlFilter: urlPattern });
  } catch (err) {
    _sessions.delete(sessionId);
    sendError(msg.id, `debug.network.start failed: ${err.message ?? err}`, {}, ctx);
  }
}

export async function handleDebugNetworkStop(msg, ctx) {
  const { sessionId } = msg;
  const session = _sessions.get(sessionId);
  if (!session) { sendError(msg.id, `debug.network.stop: unknown sessionId ${sessionId}`, {}, ctx); return; }
  if (session.kind !== "network") { sendError(msg.id, `debug.network.stop: session ${sessionId} is not a network session`, {}, ctx); return; }

  try {
    if (session.listener) chrome.debugger.onEvent.removeListener(session.listener);
    await chrome.debugger.sendCommand({ tabId: session.tabId }, "Network.disable");
    await _maybeDetach(session.tabId);
    const durationMs = Date.now() - session.startedAt;
    sendResult(msg.id, { entries: session.buffer, count: session.buffer.length, durationMs }, { ...ctx, durationMs });
    info("network-stop", { sessionId, count: session.buffer.length, durationMs });
    _sessions.delete(sessionId);
  } catch (err) {
    sendError(msg.id, `debug.network.stop failed: ${err.message ?? err}`, {}, ctx);
  }
}

// ---------------------------------------------------------------------------
// debug.trace.start / stop — CDP Tracing (performance timeline)
// ---------------------------------------------------------------------------

export async function handleDebugTraceStart(msg, ctx) {
  const { tabId, categories = "devtools.timeline,v8,disabled-by-default-devtools.timeline" } = msg;
  if (!tabId) { sendError(msg.id, "debug.trace.start requires tabId", {}, ctx); return; }
  const sessionId = `trace_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const session = { tabId, kind: "trace", startedAt: Date.now(), buffer: [], listener: null };
  _sessions.set(sessionId, session);

  try {
    await _ensureAttached(tabId);

    const listener = (source, method, params) => {
      if (source?.tabId !== tabId) return;
      if (method === "Tracing.dataCollected") {
        const events = params.value || [];
        session.buffer.push(...events);
        // Stream a sample (1 in 100 events) to avoid flooding the wire
        if (session.buffer.length % 100 === 0) {
          sendEvent("trace.progress", { count: session.buffer.length }, { tabId, sessionId, traceId: ctx.traceId });
        }
      }
    };
    chrome.debugger.onEvent.addListener(listener);
    session.listener = listener;

    await chrome.debugger.sendCommand({ tabId }, "Tracing.start", {
      traceConfig: { includedCategories: categories.split(",").map((s) => s.trim()) },
    });

    sendResult(msg.id, { sessionId, startedAt: session.startedAt, categories }, ctx);
    info("trace-start", { sessionId, tabId, categories });
  } catch (err) {
    _sessions.delete(sessionId);
    sendError(msg.id, `debug.trace.start failed: ${err.message ?? err}`, {}, ctx);
  }
}

export async function handleDebugTraceStop(msg, ctx) {
  const { sessionId } = msg;
  const session = _sessions.get(sessionId);
  if (!session) { sendError(msg.id, `debug.trace.stop: unknown sessionId ${sessionId}`, {}, ctx); return; }
  if (session.kind !== "trace") { sendError(msg.id, `debug.trace.stop: session ${sessionId} is not a trace session`, {}, ctx); return; }

  try {
    await chrome.debugger.sendCommand({ tabId: session.tabId }, "Tracing.end");
    // Tracing.dataCollected events continue to arrive; the listener captures them.
    // Give CDP 1s to flush remaining events before we detach.
    await new Promise((r) => setTimeout(r, 1000));

    if (session.listener) chrome.debugger.onEvent.removeListener(session.listener);
    await _maybeDetach(session.tabId);
    const durationMs = Date.now() - session.startedAt;
    sendResult(msg.id, { events: session.buffer, count: session.buffer.length, durationMs }, { ...ctx, durationMs });
    info("trace-stop", { sessionId, count: session.buffer.length, durationMs });
    _sessions.delete(sessionId);
  } catch (err) {
    sendError(msg.id, `debug.trace.stop failed: ${err.message ?? err}`, {}, ctx);
  }
}

// ---------------------------------------------------------------------------
// debug.dom.snapshot — one-shot DOM tree as HTML
// ---------------------------------------------------------------------------

export async function handleDebugDomSnapshot(msg, ctx) {
  const { tabId, includeShadow = true, maxDepth = 0 } = msg;
  if (!tabId) { sendError(msg.id, "debug.dom.snapshot requires tabId", {}, ctx); return; }
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: (includeShadow, maxDepth) => {
        const serialize = (node, depth) => {
          if (maxDepth > 0 && depth > maxDepth) return "";
          if (!node) return "";
          if (node.nodeType === Node.TEXT_NODE) return node.textContent;
          if (node.nodeType === Node.COMMENT_NODE) return `<!--${node.textContent}-->`;
          if (node.nodeType !== Node.ELEMENT_NODE) return "";
          const tag = node.tagName.toLowerCase();
          const attrs = [...node.attributes].map((a) => `${a.name}="${a.value.replace(/"/g, "&quot;")}"`).join(" ");
          let html = `<${tag}${attrs ? " " + attrs : ""}>`;
          if (["script", "style"].includes(tag)) {
            html += node.textContent;
          } else {
            const kids = includeShadow && node.shadowRoot ? [...node.childNodes, ...node.shadowRoot.childNodes] : [...node.childNodes];
            for (const kid of kids) html += serialize(kid, depth + 1);
          }
          html += `</${tag}>`;
          return html;
        };
        return { html: serialize(document.documentElement, 0), doctype: document.doctype?.name || "html" };
      },
      args: [includeShadow, maxDepth],
    });
    if (!result?.result) {
      sendError(msg.id, "debug.dom.snapshot: injection returned no result", {}, ctx);
      return;
    }
    sendResult(msg.id, { ...result.result, capturedAt: Date.now() }, ctx);
  } catch (err) {
    sendError(msg.id, `debug.dom.snapshot failed: ${err.message ?? err}`, {}, ctx);
  }
}

// ---------------------------------------------------------------------------
// debug.storage.dump — localStorage + sessionStorage + cookies
// ---------------------------------------------------------------------------

export async function handleDebugStorageDump(msg, ctx) {
  const { tabId, includeCookies = true } = msg;
  if (!tabId) { sendError(msg.id, "debug.storage.dump requires tabId", {}, ctx); return; }
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        const ls = {};
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          ls[k] = localStorage.getItem(k);
        }
        const ss = {};
        for (let i = 0; i < sessionStorage.length; i++) {
          const k = sessionStorage.key(i);
          ss[k] = sessionStorage.getItem(k);
        }
        return { localStorage: ls, sessionStorage: ss, localStorageCount: Object.keys(ls).length, sessionStorageCount: Object.keys(ss).length };
      },
    });
    const r = result?.result || { localStorage: {}, sessionStorage: {} };
    if (includeCookies) {
      try { r.cookies = await chrome.cookies.getAll({ url: (await chrome.tabs.get(tabId)).url }); } catch { r.cookies = []; }
    }
    sendResult(msg.id, { ...r, capturedAt: Date.now() }, ctx);
  } catch (err) {
    sendError(msg.id, `debug.storage.dump failed: ${err.message ?? err}`, {}, ctx);
  }
}

// ---------------------------------------------------------------------------
// debug.screenshot.fullpage — full-page screenshot (not just viewport)
// ---------------------------------------------------------------------------

export async function handleDebugScreenshotFullpage(msg, ctx) {
  const { tabId, format = "png", quality } = msg;
  if (!tabId) { sendError(msg.id, "debug.screenshot.fullpage requires tabId", {}, ctx); return; }
  try {
    // First, get the full page dimensions via injected script
    const [dims] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => ({
        width: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0),
        height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0),
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
      }),
    });
    const dimensions = dims?.result;
    if (!dimensions) { sendError(msg.id, "debug.screenshot.fullpage: could not read page dimensions", {}, ctx); return; }

    // Use CDP Page.captureScreenshot with captureBeyondViewport=true
    await _ensureAttached(tabId);
    try {
      await chrome.debugger.sendCommand({ tabId }, "Page.enable");
      const shotRes = await chrome.debugger.sendCommand({ tabId }, "Page.captureScreenshot", {
        format,
        quality: format === "jpeg" ? (quality || 80) : undefined,
        captureBeyondViewport: true,
        fromSurface: true,
      });
      await chrome.debugger.sendCommand({ tabId }, "Page.disable");
      await _maybeDetach(tabId);

      if (!shotRes?.data) {
        sendError(msg.id, "debug.screenshot.fullpage: captureScreenshot returned empty", {}, ctx);
        return;
      }
      const dataUrl = `data:image/${format};base64,${shotRes.data}`;
      sendResult(msg.id, { dataUrl, format, dimensions, capturedAt: Date.now() }, ctx);
    } catch (err) {
      await _maybeDetach(tabId);
      throw err;
    }
  } catch (err) {
    sendError(msg.id, `debug.screenshot.fullpage failed: ${err.message ?? err}`, {}, ctx);
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerDebugHandlers(dispatcher) {
  dispatcher[CMD.DEBUG_HAR_START] = handleDebugHarStart;
  dispatcher[CMD.DEBUG_HAR_STOP] = handleDebugHarStop;
  dispatcher[CMD.DEBUG_CONSOLE_START] = handleDebugConsoleStart;
  dispatcher[CMD.DEBUG_CONSOLE_STOP] = handleDebugConsoleStop;
  dispatcher[CMD.DEBUG_NETWORK_START] = handleDebugNetworkStart;
  dispatcher[CMD.DEBUG_NETWORK_STOP] = handleDebugNetworkStop;
  dispatcher[CMD.DEBUG_TRACE_START] = handleDebugTraceStart;
  dispatcher[CMD.DEBUG_TRACE_STOP] = handleDebugTraceStop;
  dispatcher[CMD.DEBUG_DOM_SNAPSHOT] = handleDebugDomSnapshot;
  dispatcher[CMD.DEBUG_STORAGE_DUMP] = handleDebugStorageDump;
  dispatcher[CMD.DEBUG_SCREENSHOT_FULL] = handleDebugScreenshotFullpage;
}
