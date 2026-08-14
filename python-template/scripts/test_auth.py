#!/usr/bin/env python3
"""Test that the daemon's auth middleware works correctly."""
import subprocess
import time
import sys
import urllib.request
import urllib.error
import json

PORT = 18788
TOKEN = "secret123"

# Start daemon
proc = subprocess.Popen(
    [sys.executable, "scripts/run_bridge.py", "--host", "127.0.0.1",
     "--port", str(PORT), "--auth-token", TOKEN, "--log-level", "ERROR"],
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
)
time.sleep(1.5)

results = []
def check(name, url, expected_status, headers=None, method="GET", data=None):
    try:
        req = urllib.request.Request(url, headers=headers or {}, method=method, data=data)
        with urllib.request.urlopen(req, timeout=3) as resp:
            actual = resp.status
    except urllib.error.HTTPError as e:
        actual = e.code
    except Exception as e:
        results.append(f"FAIL  {name}: exception {e}")
        return
    ok = "OK  " if actual == expected_status else "FAIL"
    results.append(f"{ok} {name}: got {actual}, expected {expected_status}")

try:
    check("health (no auth, public)", f"http://127.0.0.1:{PORT}/health", 200)
    check("extensions (no auth)", f"http://127.0.0.1:{PORT}/api/extensions", 401)
    check("extensions (wrong token)", f"http://127.0.0.1:{PORT}/api/extensions", 401, {"Authorization": "Bearer wrong"})
    check("extensions (correct token)", f"http://127.0.0.1:{PORT}/api/extensions", 200, {"Authorization": f"Bearer {TOKEN}"})
    check("command (no auth)", f"http://127.0.0.1:{PORT}/api/command", 401, method="POST",
          data=json.dumps({"cmd": {"type": "tabs.list", "id": "x"}}).encode())
    check("command (auth, no extension → 503)", f"http://127.0.0.1:{PORT}/api/command", 503,
          headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
          method="POST", data=json.dumps({"cmd": {"type": "tabs.list", "id": "x"}}).encode())

    # Queue cap test — send 5, all should succeed (cap is 1000)
    for i in range(5):
        check(f"send-http #{i+1} (auth)", f"http://127.0.0.1:{PORT}/api/send-http", 200,
              headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
              method="POST", data=json.dumps({"cmd": {"type": "ping"}}).encode())

    # Refuse external bind without token
    print("--- Refusing external bind without token ---")
    ext_proc = subprocess.run(
        [sys.executable, "scripts/run_bridge.py", "--host", "0.0.0.0", "--port", "18789", "--log-level", "ERROR"],
        capture_output=True, text=True, timeout=3,
    )
    if ext_proc.returncode != 0 and "REFUSING" in ext_proc.stderr:
        results.append("OK   refuse-external-bind: exited with error")
    else:
        results.append(f"FAIL refuse-external-bind: rc={ext_proc.returncode}, stderr={ext_proc.stderr[:200]}")

finally:
    proc.terminate()
    proc.wait(timeout=5)

print()
print("=== Results ===")
for r in results:
    print(r)
fails = sum(1 for r in results if r.startswith("FAIL"))
print(f"\n{len(results)-fails}/{len(results)} passed")
sys.exit(1 if fails else 0)
