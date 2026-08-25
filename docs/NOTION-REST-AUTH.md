# Notion REST Auth — the Zero-Click Signup Recipe

**Verified live end-to-end 2026-08-25** (pure REST through the user's browser
session; session cookies captured; zero form interaction, zero captcha).

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

### 3. Read the code from v3-mail

Send to a **named** priv.email alias (admin@ / support@ / noreply@ /
billing@ / security@) — those dual-deliver into the v3-mail worker where the
body is readable. **The chained mail is stored under the APEX form**
(`address=admin@priv.email`), NOT the v3-mail form — the skill doc's claim
is wrong for this deployment. `text_body` of Notion's code email IS the code
(6-char alphanumeric, e.g. `493701\n`).

```
GET https://v3-mail.priv.email/emails?address=admin@priv.email&limit=3   (list)
GET https://v3-mail.priv.email/emails/<id>                               (body)
```
Auth: Bearer QUERY_API_TOKEN **or** the admin session cookie (works today by
running the fetch inside a v3-mail tab — the extension macro does exactly
that; the tab must be FOCUSED or Chrome throttles background-tab fetches).

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
4. **Background-tab fetch throttling**: Chrome stalls fetches in long-
   backgrounded tabs — the macro focuses the mail tab while polling.
5. Codes are single-use and expire ~10 min; each `sendTemporaryPassword`
   sends a fresh email (reputation cost — don't spam).

## Where it lives

- `extension/macros/notion/signup-rest.json` — the full flow as a macro
  (17 steps, zero clicks). The dry-run harness mocks all four endpoints
  (tests/test_macro_dryrun.js) — request-shape regressions get caught.
