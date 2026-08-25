# Zenrows Evaluation — Can It Replace the Extension?

**Tested 2026-08-25** (empirically, from this sandbox) against
`https://app.notion.com/signup`. API key provided by the user. Test artifacts:
`scripts/zenrows_test*.py` + `scripts/zenrows_t*.out` (not committed — contain
live session tokens).

## What was tested

Zenrows **Fetch** with `js_render=true` + `premium_proxy=true` +
`proxy_country=us` + `js_instructions` (fill/click/evaluate) +
`json_response=true` (XHR capture).

| # | Test | Result |
|---|------|--------|
| 1 | Plain fetch (no JS, no proxy) | ✅ 200, real Notion HTML |
| 2 | Full render + residential IP, wait for email field | ✅ page renders, `input[type=email]` present, zero anti-bot challenge |
| 3 | Drive the form (fill `onboard@priv.email`, click Continue) | ✅ **FULL PASS** — `getLoginOptions` (hasAccount:true, loginOptionsToken) → **`sendTemporaryPassword` fired (code email SENT, csrfState returned)** → code-entry view (`placeholder="Enter code"`) appeared. No hCaptcha, no Cloudflare. |
| 4a | Same, fresh alias `zenrows1@priv.email` | ⚠️ `getLoginOptions` → `challengeProvider: "hcaptcha"` — flow stopped, no code sent |
| 4b | Same, fresh alias `zenrows2@priv.email` | ⚠️ same captcha challenge |
| 5 | Repeat of test 3 (`onboard@`) | ⚠️ captcha iframe appeared in page; getLoginOptions returned empty |

## Findings

1. **Zenrows genuinely passes Notion's outer defenses** — further than this
   sandbox's raw Playwright ever got (datacenter IP → signup flow never even
   rendered the code field). A Zenrows residential-browser session completed
   the entire hardest part of signup (email submit → verification code sent)
   with **zero captcha** in test 3.
2. **But hCaptcha enterprise challenges probabilistically**: 1 of 3
   form-submits passed. When challenged, the response carries
   `challengeProvider: "hcaptcha"` and an hCaptcha iframe renders. Nothing in
   Zenrows solves it (nor should we expect it to).
3. **The email-code bottleneck is unchanged** (confirmed with fresh data):
   Notion has TWO templates, and **both put the code in the BODY**:
   - signup path: subject `"Your Notion signup code"` (your failed run)
   - login path: subject `"Your temporary Notion login code"` (Zenrows test 3)
   ImprovMX `/logs` exposes subjects only. No driver — extension, Zenrows, or
   otherwise — can read the code without a body-capable email source.
4. **Cost**: `js_render + premium_proxy` ≈ 25 credits/request (free plan
   5,000/mo → ~200 such requests). Fine for occasional agent-side use; not a
   bulk automation budget.

## Verdict

**Keep the extension as the primary path; add Zenrows as an agent-side
capability.** Reasons:

- The extension runs in the user's real browser — captcha passes
  deterministically (that's why it exists), cookies persist, and the
  `notion/submit-code` macro finishes the flow once a human reads the code.
- Zenrows is **probabilistic** against hCaptcha enterprise (1/3) — not
  reliable enough to be the primary signup driver. With retries it would
  also burn code emails (each attempt that passes sends a REAL email to
  priv.email — reputation cost, the thing we're explicitly avoiding).
- Where Zenrows **does** earn its place:
  1. **Agent eyes on live pages without the user** — `json_response` returns
     full XHR captures (request headers, bodies, response bodies) from a real
     Notion session. This is a research/inspection tool: capture what the
     live client sends, harvest tokens, watch for API changes — no user
     round-trip needed.
  2. **Non-captcha API replay** — flows whose endpoints don't challenge
     (logged-in API calls, GET-ish resources) can be driven from the sandbox.
  3. **Fallback signup driver** when the user isn't available and a
     probabilistic pass is acceptable (retry-until-clean — use sparingly:
     each pass costs a real email).
  4. Future: **Browser Sessions** (CDP-over-residential) if we ever need
     extension-grade interactivity from the sandbox — untested here.

## The remaining bottleneck (unchanged, now the top priority)

Reading the code from the email body. Options (user decision):

1. **Cloudflare Email Routing on priv.email + Worker → Turso** (the old
   privatimail.com pattern — it worked; it died because Notion blocked the
   domain, not the architecture). Best long-term fix.
2. Hotmail IMAP/Graph access (the forward target) — needs Hotmail creds.
3. Keep the human-in-the-loop `notion/submit-code` flow (works today).
