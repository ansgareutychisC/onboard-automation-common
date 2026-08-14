// extension/popup.js
//
// Popup UI controller. Polls background.js for status every 1s (safety net
// for missed pushed messages), renders the structured log feed with
// commandId / tabId / durationMs columns when present, and handles
// connect/disconnect/clear actions.

const $ = (id) => document.getElementById(id);
let refreshTimer = null;

document.addEventListener("DOMContentLoaded", async () => {
  // Load saved config
  chrome.runtime.sendMessage({ type: "getConfig" }, (cfg) => {
    if (chrome.runtime.lastError || !cfg) return;
    $("server-url").value = cfg.serverUrl || "";
    $("auth-token").value = cfg.authToken || "";
    $("auto-connect").checked = cfg.autoConnect !== false;
  });

  // Wire up buttons
  $("connect-btn").addEventListener("click", () => {
    const serverUrl = $("server-url").value.trim();
    const authToken = $("auth-token").value.trim();
    if (!serverUrl) {
      alert("Please enter a server URL");
      return;
    }
    chrome.runtime.sendMessage({ type: "connect", serverUrl, authToken }, () => {});
  });

  $("disconnect-btn").addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "disconnect" }, () => {});
  });

  $("clear-log").addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "clearLog" }, () => {
      $("log-container").innerHTML = "";
    });
  });

  // Listen for live log entries + status updates from background
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg.type !== "string") return;
    if (msg.type === "log" && msg.entry) {
      appendLogEntry(msg.entry);
    } else if (msg.type === "status" && msg.status) {
      renderStatus(msg.status);
    }
  });

  // Initial fetch + start polling
  await fetchStatus();
  refreshTimer = setInterval(fetchStatus, 1000);
});

window.addEventListener("beforeunload", () => {
  if (refreshTimer) clearInterval(refreshTimer);
});

async function fetchStatus() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "getStatus" }, (resp) => {
      if (chrome.runtime.lastError || !resp) { resolve(); return; }
      renderStatus(resp.status);
      renderLogs(resp.logEntries || []);
      $("agent-id").textContent = "agent: " + (resp.agentId || "…");
      resolve();
    });
  });
}

function renderStatus(status) {
  if (!status) return;
  const dot = $("status-dot");
  const text = $("status-text");
  dot.className = "status-dot " + (status.status || "disconnected");
  text.textContent = status.status || "disconnected";

  $("stat-received").textContent = status.commandsReceived ?? 0;
  $("stat-completed").textContent = status.commandsCompleted ?? 0;
  $("stat-failed").textContent = status.commandsFailed ?? 0;

  if (status.lastError) {
    text.textContent += " — " + status.lastError;
  }
}

function renderLogs(entries) {
  const container = $("log-container");
  // Re-render the last 50 entries (cheaper than diffing for a small list)
  container.innerHTML = "";
  for (const entry of entries) {
    appendLogEntry(entry, /*skipScroll=*/true);
  }
  container.scrollTop = container.scrollHeight;
}

function appendLogEntry(entry, skipScroll = false) {
  const container = $("log-container");
  const div = document.createElement("div");
  div.className = "log-entry " + (entry.level || "info");

  // ISSUE-21 fix: previously built innerHTML with template literals that
  // interpolated entry.commandId, entry.tabId, entry.durationMs WITHOUT
  // escaping. A malicious bridge could inject HTML via a crafted commandId.
  // Now we use DOM APIs (textContent / createElement) — no innerHTML, no
  // possibility of XSS.

  const ts = document.createElement("span");
  ts.className = "ts";
  ts.textContent = new Date(entry.ts).toLocaleTimeString("en-US", { hour12: false });

  const level = document.createElement("span");
  level.className = "level";
  level.textContent = (entry.level || "info").toUpperCase();

  const msgText = document.createElement("span");
  msgText.textContent = (entry.message || "") + (
    entry.data && Object.keys(entry.data).length > 0
      ? " " + JSON.stringify(entry.data).slice(0, 200)
      : ""
  );

  div.appendChild(ts);
  div.appendChild(level);
  div.appendChild(msgText);

  if (entry.commandId) {
    const cmdId = document.createElement("span");
    cmdId.className = "cmd-id";
    cmdId.textContent = `[${String(entry.commandId).slice(0, 8)}]`;
    div.appendChild(cmdId);
  }
  if (entry.tabId != null) {
    const tabInfo = document.createElement("span");
    tabInfo.style.color = "#666";
    tabInfo.textContent = ` tab=${entry.tabId}`;
    div.appendChild(tabInfo);
  }
  if (entry.durationMs != null) {
    const durInfo = document.createElement("span");
    durInfo.style.color = "#666";
    durInfo.textContent = ` ${entry.durationMs}ms`;
    div.appendChild(durInfo);
  }

  container.appendChild(div);

  if (!skipScroll) {
    container.scrollTop = container.scrollHeight;
  }

  // Cap at 200 entries in the DOM
  while (container.children.length > 200) {
    container.removeChild(container.firstChild);
  }
}

function escapeHtml(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
