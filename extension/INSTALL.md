# Onboard Automation Bridge — Install & First Run

## 1. Install (30 seconds)

1. Unzip this package.
2. Open `chrome://extensions` in Chrome.
3. Toggle **Developer mode** (top right).
4. Click **Load unpacked** → select the unzipped `onboard-automation-bridge/` folder
   (the one containing `manifest.json`).

That's it. The extension runs **standalone** — no backend needed.

## 2. Zero-config defaults

The **Email & Storage Config** panel (popup, left column) ships pre-filled:

- **Email API URL**: the `priv.email` ImprovMX inbox endpoint
- **Email API token**: `api:sk_...` (the priv.email key)

So the email presets work immediately. Optional:
- **Turso URL / token**: only if you want run history persisted to a database.

## 3. First run — the self-test (no real service, ~5 seconds)

The bundled `_shared/self-test` preset signs up on a local toy site and
verifies the entire pipeline: form fill/click, email-code retrieval,
verification, session capture.

1. From the repo (this zip's companion), start the toy site:
   `node tests/toy-signup-site/server.js`
   (If you only have this zip without the repo, skip to step 4 — or grab the
   repo for the toy server.)
2. Click the extension icon → preset **_shared/self-test** → **▶ Run Macro**.
3. Expect: 16/16 steps green, a session cookie captured.

## 4. Real flows

- **`notion/create-api-key`** — simplest live test (needs an active Notion
  session in this browser): set `{"spaceId": "..."}` in inputs and run.
- **`notion/signup`** — full signup + email verification. Just edit the email
  input (any `*@priv.email` address works — it's a catch-all).
- **`notion/full-onboarding`** — the complete 36-step flow.

## 5. Optional: dev daemon (agent-driven remote control)

```
python3 python-dev-daemon/bridge.py            # listens on :3000
```

Then in the popup's **Server Connection** box: `ws://127.0.0.1:3000` → Connect.
From a terminal you can now drive the browser:

```
curl -X POST http://127.0.0.1:3000/api/command \
  -H 'Content-Type: application/json' \
  -d '{"type":"eval","function":"() => ({ title: document.title })"}'
```

## 6. Troubleshooting

- **"retry: no http(s) tab available to evaluate condition"** — open any
  normal web page first (eval steps need a tab to run in).
- **No code found** — check the email actually arrived (ImprovMX logs API),
  and that the email input matches the alias you used.
- Full docs: README.md, docs/MACROS.md, docs/EXTENSION-VS-CHROME-RD.md.
