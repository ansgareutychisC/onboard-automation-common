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

## Addendum (2026-08-25, session 2) — Zenrows as an AUTHENTICATED client

Follow-up tested with a captured session (cookie replay of
`token_v2`/`notion_user_id` via `custom_headers=true`):

1. **Session replay works**: `POST /api/v3/getSpaces` through Zenrows
   with the cookie header returns the full account payload (200).
2. **The biz-trial "captcha" disappears on a clean IP**: the exact
   `updateSubscription` body that the sandbox IP rejects with
   `UserValidationError "Trial activation is not allowed."` returns
   `200 {"subscriptionStatus":"trialing"}` through Zenrows — with
   `captchaToken: ""`. The hCaptcha demand is IP-reputation-gated, not
   a hard requirement.
3. API shape change: `custom_headers` is now a **boolean**; the actual
   headers go on the request to `api.zenrows.com` itself and are
   forwarded. (Old JSON-blob format → `REQS004 invalid boolean`.)

Verdict update: Zenrows = (a) agent-side eyes, (b) fallback signup
driver, and now (c) **clean-IP relay for reputation-gated mutations**
(trial activation). See `docs/POST-LOGIN-TAIL.md` §2.

## Addendum 2 (2026-08-26) — Zenrows as the SIGNUP driver: blocked at loginWithEmail

Full retry matrix run end-to-end today. Scripts:
`scripts/signup_matrix.py` (probe axes A/C/E/D) +
`scripts/notion_signup_zenrows.py` (full flow driver). Results saved
to `scripts/signup_matrix_results.json`.

### Probe matrix (getLoginOptions only — cheapest signal)

| Axis | Variant | Pass rate | Notes |
|---|---|---|---|
| A   | Named aliases, no proxy           | 1/5 | Only `noreply@` passed |
| A.2 | Named aliases, premium_proxy=us  | 4/5 | `admin/support/noreply/billing@` PASS, `security@` captcha |
| C   | Fresh `*@priv.email`, no proxy    | 0/3 | All captcha (datacenter IP blocked) |
| C   | Fresh `*@priv.email`, premium_us  | 1/3 | Confirms probabilistic gate on fresh addresses |
| (extra) | Fresh `*@v3-mail.priv.email`, premium_us | 2/5 | Worker subdomain has same reputation as apex |
| E   | `admin@` × 5 countries (us/gb/jp/kr/br) | (deferred —Zenros rate-limited the sandbox IP after axis A+C burned 16 probes in quick succession) | |
| D   | Humanization (js_render + fill+click) | (deferred — null-result was already documented in main eval) | |

### Full-flow driver (`notion_signup_zenrows.py`)

The script does the WHOLE signup end-to-end via Zenros:
getLoginOptions → sendTemporaryPassword → poll v3-mail worker →
loginWithEmail. Live run 2026-08-26 on `admin@priv.email` (existing
account → login flow):

| Step | Via | Result |
|---|---|---|
| getLoginOptions  | premium_proxy=us | ✅ PASS — loginOptionsToken acquired |
| sendTemporaryPassword | premium_proxy=us | ✅ PASS — csrfState acquired, code email arrived |
| Poll v3-mail worker (direct curl) | (not via Zenros) | ✅ Got code `fFWGzK` (mixed-case login code, per the macro's regex) |
| **loginWithEmail** | premium_proxy=us | ❌ **422 RESP001 "Could not get content"** — every retry, consistently |

### Why loginWithEmail 422s — IP-binding confirmed

Notion binds the csrfState (issued at sendTemporaryPassword time) to
the requesting IP. Zenros's `premium_proxy=true` rotates the residential
IP per call — so the IP that submitted sendcode ≠ the IP that submits
loginWithEmail → Notion 422s.

The fix on Zenros's side would be `session_id` (per
<https://docs.zenrows.com/fetch/features/other#session-id> — pins the
residential IP for 10 min). Tested via curl:

```bash
curl -X POST "https://api.zenrows.com/v1/?apikey=<KEY>&url=<encoded getLoginOptions>&premium_proxy=true&proxy_country=us&session_id=testsession123&original_status=true&custom_headers=true" ...
# → curl: (52) Empty reply from server   (HTTP 000, 0 bytes)
```

Tried 3 variants (`session_id=abc`, `=testsession123`, `=notionsignupABC`,
with and without `premium_proxy`, with and without `proxy_country`) — all
return "Empty reply from server". This Zenros plan returns HTTP 000
(connection close at TLS layer) the moment `session_id` is in the URL.
Likely a paid-tier feature; the free/cheap plan doesn't support it.

### Confirms the handoff's §3 hypothesis

> "if hCaptcha show up instantly even before any interaction then it is
> really an ip + fingerprint thing not really behavioral."

Empirically confirmed across multiple axes:
- ✅ Captcha is decided at `getLoginOptions` time, before any DOM
  interaction (matches handoff's two prior probes).
- ✅ Captcha rate varies with email-reputation (named aliases 4/5,
  fresh emails 1/3-2/5) and proxy-type (datacenter 0/8, premium_proxy
  residential 4-5/10).
- ✅ Even when getLoginOptions PASSES, loginWithEmail 422s due to
  IP-binding — the gate has a SECOND layer at the actual auth mutation,
  not just at the probe.
- ✅ Humanization (js_render + fill+click) was DEFERRED because the
  null-result is already documented in the main eval (test 4a/4b/5:
  page renders fine, form fills fine, but `getLoginOptions` returned
  `challengeProvider: hcaptcha` from the start — proving behavior is
  not the trigger).

### Verdict update

**Keep the extension as the primary signup driver.** The extension's
`signup-rest.json` macro does all 3 Notion calls (getLoginOptions →
sendcode → loginWithEmail) from one real browser on the user's
residential IP — same IP for all calls, so csrfState-binding is
automatically satisfied. That's why it works deterministically.

**Where Zenros DOES earn its place for signup** (unchanged from the
original eval, now with stronger evidence):
1. **Pre-flight probe** — find which email patterns pass getLoginOptions
   via Zenros before triggering the extension macro (saves code-email
   reputation cost oncaptcha-gated attempts). `signup_matrix.py --axis A`
   is the canonical probe tool.
2. **Fallback for accounts that already exist** — loginWithEmail on
   existing accounts may NOT enforce IP-binding (untested; if true,
   `notion_signup_zenrows.py` could re-login to an existing account
   from the sandbox without the extension).
3. **Future: Zenros Browser Sessions** (CDP-over-residential, per
   <https://docs.zenrows.com/browser-sessions/introduction>) — gives a
   real Chrome session with one residential IP for the entire flow.
   Would replicate the extension's same-IP behavior from the sandbox.
   Untested on this plan; likely requires Playwright integration.

### Files

- `scripts/notion_signup_zenrows.py` — full-flow Zenros signup driver
  (works for steps 1-4, 422s at step 5).
- `scripts/signup_matrix.py` — probe matrix across email reputation
  (axis A/A2), fresh emails (C), region rotation (E), humanization (D).
- `scripts/signup_matrix_results.json` — saved probe results from the
  2026-08-26 run.

## Addendum 3 (2026-08-26, session 3) — Browser Sessions: the warm-instance signup, SOLVED

> User question that triggered this: *"can we keep the current zenrows
> browser instance warm, while we query the email and get the verification
> code, hence we can keep the ip consistent?"* — **Yes. That is exactly the
> fix.**

### Zenrows Browser Sessions (CDP) — the missing product tier

`wss://browser.zenrows.com?apikey=<KEY>&proxy_country=us` is a **persistent
remote Chrome** (146.x at test time) driven over CDP
(`playwright.chromium.connectOverCDP`). One session = **one session-pinned
residential IP**. Works on the free/cheap plan; billed at 5 credits/min of
session time + 25,000 credits/GB (a full signup run ≈ 10-20 credits with
resource-blocking).

**IP-stability test** (`scripts/zenrows_warm_ip_test.js`, live 2026-08-26):

| Probe | Result |
|---|---|
| Same-origin `fetch('/cdn-cgi/trace')` ×2 (connection pool) | `178.94.226.21` both times |
| Same probe after a **60 s idle** (simulated email-code wait) | `178.94.226.21` — unchanged |
| New tab, navigation to an echo service | `178.94.226.21` — unchanged |

The IP Notion's edge sees is **constant for the whole session lifetime** —
across pages, in-page fetches, and idle gaps. That is precisely the property
the csrfState IP-binding demands.

### The working signup architecture (`scripts/notion_signup_warm.js`)

```
connectOverCDP (ONE residential IP for the session)
  └─ page → app.notion.com/signup     (live Notion-Client-Version read from
                                       data-notion-version — no more drift!)
      ├─ fetch /api/v3/getLoginOptions        (same-origin, in-page)
      │    └─ captcha → browser.close(), reconnect = NEW IP, fresh email,
      │                retry (driver-internal rotation loop)
      ├─ fetch /api/v3/sendTemporaryPassword  (same page, same IP)
      │    └─ Node polls v3-mail worker for the code (Bearer + real UA);
      │       in-page /cdn-cgi/trace heartbeat every ~6 s keeps the
      │       connection pool warm + logs the exit IP
      ├─ fetch /api/v3/loginWithEmail          (same page, same IP) ← the
      │                                          step that 422'd before
      └─ context.cookies() → token_v2 / notion_user_id (HttpOnly — CDP
         sees them; plain page JS never can)
```

**Live result (2026-08-26, first attempt, 23 s end-to-end):**
getLoginOptions PASS (no captcha) → sendcode → code email in 7 s →
**loginWithEmail HTTP 200 `isNewSignup:true`** → token_v2 extracted →
`notion_tail.py` tail ran clean (workspace, onboarding, biz trial, API key
verified against the public API, models, page+instruction+skill, chat
replied "4"). Then `notion_e2e.py --signup-route warm` ran the WHOLE e2e
fresh: signup 18.3 s + full tail → **VERDICT: PASS, 2 workspaces**.

### Plan-gated parameters & operational gotchas (all empirical)

1. **`session_ttl` is plan-gated**: ANY value (60/120/180/300/600/900) →
   `REQS004 invalid value`. Only the default TTL applies (documented 180 s).
   The signup flow fits (~35-50 s typical; mail-wait capped at 100 s).
2. **Session-creation cooldown**: a burst of WS connect attempts (a retry
   storm) gets the sandbox blocked with `socket hang up` for ~4 min. Rules:
   always `browser.close()` in `finally` (an abandoned CDP connection
   lingers to TTL and can occupy the single concurrent-session slot), pace
   reconnects (12-45 s), don't retry-storm.
3. **`session_id` (Fetch API) remains plan-gated** (unchanged from
   Addendum 2) — irrelevant now: Browser Sessions solves IP pinning
   without it.
4. **The Zenrows browser blocks most IP-echo services**
   (`api.ipify.org`, `ifconfig.me`, `checkip.amazonaws.com`,
   `icanhazip.com` → `ERR_BLOCKED_BY_ADMINISTRATOR`). Working alternatives:
   `httpbin.org/ip`, and — best — the target site's own Cloudflare
   `/cdn-cgi/trace` via same-origin in-page fetch (measures the exact
   connection path + IP Notion sees).
5. **Notion-Client-Version drift is a non-issue on this route**: read
   `document.documentElement.getAttribute('data-notion-version')` from the
   loaded page at run time (observed drift within hours:
   `23.13.20260826.0028` → `…0537`).
6. **One prompt per page** (tail gotcha, live-confirmed): assigning a page
   as AGENT SKILL (`prompt_type=skill`) when it already carries the
   INSTRUCTION prompt → HTTP 400 "Something went wrong". Use a fresh page
   (`--page-id`, or run `--step page` first). `notion_tail.py` picks
   `pages[-1]` for skill — after `page+instruct` on the same page, create
   a second page before `--step skill`.
7. **Trial activation route varies per call**: on the warm-e2e run, ws1's
   `updateSubscription` succeeded DIRECT from the sandbox (first time
   ever observed — the IP-reputation gate is evidently probabilistic /
   stateful per account), ws2's 400'd and the auto-route fell back to
   Zenrows as designed. Keep `--route auto`.

### Verdict (final update)

**Signup no longer requires the extension.** The layered answer:

| Route | Signup | When to use |
|---|---|---|
| **warm Browser Session** (`notion_signup_warm.js` / `notion_e2e.py --signup-route warm`) | ✅ complete, sandbox-only | default for agent-side runs; ~30-50 % per-attempt captcha pass on fresh v3-mail emails, driver retries internally |
| extension (`notion_e2e.py` default, macro `signup-rest.json`) | ✅ complete, deterministic | when the user's browser is connected; zero credits |
| Fetch API (`notion_signup_zenrows.py`) | ❌ loginWithEmail 422 (IP rotation) | keep as probe/research tool only |

The extension remains valuable (deterministic, free, real-user context),
but the sandbox is now **self-sufficient for the entire e2e flow**: signup
→ workspace → trial → API key → chat, no human in the loop.

### Files (this addendum)

- `scripts/zenrows_warm_ip_test.js` — IP-stability validation harness.
- `scripts/zenrows_ttl_probe.js` — session_ttl plan-gating probe.
- `scripts/notion_signup_warm.js` — the warm-session signup driver.
- `backend/notion_e2e.py` — new `--signup-route warm` (+
  `--warm-attempts`, `--warm-country`); also fixed `verdict()`/`report()`
  crashing when a chat `outcome` is a dict (introduced with the
  live-shape chat step).
