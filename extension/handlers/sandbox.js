// extension/handlers/sandbox.js
//
// sandbox.open — opens sandbox.html as a background tab. The sandbox page
//                connects to the same bridge server with context:"page" and
//                handles only sandbox.fetch commands (page-context fetch
//                with native zstd support).
//
// sandbox.fetch is NOT handled here — it's routed to the sandbox page
// connection by the bridge server (DO or aiohttp daemon). The server
// inspects the `context` field on each connected extension and routes
// sandbox.fetch commands only to connections with context:"page".

import { CMD } from "../lib/protocol.js";
import { sendResult, sendError } from "../lib/send.js";
import { info } from "../lib/logger.js";

export async function handleSandboxOpen(msg, ctx) {
  try {
    // ISSUE-13 + ISSUE-14 fix: pass the current server URL + auth token as
    // query params so the sandbox connects to the same bridge as the
    // background SW, with the same auth. Previously the handler called
    // chrome.runtime.getURL("sandbox.html") with no params, and the sandbox
    // fell back to chrome.storage.local["serverUrl"] — which works in the
    // normal case but breaks if config was set programmatically without
    // saving to storage. The sandbox also had a hardcoded empty auth token,
    // which fails against an authenticated bridge.
    const { getConnectionState } = await import("../lib/connection.js");
    const connState = getConnectionState();
    const serverUrl = connState.serverUrl;
    const authToken = connState.authToken;

    if (!serverUrl) {
      sendError(msg.id, "sandbox.open: no server URL configured — connect the extension first", {}, ctx);
      return;
    }

    const params = new URLSearchParams();
    params.set("server", serverUrl);
    if (authToken) params.set("token", authToken);

    const url = chrome.runtime.getURL("sandbox.html") + "?" + params.toString();
    const tab = await chrome.tabs.create({ url, active: false });
    info("sandbox-opened", { tabId: tab.id, serverUrl: serverUrl ? "[set]" : "[empty]" });
    sendResult(msg.id, { tabId: tab.id, opened: true }, ctx);
  } catch (err) {
    sendError(msg.id, `sandbox.open failed: ${err.message ?? err}`, {}, ctx);
  }
}

export function registerSandboxHandlers(dispatcher) {
  dispatcher[CMD.SANDBOX_OPEN] = handleSandboxOpen;
}
