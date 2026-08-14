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
import { _ownedTabs } from "./debug.js";

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
  // ISSUE-R3-3 fix: weAttached is ONLY set when chrome.debugger.attach succeeds.
  // If we assumed ownership of an existing debugger (from an active debug.*
  // session), weAttached stays false — we must NOT disable Network or detach
  // in cleanup, or we'll break the debug session.
  let weAttached = false;
  let resolved = false;
  let pendingRequestId = null;  // first matching request

  const cleanup = async () => {
    // ISSUE-R3-3 fix: only clean up if WE attached (weAttached=true). If we
    // assumed ownership of an existing debugger, calling Network.disable would
    // stop all Network events for active debug.* sessions, and detach would
    // break them entirely.
    if (weAttached) {
      try { await chrome.debugger.sendCommand(debugTarget, "Network.disable"); } catch {}
      try { await chrome.debugger.detach(debugTarget); } catch {}
      _ownedTabs.delete(tabId);
      attached = false;
      weAttached = false;
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
      _ownedTabs.add(tabId);  // ISSUE-R2-8: mark as ours
      attached = true;
      weAttached = true;  // ISSUE-R3-3: we own this debugger
    } catch (err) {
      // ISSUE-R2-8: distinguish "ours" (orphan from prior SW) from "foreign" (DevTools)
      if (String(err?.message).includes("Another debugger") && _ownedTabs.has(tabId)) {
        warn("xhr-debugger-already-attached-ours", { tabId });
        attached = true;  // assume ours — orphan from prior SW lifetime OR active debug.* session
        // weAttached stays false — we must NOT detach or disable Network
      } else if (String(err?.message).includes("Another debugger")) {
        // Foreign debugger — give a clear error instead of assuming ownership
        resolved = true;
        clearTimeout(timer);
        sendError(msg.id, `xhr.intercept failed: tab ${tabId} has a foreign debugger attached (DevTools or another extension). Close DevTools and retry.`, {}, { ...ctx, durationMs: Date.now() - startedAt });
        return;
      } else {
        throw err;
      }
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
