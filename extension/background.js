/**
 * Onboard Automation Bridge — Background Service Worker
 *
 * This extension is a DUMB INTERACTION PROXY. It contains ZERO business logic.
 * It connects to the Python backend via WebSocket and executes commands from
 * the real browser context. All intelligence lives on the Python side.
 *
 * Protocol:
 *   Server → Extension:
 *     {type: 'fetch', id, url, method, headers, body, credentials, timeoutMs}

 *     {type: 'tabs.open', id, url, active}
 *     {type: 'tabs.close', id, tabId}
 *     {type: 'tabs.list', id}
 *     {type: 'tabs.focus', id, tabId}
 *     {type: 'form.fill', id, tabId, selector, value}
 *     {type: 'form.click', id, tabId, selector}
 *     {type: 'form.wait', id, tabId, selector, timeoutMs}
 *     {type: 'form.eval', id, tabId, function, args}
 *     {type: 'xhr.intercept', id, tabId, urlPattern, method, timeoutMs}
 *     {type: 'cookies.get', id, url, name}
 *     {type: 'cookies.getAll', id, url}
 *     {type: 'cookies.set', id, url, cookies}
 *     {type: 'screenshot', id, tabId}
 *     {type: 'ping'}
 *
 *   Extension → Server:
 *     {type: 'auth', token}
 *     {type: 'connect', agentId, userAgent, hostname}
 *     {type: 'result', id, ok, status, body, headers, finalUrl, error}
 *     {type: 'xhr.event', id, method, url, status, requestBody, responseBody, requestHeaders, responseHeaders}
 *     {type: 'pong'}
 *     {type: 'log', level, message, data}
 *
 * Debuggability:
 *   - Every command received is logged to console + popup + server
 *   - Every result sent is logged with full context
 *   - XHR interceptions include request body + response body + headers
 *   - The popup shows a live activity feed
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let ws = null;
let keepaliveInterval = null;
let reconnectTimeout = null;  // tracks the auto-reconnect setTimeout so we can cancel it

// Turso persistence (optional — no-op when tursoUrl/tursoToken not configured)
import { recordMacroRun, recordStepResult, captureToken } from './lib/turso.js';

const state = {
  status: 'disconnected',  // disconnected | connecting | connected | connected-http | error
  serverUrl: '',
  authToken: '',
  agentId: '',  // populated by loadConfig() — persisted across SW restarts
  connectedAt: null,
  lastError: null,
  commandsReceived: 0,
  commandsCompleted: 0,
  commandsFailed: 0,
  lastCommandAt: null,
  lastServerMsgAt: null,       // for watchdog — last time we heard from the server
  reconnectAttempts: 0,        // for exponential backoff
  log: [],
  // XHR interception state: {interceptId: {urlPattern, method, tabId, resolve}}
  interceptors: new Map(),
  // Pending command promises: {commandId: resolve}
  pending: new Map(),
  // Pending macro step results: {subId: resolve}
  pendingMacroResults: new Map(),
  // Macro run control: only one macro at a time; Stop button sets the flag.
  macroRunning: false,
  macroCancelRequested: false,
  // Reference-counted debugger sessions: tabId -> Set<holder>
  // (holders: 'macro' for the current run, 'xhr:<id>' per interceptor,
  //  'adhoc' for one-shot evals). Attach/detach is refcounted so features
  //  sharing a tab don't kill each other's debugger session.
  debuggerHolders: new Map(),
};

const MAX_LOG = 200;

// ---------------------------------------------------------------------------
// Capture Buffer — comprehensive diagnostics + traffic capture
//
// Records EVERY event (fetch, ws, form, cookies, xhr, macro, log, state) into
// a ring buffer (last 1000 events in memory) and an append-only log (capped at
// 5MB in chrome.storage.local). The buffer survives service worker restarts
// (loaded from chrome.storage.local on startup) and backend disconnects (events
// are cached locally and forwarded via WS on reconnect).
//
// Privacy: sensitive fields (token_v2, notion_user_id, captchaToken, etc.)
// are masked in the persisted buffer + WS-forwarded events. The raw in-memory
// buffer keeps them so the user can verify which token was used without leaking
// it to the backend/logs.
// ---------------------------------------------------------------------------

const CAPTURE_RING_MAX = 1000;        // in-memory ring buffer size
const CAPTURE_LOG_MAX_BYTES = 5 * 1024 * 1024;  // 5MB cap on persisted log
const CAPTURE_PERSIST_EVERY = 10;     // persist to chrome.storage.local every N events
const CAPTURE_SENSITIVE_KEYS = new Set([
  'token_v2', 'notion_user_id', 'notion_device_id', 'captchaToken',
  'password', 'access_token', 'refresh_token', 'secret', 'cookie',
  'authorization', 'x-notion-active-user-header',
  'set-cookie', 'token',  // 'token' catches bare captcha/session tokens in results
]);

// Body-like field names — these are string fields that may contain JSON with
// sensitive values. maskSensitive() tries to JSON.parse them, mask the parsed
// object, and re-stringify. If parsing fails, applies regex token masking.
const CAPTURE_BODY_KEYS = new Set([
  'reqBody', 'respBody', 'requestBody', 'responseBody', 'body',
]);

// Maximum length of any string value stored in the ring buffer. Bodies larger
// than this are truncated (the full body is still sent to the caller via
// sendResult — only the capture record is truncated).
const CAPTURE_MAX_STRING_LEN = 4096;

// Pre-compiled regex patterns for masking token-like patterns in body strings.
// Each pattern matches "key":"value" where key is sensitive and value is 8+ chars.
const CAPTURE_TOKEN_PATTERNS = [];
for (const _key of CAPTURE_SENSITIVE_KEYS) {
  CAPTURE_TOKEN_PATTERNS.push(new RegExp(
    '(["\']' + _key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '["\']\\s*:\\s*["\'])([^"\']{8,})(["\'])',
    'gi'
  ));
}

const captureState = {
  enabled: true,            // master toggle (popup can disable)
  forwardWs: true,          // forward each capture event as {type: "capture", event} to backend
  ring: [],                 // in-memory ring buffer (last CAPTURE_RING_MAX events)
  persistCount: 0,          // counter for throttled persistence
  pendingPersist: false,    // debounce flag
  totalEvents: 0,           // total events captured since clear (not just ring size)
  lastPersistError: null,
  initialized: false,
  seqCounter: 0,            // monotonic event counter (for append-only log tracking)
  lastPersistedSeq: 0,      // seq of the last event appended to captureLog
};

// ---------------------------------------------------------------------------
// Output Store — structured critical results that the backend needs.
//
// Unlike the capture ring (which records ALL events for diagnostics), the
// output store holds ONLY the critical results that the backend would need
// to persist: signup credentials, workspace IDs, API keys, etc.
//
// Architecture:
//   - Extension runs a macro (or receives commands from backend)
//   - Each step produces output (fetch response, eval result, etc.)
//   - Critical outputs are saved to the output store (chrome.storage.local)
//   - If the backend is connected, outputs are forwarded immediately
//   - If the backend is disconnected, outputs are cached locally
//   - On reconnect, all unsent outputs are flushed to the backend
//
// The backend can then process these outputs at its leisure — no need for
// turn-by-turn involvement unless there's special logic.
//
// Output record format:
//   {
//     id: "out_<uuid>",           // unique ID for dedup
//     ts: 1234567890,             // epoch ms
//     type: "signup_result" | "workspace_created" | "api_key" | ...,
//     macroName: "signup-onboard", // which macro produced this
//     stepId: "create-space",     // which step produced this
//     data: { ... },              // the critical data (userId, spaceId, etc.)
//     sent: false,                // has this been sent to the backend?
//   }
// ---------------------------------------------------------------------------
const outputStore = {
  records: [],         // unsent records (persisted to chrome.storage.local)
  maxRecords: 100,     // cap to prevent unbounded growth
};

async function saveOutput(type, macroName, stepId, data) {
  const record = {
    id: 'out_' + crypto.randomUUID(),
    ts: Date.now(),
    type,
    macroName,
    stepId,
    data,
    sent: false,
  };
  outputStore.records.push(record);
  if (outputStore.records.length > outputStore.maxRecords) {
    outputStore.records = outputStore.records.slice(-outputStore.maxRecords);
  }
  // Persist to chrome.storage.local
  try {
    await chrome.storage.local.set({ outputStore: outputStore.records });
  } catch (e) { /* best-effort */ }
  // Try to send immediately if WS is connected
  flushOutputs();
  log('info', 'output-saved', { type, stepId, sent: ws && ws.readyState === WebSocket.OPEN });
}

async function flushOutputs() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const unsent = outputStore.records.filter(r => !r.sent);
  if (!unsent.length) return;
  try {
    ws.send(JSON.stringify({
      type: 'outputs',
      records: unsent,
      flush: true,
    }));
    // Mark as sent
    for (const r of unsent) r.sent = true;
    // Persist the updated sent state
    await chrome.storage.local.set({ outputStore: outputStore.records });
    log('info', 'outputs-flushed', { count: unsent.length });
  } catch (e) {
    log('warn', 'outputs-flush-failed', { error: e.message });
  }
}

async function loadOutputStore() {
  try {
    const stored = await chrome.storage.local.get('outputStore');
    if (Array.isArray(stored.outputStore)) {
      outputStore.records = stored.outputStore;
    }
  } catch (e) { /* ignore */ }
}

// Mask a single sensitive string: show first 8 chars + "...".
function maskValue(v) {
  if (typeof v !== 'string') return v;
  if (v.length <= 8) return '<masked>';
  return v.slice(0, 8) + '...<masked>';
}

// Best-effort regex masking of token-like patterns in a text string. Catches
// sensitive values embedded in JSON strings that maskSensitive can't reach
// (e.g., a response body string containing "token_v2":"<long value>").
function maskTokensInText(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  for (const pattern of CAPTURE_TOKEN_PATTERNS) {
    text = text.replace(pattern, (m, p1, p2, p3) => p1 + p2.slice(0, 8) + '...<masked>' + p3);
  }
  return text;
}

// Mask a body-like string field. Tries JSON.parse → maskSensitive →
// JSON.stringify. Falls back to regex token masking if the string isn't valid
// JSON (e.g., form-encoded, HTML, binary).
function maskBodyString(str) {
  if (typeof str !== 'string' || str.length === 0) return str;
  // Skip if already masked (avoids double-masking on re-persist).
  if (str.includes('...<masked>')) return str;
  try {
    const parsed = JSON.parse(str);
    return JSON.stringify(maskSensitive(parsed));
  } catch {
    return maskTokensInText(str);
  }
}

// Deep-truncate all string values in an object to CAPTURE_MAX_STRING_LEN.
// Prevents large response bodies from blowing the ring buffer + storage quota.
function truncateDeep(obj, depth) {
  if (depth === undefined) depth = 0;
  if (depth > 8) return '<too-deep>';
  if (typeof obj === 'string') {
    if (obj.length > CAPTURE_MAX_STRING_LEN) {
      return obj.slice(0, CAPTURE_MAX_STRING_LEN) + '...<truncated, ' + obj.length + ' chars total>';
    }
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(v => truncateDeep(v, depth + 1));
  }
  if (obj !== null && typeof obj === 'object') {
    const out = {};
    for (const k of Object.keys(obj)) {
      out[k] = truncateDeep(obj[k], depth + 1);
    }
    return out;
  }
  return obj;
}

// Deep-clone an object + mask sensitive fields. Handles:
//   - Sensitive keys (token_v2, notion_user_id, set-cookie, token, etc.) → maskValue
//   - Body-like keys (reqBody, respBody, body, etc.) → maskBodyString (JSON parse + mask)
//   - Nested objects/arrays → recurse
function maskSensitive(obj, depth) {
  if (depth === undefined) depth = 0;
  if (depth > 6) return obj;  // bail out deep nests
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    return obj.map(v => maskSensitive(v, depth + 1));
  }
  const out = {};
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    const lowerK = k.toLowerCase();
    if (CAPTURE_SENSITIVE_KEYS.has(lowerK)) {
      out[k] = maskValue(v);
    } else if (CAPTURE_BODY_KEYS.has(lowerK) && typeof v === 'string' && v.length > 0) {
      out[k] = maskBodyString(v);
    } else if (typeof v === 'object' && v !== null) {
      out[k] = maskSensitive(v, depth + 1);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// Estimate the byte size of a JSON-serializable value (rough — used for capping).
function estimateBytes(obj) {
  try { return JSON.stringify(obj).length; } catch { return 1024; }
}

// Persist the ring buffer + the append-only captureLog to chrome.storage.local.
// Throttled: at most one persistence in flight at a time (debounced via flag).
// If the captureLog exceeds CAPTURE_LOG_MAX_BYTES, drop the oldest 50%.
async function persistCapture() {
  if (captureState.pendingPersist) return;
  captureState.pendingPersist = true;
  try {
    const maskedRing = captureState.ring.map(e => maskSensitive(e));
    const ringBytes = estimateBytes(maskedRing);

    // Append to the persisted captureLog (append-only, capped).
    // Track which events have been appended via a monotonic seq counter.
    // Using ring.length (as the previous version did) breaks once the ring
    // wraps at CAPTURE_RING_MAX — lastPersistedLength would stay at 1000 and
    // slice(1000) returns [], silently dropping ALL new events from the log.
    const existing = await chrome.storage.local.get(['captureLog', 'captureBuffer']);
    let captureLog = Array.isArray(existing.captureLog) ? existing.captureLog : [];
    const lastSeq = captureState.lastPersistedSeq || 0;
    const newEvents = maskedRing.filter(e => (e.seq || 0) > lastSeq);
    if (newEvents.length > 0) {
      captureLog = captureLog.concat(newEvents);
      // Advance the marker to the last new event's seq
      captureState.lastPersistedSeq = newEvents[newEvents.length - 1].seq;
    }

    // Cap the captureLog at CAPTURE_LOG_MAX_BYTES
    let logBytes = estimateBytes(captureLog);
    if (logBytes > CAPTURE_LOG_MAX_BYTES) {
      // Drop oldest 50% to make room
      const dropCount = Math.ceil(captureLog.length / 2);
      captureLog = captureLog.slice(dropCount);
      log('warn', 'capture-log-trimmed', {
        dropped: dropCount,
        newBytes: estimateBytes(captureLog),
        maxBytes: CAPTURE_LOG_MAX_BYTES,
      });
    }

    await chrome.storage.local.set({
      captureBuffer: maskedRing,        // latest ring (overwrite)
      captureLog: captureLog,            // append-only log
      captureStats: {
        totalEvents: captureState.totalEvents,
        ringBytes,
        logBytes,
        lastPersistAt: Date.now(),
        lastPersistedSeq: captureState.lastPersistedSeq,
      },
    });
    captureState.lastPersistError = null;
  } catch (err) {
    captureState.lastPersistError = err.message;
    // Don't let capture failures break the actual operation
    console.warn('[notion-bridge] capture persist failed:', err.message);
  } finally {
    captureState.pendingPersist = false;
  }
}

// Load the persisted capture buffer on startup. Called once from the IIFE at
// the bottom of this file (after loadConfig).
//
// MERGES the persisted ring with the current in-memory ring (dedup by ts+type+id)
// rather than overwriting — this prevents data loss if events are captured
// between SW startup and load completion (e.g., a WS message arrives before
// the async chrome.storage.local.get resolves).
async function loadCaptureFromStorage() {
  if (captureState.initialized) return;
  captureState.initialized = true;
  try {
    const existing = await chrome.storage.local.get([
      'captureBuffer', 'captureLog', 'captureEnabled', 'captureForwardWs',
    ]);
    if (typeof existing.captureEnabled === 'boolean') {
      captureState.enabled = existing.captureEnabled;
    }
    if (typeof existing.captureForwardWs === 'boolean') {
      captureState.forwardWs = existing.captureForwardWs;
    }
    // Restore totalEvents + lastPersistedSeq from captureStats if present
    const stats = await chrome.storage.local.get('captureStats');
    if (stats.captureStats) {
      if (typeof stats.captureStats.totalEvents === 'number') {
        captureState.totalEvents = stats.captureStats.totalEvents;
      }
      if (typeof stats.captureStats.lastPersistedSeq === 'number') {
        captureState.lastPersistedSeq = stats.captureStats.lastPersistedSeq;
      }
    }
    // Merge persisted ring with in-memory ring (dedup by ts+type+id)
    if (Array.isArray(existing.captureBuffer) && existing.captureBuffer.length > 0) {
      const seenKeys = new Set(captureState.ring.map(e => `${e.ts}|${e.type}|${e.id || ''}`));
      const merged = [...captureState.ring];
      for (const e of existing.captureBuffer) {
        const key = `${e.ts}|${e.type}|${e.id || ''}`;
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          merged.push(e);
        }
      }
      // Sort by ts ascending, then cap at CAPTURE_RING_MAX (drop oldest)
      merged.sort((a, b) => (a.ts || 0) - (b.ts || 0));
      captureState.ring = merged.slice(-CAPTURE_RING_MAX);
      // Set lastPersistedSeq to the max seq in the merged ring so that
      // persistCapture only appends NEW events (captured after this load).
      // Events without a seq field (old format) are treated as seq=0.
      let maxSeq = captureState.lastPersistedSeq || 0;
      for (const e of captureState.ring) {
        if (typeof e.seq === 'number' && e.seq > maxSeq) maxSeq = e.seq;
      }
      captureState.lastPersistedSeq = maxSeq;
      // Bump totalEvents if the merged ring is larger (catches events captured
      // before load completed)
      if (captureState.ring.length > captureState.totalEvents) {
        captureState.totalEvents = captureState.ring.length;
      }
      // Bump seqCounter so new events don't collide with restored seqs
      if (maxSeq > captureState.seqCounter) captureState.seqCounter = maxSeq;
      console.log(`[notion-bridge] capture buffer restored: ${existing.captureBuffer.length} persisted + ${merged.length - existing.captureBuffer.length} new = ${captureState.ring.length} total (lastSeq=${maxSeq})`);
    }
  } catch (err) {
    console.warn('[notion-bridge] capture buffer load failed:', err.message);
  }
}

// Forward a capture event to the backend via WS (best-effort, masked).
function forwardCaptureToWs(event) {
  if (!captureState.forwardWs) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify({ type: 'capture', event: maskSensitive(event) }));
  } catch (e) {
    // WS send failed — event is still in the ring + persisted log
  }
}

// The main capture function. Stamps the event with ts/iso, pushes to the ring
// buffer, throttles persistence to chrome.storage.local, and forwards to the
// backend via WS (best-effort).
//
// NEVER throws — capture failures must not break the actual operation.
function capture(type, data, opts) {
  if (!captureState.enabled) return;
  try {
    const now = Date.now();
    const event = {
      ts: now,
      iso: new Date(now).toISOString(),
      type,
      id: (opts && opts.id) || undefined,
      seq: ++captureState.seqCounter,
      // Deep-truncate large strings (e.g., 5MB fetch response bodies) to
      // CAPTURE_MAX_STRING_LEN so the ring buffer + storage don't blow up.
      data: truncateDeep(data || {}, 0),
    };
    // Push to ring buffer (auto-evict oldest when full)
    captureState.ring.push(event);
    if (captureState.ring.length > CAPTURE_RING_MAX) {
      captureState.ring.shift();
    }
    captureState.totalEvents++;
    captureState.persistCount++;
    // Throttled persistence (every CAPTURE_PERSIST_EVERY events)
    if (captureState.persistCount >= CAPTURE_PERSIST_EVERY) {
      captureState.persistCount = 0;
      // Fire-and-forget — don't await
      persistCapture().catch(() => {});
    }
    // Forward via WS (best-effort)
    forwardCaptureToWs(event);
    // Notify popup if open (so the diagnostics panel can live-update)
    try {
      chrome.runtime.sendMessage({ type: 'capture-event', event: maskSensitive(event) });
    } catch (e) { /* popup not open */ }
  } catch (err) {
    // Never let capture break the actual operation
    console.warn('[notion-bridge] capture() failed:', err.message);
  }
}

// Clear the capture buffer (both in-memory and persisted log).
async function clearCapture() {
  captureState.ring = [];
  captureState.totalEvents = 0;
  captureState.lastPersistedSeq = 0;
  captureState.seqCounter = 0;
  captureState.persistCount = 0;
  try {
    await chrome.storage.local.remove(['captureBuffer', 'captureLog', 'captureStats']);
  } catch (err) {
    console.warn('[notion-bridge] capture clear failed:', err.message);
  }
  log('info', 'capture-cleared', {});
}

// Get the full capture buffer (masked) for export.
async function getCaptureBuffer() {
  // Trigger a persist (best-effort) so the captureLog archive is flushed.
  // Don't await — the in-memory ring is always current and is the primary
  // source for the 'ring' field below. Awaiting persistCapture() would return
  // stale data if another persist is already in flight (the debounce flag
  // causes the second call to return immediately, before storage is updated).
  persistCapture().catch(() => {});
  // Return the in-memory ring (always current) + the persisted captureLog
  // (the append-only archive). Both are masked before returning.
  const existing = await chrome.storage.local.get(['captureLog']);
  const fullLog = Array.isArray(existing.captureLog) ? existing.captureLog : [];
  return {
    ring: captureState.ring.map(e => maskSensitive(e)),
    fullLog: fullLog.map(e => maskSensitive(e)),
    totalEvents: captureState.totalEvents,
    exportedAt: new Date().toISOString(),
    agentId: state.agentId,
    serverUrl: state.serverUrl,
  };
}

// ---------------------------------------------------------------------------
// Logging — both to console, popup, and server
// ---------------------------------------------------------------------------

function log(level, message, data) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
    data: data || undefined,
  };
  console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](`[notion-bridge] ${message}`, data || '');

  state.log.push(entry);
  if (state.log.length > MAX_LOG) state.log.shift();

  // Capture the log entry (so it appears in the diagnostics panel + exports)
  // Note: capture() masks sensitive fields, so log('info', '...', { token_v2 })
  // will be masked in the export but not in the console.
  capture('log', { level, message, data }, {});

  // Send to server (best-effort)
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ type: 'log', level, message, data }));
    } catch (e) { /* ignore */ }
  }

  // Notify popup if open
  try { chrome.runtime.sendMessage({ type: 'log', entry }); } catch (e) { /* popup not open */ }
}

// ---------------------------------------------------------------------------
// Config persistence
// ---------------------------------------------------------------------------

async function loadConfig() {
  const cfg = await chrome.storage.local.get(['serverUrl', 'autoConnect', 'authToken', 'agentId']);
  // C3 fix: persist agentId across service worker restarts
  let agentId = cfg.agentId;
  if (!agentId) {
    agentId = 'ext-' + Math.random().toString(36).slice(2, 8);
    await chrome.storage.local.set({ agentId });
  }
  // Populate state.agentId as a side effect so every caller (IIFE, onInstalled,
  // onStartup, popup connect, HTTP polling) has it set before connect().
  state.agentId = agentId;
  return {
    // Default to EMPTY — the extension runs standalone (no WS, no HTTP polling)
    // unless the user explicitly configures a dev daemon URL (WS) or worker URL
    // (HTTP, Phase 2) via the popup. This is the unified-extension default:
    // macros run locally, results stay in-memory unless Turso is configured.
    serverUrl: cfg.serverUrl || '',
    autoConnect: cfg.autoConnect !== false,
    authToken: cfg.authToken || '',
    agentId,
  };
}

async function saveConfig(patch) {
  await chrome.storage.local.set(patch);
}

// ---------------------------------------------------------------------------
// WebSocket connection
// ---------------------------------------------------------------------------

function buildWsUrl(rawUrl) {
  let url = rawUrl.trim().replace(/\/+$/, '');
  // Convert http(s):// to ws(s)://
  if (url.startsWith('http://')) url = 'ws://' + url.slice(7);
  else if (url.startsWith('https://')) url = 'wss://' + url.slice(8);
  // Add ws:// prefix if no scheme
  else if (!url.startsWith('ws://') && !url.startsWith('wss://')) url = 'wss://' + url;

  const parsed = new URL(url);

  // For *.space-z.ai preview URLs, the bridge listens on port 3000 which is
  // the Caddy gateway's default proxy target — no XTransformPort needed.
  // For other hostnames (localhost, *.workers.dev, direct IPs), keep the URL
  // as-is — they connect directly without a Caddy gateway in front.
  const isSpaceZai = parsed.hostname.endsWith('.space-z.ai');

  if (isSpaceZai) {
    // The Caddy gateway only upgrades WebSocket connections when the path
    // is "/". Don't add XTransformPort since the bridge is on the default
    // port 3000 — if the user has moved the bridge to a non-default port,
    // they should include ?XTransformPort=<port> in the serverUrl themselves.
    parsed.pathname = '/';
  }

  return parsed.toString();
}

/**
 * Build an HTTP URL from the configured server URL by:
 *   - converting ws(s):// → http(s)://
 *   - stripping any trailing /ws path
 *   - appending the given `path`
 *
 * For *.space-z.ai preview URLs, the bridge listens on port 3000 (the Caddy
 * gateway's default proxy target), so no XTransformPort query param is added.
 * If the user has moved the bridge to a non-default port, they should include
 * ?XTransformPort=<port> in the serverUrl themselves and we'll preserve it.
 *
 * `extraQuery` is an optional object of additional query params to merge
 * (e.g. { agentId: 'ext-abc', wait: 25 } for /api/poll).
 *
 * This is the HTTP-side counterpart to buildWsUrl() — both must agree on
 * the XTransformPort handling for space-z.ai preview URLs.
 */
function buildHttpUrl(rawUrl, path, extraQuery) {
  let url = (rawUrl || '').trim().replace(/\/+$/, '');
  if (!url) return '';
  // Convert ws:// → http:// or wss:// → https://
  if (url.startsWith('ws://')) url = 'http://' + url.slice(5);
  else if (url.startsWith('wss://')) url = 'https://' + url.slice(6);
  // Strip any /ws suffix (legacy direct-WS endpoint alias)
  url = url.replace(/\/ws$/, '');
  const parsed = new URL(url);
  // No longer auto-add XTransformPort — the bridge defaults to port 3000
  // (Caddy's default proxy target). Users who move the bridge to a non-
  // default port must include ?XTransformPort=<port> in their serverUrl.
  if (extraQuery) {
    for (const [k, v] of Object.entries(extraQuery)) {
      if (!parsed.searchParams.has(k)) parsed.searchParams.set(k, String(v));
    }
  }
  // Replace the origin's empty pathname with the given path.
  parsed.pathname = path;
  return parsed.toString();
}

// ---------------------------------------------------------------------------
// HTTP fallback polling (SOS satellite mode)
// When WebSocket can't stay alive (MV3 service worker died, network blocks WS,
// browser was dormant), the extension falls back to long-polling GET /api/poll
// for commands. Results are POSTed to /api/result. This keeps the extension
// functional even when WS is dead — the Worker's BridgeHub DO serves the same
// command queue via HTTP that it would via WS.
//
// Ported from supabase-automation/extension/background.js (SOS mode).
// ---------------------------------------------------------------------------

let httpPollActive = false;

async function startHttpPolling() {
  if (httpPollActive) return;
  httpPollActive = true;
  log('info', 'http-poll-start', { agentId: state.agentId });

  while (httpPollActive) {
    try {
      const cfg = await loadConfig();
      if (!cfg.serverUrl) break;
      // Build the poll URL with XTransformPort for space-z.ai preview URLs.
      // The bridge's /api/poll handler records a heartbeat (so /api/extensions
      // can see active HTTP-polling agents) before returning commands.
      const httpUrl = buildHttpUrl(cfg.serverUrl, '/api/poll', {
        agentId: state.agentId,
        wait: 25,
      });

      const r = await fetch(httpUrl, { method: 'GET' });
      if (r.ok) {
        const data = await r.json();
        const commands = data.commands || [];
        for (const cmd of commands) {
          // Mark ourselves as alive via HTTP (distinct from WS 'connected')
          if (state.status !== 'connected') {
            state.status = 'connected-http';
            state.connectedAt = Date.now();
            state.lastServerMsgAt = Date.now();
            broadcastStatus();
          }
          log('info', 'http-cmd-received', { type: cmd.type, id: cmd.id });
          state.commandsReceived++;
          state.lastCommandAt = Date.now();
          broadcastStatus();
          await handleCommand(cmd);
        }
      }
    } catch (e) {
      log('warn', 'http-poll-error', { error: e.message });
      // Backoff on errors (5s, same as supabase)
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
  httpPollActive = false;
  log('info', 'http-poll-stop');
}

function stopHttpPolling() {
  httpPollActive = false;
}

// ---------------------------------------------------------------------------
// HTTP fallback for sending results back to the server
// Called from sendResult() when ws.readyState != OPEN.
// POSTs the result to /api/result — the BridgeHub DO resolves the pending
// WS future for the same command ID (cross-channel consistency).
// ---------------------------------------------------------------------------

async function sendResultHttp(msg) {
  // I1 fix: retry 3× with exponential backoff (1s/2s/4s) so results aren't
  // lost on transient network failures or Worker redeploys.
  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const cfg = await loadConfig();
      if (!cfg.serverUrl) return;
      const httpUrl = buildHttpUrl(cfg.serverUrl, '/api/result');
      const r = await fetch(httpUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(msg),
      });
      if (r.ok) {
        state.commandsCompleted++;
        log('debug', 'result-sent-http', { id: msg.id, attempt });
        return;  // success — stop retrying
      } else {
        log('warn', 'result-http-failed', { id: msg.id, status: r.status, attempt });
      }
    } catch (e) {
      log('warn', 'result-http-error', { id: msg.id, error: e.message, attempt });
    }
    // Exponential backoff: 1s, 2s, 4s
    if (attempt < maxRetries - 1) {
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
    }
  }
  log('error', 'result-http-give-up', { id: msg.id, retries: maxRetries });
}

// ---------------------------------------------------------------------------
// Watchdog: force-reconnect if no server message in 90s
// Uses chrome.alarms (MV3-friendly — survives service worker restarts).
// Catches the case where the network silently drops (no TCP RST, no WS close
// frame) — the only way to detect this is by absence of pings/pongs.
// ---------------------------------------------------------------------------

chrome.alarms.create('watchdog', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'watchdog') return;
  if (state.status === 'connected' && state.lastServerMsgAt) {
    const silenceMs = Date.now() - state.lastServerMsgAt;
    // Don't trip the watchdog if there are commands in flight (e.g.,
    // xhr.intercept can wait minutes for hCaptcha + email worker).
    // The bridge sends a 'ping' every 25s which refreshes
    // lastServerMsgAt — so this only fires if the bridge truly went silent.
    // But as an extra safety net, skip if we have any pending commands.
    const hasPending = state.commandsReceived > state.commandsCompleted + state.commandsFailed;
    if (silenceMs > 90000 && !hasPending) {
      log('warn', 'watchdog-force-reconnect', { silenceMs, hasPending });
      // Force-close the WS — onclose will trigger reconnect + SOS
      if (ws) {
        try { ws.close(4000, 'watchdog: no server message in 90s'); } catch {}
      }
    } else if (silenceMs > 90000 && hasPending) {
      // Long-running command in flight — log but don't reconnect
      log('debug', 'watchdog-skip-pending-commands', { silenceMs, hasPending });
    }
  }
});

// ---------------------------------------------------------------------------
// Browser dormancy detection: heal on wake
// chrome.idle.onStateChanged fires when the browser goes idle → active.
// On 'active' transition, proactively reconnect (the WS likely died while
// the laptop was sleeping).
// ---------------------------------------------------------------------------

chrome.idle.onStateChanged.addListener((idleState) => {
  if (idleState === 'active') {
    log('info', 'browser-wake-detected', { idleState });
    // If we're not cleanly connected, force a reconnect
    if (state.status !== 'connected' && state.serverUrl) {
      log('info', 'healing-on-wake');
      // Reset backoff on wake — give it a fresh start
      state.reconnectAttempts = 0;
      connect(state.serverUrl);
    } else if (ws && ws.readyState !== WebSocket.OPEN && state.serverUrl) {
      // Status says connected but WS isn't actually open — heal
      log('info', 'healing-on-wake-stale-ws');
      state.reconnectAttempts = 0;
      connect(state.serverUrl);
    }
  }
});

async function connect(rawUrl) {
  if (state.status === 'connecting' || state.status === 'connected') {
    log('warn', 'already connected or connecting');
    return;
  }

  const url = buildWsUrl(rawUrl);
  state.serverUrl = rawUrl;
  state.status = 'connecting';
  state.lastError = null;
  broadcastStatus();

  log('info', 'connecting', { url });
  capture('state.connect', { url, agentId: state.agentId, status: 'connecting' });

  // PRIMARY MODE: Start HTTP polling immediately.
  // This works with ANY backend (Python bridge, Worker, etc.) and doesn't
  // require a persistent WS or Durable Object. The extension polls
  // GET /api/poll?agentId=X&wait=N for commands and POSTs results to
  // /api/result. This is the most reliable mode.
  startHttpPolling();
  state.status = 'connected-http';
  state.connectedAt = Date.now();
  state.lastError = null;
  state.lastServerMsgAt = Date.now();
  broadcastStatus();
  log('info', 'http-polling-active', { agentId: state.agentId, url });

  // SECONDARY MODE: Also try to establish a WS connection for lower latency.
  // If the WS connects, we get push-based commands instead of polling.
  // If it fails, we fall back to HTTP polling (which is already running).
  // Use the shared buildWsUrl() helper so the WS URL agrees with the HTTP
  // URL on XTransformPort (8787 for *.space-z.ai preview URLs).
  const wsUrl = buildWsUrl(rawUrl);

  try {
    ws = new WebSocket(wsUrl);
  } catch (err) {
    log('debug', 'ws-connect-failed-continuing-with-http', { error: err.message });
    // HTTP polling is already running — don't treat WS failure as an error
    return;
  }

  ws.onopen = () => {
    state.status = 'connected';
    state.connectedAt = Date.now();
    state.lastError = null;
    state.lastServerMsgAt = Date.now();
    state.reconnectAttempts = 0;  // reset backoff on successful connect

    // CRITICAL FIX: cancel any pending reconnect setTimeout from a previous
    // onclose. Without this, stale timeouts fire after a new connection is
    // already established, creating duplicate WS connections that trigger
    // the BridgeHub's "superseded by new connection" (code 4002) close —
    // causing an infinite reconnect loop.
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      reconnectTimeout = null;
    }

    log('info', 'ws-connected', { url, reconnectAttempts: state.reconnectAttempts });
    capture('state.connect', { url, ok: true, status: 'connected', connectedAt: state.connectedAt });

    // Stop HTTP fallback polling — WS is alive now
    stopHttpPolling();

    // Send auth + connect messages
    ws.send(JSON.stringify({ type: 'auth', token: state.authToken || '' }));
    capture('ws.send', { message: { type: 'auth', token: state.authToken ? '<masked>' : '' } });
    ws.send(JSON.stringify({
      type: 'connect',
      agentId: state.agentId,
      userAgent: navigator.userAgent,
      hostname: 'chrome-extension',
    }));
    capture('ws.send', { message: { type: 'connect', agentId: state.agentId, hostname: 'chrome-extension' } });

    // Keepalive ping every 10s.
    // - MV3 service workers die after 30s of inactivity — 10s is safe.
    // - The bridge's /api/extensions endpoint uses a 30s heartbeat window;
    //   pinging every 10s keeps the heartbeat fresh (3 pings per window).
    // - The DO writes a D1 heartbeat row on each pong, which makes the
    //   WS-connected extension visible to the stateless /api/extensions
    //   and checkExtensionConnected() helpers (otherwise they'd only see
    //   HTTP-polling extensions).
    if (keepaliveInterval) clearInterval(keepaliveInterval);
    keepaliveInterval = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
      } else {
        clearInterval(keepaliveInterval);
        keepaliveInterval = null;
      }
    }, 10000);

    // On reconnect, send the full capture buffer to the backend so it gets any
    // events it missed during the disconnect. Best-effort — if the WS send
    // fails, the events are still in the persisted captureLog for later export.
    if (captureState.forwardWs) {
      getCaptureBuffer().then(buf => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        try {
          ws.send(JSON.stringify({
            type: 'captureBuffer',
            buffer: buf.ring,
            fullLog: buf.fullLog.slice(-200),  // last 200 events to avoid huge payloads
            totalEvents: buf.totalEvents,
            reconnect: true,
          }));
        } catch (e) { /* best-effort */ }
      }).catch(() => {});
    }

    // Also flush any unsent output records (critical results from macros
    // that ran while the backend was disconnected)
    flushOutputs();

    broadcastStatus();
  };

  ws.onmessage = async (event) => {
    state.lastServerMsgAt = Date.now();  // track for watchdog
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (err) {
      log('warn', 'invalid-message', { raw: event.data.slice(0, 200) });
      capture('ws.recv', { raw: event.data.slice(0, 500), parseError: err.message });
      return;
    }
    // Capture every received WS command
    capture('ws.recv', { message: msg }, { id: msg.id });
    await handleCommand(msg);
  };

  ws.onerror = (event) => {
    state.status = 'error';
    state.lastError = 'WebSocket error (check server URL and network)';
    log('error', 'ws-error', { event: String(event) });
    capture('state.error', { source: 'ws', status: 'error', lastError: state.lastError });
    broadcastStatus();
  };

  ws.onclose = (event) => {
    // CRITICAL: only handle onclose if this is STILL the current WebSocket.
    if (ws !== event.target) {
      log('debug', 'ignoring-close-from-stale-ws', { code: event.code, reason: event.reason });
      return;
    }
    ws = null;  // clear the reference
    if (keepaliveInterval) {
      clearInterval(keepaliveInterval);
      keepaliveInterval = null;
    }
    log('info', 'ws-disconnected', { code: event.code, reason: event.reason });

    // Don't change state.status to 'disconnected' — HTTP polling is still
    // running (or will be restarted below). The extension stays "connected"
    // via HTTP polling even if the WS dies.
    if (state.status === 'connected') {
      state.status = 'connected-http';  // downgrade to HTTP-only
      broadcastStatus();
    }

    // If HTTP polling isn't running, start it (SOS mode)
    if (!httpPollActive && state.serverUrl && event.code !== 1000) {
      startHttpPolling();
    }

    // Don't auto-reconnect WS — HTTP polling is the primary mode now.
    // Only reconnect WS if the user explicitly clicks "Connect" again.
    // (The WS was a secondary optimization for push-based commands.)
  };
}

function disconnect() {
  // C1 fix: stop HTTP polling before clearing state
  stopHttpPolling();
  // Cancel any pending reconnect timeout
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
  state.serverUrl = '';
  if (keepaliveInterval) {
    clearInterval(keepaliveInterval);
    keepaliveInterval = null;
  }
  if (ws) {
    ws.close(1000, 'user disconnect');
    ws = null;
  }
  state.status = 'disconnected';
  state.connectedAt = null;
  broadcastStatus();
  log('info', 'disconnected-by-user');
  capture('state.disconnect', { source: 'user', status: 'disconnected' });
}

// ---------------------------------------------------------------------------
// Send result back to server
// ---------------------------------------------------------------------------

function sendResult(id, result) {
  // Capture the result (always — even for macro sub-steps) so the diagnostics
  // panel shows the full command/result timeline.
  capture('result.send', { id, result: summarizeForCapture(result) }, { id });
  // Check if this result is for a pending macro step.
  // Macro sub-steps have synthetic ids like "macro-abc123" — their results
  // are captured by the macro runner via state.pendingMacroResults and must
  // NOT be forwarded to the WS/HTTP backend (the backend didn't issue them).
  if (state.pendingMacroResults && state.pendingMacroResults.has(id)) {
    const resolve = state.pendingMacroResults.get(id);
    state.pendingMacroResults.delete(id);
    resolve(result);
    state.commandsCompleted++;
    log('debug', 'macro-result-captured', { id, ok: result.ok });
    broadcastStatus();
    return;
  }
  const msg = { type: 'result', id, ...result };
  capture('ws.send', { message: { type: 'result', id, ok: result.ok, ...('status' in result ? { status: result.status } : {}) } }, { id });
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
    state.commandsCompleted++;
    log('debug', 'result-sent-ws', { id, ok: result.ok, ...('status' in result ? { status: result.status } : {}) });
  } else {
    // WS is down — POST the result via HTTP (SOS mode)
    sendResultHttp(msg);
  }
  broadcastStatus();
}

function sendError(id, error) {
  // Capture the error
  capture('result.error', { id, error: String(error) }, { id });
  // Check if this error is for a pending macro step (same logic as sendResult).
  if (state.pendingMacroResults && state.pendingMacroResults.has(id)) {
    const resolve = state.pendingMacroResults.get(id);
    state.pendingMacroResults.delete(id);
    resolve({ ok: false, error: String(error) });
    state.commandsFailed++;
    log('error', 'macro-step-failed', { id, error });
    broadcastStatus();
    return;
  }
  state.commandsFailed++;
  log('error', 'command-failed', { id, error });
  const msg = { type: 'result', id, ok: false, error: String(error) };
  capture('ws.send', { message: msg }, { id });
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  } else {
    sendResultHttp(msg);
  }
  broadcastStatus();
}

// Summarize a result for capture (truncate large bodies so the ring buffer
// doesn't blow up on a 5MB API response). Bodies are capped at 4KB in capture
// events — the full body is preserved in the actual result sent to the caller.
function summarizeForCapture(result) {
  if (!result || typeof result !== 'object') return result;
  const out = {};
  for (const k of Object.keys(result)) {
    const v = result[k];
    if (typeof v === 'string' && v.length > 4096) {
      out[k] = v.slice(0, 4096) + `...<truncated, ${v.length} chars total>`;
    } else if (typeof v === 'object' && v !== null) {
      try {
        const json = JSON.stringify(v);
        if (json.length > 4096) {
          out[k] = json.slice(0, 4096) + `...<truncated, ${json.length} chars total>`;
        } else {
          out[k] = v;
        }
      } catch {
        out[k] = '<unserializable>';
      }
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Command dispatcher
// ---------------------------------------------------------------------------

async function handleCommand(msg) {
  if (msg.type === 'ping') {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
    }
    return;
  }

  if (!msg.id) {
    log('warn', 'command-missing-id', { type: msg.type });
    return;
  }

  state.commandsReceived++;
  state.lastCommandAt = Date.now();
  log('info', 'command-received', { id: msg.id, type: msg.type, ...('url' in msg ? { url: msg.url } : {}) });
  broadcastStatus();

  try {
    switch (msg.type) {
      case 'fetch':
        await handleFetch(msg);
        break;
      case 'page.fetch':
        await handlePageFetch(msg);
        break;
      case 'tabs.open':
        await handleTabsOpen(msg);
        break;
      case 'tabs.close':
        await handleTabsClose(msg);
        break;
      case 'tabs.list':
        await handleTabsList(msg);
        break;
      case 'tabs.focus':
        await handleTabsFocus(msg);
        break;
      case 'form.fill':
        await handleFormFill(msg);
        break;
      case 'form.click':
        await handleFormClick(msg);
        break;
      case 'form.wait':
        await handleFormWait(msg);
        break;
      case 'form.eval':
        await handleFormEval(msg);
        break;
      case 'xhr.intercept':
        await handleXhrIntercept(msg);
        break;
      case 'cookies.get':
        await handleCookiesGet(msg);
        break;
      case 'cookies.getAll':
        await handleCookiesGetAll(msg);
        break;
      case 'cookies.set':
        await handleCookiesSet(msg);
        break;
      case 'cookies.remove':
        await handleCookiesRemove(msg);
        break;
      case 'storage.clear':
        await handleStorageClear(msg);
        break;
      case 'eval':
        await handleEval(msg);
        break;
      case 'screenshot':
        await handleScreenshot(msg);
        break;
      case 'getCaptchaToken':
        await handleGetCaptchaToken(msg);
        break;
      case 'sandbox.open':
        // Open the sandbox page as a new tab
        const sandboxUrl = chrome.runtime.getURL('sandbox.html');
        await chrome.tabs.create({ url: sandboxUrl, active: false });
        log('info', 'sandbox-opened', { url: sandboxUrl });
        capture('sandbox.open', { url: sandboxUrl, ok: true }, { id: msg.id });
        sendResult(msg.id, { ok: true, url: sandboxUrl });
        break;
      case 'macro.run':
        // Local macro replay — runs a JSON macro of steps without needing
        // a backend. See MACROS.md for the format.
        await handleMacroRun(msg);
        break;
      // --- Diagnostics / capture buffer commands (from popup or backend) ---
      case 'getCaptureBuffer':
        {
          const buf = await getCaptureBuffer();
          sendResult(msg.id, { ok: true, ...buf });
        }
        break;
      case 'setCaptureEnabled':
        captureState.enabled = !!msg.enabled;
        await chrome.storage.local.set({ captureEnabled: captureState.enabled });
        log('info', 'capture-toggle', { enabled: captureState.enabled });
        sendResult(msg.id, { ok: true, enabled: captureState.enabled });
        broadcastStatus();
        break;
      case 'setCaptureForwardWs':
        captureState.forwardWs = !!msg.enabled;
        await chrome.storage.local.set({ captureForwardWs: captureState.forwardWs });
        log('info', 'capture-forward-ws-toggle', { enabled: captureState.forwardWs });
        sendResult(msg.id, { ok: true, enabled: captureState.forwardWs });
        broadcastStatus();
        break;
      case 'clearCapture':
        await clearCapture();
        sendResult(msg.id, { ok: true });
        broadcastStatus();
        break;
      default:
        log('warn', 'unknown-command', { type: msg.type });
        sendError(msg.id, `Unknown command type: ${msg.type}`);
    }
  } catch (err) {
    sendError(msg.id, err.message || String(err));
  }
}

// ---------------------------------------------------------------------------
// Command: fetch — execute fetch() from the extension's browser context
// ---------------------------------------------------------------------------

async function handleFetch(cmd) {
  const { id, url, method, headers, body, credentials, timeoutMs } = cmd;
  log('debug', 'fetch-start', { id, url, method });
  const startTime = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 30000);

  try {
    const fetchOptions = {
      method: method || 'GET',
      headers: headers || {},
      credentials: credentials || 'include',
      redirect: 'follow',
      signal: controller.signal,
    };
    if (body && method !== 'GET' && method !== 'HEAD') {
      fetchOptions.body = body;
    }

    const res = await fetch(url, fetchOptions);

    // Read the response body, handling zstd/gzip/deflate decompression.
    // Chrome's service worker fetch() does NOT automatically decompress zstd
    // (even though the browser's main fetch pipeline does). We use
    // DecompressionStream (Chrome 143+) to handle zstd manually.
    let responseBody;
    const contentEncoding = res.headers.get('content-encoding') || '';

    if (contentEncoding.includes('zstd')) {
      // Decompress zstd using DecompressionStream API (Chrome 143+)
      try {
        const ds = new DecompressionStream('zstd');
        const decompressed = res.body.pipeThrough(ds);
        responseBody = await new Response(decompressed).text();
      } catch (e) {
        // Fallback: try reading as text (might get garbled, but at least we try)
        log('warn', 'fetch-zstd-decompress-failed', { id, url, error: e.message });
        responseBody = await res.text();
      }
    } else {
      // gzip/deflate are handled natively by fetch().text()
      responseBody = await res.text();
    }

    const responseHeaders = {};
    res.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    const durationMs = Date.now() - startTime;
    log('debug', 'fetch-done', { id, url, status: res.status, bodyLen: responseBody.length, encoding: contentEncoding });

    // Capture the full fetch request + response (masked + truncated for ring buffer).
    // The full body is sent in sendResult() — capture uses summarizeForCapture
    // to truncate at 4KB so the ring buffer doesn't blow up on 5MB responses.
    capture('fetch', {
      url,
      method: method || 'GET',
      reqHeaders: headers || {},
      reqBody: body,
      status: res.status,
      statusText: res.statusText,
      respHeaders: responseHeaders,
      respBody: responseBody,
      finalUrl: res.url,
      encoding: contentEncoding,
      durationMs,
      ok: res.ok,
      context: 'service-worker',
    }, { id });

    sendResult(id, {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      body: responseBody,
      finalUrl: res.url,
      headers: responseHeaders,
    });
  } catch (err) {
    const durationMs = Date.now() - startTime;
    log('error', 'fetch-error', { id, url, error: err.message });
    capture('fetch', {
      url,
      method: method || 'GET',
      reqHeaders: headers || {},
      reqBody: body,
      status: 0,
      error: err.message,
      durationMs,
      ok: false,
      context: 'service-worker',
    }, { id });
    sendError(id, err.message);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Command: tabs.open / tabs.close / tabs.list / tabs.focus
// ---------------------------------------------------------------------------

async function handleTabsOpen(cmd) {
  const { id, url, active } = cmd;
  const tab = await chrome.tabs.create({ url, active: active !== false });
  log('info', 'tab-opened', { id, tabId: tab.id, url });
  capture('tabs.open', { url, active: active !== false, tabId: tab.id, ok: true }, { id });
  // Wait for the tab to finish loading
  await waitForTabLoaded(tab.id, 30000);
  sendResult(id, { ok: true, tabId: tab.id, url: tab.url });
}

async function handleTabsClose(cmd) {
  const { id, tabId } = cmd;
  await chrome.tabs.remove(tabId);
  log('info', 'tab-closed', { id, tabId });
  capture('tabs.close', { tabId, ok: true }, { id });
  sendResult(id, { ok: true });
}

async function handleTabsList(cmd) {
  const { id } = cmd;
  const tabs = await chrome.tabs.query({});
  const simplified = tabs.map(t => ({
    id: t.id,
    url: t.url,
    title: t.title,
    active: t.active,
    windowId: t.windowId,
  }));
  capture('tabs.list', { count: simplified.length, ok: true }, { id });
  sendResult(id, { ok: true, tabs: simplified });
}

async function handleTabsFocus(cmd) {
  const { id, tabId } = cmd;
  await chrome.tabs.update(tabId, { active: true });
  capture('tabs.focus', { tabId, ok: true }, { id });
  sendResult(id, { ok: true });
}

function waitForTabLoaded(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const cleanup = () => {
      clearTimeout(timer);
      clearInterval(poll);
      chrome.tabs.onUpdated.removeListener(listener);
    };
    const succeed = () => {
      if (done) return;
      done = true;
      cleanup();
      // Small extra delay for JS frameworks to render
      setTimeout(resolve, 500);
    };
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      reject(new Error(`Tab ${tabId} did not finish loading within ${timeoutMs}ms`));
    }, timeoutMs);

    function listener(tabId_, changeInfo, tab) {
      if (tabId_ === tabId && changeInfo.status === 'complete') {
        succeed();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);

    // Poll as well — on fast-loading pages (local servers, cached pages) the
    // 'complete' onUpdated event can fire before the listener attaches, and
    // the one-shot tabs.get below can read a stale 'loading' status. A 250ms
    // poll closes that race for good.
    const poll = setInterval(async () => {
      if (done) return;
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab && tab.status === 'complete') succeed();
      } catch (e) { /* tab gone — the timeout will fire */ }
    }, 250);

    // Check if already loaded
    chrome.tabs.get(tabId, (tab) => {
      if (tab && tab.status === 'complete') {
        succeed();
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Command: form.fill / form.click / form.wait / form.eval
// ---------------------------------------------------------------------------

async function handleFormFill(cmd) {
  const { id, tabId, selector, value } = cmd;
  const startTime = Date.now();
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel, val) => {
      const el = document.querySelector(sel);
      if (!el) return { ok: false, error: `Element not found: ${sel}` };
      // Set value using the native input setter (works for React-controlled inputs)
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      const nativeTextareaValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      if (el.tagName === 'TEXTAREA') {
        nativeTextareaValueSetter.call(el, val);
      } else {
        nativeInputValueSetter.call(el, val);
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, value: el.value };
    },
    args: [selector, value],
  });
  const result = results[0]?.result || { ok: false, error: 'No result' };
  const durationMs = Date.now() - startTime;
  log('debug', 'form.fill', { id, tabId, selector, value, ok: result.ok });
  capture('form.fill', { tabId, selector, value, result, durationMs, ok: result.ok }, { id });
  sendResult(id, result);
}

async function handleFormClick(cmd) {
  const { id, tabId, selector } = cmd;
  const startTime = Date.now();
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel) => {
      const el = document.querySelector(sel);
      if (!el) return { ok: false, error: `Element not found: ${sel}` };
      el.click();
      return { ok: true };
    },
    args: [selector],
  });
  const result = results[0]?.result || { ok: false, error: 'No result' };
  const durationMs = Date.now() - startTime;
  log('debug', 'form.click', { id, tabId, selector, ok: result.ok });
  capture('form.click', { tabId, selector, result, durationMs, ok: result.ok }, { id });
  sendResult(id, result);
}

async function handleFormWait(cmd) {
  const { id, tabId, selector, timeoutMs } = cmd;
  const timeout = timeoutMs || 30000;
  const startTime = Date.now();

  const poll = async () => {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (sel) => !!document.querySelector(sel),
      args: [selector],
    });
    return results[0]?.result === true;
  };

  while (Date.now() - startTime < timeout) {
    // Abort early when the user pressed Stop (only meaningful inside a macro
    // run — the flag is otherwise always false).
    if (state.macroCancelRequested) {
      log('info', 'form.wait-cancelled', { id, tabId, selector });
      capture('form.wait', { tabId, selector, found: false, cancelled: true, ok: false, error: 'cancelled by user' }, { id });
      sendResult(id, { ok: false, cancelled: true, error: 'cancelled by user' });
      return;
    }
    if (await poll()) {
      const waitedMs = Date.now() - startTime;
      log('debug', 'form.wait-found', { id, tabId, selector, ms: waitedMs });
      capture('form.wait', { tabId, selector, found: true, waitedMs, ok: true }, { id });
      sendResult(id, { ok: true, found: true, waitedMs });
      return;
    }
    await new Promise(r => setTimeout(r, 250));
  }
  const waitedMs = Date.now() - startTime;
  log('warn', 'form.wait-timeout', { id, tabId, selector, timeoutMs: timeout });
  capture('form.wait', { tabId, selector, found: false, waitedMs, ok: false, error: 'timeout' }, { id });
  sendResult(id, { ok: false, error: `Element not found within ${timeout}ms: ${selector}` });
}

async function handleFormEval(cmd) {
  const { id, tabId, function: fn, args } = cmd;
  const startTime = Date.now();
  // Use chrome.debugger + Runtime.evaluate to run JS in the page's main
  // world. This bypasses BOTH the extension's CSP (MV3 forbids unsafe-eval)
  // AND the page's CSP (debugger runs with full privileges).
  //
  // The function body is wrapped: `(function(args){ <body> })(<args>)`
  // and evaluated via Runtime.evaluate, which returns the result directly.
  try {
    // Attach the debugger (refcounted holder; 'macro' keeps it for the run)
    const feHolder = state.macroRunning ? 'macro' : 'adhoc';
    await debuggerAttach(tabId, feHolder);
    // Enable the Runtime domain
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable');
    // Build the expression — wrap the function body and call it with args
    const expression = `(function(args){ ${fn} })(${JSON.stringify(args || [])})`;
    // Evaluate in the page's main world
    const evalResult = await chrome.debugger.sendCommand(
      { tabId },
      'Runtime.evaluate',
      {
        expression: expression,
        returnByValue: true,
        awaitPromise: true,  // ← was false — needed for async functions
        userGesture: true,
      }
    );
    // Detach (release our holder; real detach only when last holder leaves)
    await debuggerDetach(tabId, feHolder);
    const durationMs = Date.now() - startTime;
    if (evalResult.exceptionDetails) {
      const exc = evalResult.exceptionDetails;
      const errMsg = exc.exception?.description || exc.text || 'Unknown error';
      capture('form.eval', {
        tabId,
        functionSource: typeof fn === 'string' ? fn.slice(0, 500) : String(fn),
        args,
        ok: false,
        error: errMsg.slice(0, 500),
        durationMs,
      }, { id });
      sendResult(id, { ok: false, error: errMsg.slice(0, 500) });
    } else {
      const value = evalResult.result?.value;
      capture('form.eval', {
        tabId,
        functionSource: typeof fn === 'string' ? fn.slice(0, 500) : String(fn),
        args,
        result: value,
        ok: true,
        durationMs,
      }, { id });
      sendResult(id, { ok: true, result: value });
    }
  } catch (err) {
    const durationMs = Date.now() - startTime;
    log('error', 'form.eval-failed', { id, tabId, error: err.message });
    capture('form.eval', {
      tabId,
      functionSource: typeof fn === 'string' ? fn.slice(0, 500) : String(fn),
      args,
      ok: false,
      error: err.message,
      durationMs,
    }, { id });
    sendResult(id, { ok: false, error: err.message });
  }
}

// ---------------------------------------------------------------------------
// Command: getCaptchaToken — read the hCaptcha response token from the page
//
// Uses chrome.scripting.executeScript with world: 'MAIN' to run a REAL
// function (not eval) in the page's main world. This gives access to
// window.hcaptcha.getResponse() without triggering CSP restrictions
// (real function references are allowed; only new Function(string) is blocked).
// No debugger banner, no CSP bypass needed.
// ---------------------------------------------------------------------------

async function handleGetCaptchaToken(cmd) {
  const { id, tabId } = cmd;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        // Try multiple ways to read the hCaptcha token
        // 1. hcaptcha.getResponse() — the official API
        // 2. document.querySelector('textarea[name="h-captcha-response"]') — fallback
        try {
          if (typeof hcaptcha !== 'undefined' && typeof hcaptcha.getResponse === 'function') {
            const token = hcaptcha.getResponse();
            if (token) return { ok: true, token: token, source: 'hcaptcha.getResponse' };
          }
        } catch (e) {}
        // Fallback: look for the hidden textarea
        const ta = document.querySelector('textarea[name="h-captcha-response"]');
        if (ta && ta.value) {
          return { ok: true, token: ta.value, source: 'textarea' };
        }
        // Check if hCaptcha iframe is even present
        const iframe = document.querySelector('iframe[src*="hcaptcha"]');
        return {
          ok: false,
          error: 'No hCaptcha token found',
          captchaPresent: !!iframe,
          hcaptchaDefined: typeof hcaptcha !== 'undefined',
        };
      },
    });
    const result = results[0]?.result || { ok: false, error: 'No result' };
    log('info', 'getCaptchaToken', { id, tabId, ok: result.ok, source: result.source });
    // Capture: token is sensitive (it's a one-time auth secret) — maskSensitive
    // will replace it with first 8 chars + "...<masked>".
    capture('getCaptchaToken', {
      tabId,
      ok: result.ok,
      source: result.source,
      captchaToken: result.token,  // masked by capture pipeline (key matches CAPTURE_SENSITIVE_KEYS)
      captchaPresent: result.captchaPresent,
      hcaptchaDefined: result.hcaptchaDefined,
      error: result.error,
    }, { id });
    sendResult(id, result);
  } catch (err) {
    log('error', 'getCaptchaToken-failed', { id, tabId, error: err.message });
    capture('getCaptchaToken', { tabId, ok: false, error: err.message }, { id });
    sendResult(id, { ok: false, error: err.message });
  }
}

// ---------------------------------------------------------------------------
// Command: xhr.intercept — intercept XHR responses matching a URL pattern
//
// Uses chrome.debugger API to attach to a tab and intercept network requests.
// When a request matches the urlPattern, captures the request body + response
// body + headers and sends them back as an xhr.event.
// ---------------------------------------------------------------------------

async function handleXhrIntercept(cmd) {
  const { id, tabId, urlPattern, method, timeoutMs } = cmd;
  const timeout = timeoutMs || 30000;

  log('info', 'xhr.intercept-start', { id, tabId, urlPattern, method });
  capture('xhr.intercept', { tabId, urlPattern, method, timeoutMs: timeout, phase: 'start' }, { id });

  // Attach the debugger to the tab under this interceptor's own holder so
  // concurrent eval/form.eval calls cannot detach it (refcounted).
  const attached = await debuggerAttach(tabId, `xhr:${id}`);
  if (!attached) {
    // Another debugger owns this tab — we can still listen if it's ours from
    // a sticky attach; if truly foreign, commands will fail below as before.
  }

  // Enable Network domain
  await chrome.debugger.sendCommand({ tabId }, 'Network.enable');

  // Set up listener for network events
  const captured = {
    requestId: null,
    requestMethod: null,
    requestUrl: null,
    requestHeaders: null,
    requestBody: null,
    responseStatus: null,
    responseHeaders: null,
    responseBody: null,
  };

  const urlRegex = new RegExp(urlPattern);

  const listener = async (source, method_, params) => {
    if (source.tabId !== tabId) return;

    if (method_ === 'Network.requestWillBeSent') {
      const url = params.request.url;
      if (urlRegex.test(url) && (!method || params.request.method === method)) {
        captured.requestId = params.requestId;
        captured.requestMethod = params.request.method;
        captured.requestUrl = url;
        captured.requestHeaders = params.request.headers;
        captured.requestBody = params.request.postData || null;
        log('info', 'xhr.intercept-request-matched', { id, url, method: params.request.method });
      }
    }

    if (method_ === 'Network.responseReceived') {
      if (params.requestId === captured.requestId) {
        captured.responseStatus = params.response.status;
        captured.responseHeaders = params.response.headers;
        log('debug', 'xhr.intercept-response-received', { id, status: params.response.status });
      }
    }

    if (method_ === 'Network.loadingFinished') {
      if (params.requestId === captured.requestId) {
        // Fetch the response body
        try {
          const bodyResp = await chrome.debugger.sendCommand(
            { tabId },
            'Network.getResponseBody',
            { requestId: params.requestId }
          );
          captured.responseBody = bodyResp.body;
        } catch (err) {
          log('warn', 'xhr.intercept-body-fetch-failed', { id, error: err.message });
        }
        // Send the captured XHR event back to the server
        log('info', 'xhr.intercept-complete', { id, url: captured.requestUrl, status: captured.responseStatus });
        // Capture the full intercepted XHR (request + response, unmasked — the
        // ring buffer's maskSensitive will mask tokens in headers/cookies).
        capture('xhr.intercept', {
          tabId,
          urlPattern,
          matchedUrl: captured.requestUrl,
          method: captured.requestMethod,
          requestHeaders: captured.requestHeaders,
          requestBody: captured.requestBody,
          responseStatus: captured.responseStatus,
          responseHeaders: captured.responseHeaders,
          responseBody: captured.responseBody,
          ok: true,
          phase: 'complete',
        }, { id });
        sendResult(id, {
          ok: true,
          xhr: {
            method: captured.requestMethod,
            url: captured.requestUrl,
            requestHeaders: captured.requestHeaders,
            requestBody: captured.requestBody,
            responseStatus: captured.responseStatus,
            responseHeaders: captured.responseHeaders,
            responseBody: captured.responseBody,
          },
        });
        // Detach (release this interceptor's holder)
        chrome.debugger.onEvent.removeListener(listener);
        await debuggerDetach(tabId, `xhr:${id}`);
      }
    }
  };

  chrome.debugger.onEvent.addListener(listener);

  // Timeout
  setTimeout(async () => {
    if (captured.requestId === null) {
      log('warn', 'xhr.intercept-timeout', { id, urlPattern, timeoutMs: timeout });
      capture('xhr.intercept', {
        tabId, urlPattern, ok: false, error: 'timeout', timeoutMs: timeout, phase: 'timeout',
      }, { id });
      chrome.debugger.onEvent.removeListener(listener);
      await debuggerDetach(tabId, `xhr:${id}`);
      sendError(id, `No XHR matching ${urlPattern} within ${timeout}ms`);
    }
  }, timeout);
}

// ---------------------------------------------------------------------------
// Command: cookies.get / cookies.getAll / cookies.set
// ---------------------------------------------------------------------------

async function handleCookiesGet(cmd) {
  const { id, url, name } = cmd;
  const cookie = await chrome.cookies.get({ url, name });
  capture('cookies.get', { url, name, found: !!cookie, ok: true }, { id });
  sendResult(id, { ok: true, cookie });
}

async function handleCookiesGetAll(cmd) {
  const { id, url } = cmd;
  const cookies = await chrome.cookies.getAll({ url });
  // Capture: list of cookie names + count (values are sensitive — masked by
  // maskSensitive, but we explicitly enumerate names for the diagnostics panel).
  capture('cookies.getAll', {
    url,
    count: cookies.length,
    names: cookies.map(c => c.name),
    ok: true,
  }, { id });
  log('debug', 'cookies.getAll', { id, url, count: cookies.length });
  sendResult(id, { ok: true, cookies });
}

async function handleCookiesSet(cmd) {
  const { id, url, cookies } = cmd;
  const results = [];
  // Derive default cookie domain from the URL hostname (service-agnostic).
  // Previously hardcoded '.notion.com' — that broke for non-notion services.
  // For IP addresses, leave domain empty (Chrome requires host-only cookies for IPs).
  let defaultDomain = '';
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    const isIP = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) || host.includes(':');
    defaultDomain = isIP ? '' : '.' + host;
  } catch {}
  for (const c of cookies) {
    const setDetails = {
      url,
      name: c.name,
      value: c.value,
      path: c.path || '/',
      secure: c.secure !== false,
      httpOnly: c.httpOnly || false,
      sameSite: c.sameSite || 'lax',
      expirationDate: c.expirationDate,
    };
    const domain = c.domain || defaultDomain;
    if (domain) setDetails.domain = domain;
    const r = await chrome.cookies.set(setDetails);
    results.push(r);
  }
  capture('cookies.set', {
    url,
    count: cookies.length,
    names: cookies.map(c => c.name),
    ok: results.length === cookies.length,
    set: results.length,
  }, { id });
  sendResult(id, { ok: true, count: results.length });
}

// ---------------------------------------------------------------------------
// Command: cookies.remove — properly remove cookies (including httpOnly)
//
// chrome.cookies.set with expirationDate:0 does NOT remove httpOnly cookies.
// chrome.cookies.remove does. This is the fix for the cookie-clearing bug
// mentioned in AUDIT.md §5.
// ---------------------------------------------------------------------------

async function handleCookiesRemove(cmd) {
  const { id, url, names } = cmd;
  // If names is specified, remove only those; otherwise remove ALL cookies
  // for the url's WHOLE registrable domain (subdomains included) — a url
  // only clear misses host-only cookies on sibling subdomains (e.g.
  // www.notion.com when the url is app.notion.com) and same-name cookies
  // on multiple domain variants.
  let cookies = [];
  try {
    const u = new URL(url);
    // eTLD+1 by dropping the leftmost label (good enough for our targets;
    // the public suffix list isn't available in the SW).
    const parts = u.hostname.split('.');
    const registrable = parts.length > 2 ? parts.slice(-2).join('.') : u.hostname;
    cookies = await chrome.cookies.getAll({ domain: registrable });
  } catch (e) {
    // fall back to plain url matching
    cookies = await chrome.cookies.getAll({ url });
  }
  const wanted = (names && Array.isArray(names) && names.length > 0)
    ? new Set(names) : null;
  let removed = 0;
  const errors = [];
  const seen = new Set();
  for (const c of cookies) {
    if (wanted && !wanted.has(c.name)) continue;
    // One removal per (name, domain, path) — construct the exact URL the
    // cookie is scoped to, so duplicates across domain variants each die.
    const key = `${c.name}|${c.domain}|${c.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const host = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain;
    const scheme = c.secure ? 'https' : 'http';
    const cookieUrl = `${scheme}://${host}${c.path || '/'}`;
    try {
      const success = await chrome.cookies.remove({ url: cookieUrl, name: c.name });
      if (success) removed++;
    } catch (e) {
      errors.push({ name: c.name, error: e.message });
    }
  }
  log('debug', 'cookies.remove', { id, url, requested: seen.size, removed, errors: errors.length });
  capture('cookies.remove', {
    url,
    requested: seen.size,
    removed,
    names: [...seen].map(s => s.split('|')[0]),
    errors: errors.length,
    ok: errors.length === 0,
  }, { id });
  sendResult(id, { ok: true, removed, errors });
}

// ---------------------------------------------------------------------------
// Command: storage.clear — wipe origin-scoped browser storage.
//
// The missing half of cookies.remove: SPAs persist app state in
// localStorage (Notion: lastVisitedRoute, current-user-id, sidebar state,
// BlockFrecency keyed by OLD user ids...), sessionStorage, IndexedDB
// (Notion's TransactionStore can queue offline transactions from a previous
// session!), and the Cache API. Cookies alone leave all of that behind —
// after a fresh login the app reads the stale state and, e.g., redirects to
// the PREVIOUS user's last visited page.
//
// Args:
//   url                (required) any URL on the origin to clear
//   clearLocalStorage  (default true)
//   clearSessionStorage(default true)
//   clearIndexedDB     (default true)  — best-effort: open connections in
//                        OTHER tabs block deletion; close them first
//   clearCaches        (default true)
//   closeOtherTabs     (default true)  — close OTHER tabs on the same
//                        origin first so IndexedDB handles are released
//
// Runs in a tab on the target origin (opens one if none exists, closes it
// afterwards if it opened it). Storage APIs are origin-scoped, so the
// isolated world is fine — no debugger needed.
// ---------------------------------------------------------------------------

async function handleStorageClear(cmd) {
  const {
    id, url,
    clearLocalStorage = true, clearSessionStorage = true,
    clearIndexedDB = true, clearCaches = true,
    closeOtherTabs = true,
  } = cmd;
  const startTime = Date.now();

  try {
    const parsed = new URL(url);
    const origin = parsed.origin;

    // Find or open a tab on this origin. Prefer the tab the caller's macro
    // is about to use (or already has open).
    let tabs = await chrome.tabs.query({ url: `${origin}/*` });
    let openedTab = null;
    if (!tabs.length) {
      openedTab = await chrome.tabs.create({ url, active: false });
      tabs = [openedTab];
      // wait for the tab to be on the origin (about:blank → navigation)
      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 250));
        const t = await chrome.tabs.get(openedTab.id);
        if (t.url && t.url.startsWith(origin)) break;
      }
    }

    // Close OTHER tabs on the same origin (they hold IndexedDB handles and
    // will also write localStorage back from their in-memory state).
    if (closeOtherTabs) {
      const keep = tabs[0].id;
      const others = (await chrome.tabs.query({ url: `${origin}/*` })).filter(t => t.id !== keep);
      for (const t of others) {
        try { await chrome.tabs.remove(t.id); } catch (e) { /* already gone */ }
      }
    }

    const tabId = tabs[0].id;
    // Small settle delay so a closing tab's beforeunload handlers finish.
    await new Promise(r => setTimeout(r, 300));

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (o, ls, ss, idb, cch) => {
        const out = { localStorage: null, sessionStorage: null, indexedDB: [], caches: [] };
        try {
          if (ls && location.origin === o) {
            const n = localStorage.length;
            localStorage.clear();
            out.localStorage = { cleared: n };
          }
        } catch (e) { out.localStorage = { error: String(e) }; }
        try {
          if (ss && location.origin === o) {
            const n = sessionStorage.length;
            sessionStorage.clear();
            out.sessionStorage = { cleared: n };
          }
        } catch (e) { out.sessionStorage = { error: String(e) }; }
        if (idb && location.origin === o && indexedDB.databases) {
          const dbs = await indexedDB.databases();
          for (const db of dbs) {
            try {
              await new Promise((res, rej) => {
                const rq = indexedDB.deleteDatabase(db.name);
                rq.onsuccess = rq.onerror = () => res();
                rq.onblocked = () => rej(new Error('blocked'));
                setTimeout(res, 3000);
              });
              out.indexedDB.push({ name: db.name, ok: true });
            } catch (e) {
              out.indexedDB.push({ name: db.name, error: String(e) });
            }
          }
        }
        if (cch && location.origin === o && window.caches) {
          try {
            for (const k of await caches.keys()) {
              const ok = await caches.delete(k);
              out.caches.push({ name: k, ok });
            }
          } catch (e) { out.caches = [{ error: String(e) }]; }
        }
        return out;
      },
      args: [origin, clearLocalStorage, clearSessionStorage, clearIndexedDB, clearCaches],
    });

    const detail = results[0]?.result || {};
    const durationMs = Date.now() - startTime;

    // Close the tab we opened just for this.
    if (openedTab) {
      try { await chrome.tabs.remove(openedTab.id); } catch (e) { /* already gone */ }
    }

    capture('storage.clear', { origin, ...detail, ok: true, durationMs }, { id });
    log('info', 'storage-clear-done', { id, origin, detail, durationMs });
    sendResult(id, { ok: true, origin, ...detail, closedOtherTabs: closeOtherTabs, openedTab: !!openedTab });
  } catch (err) {
    log('error', 'storage-clear-failed', { id, url, error: err.message });
    capture('storage.clear', { url, ok: false, error: err.message }, { id });
    sendError(id, `storage.clear failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Command: eval — pure JS execution (no page DOM access)
//
// Used by macros for parsing fetch responses, building request bodies, etc.
// The function receives an `args` object and must return a JSON-serializable
// value. This is NOT page-context eval (use form.eval for that) — it runs
// in a tab's main world via chrome.debugger, so it has NO access to the
// extension's chrome.* APIs but DOES have access to fetch, crypto, JSON, etc.
//
// MV3 NOTE: The service worker's CSP (`script-src 'self' 'wasm-unsafe-eval'`)
// forbids eval() and new Function(). We CANNOT eval the function source in
// the service worker. Instead, we use chrome.debugger + Runtime.evaluate
// (the same approach as handleFormEval) to run the function in a tab's main
// world, which bypasses both the extension CSP and the page CSP.
//
// The function source is passed as a string. This is safe because the
// extension only executes macros from trusted sources (the user pastes
// them, or the Python backend sends them).
// ---------------------------------------------------------------------------

// Helper: find a tab to execute JS in. Prefer the provided tabId; otherwise
// find any open http(s) tab. Returns null if no suitable tab exists.
async function findEvalTabId(preferredTabId) {
  if (preferredTabId) return preferredTabId;
  const tabs = await chrome.tabs.query({});
  const httpTab = tabs.find(t => t.url && (t.url.startsWith('http://') || t.url.startsWith('https://')));
  return httpTab ? httpTab.id : null;
}

// ---------------------------------------------------------------------------
// Reference-counted debugger sessions (debuggerHolders).
//
// MULTIPLE features attach chrome.debugger to the same tab: eval steps,
// form.eval, xhr.intercept, retry-condition checks. If each one blindly
// attach/detaches, the first detach KILLS every other feature's session
// (latent bug inherited from v0.8.4: a daemon-driven xhr.intercept died the
// moment a subsequent form.eval ran -- the interceptor saw nothing). These
// helpers make attach/detach reference-counted per tab:
//
//   debuggerAttach(tabId, holder) -- first holder attaches the real debugger;
//       further holders just register. Returns true when WE own the session
//       (fresh or shared), false when a FOREIGN debugger (DevTools, another
//       extension) is attached (tolerated -- commands may still work).
//   debuggerDetach(tabId, holder) -- unregisters; the real detach happens only
//       when the last holder releases.
//
// During a macro run, eval/form.eval hold under the 'macro' holder which is
// released at run end -- one stable infobar for the whole run instead of
// flickering per step.
// ---------------------------------------------------------------------------

async function debuggerAttach(tabId, holder = 'adhoc') {
  const holders = state.debuggerHolders.get(tabId);
  if (holders && holders.size > 0) {
    holders.add(holder);  // we already own this tab's debugger session
    return true;
  }
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    state.debuggerHolders.set(tabId, new Set([holder]));
    return true;
  } catch (err) {
    if (err.message && err.message.includes('Another debugger')) return false;
    throw err;
  }
}

async function debuggerDetach(tabId, holder = 'adhoc') {
  const holders = state.debuggerHolders.get(tabId);
  if (holders) {
    holders.delete(holder);
    if (holders.size > 0) return;  // another feature still needs the session
    state.debuggerHolders.delete(tabId);
  }
  // No registered holders (or foreign session) -- detach if we own it; a
  // failed detach (foreign/already-detached) is harmless.
  try {
    await chrome.debugger.detach({ tabId });
  } catch (e) { /* already detached / not ours */ }
}

// If the user cancels the debugger infobar on a tab (or the tab closes),
// drop its holder registry so the next attach re-attaches for real.
if (chrome.debugger && chrome.debugger.onDetach) {
  chrome.debugger.onDetach.addListener((source) => {
    if (source && source.tabId != null) {
      state.debuggerHolders.delete(source.tabId);
    }
  });
}

// Helper: evaluate a JS expression in a tab's main world via chrome.debugger.
// Attaches the debugger (tolerating "already attached"), enables Runtime,
// evaluates the expression, and detaches. Returns the expression's value.
// Throws on any error (including eval errors inside the expression).
async function evaluateInTab(tabId, expression) {
  const holder = state.macroRunning ? 'macro' : 'adhoc';
  await debuggerAttach(tabId, holder);
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable');
    const evalResult = await chrome.debugger.sendCommand(
      { tabId },
      'Runtime.evaluate',
      {
        expression,
        returnByValue: true,
        awaitPromise: true,  // needed for async functions / returned Promises
        userGesture: true,
      }
    );
    if (evalResult.exceptionDetails) {
      const exc = evalResult.exceptionDetails;
      const errMsg = exc.exception?.description || exc.text || 'Unknown error';
      throw new Error(errMsg.slice(0, 500));
    }
    return evalResult.result?.value;
  } finally {
    await debuggerDetach(tabId, holder);
  }
}

async function handleEval(cmd) {
  const { id, function: fnSource, args, tabId } = cmd;
  const startTime = Date.now();
  try {
    if (typeof fnSource !== 'string' || !fnSource.trim()) {
      capture('eval', { ok: false, error: 'missing or empty function field', durationMs: 0 }, { id });
      sendError(id, 'eval: missing or empty "function" field');
      return;
    }
    // MV3 service workers can't use eval() — find a tab to execute in.
    const targetTabId = await findEvalTabId(tabId);
    if (!targetTabId) {
      capture('eval', {
        ok: false,
        error: 'no http(s) tab available',
        functionSource: fnSource.slice(0, 500),
        durationMs: Date.now() - startTime,
      }, { id });
      sendError(id, 'eval: no http(s) tab available — open any web page (or pass tabId in the step)');
      return;
    }

    // Wrap the function source in parens (handles both arrow functions and
    // function expressions) and call it with the args.
    const expression = `(${fnSource})(${JSON.stringify(args != null ? args : {})})`;
    const result = await evaluateInTab(targetTabId, expression);
    const durationMs = Date.now() - startTime;
    capture('eval', {
      tabId: targetTabId,
      functionSource: fnSource.slice(0, 500),
      args,
      result: summarizeForCapture(result),
      ok: !(result && result.ok === false),
      durationMs,
    }, { id });
    // Pass the function's return value through DIRECTLY as the step result.
    // Macros reference {{stepId.field}} (e.g. {{extract-creds.userId}}), not
    // {{stepId.result.field}} — so we must NOT wrap the return value in
    // { ok: true, result: ... }. The macro runner uses `result.ok === false`
    // (strict) to detect explicit failures, so eval functions that omit `ok`
    // are treated as success.
    sendResult(id, result);
  } catch (err) {
    const durationMs = Date.now() - startTime;
    log('error', 'eval-failed', { id, error: err.message });
    capture('eval', {
      ok: false,
      error: err.message,
      functionSource: typeof fnSource === 'string' ? fnSource.slice(0, 500) : String(fnSource),
      args,
      durationMs,
    }, { id });
    sendError(id, `eval failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Command: macro.run — local macro replay mode
//
// Runs a JSON macro of steps without needing a backend. Each step is a
// command (fetch, form.eval, cookies.getAll, etc.) with template substitution
// for {{stepId.field}} and {{inputs.key}} references.
//
// Macro format:
//   {
//     name: "string",
//     inputs: { key: value, ... },
//     steps: [
//       { id: "step1", cmd: "tabs.open", url: "https://..." },
//       { id: "step2", cmd: "form.wait", tabId: "{{step1.tabId}}", selector: "input", timeoutMs: 15000 },
//       { id: "step3", cmd: "fetch", url: "...", method: "POST", body: "{{step2.body}}", ... },
//       { id: "step4", cmd: "eval", function: "(args) => { return {code: args.body.match(/\\d{6}/)[0]} }", args: { body: "{{step3.body}}" } },
//       ...
//     ]
//   }
//
// The macro runner:
//   1. Resolves templates in each step's args
//   2. Dispatches the command to the existing handler (handleFetch, handleFormEval, etc.)
//   3. Stores the result keyed by step id
//   4. Proceeds to the next step
//   5. On error, aborts (or continues if step.onError === 'continue')
//
// The result of each step is the same shape as what the handler sends back
// via sendResult(): { ok: true, ... } or { ok: false, error: "..." }.
//
// For the email-polling case, we support a special "retry" wrapper:
//   {
//     id: "get-code",
//     cmd: "retry",
//     timeoutMs: 180000,
//     intervalMs: 4000,
//     condition: "result.code != null",  // JS expression evaluated against the last sub-step's result
//     steps: [ ...sub-steps... ]
//   }
// The retry block re-runs its sub-steps every intervalMs until condition
// is true or timeoutMs is exceeded.
// ---------------------------------------------------------------------------

async function handleMacroRun(msg) {
  const { id, macro, inputs, source } = msg;
  // source === 'popup'  → triggered from the popup (don't forward result via WS)
  // source === undefined or 'ws' → triggered from the WS backend (forward via WS)
  const isPopup = source === 'popup';
  if (!macro || !Array.isArray(macro.steps)) {
    if (isPopup) {
      const errSummary = { ok: false, error: 'macro.run requires a macro object with a steps array' };
      try { chrome.runtime.sendMessage({ type: 'macro-complete', result: errSummary }); } catch (e) { /* popup not open */ }
    } else {
      sendError(id, 'macro.run requires a macro object with a steps array');
    }
    return;
  }

  // Only ONE macro at a time. A second concurrent run would interleave steps,
  // fight over the sticky debugger tabs, and make Stop ambiguous.
  if (state.macroRunning) {
    const err = 'a macro is already running — click Stop first, then run again';
    if (isPopup) {
      // stillRunning tells the popup NOT to reset its Run/Stop buttons — the
      // macro that IS running will send its own macro-complete later.
      try { chrome.runtime.sendMessage({ type: 'macro-complete', result: { ok: false, error: err, name: macro.name, stillRunning: true } }); } catch (e) { /* popup not open */ }
    } else {
      sendError(id, err);
    }
    return;
  }

  state.macroRunning = true;
  state.macroCancelRequested = false;

  const ctx = {
    inputs: { ...(macro.inputs || {}), ...(inputs || {}) },
    results: {},
    startedAt: Date.now(),
  };

  log('info', 'macro-start', { id, name: macro.name, stepCount: macro.steps.length, inputs: Object.keys(ctx.inputs), source: source || 'ws' });
  capture('macro.start', {
    name: macro.name,
    stepCount: macro.steps.length,
    inputKeys: Object.keys(ctx.inputs),
    source: source || 'ws',
  }, { id });

  const stepResults = [];
  try {
    for (let i = 0; i < macro.steps.length; i++) {
      // User pressed Stop — abort between steps. (The in-flight step finishes
      // first; form.wait also checks the flag at its poll cadence, and the
      // retry block checks between attempts, so worst case is one step.)
      if (state.macroCancelRequested) {
        throw new Error('Macro cancelled by user');
      }
      const step = macro.steps[i];
      const stepLabel = step.id ? `#${i + 1} (${step.id}: ${step.cmd})` : `#${i + 1} (${step.cmd})`;
      const stepStart = Date.now();

      try {
        const result = await executeMacroStep(step, ctx);
        if (step.id) ctx.results[step.id] = result;
        // Strict failure check: only an explicit `ok: false` is a failure.
        // `eval` steps that return data WITHOUT an `ok` field (e.g.
        // `{ userId, tokenV2 }`) are treated as success. This lets macros
        // reference {{stepId.field}} directly instead of {{stepId.result.field}}.
        const failed = result && result.ok === false;
        stepResults.push({ step: stepLabel, id: step.id, ok: !failed, summary: summarizeResult(result) });
        log('info', `macro-step-${failed ? 'fail' : 'ok'}`, { id, step: stepLabel, ok: !failed });
        // Capture the macro step (resolved args + result, for fixture reconstruction)
        capture('macro.step', {
          macroName: macro.name,
          stepId: step.id,
          stepIndex: i,
          cmd: step.cmd,
          args: summarizeForCapture(resolveTemplateDeep(step, ctx)),
          result: summarizeForCapture(result),
          durationMs: Date.now() - stepStart,
          ok: !failed,
        }, { id });

        // Save critical outputs to the output store (for backend persistence).
        // These are the steps whose results contain data the backend needs:
        //   - extract-creds: userId, tokenV2, deviceId (signup credentials)
        //   - parse-space-id: spaceId (workspace creation)
        //   - create-space-view: spaceViewId
        //   - initiate-onboarding-agent-chat: threadId
        //   - final-result: all of the above combined
        if (!failed && step.id) {
          const criticalSteps = {
            'extract-creds': 'signup_credentials',
            'parse-space-id': 'workspace_created',
            'create-space-view': 'space_view_created',
            'initiate-onboarding-agent-chat': 'onboarding_chat_initiated',
            'final-result': 'signup_complete',
            'parse-token': 'api_key_created',
          };
          if (criticalSteps[step.id]) {
            saveOutput(criticalSteps[step.id], macro.name, step.id, result);
          }
        }

        if (failed && step.onError !== 'continue') {
          throw new Error(`Step ${stepLabel} failed: ${result.error || 'unknown error'}`);
        }
      } catch (err) {
        stepResults.push({ step: stepLabel, id: step.id, ok: false, error: err.message });
        log('error', 'macro-step-error', { id, step: stepLabel, error: err.message });
        capture('macro.step', {
          macroName: macro.name,
          stepId: step.id,
          stepIndex: i,
          cmd: step.cmd,
          args: summarizeForCapture(resolveTemplateDeep(step, ctx)),
          error: err.message,
          durationMs: Date.now() - stepStart,
          ok: false,
        }, { id });
        if (step.onError !== 'continue') {
          throw err;
        }
      }
    }

    const summary = {
      ok: true,
      name: macro.name,
      stepCount: macro.steps.length,
      durationMs: Date.now() - ctx.startedAt,
      steps: stepResults,
      results: ctx.results,
    };
    log('info', 'macro-complete', { id, name: macro.name, durationMs: summary.durationMs });
    capture('macro.complete', {
      name: macro.name,
      ok: true,
      stepCount: macro.steps.length,
      durationMs: summary.durationMs,
      stepResults: stepResults.map(s => ({ step: s.step, id: s.id, ok: s.ok })),
    }, { id });
    state.lastMacroResult = summary;
    // Persist to Turso (no-op if not configured — the extension runs standalone)
    recordMacroRun({
      service: macro.service || 'unknown',
      macroName: macro.name,
      inputs: ctx.inputs,
      startedAt: ctx.startedAt,
      finishedAt: Date.now(),
      ok: true,
    }).then(runId => {
      if (runId) {
        // Record per-step results (best-effort, non-blocking)
        for (const s of stepResults) {
          recordStepResult({
            runId, stepId: s.id || '', stepCmd: s.step || '',
            ok: !!s.ok, result: s.summary, durationMs: 0,
          });
        }
      }
    }).catch(err => console.error('[turso] recordMacroRun error:', err));
    captureStepTokens(macro, ctx);
    // Push to popup if open
    try { chrome.runtime.sendMessage({ type: 'macro-complete', result: summary }); } catch (e) { /* popup not open */ }
    // Only forward via WS if the macro was triggered by the backend.
    // Popup-triggered macros must NOT be forwarded — the backend would
    // receive an unsolicited 'result' message with a popup-macro-* id.
    if (!isPopup) {
      sendResult(id, summary);
    }
  } catch (err) {
    const summary = {
      ok: false,
      name: macro.name,
      error: err.message,
      stepCount: macro.steps.length,
      completedSteps: stepResults.length,
      steps: stepResults,
      results: ctx.results,
    };
    log('error', 'macro-failed', { id, name: macro.name, error: err.message });
    capture('macro.complete', {
      name: macro.name,
      ok: false,
      error: err.message,
      stepCount: macro.steps.length,
      completedSteps: stepResults.length,
      durationMs: Date.now() - ctx.startedAt,
    }, { id });
    state.lastMacroResult = summary;
    // Persist to Turso (no-op if not configured — the extension runs standalone)
    recordMacroRun({
      service: macro.service || 'unknown',
      macroName: macro.name,
      inputs: ctx.inputs,
      startedAt: ctx.startedAt,
      finishedAt: Date.now(),
      ok: false,
      error: err.message,
    }).then(runId => {
      if (runId) {
        for (const s of stepResults) {
          recordStepResult({
            runId, stepId: s.id || '', stepCmd: s.step || '',
            ok: !!s.ok, result: s.summary, durationMs: 0,
          });
        }
      }
    }).catch(err2 => console.error('[turso] recordMacroRun error (failure path):', err2));
    captureStepTokens(macro, ctx);
    // Push to popup if open
    try { chrome.runtime.sendMessage({ type: 'macro-complete', result: summary }); } catch (e) { /* popup not open */ }
    if (!isPopup) {
      sendResult(id, summary);
    }
  } finally {
    // Run cleanup — ALWAYS, success / failure / cancellation alike:
    //   1. Release this run's 'macro' debugger holder on every tab it touched
    //      (refcounted: the real chrome.debugger.detach happens only when no
    //      other holder — xhr.intercept, adhoc eval — still needs the session).
    //   2. Reset the run-control flags so the next macro can start.
    // v0.9.3 regression fixed here: this block still iterated the REMOVED
    // state.debuggerStickyTabs, throwing "not iterable" AFTER the summary was
    // sent — the uncaught-handler then reported every completed macro as
    // failed. Caught by the toy-signup E2E.
    for (const tid of [...state.debuggerHolders.keys()]) {
      try { await debuggerDetach(tid, 'macro'); } catch (e) { /* already detached */ }
    }
    state.macroRunning = false;
    state.macroCancelRequested = false;
  }
}

async function executeMacroStep(step, ctx) {
  const cmd = step.cmd;

  // Special case: retry block
  if (cmd === 'retry') {
    return await executeRetryBlock(step, ctx);
  }

  // Special case: wait
  if (cmd === 'wait') {
    const ms = resolveTemplate(step.ms, ctx);
    await new Promise(r => setTimeout(r, parseInt(ms, 10) || 1000));
    return { ok: true, waited: ms };
  }

  // Special case: log
  if (cmd === 'log') {
    const message = resolveTemplate(step.message, ctx);
    log('info', 'macro-user-log', { message, data: resolveTemplateDeep(step.data, ctx) });
    return { ok: true };
  }

  // All other commands: resolve templates in args, then dispatch to the
  // existing handler. We synthesize a command message with a unique id,
  // call the handler, and capture the result via state.pendingMacroResults.
  const subId = 'macro-' + Math.random().toString(36).slice(2, 12);
  const resolvedArgs = resolveTemplateDeep(step, ctx);
  // The `cmd` field becomes `type` for the handler; remove cmd/id since
  // we're replacing id with subId.
  const { cmd: _cmd, id: _id, onError: _onError, ...rest } = resolvedArgs;
  const subMsg = { id: subId, type: _cmd, ...rest };

  // Set up the pending result callback. sendResult/sendError will resolve
  // this promise when they're called with subId.
  if (!state.pendingMacroResults) state.pendingMacroResults = new Map();

  return new Promise((resolve) => {
    state.pendingMacroResults.set(subId, resolve);
    handleCommand(subMsg).catch(err => {
      if (state.pendingMacroResults.has(subId)) {
        state.pendingMacroResults.delete(subId);
        resolve({ ok: false, error: err.message });
      }
    });
  });
}

async function executeRetryBlock(step, ctx) {
  const timeoutMs = step.timeoutMs || 60000;
  const intervalMs = step.intervalMs || 4000;
  const condition = step.condition || 'result && result.ok !== false';
  const subSteps = step.steps || [];
  if (!subSteps.length) return { ok: false, error: 'retry block has no steps' };

  // MV3 NOTE: new Function() is blocked by the service worker CSP, so we
  // can't evaluate the condition expression directly. We use evaluateInTab
  // (chrome.debugger + Runtime.evaluate) to run it in a tab's main world.
  // Find a tab once at the start of the retry block to avoid re-querying
  // chrome.tabs.query on every iteration.
  const condTabId = await findEvalTabId(step.tabId || null);
  if (!condTabId) {
    return { ok: false, error: 'retry: no http(s) tab available to evaluate condition — open any web page first' };
  }

  const deadline = Date.now() + timeoutMs;
  let lastResult = null;
  let attempts = 0;

  while (Date.now() < deadline) {
    // User pressed Stop — abort between attempts (at most one in-flight
    // attempt + one interval of latency).
    if (state.macroCancelRequested) {
      return { ok: false, cancelled: true, error: 'Macro cancelled by user', attempts, lastResult };
    }
    attempts++;
    // Capture each retry attempt so the diagnostics panel + fixtures show
    // how many iterations occurred and what the condition evaluated to.
    capture('macro.retry', {
      stepId: step.id || null,
      attempt: attempts,
      timeoutMs,
      intervalMs,
      condition,
      lastOk: lastResult ? lastResult.ok !== false : null,
    });
    // Run the sub-steps in a child context (so their results don't pollute
    // the parent ctx.results, but are available for condition evaluation)
    const subCtx = { inputs: ctx.inputs, results: { ...ctx.results }, startedAt: Date.now() };
    let stepError = null;
    let fatalResult = null;  // a sub-step flagged the situation as un-retryable
    for (const subStep of subSteps) {
      try {
        const r = await executeMacroStep(subStep, subCtx);
        if (subStep.id) {
          subCtx.results[subStep.id] = r;
          // Also promote to parent ctx so subsequent steps can use them
          ctx.results[subStep.id] = r;
        }
        lastResult = r;
        // FATAL: a sub-step can declare "this will never succeed — stop
        // polling" by returning { fatal: true, error } (e.g. the email chunk
        // when the verification email arrives but its code is not readable
        // via the inbox API). Retrying would just burn the timeout.
        if (r && r.fatal === true) {
          fatalResult = r;
          break;
        }
        // Strict failure check (same as the top-level macro runner).
        if (r && r.ok === false && subStep.onError !== 'continue') {
          stepError = r.error || 'sub-step failed';
          break;
        }
      } catch (err) {
        stepError = err.message;
        break;
      }
    }

    if (fatalResult) {
      log('warn', 'macro-retry-fatal', { stepId: step.id || null, error: fatalResult.error });
      capture('macro.retry', { stepId: step.id || null, fatal: true, error: fatalResult.error, attempt: attempts });
      return { ok: false, fatal: true, error: fatalResult.error, attempts, lastResult: fatalResult };
    }

    if (state.macroCancelRequested) {
      return { ok: false, cancelled: true, error: 'Macro cancelled by user', attempts, lastResult };
    }

    if (!stepError) {
      // Evaluate condition — "result" refers to lastResult, "results" to all
      // sub-step results, "inputs" to the macro inputs.
      // We serialize the three values and inject them into the expression.
      try {
        const expr = `(function(result, results, inputs){ return (${condition}); })(${JSON.stringify(lastResult)}, ${JSON.stringify(subCtx.results)}, ${JSON.stringify(subCtx.inputs)})`;
        const condValue = await evaluateInTab(condTabId, expr);
        if (condValue) {
          return { ok: true, attempts, result: lastResult };
        }
      } catch (err) {
        log('warn', 'macro-retry-condition-error', { error: err.message, condition });
      }
    }

    if (Date.now() + intervalMs >= deadline) break;
    await new Promise(r => setTimeout(r, intervalMs));
  }

  return { ok: false, error: `retry: condition not met within ${timeoutMs}ms`, attempts, lastResult };
}

// Resolve {{stepId.field.subfield}} and {{inputs.key}} templates in a string.
//
// Fast path: if the entire string is a single template like "{{step1.body}}",
// return the RAW resolved value (object/array/number/boolean) instead of
// stringifying it. This lets macros pass arrays/objects/numbers directly
// between steps — e.g. `"args": { "cookies": "{{get-cookies.cookies}}" }`
// gives the eval function the actual cookie array, not a JSON string.
//
// Slow path: for strings with embedded templates like "Bearer {{inputs.token}}",
// substitute each template and stringify the result (so the final string is
// concatenated correctly).
//
// If a template path doesn't resolve, the template is left as-is (so the
// caller can detect missing values).
function resolveTemplate(str, ctx) {
  if (typeof str !== 'string') return str;
  const first = resolveTemplateOnce(str, ctx);
  // Second pass: allows INPUT VALUES to themselves contain templates — e.g.
  // the shared email chunk's emailWorkerUrl input is
  //   "https://v3-mail.priv.email/emails?address={{inputs.email}}&limit=10&include_body=true"
  // which references the per-run email input. Bounded to ONE extra pass so a
  // value that legitimately contains "{{...}}" text (e.g. an email body quoting
  // template syntax) cannot recurse — and unresolvable paths stay literal.
  if (typeof first === 'string' && first.includes('{{')) {
    return resolveTemplateOnce(first, ctx);
  }
  return first;
}

function resolveTemplateOnce(str, ctx) {
  // Fast path: entire string is a single template
  const single = /^\s*\{\{([^}]+)\}\}\s*$/.exec(str);
  if (single) {
    const val = lookupTemplatePath(single[1].trim(), ctx);
    if (val !== undefined && val !== null) return val;
    // null/undefined → fall through to slow path, which leaves it as-is
  }

  // Slow path: substitute templates embedded in a larger string
  return str.replace(/\{\{([^}]+)\}\}/g, (match, path) => {
    const val = lookupTemplatePath(path.trim(), ctx);
    if (val === undefined || val === null) return match; // leave as-is
    if (typeof val === 'object') return JSON.stringify(val);
    return String(val);
  });
}

// Look up a dotted path like "step1.body.field" or "inputs.email" in ctx.
// Returns undefined if any part of the path doesn't resolve.
function lookupTemplatePath(path, ctx) {
  const parts = path.split('.');
  let val;
  if (parts[0] === 'inputs') {
    val = ctx.inputs;
  } else if (parts[0] === 'results') {
    val = ctx.results;
  } else {
    // Step ID reference
    val = ctx.results[parts[0]];
  }
  for (let i = 1; i < parts.length; i++) {
    if (val == null) return undefined;
    val = val[parts[i]];
  }
  return val;
}

// Deep-resolve templates in any JSON-serializable value.
//
// Handles cycles defensively: if an object references itself (unlikely but
// possible if a step's result contains a circular ref and a later step
// references it via a template), we bail out and leave the template as-is
// rather than recursing infinitely.
function resolveTemplateDeep(obj, ctx, seen) {
  if (typeof obj === 'string') return resolveTemplate(obj, ctx);
  if (Array.isArray(obj)) return obj.map(v => resolveTemplateDeep(v, ctx, seen));
  if (obj !== null && typeof obj === 'object') {
    // Cycle guard (best-effort — uses the object as a WeakSet key)
    if (!seen) seen = new WeakSet();
    if (seen.has(obj)) return undefined; // cycle detected — bail out
    seen.add(obj);
    const out = {};
    for (const k of Object.keys(obj)) out[k] = resolveTemplateDeep(obj[k], ctx, seen);
    return out;
  }
  return obj;
}

// Summarize a result for the step log (truncate large values).
function summarizeResult(result) {
  if (!result) return null;
  const s = {};
  for (const k of Object.keys(result)) {
    const v = result[k];
    // Caps kept generous: recordStepResult() caps at 65KB anyway, and the
    // old 200/300-char caps TRUNCATED token_v2 (~740 chars) — breaking the
    // Turso creds-persistence path (backend could not resume sessions).
    if (typeof v === 'string' && v.length > 16000) {
      s[k] = v.slice(0, 16000) + '...(' + v.length + ' chars)';
    } else if (typeof v === 'object' && v !== null) {
      const json = JSON.stringify(v);
      if (json.length > 32000) {
        s[k] = json.slice(0, 32000) + '...';
      } else {
        s[k] = v;
      }
    } else {
      s[k] = v;
    }
  }
  return s;
}

// Persist tokens declared via step.persistTokens ({resultKey: tokenType})
// into Turso's captured_tokens — FULL values, never truncated. This is the
// extension→backend handoff: the backend later resumes the session straight
// from Turso (no daemon, no browser). No-op when Turso isn't configured or
// the macro declares no persistTokens.
function captureStepTokens(macro, ctx) {
  for (const step of (macro.steps || [])) {
    const map = step.persistTokens;
    if (!map) continue;
    const res = ctx.results[step.id];
    if (!res) continue;
    for (const [key, tokenType] of Object.entries(map)) {
      const val = res[key];
      if (val !== undefined && val !== null && String(val).length > 0) {
        captureToken({
          service: macro.service || 'unknown',
          email: (ctx.inputs && ctx.inputs.email) || '',
          tokenType: String(tokenType),
          tokenValue: String(val),
        }).catch(err => console.error('[turso] captureToken error:', err));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Command: screenshot
// ---------------------------------------------------------------------------

async function handleScreenshot(cmd) {
  const { id, tabId } = cmd;
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
    log('debug', 'screenshot', { id, tabId, len: dataUrl.length });
    capture('screenshot', { tabId, len: dataUrl.length, ok: true }, { id });
    sendResult(id, { ok: true, dataUrl });
  } catch (err) {
    log('error', 'screenshot-failed', { id, tabId, error: err.message });
    capture('screenshot', { tabId, ok: false, error: err.message }, { id });
    sendError(id, err.message);
  }
}

// ---------------------------------------------------------------------------
// Status broadcast to popup
// ---------------------------------------------------------------------------

function broadcastStatus() {
  const status = {
    status: state.status,
    connectedAt: state.connectedAt,
    lastError: state.lastError,
    commandsReceived: state.commandsReceived,
    commandsCompleted: state.commandsCompleted,
    commandsFailed: state.commandsFailed,
    lastCommandAt: state.lastCommandAt,
    agentId: state.agentId,
    serverUrl: state.serverUrl,
    // Capture diagnostics — included on every status broadcast so the popup
    // can live-update the Diagnostics & Capture panel.
    capture: {
      enabled: captureState.enabled,
      forwardWs: captureState.forwardWs,
      ringSize: captureState.ring.length,
      ringMax: CAPTURE_RING_MAX,
      totalEvents: captureState.totalEvents,
      lastPersistError: captureState.lastPersistError,
      wsConnected: !!(ws && ws.readyState === WebSocket.OPEN),
    },
  };
  try { chrome.runtime.sendMessage({ type: 'status', status }); } catch (e) { /* popup not open */ }
}

// ---------------------------------------------------------------------------
// Message handler for popup → background
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'connect') {
    connect(msg.serverUrl).then(() => sendResponse({ ok: true }));
    return true;  // async
  }
  if (msg.type === 'disconnect') {
    disconnect();
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'getStatus') {
    sendResponse({
      status: state.status,
      connectedAt: state.connectedAt,
      lastError: state.lastError,
      commandsReceived: state.commandsReceived,
      commandsCompleted: state.commandsCompleted,
      commandsFailed: state.commandsFailed,
      lastCommandAt: state.lastCommandAt,
      agentId: state.agentId,
      serverUrl: state.serverUrl,
      log: state.log.slice(-50),
      capture: {
        enabled: captureState.enabled,
        forwardWs: captureState.forwardWs,
        ringSize: captureState.ring.length,
        ringMax: CAPTURE_RING_MAX,
        totalEvents: captureState.totalEvents,
        lastPersistError: captureState.lastPersistError,
        wsConnected: !!(ws && ws.readyState === WebSocket.OPEN),
      },
    });
    return false;
  }
  // --- Diagnostics / capture popup messages ---
  if (msg.type === 'getCaptureBuffer') {
    getCaptureBuffer().then(buf => sendResponse({ ok: true, ...buf })).catch(err => sendResponse({ ok: false, error: err.message }));
    return true;  // async
  }
  if (msg.type === 'setCaptureEnabled') {
    captureState.enabled = !!msg.enabled;
    chrome.storage.local.set({ captureEnabled: captureState.enabled }).catch(() => {});
    log('info', 'capture-toggle', { source: 'popup', enabled: captureState.enabled });
    sendResponse({ ok: true, enabled: captureState.enabled });
    broadcastStatus();
    return false;
  }
  if (msg.type === 'setCaptureForwardWs') {
    captureState.forwardWs = !!msg.enabled;
    chrome.storage.local.set({ captureForwardWs: captureState.forwardWs }).catch(() => {});
    log('info', 'capture-forward-ws-toggle', { source: 'popup', enabled: captureState.forwardWs });
    sendResponse({ ok: true, enabled: captureState.forwardWs });
    broadcastStatus();
    return false;
  }
  if (msg.type === 'clearCapture') {
    clearCapture().then(() => sendResponse({ ok: true })).catch(err => sendResponse({ ok: false, error: err.message }));
    return true;  // async
  }
  if (msg.type === 'getCaptureRing') {
    // Return the in-memory ring (masked) without forcing a persist — used by
    // the popup's diagnostics panel for live updates between full refreshes.
    const ring = captureState.ring.slice(-100).map(e => maskSensitive(e));
    sendResponse({ ok: true, ring, totalEvents: captureState.totalEvents });
    return false;
  }
  if (msg.type === 'clearLog') {
    state.log = [];
    sendResponse({ ok: true });
    return false;
  }
  // Local macro replay — popup sends { type: 'runMacro', macro, inputs }
  // and gets back the full macro result via a 'macro-complete' push message.
  if (msg.type === 'runMacro') {
    const macroId = 'popup-macro-' + Date.now();
    // source: 'popup' tells handleMacroRun to NOT forward the result via WS
    // (the popup didn't ask the backend for this — sending the result via WS
    // would confuse the Python backend with an unsolicited 'result' message).
    handleMacroRun({ id: macroId, source: 'popup', macro: msg.macro, inputs: msg.inputs || {} })
      .catch(err => {
        // Should never happen — handleMacroRun catches its own errors — but
        // guard against an unexpected throw so the popup doesn't hang.
        log('error', 'macro-run-uncaught', { macroId, error: err.message });
        try {
          chrome.runtime.sendMessage({
            type: 'macro-complete',
            result: { ok: false, name: msg.macro?.name, error: 'Uncaught: ' + err.message, steps: [] },
          });
        } catch (e) { /* popup not open */ }
      });
    sendResponse({ ok: true, macroId, message: 'Macro started. Result will be pushed as macro-complete.' });
    return false;
  }
  if (msg.type === 'getMacroResult') {
    // Fetch the last macro result (if any)
    sendResponse({ result: state.lastMacroResult || null });
    return false;
  }
  // Stop the running macro — sets the cancellation flag checked between
  // steps, between retry attempts, and in form.wait's poll loop. The current
  // in-flight step finishes; a macro-complete message with the cancellation
  // error follows shortly after.
  if (msg.type === 'stopMacro') {
    if (!state.macroRunning) {
      sendResponse({ ok: true, wasRunning: false });
      return false;
    }
    state.macroCancelRequested = true;
    log('warn', 'macro-stop-requested', {});
    capture('macro.stop', { requested: true });
    sendResponse({ ok: true, wasRunning: true });
    return false;
  }
  // Quick Exec — run a SINGLE command through the same engine the macro
  // runner uses (executeMacroStep). This is the "extension as a sandbox"
  // surface: any of the 23 commands, on demand, from the popup. The result
  // is pushed back as a 'quickExec-result' message.
  if (msg.type === 'quickExec') {
    const qeId = msg.id;
    (async () => {
      let result;
      try {
        const step = msg.step;
        if (!step || typeof step !== 'object' || !step.cmd) {
          throw new Error('quickExec: step must be an object with a "cmd" field');
        }
        const ctx = {
          inputs: (msg.inputs && typeof msg.inputs === 'object') ? msg.inputs : {},
          results: {},
          startedAt: Date.now(),
        };
        log('info', 'quick-exec', { id: qeId, cmd: step.cmd });
        result = await executeMacroStep(step, ctx);
      } catch (err) {
        result = { ok: false, error: err.message };
      }
      try {
        chrome.runtime.sendMessage({ type: 'quickExec-result', id: qeId, result });
      } catch (e) { /* popup closed — ignore */ }
    })();
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

// ---------------------------------------------------------------------------
// Command: page.fetch — execute fetch() from a PAGE's main world context
//
// Needed because the service worker's fetch() can't decompress zstd
// (DecompressionStream doesn't support zstd in Chrome 151 service worker).
// The page's main world fetch() handles zstd natively via Chrome's network stack.
//
// Requires a Notion tab to be open (the fetch runs in that tab's context).
// Uses chrome.scripting with world: 'MAIN' to execute in the page's main world.
// ---------------------------------------------------------------------------

async function handlePageFetch(cmd) {
  const { id, tabId, url, method, headers, body, credentials, timeoutMs } = cmd;
  log('debug', 'page.fetch-start', { id, url, method, tabId });
  const startTime = Date.now();

  try {
    // I4 fix: pass timeoutMs into the page-context function + use AbortController
    // so the fetch doesn't hang indefinitely if the page is unresponsive.
    const effectiveTimeout = timeoutMs || 30000;
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async (fetchUrl, fetchMethod, fetchHeaders, fetchBody, fetchCredentials, fetchTimeoutMs) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), fetchTimeoutMs);
        try {
          const options = {
            method: fetchMethod || 'GET',
            headers: fetchHeaders || {},
            credentials: fetchCredentials || 'include',
            signal: controller.signal,
          };
          if (fetchBody && fetchMethod !== 'GET' && fetchMethod !== 'HEAD') {
            options.body = fetchBody;
          }
          const res = await fetch(fetchUrl, options);
          const text = await res.text();
          const responseHeaders = {};
          res.headers.forEach((value, key) => {
            responseHeaders[key] = value;
          });
          return {
            ok: res.ok,
            status: res.status,
            statusText: res.statusText,
            body: text,
            finalUrl: res.url,
            headers: responseHeaders,
          };
        } finally {
          clearTimeout(timer);
        }
      },
      args: [url, method || 'GET', headers || {}, body, credentials || 'include', effectiveTimeout],
    });

    const result = results[0]?.result;
    if (!result) {
      capture('fetch', {
        url,
        method: method || 'GET',
        reqHeaders: headers || {},
        reqBody: body,
        status: 0,
        error: 'No result from page fetch',
        durationMs: Date.now() - startTime,
        ok: false,
        context: 'page-main-world',
        tabId,
      }, { id });
      sendError(id, 'No result from page fetch');
      return;
    }

    const durationMs = Date.now() - startTime;
    log('debug', 'page.fetch-done', {
      id, url, status: result.status,
      bodyLen: result.body?.length,
      encoding: result.headers?.['content-encoding'] || 'none'
    });
    capture('fetch', {
      url,
      method: method || 'GET',
      reqHeaders: headers || {},
      reqBody: body,
      status: result.status,
      statusText: result.statusText,
      respHeaders: result.headers,
      respBody: result.body,
      finalUrl: result.finalUrl,
      encoding: result.headers?.['content-encoding'] || '',
      durationMs,
      ok: result.ok,
      context: 'page-main-world',
      tabId,
    }, { id });
    sendResult(id, result);
  } catch (err) {
    const durationMs = Date.now() - startTime;
    log('error', 'page.fetch-failed', { id, url, error: err.message });
    capture('fetch', {
      url,
      method: method || 'GET',
      reqHeaders: headers || {},
      reqBody: body,
      status: 0,
      error: err.message,
      durationMs,
      ok: false,
      context: 'page-main-world',
      tabId,
    }, { id });
    sendError(id, err.message);
  }
}

// ---------------------------------------------------------------------------
// Auto-connect on install/startup
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async () => {
  await loadCaptureFromStorage();
  await loadOutputStore();
  const cfg = await loadConfig();
  if (cfg.autoConnect && cfg.serverUrl) {
    connect(cfg.serverUrl);
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await loadCaptureFromStorage();
  await loadOutputStore();
  const cfg = await loadConfig();
  if (cfg.autoConnect && cfg.serverUrl) {
    connect(cfg.serverUrl);
  }
});

// Auto-connect on service worker startup (handles browser restart)
// Also restores the capture buffer from chrome.storage.local so events
// survive service worker restarts (MV3 kills the SW after 30s idle).
(async () => {
  await loadCaptureFromStorage();
  const cfg = await loadConfig();
  if (cfg.autoConnect && cfg.serverUrl) {
    connect(cfg.serverUrl);
  }
})();
