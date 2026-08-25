#!/usr/bin/env node
'use strict';
// test_email_extraction_live.js — validate the extractionJs functions from the
// macros against the REAL ImprovMX API response (fetched live at test time),
// plus synthetic Notion-style entries injected into the real response shape.
//
// Run: node tests/test_email_extraction_live.js
// Exit 0 = all assertions pass.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const https = require('https');

const MACROS = {
  shared: path.join(__dirname, '..', 'extension', 'macros', '_shared', 'wait-for-verification-email.json'),
  notion: path.join(__dirname, '..', 'extension', 'macros', 'notion', 'signup.json'),
};

const API_KEY = process.env.IMPROVMX_KEY || 'sk_691ff26633c94b0d80523433afe3a369';
const API_URL = 'https://api.improvmx.com/v3/domains/priv.email/logs?take=20';

function fetchJson(url, authHeader) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    https.get(url, { headers: { Authorization: authHeader }, hostname: u.hostname, path: u.pathname + u.search }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: data }); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function runExtraction(fnSource, args) {
  const sandbox = {
    Date, JSON, Math,
    // btoa/atob exist in the browser tab contexts where the extension's eval
    // steps actually run (CDP Runtime.evaluate in a tab's main world) — provide
    // them here so the sandbox matches the real execution environment.
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    console: { log: () => {}, error: () => {}, warn: () => {} },
    args,
  };
  vm.createContext(sandbox);
  return vm.runInContext(`(${fnSource})(args)`, sandbox, { timeout: 5000 });
}

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
  const sharedMacro = JSON.parse(fs.readFileSync(MACROS.shared, 'utf8'));
  const notionMacro = JSON.parse(fs.readFileSync(MACROS.notion, 'utf8'));
  const genericJs = sharedMacro.inputs.extractionJs;
  const notionJs = notionMacro.inputs.extractionJs;

  // --- 1. Build the Basic auth header the same way the email-auth step does
  const b64 = Buffer.from(`api:${API_KEY}`, 'binary').toString('base64');
  const authHeader = 'Basic ' + b64;
  console.log('1. Auth header built: Basic ' + b64.slice(0, 12) + '...');

  // --- 2. Live fetch the real logs
  console.log(`2. Fetching live logs from ${API_URL} ...`);
  const resp = await fetchJson(API_URL, authHeader);
  check('live API responds 200', resp.status === 200, `status=${resp.status}`);
  const live = JSON.parse(resp.body);
  check('live response has logs[] array', Array.isArray(live.logs), `keys=${Object.keys(live)}`);
  console.log(`   (real logs in window: ${live.logs.length}; subjects: ${live.logs.map(l => JSON.stringify((l.subject || '').slice(0, 40))).join(', ')})`);

  // --- 3. Generic extraction vs live data: current window has no code emails
  const r1 = runExtraction(genericJs, { body: resp.body, email: 'admin@priv.email', sinceMs: 0 });
  check('generic: no false positive on real non-code subjects', r1.code == null,
    `unexpectedly extracted code=${JSON.stringify(r1.code)} from "${(r1.subject || '').slice(0, 60)}"`);

  // --- 4. Notion extraction vs live data: no notion mail present
  const r2 = runExtraction(notionJs, { body: resp.body, email: 'admin@priv.email', sinceMs: 0 });
  check('notion: no false positive when no Notion mail', r2.code == null, `code=${JSON.stringify(r2.code)}`);

  // --- 5. Inject synthetic Notion emails into the REAL response shape and
  //        verify extraction across subject variants + filters.
  const now = Date.now();
  function withLogs(extraLogs) {
    const clone = JSON.parse(resp.body);
    clone.logs = [...extraLogs, ...(clone.logs || [])];
    return JSON.stringify(clone);
  }
  const mk = (subject, opts = {}) => ({
    created: opts.created != null ? opts.created : now,
    subject,
    sender: { email: opts.sender || 'team@notion.so', name: 'Notion' },
    recipient: { email: opts.to || 'test-signup@priv.email', name: null },
    forward: { email: 'user@hotmail.com', name: null },
    events: [{ status: 'DELIVERED', code: 250 }],
    messageId: '<mock@notion.so>',
    id: opts.id || 'synthetic-' + Math.random().toString(36).slice(2, 8),
  });

  const cases = [
    // [description, subject, expectedCode]
    ['Notion layer1: "XJ4K2B is your Notion login code"', 'XJ4K2B is your Notion login code', 'XJ4K2B'],
    ['Notion layer2: "Your temporary Notion login code is 7GQ2MP"', 'Your temporary Notion login code is 7GQ2MP', '7GQ2MP'],
    ['Notion layer2: "Your login code: AB12CD"', 'Your login code: AB12CD', 'AB12CD'],
    ['Notion numeric: "Your login code is 482913"', 'Your login code is 482913', '482913'],
    ['Generic layer1: "KQ9Z4W is your verification code"', 'KQ9Z4W is your verification code', 'KQ9Z4W'],
    ['Generic OTP: "Your one-time code 553201"', 'Your one-time code 553201', '553201'],
  ];
  for (const [desc, subject, expected] of cases) {
    const body = withLogs([mk(subject)]);
    const rn = runExtraction(notionJs, { body, email: 'test-signup@priv.email', sinceMs: 0 });
    check(`notion extraction: ${desc}`, rn.code === expected, `got ${JSON.stringify(rn)}`);
    const rg = runExtraction(genericJs, { body, email: 'test-signup@priv.email', sinceMs: 0 });
    check(`generic extraction: ${desc}`, rg.code === expected, `got ${JSON.stringify(rg)}`);
  }

  // --- 6. Filter behaviors
  // 6a. sinceMs: older email must be skipped, newer one found
  const bodyAge = withLogs([mk('Old code 111111', { created: now - 3600_000 }), mk('Your login code is 999888', { created: now - 1000 })]);
  const rAge = runExtraction(notionJs, { body: bodyAge, email: 'test-signup@priv.email', sinceMs: now - 60_000 });
  check('sinceMs skips older email, picks newer', rAge.code === '999888', `got ${JSON.stringify(rAge)}`);

  // 6b. recipient filter: email for another alias must be skipped
  const bodyRcpt = withLogs([mk('Your login code is AAA222', { to: 'someone-else@priv.email' }), mk('Your login code is BBB333')]);
  const rRcpt = runExtraction(notionJs, { body: bodyRcpt, email: 'test-signup@priv.email', sinceMs: 0 });
  check('recipient filter skips other aliases', rRcpt.code === 'BBB333', `got ${JSON.stringify(rRcpt)}`);

  // 6c. non-notion sender + non-notion subject must be skipped by notion extraction
  const bodyFrom = withLogs([mk('Your login code is CCC444', { sender: 'noreply@example.com' })]);
  const rFrom = runExtraction(notionJs, { body: bodyFrom, email: 'test-signup@priv.email', sinceMs: 0 });
  check('notion filter skips non-notion mail', rFrom.code == null, `got ${JSON.stringify(rFrom)}`);
  // ...but the generic extraction still finds it (no sender filter)
  const rFromG = runExtraction(genericJs, { body: bodyFrom, email: 'test-signup@priv.email', sinceMs: 0 });
  check('generic extraction has no sender filter (finds it)', rFromG.code === 'CCC444', `got ${JSON.stringify(rFromG)}`);

  // 6d. spam subject must not produce a false positive
  const bodySpam = withLogs([mk('~ Your ATM Visa Card')]);
  const rSpam = runExtraction(genericJs, { body: bodySpam, email: 'test-signup@priv.email', sinceMs: 0 });
  check('spam subject produces no code', rSpam.code == null, `got ${JSON.stringify(rSpam)}`);

  // --- 7. email-auth eval step behavior
  const authFn = sharedMacro.steps.find(s => s.id === 'email-auth').function;
  const rAuth1 = runExtraction(authFn, { token: '' });
  check('email-auth: empty token → ok:false with clear error', rAuth1.ok === false && /config panel/.test(rAuth1.error), JSON.stringify(rAuth1));
  const rAuth2 = runExtraction(authFn, { token: `api:${API_KEY}` });
  check('email-auth: raw pair → Basic header', rAuth2.header === authHeader, JSON.stringify(rAuth2).slice(0, 80));
  const rAuth3 = runExtraction(authFn, { token: 'Bearer abc123' });
  check('email-auth: ready-made Bearer header passes through', rAuth3.header === 'Bearer abc123', JSON.stringify(rAuth3));

  // --- 8. REGRESSION: replay the REAL captured failure (2026-08-24).
  // Notion's code email arrived with subject "Your Notion signup code" —
  // the code is in the BODY. Subject-only extraction must fail FATAL with
  // the actionable message, and manualCode must bypass it.
  const realFixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'improvmx-logs-notion-real.json'), 'utf8');
  const notionJs2 = JSON.parse(fs.readFileSync(MACROS.notion, 'utf8')).inputs.extractionJs;
  const since = JSON.parse(realFixture).logs[0].created + 1000;
  const rr = runExtraction(notionJs2, { body: realFixture, email: 'onboard@priv.email', sinceMs: since });
  check('REGRESSION real capture: code email w/o code in subject → fatal',
    rr.fatal === true && /email body/i.test(rr.error || ''), JSON.stringify(rr).slice(0, 300));
  check('REGRESSION real capture: fatal message names the escape hatches',
    /submit-code|manualCode/i.test(rr.error || ''), (rr.error || '').slice(0, 200));
  const rm = runExtraction(notionJs2, { body: realFixture, email: 'onboard@priv.email', sinceMs: since, manualCode: 'ABC123' });
  check('REGRESSION real capture: manualCode bypasses the unreadable email',
    rm.code === 'ABC123' && rm.source === 'manual', JSON.stringify(rm));
  const rg = runExtraction(genericJs, { body: realFixture, email: 'onboard@priv.email', sinceMs: since });
  check('REGRESSION real capture: generic extraction also fails fatal (not silently)',
    rg.fatal === true, JSON.stringify(rg).slice(0, 300));

  console.log(failures === 0 ? '\nALL LIVE EXTRACTION TESTS PASS' : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('Fatal:', e.message); process.exit(2); });
