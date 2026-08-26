# Notion REST Auth — the Zero-Click Signup Recipe

**Verified live end-to-end 2026-08-25** (pure REST through the user's browser
session; session cookies captured; zero form interaction, zero captcha).
**2026-08-26: the same recipe now runs fully sandbox-side** via ONE warm
Zenrows Browser Session — `scripts/notion_signup_warm.js` (all three calls
as same-origin in-page fetches from one session-pinned residential IP,
which satisfies Notion's csrfState IP-binding; see
`docs/ZENROWS-EVAL.md` Addendum 3) or `backend/notion_e2e.py
--signup-route warm` for the whole e2e.

## The endpoints (all POST, credentials: include, same-origin)

**Required headers on ALL of them** (missing `Notion-Client-Version` →
`400 UserValidationError "Login is not allowed"`):

```
Content-Type: application/json
Notion-Audit-Log-Platform: web
Notion-Client-Version: <live value — read document.documentElement
                         .getAttribute('data-notion-version') from any
                         app.notion.com page; changes on every Notion deploy>
```

### 1. getLoginOptions

```json
{ "email": "admin@priv.email", "requireWorkTypeEmail": false }
```
→ `{ "hasAccount": bool, "loginOptionsToken": "v02:login_options:…",
    "challengeProvider": "hcaptcha" (only when challenged) }`

### 2. sendTemporaryPassword

```json
{ "email": "admin@priv.email",
  "redirectURL": "/p/3c7e9d22c27d805f8768dc3399e67455",
  "disableLoginLink": false, "native": false, "isSignup": true,
  "shouldHidePasscode": false,
  "loginOptionsToken": "<from step 1>",
  "deviceId": "<any uuid — page uses a persistent one>",
  "loginRouteOrigin": "signup" }
```
→ `{ "csrfState": "v02:temp_password:…" }` + the code email is sent.

### 3. Read the code from v3-mail (direct Bearer API — no mail tab)

Send to a **named** priv.email alias (admin@ / support@ / noreply@ /
billing@ / security@) — those dual-deliver into the v3-mail worker where the
body is readable. **The chained mail is stored under the APEX form**
(`address=admin@priv.email`), NOT the v3-mail form. `text_body` of Notion's
code email ALWAYS starts with the code as the entire first line — TWO
variants verified live:
- signup code: subject "Your Notion signup code", body `493701\n` (digits)
- login code (account already exists): subject "Your temporary Notion login
  code", body `bfDSXo\n\nNever share this code...` — **mixed case**, so an
  uppercase-only `[A-Z0-9]` regex misses it; match `/^[A-Za-z0-9]{4,10}$/`
  on the first line.

```
GET https://v3-mail.priv.email/emails?address=admin@priv.email&limit=10&include_body=true
```
Auth: `Authorization: Bearer <QUERY_API_TOKEN>` (the token ships as the
extension's default config — popup.js DEFAULT_CONFIG). `include_body=true`
returns `text_body` on every row, so ONE request per poll covers list + body.

Since v0.9.5 the macro's `fetch` steps run in the **extension service worker**
with the Bearer header — NO mail tab, NO admin-cookie session, NO tab-focus
workarounds. (`credentials: 'omit'`; host_permissions bypass CORS.) The
macro takes a baseline (`sinceId` = max row id) before sendTemporaryPassword
so a re-run never submits a stale code from a previous run's email.

### 4. loginWithEmail

```json
{ "state": "<csrfState from step 2>",
  "password": "<the 6-char code>",
  "appSource": "notion",
  "loginRouteOrigin": "signup" }
```
→ `{ "isNewSignup": true, "userId": "…" }` + `token_v2` / `notion_user_id`
session cookies set on the browser.

## Gotchas discovered the hard way

1. **`Notion-Client-Version` is mandatory** — 400 "Login is not allowed"
   without it (even for gmail addresses — it looks like domain blocking but
   isn't).
2. **Mail must go to a named alias** — catch-all addresses (foo@priv.email)
   forward to Hotmail only; the worker never sees the body.
3. **Apex vs v3-mail address form**: chained mail is stored under
   `to_address = admin@priv.email` (the apex form).
4. **Login codes are mixed-case** ("bfDSXo"), signup codes are digits-only
   ("493701") — extraction must accept `[A-Za-z0-9]` (first line of
   text_body).
5. Codes are single-use and expire ~10 min; each `sendTemporaryPassword`
   sends a fresh email (reputation cost — don't spam).
6. Once the account EXISTS, getLoginOptions returns `hasAccount: true` and
   the flow becomes a LOGIN (isNewSignup: false) — the same macro handles
   both; only the email template differs.
7. Cloudflare bot-blocks plain `python urllib` (403) on the worker host —
   `curl` and browser/SW fetches are fine.

## Where it lives

- `extension/macros/notion/signup-rest.json` — the full flow as a macro
  (19 steps, zero clicks, direct Bearer mail reads). The dry-run harness mocks
  all four endpoints
  (tests/test_macro_dryrun.js) — request-shape regressions get caught.
- `scripts/notion_signup_warm.js` — the SAME three calls driven from the
  sandbox inside one warm Zenrows Browser Session (Node/Playwright over
  CDP): reads the live `Notion-Client-Version` off the page, polls v3-mail
  itself, extracts HttpOnly cookies via CDP. Emits creds JSON for
  `notion_tail.py --init-from-creds`. THE agent-side signup path as of
  2026-08-26.
