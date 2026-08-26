#!/usr/bin/env python3
"""Notion FULL-FLOW E2E — one script, zero manual steps.

Assumes ONLY: the daemon is running and the extension is connected to it
(popup → Server Connection → Connect). Everything else is automated:

  1. allocate a fresh email      — rotates the three mail domains:
                                   v3-mail / v4-mail (native worker routes,
                                   any local part) and the apex domain
                                   (fresh ImprovMX alias, dual-delivered into
                                   the v3 worker). No signup cooldown: every
                                   run gets a brand-new address.
  2. preflight                   — daemon health + extension connected.
  3. SIGNUP (extension)          — macro.run notion/signup-rest over the
                                   daemon WS: pure REST auth (getLoginOptions
                                   → sendTemporaryPassword → code via the mail
                                   worker Bearer API → loginWithEmail) on the
                                   user's residential IP. Zero clicks.
          OR (--signup-route warm) — ONE warm Zenrows Browser Session
                                   (scripts/notion_signup_warm.js over CDP):
                                   the whole auth flow runs inside a single
                                   remote Chrome with ONE session-pinned
                                   residential IP, which satisfies Notion's
                                   csrfState IP-binding (the Fetch-API route
                                   422s because it rotates IPs per call).
                                   No daemon, no extension, no user.
  4. CREDS over WS               — tokenV2 (JWT) / userId / deviceId /
                                   clientVersion straight from the macro
                                   result — the WS handoff (no Turso needed).
  5. TAIL (backend, no browser)  — resume → workspace → onboarding →
                                   biz trial (Zenrows) → API key (public-API
                                   verified) → chat (runInferenceTranscript
                                   streaming; the reply text is extracted
                                   from the API response itself).
  6. WORKSPACES 2..N             — each additional workspace: create +
                                   activate → its own biz trial → its own
                                   API key → its own chat (distinct prompt,
                                   reply from the API stream).
  7. verdict + session file      — every critical artifact (email, JWT,
                                   device id, workspaces, trials, API keys,
                                   chats with replies) persisted atomically
                                   to backend/sessions/<email>.json.

Usage:
  python3 backend/notion_e2e.py                          # fresh email, 2 workspaces
  python3 backend/notion_e2e.py --workspaces 3
  python3 backend/notion_e2e.py --email-domain v4        # force a domain
  python3 backend/notion_e2e.py --email foo@v3-mail.priv.email
  python3 backend/notion_e2e.py --probe-via-zenros       # pre-flight: probe
                                                         # getLoginOptions via
                                                         # Zenros until PASS,
                                                         # saves code-email
                                                         # reputation cost
  python3 backend/notion_e2e.py --signup-route warm     # sandbox-only signup:
                                                         # warm Zenrows browser
                                                         # session (no daemon,
                                                         # no extension)
  python3 backend/notion_e2e.py --no-signup --session backend/sessions/x.json
                                                         # idempotent re-run
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "scripts"))  # for notion_signup_zenrows
import notion_tail as nt  # noqa: E402
import notion_signup_zenrows as zsu  # noqa: E402

DAEMON = os.environ.get("BRIDGE_URL", "http://127.0.0.1:3000")
MACRO_PATH = os.path.join(HERE, "..", "extension", "macros", "notion",
                          "signup-rest.json")
STATE_PATH = os.path.join(HERE, "e2e_state.json")
SESSIONS_DIR = os.path.join(HERE, "sessions")
REDIRECT_URL = "/p/3c7e9d22c27d805f8768dc3399e67455"

# The mail domains (operator's own infrastructure):
#   v3-mail — CF Email Routing with a CATCH-ALL → worker → D1; ANY local
#             part works (live-proven: e2e-*@v3-mail signup code arrived).
#   apex    — ImprovMX; only NAMED aliases dual-deliver into the v3 worker
#             (catch-all goes to Hotmail only!), so a fresh alias is created
#             per run via the ImprovMX API (live-proven via noreply@ etc.).
#   v4-mail — NO catch-all (live finding 2026-08-25: only the routed
#             addresses test@/admin@ deliver; arbitrary local parts go
#             NOWHERE — Notion's code email never arrives and the signup
#             macro dies at the mail-poll step). NOT in the default
#             rotation for that reason; usable via --email <routed addr>.
MAIL_DOMAINS = {
    "v3": {"domain": "v3-mail.priv.email",
           "worker": "https://v3-mail.priv.email",
           "token": "Bearer a2df50bf1d1310903061cdd569b6a20a62717998dcfe52bf"},
    "v4": {"domain": "v4-mail.priv.email",
           "worker": "https://v4-mail.priv.email",
           "token": "Bearer e346edb6a4d28c2a488c03fbd85d15ad7c6bf53c55799369"},
    "apex": {"domain": "priv.email",
             "worker": "https://v3-mail.priv.email",
             "token": "Bearer a2df50bf1d1310903061cdd569b6a20a62717998dcfe52bf"},
}
IMX_API = "https://api.improvmx.com/v3"
IMX_KEY = "sk_691ff26633c94b0d80523433afe3a369"
IMX_FORWARD = "ansgareutychis@hotmail.com,admin@v3-mail.priv.email"
ROTATION = ["v3", "apex"]   # v4 excluded: no catch-all (see MAIL_DOMAINS)

RUNNERS = {"resume": nt.step_resume, "workspace": nt.step_workspace,
           "onboarding": nt.step_onboarding, "trial": nt.step_trial,
           "apikey": nt.step_apikey, "chat": nt.step_chat}


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def http_json(url: str, *, method: str = "GET", body: dict | None = None,
              headers: dict | None = None, timeout: float = 30) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    h = {"Content-Type": "application/json",
         "User-Agent": "onboard-automation-e2e/1.0"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


# ---------------------------------------------------------------------------
# email allocation — the three-domain rotation
# ---------------------------------------------------------------------------
def load_state() -> dict:
    try:
        with open(STATE_PATH) as f:
            return json.load(f)
    except Exception:                                   # noqa: BLE001
        return {"lastDomainIdx": -1, "runs": []}


def save_state(st: dict) -> None:
    tmp = STATE_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(st, f, indent=1)
    os.replace(tmp, STATE_PATH)


def create_apex_alias(local: str) -> None:
    """Fresh named apex alias via ImprovMX — dual-delivers into the v3 worker.

    ImprovMX v3 API: POST /domains/{domain}/aliases with
    {"alias": local, "forward": "..."} (live-verified 2026-08-25; the
    PUT /aliases/{name} path 404s — that's for updates by numeric id).
    """
    url = f"{IMX_API}/domains/priv.email/aliases"
    auth = base64.b64encode(f"api:{IMX_KEY}".encode()).decode()
    http_json(url, method="POST", body={"alias": local, "forward": IMX_FORWARD},
              headers={"Authorization": f"Basic {auth}"}, timeout=30)
    log(f"  apex alias created: {local}@priv.email → {IMX_FORWARD}")


def allocate_email(domain: str) -> tuple[str, str, str, str]:
    """Returns (email, mailWorkerUrl, mailBearerToken, domainUsed)."""
    local = f"e2e-{int(time.time())}-{secrets.token_hex(3)}"
    if domain == "apex":
        create_apex_alias(local)
        cfg = MAIL_DOMAINS["apex"]
        email = f"{local}@{cfg['domain']}"
    else:
        cfg = MAIL_DOMAINS[domain]
        email = f"{local}@{cfg['domain']}"
    mail_url = (f"{cfg['worker']}/emails?address="
                f"{urllib.parse.quote(email)}&limit=10&include_body=true")
    return email, mail_url, cfg["token"], domain


# ---------------------------------------------------------------------------
# daemon / extension
# ---------------------------------------------------------------------------
def preflight() -> dict:
    health = http_json(f"{DAEMON}/health", timeout=10)
    if not health.get("ok"):
        sys.exit(f"daemon not healthy: {health}")
    info = health.get("extension_info") or {}
    if not health.get("extension_connected"):
        sys.exit("extension NOT connected to the daemon — open the extension "
                 "popup and Connect, then re-run.")
    log(f"preflight OK — daemon up ({health.get('uptime_seconds', 0):.0f}s), "
        f"extension {info.get('agentId', '?')} connected "
        f"(commands received: {health.get('commands_received', 0)})")
    return health


def daemon_cmd(command: dict, timeout: float = 330) -> dict:
    command = dict(command)
    command.setdefault("timeout", timeout - 30)   # extension-side timeout
    body = json.dumps(command).encode()
    req = urllib.request.Request(f"{DAEMON}/api/command", data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def run_signup(email: str, mail_url: str, mail_token: str) -> dict:
    """macro.run notion/signup-rest in the user's browser via the daemon WS."""
    with open(MACRO_PATH) as f:
        macro = json.load(f)
    inputs = {"email": email, "emailWorkerUrl": mail_url,
              "emailWorkerToken": mail_token, "redirectURL": REDIRECT_URL}
    log(f"signup: macro.run notion/signup-rest via daemon — {email}")
    t0 = time.time()
    res = daemon_cmd({"type": "macro.run", "macro": macro, "inputs": inputs})
    dt = time.time() - t0

    res = res if isinstance(res, dict) else {}
    steps = res.get("steps") or []
    ok_steps = [s for s in steps if s.get("ok")]
    log(f"signup returned in {dt:.1f}s — steps ok {len(ok_steps)}/{len(steps)}"
        f" | macro ok: {res.get('ok')}")
    for s in steps:
        if not s.get("ok"):
            log(f"  FAILED STEP {s.get('id')}: {json.dumps(s)[:300]}")

    results = res.get("results") or {}
    creds = {}
    for sid, keys in (("extract-creds", ("userId", "tokenV2", "deviceId")),
                      ("parse-login", ("isNewSignup",)),
                      ("get-version", ("version",)),
                      ("gen-ids", ("deviceId",))):
        d = results.get(sid) or {}
        if isinstance(d, dict):
            for k in keys:
                if d.get(k) and k not in creds:
                    creds[k] = d[k]
    creds["email"] = email
    if creds.get("version"):
        creds["clientVersion"] = creds.pop("version")
    return creds


def run_signup_warm(email: str | None, country: str = "us",
                    attempts: int = 5) -> dict:
    """Signup via ONE warm Zenrows Browser Session (sandbox-only route).

    Shells out to scripts/notion_signup_warm.js: connects Playwright over
    CDP to wss://browser.zenrows.com (a persistent remote Chrome with ONE
    session-pinned residential IP), drives getLoginOptions →
    sendTemporaryPassword → (polls v3-mail for the code itself) →
    loginWithEmail as same-origin in-page fetches, then extracts the
    HttpOnly cookies (token_v2 & co.) via CDP. The single IP for the whole
    flow satisfies Notion's csrfState IP-binding — the thing the Fetch-API
    route cannot do (it rotates IPs per call → loginWithEmail 422s).

    The driver handles email allocation (fresh @v3-mail.priv.email) and
    captcha rotation internally; pass email=None to let it allocate.
    Returns the creds dict (email, userId, deviceId, tokenV2,
    clientVersion, isNewSignup).
    """
    script = os.path.join(HERE, "..", "scripts", "notion_signup_warm.js")
    out = f"/tmp/warm_signup_creds_{os.getpid()}_{int(time.time())}.json"
    cmd = ["node", script, "--attempts", str(attempts),
           "--country", country, "--out", out]
    if email:
        cmd += ["--email", email]
    env = dict(os.environ)
    env.setdefault("NODE_PATH", "/home/z/.npm-global/lib/node_modules")
    log(f"signup: warm Zenrows browser session — {os.path.basename(script)} "
        f"(attempts={attempts}, country={country}, email={email or 'auto'})")
    t0 = time.time()
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=900,
                       env=env)
    dt = time.time() - t0
    lines = (p.stdout or "").strip().splitlines()
    for ln in lines[-8:]:
        log(f"  warm| {ln}")
    if p.returncode != 0 or not os.path.exists(out):
        sys.exit(f"warm signup failed (rc={p.returncode}) after {dt:.0f}s. "
                 f"Driver output (last 30 lines):\n"
                 + "\n".join(lines[-30:]))
    with open(out) as f:
        creds = json.load(f)
    try:
        os.unlink(out)
    except OSError:
        pass
    log(f"warm signup done in {dt:.1f}s — "
        f"userId={str(creds.get('userId'))[:8]}…, "
        f"isNewSignup={creds.get('isNewSignup')}, "
        f"tokenV2={len(creds.get('tokenV2') or '')} chars")
    return creds


def probe_via_zenros(email: str, max_retries: int = 5,
                    proxy_country: str = "us") -> tuple[str, dict]:
    """Pre-flight probe: getLoginOptions via Zenros until PASS (no captcha).

    Saves code-email reputation cost: if we know in advance that an email
    will get captcha from a residential IP, we don't even try the extension
    macro (which would send a real code email and waste reputation).

    Returns (email_to_use, probe_result_dict). If email_to_use == email,
    the original probe passed. If email_to_use differs, we rotated to a
    passing email. If email_to_use is empty, all retries failed.
    """
    log(f"probing getLoginOptions via Zenros premium_proxy={proxy_country} "
        f"(up to {max_retries} retries) — saves code-email reputation cost")
    current_email = email
    for attempt in range(1, max_retries + 1):
        try:
            ok, parsed, raw = zsu.probe_get_login_options(
                current_email, use_proxy=True, proxy_country=proxy_country)
        except Exception as e:                                # noqa: BLE001
            log(f"  probe attempt {attempt}/{max_retries}: EXC {e}")
            current_email = f"e2e-{int(time.time())}-{secrets.token_hex(3)}@v3-mail.priv.email"
            log(f"  rotating to {current_email}")
            time.sleep(5)
            continue
        if ok:
            log(f"  probe attempt {attempt}/{max_retries}: PASS — "
                f"loginOptionsToken acquired for {current_email}")
            return current_email, {"ok": True, "attempts": attempt,
                                   "email": current_email,
                                   "loginOptionsToken": parsed.get("loginOptionsToken", "")[:30] + "..."}
        challenge = parsed.get("challengeProvider") or "no_token"
        log(f"  probe attempt {attempt}/{max_retries}: captcha ({challenge}) — "
            f"rotating to fresh email")
        current_email = f"e2e-{int(time.time())}-{secrets.token_hex(3)}@v3-mail.priv.email"
        log(f"  new email: {current_email}")
        time.sleep(5)  # pace to avoid rate limit
    return "", {"ok": False, "attempts": max_retries,
                "last_email": current_email}


# ---------------------------------------------------------------------------
# tail (backend steps) — notion_tail functions, orchestrated in-process
# ---------------------------------------------------------------------------
class TailArgs:
    """The argparse-namespace fields the notion_tail step functions read."""

    def __init__(self, prompt: str, workspace_name: str = "Onboard Workspace"):
        self.prompt = prompt
        self.workspace_name = workspace_name
        self.workspace_icon = "🚀"
        self.new_workspace = False
        self.activate = False
        self.trial_days = 14
        self.api_key_name = "automation-pat"
        self.api_key_expiration = "1_year"


def run_step(R, sess: dict, name: str, route: str, zkey: str,
             targs: TailArgs, session_path: str) -> dict:
    log(f"tail step: {name}"
        + (f" (workspace: {targs.workspace_name})" if name == "workspace" else "")
        + (f" (prompt: {targs.prompt[:40]}…)" if name == "chat" else ""))
    try:
        res = RUNNERS[name](R, sess, route, zkey, targs)
    except R.NotionAuthError as e:
        log(f"  AUTH DEAD: {str(e)[:140]}")
        res = {"error": f"auth dead: {str(e)[:140]}"}
    except Exception as e:                                # noqa: BLE001
        log(f"  FAILED: {type(e).__name__}: {str(e)[:160]}")
        res = {"error": f"{type(e).__name__}: {str(e)[:160]}"}
    nt.save_session(session_path, sess)     # atomic, after every step
    log("  " + json.dumps(res, ensure_ascii=False, default=str)[:360])
    return res


def run_tail(R, sess: dict, session_path: str, route: str, zkey: str,
             workspaces: int, base_prompt: str) -> list[tuple[str, dict]]:
    """Full backend tail. Returns [(step-label, result)] for the verdict."""
    outcomes: list[tuple[str, dict]] = []

    # -- first workspace: resume → workspace → onboarding → trial → apikey → chat
    targs = TailArgs(base_prompt, "Onboard Workspace")
    for st in ("resume", "workspace", "onboarding", "trial", "apikey", "chat"):
        outcomes.append((f"ws1:{st}", run_step(R, sess, st, route, zkey,
                                               targs, session_path)))

    # -- additional workspaces: create + ACTIVATE (or reuse on re-runs) →
    #    trial → apikey → chat. Idempotent: a space with the same name in
    #    spaces[] is re-activated instead of re-created.
    for i in range(2, workspaces + 1):
        name = f"Onboard Workspace {i}"
        targs = TailArgs(f"What is {i}+{i}? Answer with just the number.", name)
        targs.api_key_name = f"automation-pat-ws{i}"
        existing = next((s for s in (sess.get("spaces") or [])
                         if s.get("name") == name), None)
        if existing:
            sess["space"] = existing
            nt.save_session(session_path, sess)
            log(f"workspace {i}: reusing existing space {name} "
                f"[{existing.get('id', '')[:8]}…]")
            outcomes.append((f"ws{i}:workspace", {"reused": existing["id"]}))
        else:
            targs.new_workspace = True
            targs.activate = True
            outcomes.append((f"ws{i}:workspace",
                             run_step(R, sess, "workspace", route, zkey,
                                      targs, session_path)))
        for st in ("trial", "apikey", "chat"):
            if st == "trial" and i > 2:
                # pacing: updateSubscription rate-limits (429) when several
                # trials fire in quick succession on one account
                log("pacing 15s before next trial activation…")
                time.sleep(15)
            outcomes.append((f"ws{i}:{st}", run_step(R, sess, st, route, zkey,
                                                     targs, session_path)))
    return outcomes


# ---------------------------------------------------------------------------
# verdict / report
# ---------------------------------------------------------------------------
def verdict(sess: dict, outcomes: list[tuple[str, dict]]) -> tuple[bool, list]:
    problems = []
    if not (sess.get("tokenV2") and sess.get("userId") and sess.get("deviceId")):
        problems.append("creds incomplete (tokenV2/userId/deviceId)")
    spaces = sess.get("spaces") or []
    if not spaces:
        problems.append("no workspaces created")
    trials = sess.get("trials") or {}
    keys = sess.get("apiKeys") or {}
    chats = sess.get("chats") or []
    for sp in spaces:
        sid = sp.get("id", "?")
        label = f"{sp.get('name', sid[:8])}"
        t = trials.get(sid)
        if not t or not (t.get("status") == "trialing"
                         or t.get("tier") in ("business", "enterprise")
                         or t.get("type") == "subscribed_admin"):
            problems.append(f"{label}: biz trial NOT active ({json.dumps(t)[:80] if t else 'no record'})")
        k = keys.get(sid)
        if not (k or {}).get("token"):
            problems.append(f"{label}: no API key")
        ws_chats = [c for c in chats if c.get("spaceId") == sid]
        good = [c for c in ws_chats if c.get("reply")]
        if not good:
            problems.append(f"{label}: no chat reply captured")
        for c in ws_chats:
            # outcome may be a str (legacy) or a dict (current chat step
            # shape: {"inference_id":…, "status":"completed", …}) — coerce
            outcome_raw = c.get("outcome")
            if isinstance(outcome_raw, str):
                outcome_str = outcome_raw
            elif outcome_raw:
                outcome_str = json.dumps(outcome_raw, default=str)
            else:
                outcome_str = "none"
            if "completed" not in outcome_str:
                problems.append(f"{label}: chat outcome not completed "
                                f"({outcome_str[:60]})")
    for label, res in outcomes:
        if isinstance(res, dict) and res.get("error"):
            problems.append(f"{label}: {res['error'][:100]}")
    return (not problems), problems


def report(sess: dict) -> None:
    def mask(v: str, keep: int = 14) -> str:
        v = str(v or "")
        return v if len(v) <= keep else v[:keep] + f"…({len(v)} chars)"

    print("\n" + "=" * 74)
    print("CAPTURED CRITICAL INFO (all persisted in the session file)")
    print("=" * 74)
    print(f"  email           : {sess.get('email')}")
    print(f"  userId          : {sess.get('userId')}")
    print(f"  deviceId        : {sess.get('deviceId')}")
    print(f"  tokenV2 (JWT)   : {mask(sess.get('tokenV2'))}")
    print(f"  clientVersion   : {sess.get('clientVersion')}")
    print(f"  onboarding      : completed={sess.get('onboardingCompleted')}")
    for i, sp in enumerate(sess.get("spaces") or [], 1):
        sid = sp.get("id", "")
        t = (sess.get("trials") or {}).get(sid) or {}
        k = (sess.get("apiKeys") or {}).get(sid) or {}
        print(f"\n  workspace #{i}    : {sp.get('name')}  "
              f"[{sid[:8]}… view={str(sp.get('viewId'))[:8]}…]")
        print(f"    biz trial    : {t.get('status') or t.get('tier') or '—'}"
              f"{' via ' + t.get('route', '') if t.get('route') else ''}"
              f"  end={t.get('trialEnd', '—')}")
        print(f"    api key      : {mask(k.get('token'))}"
              f"  verified={bool(k.get('token'))}"
              f"  bot={str(k.get('botId'))[:8]}…")
        for c in [c for c in (sess.get("chats") or [])
                  if c.get("spaceId") == sid]:
            print(f"    chat         : “{c.get('prompt', '')[:48]}”")
            print(f"      → reply    : “{(c.get('reply') or '')[:80]}”")
            outcome_raw = c.get("outcome")
            outcome_str = (outcome_raw if isinstance(outcome_raw, str)
                           else json.dumps(outcome_raw, default=str)
                           if outcome_raw else "")
            print(f"      outcome    : {outcome_str[:90]}")


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
def main() -> None:
    p = argparse.ArgumentParser(description="Notion full-flow E2E — "
                                            "one script, everything done.")
    p.add_argument("--email", help="explicit email (skips allocation)")
    p.add_argument("--email-domain", choices=(*ROTATION, "auto"),
                   default="auto",
                   help="which mail domain to allocate on (default: rotate)")
    p.add_argument("--workspaces", type=int, default=2,
                   help="workspaces to create+provision (trial+apikey+chat "
                        "each); default 2")
    p.add_argument("--no-signup", action="store_true",
                   help="skip signup; just run the tail on --session")
    p.add_argument("--session", help="session file path "
                                     "(default: sessions/<email-local>.json)")
    p.add_argument("--route", choices=("auto", "direct", "zenrows"),
                   default="auto")
    p.add_argument("--zenrows-key", default=os.environ.get(
        "ZENROWS_API_KEY", nt.ZENROWS_KEY_DEFAULT))
    p.add_argument("--signup-route", choices=("extension", "warm"),
                   default="extension",
                   help="signup driver: 'extension' (daemon WS macro.run, "
                        "default — needs the user's browser connected) or "
                        "'warm' (sandbox-only: ONE Zenrows Browser Session "
                        "keeps a single residential IP across the whole auth "
                        "flow — no daemon, no extension, no user)")
    p.add_argument("--warm-attempts", type=int, default=5,
                   help="max captcha-retry attempts for the warm signup "
                        "route (default 5; ~30-50%% per-attempt pass rate "
                        "on fresh v3-mail emails)")
    p.add_argument("--warm-country", default="us",
                   help="Zenrows Browser Session proxy_country for the warm "
                        "signup route (default us)")
    p.add_argument("--probe-via-zenros", action="store_true",
                   help="pre-flight: probe getLoginOptions via Zenros "
                        "premium_proxy=us before triggering the extension "
                        "macro. Saves code-email reputation cost on "
                        "captcha-gated emails (rotates to a passing email "
                        "instead of sending a real code email that will "
                        "fail). ~5 Zenros credits per probe attempt.")
    p.add_argument("--probe-retries", type=int, default=5,
                   help="max getLoginOptions probe retries via Zenros "
                        "(default 5, ~90%% success rate given ~30%% per-attempt "
                        "pass rate). Only used with --probe-via-zenros.")
    p.add_argument("--probe-country", default="us",
                   help="Zenros premium_proxy country for the pre-flight probe")
    p.add_argument("--notion-ref", default=nt.NOTION_REF_DEFAULT)
    p.add_argument("--prompt", default="What is 2+2? Answer with just the number.")
    args = p.parse_args()

    t_start = time.time()
    os.makedirs(SESSIONS_DIR, exist_ok=True)
    st = load_state()

    # ---- 1. email allocation -------------------------------------------
    if args.no_signup:
        if not args.session or not os.path.exists(args.session):
            sys.exit("--no-signup needs an existing --session file")
        sess = nt.load_session(args.session)
        session_path = args.session
        email = sess.get("email", "?")
        log(f"tail-only run on existing session {session_path} ({email})")
    else:
        if args.signup_route == "warm":
            # ---- WARM ROUTE: sandbox-only signup, no daemon/extension -----
            # The Node driver allocates a fresh @v3-mail.priv.email (unless
            # --email was given), probes/rotates on captcha internally, polls
            # the mail worker itself, and completes loginWithEmail inside one
            # warm browser session (single residential IP).
            creds = run_signup_warm(args.email, args.warm_country,
                                    args.warm_attempts)
            missing = [k for k in ("tokenV2", "userId", "deviceId")
                       if not creds.get(k)]
            if missing:
                print(json.dumps(creds, indent=1)[:800])
                sys.exit(f"warm signup did not yield {missing} — aborting")
            email = creds.get("email") or args.email or "unknown"
            domain = "v3"
            log(f"warm signup complete — {email}")

            session_path = args.session or os.path.join(
                SESSIONS_DIR, re.sub(r"[^a-z0-9@._-]", "_",
                                     email.split("@")[0]) + ".json")
            sess = {
                "email": email, "userId": creds["userId"],
                "deviceId": creds["deviceId"], "tokenV2": creds["tokenV2"],
                "clientVersion": creds.get("clientVersion")
                or nt.CLIENT_VERSION_FALLBACK,
                "credsSource": "zenrows-warm-session",
                "createdAt": time.time(),
                "space": {}, "spaces": [], "chats": [],
            }
            nt.save_session(session_path, sess)
            log(f"session initialised -> {session_path}")
        else:
            preflight()
            if args.email:
                email = args.email
                if email.endswith("@priv.email"):
                    domain = "apex"
                elif "@v4-mail." in email:
                    domain = "v4"
                else:
                    domain = "v3"
                cfg = MAIL_DOMAINS[domain]
                mail_url = (f"{cfg['worker']}/emails?address="
                            f"{urllib.parse.quote(email)}&limit=10&include_body=true")
                mail_token = cfg["token"]
            else:
                domain = args.email_domain
                if domain == "auto":
                    idx = (st.get("lastDomainIdx", -1) + 1) % len(ROTATION)
                    domain = ROTATION[idx]
                    st["lastDomainIdx"] = idx
                elif domain == "v4":
                    log("WARNING: v4-mail has NO catch-all — arbitrary local "
                        "parts never receive mail; only routed addresses "
                        "(test@/admin@) deliver. Continuing anyway.")
                email, mail_url, mail_token, domain = allocate_email(domain)
            log(f"allocated email: {email}  (domain: {domain})")

            # ---- 1.5. pre-flight probe via Zenros (optional) ---------------
            if args.probe_via_zenros:
                probe_email, probe_res = probe_via_zenros(
                    email, max_retries=args.probe_retries,
                    proxy_country=args.probe_country)
                if not probe_email:
                    sys.exit(f"probe-via-zenros: all {args.probe_retries} attempts "
                             f"hit captcha; aborting to save code-email reputation "
                             f"cost. Last email tried: {probe_res.get('last_email')}. "
                             f"Re-run without --probe-via-zenros to skip the probe "
                             f"(will then send a real code email from the extension).")
                if probe_email != email:
                    # Rotated to a passing email on v3-mail worker subdomain
                    email = probe_email
                    cfg = MAIL_DOMAINS["v3"]
                    mail_url = (f"{cfg['worker']}/emails?address="
                                f"{urllib.parse.quote(email, safe='@')}"
                                f"&limit=10&include_body=true")
                    mail_token = cfg["token"]
                    domain = "v3"
                    log(f"probe passed on rotated email: {email}")
                else:
                    log(f"probe passed on first email: {email}")

            # ---- 2-4. signup via extension, creds over WS -------------------
            creds = run_signup(email, mail_url, mail_token)
            missing = [k for k in ("tokenV2", "userId", "deviceId") if not creds.get(k)]
            if missing:
                print(json.dumps(creds, indent=1)[:800])
                sys.exit(f"signup did not yield {missing} — aborting "
                         f"(macro result above)")
            log(f"creds over WS: tokenV2={len(creds['tokenV2'])} chars, "
                f"userId={creds['userId'][:8]}…, isNewSignup={creds.get('isNewSignup')}")

            session_path = args.session or os.path.join(
                SESSIONS_DIR, re.sub(r"[^a-z0-9@._-]", "_", email.split("@")[0])
                + ".json")
            sess = {
                "email": email, "userId": creds["userId"],
                "deviceId": creds["deviceId"], "tokenV2": creds["tokenV2"],
                "clientVersion": creds.get("clientVersion")
                or nt.CLIENT_VERSION_FALLBACK,
                "credsSource": "daemon-ws", "createdAt": time.time(),
                "space": {}, "spaces": [], "chats": [],
            }
            nt.save_session(session_path, sess)
            log(f"session initialised -> {session_path}")

    # ---- 5-6. backend tail ----------------------------------------------
    log("loading notion-ref and running the backend tail "
        f"({args.workspaces} workspace(s), route={args.route})…")
    R = nt.load_ref(args.notion_ref)
    outcomes = run_tail(R, sess, session_path, args.route,
                        args.zenrows_key, args.workspaces, args.prompt)

    # ---- 7. verdict + report --------------------------------------------
    ok, problems = verdict(sess, outcomes)
    report(sess)
    print("\n" + "=" * 74)
    if ok:
        print(f"VERDICT: PASS — full E2E flow complete in "
              f"{time.time() - t_start:.0f}s "
              f"({len(sess.get('spaces') or [])} workspace(s) provisioned)")
    else:
        print("VERDICT: FAIL — problems:")
        for pr in problems:
            print(f"  - {pr}")

    if not args.no_signup:
        st.setdefault("runs", []).append({
            "ts": time.time(), "email": email, "domain": domain,
            "ok": ok, "session": session_path,
            "workspaces": len(sess.get("spaces") or [])})
        save_state(st)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
