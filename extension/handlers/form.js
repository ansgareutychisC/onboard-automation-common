// extension/handlers/form.js
//
// DOM interaction in a tab. form.fill uses the React-safe native value setter
// pattern so controlled inputs accept the value. form.eval uses CDP
// Runtime.evaluate to bypass both MV3 CSP (forbidden unsafe-eval) and page
// CSP.

import { CMD } from "../lib/protocol.js";
import { sendResult, sendError } from "../lib/send.js";
import { warn } from "../lib/logger.js";

export async function handleFormFill(msg, ctx) {
  const { tabId, selector, value } = msg;
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (sel, val) => {
        const el = document.querySelector(sel);
        if (!el) return { ok: false, error: `Element not found: ${sel}` };
        // React-safe: use the native input value setter so React's onChange fires
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, "value"
        )?.set || Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype, "value"
        )?.set;
        if (setter && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
          setter.call(el, val);
        } else {
          el.value = val;
        }
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true, value: el.value, tagName: el.tagName };
      },
      args: [selector, value],
    });
    if (result?.result?.ok) {
      sendResult(msg.id, result.result, ctx);
    } else {
      sendError(msg.id, result?.result?.error || "form.fill failed", {}, ctx);
    }
  } catch (err) {
    sendError(msg.id, `form.fill injection failed: ${err.message ?? err}`, {}, ctx);
  }
}

export async function handleFormClick(msg, ctx) {
  const { tabId, selector } = msg;
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (sel) => {
        const el = document.querySelector(sel);
        if (!el) return { ok: false, error: `Element not found: ${sel}` };
        el.click();
        return { ok: true, tagName: el.tagName };
      },
      args: [selector],
    });
    if (result?.result?.ok) {
      sendResult(msg.id, result.result, ctx);
    } else {
      sendError(msg.id, result?.result?.error || "form.click failed", {}, ctx);
    }
  } catch (err) {
    sendError(msg.id, `form.click injection failed: ${err.message ?? err}`, {}, ctx);
  }
}

export async function handleFormWait(msg, ctx) {
  const { tabId, selector, timeoutMs = 30_000 } = msg;
  const start = Date.now();
  try {
    while (Date.now() - start < timeoutMs) {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (sel) => {
          const el = document.querySelector(sel);
          return el ? { found: true, tagName: el.tagName, visible: !!(el.offsetWidth || el.offsetHeight) } : { found: false };
        },
        args: [selector],
      });
      if (result?.result?.found) {
        sendResult(msg.id, result.result, { ...ctx, durationMs: Date.now() - start });
        return;
      }
      await _sleep(250);
    }
    sendError(msg.id, `form.wait timed out after ${timeoutMs}ms: ${selector}`, { timeoutMs }, { ...ctx, durationMs: Date.now() - start });
  } catch (err) {
    sendError(msg.id, `form.wait failed: ${err.message ?? err}`, {}, { ...ctx, durationMs: Date.now() - start });
  }
}

export async function handleFormEval(msg, ctx) {
  const { tabId, function: fnBody, args = [] } = msg;
  if (!fnBody || typeof fnBody !== "string") {
    sendError(msg.id, "form.eval requires 'function' (string body)", {}, ctx);
    return;
  }
  try {
    // Use chrome.debugger + CDP Runtime.evaluate to bypass both MV3 CSP
    // (forbids unsafe-eval) and the page's own CSP. We attach the debugger,
    // evaluate the function body in the page's main world with
    // userGesture:true (sotrusted-triggered click/submit work), then detach.
    const debugTarget = { tabId };
    let attached = false;
    try {
      await chrome.debugger.attach(debugTarget, "1.3");
      attached = true;
    } catch (err) {
      // Tolerate "Another debugger already attached" — assume it's ours from a prior call
      if (!String(err?.message).includes("Another debugger")) {
        throw err;
      }
      warn("form-eval-debugger-already-attached", { tabId });
    }

    try {
      const wrapped = `(function(args){ ${fnBody} })(${JSON.stringify(args)})`;
      const evalRes = await chrome.debugger.sendCommand(debugTarget, "Runtime.evaluate", {
        expression: wrapped,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      });
      if (evalRes.exceptionDetails) {
        sendError(msg.id, `form.eval threw: ${evalRes.exceptionDetails.text}`, { stackTrace: evalRes.exceptionDetails.exception?.description?.slice(0, 1000) }, ctx);
      } else {
        sendResult(msg.id, { result: evalRes.result?.value }, ctx);
      }
    } finally {
      if (attached) {
        try { await chrome.debugger.detach(debugTarget); } catch {}
      }
    }
  } catch (err) {
    sendError(msg.id, `form.eval failed: ${err.message ?? err}`, {}, ctx);
  }
}

function _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

export function registerFormHandlers(dispatcher) {
  dispatcher[CMD.FORM_FILL] = handleFormFill;
  dispatcher[CMD.FORM_CLICK] = handleFormClick;
  dispatcher[CMD.FORM_WAIT] = handleFormWait;
  dispatcher[CMD.FORM_EVAL] = handleFormEval;
}
