// extension/handlers/captcha.js
//
// Multi-provider captcha token reader.
//
// Supported providers:
//   - hcaptcha    — reads window.hcaptcha.getResponse() or the
//                   textarea[name="h-captcha-response"] fallback.
//   - recaptcha   — reads grecaptcha.getResponse() or
//                   textarea[name="g-recaptcha-response"].
//   - turnstile   — reads window.turnstile.getResponse() or
//                   textarea[name="cf-turnstile-response"] (or the
//                   [name*="turnstile"] hidden input variant).
//   - cloudflare  — Cloudflare challenge tokens. Reads
//                   document.querySelector('[name="cf-chl-token"]') or
//                   window.__cf_chl_opt (whichever is exposed).
//
// If no provider is specified, the handler auto-detects by probing each
// provider's window global in order: hcaptcha, turnstile, recaptcha, cloudflare.
//
// Returns:
//   { ok, token, source, provider, captchaPresent, providerDefined }
//
// On failure (no token found), returns ok=false with diagnostic flags so
// the backend can distinguish "no captcha shown" from "captcha shown but
// not solved".
//
// ISSUE-4 fix: chrome.scripting.executeScript serializes args via structured
// clone — functions are silently dropped. The previous version passed a
// PROVIDERS map containing `responseFn` closures, which became undefined in
// the page world. Now we pass only serializable spec data (globalName,
// textareaSelector) and reconstruct the response-reading logic inside the
// injected function body itself.

import { CMD } from "../lib/protocol.js";
import { sendResult, sendError } from "../lib/send.js";
import { info, warn } from "../lib/logger.js";

// Serializable spec — no functions, just data. This is safe to pass via
// chrome.scripting.executeScript args.
const PROVIDER_SPECS = {
  hcaptcha: {
    globalName: "hcaptcha",
    textareaSelector: 'textarea[name="h-captcha-response"]',
  },
  recaptcha: {
    globalName: "grecaptcha",
    textareaSelector: 'textarea[name="g-recaptcha-response"]',
  },
  turnstile: {
    globalName: "turnstile",
    textareaSelector: 'textarea[name="cf-turnstile-response"], input[name*="turnstile"]',
  },
  cloudflare: {
    globalName: "__cf_chl_opt",
    textareaSelector: '[name="cf-chl-token"]',
  },
};

export async function handleCaptchaGetToken(msg, ctx) {
  const { tabId, provider: requestedProvider = null } = msg;
  if (!tabId) {
    sendError(msg.id, "captcha.getToken requires tabId", {}, ctx);
    return;
  }

  const providersToTry = requestedProvider
    ? [requestedProvider]
    : Object.keys(PROVIDER_SPECS);

  // Only pass serializable data — the response-reading logic lives inside
  // the injected function body. This is the ISSUE-4 fix.
  const specsToTry = providersToTry.map((name) => ({
    name,
    globalName: PROVIDER_SPECS[name].globalName,
    textareaSelector: PROVIDER_SPECS[name].textareaSelector,
  }));

  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: (providerSpecs) => {
        const present = {};
        const defined = {};
        for (const spec of providerSpecs) {
          defined[spec.name] = !!window[spec.globalName];
          const ta = document.querySelector(spec.textareaSelector);
          present[spec.name] = !!ta || defined[spec.name];
        }
        for (const spec of providerSpecs) {
          let token = null;
          // Read via the global's getResponse() method if defined.
          // (Previously this was a closure in PROVIDERS — ISSUE-4 —
          //  structured clone dropped the function. Now inlined here.)
          const globalObj = window[spec.globalName];
          if (globalObj && typeof globalObj.getResponse === "function") {
            try { token = globalObj.getResponse(); } catch {}
          }
          // Fallback: scrape the hidden textarea/input
          if (!token) {
            const ta = document.querySelector(spec.textareaSelector);
            if (ta) token = ta.value;
          }
          if (token && token.length > 0) {
            return {
              ok: true,
              token,
              source: spec.name + ".getResponse",
              provider: spec.name,
              captchaPresent: present,
              providerDefined: defined,
            };
          }
        }
        return {
          ok: false,
          error: "No captcha token found",
          captchaPresent: present,
          providerDefined: defined,
        };
      },
      args: [specsToTry],
    });

    const r = result?.result;
    if (!r) {
      sendError(msg.id, "captcha.getToken: injection returned no result", {}, ctx);
      return;
    }
    if (r.ok) {
      info("captcha-token-found", { provider: r.provider, source: r.source, tokenLen: r.token.length });
      sendResult(msg.id, r, ctx);
    } else {
      warn("captcha-token-not-found", { requestedProvider, present: r.captchaPresent, defined: r.providerDefined });
      sendError(msg.id, r.error, { captchaPresent: r.captchaPresent, providerDefined: r.providerDefined, requestedProvider }, ctx);
    }
  } catch (err) {
    sendError(msg.id, `captcha.getToken injection failed: ${err.message ?? err}`, {}, ctx);
  }
}

export function registerCaptchaHandlers(dispatcher) {
  dispatcher[CMD.CAPTCHA_GET_TOKEN] = handleCaptchaGetToken;
}
