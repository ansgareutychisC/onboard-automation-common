#!/usr/bin/env node
'use strict';
// =============================================================================
// test_stop_and_fatal.js — regression tests for the two failures the user hit
// in the live Notion signup (2026-08-24 capture):
//
//   A. STOP BUTTON: a stuck email-polling loop must be cancellable from the
//      popup within seconds, buttons reset, and a fresh macro can run right
//      after (no stuck state, sticky debugger tabs detached).
//
//   B. FAIL-FAST FATAL: replaying the user's EXACT failure — the Notion code
//      email arrives ("Your Notion signup code", code in the BODY) — the
//      macro must abort within ~1-2 poll intervals with the actionable
//      message, not loop for 180s.
//
//   C. manualCode bypasses polling entirely.
//   D. code-in-subject still extracts (regression).
//
// Uses the standalone _shared/wait-for-verification-email chunk with the
// NOTION extractionJs (loaded from notion/signup.json — the exact code path
// that failed live) against a controllable mock inbox. No notion.com access
// needed (the sandbox IP can't pass hCaptcha anyway — that's the user-side
// test).
//
// Run: NODE_PATH=$(npm root -g) node tests/test_stop_and_fatal.js
// =============================================================================

const http = require('http');
const path = require('path');
const fs = require('fs');

const REPO = path.join(__dirname, '..');
const PORT = 8897;
const EXT_PATH = path.join(REPO, 'extension');
const PROFILE_DIR = path.join(REPO, '.tmp-chrome-profile-stop');

const MOCK_TOKEN = 'api:mock-improvmx-key';
const EXPECTED_AUTH = 'Basic ' + Buffer.from(MOCK_TOKEN, 'binary').toString('base64');
const TEST_EMAIL = 'stuck-test@priv.email';

const inbox = { mode: 'empty', polls: 0 };

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.log(`  ✗ ${name} — ${detail}`); }
}
function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

function startMockInbox() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
      if (u.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<!DOCTYPE html><html><body><h1>host page</h1></body></html>');
        return;
      }
      if (u.pathname === '/v3/domains/priv.email/logs') {
        inbox.polls++;
        const auth = req.headers['authorization'] || '';
        if (auth !== EXPECTED_AUTH) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code: 401, error: 'Authentication required' }));
          return;
        }
        let logs = [];
        if (inbox.mode === 'arrived-no-code') {
          // EXACT replay of the user's real capture: Notion's code email with
          // the code in the BODY, subject has no code.
          logs = [{
            created: Date.now(),
            subject: 'Your Notion signup code',
            sender: { email: 'notify@updates.notion.so', name: null },
            recipient: { email: TEST_EMAIL, name: null },
            forward: { email: 'user@hotmail.com', name: null },
            events: [{ status: 'DELIVERED', code: 250 }],
            id: 'replay-notion-real',
          }];
        } else if (inbox.mode === 'code-in-subject') {
          logs = [{
            created: Date.now(),
            subject: 'Your temporary Notion login code is ZQ7W3C',
            sender: { email: 'notify@updates.notion.so', name: null },
            recipient: { email: TEST_EMAIL, name: null },
            events: [{ status: 'DELIVERED', code: 250 }],
            id: 'replay-code-subject',
          }];
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, logs }));
        return;
      }
      res.writeHead(404); res.end('{}');
    });
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

async function main() {
  const { chromium } = require('playwright');
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
  const server = await startMockInbox();

  // The chunk macro + the NOTION extraction (the exact code path that failed
  // for the user live).
  const chunk = JSON.parse(fs.readFileSync(path.join(EXT_PATH, 'macros', '_shared', 'wait-for-verification-email.json'), 'utf8'));
  const notionExtraction = JSON.parse(fs.readFileSync(path.join(EXT_PATH, 'macros', 'notion', 'signup.json'), 'utf8')).inputs.extractionJs;

  const baseInputs = {
    email: TEST_EMAIL,
    emailWorkerUrl: `http://127.0.0.1:${PORT}/v3/domains/priv.email/logs?take=20`,
    emailWorkerToken: MOCK_TOKEN,
  };

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

    const hostPage = await context.newPage();
    await hostPage.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'domcontentloaded' });
    await popup.waitForSelector('#macroPreset', { timeout: 10000 });

    async function runChunk(extraInputs) {
      await popup.evaluate(([m, i]) => {
        document.getElementById('macroJson').value = JSON.stringify(m);
        document.getElementById('macroInputs').value = JSON.stringify(i);
      }, [chunk, { ...baseInputs, extractionJs: notionExtraction, ...extraInputs }]);
      await popup.click('#runMacroBtn');
    }
    async function waitForCompletion(timeoutMs) {
      const started = Date.now();
      await popup.waitForFunction(() => {
        const el = document.getElementById('macroResultArea');
        return el && el.textContent && (el.textContent.includes('completed in') || el.textContent.includes('failed'));
      }, undefined, { timeout: timeoutMs });
      return {
        elapsed: Date.now() - started,
        text: await popup.evaluate(() => document.getElementById('macroResultArea').textContent),
      };
    }

    // ------------------------------------------------------------------
    console.log('\n--- A. STOP BUTTON: cancel a stuck email-polling loop ---');
    inbox.mode = 'empty';
    inbox.polls = 0;
    await runChunk({});
    await wait(11000);  // ≥1 poll interval — the macro is now stuck polling
    const pollsBeforeStop = inbox.polls;
    check('macro is in the stuck polling state', pollsBeforeStop >= 1, `polls=${pollsBeforeStop}`);
    check('run button disabled while running',
      await popup.evaluate(() => document.getElementById('runMacroBtn').disabled));

    await popup.click('#stopMacroBtn');
    const { elapsed: stopElapsed, text: stopText } = await waitForCompletion(25000);
    check('macro ended after Stop (not the 180s timeout)', stopElapsed < 25000, `took ${stopElapsed}ms`);
    check('cancellation is reported to the user', /cancelled by user/i.test(stopText), stopText.slice(0, 300));
    check('run button re-enabled after cancellation',
      await popup.evaluate(() => !document.getElementById('runMacroBtn').disabled
        && document.getElementById('runMacroBtn').textContent.includes('Run')));
    check('stop button label reset (ready for the next run)',
      await popup.evaluate(() => document.getElementById('stopMacroBtn').textContent === 'Stop'));

    // A fresh macro must run immediately after (proves sticky debugger tabs
    // were detached and run-control flags were reset).
    inbox.mode = 'code-in-subject';
    await runChunk({});
    const { text: rerunText } = await waitForCompletion(60000);
    check('a fresh macro runs immediately after cancellation', /completed in/.test(rerunText), rerunText.slice(0, 300));

    // ------------------------------------------------------------------
    console.log('\n--- B. FAIL-FAST FATAL: exact replay of the user\'s failure ---');
    inbox.mode = 'arrived-no-code';
    inbox.polls = 0;
    await runChunk({});
    const { elapsed: fatalElapsed, text: fatalText } = await waitForCompletion(60000);
    const pollsUsed = inbox.polls;
    check('macro fails FAST (not the 180s timeout)', fatalElapsed < 60000 && pollsUsed <= 3,
      `took ${fatalElapsed}ms over ${pollsUsed} polls`);
    check('fails with the actionable body-code message', /email body/i.test(fatalText), fatalText.slice(0, 400));
    check('message points at the escape hatches (submit-code / manualCode)',
      /submit-code|manualCode/i.test(fatalText), fatalText.slice(0, 400));
    check('message mentions the forwarded mailbox / Junk', /hotmail|junk/i.test(fatalText), fatalText.slice(0, 400));

    // ------------------------------------------------------------------
    console.log('\n--- C. manualCode bypasses polling entirely ---');
    inbox.mode = 'arrived-no-code';  // fatal territory without manualCode
    inbox.polls = 0;
    await runChunk({ manualCode: 'ZQ7W3C' });
    const { elapsed: manualElapsed, text: manualText } = await waitForCompletion(60000);
    check('manualCode run completes (bypasses the unreadable email)', /completed in/.test(manualText), manualText.slice(0, 300));
    check('the manual code is in the results', manualText.includes('ZQ7W3C'), manualText.slice(0, 300));
    check('completed fast (no polling loop)', manualElapsed < 30000, `took ${manualElapsed}ms`);

    // ------------------------------------------------------------------
    console.log('\n--- D. code-in-subject still extracts (regression) ---');
    inbox.mode = 'code-in-subject';
    await runChunk({});
    const { text: subjectText } = await waitForCompletion(60000);
    check('code-in-subject mode completes', /completed in/.test(subjectText), subjectText.slice(0, 300));
    check('extracted code ZQ7W3C present', subjectText.includes('ZQ7W3C'), subjectText.slice(0, 300));

    // ------------------------------------------------------------------
    console.log('\n--- E. concurrent-run guard ---');
    inbox.mode = 'empty';
    await runChunk({});
    await wait(2500);
    // The popup's Run button is disabled while running — the guard matters
    // for non-UI triggers (daemon/WS). Send the runtime message directly.
    await popup.evaluate(async ([m, i]) => {
      await chrome.runtime.sendMessage({ type: 'runMacro', macro: m, inputs: i });
    }, [chunk, { ...baseInputs, extractionJs: notionExtraction }]);
    await wait(1500);
    const secondRunResult = await popup.evaluate(() => document.getElementById('macroResultArea').textContent);
    check('second run while one is active is rejected with a clear error',
      /already running|Stop first/i.test(secondRunResult), secondRunResult.slice(0, 300));
    // clean up: stop the still-running first macro (via the button — enabled during a run)
    await popup.click('#stopMacroBtn');
    await waitForCompletion(25000);
  } catch (err) {
    failures++;
    console.error('FATAL:', err && err.stack || err);
  } finally {
    if (context) await context.close().catch(() => {});
    server.close();
    try { fs.rmSync(PROFILE_DIR, { recursive: true, force: true }); } catch (e) {}
  }

  console.log(failures === 0 ? '\nSTOP-AND-FATAL E2E: ALL PASS' : `\nSTOP-AND-FATAL E2E: ${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('Fatal:', e); process.exit(2); });
