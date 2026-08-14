// extension/handlers/xhr.js
//
// xhr.intercept — one-shot capture of a single matching request via CDP
// Network domain. Attaches chrome.debugger, listens for the first request
// matching urlPattern (regex string), captures request + response bodies
// via Network.getResponseBody, then detaches.
//
// For CONTINUOUS capture (multiple requests over a time window), use
// debug.network.start / debug.network.stop instead — see handlers/debug.js.

import { CMD } from "../lib/protocol.js";
import { sendResult, sendError } from "../lib/send.js";
import { info, warn } from "../lib/logger.js";

export async function handleXhrIntercept(msg, ctx) {
  const { tabId, urlPattern, method = null, timeoutMs = 30_000 } = msg;
  if (!tabId || !urlPattern) {
    sendError(msg.id, "xhr.intercept requires tabId and urlPattern", {}, ctx);
    return;
  }

  let regex;
  try { regex = new RegExp(urlPattern); }
  catch (err) {
    sendError(msg.id, `invalid urlPattern regex: ${err.message}`, { urlPattern }, ctx);
    return;
  }

  const debugTarget = { tabId };
  const startedAt = Date.now();
  let attached = false;
  let resolved = false;
  let pendingRequestId = null;  // first matching request

  const cleanup = async () => {
    if (attached) {
      try { await chrome.debugger.sendCommand(debugTarget, "Network.disable"); } catch {}
      try { await chrome.debugger.detach(debugTarget); } catch {}
      attached = false;
    }
  };

  const timer = setTimeout(async () => {
    if (!resolved) {
      resolved = true;
      await cleanup();
      sendError(msg.id, `xhr.intercept timed out after ${timeoutMs}ms (pattern: ${urlPattern})`, { timeoutMs }, { ...ctx, durationMs: Date.now() - startedAt });
    }
  }, timeoutMs);

  try {
    try {
      await chrome.debugger.attach(debugTarget, "1.3");
      attached = true;
    } catch (err) {
      if (!String(err?.message).includes("Another debugger")) throw err;
      warn("xhr-debugger-already-attached", { tabId });
      attached = true;  // assume ours
    }

    await chrome.debugger.sendCommand(debugTarget, "Network.enable");

    const listener = async (source, method, params) => {
      if (source?.tabId !== tabId) return;

      if (method === "Network.requestWillBeSent" && !resolved) {
        const reqUrl = params.request?.url || "";
        if (regex.test(reqUrl) && (!method || params.request?.method?.toUpperCase() === method.toUpperCase())) {
          if (pendingRequestId) return;  // already capturing one
          pendingRequestId = {
            requestId: params.requestId,
            url: reqUrl,
            method: params.request.method,
            requestHeaders: params.request.headers,
            requestBody: params.request.postData || null,
            type: params.type,
          };
          info("xhr-matched", { id: msg.id, url: reqUrl, method: params.request.method });
        }
      }

      if (method === "Network.responseReceived" && pendingRequestId && params.requestId === pendingRequestId.requestId) {
        pendingRequestId.responseStatus = params.response?.status;
        pendingRequestId.responseHeaders = params.response?.headers;
        pendingRequestId.responseMimeType = params.response?.mimeType;
      }

      if (method === "Network.loadingFinished" && pendingRequestId && params.requestId === pendingRequestId.requestId) {
        // Fetch the response body
        try {
          const bodyRes = await chrome.debugger.sendCommand(debugTarget, "Network.getResponseBody", {
            requestId: pendingRequestId.requestId,
          });
          pendingRequestId.responseBody = bodyRes?.body || null;
          pendingRequestId.responseBase64Encoded = bodyRes?.base64Encoded || false;
        } catch (err) {
          warn("xhr-get-body-failed", { id: msg.id, error: String(err) });
        }
        resolved = true;
        clearTimeout(timer);
        chrome.debugger.onEvent.removeListener(listener);
        await cleanup();
        sendResult(msg.id, { xhr: pendingRequestId }, { ...ctx, durationMs: Date.now() - startedAt });
      }

      if (method === "Network.loadingFailed" && pendingRequestId && params.requestId === pendingRequestId.requestId) {
        resolved = true;
        clearTimeout(timer);
        chrome.debugger.onEvent.removeListener(listener);
        await cleanup();
        sendError(msg.id, `xhr.intercept: request failed: ${params.errorText || "unknown"}`, { xhr: pendingRequestId, errorText: params.errorText }, { ...ctx, durationMs: Date.now() - startedAt });
      }
    };

    chrome.debugger.onEvent.addListener(listener);
  } catch (err) {
    if (!resolved) {
      resolved = true;
      clearTimeout(timer);
      await cleanup();
      sendError(msg.id, `xhr.intercept failed: ${err.message ?? err}`, {}, { ...ctx, durationMs: Date.now() - startedAt });
    }
  }
}

export function registerXhrHandlers(dispatcher) {
  dispatcher[CMD.XHR_INTERCEPT] = handleXhrIntercept;
}
