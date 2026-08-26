#!/usr/bin/env python3
"""LIVE E2E #1: fresh signup via signup-rest on v0.9.5 SW (noreply@priv.email).

Fresh named alias => brand-new Notion account => isNewSignup:true => we get
to verify the post-login onboarding TAIL against a real wizard state.

Saves {token_v2, userId, deviceId, clientVersion} to /tmp/fresh_creds.json
for the tail-discovery phase (reference library drives createSpace etc.).
"""
import json, time, urllib.request, sys

DAEMON = "http://127.0.0.1:3000"
MACRO_PATH = "/home/z/my-project/onboard-automation-common/extension/macros/notion/signup-rest.json"
TOKEN = "Bearer a2df50bf1d1310903061cdd569b6a20a62717998dcfe52bf"
EMAIL = sys.argv[1] if len(sys.argv) > 1 else "noreply@priv.email"

def cmd(command, timeout=280):
    body = json.dumps(command).encode()
    req = urllib.request.Request(f"{DAEMON}/api/command", data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)

def main():
    macro = json.load(open(MACRO_PATH))
    inputs = {
        "email": EMAIL,
        "emailWorkerUrl": f"https://v3-mail.priv.email/emails?address={EMAIL}&limit=10&include_body=true",
        "emailWorkerToken": TOKEN,
        "redirectURL": "/p/3c7e9d22c27d805f8768dc3399e67455",
    }
    print(f"[{time.strftime('%H:%M:%S')}] LIVE signup-rest via daemon — fresh alias {EMAIL}")
    t0 = time.time()
    r = cmd({"type": "macro.run", "macro": macro, "inputs": inputs, "timeout": 280})
    dt = time.time() - t0

    res = r if isinstance(r, dict) else {}
    steps = res.get("steps") or []
    ok_steps = [s for s in steps if s.get("ok")]
    print(f"=== macro.run returned in {dt:.1f}s — steps ok {len(ok_steps)}/{len(steps)} ===")
    print("top-level ok:", res.get("ok"), "| error:", res.get("error"))

    results = res.get("results", {})
    creds = {}
    def grab(step_id, keys):
        d = results.get(step_id) or {}
        if isinstance(d, dict):
            for k in keys:
                if d.get(k) is not None:
                    creds[k] = d[k]
    grab("gen-ids", ["deviceId", "ts"])
    grab("get-version", ["version"])
    grab("parse-login", ["userId", "isNewSignup"])
    grab("extract-creds", ["userId", "tokenV2", "token_v2"])

    # dump failed steps for debugging
    for s in steps:
        if not s.get("ok"):
            print("FAILED STEP:", json.dumps(s)[:500])

    print("\ncreds captured:", json.dumps({k: (str(v)[:28] + "..." if k == "tokenV2" and v else v) for k, v in creds.items()}, indent=1))
    if creds.get("tokenV2") or creds.get("token_v2"):
        with open("/tmp/fresh_creds.json", "w") as f:
            json.dump({**creds, "email": EMAIL, "ts": time.time()}, f, indent=1)
        print("saved -> /tmp/fresh_creds.json")
        print("VERDICT: PASS — fresh signup E2E complete on v0.9.5")
    else:
        print("VERDICT: FAIL — no token_v2 captured")
        print(json.dumps(res, indent=1)[:3000])

if __name__ == "__main__":
    main()
