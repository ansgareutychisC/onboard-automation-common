#!/usr/bin/env python3
"""Test that command failures (ok:false) return HTTP 200 with the failure body,
not HTTP 500. This verifies the ISSUE-R2-11 fix.

Also tests the ok:false → BridgeCommandError typed exception path.
"""
import asyncio
import json
import subprocess
import sys
import time
import urllib.request
import urllib.error
import websockets

# Add parent dir to path so we can import onboard_common
sys.path.insert(0, ".")
from onboard_common import ExtensionBridge, BridgeCommandError, BridgeProtocolError, BridgeNotConnectedError

PORT = 18790
TOKEN = "secret123"
BASE = f"http://127.0.0.1:{PORT}"
WS_URL = f"ws://127.0.0.1:{PORT}/ws"

async def mock_extension_respond_ok_false():
    """Connect as a fake extension and respond to one command with ok:false."""
    async with websockets.connect(WS_URL) as ws:
        await ws.send(json.dumps({"type": "auth", "token": TOKEN}))
        await ws.recv()  # auth-ok
        await ws.send(json.dumps({"type": "connect", "agentId": "test-ext-fail", "context": "worker", "protocolVersion": "1.0", "capabilities": []}))
        # Wait for a command
        cmd = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))
        # Respond with ok:false (simulating "Element not found")
        await ws.send(json.dumps({
            "type": "result", "id": cmd["id"], "ok": False,
            "error": "Element not found: #nonexistent",
        }))
        # Wait a bit for the result to be processed
        await asyncio.sleep(0.5)

async def main():
    # Start daemon
    proc = subprocess.Popen(
        [sys.executable, "scripts/run_bridge.py", "--host", "127.0.0.1",
         "--port", str(PORT), "--auth-token", TOKEN, "--log-level", "ERROR"],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    time.sleep(1.5)
    results = []

    try:
        # Start mock extension in background
        ext_task = asyncio.create_task(mock_extension_respond_ok_false())
        await asyncio.sleep(0.5)  # let it connect

        # Use the Python client to send a command that will fail with ok:false
        async with ExtensionBridge(BASE, auth_token=TOKEN) as bridge:
            await asyncio.sleep(0.3)  # let extension register
            try:
                result = await bridge.form_click(tab_id=99999, selector="#nonexistent")
                if result.ok:
                    results.append(f"FAIL  form_click returned ok=true (expected ok=false): {result}")
                else:
                    results.append(f"OK    form_click returned ok=false as expected (error: {result.error})")
            except BridgeCommandError as e:
                results.append(f"OK    BridgeCommandError raised: {e}")
            except BridgeProtocolError as e:
                results.append(f"FAIL  got BridgeProtocolError instead of BridgeCommandError: {e}")
            except BridgeNotConnectedError as e:
                results.append(f"FAIL  got BridgeNotConnectedError (extension may not have registered in time): {e}")
            except Exception as e:
                results.append(f"FAIL  unexpected exception type {type(e).__name__}: {e}")

        await ext_task

    finally:
        proc.terminate()
        proc.wait(timeout=5)

    print()
    print("=== ISSUE-R2-11 Test Results ===")
    for r in results:
        print(r)
    fails = sum(1 for r in results if r.startswith("FAIL"))
    print(f"\n{len(results)-fails}/{len(results)} passed")
    sys.exit(1 if fails else 0)

asyncio.run(main())
