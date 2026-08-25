#!/usr/bin/env node
'use strict';
// =============================================================================
// test_extension_headless.js — End-to-end test of the ACTUAL Chrome MV3
// extension in headless Chromium (Playwright), against a local mock ImprovMX
// server.
//
// What it verifies (things a static/dry-run test cannot):
//   1. The extension loads: manifest valid, MV3 service worker (ES module,
//      imports lib/turso.js) starts, no registration errors.
//   2. The popup page opens, the config panel persists to
//      chrome.storage.local (emailWorkerUrl/Token, tursoUrl/Token).
//   3. The preset dropdown fetches a NESTED macro path
//      (macros/_shared/wait-for-verification-email.json) via
//      chrome.runtime.getURL — proves the manifest WAR + nested layout work.
//   4. Config values pre-fill the preset inputs.
//   5. Clicking "Run Macro" drives the REAL background macro runner:
//      email-auth eval (chrome.debugger + CDP Runtime.evaluate in the tab),
//      email-now eval, the retry loop fetching the mock ImprovMX /logs API
//      with the correct Basic Authorization header, extractionJs templating
//      ({{inputs.extractionJs}}), and the retry condition evaluation.
//   6. The macro completes with the verification code extracted.
//
// Requirements: Playwright with Chromium installed.
//   NODE_PATH=$(npm root -g) node tests/test_extension_headless.js
//
// The mock server binds 127.0.0.1:8899 (avoiding the sandbox's gateway ports).
// =============================================================================

const http = require('http');
const path = require('path');
const fs = require('fs');

const PORT = 8899;
const EXT_PATH = path.join(__dirname, '..', 'extension');
const PROFILE_DIR = path.join(__dirname, '..', '.tmp-chrome-profile');

const MOCK_TOKEN = 'api:mock-improvmx-key';
const EXPECTED_AUTH = 'Basic ' + Buffer.from(MOCK_TOKEN, 'binary').toString('base64');
const MOCK_EMAIL = 'test-signup@priv.email';
const MOCK_CODE = 'XJ4K2B';
const MOCK_TURSO_TOKEN = 'mock-turso-jwt-for-e2e';

// -----------------------------------------------------------------------------
// Mock ImprovMX server
// -----------------------------------------------------------------------------

const state = {
  logRequests: [],     // { ts, auth, phase }
  rootHits: 0,
  tursoRequests: [],   // { ts, auth, statements: [sql...] }
};

function startMockServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, `http://127.0.0.1:${PORT}`);

      if (u.pathname === '/' || u.pathname === '/index.html') {
        state.rootHits++;
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<!DOCTYPE html><html><body><h1>mock host page</h1></body></html>');
        return;
      }

      if (u.pathname === '/v3/domains/priv.email/logs') {
        const auth = req.headers['authorization'] || '';
        state.logRequests.push({ ts: Date.now(), auth, phase: state.logRequests.length });
        const attempt = state.logRequests.length;

        if (attempt < 2) {
          // Phase 1: no emails yet
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, logs: [] }));
        } else {
          // Phase 2+: the verification email arrives
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            logs: [{
              created: Date.now(),
              subject: `${MOCK_CODE} is your verification code`,
              sender: { email: 'noreply@example-service.test', name: null },
              recipient: { email: MOCK_EMAIL, name: null },
              forward: { email: 'user@hotmail.com', name: null },
              events: [{ status: 'DELIVERED', code: 250, message: '2.6.0 Queued' }],
              messageId: '<mock@example-service.test>',
              id: 'mock-log-id-' + attempt,
            }],
          }));
        }
        return;
      }

      if (u.pathname === '/turso/v2/pipeline') {
        // Mock Turso (libSQL HTTP pipeline) endpoint — records the statements
        // the extension sends, responds with an empty result set.
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          let stmts = [];
          try {
            const parsed = JSON.parse(body);
            stmts = (parsed.requests || []).map(r => ({
              sql: (r.stmt && r.stmt.sql) || '',
              args: ((r.stmt && r.stmt.args) || []).map(a => a.value),
            }));
          } catch (e) { /* ignore */ }
          state.tursoRequests.push({ ts: Date.now(), auth: req.headers['authorization'] || '', stmts });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ results: stmts.map(() => ({ type: 'ok', response: { result: { cols: [], rows: [] } } })) }));
        });
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

// -----------------------------------------------------------------------------
// Test driver
// -----------------------------------------------------------------------------

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.log(`  ✗ ${name} — ${detail}`);
  }
}

async function main() {
  const { chromium } = require('playwright');

  // Clean any previous profile so the run is deterministic
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true });

  const server = await startMockServer();
  console.log(`mock ImprovMX server listening on 127.0.0.1:${PORT}`);

  let context;
  try {
    // Launch Chromium with the extension loaded. New headless mode supports
    // MV3 extensions; `channel: 'chromium'` forces the full Chromium binary
    // (the default `headless: true` without a channel uses headless-shell,
    // which silently ignores --load-extension).
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      channel: 'chromium',
      headless: true,
      viewport: { width: 1280, height: 800 },
      args: [
        `--disable-extensions-except=${EXT_PATH}`,
        `--load-extension=${EXT_PATH}`,
        '--no-sandbox',
        '--disable-dev-shm-usage',
      ],
    });
    console.log('chromium launched (new headless) with extension at', EXT_PATH);

    // --- 1. Wait for the extension service worker -------------------------
    let sw = context.serviceWorkers().find(w => w.url().includes('background.js'));
    if (!sw) {
      console.log('waiting for extension service worker...');
      sw = await context.waitForEvent('serviceworker', { timeout: 20000 });
    }
    const extId = new URL(sw.url()).host;
    console.log('extension loaded, id =', extId);
    check('MV3 service worker registered', !!sw && sw.url().endsWith('background.js'), `sw.url=${sw && sw.url()}`);

    // Give the SW a moment to finish top-level module evaluation
    await sw.evaluate('1+1').catch(() => {});

    // --- 2. Open a host tab (needed as the chrome.debugger eval target) ---
    const hostPage = await context.newPage();
    await hostPage.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
    check('mock host page opened (eval target tab)', state.rootHits >= 1, `rootHits=${state.rootHits}`);

    // --- 3. Open the popup page as a tab -----------------------------------
    const popup = await context.newPage();
    const popupUrl = `chrome-extension://${extId}/popup.html`;
    const consoleErrors = [];
    popup.on('pageerror', (err) => consoleErrors.push(String(err)));
    await popup.goto(popupUrl, { waitUntil: 'domcontentloaded' });
    await popup.waitForSelector('#macroPreset', { timeout: 10000 });
    check('popup page opens without fatal errors', true);

    // --- 4. Config panel: fill + persistence -------------------------------
    await popup.fill('#emailWorkerUrl', `http://127.0.0.1:${PORT}/v3/domains/priv.email/logs?take=20`);
    await popup.fill('#emailWorkerToken', MOCK_TOKEN);
    await popup.fill('#tursoUrl', `http://127.0.0.1:${PORT}/turso`);
    await popup.fill('#tursoToken', MOCK_TURSO_TOKEN);
    // wait for the debounced save (500ms) + indicator
    await popup.waitForSelector('#configSaved.show', { timeout: 5000 });
    await popup.waitForTimeout(300);

    const stored = await popup.evaluate(() => chrome.storage.local.get(null));
    check('config persisted to chrome.storage.local',
      stored.emailWorkerUrl === `http://127.0.0.1:${PORT}/v3/domains/priv.email/logs?take=20`
      && stored.emailWorkerToken === MOCK_TOKEN
      && stored.tursoUrl === `http://127.0.0.1:${PORT}/turso`
      && stored.tursoToken === MOCK_TURSO_TOKEN,
      `stored=${JSON.stringify(stored).slice(0, 200)}`);

    // --- 5. Preset: nested macro fetch + input prefill ---------------------
    await popup.selectOption('#macroPreset', '_shared/wait-for-verification-email');
    await popup.waitForFunction(() => {
      const v = document.getElementById('macroJson').value;
      return v && v.includes('wait-for-verification-email');
    }, undefined, { timeout: 10000 });
    check('preset loads nested macros/_shared/*.json via runtime.getURL', true);

    const prefilled = await popup.evaluate(() => JSON.parse(document.getElementById('macroInputs').value || '{}'));
    check('preset inputs pre-filled from config panel',
      prefilled.emailWorkerUrl === `http://127.0.0.1:${PORT}/v3/domains/priv.email/logs?take=20`
      && prefilled.emailWorkerToken === MOCK_TOKEN,
      `prefilled=${JSON.stringify(prefilled)}`);

    // Set the email input in the inputs JSON
    await popup.evaluate((email) => {
      const ta = document.getElementById('macroInputs');
      const obj = JSON.parse(ta.value || '{}');
      obj.email = email;
      ta.value = JSON.stringify(obj, null, 2);
    }, MOCK_EMAIL);

    // --- 6. Run the macro ----------------------------------------------------
    state.logRequests.length = 0;  // count only run-time requests
    await popup.click('#runMacroBtn');

    // Wait for completion — the result area gets the summary
    const ok = await popup.waitForFunction(() => {
      const el = document.getElementById('macroResultArea');
      return el && el.textContent && (el.textContent.includes('completed in') || el.textContent.includes('failed'));
    }, { timeout: 60000 }).then(() => true).catch(() => false);

    const resultText = await popup.evaluate(() => document.getElementById('macroResultArea').textContent);
    console.log('\n  --- macro result area ---');
    for (const line of resultText.split('\n')) {
      if (line.trim()) console.log('  |' + line.slice(0, 160));
    }
    console.log('  -------------------------\n');

    check('macro run finished (success or failure reported)', ok, 'timed out waiting for macro-complete');

    const emailFetches = state.logRequests.filter(r => r.phase >= 0);
    check('email API polled at least twice (retry loop live)',
      state.logRequests.length >= 2, `logRequests=${state.logRequests.length}`);
    check('Authorization header correct on every poll (Basic auth chain works)',
      state.logRequests.length > 0 && state.logRequests.every(r => r.auth === EXPECTED_AUTH),
      `auths=${JSON.stringify(state.logRequests.map(r => r.auth))}`);
    check('verification code extracted end-to-end', resultText.includes(MOCK_CODE),
      `resultText=${JSON.stringify(resultText.slice(0, 300))}`);
    check('macro completed successfully (not failed)', /completed in/.test(resultText) && !/failed/.test(resultText),
      resultText.slice(0, 300));
    check('all 4 steps passed (17/17-style counts)', (resultText.match(/✓/g) || []).length >= 4,
      `checkmarks=${(resultText.match(/✓/g) || []).length}`);
    check('no popup page errors during run', consoleErrors.length === 0, consoleErrors.join(' | ').slice(0, 300));

    // --- 7. Turso persistence wire format ----------------------------------
    // recordMacroRun/recordStepResult are fire-and-forget — give them a moment
    await popup.waitForTimeout(1500);
    const tursoAuths = state.tursoRequests.map(r => r.auth);
    check('Turso pipeline POSTs carry the Bearer token',
      tursoAuths.length > 0 && tursoAuths.every(a => a === `Bearer ${MOCK_TURSO_TOKEN}`),
      `auths=${JSON.stringify(tursoAuths)}`);
    const allStmts = state.tursoRequests.flatMap(r => r.stmts);
    const createTables = allStmts.filter(s => /CREATE TABLE IF NOT EXISTS/.test(s.sql));
    check('Turso schema auto-created (3 tables)',
      createTables.length === 3
      && createTables.some(s => s.sql.includes('macro_runs'))
      && createTables.some(s => s.sql.includes('step_results'))
      && createTables.some(s => s.sql.includes('captured_tokens')),
      `createTables=${JSON.stringify(createTables.map(s => s.sql.slice(0, 60)))}`);
    const runInsert = allStmts.find(s => /INSERT INTO macro_runs/.test(s.sql));
    check('macro run recorded in macro_runs', !!runInsert,
      `sqls=${JSON.stringify(allStmts.slice(0, 8).map(s => s.sql.slice(0, 60)))}`);
    if (runInsert) {
      // args: [runId, service, macroName, inputsJson, startedAt, finishedAt, ok, error]
      check('macro_runs row is parameterized with service=shared + macro name + ok=1',
        runInsert.args[1] === 'shared'
        && runInsert.args[2] === 'wait-for-verification-email'
        && runInsert.args[6] === 1,
        `args=${JSON.stringify(runInsert.args)}`);
      check('macro_runs inputs JSON carries the resolved email config',
        JSON.stringify(runInsert.args[3]).includes(MOCK_EMAIL)
        && JSON.stringify(runInsert.args[3]).includes('127.0.0.1'),
        `inputs=${JSON.stringify(runInsert.args[3]).slice(0, 200)}`);
    }
    const stepInserts = allStmts.filter(s => /INSERT OR REPLACE INTO step_results/.test(s.sql));
    check('per-step results recorded in step_results', stepInserts.length >= 4,
      `stepInserts=${stepInserts.length}`);
    if (stepInserts.length >= 4) {
      const stepIds = stepInserts.map(s => s.args[1]);
      check('step_results rows carry the chunk step ids',
        ['email-auth', 'email-now', 'get-verification-code', 'log-got-code'].every(id => stepIds.includes(id)),
        `stepIds=${JSON.stringify(stepIds)}`);
    }

    // --- 8. Service worker still alive ------------------------------------
    const swAlive = await sw.evaluate('1+1').then(r => r === 2).catch(() => false);
    check('service worker still alive after run (Turso path exercised)', swAlive);
  } catch (err) {
    failures++;
    console.error('FATAL:', err && err.stack || err);
  } finally {
    if (context) await context.close().catch(() => {});
    server.close();
    try { fs.rmSync(PROFILE_DIR, { recursive: true, force: true }); } catch (e) {}
  }

  console.log(failures === 0 ? '\nHEADLESS EXTENSION E2E: ALL PASS' : `\nHEADLESS EXTENSION E2E: ${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('Fatal:', e); process.exit(2); });
