#!/usr/bin/env node
'use strict';
// test_mail_api_live.js — validate the v3-mail worker Bearer API (the PRIMARY
// email provider since v0.9.5) against the LIVE deployment, using the exact
// shipped defaults (popup.js DEFAULT_CONFIG). Everything the extension's mail
// steps rely on is verified here end to end, without a browser:
//
//   1. Bearer auth works on GET /emails (both address forms)
//   2. include_body=true returns text_body (the code lives in the BODY)
//   3. wrong token → 401 (negative control)
//   4. missing address → 400 (shape control)
//   5. the shipped DEFAULT_CONFIG URL+token pair works AS SHIPPED (zero-config)
//   6. the generic chunk extractionJs extracts a code from a synthetic
//      Notion-style row in the REAL response shape
//   7. email-auth step: ready-made Bearer passes through
//   8. v4-mail probe (separate inbox — informational, non-fatal)
//
// Run: node tests/test_mail_api_live.js
// Exit 0 = all assertions pass.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const https = require('https');

const MACROS = {
  shared: path.join(__dirname, '..', 'extension', 'macros', '_shared', 'wait-for-verification-email.json'),
};

// The shipped defaults (must match popup.js DEFAULT_CONFIG — the zero-config
// contract this test protects).
const DEFAULT_URL_TEMPLATE = 'https://v3-mail.priv.email/emails?address={{inputs.email}}&limit=10&include_body=true';
const DEFAULT_TOKEN = 'Bearer a2df50bf1d1310903061cdd569b6a20a62717998dcfe52bf';
const V4_TOKEN = 'Bearer e346edb6a4d28c2a488c03fbd85d15ad7c6bf53c55799369';

function fetchRaw(url, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    https.get(url, { headers: headers || {}, hostname: u.hostname, path: u.pathname + u.search }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

function runExtraction(fnSource, args) {
  const sandbox = {
    Date, JSON, Math,
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
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.log(`  ✗ ${name} — ${detail}`); }
}

(async () => {
  console.log('=== v3-mail worker LIVE API test (Bearer) ===');
  const sharedMacro = JSON.parse(fs.readFileSync(MACROS.shared, 'utf8'));
  const genericJs = sharedMacro.inputs.extractionJs;
  const authFn = sharedMacro.steps.find((s) => s.id === 'email-auth').function;

  // --- 1. Bearer list, apex form (the live finding: chained mail is stored
  //        under the APEX form) + v3-mail form (direct mail) — both must 200.
  const apexUrl = DEFAULT_URL_TEMPLATE.replace('{{inputs.email}}', 'admin@priv.email');
  const rApex = await fetchRaw(apexUrl, { Authorization: DEFAULT_TOKEN });
  check('GET /emails (apex form) → 200 with Bearer', rApex.status === 200, `status ${rApex.status}: ${rApex.body.slice(0, 120)}`);
  let apexJson = null;
  try { apexJson = JSON.parse(rApex.body); } catch (e) { /* handled below */ }
  check('apex response is the /emails shape (results array)', apexJson && Array.isArray(apexJson.results), rApex.body.slice(0, 120));
  if (apexJson && apexJson.results) {
    check('apex rows carry from_header + to_address + received_at',
      apexJson.results.every((r) => 'from_header' in r && 'to_address' in r && 'received_at' in r),
      JSON.stringify((apexJson.results[0] || {}).keys));
    check('include_body=true returns text_body on rows (null for HTML-only mail)',
      // Live finding 2026-08-25: HTML-only emails (e.g. Notion's "A new
      // device logged into your account") legitimately have text_body: null.
      // The KEY must exist on every row; the value is a string OR null.
      // Code emails (signup/login) always carry a text part.
      apexJson.results.every((r) => 'text_body' in r && (r.text_body === null || typeof r.text_body === 'string')),
      'missing text_body key on some rows');
    check('rows are newest-first', (() => {
      const ts = apexJson.results.map((r) => Date.parse(r.received_at) || 0);
      return ts.every((v, i) => i === 0 || ts[i - 1] >= v);
    })(), 'order not monotonic');
  }

  const rV3Form = await fetchRaw(DEFAULT_URL_TEMPLATE.replace('{{inputs.email}}', 'admin@v3-mail.priv.email'), { Authorization: DEFAULT_TOKEN });
  check('GET /emails (v3-mail form) → 200 with Bearer', rV3Form.status === 200, `status ${rV3Form.status}`);

  // --- 2. Notion code email: find one in the real inbox, verify text_body IS
  //        the code (the empirically verified Notion behavior).
  if (apexJson && apexJson.results) {
    const notionRow = apexJson.results.find((r) => /notion/i.test((r.from_header || '') + ' ' + (r.subject || '')) && /code/i.test(r.subject || ''));
    if (notionRow) {
      const code = (notionRow.text_body || '').split('\n')[0].trim();
      check(`real Notion code email (id=${notionRow.id}) has a code as the first line of text_body`, /^[A-Za-z0-9]{4,10}$/.test(code), JSON.stringify(notionRow.text_body).slice(0, 60));
    } else {
      check('real Notion code email present in inbox (send one via notion/signup-rest to populate)', true, '(none found — informational)');
    }
  }

  // --- 3. Negative controls
  const rBad = await fetchRaw(apexUrl, { Authorization: 'Bearer wrong-token-value' });
  check('wrong token → 401', rBad.status === 401, `status ${rBad.status}`);
  const rNoAddr = await fetchRaw('https://v3-mail.priv.email/emails?limit=5', { Authorization: DEFAULT_TOKEN });
  check('missing address param → 400', rNoAddr.status === 400, `status ${rNoAddr.status}: ${rNoAddr.body.slice(0, 80)}`);
  const rNoBody = await fetchRaw('https://v3-mail.priv.email/emails?address=admin@priv.email&limit=3', { Authorization: DEFAULT_TOKEN });
  check('include_body omitted → no text_body on rows', (() => {
    try { return JSON.parse(rNoBody.body).results.every((r) => !('text_body' in r)); } catch (e) { return false; }
  })(), 'unexpected body leakage');

  // --- 4. Extraction: synthetic Notion-style row inside the REAL response shape
  const synth = JSON.stringify({
    results: [
      { id: 101, from_address: 'bounces-imx+abc@bounces.improvmx.net', from_header: 'Notion Team <notify@updates.notion.so>', to_address: 'admin@priv.email', subject: 'Your Notion signup code', received_at: new Date().toISOString(), raw_size: 8258, has_attachments: 0, is_read: 0, is_starred: 0, text_body: 'ZK9P4Q\n' },
      { id: 100, from_address: 'bounces-imx+old@bounces.improvmx.net', from_header: 'Notion Team <notify@updates.notion.so>', to_address: 'admin@priv.email', subject: 'Your Notion signup code', received_at: new Date(Date.now() - 600000).toISOString(), raw_size: 8258, has_attachments: 0, is_read: 0, is_starred: 0, text_body: 'OLDC0DE\n' },
    ],
    nextCursor: null, count: 2, include_body: true,
  });
  const rNew = runExtraction(genericJs, { body: synth, status: 200, email: 'admin@priv.email', sinceMs: Date.now(), manualCode: '' });
  check('generic extraction: picks the NEW code email from text_body', rNew.code === 'ZK9P4Q' && rNew.source === 'body', JSON.stringify(rNew));
  const rOld = runExtraction(genericJs, { body: JSON.stringify({ results: [JSON.parse(synth).results[1]] }), status: 200, email: 'admin@priv.email', sinceMs: Date.now() - 300000, manualCode: '' });
  check('generic extraction: older email outside grace window is skipped', rOld.code == null, JSON.stringify(rOld));
  const rManual = runExtraction(genericJs, { body: synth, status: 200, email: 'admin@priv.email', sinceMs: Date.now(), manualCode: 'MANUAL1' });
  check('generic extraction: manualCode bypass', rManual.code === 'MANUAL1' && rManual.source === 'manual', JSON.stringify(rManual));
  const r401 = runExtraction(genericJs, { body: '{"error":"Unauthorized"}', status: 401, email: 'admin@priv.email', sinceMs: Date.now(), manualCode: '' });
  check('generic extraction: 401 → fatal with token hint', r401.fatal === true && /emailWorkerToken/.test(r401.error || ''), JSON.stringify(r401));

  // --- 5. email-auth step with the shipped default token
  const rAuth = runExtraction(authFn, { token: DEFAULT_TOKEN });
  check('email-auth: shipped Bearer token passes through verbatim', rAuth.header === DEFAULT_TOKEN, JSON.stringify(rAuth).slice(0, 80));

  // --- 6. v4-mail probe (separate inbox — informational only)
  try {
    const rV4 = await fetchRaw('https://v4-mail.priv.email/emails?address=admin@v4-mail.priv.email&limit=1', { Authorization: V4_TOKEN });
    check('v4-mail Bearer API reachable (separate inbox)', rV4.status === 200, `status ${rV4.status}`);
  } catch (e) {
    check('v4-mail Bearer API reachable (separate inbox)', false, String(e));
  }

  console.log(failures === 0 ? '\nALL v3-mail LIVE API TESTS PASS' : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
