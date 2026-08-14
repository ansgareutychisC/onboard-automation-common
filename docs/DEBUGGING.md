# DEBUGGING.md — Activatable Debug Commands

The unified extension includes 11 activatable debugging commands. Unlike the legacy `xhr.intercept` (which captures a single request and detaches), these commands let you **continuously capture** browser activity for as long as you need — then stop and retrieve the full buffer.

All debug commands use `chrome.debugger` (the same permission already used by `form.eval` and `xhr.intercept`), so **no additional permissions are required**.

## Command Reference

| Command | Type | Captures |
|---------|------|----------|
| `debug.har.start` / `stop` | Toggle | Full HAR 1.2 JSON (network requests + responses) |
| `debug.console.start` / `stop` | Toggle | Page `console.*` output (log/warn/error/info/debug) + stack traces |
| `debug.network.start` / `stop` | Toggle | Continuous network capture (vs one-shot `xhr.intercept`) |
| `debug.trace.start` / `stop` | Toggle | CDP Tracing events (performance timeline, V8 internals) |
| `debug.dom.snapshot` | One-shot | DOM tree as HTML (with optional shadow DOM) |
| `debug.storage.dump` | One-shot | `localStorage` + `sessionStorage` + cookies for a tab |
| `debug.screenshot.fullpage` | One-shot | Full-page screenshot (not just visible viewport) |

## Session Model

Each toggle command returns a `sessionId` on start. The extension attaches `chrome.debugger` to the tab ONCE per session (refcounted — multiple concurrent sessions on the same tab share the debugger attachment). While the session is active:

1. **Live events stream** — captured events are sent immediately as `MSG.EVENT` messages (so a live dashboard can render them in real time).
2. **Buffer accumulates** — events are also stored in memory on the extension side.
3. **Stop returns the full buffer** — the stop command's result contains the complete captured data, even if some events were already streamed live.

The orchestrator can choose to consume either the live stream (for real-time observability) or the stop-result buffer (for one-shot analysis), or both.

## Usage Patterns

### 1. Capture a HAR of a Multi-Step Flow

Use this when reverse-engineering a signup flow: start HAR capture, walk through the entire flow, stop, save the HAR to disk.

```python
async with ExtensionBridge("http://127.0.0.1:8787") as bridge:
    await bridge.wait_for_extension(timeout=60)

    # Open the signup page
    tab = await bridge.tabs_open("https://example.com/signup")
    tab_id = tab.get("tabId")

    # Start HAR capture
    session = await bridge.debug_har_start(tab_id)
    session_id = session.data["sessionId"]

    # Walk through the flow (your service-specific logic)
    await bridge.form_fill(tab_id, "input[name=email]", "user@example.com")
    await bridge.form_click(tab_id, "button[type=submit]")
    # ... wait for redirect, fill more fields, etc.

    # Stop and retrieve
    result = await bridge.debug_har_stop(session_id)
    har = result.data["har"]

    # Save to disk
    import json
    with open("signup.har", "w") as f:
        json.dump(har, f, indent=2)
    print(f"Captured {result.data['entryCount']} entries in {result.data['durationMs']}ms")
```

The resulting `signup.har` file can be loaded directly into Chrome DevTools' Network panel, or used as a mock for offline tests (the way the legacy todoist project uses `.har.zip` files).

### 2. Mirror Page Console Output

Use this when debugging a flaky JavaScript interaction — capture the page's own console output while your automation runs.

```python
session = await bridge.debug_console_start(tab_id)
# ... run your automation, trigger the bug ...
result = await bridge.debug_console_stop(session.data["sessionId"])

for entry in result.data["entries"]:
    level = entry["type"]
    args = " ".join(str(a) for a in entry["args"])
    stack = entry["stackTrace"][0] if entry["stackTrace"] else None
    loc = f" ({stack['functionName']}@{stack['url']}:{stack['lineNumber']})" if stack else ""
    print(f"[{level}] {args}{loc}")
```

Captures both `Runtime.consoleAPICalled` (page's `console.*` calls) and `Log.entryAdded` (browser-internal log messages).

### 3. Continuous Network Capture with URL Filter

Use this when you want to see ALL requests matching a pattern (not just the first one, as `xhr.intercept` does).

```python
session = await bridge.debug_network_start(tab_id, url_pattern=r"api\.(example|auth)\.com")
# ... trigger multiple operations ...
result = await bridge.debug_network_stop(session.data["sessionId"])

for entry in result.data["entries"]:
    req = entry["request"]
    resp = entry.get("response", {})
    body = entry.get("responseBody", "")[:200]
    print(f"{req['method']} {req['url']} → {resp.get('status')} (body: {body!r})")
```

The `urlPattern` is a regex string (passed to `new RegExp(...)`). If omitted, captures ALL requests.

### 4. Performance Trace for Slow Operations

Use this when a page interaction is slow and you want to see where the time goes.

```python
session = await bridge.debug_trace_start(tab_id, categories="devtools.timeline,v8")
# ... trigger the slow operation ...
result = await bridge.debug_trace_stop(session.data["sessionId"])

events = result.data["events"]
print(f"Captured {len(events)} trace events")

# Save as Chrome DevTools trace JSON (loadable via devtools://devtools/bundled/devtools_app.html)
import json
with open("trace.json", "w") as f:
    json.dumps({"traceEvents": events}, f)
```

Categories default to `"devtools.timeline,v8,disabled-by-default-devtools.timeline"`. See the [Chrome DevTools Protocol docs](https://chromedevtools.github.io/devtools-protocol/tot/Tracing/) for the full category list.

### 5. DOM Snapshot for Selector Discovery

Use this when you're writing a new automation flow and need to find the right selectors — dump the DOM and search it offline.

```python
result = await bridge.debug_dom_snapshot(tab_id, include_shadow=True)
html = result.data["html"]

# Save and open in a browser for inspection
with open("dom.html", "w") as f:
    f.write(f"<!DOCTYPE {result.data['doctype']}>\n" + html)

# Or grep for likely selectors
import re
inputs = re.findall(r'<input[^>]*>', html)
for inp in inputs:
    print(inp)
```

Set `max_depth` to limit recursion (0 = unlimited). Shadow DOM is included by default.

### 6. Dump All Client-Side State

Use this when debugging authentication state — see exactly what's in localStorage, sessionStorage, and cookies.

```python
result = await bridge.debug_storage_dump(tab_id)

print("localStorage:")
for k, v in result.data["localStorage"].items():
    print(f"  {k} = {v[:100]}")

print("\nsessionStorage:")
for k, v in result.data["sessionStorage"].items():
    print(f"  {k} = {v[:100]}")

print("\nCookies:")
for c in result.data.get("cookies", []):
    print(f"  {c['name']} = {c['value'][:50]} (domain={c['domain']})")
```

### 7. Full-Page Screenshot

Use this when `screenshot` (visible-viewport only) misses content below the fold.

```python
result = await bridge.debug_screenshot_fullpage(tab_id, format="png")
data_url = result.data["dataUrl"]
dimensions = result.data["dimensions"]
print(f"Captured {dimensions['width']}x{dimensions['height']} page (viewport was {dimensions['viewportWidth']}x{dimensions['viewportHeight']})")

# Save to disk
import base64
with open("fullpage.png", "wb") as f:
    f.write(base64.b64decode(data_url.split(",", 1)[1]))
```

Uses CDP `Page.captureScreenshot` with `captureBeyondViewport: true`. Supports `format: "png" | "jpeg"` and `quality` (for jpeg).

## Combining Debug Sessions

Multiple debug sessions can run concurrently on the same tab — the extension refcounts `chrome.debugger` attachments. For example, you can capture HAR + console + network simultaneously:

```python
har_session = await bridge.debug_har_start(tab_id)
console_session = await bridge.debug_console_start(tab_id)
network_session = await bridge.debug_network_start(tab_id, url_pattern=r"api\.")

# ... run automation ...

har_result = await bridge.debug_har_stop(har_session.data["sessionId"])
console_result = await bridge.debug_console_stop(console_session.data["sessionId"])
network_result = await bridge.debug_network_stop(network_session.data["sessionId"])

# Now you have three correlated views of the same interaction.
# Use the traceId (if you set one on each start command) to correlate them.
```

## Live Event Streaming

While a debug session is active, the extension streams events as `MSG.EVENT` messages. To consume them live, your orchestrator needs to subscribe to the bridge's event stream (this requires extending `ExtensionBridge` with an event-listener API — not yet implemented in the template, but the wire protocol supports it).

The event envelope:

```json
{
  "type": "event",
  "event": "console.log",
  "tabId": 123,
  "sessionId": "console_...",
  "traceId": "trace-xyz",
  "ts": 1699999999999,
  "data": { "type": "log", "args": ["Hello, world!"], "stackTrace": [...] }
}
```

## Performance Considerations

- **HAR capture** buffers all request/response bodies in memory on the extension side. For long sessions with large responses, this can exhaust the MV3 service worker's memory. Stop and restart the session every few minutes if needed.
- **Network capture** with no `urlPattern` captures everything — can be noisy. Always filter when possible.
- **Trace capture** can produce tens of thousands of events per second. The extension streams a "progress" event every 100 events (not every event) to avoid flooding the WS. The full buffer is returned on stop.
- **Console capture** is cheap — page console output is usually low-volume.

## When to Use What

| Symptom | Use |
|---------|-----|
| "I need to reverse-engineer this signup flow" | `debug.har.start` + walk through the flow manually |
| "My automation fails silently — no error" | `debug.console.start` + run automation, inspect page console |
| "The page makes a request I don't know about" | `debug.network.start` with a broad URL pattern |
| "This interaction is slow" | `debug.trace.start` + run interaction, load trace into DevTools |
| "I can't find the right selector" | `debug.dom.snapshot` + grep the HTML |
| "Login state is wrong" | `debug.storage.dump` + inspect localStorage + cookies |
| "The bug is below the fold" | `debug.screenshot.fullpage` |
| "I just need one specific XHR" | `xhr.intercept` (one-shot, lighter weight) |
