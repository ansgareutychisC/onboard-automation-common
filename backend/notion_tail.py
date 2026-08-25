#!/usr/bin/env python3
"""Notion post-signup tail — resume a saved session, finish every goal.

THE DREAM (operator's words): "sign up once through the extension, save all
the credentials, then resume those sessions instantly at the backend" — no
browser, no re-login, no cookie resets.

Session file (JSON, one per account) — bootstrapped by --init-from-creds,
rewritten ATOMICALLY after every step so a crashed run resumes cleanly:

    {
      "email": ..., "userId": ..., "deviceId": ..., "tokenV2": ...,
      "clientVersion": "23.13.20260824.2240",
      "space":  {"id":..., "viewId":..., "name":..., "icon":...},
      "spaces": [ ...additional spaces, if any... ],
      "onboardingCompleted": true,
      "trial":  {"status":"trialing", "tier":"business", ...},
      "apiKey": {"token":"ntn_...", "botId":..., "expiresAt":...},
      "chats":  [{"threadId":..., "prompt":..., "reply":..., "ts":...}]
    }

Steps (all idempotent — each one skips work that is already done):
    resume      getSpaces — validates token_v2, (re)discovers space/view ids
    workspace   createSpace + space_view + icon (skips if a space exists;
                --new-workspace force-creates an additional one)
    onboarding  finish_onboarding_screens (skips if onboarding_completed)
    trial       updateSubscription — the critical unblocker. From a
                datacenter IP this 400s with UserValidationError "Trial
                activation is not allowed"; through Zenrows (clean IP) it
                returns 200 with captchaToken:"" — the captcha is
                IP-reputation-gated and never actually validated on a
                clean IP. Auto mode tries direct, falls back to Zenrows.
    apikey      PAT flow: getPersonalAccessTokenCapabilityOptions →
                createDeveloperPersonalIntegration → getBotToken → verify
                against the PUBLIC api.notion.com/v1. Works DIRECT (no IP
                gate on this one).
    chat        runInferenceTranscript with the LIVE transcript shape
                [config, context, user] (the ref's stale 4-item shape dies
                at step_count:0). Streams NDJSON, extracts the reply text.

Routing (--route):
    auto      direct first; on IP-reputation blocks (400 UserValidationError /
              "... not allowed", 403) the SAME call is retried through Zenrows
    direct    sandbox → app.notion.com only (trial WILL fail from datacenter IPs)
    zenrows   everything through api.zenrows.com. 2026 API shape:
              custom_headers is a BOOLEAN — headers ride on the request to
              api.zenrows.com itself and are forwarded to the target.

Transport trick: ZenrowsSession duck-types requests.Session, so the ENTIRE
notion-ref library (create_space, save_transactions, onboarding automation,
api_token, ...) runs through Zenrows with zero changes to that repo.

Requires: the notion-ref checkout (default /home/z/my-project/notion-ref,
override with --notion-ref or NOTION_REF_PATH).
"""
from __future__ import annotations

import argparse
import json
import os
from json import dumps as _json_dumps
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timedelta

# Committed like the ImprovMX / v3-mail keys before it (operator's policy);
# override with --zenrows-key or ZENROWS_API_KEY.
ZENROWS_KEY_DEFAULT = "0e43f2d6166122fa4b4aa607464f5c7d4d8ce855"
ZENROWS_BASE = "https://api.zenrows.com/v1/"
NOTION_REF_DEFAULT = os.environ.get(
    "NOTION_REF_PATH", "/home/z/my-project/notion-ref")
CLIENT_VERSION_FALLBACK = "23.13.20260824.2240"
CHAT_CONFIG = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                           "notion_chat_config.json")

STEP_ORDER = ("resume", "workspace", "onboarding", "trial", "apikey", "chat")


# --------------------------------------------------------------------------
# Zenrows transport
# --------------------------------------------------------------------------
class _FakeResp:
    """Minimal requests.Response duck-type over a buffered body."""

    def __init__(self, status_code: int, text: str, headers: dict | None):
        self.status_code = status_code
        self.reason = ""
        self.text = text
        self.content = text.encode("utf-8", "replace")
        self.headers = headers or {}
        self._json_cache = None

    def json(self):
        if self._json_cache is None:
            self._json_cache = json.loads(self.text) if self.text.strip() else {}
        return self._json_cache

    def iter_lines(self, decode_unicode: bool = False, **_kw):
        for line in self.text.split("\n"):
            yield line if decode_unicode else line.encode("utf-8")

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}: {self.text[:200]}")


class ZenrowsSession:
    """Duck-types requests.Session — every request is proxied through
    api.zenrows.com with header/cookie forwarding (custom_headers=true).

    NotionAppClient._request() calls
    session.request(method, url, params=, json=, headers=, timeout=, stream=)
    and reads status_code / headers / json() / iter_lines() — all covered.
    """

    def __init__(self, base_headers: dict, cookie: str, api_key: str):
        self.headers = dict(base_headers)   # create_space() writes into this
        self._cookie = cookie
        self._key = api_key

    def request(self, method, url, params=None, json=None, headers=None,
                timeout=None, stream=False, **_kw):
        if params:
            url = url + ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
        h = dict(self.headers)
        if headers:
            h.update(headers)               # per-request Referer / x-notion-space-id
        h["Cookie"] = self._cookie
        # Zenrows forwards the target's compressed body verbatim and urllib
        # does not decompress — always ask the target for plain text.
        h["Accept-Encoding"] = "identity"
        if json is not None:
            h.setdefault("Content-Type", "application/json")
        qs = urllib.parse.urlencode({
            "apikey": self._key, "url": url,
            "original_status": "true",      # propagate the target's real status
            "custom_headers": "true",
        })
        # NB: `json` here is the requests-API kwarg (the body), not the module
        data = _json_dumps(json).encode() if json is not None else None
        req = urllib.request.Request(
            f"{ZENROWS_BASE}?{qs}", data=data, headers=h,
            method=(method or "POST").upper())
        try:
            with urllib.request.urlopen(req, timeout=timeout or 60) as r:
                return _FakeResp(r.status, r.read().decode("utf-8", "replace"),
                                 dict(r.headers))
        except urllib.error.HTTPError as e:
            return _FakeResp(e.code, e.read().decode("utf-8", "replace"),
                             dict(e.headers or {}))
        except Exception as e:                       # noqa: BLE001
            raise ConnectionError(f"zenrows transport error: {e}") from e


# --------------------------------------------------------------------------
# notion-ref loader (path is CLI-configurable, so imports happen here)
# --------------------------------------------------------------------------
class Ref:
    """Namespace for the notion-ref pieces we use."""


def load_ref(path: str) -> Ref:
    if not os.path.isdir(path):
        sys.exit(f"notion-ref checkout not found at {path!r} "
                 f"(use --notion-ref or NOTION_REF_PATH)")
    sys.path.insert(0, path)
    from notion_onboarding import NotionAppClient
    import notion_onboarding.onboarding as OB
    from notion_onboarding.api_token import create_api_key
    from notion_onboarding.exceptions import NotionAPIError, NotionAuthError
    from notion_onboarding.workspace import create_space

    # runInferenceTranscript now returns NDJSON — the ref's non-streaming
    # resp.json() crashes. Patch in OB's OWN namespace (onboarding.py
    # imports the fn directly; patching ai.py does nothing).
    _orig = OB.initiate_onboarding_agent_chat

    def _streaming(*a, **kw):
        kw.setdefault("collect_initial_messages", True)
        kw.setdefault("message_wait_timeout", 8.0)
        return _orig(*a, **kw)

    OB.initiate_onboarding_agent_chat = _streaming

    r = Ref()
    r.NotionAppClient = NotionAppClient
    r.OB = OB
    r.create_space = create_space
    r.create_api_key = create_api_key
    r.NotionAPIError = NotionAPIError
    r.NotionAuthError = NotionAuthError
    return r


# --------------------------------------------------------------------------
# session file handling
# --------------------------------------------------------------------------
def load_session(path: str) -> dict:
    with open(path) as f:
        sess = json.load(f)
    for k in ("tokenV2", "userId", "deviceId"):
        if not sess.get(k):
            sys.exit(f"session file {path} is missing {k!r} — re-init from creds")
    return sess


def save_session(path: str, sess: dict) -> None:
    tmp = f"{path}.tmp"
    with open(tmp, "w") as f:
        json.dump(sess, f, indent=1, sort_keys=True)
    os.replace(tmp, path)


def init_from_creds(creds_path: str, out_path: str) -> dict:
    with open(creds_path) as f:
        creds = json.load(f)
    sess = {
        "email": creds.get("email", ""),
        "userId": creds["userId"],
        "deviceId": creds["deviceId"],
        "tokenV2": creds["tokenV2"],
        "clientVersion": creds.get("clientVersion", CLIENT_VERSION_FALLBACK),
        "createdAt": time.time(),
        "space": {}, "spaces": [], "chats": [],
    }
    save_session(out_path, sess)
    return sess


# --------------------------------------------------------------------------
# routing
# --------------------------------------------------------------------------
def make_client(R: Ref, sess: dict, route: str, zkey: str):
    c = R.NotionAppClient(
        token_v2=sess["tokenV2"], user_id=sess["userId"],
        device_id=sess["deviceId"],
        client_version=sess.get("clientVersion") or CLIENT_VERSION_FALLBACK,
        space_id=(sess.get("space") or {}).get("id") or None,
        timeout=60,
    )
    c._session.headers["notion-audit-log-platform"] = "web"
    if route == "zenrows":
        uid = sess["userId"]
        cookie = (f"token_v2={sess['tokenV2']}; notion_user_id={uid}; "
                  f"notion_users=%5B%22{uid}%22%5D; "
                  f"notion_device_id={sess['deviceId']}")
        c._session = ZenrowsSession(dict(c._session.headers), cookie, zkey)
    return c


def _looks_ip_blocked(e) -> bool:
    msg = str(e)
    status = getattr(e, "status_code", None)
    if status == 403:
        return True
    return status == 400 and ("UserValidationError" in msg or "not allowed" in msg)


def routed(R: Ref, sess: dict, route: str, zkey: str, fn):
    """Run fn(client) with auto Zenrows fallback on IP-reputation blocks.
    Returns (result, route_used)."""
    order = {"auto": ["direct", "zenrows"], "direct": ["direct"],
             "zenrows": ["zenrows"]}[route]
    last = None
    for r in order:
        try:
            return fn(make_client(R, sess, r, zkey)), r
        except R.NotionAPIError as e:
            last = e
            if r == "direct" and "zenrows" in order and _looks_ip_blocked(e):
                print(f"  ! direct blocked ({str(e)[:90]}) — retrying via zenrows")
                continue
            raise
    raise last


# --------------------------------------------------------------------------
# steps
# --------------------------------------------------------------------------
def _record_fields(row: dict) -> dict:
    """getSpaces records nest two levels: row.value.value = actual fields."""
    v = (row or {}).get("value") or {}
    inner = v.get("value") if isinstance(v, dict) else None
    return inner if isinstance(inner, dict) else (v if isinstance(v, dict) else {})


def step_resume(R: Ref, sess: dict, route: str, zkey: str, args) -> dict:
    def fn(c):
        return c.post("/api/v3/getSpaces", body={}, referer="/") or {}
    raw, used = routed(R, sess, route, zkey, fn)
    node = (raw or {}).get(sess["userId"]) or {}
    spaces = {}
    for sid, row in (node.get("space") or {}).items():
        spaces[sid] = _record_fields(row)
    views = {}
    for svid, row in (node.get("space_view") or {}).items():
        f = _record_fields(row)
        if f.get("space_id"):
            views.setdefault(f["space_id"], svid)

    cur = (sess.get("space") or {}).get("id")
    chosen = cur if cur in spaces else (next(iter(spaces)) if spaces else None)
    sess["space"] = sess.get("space") or {}
    if chosen:
        f = spaces[chosen]
        sess["space"].setdefault("id", chosen)
        if chosen in views:
            sess["space"]["viewId"] = views[chosen]
        if f.get("name"):
            sess["space"]["name"] = f["name"]
    blob = json.dumps(raw)
    was = sess.get("onboardingCompleted")
    sess["onboardingCompleted"] = '"onboarding_completed":true' in blob.replace(" ", "")
    return {"route": used, "spaces_found": len(spaces),
            "space": sess["space"],
            "onboardingCompleted": sess["onboardingCompleted"],
            "onboarding_changed": was != sess["onboardingCompleted"]}


def step_workspace(R: Ref, sess: dict, route: str, zkey: str, args) -> dict:
    have = (sess.get("space") or {}).get("id")
    if have and not args.new_workspace:
        return {"skipped": f"space already exists ({have[:8]}…); "
                           f"use --new-workspace to add another"}

    def fn(c):
        return R.create_space(
            c, name=args.workspace_name, icon=args.workspace_icon,
            plan_type="personal", source="handle_root_redirect",
            create_space_view=True, user_id=sess["userId"])
    sp, used = routed(R, sess, route, zkey, fn)
    entry = {"id": sp.space_id, "viewId": sp.space_view_id,
             "name": args.workspace_name, "icon": args.workspace_icon,
             "createdAt": time.time()}
    if have:
        # additional space — the ACTIVE space stays untouched (trial/apikey/
        # chat all target it); record under spaces[] for reference.
        sess.setdefault("spaces", []).append(entry)
    else:
        sess["space"] = entry
        sess.setdefault("spaces", []).append(entry)
    return {"created": entry, "route": used, "active": sess["space"]["id"]}


def step_onboarding(R: Ref, sess: dict, route: str, zkey: str, args) -> dict:
    if sess.get("onboardingCompleted"):
        return {"skipped": "onboarding_completed already true"}
    sp = sess.get("space") or {}
    if not sp.get("id") or not sp.get("viewId"):
        return {"error": "no space/view id in session — run --step resume first"}
    user_name = sess.get("userName") or (sess.get("email", "user").split("@")[0]).capitalize()

    def fn(c):
        auto = R.OB.OnboardingAutomation.from_existing_client(c)
        return auto.finish_onboarding_screens(
            sess["userId"], space_id=sp["id"], space_view_id=sp["viewId"],
            user_name=user_name, email=sess.get("email", ""),
            space_name=sp.get("name") or "Notion Workspace")
    fin, used = routed(R, sess, route, zkey, fn)
    sess["onboardingCompleted"] = True
    if fin.get("agent_thread_id"):
        sess["agentThreadId"] = fin["agent_thread_id"]
    return {"ok": True, "route": used,
            "agent_thread_id": fin.get("agent_thread_id", "")}


def _subscription_active(sub: dict) -> bool:
    return bool(sub.get("subscriptionTier") in ("business", "enterprise")
                or sub.get("type") == "subscribed_admin"
                or sub.get("subscriptionStatus") == "trialing")


def step_trial(R: Ref, sess: dict, route: str, zkey: str, args) -> dict:
    sid = (sess.get("space") or {}).get("id")
    if not sid:
        return {"error": "no space id in session — run --step resume first"}

    def check(c):
        return c.post("/api/v3/getSubscriptionData",
                      body={"spaceId": sid, "excludeInactiveTrial": False},
                      referer="/") or {}
    sub, used = routed(R, sess, route, zkey, check)
    if _subscription_active(sub):
        sess["trial"] = {"tier": sub.get("subscriptionTier"),
                         "type": sub.get("type"), "checkedAt": time.time()}
        return {"skipped": f"already active: tier={sub.get('subscriptionTier')} "
                           f"type={sub.get('type')}", "route": used}

    trial_end = (datetime.utcnow() + timedelta(days=args.trial_days)
                 ).isoformat(timespec="milliseconds") + "Z"
    body = {
        "captchaToken": "",                    # NOT validated on a clean IP
        "spaceId": sid,
        "desiredState": {"items": [{
            "quantity": 1,
            "price": {"externalId": "business_monthly_usd_202505",
                      "product": "business", "billingInterval": "month",
                      "unitAmount": {"currencyCode": "USD", "amount": 2400},
                      "state": "current"}}],
            "trialEnd": trial_end},
        "modalSessionId": str(uuid.uuid4()),
        "clientVersion": sess.get("clientVersion") or CLIENT_VERSION_FALLBACK,
        "trialData": {"id": "custom_agents_business_reverse_14d",
                      "from": "new_custom_agents_sidebar", "autoConvert": False},
        "from": "new_custom_agents_sidebar",
    }

    def activate(c):
        return c.post("/api/v3/updateSubscription", body=body, referer="/") or {}
    resp, used2 = routed(R, sess, route, zkey, activate)
    status = resp.get("subscriptionStatus")
    if status != "trialing":
        return {"error": f"unexpected subscriptionStatus {status!r}",
                "body": json.dumps(resp)[:300]}
    sess["trial"] = {"status": status, "tier": "business",
                     "invoiceUrl": resp.get("invoiceUrl", ""),
                     "trialEnd": trial_end, "activatedAt": time.time(),
                     "route": used2}
    return {"ok": True, "status": status, "route": used2,
            "invoiceUrl": resp.get("invoiceUrl", "")}


def verify_public_api(token: str) -> tuple[int, str]:
    req = urllib.request.Request(
        "https://api.notion.com/v1/users/me",
        headers={"Authorization": f"Bearer {token}",
                 "Notion-Version": "2022-06-28"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read().decode("utf-8", "replace")[:200]
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")[:200]
    except Exception as e:                              # noqa: BLE001
        return 0, f"EXC: {e}"


def step_apikey(R: Ref, sess: dict, route: str, zkey: str, args) -> dict:
    cur = sess.get("apiKey") or {}
    if cur.get("token"):
        s, _ = verify_public_api(cur["token"])
        if s == 200:
            return {"skipped": f"stored token {cur['token'][:12]}… still valid "
                               f"until {cur.get('expiresAt')}"}
        print(f"  stored token invalid (HTTP {s}) — creating a new one")
    sid = (sess.get("space") or {}).get("id")
    if not sid:
        return {"error": "no space id in session — run --step resume first"}

    def fn(c):
        return R.create_api_key(c, name=args.api_key_name, space_id=sid,
                                expiration=args.api_key_expiration)
    res, used = routed(R, sess, route, zkey, fn)
    s, body = verify_public_api(res.token)
    if s != 200:
        return {"error": f"token created but public-API verify failed: "
                         f"HTTP {s} {body[:120]}"}
    sess["apiKey"] = {"token": res.token, "botId": res.bot_id,
                      "expiresAt": res.expires_at, "name": res.name,
                      "spaceId": res.space_id, "createdAt": time.time()}
    return {"ok": True, "token": res.token[:12] + "…", "botId": res.bot_id,
            "expiresAt": res.expires_at, "route": used,
            "publicApiVerified": True}


def _extract_agent_text(lines) -> str:
    """Pull the AI reply out of the NDJSON patch stream: patch ops append
    {type: "agent-inference", value: [{type: "text", content: …}]}."""
    texts = []
    for line in lines:
        try:
            obj = json.loads(line)
        except Exception:
            continue
        if obj.get("type") != "patch":
            continue
        for op in obj.get("v") or []:
            inner = op.get("v") if isinstance(op, dict) else None
            if isinstance(inner, dict) and inner.get("type") == "agent-inference":
                for part in inner.get("value") or []:
                    if isinstance(part, dict) and part.get("type") == "text":
                        texts.append(part.get("content", ""))
    return "".join(texts).strip()


def _chat_config() -> dict:
    if not os.path.exists(CHAT_CONFIG):
        sys.exit(f"missing {CHAT_CONFIG} — capture a live chat request first "
                 f"(recorder technique, docs/POST-LOGIN-TAIL.md §3) and pass "
                 f"--refresh-config <gt_chat.json>")
    with open(CHAT_CONFIG) as f:
        return json.load(f)


def step_chat(R: Ref, sess: dict, route: str, zkey: str, args) -> dict:
    sp = sess.get("space") or {}
    sid, svid = sp.get("id"), sp.get("viewId")
    if not sid:
        return {"error": "no space id in session — run --step resume first"}
    uid = sess["userId"]
    now_local = datetime.now().astimezone().isoformat(timespec="milliseconds")
    tid = str(uuid.uuid4())
    transcript = [
        {"id": str(uuid.uuid4()), "type": "config", "value": _chat_config()},
        {"id": str(uuid.uuid4()), "type": "context", "value": {
            "timezone": datetime.now().astimezone().tzname() or "UTC",
            "userId": uid, "userEmail": sess.get("email", ""),
            "spaceName": sp.get("name") or "Notion Workspace",
            "spaceId": sid, "spaceViewId": svid or "",
            "currentDatetime": now_local, "surface": "ai_module"}},
        {"id": str(uuid.uuid4()), "type": "user", "userId": uid,
         "value": [[args.prompt]], "createdAt": now_local},
    ]
    body = {
        "traceId": str(uuid.uuid4()), "spaceId": sid,
        "transcript": transcript, "threadId": tid,
        "threadParentPointer": {"table": "space", "id": sid, "spaceId": sid},
        "createThread": True,
        "debugOverrides": {"emitAgentSearchExtractedResults": True,
                           "cachedInferences": {}, "annotationInferences": {},
                           "emitInferences": False},
        "generateTitle": True, "saveAllThreadOperations": True,
        "setUnreadState": True, "createdSource": "ai_module",
        "threadType": "workflow", "isPartialTranscript": False,
        "asPatchResponse": True, "patchResponseVersion": 2,
        "isUserInAnySalesAssistedSpace": False, "isSpaceSalesAssisted": False,
        "supportsCustomAgentNudgeTranscriptStep": True,
    }

    def fn(c):
        return c.post_stream("/api/v3/runInferenceTranscript", body=body,
                             referer="/", timeout=150)
    resp, used = routed(R, sess, route, zkey, fn)
    lines = [l for l in resp.iter_lines(decode_unicode=True) if l]
    reply = _extract_agent_text(lines)

    # outcome check (best-effort; the thread record settles a few seconds later)
    time.sleep(4)
    outcome = ""
    try:
        def fn2(c):
            return c.post("/api/v3/getInferenceTranscriptsForUser",
                          body={"threadParentPointer": {"table": "space",
                                                        "id": sid, "spaceId": sid},
                                "limit": 3, "includeWriterChats": False},
                          referer="/") or {}
        raw2, _ = routed(R, sess, route, zkey, fn2)
        for row in ((raw2.get("recordMap") or {}).get("thread") or {}).values():
            v = ((row.get("value") or {}).get("value") or {})
            if v.get("id") == tid:
                outcome = json.dumps((v.get("data") or {})
                                     .get("last_turn_outcome") or {})
                break
    except Exception as e:                              # noqa: BLE001
        outcome = f"(outcome lookup failed: {e})"

    sess.setdefault("chats", []).append({
        "threadId": tid, "prompt": args.prompt, "reply": reply,
        "events": len(lines), "outcome": outcome, "ts": time.time(),
        "route": used})
    ok = bool(reply) and '"completed"' in outcome
    return {"ok": ok, "threadId": tid, "route": used, "events": len(lines),
            "reply": reply or "(no text extracted)",
            "outcome": outcome or "(unknown)"}


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------
def main() -> None:
    p = argparse.ArgumentParser(
        description="Resume a saved Notion session at the backend and run "
                    "the post-signup tail: workspace → trial → api key → chat.")
    p.add_argument("--session", required=True,
                   help="path to the session JSON (created via --init-from-creds)")
    p.add_argument("--init-from-creds", metavar="CREDS_JSON",
                   help="bootstrap the session file from a signup creds dump "
                        "(tokenV2/userId/deviceId[/email])")
    p.add_argument("--step", action="append",
                   choices=[*STEP_ORDER, "all"],
                   help="step(s) to run (repeatable); default: all")
    p.add_argument("--route", choices=("auto", "direct", "zenrows"),
                   default="auto",
                   help="transport: auto = direct with Zenrows fallback on "
                        "IP blocks (default); direct; zenrows-only")
    p.add_argument("--zenrows-key", default=os.environ.get(
        "ZENROWS_API_KEY", ZENROWS_KEY_DEFAULT))
    p.add_argument("--notion-ref", default=NOTION_REF_DEFAULT)
    p.add_argument("--workspace-name", default="Onboard Workspace")
    p.add_argument("--workspace-icon", default="🚀")
    p.add_argument("--new-workspace", action="store_true",
                   help="force-create an ADDITIONAL space (active space "
                        "stays unchanged)")
    p.add_argument("--trial-days", type=int, default=14)
    p.add_argument("--api-key-name", default="automation-pat")
    p.add_argument("--api-key-expiration", default="1_year",
                   choices=("1_year", "90_days", "30_days", "7_days", "no_expiry"))
    p.add_argument("--prompt", default="What is 2+2? Answer with just the number.")
    p.add_argument("--refresh-config", metavar="GT_CHAT_JSON",
                   help="refresh backend/notion_chat_config.json from a freshly "
                        "captured ground-truth chat request, then exit")
    args = p.parse_args()

    if args.refresh_config:
        gt = json.load(open(args.refresh_config))
        cfg = gt["transcript"][0]["value"]
        with open(CHAT_CONFIG, "w") as f:
            json.dump(cfg, f, indent=1)
        print(f"chat config refreshed ({len(cfg)} keys) -> {CHAT_CONFIG}")
        return

    if args.init_from_creds:
        sess = init_from_creds(args.init_from_creds, args.session)
        print(f"session initialised from {args.init_from_creds} -> {args.session}")
    elif os.path.exists(args.session):
        sess = load_session(args.session)
    else:
        sys.exit(f"no session at {args.session} and no --init-from-creds given")

    R = load_ref(args.notion_ref)
    steps = args.step or ["all"]
    if "all" in steps:
        steps = list(STEP_ORDER)

    runners = {"resume": step_resume, "workspace": step_workspace,
               "onboarding": step_onboarding, "trial": step_trial,
               "apikey": step_apikey, "chat": step_chat}
    summary = {}
    for st in steps:
        print(f"\n=== step: {st} (route={args.route}) ===")
        try:
            res = runners[st](R, sess, args.route, args.zenrows_key, args)
        except R.NotionAuthError as e:
            print(f"  AUTH DEAD: {e}\n  → re-login via the extension "
                  f"(notion/signup-rest), then --init-from-creds again.")
            summary[st] = {"auth_error": str(e)[:120]}
            break
        except R.NotionAPIError as e:
            print(f"  FAILED: {e}")
            summary[st] = {"error": str(e)[:160]}
            break
        print("  " + json.dumps(res, ensure_ascii=False, default=str)[:400])
        summary[st] = res
        save_session(args.session, sess)

    save_session(args.session, sess)
    print("\n=== SUMMARY ===")
    print(json.dumps(summary, ensure_ascii=False, indent=1, default=str))
    masked = dict(sess)
    if masked.get("tokenV2"):
        masked["tokenV2"] = masked["tokenV2"][:12] + "…"
    if (masked.get("apiKey") or {}).get("token"):
        masked["apiKey"] = dict(masked["apiKey"],
                                token=masked["apiKey"]["token"][:12] + "…")
    print(f"\nsession state ({args.session}):")
    print(json.dumps(masked, ensure_ascii=False, indent=1, default=str))


if __name__ == "__main__":
    main()
