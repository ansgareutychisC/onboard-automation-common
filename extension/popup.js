/**
 * Popup script — connection config + email/storage config + live diagnostics monitor.
 *
 * The popup is just a monitor + launcher: it shows connection status, command
 * counts, and a live log feed from the background service worker, plus the
 * config panel (email API + Turso) and the macro replay launcher. All the
 * actual work happens in background.js.
 */

const serverUrlInput = document.getElementById('serverUrl');
const connectBtn = document.getElementById('connectBtn');
const autoConnectCheckbox = document.getElementById('autoConnect');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const statReceived = document.getElementById('statReceived');
const statCompleted = document.getElementById('statCompleted');
const statFailed = document.getElementById('statFailed');
const logArea = document.getElementById('logArea');
const clearLogBtn = document.getElementById('clearLogBtn');
const agentIdEl = document.getElementById('agentId');

let logEntries = [];
let refreshInterval = null;

// ---------------------------------------------------------------------------
// Persisted popup state — defined here so the helpers are available
// throughout the file. The actual load happens at the bottom (after all
// `const` declarations of the DOM elements we read from). State is saved
// to chrome.storage.local under 'popupState' so the user doesn't lose
// in-progress macro edits when the popup reopens.
// ---------------------------------------------------------------------------

const PERSISTED_FIELDS = ['macroPreset', 'macroInputs', 'macroJson', 'captureFilter', 'quickExecJson'];

// Debounce timer for saving popup state (avoid writing on every keystroke).
let saveStateTimer = null;

async function savePopupState() {
  const state = {
    macroPreset: (typeof macroPresetSelect !== 'undefined' && macroPresetSelect) ? macroPresetSelect.value : '',
    macroInputs: (typeof macroInputsTextarea !== 'undefined' && macroInputsTextarea) ? macroInputsTextarea.value : '',
    macroJson: (typeof macroJsonTextarea !== 'undefined' && macroJsonTextarea) ? macroJsonTextarea.value : '',
    captureFilter: (typeof captureFilterEl !== 'undefined' && captureFilterEl) ? captureFilterEl.value : '',
    quickExecJson: (typeof quickExecJsonTextarea !== 'undefined' && quickExecJsonTextarea) ? quickExecJsonTextarea.value : '',
  };
  try {
    await chrome.storage.local.set({ popupState: state });
  } catch (e) {
    // Storage might be temporarily unavailable — non-fatal
  }
}

function scheduleSavePopupState() {
  if (saveStateTimer) clearTimeout(saveStateTimer);
  saveStateTimer = setTimeout(savePopupState, 400);  // 400ms debounce
}

async function loadPopupState() {
  try {
    const stored = await chrome.storage.local.get('popupState');
    return stored.popupState || {};
  } catch (e) {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Email & Storage config panel — persisted to chrome.storage.local under the
// same keys the macro inputs and lib/turso.js read:
//   emailWorkerUrl   — full inbox API endpoint (ImprovMX /logs by default)
//   emailWorkerToken — raw Basic pair ("api:sk_...") or a ready "Basic ..."/
//                      "Bearer ..." header value
//   tursoUrl/tursoToken — read directly by lib/turso.js (background)
// Email config is merged into macro inputs at run time (per-run inputs win).
//
// SHIPPED DEFAULTS (friction reduction): when a key has never been saved, the
// fields pre-fill with the priv.email / ImprovMX defaults below so a fresh
// install can run the email presets immediately. Clearing a field and saving
// stores '' — but on next load an empty value falls back to the default again
// (deliberate: empty config is almost always a mistake for these two keys).
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = {
  emailWorkerUrl: 'https://api.improvmx.com/v3/domains/priv.email/logs?take=20',
  emailWorkerToken: 'api:sk_691ff26633c94b0d80523433afe3a369',  // priv.email ImprovMX key (committed with user's blessing — see .agents/SKILL-consumer.md)
};

const CONFIG_FIELDS = ['emailWorkerUrl', 'emailWorkerToken', 'tursoUrl', 'tursoToken'];
const configEls = {};
for (const f of CONFIG_FIELDS) configEls[f] = document.getElementById(f);
const configSavedEl = document.getElementById('configSaved');

let emailConfig = { emailWorkerUrl: '', emailWorkerToken: '' };
let saveConfigTimer = null;
let configSavedTimer = null;

async function loadEmailConfig() {
  try {
    const stored = await chrome.storage.local.get(CONFIG_FIELDS);
    for (const f of CONFIG_FIELDS) {
      const val = stored[f] || DEFAULT_CONFIG[f] || '';
      if (configEls[f]) configEls[f].value = val;
    }
    emailConfig = {
      emailWorkerUrl: stored.emailWorkerUrl || DEFAULT_CONFIG.emailWorkerUrl,
      emailWorkerToken: stored.emailWorkerToken || DEFAULT_CONFIG.emailWorkerToken,
    };
  } catch (e) {
    // Storage unavailable — fall back to shipped defaults so macros still run
    emailConfig = { ...DEFAULT_CONFIG };
  }
}

async function saveConfig() {
  const state = {};
  for (const f of CONFIG_FIELDS) state[f] = (configEls[f] ? configEls[f].value : '').trim();
  try {
    await chrome.storage.local.set(state);
    emailConfig = {
      emailWorkerUrl: state.emailWorkerUrl,
      emailWorkerToken: state.emailWorkerToken,
    };
  } catch (e) {
    // Storage unavailable — non-fatal
  }
  // Flash the "saved" indicator
  configSavedEl.classList.add('show');
  if (configSavedTimer) clearTimeout(configSavedTimer);
  configSavedTimer = setTimeout(() => configSavedEl.classList.remove('show'), 1500);
}

function scheduleSaveConfig() {
  if (saveConfigTimer) clearTimeout(saveConfigTimer);
  saveConfigTimer = setTimeout(saveConfig, 500);  // 500ms debounce
}

for (const f of CONFIG_FIELDS) {
  if (configEls[f]) configEls[f].addEventListener('input', scheduleSaveConfig);
}

const loadEmailConfigPromise = loadEmailConfig();

// ---------------------------------------------------------------------------
// Initial config load (server URL + autoConnect — separate from popupState
// because these are also read by background.js).
// ---------------------------------------------------------------------------

(async () => {
  const cfg = await chrome.storage.local.get(['serverUrl', 'autoConnect']);
  // Default to EMPTY — the extension runs standalone unless the user explicitly
  // configures a dev daemon URL (for WS dev/debug) or a worker URL (Phase 2).
  // The user pastes their own URL via the popup. For *.space-z.ai preview
  // URLs, the bridge listens on port 3000 (the gateway's default proxy target)
  // so no XTransformPort query param is needed.
  serverUrlInput.value = cfg.serverUrl || '';
  autoConnectCheckbox.checked = cfg.autoConnect !== false;
  refreshStatus();
  // Start polling for status updates
  refreshInterval = setInterval(refreshStatus, 1000);
})();

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

connectBtn.addEventListener('click', async () => {
  const url = serverUrlInput.value.trim();
  if (!url) return;

  await chrome.storage.local.set({ serverUrl: url, autoConnect: autoConnectCheckbox.checked });

  if (connectBtn.textContent === 'Connect') {
    connectBtn.textContent = 'Connecting...';
    connectBtn.disabled = true;
    await chrome.runtime.sendMessage({ type: 'connect', serverUrl: url });
    setTimeout(() => {
      connectBtn.textContent = 'Disconnect';
      connectBtn.disabled = false;
      refreshStatus();
    }, 1000);
  } else {
    await chrome.runtime.sendMessage({ type: 'disconnect' });
    connectBtn.textContent = 'Connect';
    refreshStatus();
  }
});

autoConnectCheckbox.addEventListener('change', async () => {
  await chrome.storage.local.set({ autoConnect: autoConnectCheckbox.checked });
});

clearLogBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'clearLog' });
  logEntries = [];
  renderLog();
  refreshStatus();
});

document.getElementById('openSandboxBtn').addEventListener('click', async () => {
  const url = chrome.runtime.getURL('sandbox.html');
  await chrome.tabs.create({ url, active: false });
});

// ---------------------------------------------------------------------------
// Status polling + rendering
// ---------------------------------------------------------------------------

async function refreshStatus() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'getStatus' });
    if (!resp) return;
    renderStatus(resp);
    if (resp.log) {
      logEntries = resp.log;
      renderCaptureList();  // unified render (replaces old renderLog)
    }
  } catch (e) {
    // Background service worker might be starting up
  }
}

function renderStatus(s) {
  // Status dot
  statusDot.className = 'status-dot ' + s.status;
  const statusLabels = {
    connected: 'Connected',
    connecting: 'Connecting...',
    disconnected: 'Disconnected',
    error: 'Error',
  };
  statusText.textContent = statusLabels[s.status] || s.status;
  if (s.status === 'connected') {
    connectBtn.textContent = 'Disconnect';
  } else if (s.status === 'connecting') {
    connectBtn.textContent = 'Connecting...';
  } else {
    connectBtn.textContent = 'Connect';
  }

  // Stats
  statReceived.textContent = s.commandsReceived || 0;
  statCompleted.textContent = s.commandsCompleted || 0;
  statFailed.textContent = s.commandsFailed || 0;

  // Agent ID
  agentIdEl.textContent = s.agentId || 'ext-???';

  // Error
  if (s.lastError && s.status === 'error') {
    statusText.textContent = s.lastError.slice(0, 50);
  }

  // Capture stats — render if the diagnostics panel function is defined
  // (defined below in the Diagnostics & Capture panel section)
  if (typeof renderCaptureStats === 'function' && s.capture) {
    renderCaptureStats(s.capture);
  }
}

function renderLog() {
  if (!logEntries || logEntries.length === 0) {
    logArea.innerHTML = '<div style="color:#666;font-style:italic;">No activity yet</div>';
    return;
  }
  // Show last 50 entries, newest at bottom
  const html = logEntries.slice(-50).map(e => {
    const time = e.ts.split('T')[1]?.split('.')[0] || e.ts;
    const level = e.level || 'info';
    let dataStr = '';
    if (e.data) {
      try {
        dataStr = ' ' + JSON.stringify(e.data).slice(0, 200);
      } catch (err) { /* ignore */ }
    }
    return `<div class="log-entry ${level}"><span class="log-time">${time}</span><span class="log-level">${level.toUpperCase()}</span>${escapeHtml(e.message)}${escapeHtml(dataStr)}</div>`;
  }).join('');
  logArea.innerHTML = html;
  // Auto-scroll to bottom
  logArea.scrollTop = logArea.scrollHeight;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Listen for live log updates from background
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'log' && msg.entry) {
    logEntries.push(msg.entry);
    if (logEntries.length > 200) logEntries.shift();
    renderCaptureList();  // unified render
  } else if (msg.type === 'status') {
    renderStatus(msg.status);
  } else if (msg.type === 'macro-complete') {
    showMacroResult(msg.result);
    runMacroBtn.disabled = false;
    runMacroBtn.textContent = '▶ Run Macro';
    stopMacroBtn.disabled = true;
  } else if (msg.type === 'quickExec-result' && msg.id) {
    // Result of a Quick Exec command (see the Quick Exec section below).
    if (msg.id === pendingQuickExecId) {
      renderQuickExecResult(msg.result);
      pendingQuickExecId = null;
    }
  } else if (msg.type === 'capture-event' && msg.event) {
    captureRing.push(msg.event);
    if (captureRing.length > 100) captureRing.shift();
    renderCaptureList();  // unified render
  }
});

// ---------------------------------------------------------------------------
// Macro Replay
// ---------------------------------------------------------------------------

const macroPresetSelect = document.getElementById('macroPreset');
const macroInputsTextarea = document.getElementById('macroInputs');
const macroJsonTextarea = document.getElementById('macroJson');
const runMacroBtn = document.getElementById('runMacroBtn');
const stopMacroBtn = document.getElementById('stopMacroBtn');
const macroResultDiv = document.getElementById('macroResult');
const macroResultArea = document.getElementById('macroResultArea');

// Load preset macros from the extension's bundled macros/ directory.
// We use chrome.runtime.getURL to fetch them.
const presetCache = {};

// Default inputs — the email API URL + token auto-fill from the config
// panel (which itself ships with the priv.email/ImprovMX defaults), so a
// fresh install can run the email presets with zero configuration. Only the
// email itself may need editing (any *@priv.email alias works — catch-all).
const DEFAULT_INPUTS = {
  email: 'onboard@priv.email',
  workspaceName: 'My Workspace',
  workspaceIcon: '🏠',
  emailWorkerUrl: '',
  emailWorkerToken: '',
  locale: 'en-US',
  timezone: 'America/Los_Angeles',
};

// Pre-fill the inputs textarea with defaults on first load.
// If the user has a persisted state, it will override this at the bottom
// of the file (after all const declarations are in scope).
macroInputsTextarea.value = JSON.stringify(DEFAULT_INPUTS, null, 2);

macroPresetSelect.addEventListener('change', async () => {
  const name = macroPresetSelect.value;
  scheduleSavePopupState();  // persist the selected preset
  if (!name) return;
  if (!presetCache[name]) {
    try {
      const url = chrome.runtime.getURL(`macros/${name}.json`);
      const resp = await fetch(url);
      presetCache[name] = await resp.json();
    } catch (e) {
      alert(`Failed to load preset ${name}: ${e.message}`);
      macroPresetSelect.value = '';
      return;
    }
  }
  macroJsonTextarea.value = JSON.stringify(presetCache[name], null, 2);

  // Make sure the email config is loaded before pre-filling inputs
  await loadEmailConfigPromise;

  // Adjust default inputs based on the preset
  if (name === 'notion/create-api-key' || name === 'notion/activate-trial') {
    // These only need spaceId, not email worker stuff
    macroInputsTextarea.value = JSON.stringify({
      spaceId: 'YOUR_SPACE_ID_HERE',
      ...(name === 'notion/activate-trial' ? { captchaToken: 'P1_eyJ...', trialDays: 14 } : {}),
      ...(name === 'notion/create-api-key' ? { integrationName: 'automation-pat', expiration: '1_year' } : {}),
    }, null, 2);
  } else if (name === 'notion/create-workspace') {
    macroInputsTextarea.value = JSON.stringify({
      workspaceName: 'New Workspace',
      workspaceIcon: '🚀',
      planType: 'personal',
    }, null, 2);
  } else if (name === '_shared/self-test') {
    // The self-test preset targets the LOCAL toy signup site — it must NOT
    // inherit the real ImprovMX config (the code email arrives at the toy
    // server's mock inbox, not at priv.email). Its defaults are self-contained.
    const m = presetCache[name];
    macroInputsTextarea.value = JSON.stringify({
      email: (m.inputs && m.inputs.email) || 'onboard@priv.email',
      baseUrl: (m.inputs && m.inputs.baseUrl) || 'http://127.0.0.1:8898',
      emailWorkerUrl: (m.inputs && m.inputs.emailWorkerUrl) || '',
      emailWorkerToken: (m.inputs && m.inputs.emailWorkerToken) || 'api:toy-local',
    }, null, 2);
  } else if (name === '_shared/wait-for-verification-email') {
    // The shared chunk only needs the email API fields
    macroInputsTextarea.value = JSON.stringify({
      email: DEFAULT_INPUTS.email,
      emailWorkerUrl: emailConfig.emailWorkerUrl || '',
      emailWorkerToken: emailConfig.emailWorkerToken || '',
    }, null, 2);
  } else {
    // notion/signup, notion/full-onboarding — email-flow presets. Pre-fill
    // the email API fields from the config panel so the user sees (and can
    // override) exactly what will be used.
    macroInputsTextarea.value = JSON.stringify({
      ...DEFAULT_INPUTS,
      emailWorkerUrl: emailConfig.emailWorkerUrl || '',
      emailWorkerToken: emailConfig.emailWorkerToken || '',
    }, null, 2);
  }
});

runMacroBtn.addEventListener('click', async () => {
  let macro, inputs;
  try {
    macro = JSON.parse(macroJsonTextarea.value);
    if (!macro.steps || !Array.isArray(macro.steps)) {
      throw new Error('Macro must have a "steps" array');
    }
  } catch (e) {
    alert('Invalid macro JSON: ' + e.message);
    return;
  }
  try {
    inputs = macroInputsTextarea.value.trim()
      ? JSON.parse(macroInputsTextarea.value)
      : {};
  } catch (e) {
    alert('Invalid inputs JSON: ' + e.message);
    return;
  }

  // Merge the Email config panel into the inputs: config fills in only the
  // keys the per-run inputs leave empty/missing. Per-run values always win,
  // so the user can still override per run via the inputs textarea.
  await loadEmailConfigPromise;
  inputs = { ...inputs };
  for (const k of ['emailWorkerUrl', 'emailWorkerToken']) {
    if (!inputs[k] && emailConfig[k]) inputs[k] = emailConfig[k];
  }

  // Disable the run button + show progress
  runMacroBtn.disabled = true;
  runMacroBtn.textContent = 'Running...';
  stopMacroBtn.disabled = false;
  macroResultDiv.style.display = 'block';
  macroResultArea.textContent = '⏳ Running macro "' + (macro.name || 'unnamed') + '"...\n\n';

  // Send to background
  try {
    await chrome.runtime.sendMessage({ type: 'runMacro', macro, inputs });
  } catch (e) {
    showMacroResult({ ok: false, error: 'Failed to start macro: ' + e.message });
    runMacroBtn.disabled = false;
    runMacroBtn.textContent = '▶ Run Macro';
    stopMacroBtn.disabled = true;
  }
});

stopMacroBtn.addEventListener('click', () => {
  // Currently no graceful stop — just re-enable the button.
  // A full stop would require a cancellation token in the macro runner.
  stopMacroBtn.disabled = true;
  macroResultArea.textContent += '\n⚠ Stop requested (current step will finish).';
});

function showMacroResult(result) {
  const ok = result.ok !== false;
  const header = ok
    ? `✅ Macro "${result.name}" completed in ${result.durationMs}ms (${result.stepCount} steps)\n`
    : `❌ Macro "${result.name || '?'}" failed: ${result.error}\n   Completed ${result.completedSteps}/${result.stepCount} steps\n`;

  const stepsHtml = (result.steps || []).map(s => {
    const icon = s.ok ? '✓' : '✗';
    const detail = s.ok
      ? (s.summary ? JSON.stringify(s.summary).slice(0, 200) : '')
      : (s.error || '');
    return `  ${icon} ${s.step}${detail ? ' → ' + detail : ''}`;
  }).join('\n');

  const results = result.results
    ? '\n\n--- Final Results ---\n' + JSON.stringify(result.results, null, 2).slice(0, 2000)
    : '';

  macroResultArea.textContent = header + '\n' + stepsHtml + results;
}

// ---------------------------------------------------------------------------
// Persist in-progress edits — debounced save on input/change so the user
// doesn't lose their macro JSON / inputs / preset / filter when the popup
// closes (Chrome destroys the popup DOM on close, but storage survives).
// ---------------------------------------------------------------------------

macroInputsTextarea.addEventListener('input', scheduleSavePopupState);
macroJsonTextarea.addEventListener('input', scheduleSavePopupState);

// Cleanup on popup close
window.addEventListener('beforeunload', () => {
  // Flush any pending state save so the user's last edits aren't lost.
  if (saveStateTimer) {
    clearTimeout(saveStateTimer);
    savePopupState();  // fire-and-forget — popup is closing anyway
  }
  if (refreshInterval) clearInterval(refreshInterval);
});

// ---------------------------------------------------------------------------
// Quick Exec — run a SINGLE command through the same engine the macro runner
// uses (executeMacroStep in background.js). This is the "extension as a
// sandbox" surface: any of the 23 commands, on demand, with the raw JSON
// result rendered. {{inputs.x}} templates resolve against the optional
// "inputs" object.
// ---------------------------------------------------------------------------

const quickExecJsonTextarea = document.getElementById('quickExecJson');
const quickExecBtn = document.getElementById('quickExecBtn');
const quickExecResultEl = document.getElementById('quickExecResult');

let pendingQuickExecId = null;

quickExecJsonTextarea.value = JSON.stringify({ cmd: 'tabs.list' }, null, 2);

quickExecJsonTextarea.addEventListener('input', scheduleSavePopupState);

quickExecBtn.addEventListener('click', async () => {
  let step;
  try {
    step = JSON.parse(quickExecJsonTextarea.value);
    if (!step || typeof step !== 'object' || !step.cmd) {
      throw new Error('Command must be an object with a "cmd" field');
    }
  } catch (e) {
    quickExecResultEl.textContent = '✗ Invalid command JSON: ' + e.message;
    return;
  }
  const id = 'qe-' + Date.now();
  pendingQuickExecId = id;
  quickExecBtn.disabled = true;
  quickExecBtn.textContent = 'Running...';
  quickExecResultEl.textContent = '⏳ Running ' + step.cmd + '...';
  try {
    await chrome.runtime.sendMessage({ type: 'quickExec', id, step });
  } catch (e) {
    quickExecResultEl.textContent = '✗ Failed to send: ' + e.message;
    quickExecBtn.disabled = false;
    quickExecBtn.textContent = '⚡ Run Command';
    pendingQuickExecId = null;
  }
  // Result arrives via the 'quickExec-result' push message (listener above).
  // Safety net: re-enable the button after 90s regardless.
  setTimeout(() => {
    quickExecBtn.disabled = false;
    quickExecBtn.textContent = '⚡ Run Command';
    if (pendingQuickExecId === id) {
      pendingQuickExecId = null;
      quickExecResultEl.textContent += '\n⚠ Timed out waiting for result.';
    }
  }, 90000);
});

function renderQuickExecResult(result) {
  quickExecBtn.disabled = false;
  quickExecBtn.textContent = '⚡ Run Command';
  let text;
  try {
    text = JSON.stringify(result, null, 2);
  } catch (e) {
    text = String(result);
  }
  if (text.length > 6000) text = text.slice(0, 6000) + '\n... (' + text.length + ' chars total)';
  quickExecResultEl.textContent = (result && result.ok === false ? '✗ ' : '✓ ') + text;
}

// ---------------------------------------------------------------------------
// Diagnostics & Capture panel
//
// Renders the live capture ring from the background service worker. Supports:
//   - Export full capture buffer as JSON (masked)
//   - Export as HAR (browser devtools-compatible)
//   - Clear the buffer (after confirm)
//   - Filter by event type (fetch / ws / macro / form / error)
//   - Toggle capture on/off
//   - Toggle WS forwarding on/off
//
// The capture ring lives in the background SW (not the popup) so it survives
// popup close. The popup just queries + renders.
// ---------------------------------------------------------------------------

const exportCaptureBtn = document.getElementById('exportCaptureBtn');
const exportHarBtn = document.getElementById('exportHarBtn');
const captureStatsEl = document.getElementById('captureStats');
const captureFilterEl = document.getElementById('captureFilter');
const captureEnabledChk = document.getElementById('captureEnabled');
const captureForwardWsChk = document.getElementById('captureForwardWs');
// Note: clearLogBtn is already defined above (line 18) — reused for clearing capture buffer

let captureRing = [];        // last fetched ring (masked events)
let captureFilter = '';      // current filter

// Load persisted capture toggle states (so the checkboxes reflect the SW state)
(async () => {
  const stored = await chrome.storage.local.get(['captureEnabled', 'captureForwardWs']);
  if (typeof stored.captureEnabled === 'boolean') captureEnabledChk.checked = stored.captureEnabled;
  if (typeof stored.captureForwardWs === 'boolean') captureForwardWsChk.checked = stored.captureForwardWs;
})();

// ---------------------------------------------------------------------------
// Render the capture list (filtered, last 50 events, auto-scroll to bottom)
// ---------------------------------------------------------------------------

function eventMatchesFilter(event, filter) {
  if (!filter) return true;
  const t = event.type || '';
  const d = event.data || {};
  switch (filter) {
    case 'fetch':
      return t === 'fetch';
    case 'ws':
      return t === 'ws.send' || t === 'ws.recv' || t.startsWith('ws.');
    case 'macro':
      return t.startsWith('macro.');
    case 'form':
      return t.startsWith('form.');
    case 'error':
      // errors only — match events with ok=false OR error in data
      return d.ok === false || d.error || d.level === 'error' || t === 'result.error' || t === 'state.error';
    default:
      return true;
  }
}

function renderCaptureList() {
  // Unified log: merge old-style logEntries (from getStatus.log) with captureRing.
  // Both are rendered into #logArea — no separate capture list anymore.
  const allEntries = [...(logEntries || []).map(e => ({
    ts: new Date(e.ts).getTime() || 0,
    iso: e.ts,
    type: 'log',
    data: { level: e.level, message: e.message, ...(e.data ? { data: e.data } : {}) },
  })), ...(captureRing || [])];
  
  if (allEntries.length === 0) {
    logArea.innerHTML = '<div style="color:#666;font-style:italic;">No activity yet. Run a macro or connect to a backend.</div>';
    return;
  }
  const filtered = allEntries.filter(e => eventMatchesFilter(e, captureFilter));
  const slice = filtered.slice(-80);
  const html = slice.map(e => {
    const time = (e.iso || '').split('T')[1]?.split('.')[0] || '';
    const type = e.type || '?';
    const id = e.id ? ` #${String(e.id).slice(0, 12)}` : '';
    let detail = '';
    try {
      const data = e.data || {};
      switch (type) {
        case 'fetch':
          detail = `${data.method || 'GET'} ${data.url || '?'} → ${data.status || (data.error ? 'ERR' : '?')}${data.durationMs ? ` (${data.durationMs}ms)` : ''}`;
          break;
        case 'ws.recv':
          detail = `← ${(data.message && data.message.type) || 'msg'}`;
          break;
        case 'ws.send':
          detail = `→ ${(data.message && data.message.type) || 'msg'}`;
          break;
        case 'macro.step':
          detail = `${e.data.stepId || '?'}: ${e.data.cmd || '?'} ${e.data.ok ? '✓' : '✗'}`;
          break;
        case 'macro.start':
          detail = `"${e.data.name}" (${e.data.stepCount} steps)`;
          break;
        case 'macro.complete':
          detail = `"${e.data.name}" ${e.data.ok ? '✓' : '✗'} (${e.data.durationMs}ms)`;
          break;
        case 'macro.retry':
          detail = `attempt ${e.data.attempt} (${e.data.stepId || '?'}) ${e.data.lastOk === false ? '✗' : '…'}`;
          break;
        case 'sandbox.open':
          detail = `${e.data.url} ${e.data.ok ? '✓' : '✗'}`;
          break;
        case 'form.eval':
        case 'form.fill':
        case 'form.click':
        case 'form.wait':
          detail = `tab=${e.data.tabId} sel=${(e.data.selector || (e.data.functionSource || '').slice(0, 40) || '?')}${e.data.ok ? ' ✓' : ' ✗'}`;
          break;
        case 'cookies.getAll':
          detail = `${e.data.url} (${e.data.count} cookies)`;
          break;
        case 'cookies.set':
          detail = `${e.data.url} set ${e.data.count} cookies`;
          break;
        case 'cookies.remove':
          detail = `${e.data.url} removed ${e.data.removed}/${e.data.requested}`;
          break;
        case 'cookies.get':
          detail = `${e.data.url} ${e.data.name} found=${e.data.found}`;
          break;
        case 'xhr.intercept':
          detail = `${e.data.urlPattern} ${e.data.phase || ''} ${e.data.matchedUrl || ''}${e.data.ok === false ? ' ✗' : ''}`;
          break;
        case 'eval':
          detail = `tab=${e.data.tabId} ${e.data.ok ? '✓' : '✗'}${e.data.error ? ' ' + e.data.error.slice(0, 80) : ''}`;
          break;
        case 'state.connect':
          detail = `${e.data.status || ''}${e.data.url ? ' ' + e.data.url : ''}`;
          break;
        case 'state.disconnect':
          detail = `code=${e.data.code || ''} ${e.data.reason || e.data.source || ''}`;
          break;
        case 'state.error':
          detail = e.data.lastError || e.data.error || '';
          break;
        case 'log':
          detail = `[${e.data.level}] ${e.data.message}`;
          break;
        case 'result.send':
          detail = `ok=${e.data.result && e.data.result.ok}`;
          break;
        case 'result.error':
          detail = e.data.error || '';
          break;
        case 'screenshot':
          detail = `tab=${e.data.tabId} (${e.data.len} bytes)`;
          break;
        case 'tabs.open':
          detail = `${e.data.url} → tab=${e.data.tabId}`;
          break;
        case 'tabs.close':
        case 'tabs.focus':
          detail = `tab=${e.data.tabId}`;
          break;
        case 'tabs.list':
          detail = `${e.data.count} tabs`;
          break;
        case 'getCaptchaToken':
          detail = `${e.data.source || ''} ${e.data.ok ? '✓' : '✗'}`;
          break;
        default:
          detail = JSON.stringify(e.data).slice(0, 120);
      }
    } catch (err) {
      detail = '<render error: ' + err.message + '>';
    }
    const isError = e.data && (e.data.ok === false || e.data.error || e.data.level === 'error');
    const color = isError ? '#db4437' : type.startsWith('ws.') ? '#4285f4'
      : type.startsWith('macro.') ? '#0f9d58'
      : type.startsWith('form.') ? '#f4b400'
      : '#d4d4d4';
    return `<div class="log-entry ${type.split('.')[0] || 'info'}" style="color:${color};"><span class="log-time">${time}</span> <span class="log-level">${type}${id}</span> ${escapeHtml(detail)}</div>`;
  }).join('');
  logArea.innerHTML = html;
  // Auto-scroll to bottom (newest events)
  logArea.scrollTop = logArea.scrollHeight;
}

// ---------------------------------------------------------------------------
// Refresh the capture ring from the background. Called every 2s by the polling
// interval below. The popup also receives 'capture-event' push messages from
// the background for live updates between polls.
// ---------------------------------------------------------------------------

async function refreshCapture() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'getCaptureRing' });
    if (resp && resp.ok) {
      captureRing = resp.ring || [];
      renderCaptureList();
    }
  } catch (e) {
    // Background service worker might be starting up
  }
}

// ---------------------------------------------------------------------------
// Update the capture stats line (called from refreshStatus above)
// ---------------------------------------------------------------------------

function renderCaptureStats(capture) {
  if (!capture) return;
  const fwdStatus = capture.enabled === false ? 'OFF'
    : capture.forwardWs && capture.wsConnected ? 'LIVE'
    : capture.forwardWs ? 'CACHED'
    : 'LOCAL';
  captureStatsEl.textContent = `${capture.totalEvents || 0} events · ${fwdStatus}${capture.lastPersistError ? ' ⚠' : ''}`;
}

// ---------------------------------------------------------------------------
// Export buttons
// ---------------------------------------------------------------------------

function downloadBlob(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function timestampForFilename() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

exportCaptureBtn.addEventListener('click', async () => {
  exportCaptureBtn.textContent = '⏳ Exporting...';
  exportCaptureBtn.disabled = true;
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'getCaptureBuffer' });
    if (!resp || !resp.ok) {
      alert('Failed to get capture buffer: ' + (resp && resp.error ? resp.error : 'unknown'));
      return;
    }
    const payload = {
      schema: 'notion-onboarding-capture/v1',
      exportedAt: resp.exportedAt,
      agentId: resp.agentId,
      serverUrl: resp.serverUrl,
      totalEvents: resp.totalEvents,
      ring: resp.ring,
      fullLog: resp.fullLog,
    };
    const filename = `notion-capture-${timestampForFilename()}.json`;
    downloadBlob(filename, JSON.stringify(payload, null, 2), 'application/json');
  } catch (e) {
    alert('Export failed: ' + e.message);
  } finally {
    exportCaptureBtn.textContent = '📥 Export Capture (JSON)';
    exportCaptureBtn.disabled = false;
  }
});

exportHarBtn.addEventListener('click', async () => {
  exportHarBtn.textContent = '⏳ Building HAR...';
  exportHarBtn.disabled = true;
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'getCaptureBuffer' });
    if (!resp || !resp.ok) {
      alert('Failed to get capture buffer: ' + (resp && resp.error ? resp.error : 'unknown'));
      return;
    }
    const har = captureToHar(resp.ring, resp.fullLog, resp.exportedAt, resp.agentId);
    const filename = `notion-capture-${timestampForFilename()}.har`;
    downloadBlob(filename, JSON.stringify(har, null, 2), 'application/json');
  } catch (e) {
    alert('HAR export failed: ' + e.message);
  } finally {
    exportHarBtn.textContent = '📋 Export as HAR';
    exportHarBtn.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Convert capture events (fetch + xhr.intercept) into a HAR 1.2 archive.
// HAR spec: http://www.softwareishard.com/blog/har-12-spec/
// ---------------------------------------------------------------------------

function captureToHar(ring, fullLog, exportedAt, agentId) {
  // Combine ring + fullLog, dedup by ts+type, sort by ts ascending
  const allEvents = (ring || []).concat(fullLog || []);
  const seen = new Set();
  const deduped = [];
  for (const e of allEvents) {
    const key = `${e.ts}|${e.type}|${e.id || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(e);
  }
  deduped.sort((a, b) => (a.ts || 0) - (b.ts || 0));

  const entries = [];
  for (const e of deduped) {
    if (e.type !== 'fetch' && e.type !== 'xhr.intercept') continue;
    const d = e.data || {};
    const startedDateTime = new Date(e.ts).toISOString();
    const url = d.url || d.matchedUrl || '';
    if (!url) continue;
    const method = d.method || 'GET';
    const status = d.status || d.responseStatus || 0;

    // Request
    const reqHeaders = Object.entries(d.reqHeaders || d.requestHeaders || {}).map(([name, value]) => ({ name, value: String(value) }));
    const reqPostData = d.reqBody || d.requestBody;
    const queryString = [];
    try {
      const u = new URL(url);
      for (const [name, value] of u.searchParams.entries()) {
        queryString.push({ name, value });
      }
    } catch (err) { /* not a URL */ }

    // Response
    const respHeaders = Object.entries(d.respHeaders || d.responseHeaders || {}).map(([name, value]) => ({ name, value: String(value) }));
    const respBody = d.respBody || d.responseBody || '';
    const respMimeType = (respHeaders.find(h => h.name.toLowerCase() === 'content-type') || {}).value || 'application/json';

    entries.push({
      startedDateTime,
      time: d.durationMs || 0,
      request: {
        method,
        url,
        httpVersion: 'HTTP/1.1',
        cookies: [],
        headers: reqHeaders,
        queryString,
        headersSize: -1,
        bodySize: reqPostData ? String(reqPostData).length : 0,
        postData: reqPostData ? {
          mimeType: 'application/json',
          text: typeof reqPostData === 'string' ? reqPostData : JSON.stringify(reqPostData),
        } : undefined,
      },
      response: {
        status,
        statusText: d.statusText || '',
        httpVersion: 'HTTP/1.1',
        cookies: [],
        headers: respHeaders,
        redirectURL: '',
        headersSize: -1,
        bodySize: respBody ? respBody.length : 0,
        content: {
          size: respBody ? respBody.length : 0,
          mimeType: respMimeType,
          text: respBody,
        },
      },
      cache: {},
      timings: { send: 0, wait: d.durationMs || 0, receive: 0 },
      // Custom field — preserved by HAR consumers that ignore unknown fields
      _captureType: e.type,
      _captureId: e.id,
      _captureContext: d.context,
      _captureTabId: d.tabId,
    });
  }

  return {
    log: {
      version: '1.2',
      creator: {
        name: 'Onboard Automation Bridge',
        version: '0.7.2',
      },
      pages: [],
      entries,
      // Custom metadata — not part of HAR spec but useful for downstream tools
      _meta: {
        exportedAt,
        agentId,
        totalCaptureEvents: deduped.length,
        harEntries: entries.length,
        note: 'Generated from extension capture buffer. Sensitive fields are masked (first 8 chars + "...<masked>").',
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Clear button
// ---------------------------------------------------------------------------

// Reuse the existing clearLogBtn (defined at top of file) for clearing capture buffer
clearLogBtn.addEventListener('click', async () => {
  if (!confirm('Clear the entire capture buffer + log? This cannot be undone.')) {
    return;
  }
  try {
    await chrome.runtime.sendMessage({ type: 'clearLog' });
    await chrome.runtime.sendMessage({ type: 'clearCapture' });
    logEntries = [];
    captureRing = [];
    renderCaptureList();
    refreshStatus();
  } catch (e) {
    alert('Clear failed: ' + e.message);
  }
});

// ---------------------------------------------------------------------------
// Filter dropdown
// ---------------------------------------------------------------------------

captureFilterEl.addEventListener('change', () => {
  captureFilter = captureFilterEl.value;
  renderCaptureList();
  scheduleSavePopupState();  // persist the selected filter
});

// ---------------------------------------------------------------------------
// Toggles
// ---------------------------------------------------------------------------

captureEnabledChk.addEventListener('change', async () => {
  try {
    await chrome.runtime.sendMessage({ type: 'setCaptureEnabled', enabled: captureEnabledChk.checked });
  } catch (e) {
    alert('Failed to toggle capture: ' + e.message);
    captureEnabledChk.checked = !captureEnabledChk.checked;
  }
});

captureForwardWsChk.addEventListener('change', async () => {
  try {
    await chrome.runtime.sendMessage({ type: 'setCaptureForwardWs', enabled: captureForwardWsChk.checked });
  } catch (e) {
    alert('Failed to toggle WS forwarding: ' + e.message);
    captureForwardWsChk.checked = !captureForwardWsChk.checked;
  }
});

// ---------------------------------------------------------------------------
// Live updates: listen for 'status' messages that include capture stats.
// (The 'capture-event' listener is already handled in the unified listener
// above — no duplicate listener needed here.)
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'status' && msg.status && msg.status.capture) {
    renderCaptureStats(msg.status.capture);
    // Sync checkbox state if the SW changed it (e.g., via WS command from backend)
    if (typeof msg.status.capture.enabled === 'boolean' && msg.status.capture.enabled !== captureEnabledChk.checked) {
      captureEnabledChk.checked = msg.status.capture.enabled;
    }
    if (typeof msg.status.capture.forwardWs === 'boolean' && msg.status.capture.forwardWs !== captureForwardWsChk.checked) {
      captureForwardWsChk.checked = msg.status.capture.forwardWs;
    }
  }
});

// Initial render + start polling
refreshCapture();
setInterval(refreshCapture, 2000);

// ---------------------------------------------------------------------------
// Restore persisted popup state — runs LAST, after all `const` declarations
// of the DOM elements we read from are in scope. This way the user's
// in-progress macro edits / preset / filter survive popup close.
// ---------------------------------------------------------------------------

(async () => {
  const persisted = await loadPopupState();
  if (!persisted || Object.keys(persisted).length === 0) {
    // First-time load — leave the defaults in place (already set above).
    return;
  }

  // Restore the preset dropdown. If the user had a preset selected, load
  // the corresponding macro JSON from the bundled file (so the macro
  // textarea is populated). If the user had customized the macro JSON,
  // we leave their customizations alone.
  if (persisted.macroPreset && macroPresetSelect) {
    macroPresetSelect.value = persisted.macroPreset;
    // Trigger the change handler to load the preset's macro JSON, but only
    // if the user hasn't customized the macro JSON (otherwise we'd overwrite
    // their edits).
    if (!persisted.macroJson) {
      macroPresetSelect.dispatchEvent(new Event('change'));
    }
  }

  // Restore the inputs textarea (override the defaults we set earlier).
  if (persisted.macroInputs && macroInputsTextarea) {
    macroInputsTextarea.value = persisted.macroInputs;
  }

  // Restore the macro JSON textarea (either user-customized or preset-loaded).
  if (persisted.macroJson && macroJsonTextarea) {
    macroJsonTextarea.value = persisted.macroJson;
  }

  // Restore the capture filter dropdown.
  if (persisted.captureFilter && captureFilterEl) {
    captureFilterEl.value = persisted.captureFilter;
    captureFilter = persisted.captureFilter;
    renderCaptureList();  // re-render with the restored filter
  }

  // Restore the Quick Exec command.
  if (persisted.quickExecJson && quickExecJsonTextarea) {
    quickExecJsonTextarea.value = persisted.quickExecJson;
  }
})();

