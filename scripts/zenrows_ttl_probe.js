#!/usr/bin/env node
/* Probe which session_ttl values the Zenrows Browser Sessions endpoint accepts. */
const { chromium } = require('playwright');
const KEY = '0e43f2d6166122fa4b4aa607464f5c7d4d8ce855';

const values = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['none', '60', '120', '180', '300', '600', '900'];

(async () => {
  for (const v of values) {
    const qs = v === 'none' ? '' : `&session_ttl=${v}`;
    const wss = `wss://browser.zenrows.com?apikey=${KEY}&proxy_country=us${qs}`;
    try {
      const b = await chromium.connectOverCDP(wss, { timeout: 45000 });
      console.log(`session_ttl=${v.padEnd(5)} -> CONNECTED (chromium ${b.version()})`);
      await b.close();
    } catch (e) {
      const msg = (e && e.message || String(e)).split('\n').filter(l => l.includes('REQS') || l.includes('Invalid') || l.includes('error:') || l.includes('timeout')).slice(0, 2).join(' | ');
      console.log(`session_ttl=${v.padEnd(5)} -> REJECTED: ${msg || e.message}`);
    }
  }
})();
