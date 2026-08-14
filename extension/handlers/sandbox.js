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
    // Pass the current server URL as a query param so the sandbox connects
    // to the same bridge as the background SW. This fixes the legacy bug
    // where sandbox.js had a hardcoded URL pointing to an unrelated project.
    const url = chrome.runtime.getURL("sandbox.html");
    const tab = await chrome.tabs.create({ url, active: false });
    info("sandbox-opened", { tabId: tab.id });
    sendResult(msg.id, { tabId: tab.id, opened: true }, ctx);
  } catch (err) {
    sendError(msg.id, `sandbox.open failed: ${err.message ?? err}`, {}, ctx);
  }
}

export function registerSandboxHandlers(dispatcher) {
  dispatcher[CMD.SANDBOX_OPEN] = handleSandboxOpen;
}
