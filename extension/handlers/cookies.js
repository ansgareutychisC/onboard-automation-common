// extension/handlers/cookies.js
//
// Cookie access via chrome.cookies.*.
//
// IMPORTANT: there is NO default cookie domain. The caller MUST specify
// `domain` in each cookie, OR the extension derives it from the URL hostname.
// This fixes the legacy bug where .notion.com / .supabase.com was hardcoded.

import { CMD } from "../lib/protocol.js";
import { sendResult, sendError } from "../lib/send.js";

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
  // Derive domain from URL hostname if not specified per-cookie
  let defaultDomain = "";
  try {
    const parsed = new URL(url);
    // Use ".example.com" form so the cookie applies to subdomains
    defaultDomain = "." + parsed.hostname.split(".").slice(-2).join(".");
  } catch {}

  try {
    const results = [];
    for (const c of cookies) {
      const setDetails = {
        url,
        name: c.name,
        value: c.value,
        domain: c.domain || defaultDomain,
        path: c.path || "/",
        secure: c.secure ?? true,
        httpOnly: c.httpOnly ?? false,
        sameSite: c.sameSite || "no_restriction",
      };
      if (c.expirationDate) setDetails.expirationDate = c.expirationDate;
      const cookie = await chrome.cookies.set(setDetails);
      results.push({ name: c.name, ok: !!cookie });
    }
    sendResult(msg.id, { results, defaultDomain }, ctx);
  } catch (err) {
    sendError(msg.id, `cookies.set failed: ${err.message ?? err}`, {}, ctx);
  }
}

export function registerCookiesHandlers(dispatcher) {
  dispatcher[CMD.COOKIES_GET] = handleCookiesGet;
  dispatcher[CMD.COOKIES_GET_ALL] = handleCookiesGetAll;
  dispatcher[CMD.COOKIES_SET] = handleCookiesSet;
}
