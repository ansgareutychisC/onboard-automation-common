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
| `cookies.remove` | Remove cookies (including httpOnly) | `url`, `names` (optional — omit for all) |
| `eval` | Pure JS in the service worker (no page context) | `function`, `args` |
| `xhr.intercept` | Intercept an XHR | `tabId`, `urlPattern`, `timeoutMs` |
| `screenshot` | Capture visible tab | `tabId` |
| `wait` | Sleep | `ms` |
| `log` | Log a message | `message`, `data` |
| `retry` | Re-run sub-steps until condition | `timeoutMs`, `intervalMs`, `condition`, `steps` |

### The `eval` Command

`eval` runs JavaScript in the extension's service worker context. It receives an `args` object and must return a JSON-serializable value. Use it for:
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
  "id": "get-code",
  "cmd": "retry",
  "timeoutMs": 180000,
  "intervalMs": 4000,
  "condition": "result && result.code != null",
  "steps": [
    {
      "id": "fetch-email",
      "cmd": "fetch",
      "url": "{{inputs.emailWorkerUrl}}/emails?address={{inputs.email}}",
      "method": "GET",
      "headers": {"Authorization": "Bearer {{inputs.emailWorkerToken}}"}
    },
    {
      "id": "parse-code",
      "cmd": "eval",
      "function": "(args) => { const d = JSON.parse(args.body); const text = d.results[0]?.text_body || ''; const m = text.match(/\\d{6}/); return { code: m ? m[0] : null }; }",
      "args": { "body": "{{fetch-email.body}}" }
    }
  ]
}
```

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

The extension bundles these presets in `extension/macros/`:

| Preset | Description | Requires |
|---|---|---|
| `signup-onboard` | Full signup + onboarding flow (HAR Phase A-K) | Email worker token |
| `create-workspace` | Create a workspace on an existing account | Active session |
| `activate-trial` | Activate 14-day business trial | hCaptcha P1_ token |
| `create-api-key` | Create a PAT | Active session + spaceId |

## Python Integration

The Python backend can generate the same macros via `notion_onboarding.macros`:

```python
from notion_onboarding.macros import build_signup_onboard_macro

macro = build_signup_onboard_macro(
    email="test@privatimail.com",
    workspace_name="My Space",
    email_worker_url="https://mail-api.privatimail.com",
    email_worker_token="...",
)

# Option A: send to extension via WS (single message, runs locally)
bridge.send({"type": "macro.run", "macro": macro, "inputs": {}})

# Option B: save to file for the user to paste into the popup
import json
with open("my-macro.json", "w") as f:
    json.dump(macro, f, indent=2)

# Option C: execute step-by-step via WS (current approach, for debuggability)
# (The existing Python methods in onboarding.py already do this)
```

## Testing Workflow

1. **First test with `create-api-key`** (simplest, 8 steps, no email polling):
   - Log into Notion in your browser
   - Open the extension popup → Macro Replay section
   - Select "create-api-key" preset
   - Fill in inputs: `{"spaceId": "your-space-id"}`
   - Click "Run Macro"
   - Verify the result shows an `ntn_*` token

2. **Then test with `create-workspace`** (15 steps, no signup):
   - Log into Notion
   - Select "create-workspace" preset
   - Fill in inputs: `{"workspaceName": "Test Space"}`
   - Run — verify a new workspace appears in your Notion sidebar

3. **Then test with `signup-onboard`** (34 steps, full flow):
   - Fill in all inputs (email, workspace name, email worker token)
   - Run — this opens a signup tab, fills the email, polls for the code, submits it, then does all the API calls
   - Verify the account is created and onboarding is cleared

4. **Iterate**: if a step fails, check the result panel + diagnostics log. Edit the macro JSON and re-run.

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
