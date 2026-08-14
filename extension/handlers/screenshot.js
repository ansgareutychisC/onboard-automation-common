// extension/handlers/screenshot.js
//
// screenshot — visible tab capture. TABID-AWARE (fixes the legacy bug where
// chrome.tabs.captureVisibleTab(null, ...) captured whatever tab was active
// in the current window, ignoring the requested tabId).
//
// We resolve the tab's windowId first, focus the window if needed, then
// capture. The tab is NOT refocused if it was already active — this avoids
// flicker. If the tab is not in the currently-focused window, we briefly
// switch focus, capture, then restore the previous window.

import { CMD } from "../lib/protocol.js";
import { sendResult, sendError } from "../lib/send.js";
import { info } from "../lib/logger.js";

export async function handleScreenshot(msg, ctx) {
  const { tabId, format = "png", quality } = msg;
  if (!tabId) {
    sendError(msg.id, "screenshot requires tabId", {}, ctx);
    return;
  }
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab || !tab.windowId) {
      sendError(msg.id, `screenshot: tab ${tabId} not found or has no window`, {}, ctx);
      return;
    }

    const captureOpts = { format };
    if (format === "jpeg" && typeof quality === "number") captureOpts.quality = quality;

    // If the tab isn't active in its window, we need to activate it to capture
    let restored = false;
    const previouslyActive = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    const wasActive = previouslyActive.some((t) => t.id === tabId);

    if (!wasActive) {
      await chrome.tabs.update(tabId, { active: true });
      // Focus the window so captureVisibleTab targets it
      try { await chrome.windows.update(tab.windowId, { focused: true }); } catch {}
      await _sleep(150);  // let the tab become visible
      restored = true;
    }

    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, captureOpts);

    if (restored && previouslyActive[0]) {
      try { await chrome.tabs.update(previouslyActive[0].id, { active: true }); } catch {}
    }

    if (!dataUrl) {
      sendError(msg.id, "screenshot: captureVisibleTab returned empty", {}, ctx);
      return;
    }
    sendResult(msg.id, { dataUrl, format, tabId, capturedAt: Date.now() }, ctx);
  } catch (err) {
    sendError(msg.id, `screenshot failed: ${err.message ?? err}`, {}, ctx);
  }
}

function _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

export function registerScreenshotHandlers(dispatcher) {
  dispatcher[CMD.SCREENSHOT] = handleScreenshot;
}
