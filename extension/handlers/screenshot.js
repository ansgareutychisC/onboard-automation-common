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
    let tabFocusRestored = false;
    let windowFocusRestored = false;
    const previouslyActiveTab = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    const wasTabActive = previouslyActiveTab.some((t) => t.id === tabId);
    // ISSUE-18 fix: also remember the previously-focused window so we can
    // restore focus to it after capture. The previous code only restored
    // the previously-active TAB within the same window — leaving focus on
    // the tab's window when it was a different window.
    let prevWindow = null;
    try { prevWindow = await chrome.windows.getLastFocused(); } catch {}

    if (!wasTabActive) {
      await chrome.tabs.update(tabId, { active: true });
      tabFocusRestored = true;
    }
    // Focus the window so captureVisibleTab targets it (only if not already focused)
    if (!prevWindow || prevWindow.id !== tab.windowId) {
      try { await chrome.windows.update(tab.windowId, { focused: true }); windowFocusRestored = true; } catch {}
      await _sleep(150);  // let the tab become visible
    }

    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, captureOpts);

    // Restore focus in reverse order: tab first, then window
    if (tabFocusRestored && previouslyActiveTab[0]) {
      try { await chrome.tabs.update(previouslyActiveTab[0].id, { active: true }); } catch {}
    }
    if (windowFocusRestored && prevWindow) {
      try { await chrome.windows.update(prevWindow.id, { focused: true }); } catch {}
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
