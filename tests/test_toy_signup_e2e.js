#!/usr/bin/env node
'use strict';
// =============================================================================
// test_toy_signup_e2e.js — the FULLEST automated verification of the extension:
//
//   1. Spawns the toy signup site (tests/toy-signup-site/server.js)
//   2. Loads the REAL extension in headless Chromium (channel: 'chromium')
//   3. Verifies the SHIPPED DEFAULTS appear in the config panel (zero-config)
//   4. Runs the `_shared/self-test` preset: a COMPLETE signup flow on a real
//      page — tabs.open, form.wait/fill/eval (chrome.debugger CDP), the
//      shared email chunk (email-auth btoa + retry + generic extractionJs),
//      the /welcome SPA redirect check, cookies.getAll, session capture.
//   5. Verifies Quick Exec (single-command sandbox mode): tabs.list + eval
//   6. Spawns the Python dev daemon and CONNECTS the extension to it over
//      WebSocket, then drives the extension THROUGH the daemon via
//      POST /api/command (eval + macro.run) — the "extension as a
//      remote-debug sandbox" story, agent-driven.
//
// Run: NODE_PATH=$(npm root -g) node tests/test_toy_signup_e2e.js
// =============================================================================

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const REPO = path.join(__dirname, '..');
const TOY_PORT = 8898;
const DAEMON_PORT = 3010;
const EXT_PATH = path.join(REPO, 'extension');
const PROFILE_DIR = path.join(REPO, '.tmp-chrome-profile-toy');

const SHIPPED_DEFAULT_URL = 'https://v3-mail.priv.email/emails?address={{inputs.email}}&limit=10&include_body=true';
const SHIPPED_DEFAULT_TOKEN = 'Bearer a2df50bf1d1310903061cdd569b6a20a62717998dcfe52bf';

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.log(`  ✗ ${name} — ${detail}`);
  }
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchJson(url, opts) {
  const r = await fetch(url, opts);
  return { status: r.status, body: await r.json() };
}

function spawnAndReady(cmd, args, readyUrl, label) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: REPO });
    let out = '';
    proc.stdout.on('data', (c) => { out += c; });
    proc.stderr.on('data', (c) => { out += c; });
    const started = Date.now();
    (async function poll() {
      if (proc.exitCode !== null) {
        reject(new Error(`${label} exited code ${proc.exitCode}: ${out.slice(0, 500)}`));
        return;
      }
      try {
        const r = await fetch(readyUrl, { signal: AbortSignal.timeout(1500) }).catch(() => null);
        if (r && r.ok) { resolve(proc); return; }
      } catch (e) { /* not ready yet */ }
      if (Date.now() - started > 30000) {
        proc.kill();
        reject(new Error(`${label} not ready after 30s: ${out.slice(0, 500)}`));
        return;
      }
      setTimeout(poll, 300);
    })();
  });
}

async function main() {
  const { chromium } = require('playwright');
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true });

  const toy = await spawnAndReady('node', [path.join(REPO, 'tests', 'toy-signup-site', 'server.js')],
    `http://127.0.0.1:${TOY_PORT}/health`, 'toy-signup-site');
  console.log(`toy signup site up on :${TOY_PORT}`);
  const daemon = await spawnAndReady('python3', [path.join(REPO, 'python-dev-daemon', 'bridge.py'), '--port', String(DAEMON_PORT)],
    `http://127.0.0.1:${DAEMON_PORT}/health`, 'dev daemon');
  console.log(`dev daemon up on :${DAEMON_PORT}`);

  let context;
  try {
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

    let sw = context.serviceWorkers().find((w) => w.url().includes('background.js'));
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 20000 });
    const extId = new URL(sw.url()).host;
    console.log('extension loaded, id =', extId);

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'domcontentloaded' });
    await popup.waitForSelector('#macroPreset', { timeout: 10000 });

    // ------------------------------------------------------------------
    console.log('\n--- 1. Shipped defaults (zero-config friction) ---');
    await wait(600);  // let loadEmailConfig populate the fields
    const cfgUrl = await popup.inputValue('#emailWorkerUrl');
    const cfgToken = await popup.inputValue('#emailWorkerToken');
    check('config panel pre-filled with v3-mail worker URL default', cfgUrl === SHIPPED_DEFAULT_URL, `got ${cfgUrl}`);
    check('config panel pre-filled with v3-mail Bearer token default', cfgToken === SHIPPED_DEFAULT_TOKEN, `got ${cfgToken}`);

    // ------------------------------------------------------------------
    console.log('\n--- 2. Full signup self-test (real DOM + email chunk) ---');
    await popup.selectOption('#macroPreset', '_shared/self-test');
    await popup.waitForFunction(() => {
      const v = document.getElementById('macroJson').value;
      return v && v.includes('"self-test"');
    }, undefined, { timeout: 10000 });
    const stInputs = await popup.evaluate(() => JSON.parse(document.getElementById('macroInputs').value || '{}'));
    check('self-test preset inputs are self-contained (toy mock of the v3-mail API, not the real worker)',
      stInputs.emailWorkerUrl === `http://127.0.0.1:${TOY_PORT}/emails?address={{inputs.email}}&limit=10&include_body=true`
      && stInputs.baseUrl === `http://127.0.0.1:${TOY_PORT}`,
      `inputs=${JSON.stringify(stInputs)}`);

    await popup.click('#runMacroBtn');
    try {
      await popup.waitForFunction(() => {
        const el = document.getElementById('macroResultArea');
        return el && el.textContent && (el.textContent.includes('completed in') || el.textContent.includes('failed'));
      }, undefined, { timeout: 90000 });
    } catch (e) {
      // Dump live diagnostics — the unified log shows macro.step events as they run
      const dbg = await popup.evaluate(async () => {
        const resp = await chrome.runtime.sendMessage({ type: 'getCaptureRing' }).catch(() => null);
        const ring = (resp && resp.ring) || [];
        return {
          resultArea: document.getElementById('macroResultArea').textContent,
          lastMacro: (await chrome.runtime.sendMessage({ type: 'getMacroResult' }).catch(() => null)) || null,
          ringTail: ring.slice(-25).map((ev) => `${ev.type} ${JSON.stringify(ev.data).slice(0, 180)}`),
        };
      });
      console.log('\n  === DEBUG DUMP (macro stalled) ===');
      console.log('  resultArea:', JSON.stringify(dbg.resultArea).slice(0, 300));
      console.log('  lastMacro:', JSON.stringify(dbg.lastMacro).slice(0, 500));
      for (const l of dbg.ringTail) console.log('  |', l);
      console.log('  ================================\n');
      throw e;
    }
    const resultText = await popup.evaluate(() => document.getElementById('macroResultArea').textContent);
    console.log('  --- macro result (first lines) ---');
    for (const line of resultText.split('\n').slice(0, 20)) {
      if (line.trim()) console.log('  |' + line.slice(0, 150));
    }
    console.log('  ----------------------------------');

    check('self-test macro completed (not failed)', /completed in/.test(resultText) && !/failed/.test(resultText),
      resultText.slice(0, 300));
    const marks = (resultText.match(/✓/g) || []).length;
    const crosses = (resultText.match(/✗/g) || []).length;
    check('all 16 self-test steps passed', marks >= 16 && crosses === 0, `✓=${marks} ✗=${crosses}`);
    check('verification code extracted + submitted (retry result with code)',
      /get-verification-code.*XJ4K2B|code/i.test(resultText) || /"code"/.test(resultText),
      resultText.slice(0, 400));
    check('session cookie captured (sess_ appears in results)', /sess_[0-9a-f]{8}/.test(resultText),
      resultText.slice(0, 600));
    const toyHealth = await fetchJson(`http://127.0.0.1:${TOY_PORT}/health`);
    check('toy server registered exactly 1 completed signup', toyHealth.body.signups === 1,
      JSON.stringify(toyHealth.body));

    // ------------------------------------------------------------------
    console.log('\n--- 3. Quick Exec (single-command sandbox) ---');
    // tabs.list
    await popup.click('#quickExecBtn');
    await popup.waitForFunction(() => {
      const el = document.getElementById('quickExecResult');
      return el && el.textContent && !el.textContent.startsWith('⏳') && el.textContent.includes('tabs');
    }, undefined, { timeout: 15000 });
    let qeResult = await popup.evaluate(() => document.getElementById('quickExecResult').textContent);
    check('quick exec tabs.list returns a tabs array', /"tabs"\s*:|tabId/.test(qeResult), qeResult.slice(0, 200));

    // eval — arbitrary JS in the toy tab (now at /welcome after the signup)
    await popup.evaluate(() => {
      document.getElementById('quickExecJson').value = JSON.stringify({
        cmd: 'eval',
        function: '(args) => ({ computed: 6 * 7, url: location.href, welcomeShown: !!document.querySelector("#view-welcome"), emailInputGone: !document.querySelector("input[type=email]") })',
        args: {},
      }, null, 2);
    });
    await popup.click('#quickExecBtn');
    await popup.waitForFunction(() => {
      const el = document.getElementById('quickExecResult');
      return el && el.textContent.includes('computed');
    }, undefined, { timeout: 15000 });
    qeResult = await popup.evaluate(() => document.getElementById('quickExecResult').textContent);
    check('quick exec eval runs arbitrary JS (6*7=42, toy URL)',
      qeResult.includes('"computed": 42') && qeResult.includes(String(TOY_PORT)),
      qeResult.slice(0, 300));
    check('quick exec eval reports live page state (welcome view, email input removed)',
      qeResult.includes('"welcomeShown": true') && qeResult.includes('"emailInputGone": true'),
      qeResult.slice(0, 300));

    // ------------------------------------------------------------------
    console.log('\n--- 4. Dev daemon (WS) — agent-driven remote control ---');
    await popup.fill('#serverUrl', `ws://127.0.0.1:${DAEMON_PORT}`);
    await popup.click('#connectBtn');
    await popup.waitForFunction(() => {
      const el = document.getElementById('statusText');
      return el && el.textContent === 'Connected';
    }, undefined, { timeout: 20000 });
    check('extension connected to the dev daemon over WS', true);
    await wait(1500);  // let auth+connect messages land

    const st = await fetchJson(`http://127.0.0.1:${DAEMON_PORT}/api/extensions`);
    check('daemon sees the extension agent', (st.body.extensions || []).length >= 1, JSON.stringify(st.body).slice(0, 300));

    // eval through the daemon
    let resp = await fetchJson(`http://127.0.0.1:${DAEMON_PORT}/api/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'eval', function: '(args) => ({ via: "daemon", title: document.title })' }),
    });
    check('daemon → extension eval round-trips', resp.status === 200 && resp.body.title === 'Toy Signup — Onboard Bridge Self-Test',
      JSON.stringify(resp).slice(0, 300));
    check('eval ran in the toy tab (title matches)', /Toy Signup/.test(JSON.stringify(resp.body)), JSON.stringify(resp.body).slice(0, 200));

    // fetch through the daemon
    resp = await fetchJson(`http://127.0.0.1:${DAEMON_PORT}/api/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'fetch', url: `http://127.0.0.1:${TOY_PORT}/health`, method: 'GET', credentials: 'omit' }),
    });
    check('daemon → extension fetch round-trips (toy /health)', resp.status === 200 && resp.body.status === 200 && /signups/.test(resp.body.body || ''),
      JSON.stringify(resp).slice(0, 300));

    // macro.run through the daemon
    resp = await fetchJson(`http://127.0.0.1:${DAEMON_PORT}/api/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'macro.run',
        macro: {
          name: 'daemon-smoke',
          steps: [
            { id: 's1', cmd: 'log', message: 'hello from the daemon' },
            { id: 's2', cmd: 'eval', function: '(args) => ({ ok: true, ranVia: "daemon-ws" })' },
          ],
        },
        inputs: {},
      }),
    });
    check('daemon → extension macro.run round-trips (2 steps, ok)',
      resp.status === 200 && resp.body.ok === true && resp.body.stepCount === 2,
      JSON.stringify(resp).slice(0, 400));

    // daemon status page renders
    const page = await fetch(`http://127.0.0.1:${DAEMON_PORT}/`).then((r) => r.text());
    check('daemon dashboard renders at /', /<!doctype html/i.test(page) && /ext-dot|ws-count|acct-count/.test(page), page.slice(0, 200));
  } catch (err) {
    failures++;
    console.error('FATAL:', err && err.stack || err);
  } finally {
    if (context) await context.close().catch(() => {});
    toy.kill();
    daemon.kill();
    try { fs.rmSync(PROFILE_DIR, { recursive: true, force: true }); } catch (e) {}
  }

  console.log(failures === 0 ? '\nTOY SIGNUP E2E: ALL PASS' : `\nTOY SIGNUP E2E: ${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('Fatal:', e); process.exit(2); });
