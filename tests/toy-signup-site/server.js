#!/usr/bin/env node
'use strict';
// =============================================================================
// toy-signup-site/server.js — a minimal "SaaS signup" site for testing the
// Onboard Automation Bridge extension end-to-end WITHOUT touching a real
// service. Mimics the Notion signup flow's shape:
//
//   1. GET  /                       — signup page: input[type=email] +
//                                     div[role=button] "Continue"
//   2. POST /api/signup  {email}    — "sends" a verification email and swaps
//                                     to the code view (SPA transition, same
//                                     as Notion — no full page navigation)
//   3. GET  /v3/domains/priv.email/logs?take=N
//                                  — mock ImprovMX inbox API (same response
//                                     SHAPE as the real one). Requires a
//                                     Basic Authorization header (any value).
//   4. POST /api/verify {email, code} — validates the code; on success the
//                                     page sets a `toy_session` cookie and
//                                     pushState's to /welcome (SPA, so the
//                                     macro's URL-polling eval survives)
//   5. GET  /welcome                — "account created" page
//
// Run: node tests/toy-signup-site/server.js   (listens on 127.0.0.1:8898)
// Then in the extension popup run the `_shared/self-test` preset.
// =============================================================================

const http = require('http');
const crypto = require('crypto');

const PORT = 8898;

const state = {
  startedAt: Date.now(),
  signups: 0,          // completed signups
  inbox: [],           // ImprovMX-log-shaped entries
  authRejects: 0,
};

const PAGE_HTML = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Toy Signup — Onboard Bridge Self-Test</title>
<style>
  body { font-family: -apple-system, 'Segoe UI', Roboto, sans-serif; background:#fafafa; display:flex; justify-content:center; padding-top:80px; }
  .card { background:#fff; border:1px solid #e0e0e0; border-radius:12px; padding:32px; width:360px; }
  h1 { font-size:18px; margin:0 0 4px; }
  p.sub { color:#666; font-size:12px; margin:0 0 20px; }
  input { width:100%; box-sizing:border-box; padding:10px 12px; border:1px solid #ddd; border-radius:6px; font-size:14px; margin-bottom:12px; }
  input:focus { outline:none; border-color:#4285f4; }
  .btn { display:block; width:100%; box-sizing:border-box; padding:10px 12px; background:#4285f4; color:#fff; border-radius:6px; font-size:14px; text-align:center; cursor:pointer; user-select:none; }
  .btn:hover { background:#3367d6; }
  .btn[aria-disabled="true"] { background:#ccc; cursor:default; }
  .err { color:#db4437; font-size:12px; min-height:16px; margin-bottom:8px; }
  .muted { color:#999; font-size:11px; margin-top:16px; text-align:center; }
</style></head>
<body>
<div class="card">
  <div id="view-email">
    <h1>Sign up</h1>
    <p class="sub">Enter your email to continue.</p>
    <input type="email" id="email" placeholder="Enter your email address" />
    <div class="err" id="err1"></div>
    <div role="button" tabindex="0" class="btn" id="continue1">Continue</div>
    <div class="muted">toy service — for extension self-testing only</div>
  </div>
  <div id="view-code" style="display:none;">
    <h1>Check your email</h1>
    <p class="sub">We sent a login code to <b id="sent-to"></b>.</p>
    <input id="code" placeholder="Enter code" autocomplete="one-time-code" />
    <div class="err" id="err2"></div>
    <div role="button" tabindex="0" class="btn" id="continue2">Continue</div>
  </div>
  <div id="view-welcome" style="display:none;">
    <h1>Account created 🎉</h1>
    <p class="sub">Signed in with session cookie <code>toy_session</code>.</p>
    <div class="muted" id="who"></div>
  </div>
</div>
<script>
  let email = '';
  const $ = (id) => document.getElementById(id);
  // Faithful to Notion's SPA behavior: a forward transition REMOVES the views
  // EARLIER in the flow from the DOM (not display:none) — so only one
  // "Continue" button ever exists, exactly like the real signup page the
  // notion macros were built against. Future views stay in the DOM (hidden).
  const VIEW_ORDER = ['view-email', 'view-code', 'view-welcome'];
  function show(view) {
    const idx = VIEW_ORDER.indexOf(view);
    for (let i = 0; i < idx; i++) {
      const el = $(VIEW_ORDER[i]);
      if (el) el.remove();
    }
    const el = $(view);
    if (el) el.style.display = '';
  }
  $('continue1').addEventListener('click', async () => {
    $('err1').textContent = '';
    email = $('email').value.trim();
    if (!email || email.indexOf('@') < 1) { $('err1').textContent = 'Please enter a valid email address.'; return; }
    $('continue1').setAttribute('aria-disabled', 'true');
    try {
      const r = await fetch('/api/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
      const d = await r.json();
      if (!d.ok) { $('err1').textContent = d.error || 'Signup failed.'; $('continue1').removeAttribute('aria-disabled'); return; }
      $('sent-to').textContent = email;
      show('view-code');
    } catch (e) {
      $('err1').textContent = 'Network error: ' + e.message;
    } finally {
      $('continue1').removeAttribute('aria-disabled');
    }
  });
  $('continue2').addEventListener('click', async () => {
    $('err2').textContent = '';
    const code = $('code').value.trim();
    if (!code) { $('err2').textContent = 'Enter the code from your email.'; return; }
    try {
      const r = await fetch('/api/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code }) });
      const d = await r.json();
      if (!d.ok) { $('err2').textContent = d.error || 'Wrong code.'; return; }
      document.cookie = 'toy_session=' + encodeURIComponent(d.session) + '; path=/; max-age=86400';
      history.pushState({}, '', '/welcome');
      $('who').textContent = email + ' — session ' + d.session.slice(0, 12) + '…';
      show('view-welcome');
    } catch (e) {
      $('err2').textContent = 'Network error: ' + e.message;
    }
  });
</script>
</body></html>`;

function genCode() {
  // 6-char alphanumeric — same shape as Notion's current codes
  return crypto.randomBytes(6).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toUpperCase();
}

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      try { resolve(JSON.parse(b || '{}')); } catch (e) { resolve({}); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (u.pathname === '/' || u.pathname === '/welcome' || u.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(PAGE_HTML);
    return;
  }

  if (u.pathname === '/health') {
    json(res, 200, { ok: true, uptime: Date.now() - state.startedAt, signups: state.signups, inboxSize: state.inbox.length });
    return;
  }

  if (u.pathname === '/api/signup' && req.method === 'POST') {
    const { email } = await readBody(req);
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      json(res, 400, { ok: false, error: 'invalid email' });
      return;
    }
    const code = genCode();
    state.inbox.push({
      created: Date.now(),
      subject: `Your login code is ${code}`,
      sender: { email: 'noreply@toy-signup.local', name: 'Toy Signup' },
      recipient: { email, name: null },
      forward: { email: 'nobody@toy-signup.local', name: null },
      events: [{ status: 'DELIVERED', code: 250, message: '2.6.0 Queued' }],
      messageId: `<${crypto.randomUUID()}@toy-signup.local>`,
      id: crypto.randomUUID(),
      _code: code,  // server-side only — NOT exposed by /logs (shape-faithful)
    });
    // keep the last 50
    if (state.inbox.length > 50) state.inbox.splice(0, state.inbox.length - 50);
    console.log(`[toy] signup for ${email} — code mailed (subject)`);
    json(res, 200, { ok: true, message: 'verification code sent' });
    return;
  }

  if (u.pathname === '/api/verify' && req.method === 'POST') {
    const { email, code } = await readBody(req);
    const entry = [...state.inbox].reverse().find((l) => l.recipient.email === email);
    if (!entry) { json(res, 400, { ok: false, error: 'no signup found for this email' }); return; }
    if (String(code).trim().toUpperCase() !== entry._code) {
      json(res, 400, { ok: false, error: 'wrong code' });
      return;
    }
    state.signups++;
    const session = 'sess_' + crypto.randomBytes(16).toString('hex');
    console.log(`[toy] verified ${email} — signup #${state.signups} complete`);
    json(res, 200, { ok: true, session });
    return;
  }

  // Mock ImprovMX /logs — same response shape as the real API. Requires Basic auth
  // (any credentials) so the email-auth step of the shared chunk is exercised.
  if (u.pathname === '/v3/domains/priv.email/logs') {
    const auth = req.headers['authorization'] || '';
    if (!auth.startsWith('Basic ')) {
      state.authRejects++;
      json(res, 401, { code: 401, error: 'Authentication required' });
      return;
    }
    const take = Math.min(parseInt(u.searchParams.get('take') || '50', 10) || 50, 100);
    const logs = state.inbox.slice(-take).map(({ _code, ...rest }) => rest);
    json(res, 200, { success: true, logs });
    return;
  }

  json(res, 404, { error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`toy-signup-site listening on http://127.0.0.1:${PORT}`);
  console.log(`mock ImprovMX logs API at http://127.0.0.1:${PORT}/v3/domains/priv.email/logs`);
});
