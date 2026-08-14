# python-template

Async Python client for the unified browser extension. Talks to either the
local `scripts/run_bridge.py` daemon (dev) or the `worker-template/` Cloudflare
Worker (production) — both expose the same REST API.

## Install

```bash
cd python-template
pip install -r requirements.txt
pip install -e .   # if you add a setup.py / pyproject.toml
```

Or just copy the `onboard_common/` package into your service's repo.

## Quick Start

```python
import asyncio
from onboard_common import ExtensionBridge

async def main():
    async with ExtensionBridge("http://127.0.0.1:8787") as bridge:
        await bridge.wait_for_extension(timeout=60)
        result = await bridge.tabs_open("https://example.com")
        tab_id = result.get("tabId")
        await bridge.form_fill(tab_id, "input[name=email]", "user@example.com")
        await bridge.form_click(tab_id, "button[type=submit]")

asyncio.run(main())
```

## Using Activatable Debug Commands

```python
# Capture a HAR of everything that happens on a tab
session = await bridge.debug_har_start(tab_id)
await bridge.form_click(tab_id, "button#load-data")
har_result = await bridge.debug_har_stop(session.data["sessionId"])
# har_result.data["har"] is a HAR 1.2 JSON blob — save to disk
import json
with open("capture.har", "w") as f:
    json.dump(har_result.data["har"], f, indent=2)
```

```python
# Mirror page console output
session = await bridge.debug_console_start(tab_id)
# ... do stuff ...
result = await bridge.debug_console_stop(session.data["sessionId"])
for entry in result.data["entries"]:
    print(f"[{entry['type']}] {entry['args']}")
```

## Run the Local Daemon

```bash
# Foreground (for debugging):
python scripts/run_bridge.py --host 127.0.0.1 --port 8787 --log-level DEBUG

# As a daemon (double-forked, survives shell exits):
python scripts/run_bridge.py --daemon --pid-file /tmp/bridge.pid --log-file /tmp/bridge.log

# Check status:
cat /tmp/bridge.pid && kill -0 $(cat /tmp/bridge.pid) && echo "running"

# Stop:
kill $(cat /tmp/bridge.pid)
```
