// extension/lib/url.js
//
// Shared URL-building utilities for the background SW and sandbox page.
// Extracted to prevent drift between connection.js and sandbox.js (ISSUE-R2-4).

/**
 * Convert a user-provided server URL into a WebSocket URL.
 *   - ws(s):// passthrough
 *   - http(s):// → ws(s)://
 *   - For the z.ai Caddy preview gateway (hostname ends in .space-z.ai),
 *     append ?XTransformPort=8787 (Caddy routing hint) and force pathname="/"
 *     (Caddy only upgrades WS at this path).
 *   - For all other hosts (including Cloudflare Workers), leave the URL alone
 *     — workers ignore unknown query params but it's confusing in DevTools.
 */
export function buildWsUrl(serverUrl) {
  let url = serverUrl.trim();
  url = url.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");
  if (!/^wss?:\/\//i.test(url)) url = "ws://" + url;
  try {
    const parsed = new URL(url);
    const isLocal = ["localhost", "127.0.0.1", "0.0.0.0", "::1"].includes(parsed.hostname);
    const isCaddyPreview = parsed.hostname.endsWith(".space-z.ai");
    if (!isLocal && isCaddyPreview && !parsed.searchParams.has("XTransformPort")) {
      parsed.searchParams.set("XTransformPort", "8787");
    }
    if (isCaddyPreview) parsed.pathname = "/";
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * Convert a WS URL to its HTTP equivalent (for the SOS fallback path).
 * Strips a trailing /ws if present (legacy convention).
 */
export function wsUrlToHttpBase(wsUrl) {
  let url = wsUrl.trim()
    .replace(/^ws:/i, "http:").replace(/^wss:/i, "https:");
  if (!/^https?:\/\//i.test(url)) url = "http://" + url;
  try {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/ws")) parsed.pathname = parsed.pathname.slice(0, -3);
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return url;
  }
}

/**
 * Redact query params from a URL for safe logging (may contain tokens).
 */
export function redactUrl(url) {
  try { return new URL(url).origin + new URL(url).pathname; }
  catch { return url; }
}

/**
 * Check if a hostname is an IP address (IPv4 or IPv6).
 * Used by cookies.js to decide whether to set a domain (Chrome rejects
 * domain cookies on IP addresses — they must be host-only).
 */
export function isIpAddress(hostname) {
  // IPv4: four dot-separated octets
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
  // IPv6: contains a colon (also covers [::1] bracketed form)
  if (hostname.includes(":")) return true;
  return false;
}
