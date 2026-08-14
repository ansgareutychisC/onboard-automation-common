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

import { CMD } from "../lib/protocol.js";
import { sendResult, sendError } from "../lib/send.js";
import { info, warn } from "../lib/logger.js";

const PROVIDERS = {
  hcaptcha: {
    global: "hcaptcha",
    responseFn: () => window.hcaptcha?.getResponse?.(),
    textareaSelector: 'textarea[name="h-captcha-response"]',
  },
  recaptcha: {
    global: "grecaptcha",
    responseFn: () => window.grecaptcha?.getResponse?.(),
    textareaSelector: 'textarea[name="g-recaptcha-response"]',
  },
  turnstile: {
    global: "turnstile",
    responseFn: () => window.turnstile?.getResponse?.(),
    textareaSelector: 'textarea[name="cf-turnstile-response"], input[name*="turnstile"]',
  },
  cloudflare: {
    global: "__cf_chl_opt",
    responseFn: () => null,  // CF challenges don't expose a JS getter — must scrape DOM
    textareaSelector: '[name="cf-chl-token"], [name="cf-chl-token"]',
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
    : Object.keys(PROVIDERS);

  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: (providerNames, providerSpecs) => {
        const present = {};
        const defined = {};
        for (const name of providerNames) {
          const spec = providerSpecs[name];
          defined[name] = !!window[spec.global];
          const ta = document.querySelector(spec.textareaSelector);
          present[name] = !!ta || defined[name];
        }
        for (const name of providerNames) {
          const spec = providerSpecs[name];
          let token = null;
          try { token = spec.responseFn(); } catch {}
          if (!token) {
            const ta = document.querySelector(spec.textareaSelector);
            if (ta) token = ta.value;
          }
          if (token && token.length > 0) {
            return { ok: true, token, source: name + ".getResponse", provider: name, captchaPresent: present, providerDefined: defined };
          }
        }
        return { ok: false, error: "No captcha token found", captchaPresent: present, providerDefined: defined };
      },
      args: [providersToTry, PROVIDERS],
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
