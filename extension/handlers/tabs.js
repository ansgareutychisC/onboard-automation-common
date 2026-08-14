// extension/handlers/tabs.js
import { CMD } from "../lib/protocol.js";
import { sendResult, sendError } from "../lib/send.js";

export async function handleTabsOpen(msg, ctx) {
  const { url, active = true } = msg;
  try {
    const tab = await chrome.tabs.create({ url, active });
    // Wait for the tab to finish loading (+500ms grace for late JS)
    await _waitForTabLoaded(tab.id);
    await _sleep(500);
    sendResult(msg.id, { tabId: tab.id, url: tab.url, title: tab.title }, ctx);
  } catch (err) {
    sendError(msg.id, `tabs.open failed: ${err.message ?? err}`, {}, ctx);
  }
}

export async function handleTabsClose(msg, ctx) {
  try {
    await chrome.tabs.remove(msg.tabId);
    sendResult(msg.id, { closed: true }, ctx);
  } catch (err) {
    sendError(msg.id, `tabs.close failed: ${err.message ?? err}`, {}, ctx);
  }
}

export async function handleTabsList(msg, ctx) {
  try {
    const tabs = await chrome.tabs.query({});
    const mapped = tabs.map((t) => ({
      id: t.id, url: t.url, title: t.title, active: t.active, windowId: t.windowId,
    }));
    sendResult(msg.id, { tabs: mapped }, ctx);
  } catch (err) {
    sendError(msg.id, `tabs.list failed: ${err.message ?? err}`, {}, ctx);
  }
}

export async function handleTabsFocus(msg, ctx) {
  try {
    await chrome.tabs.update(msg.tabId, { active: true });
    const tab = await chrome.tabs.get(msg.tabId);
    if (tab.windowId) {
      try { await chrome.windows.update(tab.windowId, { focused: true }); } catch {}
    }
    sendResult(msg.id, { focused: true, tabId: msg.tabId }, ctx);
  } catch (err) {
    sendError(msg.id, `tabs.focus failed: ${err.message ?? err}`, {}, ctx);
  }
}

function _waitForTabLoaded(tabId, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError || !tab) { resolve(); return; }
        if (tab.status === "complete" || Date.now() - start > timeoutMs) { resolve(); return; }
        setTimeout(check, 250);
      });
    };
    check();
  });
}

function _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

export function registerTabsHandlers(dispatcher) {
  dispatcher[CMD.TABS_OPEN] = handleTabsOpen;
  dispatcher[CMD.TABS_CLOSE] = handleTabsClose;
  dispatcher[CMD.TABS_LIST] = handleTabsList;
  dispatcher[CMD.TABS_FOCUS] = handleTabsFocus;
}
