// extension/handlers/cookies.js
//
// Cookie access via chrome.cookies.*.
//
// IMPORTANT: there is NO default cookie domain. The caller MUST specify
// `domain` in each cookie, OR the extension derives it from the URL hostname.
// This fixes the legacy bug where .notion.com / .supabase.com was hardcoded.

import { CMD } from "../lib/protocol.js";
import { sendResult, sendError } from "../lib/send.js";
import { isIpAddress } from "../lib/url.js";

export async function handleCookiesGet(msg, ctx) {
  const { url, name } = msg;
  try {
    const cookie = await chrome.cookies.get({ url, name });
    sendResult(msg.id, { cookie }, ctx);
  } catch (err) {
    sendError(msg.id, `cookies.get failed: ${err.message ?? err}`, {}, ctx);
  }
}

export async function handleCookiesGetAll(msg, ctx) {
  const { url } = msg;
  try {
    const cookies = await chrome.cookies.getAll({ url });
    sendResult(msg.id, { cookies }, ctx);
  } catch (err) {
    sendError(msg.id, `cookies.getAll failed: ${err.message ?? err}`, {}, ctx);
  }
}

export async function handleCookiesSet(msg, ctx) {
  const { url, cookies = [] } = msg;
  // Derive domain from URL hostname if not specified per-cookie.
  //
  // ISSUE-20 + ISSUE-R2-5 fix:
  // - For hostnames (e.g. example.com, foo.bar.example.com): use ".<hostname>"
  //   for subdomain coverage. NEVER use just the last 2 labels (would produce
  //   ".co.uk" for example.co.uk — planting a cookie on the public suffix).
  //   Callers wanting a registrable-domain cookie (".example.com" to cover
  //   both example.com and app.example.com) MUST specify `domain` explicitly.
  // - For IP addresses (IPv4 or IPv6): Chrome rejects domain cookies on IPs —
  //   they must be host-only. We set domain to "" (empty) and omit it from
  //   the setDetails, so Chrome creates a host-only cookie.
  let defaultDomain = "";
  try {
    const parsed = new URL(url);
    if (!isIpAddress(parsed.hostname)) {
      defaultDomain = "." + parsed.hostname;
    }
    // else: defaultDomain stays "" — host-only cookie for IP addresses
  } catch {}

  try {
    const results = [];
    for (const c of cookies) {
      const setDetails = {
        url,
        name: c.name,
        value: c.value,
        path: c.path || "/",
        secure: c.secure ?? true,
        httpOnly: c.httpOnly ?? false,
        sameSite: c.sameSite || "no_restriction",
      };
      // Only set domain if non-empty (host-only cookie when domain is omitted)
      const domain = c.domain || defaultDomain;
      if (domain) setDetails.domain = domain;
      if (c.expirationDate) setDetails.expirationDate = c.expirationDate;
      const cookie = await chrome.cookies.set(setDetails);
      results.push({ name: c.name, ok: !!cookie, domain: domain || "(host-only)" });
    }
    sendResult(msg.id, { results, defaultDomain: defaultDomain || "(host-only)" }, ctx);
  } catch (err) {
    sendError(msg.id, `cookies.set failed: ${err.message ?? err}`, {}, ctx);
  }
}

export function registerCookiesHandlers(dispatcher) {
  dispatcher[CMD.COOKIES_GET] = handleCookiesGet;
  dispatcher[CMD.COOKIES_GET_ALL] = handleCookiesGetAll;
  dispatcher[CMD.COOKIES_SET] = handleCookiesSet;
}
