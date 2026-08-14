// extension/handlers/fetch.js
//
// fetch — service-worker context. Handles zstd via DecompressionStream
//         (Chrome 143+). NOTE: SW-context zstd decompression is unreliable
//         in Chrome 151+; callers should prefer page.fetch for zstd-bearing
//         endpoints. We log content-encoding so the backend can detect when
//         zstd was active.
//
// page.fetch — page main-world context. Uses chrome.scripting.executeScript
//              with world:'MAIN'. Chrome's page-context network stack handles
//              zstd natively. REQUIRES a tab to already be open.

import { CMD } from "../lib/protocol.js";
import { sendResult, sendError } from "../lib/send.js";
import { info, warn, error } from "../lib/logger.js";

export async function handleFetch(msg, ctx) {
  const { url, method = "GET", headers = {}, body = null, credentials = "include", timeoutMs = 30_000 } = msg;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const fetchOpts = { method, headers, credentials, signal: controller.signal };
    if (body && !["GET", "HEAD"].includes(method.toUpperCase())) fetchOpts.body = body;

    const res = await fetch(url, fetchOpts);
    const contentEncoding = res.headers.get("content-encoding") || "";
    const finalUrl = res.url;

    let text;
    if (contentEncoding.includes("zstd")) {
      try {
        // DecompressionStream('zstd') is Chrome 143+
        const ds = new DecompressionStream("zstd");
        const decompressed = res.body.pipeThrough(ds);
        text = await new Response(decompressed).text();
        info("fetch-zstd-decompressed", { id: msg.id, bodyLen: text.length, finalUrl });
      } catch (err) {
        warn("fetch-zstd-decompress-failed", { id: msg.id, error: String(err) });
        text = await res.text();  // likely garbled — caller should retry with page.fetch
      }
    } else {
      text = await res.text();
    }

    const respHeaders = {};
    res.headers.forEach((v, k) => { respHeaders[k] = v; });

    sendResult(msg.id, {
      status: res.status,
      statusText: res.statusText,
      body: text,
      headers: respHeaders,
      finalUrl,
      contentEncoding,
      bodyLen: text.length,
    }, { ...ctx, durationMs: Date.now() - startedAt });
  } catch (err) {
    sendError(msg.id, `fetch failed: ${err.message ?? err}`, { timeoutMs }, { ...ctx, durationMs: Date.now() - startedAt });
  } finally {
    clearTimeout(timer);
  }
}

export async function handlePageFetch(msg, ctx) {
  const { tabId, url, method = "GET", headers = {}, body = null, credentials = "include", timeoutMs = 30_000 } = msg;
  if (!tabId) {
    sendError(msg.id, "page.fetch requires tabId", {}, ctx);
    return;
  }
  const startedAt = Date.now();
  try {
    // Inject a function into the tab's main world. Chrome's page-context
    // network stack handles zstd natively (no DecompressionStream dance).
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: async (p) => {
        try {
          const opts = { method: p.method, headers: p.headers, credentials: p.credentials };
          if (p.body && !["GET", "HEAD"].includes(p.method.toUpperCase())) opts.body = p.body;
          const res = await fetch(p.url, opts);
          const text = await res.text();
          const hdrs = {};
          res.headers.forEach((v, k) => { hdrs[k] = v; });
          return { ok: true, status: res.status, statusText: res.statusText, body: text, headers: hdrs, finalUrl: res.url, contentEncoding: hdrs["content-encoding"] || "" };
        } catch (err) {
          return { ok: false, error: String(err) };
        }
      },
      args: [{ url, method, headers, body, credentials }],
    });

    if (!result || !result.result) {
      sendError(msg.id, "page.fetch returned no result", {}, { ...ctx, durationMs: Date.now() - startedAt });
      return;
    }
    const r = result.result;
    if (!r.ok) {
      sendError(msg.id, r.error || "page.fetch failed", {}, { ...ctx, durationMs: Date.now() - startedAt });
      return;
    }
    sendResult(msg.id, {
      status: r.status,
      statusText: r.statusText,
      body: r.body,
      headers: r.headers,
      finalUrl: r.finalUrl,
      contentEncoding: r.contentEncoding,
      bodyLen: r.body.length,
    }, { ...ctx, durationMs: Date.now() - startedAt });
  } catch (err) {
    sendError(msg.id, `page.fetch injection failed: ${err.message ?? err}`, {}, { ...ctx, durationMs: Date.now() - startedAt });
  }
}

export function registerFetchHandlers(dispatcher) {
  dispatcher[CMD.FETCH] = handleFetch;
  dispatcher[CMD.PAGE_FETCH] = handlePageFetch;
}
