# Extension vs. Chrome Remote Debugging (CDP) — which route, when?

**Question raised (2026-08-25):** would driving Chrome via `--remote-debugging-port`
(plain CDP / Puppeteer / Playwright) be better than the extension route?

**Short answer: they are the same muscle used in different places.** The
extension already speaks CDP internally (`chrome.debugger`); what it adds is
*whose browser* the CDP commands run in and *who can reach it*. Keep the
extension as the production path; use raw CDP for automated testing (we
already do — the test suite drives the real extension through Playwright's CDP).
Nothing here overthrows the extension route; it clarifies when each wins.

## What each route actually is

| | Chrome RD mode (`--remote-debugging-port=9222`) | Onboard Automation Bridge (extension) |
|---|---|---|
| Transport | Raw CDP over HTTP+WS on a port you open at launch | Extension commands over WS/HTTP to a daemon; **internally executed via `chrome.debugger` = CDP** (`Runtime.evaluate`, `Network.*`) |
| Whose browser | A Chrome instance *you* launched with a flag, usually a dedicated profile | **The user's daily browser**, real profile, real cookies, real extensions, real IP |
| Capability ceiling | Highest — full CDP: every Domain, per-request interception, emulation, buffer control | 23 curated commands built on the same CDP primitives + `chrome.scripting`, `cookies`, `tabs` APIs |
| Installation friction | Must quit Chrome and relaunch with a flag (or run a second instance) | "Load unpacked" once; zero flags |
| Detectability | Browser launched for automation: CDP artifacts (e.g. `Runtime.enable` side effects), no user history/cookies, datacenter IP if run in a cloud sandbox → hCaptcha enterprise fails | Real browser context. `chrome.debugger` shows a one-time "being debugged" infobar but sets **no** `navigator.webdriver` flag; hCaptcha enterprise passes (this is the *primary reason* the extension exists — the reference repos require a real browser for hCaptcha-gated signup) |
| Who can drive it | Anything that can reach the port — localhost only unless you tunnel | The Python dev daemon (local/agent) or the Phase 2 CF Worker over HTTP; the popup also runs everything locally |
| Survivability | Dies with the launched process | MV3 service worker sleeps/wakes; HTTP long-poll fallback keeps the link alive even when WS dies (empirically necessary — see `.agents/SKILL.md` §1.1) |
| "Execute anything" | Yes, any CDP command | Yes — `eval` (arbitrary JS in any tab's main world), `fetch`, `page.fetch`, `form.*`, `cookies.*`, `xhr.intercept`, `screenshot`, plus **Quick Exec** in the popup (single-command REPL) and `POST /api/command` on the daemon (curl-able remote control) |
| "Report anything" | DevTools protocol events | Capture ring: every command/result/fetch (masked, 4KB-capped), exportable as JSON or HAR; every macro step + result persisted to Turso |

## The empirical constraints that decided this

1. **hCaptcha enterprise** gates Notion and Supabase signup. It scores the
   browser context; a fresh automated profile fails where the user's real
   browser passes. The extension route exists to run flows *inside the real
   browser*. (`.agents/SKILL.md` §1.6.)
2. **WS on CF free tier is dead** (5+ P0 reconnect bugs in the notion repo's
   history). So the *backend* link must be HTTP-poll-friendly — the extension
   supports both, with the daemon for dev and a Worker for Phase 2.
3. **The sandbox cannot run the user's browser.** Raw RD mode from this
   sandbox would mean headless Chromium in a datacenter — fine for testing
   (that's exactly what `tests/test_extension_headless.js` does, and it works:
   `chrome.debugger` attaches fine alongside Playwright's own CDP session),
   useless for passing captcha in the user's context.

## Where raw CDP already serves us

- `tests/test_extension_headless.js` + `tests/test_toy_signup_e2e.js` load the
  real extension in headless Chromium via Playwright (CDP) and drive the popup
  end-to-end — including verifying the extension's own `chrome.debugger` CDP
  usage. Two CDP layers, zero conflicts.
- `python-dev-daemon/bridge.py` exposes `POST /api/command` — the same
  "remote debug" ergonomics (`curl -d '{"type":"eval","function":"..."}'`),
  but the commands execute in the user's real browser.

## Verdict

- **Production / real-service flows (Notion, Supabase):** extension. It *is*
  CDP with an identity, a distribution story, and a survival story.
- **Automated testing:** Playwright/CDP in the sandbox — already in place, all
  suites green.
- **Agent-driven interactive work:** the dev daemon + `POST /api/command`
  (or the WS protocol directly) gives Chrome-RD-like power over the user's
  real browser without asking them to relaunch Chrome with flags.
- If a future flow needs CDP capabilities the 23 commands don't expose
  (e.g. response body interception at scale), extend a command handler then —
  don't pre-build a parallel raw-CDP route.
