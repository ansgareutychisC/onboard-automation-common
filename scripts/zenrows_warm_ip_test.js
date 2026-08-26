#!/usr/bin/env node
/* Zenrows Browser Sessions — IP stability ("warm instance") test.

Question (user, 2026-08-26): can we keep the Zenrows browser instance warm
while we query the email for the verification code, keeping the IP
consistent across getLoginOptions -> sendTemporaryPassword -> loginWithEmail?

Context (docs/ZENROWS-EVAL.md Addendum 2): Notion IP-binds the csrfState, so
sendcode and loginWithEmail MUST come from the same IP. Plain Zenrows fetch
rotates the residential IP per API call -> loginWithEmail 422s. Browser
Sessions (CDP over wss://browser.zenrows.com) is a persistent Chrome with a
session-scoped residential IP — this script validates that empirically.

Probes (in priority order):
  P1  app.notion.com /cdn-cgi/trace via SAME-ORIGIN in-page fetch — the exact
      connection path + exit IP Notion's edge sees for our API calls.
  P2  echo services via top-level navigation (ifconfig.me / checkip.amazonaws
      / icanhazip / httpbin) — api.ipify.org is BLOCKED by the Zenrows
      browser network policy (ERR_BLOCKED_BY_ADMINISTRATOR).

Sequence: load notion signup -> P1 x2 (consecutive) -> idle 60s (simulated
email wait) -> P1 again -> new page -> P2. All IPs must match.

Usage:
  NODE_PATH=/home/z/.npm-global/lib/node_modules node zenrows_warm_ip_test.js
*/
const { chromium } = require('playwright');

const KEY = '0e43f2d6166122fa4b4aa607464f5c7d4d8ce855';
// session_ttl is plan-gated (REQS004 for any value) — default TTL (180s) applies.
const WSS = `wss://browser.zenrows.com?apikey=${KEY}&proxy_country=us`;
const IDLE_MS = 60000; // simulate the email-code wait (keep total under 180s)
const ECHOES = [
  'https://ifconfig.me/ip',
  'https://checkip.amazonaws.com/',
  'https://icanhazip.com/',
  'https://httpbin.org/ip',
];

function ts(t0) { return `t+${((Date.now() - t0) / 1000).toFixed(0)}s`; }

async function connectWithRetry(wss, tries = 3) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      return await chromium.connectOverCDP(wss, { timeout: 90000 });
    } catch (e) {
      lastErr = e;
      console.log(`[warm] connect attempt ${i} failed (${(e.message || e).split('\n')[0]}); retrying in 10s...`);
      await new Promise((r) => setTimeout(r, 10000));
    }
  }
  throw lastErr;
}

// Same-origin probe: Cloudflare's /cdn-cgi/trace from the app.notion.com page.
// This is the exact exit IP + connection path our /api/v3/* fetches will use.
async function traceIp(page) {
  return await page.evaluate(async () => {
    const r = await fetch('/cdn-cgi/trace', { cache: 'no-store' });
    const t = await r.text();
    const m = t.match(/^ip=(.+)$/m);
    return m ? m[1].trim() : `HTTP ${r.status} (no ip in trace: ${t.slice(0, 60)})`;
  });
}

(async () => {
  const t0 = Date.now();
  console.log('[warm] connecting:', WSS.replace(KEY, '<KEY>'));
  const browser = await connectWithRetry(WSS);
  console.log(`[warm] connected (${ts(t0)}). chromium: ${browser.version()}`);
  try {
  const context = browser.contexts()[0] || (await browser.newContext());

  // block heavy resources to save bandwidth credits (billing: 25k credits/GB)
  try {
    await context.route('**/*', (route) => {
      const t = route.request().resourceType();
      if (['image', 'font', 'media', 'stylesheet'].includes(t)) return route.abort();
      route.continue();
    });
    console.log('[warm] resource blocking enabled (image/font/media/css)');
  } catch (e) {
    console.log('[warm] resource blocking unavailable:', e.message);
  }

  // --- Notion signup page: live client version + same-origin trace ---
  const page = await context.newPage();
  await page.goto('https://app.notion.com/signup', { timeout: 90000, waitUntil: 'domcontentloaded' });
  const ver = await page.evaluate(() =>
    document.documentElement.getAttribute('data-notion-version'));
  console.log(`[warm] notion signup loaded (${ts(t0)}). Notion-Client-Version = ${ver}`);

  const ip1 = await traceIp(page);
  console.log(`[warm] P1 same-origin trace #1   : ${ip1} (${ts(t0)})`);
  const ip2 = await traceIp(page);
  console.log(`[warm] P1 same-origin trace #2   : ${ip2} (${ts(t0)}) [connection-pool check]`);

  console.log(`[warm] idling ${IDLE_MS / 1000}s (simulating email-code wait)...`);
  await new Promise((r) => setTimeout(r, IDLE_MS));

  const ip3 = await traceIp(page);
  console.log(`[warm] P1 same-origin post-idle : ${ip3} (${ts(t0)}) [THE warm check]`);

  // --- New page, echo services via navigation ---
  const page2 = await context.newPage();
  let ip4 = null;
  for (const u of ECHOES) {
    try {
      await page2.goto(u, { timeout: 30000, waitUntil: 'domcontentloaded' });
      let body = await page2.evaluate(() => document.body.innerText);
      body = (body || '').trim().slice(0, 200);
      const m = body.match(/\b\d{1,3}(\.\d{1,3}){3}\b/) || body.match(/"origin":\s*"([^"]+)"/);
      console.log(`[warm] P2 nav echo ${u} -> ${m ? m[0] : body.slice(0, 60)}`);
      if (!ip4 && m) ip4 = m[0].replace(/"origin":\s*"|"/g, '');
      if (ip4) break;
    } catch (e) {
      console.log(`[warm] P2 nav echo ${u} -> FAILED: ${(e.message || '').split('\n')[0]}`);
    }
  }

  console.log('\n[warm] ========================================');
  const uniq = [...new Set([ip1, ip2, ip3].filter((x) => x && /^\d/.test(x)))];
  if (uniq.length === 1) {
    console.log(`[warm] SAME-ORIGIN IP STABLE: ${ip1}`);
    if (ip4 && ip4 === ip1) console.log(`[warm] navigation IP matches too (${ip4}).`);
    else if (ip4) console.log(`[warm] WARNING: navigation IP differs (${ip4}) — session may rotate per-connection.`);
    console.log('[warm] VERDICT: warm-instance architecture WORKS — one Browser');
    console.log('[warm] Session can drive getLoginOptions -> sendTemporaryPassword');
    console.log('[warm] -> (email-code wait) -> loginWithEmail on ONE residential IP.');
  } else {
    console.log(`[warm] SAME-ORIGIN IP UNSTABLE: ${uniq.join(' , ')}`);
    console.log('[warm] VERDICT: need a same-origin heartbeat keepalive during the wait.');
  }
  console.log('[warm] ========================================');

  } finally {
    // Always close — an abandoned CDP connection leaves the remote session
    // alive until TTL (180s), occupying the concurrent-session slot.
    try { await browser.close(); console.log('[warm] browser closed.'); }
    catch (e) { console.log('[warm] close failed:', e.message); }
  }
})().catch((e) => {
  console.error('[warm] FAILED:', e && e.message ? e.message : e);
  process.exit(1);
});
