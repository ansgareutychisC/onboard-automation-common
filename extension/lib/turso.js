// extension/lib/turso.js
//
// Turso (libSQL) HTTP client for the extension.
// Docs: https://docs.turso.tech/sdk/http
//
// Configured via chrome.storage.local:
//   tursoUrl: the database HTTP URL (e.g. https://my-db-myorg.tur.so)
//   tursoToken: the JWT auth token
//
// When either is empty, all methods are no-ops (the extension runs standalone,
// results stay in-memory). This is the default — the user must explicitly
// configure Turso via the popup to enable persistence.
//
// Wire format: uses the libSQL HTTP pipeline API (POST <url>/v2/pipeline).
// If Turso's wire format changes, only this file needs updating.

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS macro_runs (
  id TEXT PRIMARY KEY,
  service TEXT,
  macro_name TEXT,
  inputs TEXT,
  started_at INTEGER,
  finished_at INTEGER,
  ok INTEGER,
  error TEXT
);
CREATE TABLE IF NOT EXISTS step_results (
  run_id TEXT,
  step_id TEXT,
  step_cmd TEXT,
  ok INTEGER,
  result TEXT,
  duration_ms INTEGER,
  PRIMARY KEY (run_id, step_id)
);
CREATE TABLE IF NOT EXISTS captured_tokens (
  service TEXT,
  email TEXT,
  token_type TEXT,
  token_value TEXT,
  captured_at INTEGER,
  PRIMARY KEY (service, email, token_type)
);
`;

let _initialized = false;

async function getConfig() {
  try {
    const cfg = await chrome.storage.local.get(['tursoUrl', 'tursoToken']);
    return {
      url: (cfg.tursoUrl || '').trim().replace(/\/+$/, ''),
      token: cfg.tursoToken || '',
    };
  } catch {
    return { url: '', token: '' };
  }
}

async function _isEnabled() {
  const { url, token } = await getConfig();
  return !!(url && token);
}

/**
 * Execute one or more SQL statements against Turso via the pipeline API.
 * Returns the raw response, or null if Turso isn't configured.
 */
async function _pipeline(statements) {
  const { url, token } = await getConfig();
  if (!url || !token) return null;

  const body = {
    requests: statements.map(([sql, args]) => ({
      type: 'execute',
      stmt: {
        sql,
        args: (args || []).map(a => {
          if (a === null || a === undefined) return { type: 'null' };
          if (typeof a === 'number') return { type: Number.isInteger(a) ? 'integer' : 'float', value: a };
          return { type: 'text', value: String(a) };
        }),
        want_rows: true,
      },
    })),
  };

  try {
    const res = await fetch(`${url}/v2/pipeline`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error('[turso] pipeline failed:', res.status, await res.text().catch(() => ''));
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error('[turso] pipeline error:', err);
    return null;
  }
}

async function _ensureSchema() {
  if (_initialized) return;
  _initialized = true;  // set first to avoid retry storms
  // Execute each CREATE statement separately (the pipeline API may not support
  // multi-statement strings in one request).
  for (const stmt of SCHEMA_SQL.trim().split(/;\s*\n/)) {
    const s = stmt.trim();
    if (s) await _pipeline([[s, []]]);
  }
}

/**
 * Record a macro run. Call this when a macro finishes (success or failure).
 * Returns the run_id (a UUID) or null if Turso isn't configured.
 */
export async function recordMacroRun({ service, macroName, inputs, startedAt, finishedAt, ok, error }) {
  if (!await _isEnabled()) return null;
  await _ensureSchema();
  const runId = 'run_' + crypto.randomUUID();
  await _pipeline([[
    `INSERT INTO macro_runs (id, service, macro_name, inputs, started_at, finished_at, ok, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [runId, service || 'unknown', macroName || 'unknown', JSON.stringify(inputs || {}),
     Math.floor(startedAt / 1000), Math.floor(finishedAt / 1000), ok ? 1 : 0, error || null],
  ]]);
  return runId;
}

/**
 * Record a single step's result. Call this for each step in the macro.
 */
export async function recordStepResult({ runId, stepId, stepCmd, ok, result, durationMs }) {
  if (!await _isEnabled() || !runId) return;
  await _pipeline([[
    `INSERT OR REPLACE INTO step_results (run_id, step_id, step_cmd, ok, result, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [runId, stepId, stepCmd, ok ? 1 : 0,
     JSON.stringify(result || {}).slice(0, 65000),  // cap at 65KB to avoid row size limits
     durationMs || 0],
  ]]);
}

/**
 * Capture a token (PAT, access_token, session cookie, etc.) for an account.
 * Call this when a macro captures a credential worth persisting.
 */
export async function captureToken({ service, email, tokenType, tokenValue }) {
  if (!await _isEnabled()) return;
  await _ensureSchema();
  await _pipeline([[
    `INSERT OR REPLACE INTO captured_tokens (service, email, token_type, token_value, captured_at)
     VALUES (?, ?, ?, ?, ?)`,
    [service, email, tokenType, tokenValue, Math.floor(Date.now() / 1000)],
  ]]);
}
