# Extension Macro Replay Mode

The extension supports a **local macro replay mode** that lets you run JSON-defined automation flows without needing the Python backend or Cloudflare Worker. This is the fastest way to iterate on and test the onboarding flows.

## How It Works

1. You write (or load a preset) a **macro** — a JSON file with `inputs` (variables) and `steps` (sequential commands).
2. You paste the macro into the extension popup's "Macro Replay" section.
3. You fill in the inputs (email, workspace name, email worker token, etc.).
4. You click "Run Macro".
5. The extension executes each step locally, showing the result of each step.

## Macro Format

```json
{
  "name": "my-macro",
  "description": "What this macro does",
  "inputs": {
    "email": "test@example.com",
    "workspaceName": "My Space"
  },
  "steps": [
    {
      "id": "step1",
      "cmd": "tabs.open",
      "url": "https://app.notion.com/signup",
      "active": true
    },
    {
      "id": "step2",
      "cmd": "form.wait",
      "tabId": "{{step1.tabId}}",
      "selector": "input[type=email]",
      "timeoutMs": 15000
    },
    {
      "id": "step3",
      "cmd": "fetch",
      "url": "https://app.notion.com/api/v3/getSpacesInitial",
      "method": "POST",
      "headers": {"Content-Type": "application/json"},
      "body": "{}",
      "credentials": "include"
    },
    {
      "id": "step4",
      "cmd": "eval",
      "function": "(args) => { return { parsed: JSON.parse(args.body) }; }",
      "args": { "body": "{{step3.body}}" }
    }
  ]
}
```

### Template Substitution

Any string value in a step can contain `{{...}}` templates:

- `{{inputs.email}}` — references a value from the `inputs` object
- `{{step1.tabId}}` — references the `tabId` field from the result of step `step1`
- `{{step3.body}}` — references the `body` field from step `step3`'s result
- `{{results.step1.ok}}` — alternative explicit form

Templates are resolved before the step is executed. If a template path doesn't resolve, the template is left as-is (so you can detect missing values).

### Step Types

| `cmd` | Description | Key args |
|---|---|---|
| `tabs.open` | Open a URL in a new tab | `url`, `active` |
| `tabs.close` | Close a tab | `tabId` |
| `tabs.list` | List open tabs | — |
| `form.wait` | Wait for a CSS selector to appear | `tabId`, `selector`, `timeoutMs` |
| `form.fill` | Fill a form field | `tabId`, `selector`, `value` |
| `form.click` | Click an element | `tabId`, `selector` |
| `form.eval` | Execute JS in a page | `tabId`, `function`, `args` |
| `fetch` | HTTP request via extension's browser context | `url`, `method`, `headers`, `body`, `credentials` |
| `cookies.getAll` | Get all cookies for a URL | `url` |
| `cookies.set` | Set cookies | `url`, `cookies` |
| `cookies.remove` | Remove cookies (whole registrable domain sweep, per name+domain+path) | `url`, `names` (optional — omit for all) |
| `storage.clear` | Wipe origin storage: localStorage + sessionStorage + IndexedDB + caches (closes other tabs on the origin to release IDB handles) | `url`, `clearLocalStorage`/`clearSessionStorage`/`clearIndexedDB`/`clearCaches`/`closeOtherTabs` (all default true) |
| `eval` | Pure JS in the service worker (no page context) | `function`, `args` |
| `xhr.intercept` | Intercept an XHR | `tabId`, `urlPattern`, `timeoutMs` |
| `screenshot` | Capture visible tab | `tabId` |
| `wait` | Sleep | `ms` |
| `log` | Log a message | `message`, `data` |
| `retry` | Re-run sub-steps until condition | `timeoutMs`, `intervalMs`, `condition`, `steps` |

### The `eval` Command

`eval` runs JavaScript **in a tab's main world** via `chrome.debugger` + CDP
`Runtime.evaluate` (MV3 service workers forbid `eval()`, so this is the only
safe path). It receives an `args` object and must return a JSON-serializable
value. At least one http(s) tab must be open (the macro itself usually opens
one via `tabs.open`). Use it for:
- Parsing fetch response bodies (e.g., extracting a `spaceId` from `createSpace` response)
- Generating UUIDs and timestamps
- Building request bodies from previous results
- Any logic that doesn't need page DOM access

```json
{
  "id": "gen-ids",
  "cmd": "eval",
  "function": "() => { return { uuid: crypto.randomUUID(), ts: Date.now() }; }",
  "args": {}
}
```

### The `retry` Block

For polling (e.g., waiting for a verification email), use the `retry` block:

```json
{
  "id": "get-verification-code",
  "cmd": "retry",
  "timeoutMs": 180000,
  "intervalMs": 10000,
  "condition": "result && result.code != null",
  "steps": [
    {
      "id": "fetch-email",
      "cmd": "fetch",
      "url": "{{inputs.emailWorkerUrl}}",
      "method": "GET",
      "headers": {"Authorization": "{{email-auth.header}}"},
      "credentials": "omit"
    },
    {
      "id": "parse-code",
      "cmd": "eval",
      "function": "{{inputs.extractionJs}}",
      "args": {
        "body": "{{fetch-email.body}}",
        "email": "{{inputs.email}}",
        "sinceMs": "{{email-now.now}}"
      }
    }
  ]
}
```

Note: `timeoutMs` / `intervalMs` / `condition` are read literally by the runner
(they are NOT template-resolved) — keep them concrete values. The interval of
10s respects ImprovMX's ~10 req/min limit on the `/logs` endpoint.

The `condition` is a JS expression evaluated against `{ result, results, inputs }` where:
- `result` = the result of the last sub-step
- `results` = all sub-step results keyed by id
- `inputs` = the macro's inputs

Sub-step results are also promoted to the parent context, so `{{parse-code.code}}` works in subsequent top-level steps.

### Error Handling

By default, if a step fails (returns `ok: false` or throws), the macro aborts. To continue on error:

```json
{
  "id": "optional-step",
  "cmd": "fetch",
  "url": "...",
  "onError": "continue"
}
```

## Preset Macros

The extension bundles presets under `extension/macros/`, organized by service:

| Preset | Description | Requires |
|---|---|---|
| `notion/signup` | Signup + email verification, form-based (17 steps) | Email API config |
| `notion/signup-rest` | **PURE REST signup — zero clicks** (17 steps; reads code from v3-mail) | Named priv.email alias |
| `notion/submit-code` | Type a pasted verification code into the open signup tab | The code (from Hotmail) |
| `notion/create-workspace` | Create a workspace on an existing account | Active session |
| `notion/activate-trial` | Activate 14-day business trial | hCaptcha P1_ token |
| `notion/create-api-key` | Create a PAT | Active session + spaceId |
| `notion/full-onboarding` | Full signup → onboarded flow (36 steps, HAR Phase A-K) | Email API config |
| `_shared/wait-for-verification-email` | The email chunk standalone — tests the email infra | Email API config |
| `_shared/self-test` | FULL signup vs the local toy site (16 steps, ~1s) | `node tests/toy-signup-site/server.js` |

The email API config ships pre-filled (priv.email / ImprovMX defaults) — the
`wait-for-verification-email` and notion email presets run with zero
configuration on a fresh install. `extension/config.example.json` documents
every config key.

## Shared Chunks

`macros/_shared/` holds **reusable step sequences** that get *inlined* into
service macros (the runner has no macro-calling-macro — by design). The
chunk of record is `wait-for-verification-email`:

- **Provider-agnostic by construction**: the inbox API endpoint
  (`emailWorkerUrl`), credentials (`emailWorkerToken`), and the extraction
  logic (`extractionJs`) are all macro **inputs**. Switching email providers
  or fixing a changed email template = editing inputs, never extension code.
- **Stable step ids**: `email-auth`, `email-now`, `get-verification-code`,
  `fetch-email`, `parse-code`, `log-got-code`. Macros that inline the chunk
  keep these ids so downstream `{{refs}}` are predictable.
- **Auth handling**: `email-auth` (eval) accepts either a raw Basic pair
  (`api:sk_...`) or a ready-made `Basic ...`/`Bearer ...` header value and
  produces the `Authorization` header.
- **Stale-code guard**: `email-now` stamps `Date.now()` before the retry
  starts; the extraction skips emails older than that **minus a 120s grace
  window** (`args.graceMs` overrides) — so emails created between the signup
  click and the first poll (any fast sender) still pass, while genuinely
  stale codes from a previous run are filtered.
- **`manualCode` input**: when set, the extraction returns it immediately —
  no polling. Escape hatch for services whose code email doesn't expose the
  code in the subject (Notion does exactly this).
- **Fail-fast (`fatal`) semantics**: when a code-shaped email for this
  recipient ARRIVES (subject matches /code|verify|login|passcode|confirm|
  signup|otp/i) but no code is extractable from the subject, the extraction
  returns `{fatal: true, error: <actionable message>}` and the retry runner
  ABORTS immediately — distinguish "not yet" (keep polling) from "never"
  (this API cannot read the code). Non-code emails (digests, welcomes)
  never trigger fatal.
- **Reality check (2026-08-24 live finding)**: Notion's code email is
  "Your Notion signup code" with the code in the BODY. ImprovMX `/logs`
  exposes subjects only — so for Notion today the flow is: signup runs,
  detects the email, fails fast with instructions; you grab the code from
  Hotmail (Junk folder) and either re-run with `manualCode` or run
  `notion/submit-code`. The long-term fix is an email source with body
  access (e.g. a Cloudflare Email Routing worker storing bodies in Turso).
- When a service's email format changes, edit that service macro's
  `extractionJs` input default (e.g. `macros/notion/signup.json`) — one file,
  no extension code changes, no lockstep updates.

To inline the chunk into a new service macro: copy the chunk's `steps` array
into the macro and override the `extractionJs` input with service-specific
extraction logic. Keep the step ids.

## Python Integration

The Python dev daemon (WS, agent-driven interactive debugging) is planned for
`python-dev-daemon/` — a port of notion v0.8.4's `scripts/run_bridge_aiohttp.py`,
gated behind `serverUrl` (empty by default = standalone mode; the extension
never attempts a WS connection unless configured). Until then, the extension
runs standalone from the popup.

## Testing Workflow

### Automated (no browser needed)

```bash
# 1. Static dry-run of every macro against HAR-captured responses
#    (template resolution, request-body shape, extraction logic, lint)
node tests/test_macro_dryrun.js

# 2. Live ImprovMX extraction tests (hits the real API read-only)
node tests/test_email_extraction_live.js

# 3. Full E2E: loads the real extension in headless Chromium (needs Playwright)
NODE_PATH=$(npm root -g) node tests/test_extension_headless.js
```

### Manual (in your browser)

0. **Optional zero-risk warm-up**: `node tests/toy-signup-site/server.js`
   in the repo → run the `_shared/self-test` preset — completes a full
   signup (form fill/click, email code, verify, session capture) against
   the local toy site in ~1s.

1. **First `notion/create-api-key`** (simplest, 8 steps, no email polling):
   - Log into Notion in your browser
   - Open the extension popup → Macro Replay section
   - Select "notion/create-api-key" preset
   - Fill in inputs: `{"spaceId": "your-space-id"}`
   - Click "Run Macro"
   - Verify the result shows an `ntn_*` token

2. **Then `_shared/wait-for-verification-email`** (email infra only):
   - Fill the Email & Storage config panel (ImprovMX URL + `api:sk_...` token)
   - Select the chunk preset, set inputs `{"email": "you@priv.email"}`
   - Run — should extract the code from the latest matching email

3. **Then `notion/create-workspace`** (10 steps, no signup):
   - Log into Notion
   - Select "notion/create-workspace" preset
   - Fill in inputs: `{"workspaceName": "Test Space"}`
   - Run — verify a new workspace appears in your Notion sidebar

4. **Then `notion/signup` / `notion/full-onboarding`** (17 / 36 steps):
   - Fill the config panel + inputs (email, workspace name)
   - Run — this opens a signup tab, fills the email, polls for the code,
     submits it, then (full-onboarding) does all the API calls
   - Verify the account is created and onboarding is cleared

5. **Iterate**: if a step fails, check the result panel + diagnostics log.
   Edit the macro JSON and re-run.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Extension (background.js)                     │
│                                                                  │
│  ┌──────────────┐   ┌──────────────┐   ┌─────────────────────┐ │
│  │ WS from      │   │ Macro Runner │   │ Existing Handlers   │ │
│  │ Python/Worker│──▶│              │──▶│ (fetch, form.eval,  │ │
│  │              │   │ - resolves   │   │  cookies, etc.)     │ │
│  │ OR           │   │   templates  │   │                     │ │
│  │              │   │ - dispatches │   │ sendResult() ───────┼─┼─▶ WS
│  │ Popup        │   │   to handler │   │         │           │ │
│  │ (paste JSON) │   │ - captures   │   │         │           │ │
│  │              │   │   result     │   │         ▼           │ │
│  └──────────────┘   └──────────────┘   │ pendingMacroResults │ │
│                                          │ Map<id, resolve>   │ │
│                                          └─────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

The macro runner is a thin orchestrator that:
1. Resolves `{{...}}` templates in each step's args
2. Dispatches the command to the existing handler (same code path as WS-driven commands)
3. Captures the result via `state.pendingMacroResults` (a Map of pending promises)
4. Proceeds to the next step

This means **macro replay and backend-driven commands use the exact same execution path** — the only difference is who decides what command to run next (the macro runner vs. the Python/Worker backend).
