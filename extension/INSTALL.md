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
  **Heads-up (Notion today):** the code email's subject is "Your Notion
  signup code" with the code in the BODY — the inbox API can only read
  subjects, so the macro detects the email and **stops fast** with
  instructions instead of looping. Then:
  1. grab the code from the forwarded mailbox
     (`ansgareutychis@hotmail.com` — check **Junk**), and
  2. run the **`notion/submit-code`** preset with `{"code": "XXXXXX"}` —
     it types the code into the still-open signup tab and captures the
     session.
  (Alternative: re-run signup with `"manualCode": "XXXXXX"` in inputs —
  skips polling entirely.)
- **`notion/full-onboarding`** — the complete 36-step flow (same email-code
  caveat as signup).

**Stop button**: works. If anything misbehaves, press **Stop** — the run
ends within ~1 step (the current step finishes first), and the "being
debugged" banner clears when the macro ends.

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
- **"a macro is already running"** — one macro at a time; press **Stop**
  first, then run again.
- **"code is NOT in the subject line" (fatal)** — expected on Notion today:
  the email arrived but its code is in the body, which the inbox API can't
  read. Get the code from Hotmail (Junk folder) and run `notion/submit-code`,
  or re-run with `manualCode` set.
- **No code found** — check the email actually arrived (ImprovMX logs API),
  and that the email input matches the alias you used.
- Full docs: README.md, docs/MACROS.md, docs/EXTENSION-VS-CHROME-RD.md.
