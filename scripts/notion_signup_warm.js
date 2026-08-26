#!/usr/bin/env node
/* Notion signup through ONE warm Zenrows Browser Session (CDP).

WHY THIS EXISTS (2026-08-26): Notion IP-binds the csrfState — the IP that
calls sendTemporaryPassword must be the IP that calls loginWithEmail, or
Notion 422s (docs/ZENROWS-EVAL.md Addendum 2). Zenrows Fetch rotates the
residential IP per API call, and session_id/session_ttl are plan-gated
(REQS004 / connection drops). BUT Zenrows Browser Sessions
(wss://browser.zenrows.com) is a persistent remote Chrome with ONE
session-scoped residential IP — exactly the "keep the instance warm"
architecture:

    connect CDP (one residential IP for the session)
      └─ page -> app.notion.com/signup   (live Notion-Client-Version read)
          ├─ fetch /api/v3/getLoginOptions        (same-origin, in-page)
          │    └─ captcha? -> close, reconnect (new IP), new email, retry
          ├─ fetch /api/v3/sendTemporaryPassword  (same page, same IP)
          │    └─ Node polls v3-mail worker for the code email
          │       browser idles; /cdn-cgi/trace heartbeat keeps the
          │       same-origin connection pool warm + logs the exit IP
          ├─ fetch /api/v3/loginWithEmail          (same page, same IP)
          └─ context.cookies() -> token_v2 etc. (HttpOnly visible via CDP)

Output: creds JSON compatible with notion_tail.py --init-from-creds
(email, userId, deviceId, tokenV2, clientVersion, createdAt, isNewSignup),
then run: python3 backend/notion_tail.py --init-from-creds <file> --all

Billing: 5 credits/min session + 25k credits/GB; resource-blocking keeps a
run to roughly 10-20 credits. Default TTL 180s covers the flow (~35-50s
typical; mail-wait capped at 100s).

Usage:
  NODE_PATH=/home/z/.npm-global/lib/node_modules node notion_signup_warm.js \
      [--attempts 5] [--out /tmp/warm_signup_creds.json] [--email x@y.z] \
      [--country us]
*/
const { chromium } = require('playwright');

const KEY = '0e43f2d6166122fa4b4aa607464f5c7d4d8ce855';
const V3MAIL_BASE = 'https://v3-mail.priv.email';
const V3MAIL_TOKEN = 'Bearer a2df50bf1d1310903061cdd569b6a20a62717998dcfe52bf';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
const REDIRECT_URL = '/p/3c7e9d22c27d805f8768dc3399e67455';
const VER_FALLBACK = '23.13.20260826.0028';
const MAIL_WAIT_MS = 100000; // cap: keep total session under the 180s TTL
const MAIL_POLL_INTERVAL_MS = 5000;
const HEARTBEAT_MS = 20000;  // same-origin keepalive during the mail wait
const ATTEMPT_PACE_MS = 12000; // reconnect pacing (avoid session-limit hits)

const args = Object.fromEntries(process.argv.slice(2).map((s, i, a) =>
  s.startsWith('--') ? [s.slice(2), a[i + 1] && !a[i + 1].startsWith('--') ? a[i + 1] : true] : []
));
const ATTEMPTS = parseInt(args.attempts || '5', 10);
const OUT = args.out || '/tmp/warm_signup_creds.json';
const COUNTRY = args.country || 'us';

function log(tag, ...m) { console.log(`[${new Date().toISOString().slice(11, 19)}][${tag}]`, ...m); }

function freshEmail() {
  return `zen-warm-${Math.floor(Date.now() / 1000)}-${Math.random().toString(16).slice(2, 8)}@v3-mail.priv.email`;
}

async function connect(country, tries = 4) {
  const wss = `wss://browser.zenrows.com?apikey=${KEY}&proxy_country=${country}`;
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      const b = await chromium.connectOverCDP(wss, { timeout: 90000 });
      return b;
    } catch (e) {
      lastErr = e;
      log('conn', `attempt ${i} failed (${(e.message || e).split('\n')[0]}); retry in 15s`);
      await new Promise((r) => setTimeout(r, 15000));
    }
  }
  throw lastErr;
}

/* ---------------- in-page Notion calls (same-origin fetch) -------------- */

// One eval = one POST to /api/v3/<endpoint>, executed inside the
// app.notion.com page (same-origin fetch with the live client version).
async function callApi(page, endpoint, bodyObj, verFallback) {
  const src = `(async () => {
    const ver = document.documentElement.getAttribute('data-notion-version') || '${verFallback}';
    const r = await fetch('/api/v3/${endpoint}', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'Notion-Audit-Log-Platform': 'web',
        'Notion-Client-Version': ver,
      },
      body: ${JSON.stringify(JSON.stringify(bodyObj))},
    });
    let text = '';
    try { text = await r.text(); } catch (e) { text = '<no body: ' + e + '>'; }
    return { status: r.status, text: text.slice(0, 4000), ver };
  })()`;
  return await page.evaluate(src);
}

async function traceIp(page) {
  return await page.evaluate(`(async () => {
    const r = await fetch('/cdn-cgi/trace', { cache: 'no-store' });
    const t = await r.text();
    const m = t.match(/^ip=(.+)$/m);
    return m ? m[1].trim() : 'HTTP ' + r.status;
  })()`);
}

/* ---------------- v3-mail polling (from Node, not the page) ------------ */

async function mailList(email) {
  const url = `${V3MAIL_BASE}/emails?address=${email}&limit=20&include_body=true`; // raw @
  const r = await fetch(url, { headers: { Authorization: V3MAIL_TOKEN, 'User-Agent': UA } });
  if (!r.ok) return { error: `HTTP ${r.status}` };
  try { return await r.json(); } catch (e) { return { error: String(e) }; }
}

async function mailBaseline(email) {
  const d = await mailList(email);
  let maxId = 0;
  if (d && Array.isArray(d.results)) for (const row of d.results) maxId = Math.max(maxId, row.id || 0);
  return maxId;
}

const CODEISH = /(code|verify|verification|login|passcode|signup|otp|one[- ]?time)/i;

async function pollForCode(email, sinceId, page, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  let lastIp = null;
  while (Date.now() < deadline) {
    // same-origin heartbeat: keep the notion.com connection pool warm and
    // log the exit IP so any mid-wait rotation becomes visible.
    try { lastIp = await traceIp(page); log('mail', `heartbeat ip=${lastIp}`); }
    catch (e) { log('mail', 'heartbeat failed:', e.message); }

    const d = await mailList(email);
    if (d && Array.isArray(d.results)) {
      for (const row of d.results) {
        if (sinceId && (row.id || 0) <= sinceId) continue;
        const subj = row.subject || '';
        const from = row.from_header || '';
        if (!CODEISH.test(subj)) continue;
        if (!/notion/i.test(from + ' ' + subj)) continue;
        const firstLine = ((row.text_body || '').trim().split('\n')[0] || '').trim();
        if (/^[A-Za-z0-9]{4,10}$/.test(firstLine)) {
          return { code: firstLine, subject: subj };
        }
      }
    }
    await new Promise((r) => setTimeout(r, MAIL_POLL_INTERVAL_MS));
  }
  return { code: null, subject: `timeout (${lastIp ? 'last ip ' + lastIp : 'no heartbeat'})` };
}

/* ---------------- cookie extraction ------------------------------------ */

async function extractCookies(context, page) {
  const out = {};
  try {
    for (const c of await context.cookies('https://app.notion.com')) out[c.name] = c.value;
  } catch (e) {
    log('cookies', 'context.cookies failed, trying CDP:', e.message);
    try {
      const cdp = await context.newCDPSession(page);
      const { cookies } = await cdp.send('Network.getAllCookies');
      for (const c of cookies || []) {
        if ((c.domain || '').includes('notion.com')) out[c.name] = c.value;
      }
      await cdp.detach();
    } catch (e2) {
      log('cookies', 'CDP fallback failed too:', e2.message);
    }
  }
  return out;
}

/* ---------------- main attempt loop ------------------------------------ */

(async () => {
  let email = typeof args.email === 'string' ? args.email : null;
  let deviceId = null;

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    if (!email) email = freshEmail();
    deviceId = deviceId || (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Math.random()));
    log('attempt', `${attempt}/${ATTEMPTS} email=${email}`);

    let browser = null;
    try {
      browser = await connect(COUNTRY);
      log('attempt', `connected, chromium ${browser.version()}`);
      const context = browser.contexts()[0] || (await browser.newContext());
      try {
        await context.route('**/*', (route) => {
          const t = route.request().resourceType();
          if (['image', 'font', 'media', 'stylesheet'].includes(t)) return route.abort();
          route.continue();
        });
      } catch (e) { log('attempt', 'resource blocking unavailable:', e.message); }

      const page = await context.newPage();
      await page.goto('https://app.notion.com/signup', { timeout: 90000, waitUntil: 'domcontentloaded' });
      const ip0 = await traceIp(page).catch(() => 'unknown');
      log('attempt', `signup page loaded, exit ip=${ip0}`);

      // 1. getLoginOptions
      const g = await callApi(page, 'getLoginOptions',
        { email, requireWorkTypeEmail: false }, VER_FALLBACK);
      let gj = {};
      try { gj = JSON.parse(g.text); } catch {}
      log('probe', `getLoginOptions HTTP ${g.status} hasAccount=${gj.hasAccount} challenge=${gj.challengeProvider || 'none'}`);
      if (g.status !== 200 || gj.challengeProvider || !gj.loginOptionsToken) {
        log('probe', 'captcha-gated or failed — rotating (new session = new IP, new email)');
        email = null; // fresh email next attempt
        await browser.close(); browser = null;
        await new Promise((r) => setTimeout(r, ATTEMPT_PACE_MS));
        continue;
      }

      // 2. mail baseline BEFORE sendcode
      const sinceId = await mailBaseline(email);
      log('mail', `baseline since_id=${sinceId}`);

      // 3. sendTemporaryPassword — SAME page, SAME IP
      const s = await callApi(page, 'sendTemporaryPassword', {
        email,
        redirectURL: REDIRECT_URL,
        disableLoginLink: false,
        native: false,
        isSignup: true,
        shouldHidePasscode: false,
        loginOptionsToken: gj.loginOptionsToken,
        deviceId,
        loginRouteOrigin: 'signup',
      }, VER_FALLBACK);
      let sj = {};
      try { sj = JSON.parse(s.text); } catch {}
      log('send', `sendTemporaryPassword HTTP ${s.status} csrfState=${sj.csrfState ? 'acquired' : 'MISSING'}`);
      if (s.status !== 200 || !sj.csrfState) {
        log('send', 'sendcode failed:', (s.text || '').slice(0, 200));
        await browser.close(); browser = null;
        await new Promise((r) => setTimeout(r, ATTEMPT_PACE_MS));
        continue;
      }

      // 4. poll v3-mail for the code (browser idles, heartbeat keeps it warm)
      log('mail', `waiting for code email (cap ${MAIL_WAIT_MS / 1000}s)...`);
      const { code, subject } = await pollForCode(email, sinceId, page, MAIL_WAIT_MS);
      if (!code) {
        log('mail', 'no code arrived:', subject);
        await browser.close(); browser = null;
        email = null;
        await new Promise((r) => setTimeout(r, ATTEMPT_PACE_MS));
        continue;
      }
      log('mail', `code acquired from "${subject}"`);

      // 5. loginWithEmail — SAME page, SAME IP (the whole point)
      const ipPre = await traceIp(page).catch(() => 'unknown');
      const l = await callApi(page, 'loginWithEmail', {
        state: sj.csrfState,
        password: code,
        appSource: 'notion',
        loginRouteOrigin: 'signup',
      }, VER_FALLBACK);
      let lj = {};
      try { lj = JSON.parse(l.text); } catch {}
      log('login', `loginWithEmail HTTP ${l.status} ip=${ipPre} isNewSignup=${lj.isNewSignup} userId=${lj.userId || '-'}`);
      if (l.status !== 200 || !lj.userId) {
        log('login', 'loginWithEmail failed:', (l.text || '').slice(0, 300));
        await browser.close(); browser = null;
        email = null;
        await new Promise((r) => setTimeout(r, ATTEMPT_PACE_MS));
        continue;
      }

      // 6. cookies (token_v2 is HttpOnly — CDP sees it)
      const cookies = await extractCookies(context, page);
      log('login', `cookies: ${Object.keys(cookies).filter((k) => /token|user|device/.test(k)).join(', ') || 'none'}`);
      const tokenV2 = cookies['token_v2'] || '';
      const userId = cookies['notion_user_id'] || lj.userId;
      const devId = cookies['notion_device_id'] || deviceId;

      const creds = {
        email,
        userId,
        deviceId: devId,
        tokenV2,
        clientVersion: (g && g.ver) || VER_FALLBACK,
        createdAt: Math.floor(Date.now() / 1000),
        isNewSignup: !!lj.isNewSignup,
        route: 'zenrows-browser-session',
        // IP hygiene: the exact residential exit IP that completed the
        // whole auth flow (probe→sendcode→login), read from Notion's own
        // /cdn-cgi/trace right before loginWithEmail.
        signupIp: ipPre || ip0 || null,
        proxyCountry: COUNTRY,
        cookies,                    // full cookie jar for session replay
      };

      await browser.close(); browser = null;
      log('done', `SUCCESS via warm session — saved ${OUT}`);
      if (!tokenV2) log('done', 'WARNING: token_v2 cookie missing — creds may be incomplete');

      require('fs').writeFileSync(OUT, JSON.stringify(creds, null, 2));
      console.log('\n===== CREDENTIALS =====');
      console.log(JSON.stringify({ ...creds, tokenV2: creds.tokenV2 ? creds.tokenV2.slice(0, 24) + '…' : '' }, null, 2));
      console.log('\nNext: python3 backend/notion_tail.py --init-from-creds ' + OUT + ' --all');
      process.exit(0);
    } catch (e) {
      log('attempt', 'exception:', (e && e.message || String(e)).split('\n')[0]);
      if (browser) { try { await browser.close(); } catch {} }
      // longer cooldown on exceptions — rapid reconnects trip the plan's
      // session-creation limit (observed: burst of handshakes -> ~4min block)
      await new Promise((r) => setTimeout(r, 45000));
      // keep the same email only if we never got past the probe; else fresh
    }
  }
  log('done', `all ${ATTEMPTS} attempts exhausted`);
  process.exit(2);
})();
