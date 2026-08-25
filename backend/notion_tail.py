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

Complete chat support (live-verified 2026-08-25, extension-free):
    models      getAvailableModels (+ getAiPickableModels) — the EXACT
                model list for the space: codename, display name, family,
                reasoning efforts, default effort. Saved to session[models].
    page        create a page WITH CONTENT via the PUBLIC API using the
                space's ntn_ key (the app-API CRDT create_page is broken —
                CrdtAssertionError text_slice_block_mapping). Saved to
                session[pages].
    instruct    assign a page as the AGENT INSTRUCTION (prompt table set
                prompt_type=instruction + space_view.settings
                agent_personalization_settings.context_page_id — the TWO-op
                shape from HAR call #36).
    skill       assign a page as an AGENT SKILL (prompt table set
                prompt_type=skill, HAR call #54). Skills auto-surface to
                the agent (Skills V2) — it reads + applies + CITES the page.
    chat        full options: --chat-model (codename), --chat-effort,
                --chat-context-page (context_page_id: the page becomes the
                thread's persistent_instructions_page — the agent READS
                it), --chat-block (blockId variant), --chat-thread
                (follow-up turn: createThread=false, isPartialTranscript).

Streaming protocol (decoded from live NDJSON): patch-start carries the
initial records; `a /s/-` appends records (agent-inference value parts are
typed "thinking" = CoT vs "text" = user-visible); `x /s/N/value/K/content`
APPENDS text chunks; terminal `a /s/N/model|inputTokens|...` carry the
model metadata; a final record-map line carries last_turn_outcome.

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

# Turso (libSQL HTTP pipeline) — the extension persists captured creds there
# (captured_tokens table, written by captureStepTokens on macro completion).
# Defaults point at the operator's onboard-automation database; override with
# --turso-url / --turso-token or TURSO_DATABASE_URL / TURSO_AUTH_TOKEN.
TURSO_URL_DEFAULT = os.environ.get(
    "TURSO_DATABASE_URL",
    "https://onboard-automation-ansgareutychisc.aws-us-east-1.turso.io")
TURSO_TOKEN_DEFAULT = os.environ.get("TURSO_AUTH_TOKEN", "")
TOKEN_TYPE_MAP = {  # captured_tokens.token_type -> session field
    "token_v2": "tokenV2",
    "notion_user_id": "userId",
    "notion_device_id": "deviceId",
}
CHAT_CONFIG = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                           "notion_chat_config.json")

STEP_ORDER = ("resume", "workspace", "onboarding", "trial", "apikey",
              "models", "page", "instruct", "skill", "chat")


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

    ZENROWS_ERROR_MARKERS = ("api-error-codes", "RESP0", "premium proxies")

    def __init__(self, base_headers: dict, cookie: str, api_key: str):
        self.headers = dict(base_headers)   # create_space() writes into this
        self._cookie = cookie
        self._key = api_key

    @staticmethod
    def _is_zenrows_error(resp: "_FakeResp") -> bool:
        """Zenrows-side failure (RESP001 'could not get content', etc.) —
        NOT a Notion response. These are transient proxy failures; retry.
        Live finding 2026-08-25: a RESP001 surfaced as NotionValidationError
        '[HTTP 400] validation error' and broke a workspace's trial."""
        body = (resp.text or "")[:600]
        return any(m in body for m in ZenrowsSession.ZENROWS_ERROR_MARKERS)

    def request(self, method, url, params=None, json=None, headers=None,
                timeout=None, stream=False, **_kw):
        last = None
        for attempt in range(4):                     # zenrows proxy flakiness
            last = self._request_once(method, url, params=params, json=json,
                                      headers=headers, timeout=timeout)
            if not self._is_zenrows_error(last):
                return last
            time.sleep(1.5 * (attempt + 1))
        return last

    def _request_once(self, method, url, params=None, json=None,
                      headers=None, timeout=None):
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
    # resp.json() crashes (JSONDecodeError "Extra data"). Patch in OB's OWN
    # namespace (onboarding.py imports the fn directly; patching ai.py does
    # nothing). FORCE streaming: finish_onboarding_screens passes
    # collect_initial_messages=False explicitly (fire-and-forget), and
    # setdefault would leave that in place — the exact bug that crashed the
    # onboarding step on fresh accounts (2026-08-25 live run).
    _orig = OB.initiate_onboarding_agent_chat

    def _streaming(*a, **kw):
        kw["collect_initial_messages"] = True
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


# --------------------------------------------------------------------------
# Turso (libSQL HTTP) — creds source
# --------------------------------------------------------------------------
def _turso_pipeline(url: str, token: str, sql: str, args: list | None = None):
    """One execute request against <url>/v2/pipeline. Returns parsed JSON."""
    stmt = {"sql": sql, "want_rows": True}
    if args:
        stmt["args"] = [
            {"type": "null"} if a is None else
            {"type": "integer", "value": a} if isinstance(a, int) and not isinstance(a, bool) else
            {"type": "float", "value": a} if isinstance(a, float) else
            {"type": "text", "value": str(a)}
            for a in args
        ]
    req = urllib.request.Request(
        f"{url.rstrip('/')}/v2/pipeline",
        data=_json_dumps({"requests": [{"type": "execute", "stmt": stmt}]}).encode(),
        headers={"Authorization": f"Bearer {token}",
                 "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def _turso_rows(payload: dict) -> list[dict]:
    rows: list[dict] = []
    for res in payload.get("results", []):
        result = (res.get("response") or {}).get("result") or {}
        cols = [c.get("name") for c in result.get("cols", [])]
        for row in result.get("rows", []):
            rows.append({c: v.get("value") for c, v in zip(cols, row)})
    return rows


def fetch_creds_from_turso(email: str, url: str, token: str) -> dict:
    """Latest captured creds for `email` from captured_tokens.

    Returns {token_v2, notion_user_id, notion_device_id, captured_at}.
    Raises SystemExit with a helpful message when nothing is found.
    """
    rows = _turso_rows(_turso_pipeline(
        url, token,
        "SELECT token_type, token_value, captured_at FROM captured_tokens "
        "WHERE email = ? AND service = 'notion' ORDER BY captured_at", [email]))
    creds: dict = {}
    captured_at = 0
    for r in rows:
        creds[r["token_type"]] = r["token_value"]
        captured_at = max(captured_at, int(r.get("captured_at") or 0))
    missing = [t for t in TOKEN_TYPE_MAP if t not in creds]
    if missing:
        have = list(creds.keys())
        sys.exit(f"[turso] no complete creds for {email!r} — missing {missing}, "
                 f"have {have}. Run the signup macro with Turso configured first.")
    creds["captured_at"] = captured_at
    return creds


def init_from_turso(email: str, out_path: str, url: str, token: str) -> dict:
    creds = fetch_creds_from_turso(email, url, token)
    sess = {
        "email": email,
        "userId": creds["notion_user_id"],
        "deviceId": creds["notion_device_id"],
        "tokenV2": creds["token_v2"],
        "clientVersion": CLIENT_VERSION_FALLBACK,
        "credsSource": "turso",
        "credsCapturedAt": creds.get("captured_at"),
        "createdAt": time.time(),
        "space": {}, "spaces": [], "chats": [],
    }
    save_session(out_path, sess)
    print(f"[turso] creds loaded for {email} "
          f"(captured_at={datetime.fromtimestamp(creds.get('captured_at') or 0)})")
    return sess


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
    """Detect Notion's IP-reputation gate on trial activation.

    The 400 is often wrapped as a generic_error: str(e) is only
    "Something went wrong. (400)" while the PAYLOAD carries
    name=UserValidationError / debugMessage="Trial activation is not
    allowed." — inspect both (live finding, 2026-08-25: the gate is
    probabilistic per-request — one direct call even succeeded — so the
    zenrows fallback must fire reliably, not just on the old message).
    """
    msg = str(e)
    status = getattr(e, "status_code", None)
    try:
        blob = msg + " " + _json_dumps(getattr(e, "payload", None) or {})
    except Exception:                                    # noqa: BLE001
        blob = msg
    if status == 403:
        return True
    return status == 400 and ("UserValidationError" in blob
                              or "not allowed" in blob)


def _is_rate_limited(e) -> bool:
    if getattr(e, "status_code", None) == 429:
        return True
    try:
        blob = str(e) + " " + _json_dumps(getattr(e, "payload", None) or {})
    except Exception:                                    # noqa: BLE001
        blob = str(e)
    return "Rate limited" in blob or "rate_limit" in blob


def routed(R: Ref, sess: dict, route: str, zkey: str, fn,
           rate_limit_retries: int = 2):
    """Run fn(client) with auto Zenrows fallback on IP-reputation blocks
    and wait-and-retry on Notion 429s (updateSubscription rate-limits
    aggressively when several trials are activated in quick succession).
    Returns (result, route_used)."""
    order = {"auto": ["direct", "zenrows"], "direct": ["direct"],
             "zenrows": ["zenrows"]}[route]
    last = None
    for r in order:
        attempt = 0
        while True:
            try:
                return fn(make_client(R, sess, r, zkey)), r
            except R.NotionAPIError as e:
                last = e
                if _is_rate_limited(e) and attempt < rate_limit_retries:
                    attempt += 1
                    wait = 20 * attempt
                    print(f"  ! rate limited (429) — retry {attempt} "
                          f"in {wait}s", flush=True)
                    time.sleep(wait)
                    continue
                break
        if r == "direct" and "zenrows" in order and _looks_ip_blocked(last):
            print(f"  ! direct blocked ({str(last)[:90]}) — retrying via zenrows")
            continue
        raise last
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
    activated = False
    if have and not getattr(args, "activate", False):
        # additional space — the ACTIVE space stays untouched (trial/apikey/
        # chat all target it); record under spaces[] for reference.
        sess.setdefault("spaces", []).append(entry)
    else:
        # first space, or --new-workspace --activate: the new space becomes
        # the active target for onboarding/trial/apikey/chat.
        sess["space"] = entry
        sess.setdefault("spaces", []).append(entry)
        activated = True
    return {"created": entry, "route": used, "active": sess["space"]["id"],
            "activated": activated}


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
        rec = {"tier": sub.get("subscriptionTier"),
               "type": sub.get("type"), "checkedAt": time.time()}
        sess.setdefault("trials", {})[sid] = rec
        sess["trial"] = rec
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
    rec = {"status": status, "tier": "business",
           "invoiceUrl": resp.get("invoiceUrl", ""),
           "trialEnd": trial_end, "activatedAt": time.time(),
           "route": used2, "spaceId": sid}
    sess.setdefault("trials", {})[sid] = rec
    sess["trial"] = rec                       # compat: latest trial
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
    sid = (sess.get("space") or {}).get("id")
    if not sid:
        return {"error": "no space id in session — run --step resume first"}
    keys = sess.setdefault("apiKeys", {})
    cur = keys.get(sid) or {}
    if cur.get("token"):
        s, _ = verify_public_api(cur["token"])
        if s == 200:
            return {"skipped": f"stored token {cur['token'][:12]}… still valid "
                               f"until {cur.get('expiresAt')}"}
        print(f"  stored token invalid (HTTP {s}) — creating a new one")

    def fn(c):
        return R.create_api_key(c, name=args.api_key_name, space_id=sid,
                                expiration=args.api_key_expiration)
    res, used = routed(R, sess, route, zkey, fn)
    s, body = verify_public_api(res.token)
    if s != 200:
        return {"error": f"token created but public-API verify failed: "
                         f"HTTP {s} {body[:120]}"}
    rec = {"token": res.token, "botId": res.bot_id,
           "expiresAt": res.expires_at, "name": res.name,
           "spaceId": res.space_id, "createdAt": time.time()}
    keys[sid] = rec
    sess["apiKey"] = dict(rec)                 # compat: latest key
    return {"ok": True, "token": res.token[:12] + "…", "botId": res.bot_id,
            "expiresAt": res.expires_at, "route": used,
            "publicApiVerified": True}


def _extract_agent_text(lines) -> str:
    """Pull the AI reply out of the NDJSON patch stream (legacy shim)."""
    return parse_chat_stream(lines, "", "")["reply"]


def parse_chat_stream(lines, tid: str, used: str) -> dict:
    """Stateful NDJSON patch applier — reconstructs the chat result from
    the runInferenceTranscript patch stream. Live-protocol (2026-08-25):

      patch-start data.s  : initial records (agent-instruction-state, ...)
      a  /s/-             : append record
      a  /s/N/value/-     : append a VALUE PART {type, content, ...}
                            ("thinking" = chain-of-thought, "text" = the
                            user-visible reply — MUST be separated)
      x  /s/N/value/K/content : APPEND a text chunk to part K (o="x" is
                            extend, NOT replace)
      a  /s/N/model|inputTokens|outputTokens|... : terminal metadata
      record-map          : final thread record (last_turn_outcome)
    """
    records: list[dict] = []
    tools, outcome = [], {}

    def _mkrec(v: dict) -> dict:
        return {"type": (v or {}).get("type", ""),
                "parts": [dict(pp) for pp in (v or {}).get("value") or []
                          if isinstance(pp, dict)],
                "meta": {k: vv for k, vv in (v or {}).items()
                         if k not in ("value", "type", "id")},
                "id": (v or {}).get("id", "")}

    for line in lines:
        try:
            obj = json.loads(line if isinstance(line, str)
                             else line.decode("utf-8", "replace"))
        except Exception:                                    # noqa: BLE001
            continue
        t = obj.get("type")
        if t == "patch-start":
            for rec in (obj.get("data") or {}).get("s") or []:
                records.append(_mkrec(rec))
            continue
        if t == "record-map":
            for rec in (obj.get("recordMap") or {}).get("thread", {}).values():
                v = rec.get("value") or {}
                inner = v.get("value") if isinstance(v, dict) else None
                data = (inner or v).get("data") or {}
                if data.get("last_turn_outcome"):
                    outcome = data["last_turn_outcome"]
            continue
        if t != "patch":
            continue
        for op in obj.get("v") or []:
            if not isinstance(op, dict):
                continue
            o, p, v = op.get("o"), op.get("p"), op.get("v")
            if not isinstance(p, str) or not p.startswith("/s/"):
                continue
            if p == "/s/-" and o == "a":
                records.append(_mkrec(v or {}))
                continue
            parts = p.strip("/").split("/")
            try:
                n = int(parts[1])
            except (ValueError, IndexError):
                continue
            while len(records) <= n:
                records.append({"type": "", "parts": [], "meta": {}, "id": ""})
            rec = records[n]
            if len(parts) == 3 and o == "a":              # /s/N/<field>
                rec["meta"][parts[2]] = v
            elif (len(parts) == 4 and parts[2] == "value" and parts[3] == "-"
                    and o == "a"):                        # append value part
                if isinstance(v, dict):
                    rec["parts"].append(dict(v))
            elif (len(parts) == 5 and parts[2] == "value"
                    and parts[4] == "content"):           # extend content
                try:
                    k = int(parts[3])
                except ValueError:
                    continue
                while len(rec["parts"]) <= k:
                    rec["parts"].append({"type": "", "content": ""})
                rec["parts"][k]["content"] = \
                    rec["parts"][k].get("content", "") + (v or "")

    reply_parts, thinking, models, tokens = [], [], [], {}
    for rec in records:
        if rec["type"] == "agent-inference":
            for part in rec["parts"]:
                if part.get("type") == "text":
                    reply_parts.append(part.get("content", ""))
                elif part.get("type") == "thinking":
                    thinking.append(part.get("content", ""))
            if rec["meta"].get("model"):
                models.append(rec["meta"]["model"])
            for k in ("inputTokens", "outputTokens", "cachedTokensRead",
                      "maxContextTokens"):
                if rec["meta"].get(k) is not None:
                    tokens[k] = rec["meta"][k]
        elif rec["type"] == "agent-tool-result":
            res = rec["meta"].get("result") or {}
            tools.append({"headerLabel": res.get("headerLabel", ""),
                          "output": str(res.get("output", ""))[:160]})
    return {"threadId": tid, "route": used, "events": len(lines),
            "reply": "".join(reply_parts).strip(),
            "thinking": "".join(thinking).strip()[:400],
            "model": models[-1] if models else "",
            "tools": tools, "tokens": tokens,
            "outcome": outcome}


def _chat_config() -> dict:
    if not os.path.exists(CHAT_CONFIG):
        sys.exit(f"missing {CHAT_CONFIG} — capture a live chat request first "
                 f"(recorder technique, docs/POST-LOGIN-TAIL.md §3) and pass "
                 f"--refresh-config <gt_chat.json>")
    with open(CHAT_CONFIG) as f:
        return json.load(f)


def step_models(R: Ref, sess: dict, route: str, zkey: str, args) -> dict:
    """getAvailableModels + getAiPickableModels — the EXACT model list.

    Live finding (business-trial space, 2026-08-25): 31 available models
    with per-model supportedReasoningEfforts + defaults; 92 pickable
    codenames in total; restricted entries carry disabledReason (e.g.
    acai-budino "Fable 5": trial_not_allowed). Saved to session[models].
    """
    sid = (sess.get("space") or {}).get("id")

    def fn_avail(c):
        return c.post("/api/v3/getAvailableModels",
                      body={"spaceId": sid}, referer="/") or {}

    def fn_pick(c):
        return c.post("/api/v3/getAiPickableModels", body={}, referer="/") or {}
    avail, used = routed(R, sess, route, zkey, fn_avail)
    pick, _ = routed(R, sess, route, zkey, fn_pick)
    models = []
    for m in avail.get("models") or []:
        cfg = m.get("modelConfiguration") or {}
        models.append({
            "codename": m.get("model"), "name": m.get("modelMessage"),
            "family": m.get("modelFamily"), "group": m.get("displayGroup"),
            "efforts": cfg.get("supportedReasoningEfforts"),
            "defaultEffort": cfg.get("defaultReasoningEffort"),
            "disabled": bool(m.get("isDisabled"))})
    restricted = [{"codename": r.get("codename"), "name": r.get("modelMessage"),
                   "reason": r.get("disabledReason")}
                  for r in avail.get("restrictedAccessModelsInPickerConfig") or []]
    sess["models"] = {"available": models, "nPickable": len(pick.get("models") or []),
                      "restricted": restricted}
    return {"route": used, "available": len(models),
            "pickable": len(pick.get("models") or []),
            "restricted": restricted,
            "table": [f"{m['codename']} = {m['name']} "
                      f"({m['family']}, eff={m['efforts']})"
                      for m in models[:8]] + ["…"]}


# --------------------------------------------------------------------------
# PUBLIC API (api.notion.com/v1) — page creation with the ntn_ key
# --------------------------------------------------------------------------
def _space_api_key(sess: dict) -> str:
    sid = (sess.get("space") or {}).get("id")
    per_space = (sess.get("apiKeys") or {}).get(sid) or {}
    tok = per_space.get("token") or (sess.get("apiKey") or {}).get("token")
    if not tok:
        sys.exit("no ntn_ key for the active space — run --step apikey first")
    return tok


def _pub_api(method: str, path: str, token: str, body=None) -> tuple[int, dict]:
    req = urllib.request.Request(
        f"https://api.notion.com/v1{path}",
        data=_json_dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {token}",
                 "Notion-Version": "2022-06-28",
                 "Content-Type": "application/json"}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8", "replace") or "{}")


def step_page(R: Ref, sess: dict, route: str, zkey: str, args) -> dict:
    """Create a page WITH CONTENT via the PUBLIC API (ntn_ key).

    The app-API CRDT create_page is broken server-side (CrdtAssertionError
    "New block should have one text_slice_block_mapping record" — the
    server now demands the new insertText CRDT protocol); the PUBLIC API
    creates pages + paragraph blocks cleanly and the chat agent reads
    them identically (live-verified: MARSHMALLOW secret-word test).
    """
    tok = _space_api_key(sess)
    title = args.page_title
    children = [{"object": "block", "type": "paragraph", "paragraph": {
        "rich_text": [{"text": {"content": args.page_content}}]}}] \
        if args.page_content else []
    st, page = _pub_api("POST", "/pages", tok, {
        "parent": {"type": "workspace", "workspace": True},
        "properties": {"title": [{"text": {"content": title}}]},
        "children": children})
    if st != 200:
        return {"error": f"HTTP {st}", "detail": json.dumps(page)[:200]}
    entry = {"id": page["id"], "title": title, "url": page.get("url", ""),
             "createdAt": time.time()}
    sess.setdefault("pages", []).append(entry)
    return {"ok": True, "page": entry}


def _assign_prompt(R: Ref, sess: dict, route: str, zkey: str,
                   page_id: str, prompt_type: str) -> dict:
    """prompt-table assignment — HAR call #36/#54 ground truth.

    instruction ALSO updates space_view.settings
    agent_personalization_settings.context_page_id (the second op the
    web client sends with setAsInstruction.on — without it the page never
    becomes the agent's personalization context).
    """
    sid = (sess.get("space") or {}).get("id")
    svid = (sess.get("space") or {}).get("viewId")
    pid = str(uuid.uuid4())
    now_ms = int(time.time() * 1000)
    ops = [{
        "pointer": {"table": "prompt", "id": pid, "spaceId": sid},
        "path": [], "command": "set",
        "args": {"id": pid, "space_id": sid, "parent_id": page_id,
                 "parent_table": "block", "version": 1,
                 "created_time": now_ms, "alive": True,
                 "prompt_type": prompt_type}}]
    if prompt_type == "instruction":
        ops.append({
            "pointer": {"table": "space_view", "id": svid, "spaceId": sid},
            "path": ["settings"], "command": "update",
            "args": {"agent_personalization_settings":
                     {"context_page_id": page_id}}})
    body = {"requestId": str(uuid.uuid4()), "transactions": [{
        "id": str(uuid.uuid4()), "spaceId": sid,
        "debug": {"userAction": "setAsInstruction.on" if
                  prompt_type == "instruction" else
                  "topbarMoreActionRegistry.setAsAiSkill",
                  "clientCommitTimeMs": now_ms},
        "operations": ops}]}

    def fn(c):
        return c.post("/api/v3/saveTransactionsFanout", body=body,
                      referer="/") or {}
    raw, used = routed(R, sess, route, zkey, fn)
    return {"promptId": pid, "promptType": prompt_type, "pageId": page_id,
            "route": used, "ok": True}


def _resolve_page_arg(sess: dict, args) -> str:
    """--page-id, or the Nth-latest session page, or the latest page."""
    if getattr(args, "page_id", None):
        return args.page_id
    pages = sess.get("pages") or []
    if not pages:
        sys.exit("no page id — pass --page-id <uuid> or run --step page first")
    return pages[-1]["id"]


def step_instruct(R: Ref, sess: dict, route: str, zkey: str, args) -> dict:
    page_id = _resolve_page_arg(sess, args)
    res = _assign_prompt(R, sess, route, zkey, page_id, "instruction")
    sess.setdefault("prompts", {})[page_id] = res
    sess["instructionPageId"] = page_id
    return res


def step_skill(R: Ref, sess: dict, route: str, zkey: str, args) -> dict:
    page_id = _resolve_page_arg(sess, args)
    res = _assign_prompt(R, sess, route, zkey, page_id, "skill")
    sess.setdefault("prompts", {})[page_id] = res
    sess.setdefault("skillPageIds", []).append(page_id)
    return res


def step_chat(R: Ref, sess: dict, route: str, zkey: str, args) -> dict:
    """runInferenceTranscript — full chat support.

    Live-verified capabilities (2026-08-25):
      --chat-model <codename>   config.model + modelFromUser=true
      --chat-effort <level>     config.reasoningEffort (per-model list:
                                --step models)
      --chat-context-page <id>  context.context_page_id — the page becomes
                                the thread's persistent_instructions_page;
                                the agent READS it (MARSHMALLOW test) and
                                FOLLOWS directives on it (PINEAPPLE test)
      --chat-block <id>         context.blockId — alternative page-context
                                shape (also live-verified)
      --chat-thread <threadId>  follow-up turn: createThread=false,
                                isPartialTranscript=true (instructions on
                                the page PERSIST across turns; ~97% of the
                                prompt is cache-hit on the 2nd turn)
    """
    sp = sess.get("space") or {}
    sid, svid = sp.get("id"), sp.get("viewId")
    if not sid:
        return {"error": "no space id in session — run --step resume first"}
    uid = sess["userId"]
    now_local = datetime.now().astimezone().isoformat(timespec="milliseconds")
    tid = getattr(args, "chat_thread", None) or str(uuid.uuid4())
    follow_up = bool(getattr(args, "chat_thread", None))
    cfg = _chat_config()
    if getattr(args, "chat_model", None):
        cfg["model"] = args.chat_model
        cfg["modelFromUser"] = True
        if getattr(args, "chat_effort", None):
            cfg["reasoningEffort"] = args.chat_effort
    ctx = {
        "timezone": datetime.now().astimezone().tzname() or "UTC",
        "userName": "Onboard",
        "userId": uid, "userEmail": sess.get("email", ""),
        "spaceName": sp.get("name") or "Notion Workspace",
        "spaceId": sid, "spaceViewId": svid or "",
        "currentDatetime": now_local, "surface": "ai_module"}
    if getattr(args, "chat_context_page", None):
        ctx["context_page_id"] = args.chat_context_page
    elif sess.get("instructionPageId"):
        # agent personalization: the web client sends the instruction page
        # as context_page_id on every chat (HAR calls #55/#63/#65)
        ctx["context_page_id"] = sess["instructionPageId"]
    if getattr(args, "chat_block", None):
        ctx["blockId"] = args.chat_block
    transcript = [
        {"id": str(uuid.uuid4()), "type": "config", "value": cfg},
        {"id": str(uuid.uuid4()), "type": "context", "value": ctx},
        {"id": str(uuid.uuid4()), "type": "user", "userId": uid,
         "value": [[args.prompt]], "createdAt": now_local},
    ]
    body = {
        "traceId": str(uuid.uuid4()), "spaceId": sid,
        "transcript": transcript, "threadId": tid,
        "threadParentPointer": {"table": "space", "id": sid, "spaceId": sid},
        "createThread": not follow_up,
        "debugOverrides": {"emitAgentSearchExtractedResults": True,
                           "cachedInferences": {}, "annotationInferences": {},
                           "emitInferences": False},
        "generateTitle": not follow_up, "saveAllThreadOperations": True,
        "setUnreadState": True, "createdSource": "ai_module",
        "threadType": "workflow", "isPartialTranscript": follow_up,
        "asPatchResponse": True, "patchResponseVersion": 2,
        "isUserInAnySalesAssistedSpace": False, "isSpaceSalesAssisted": False,
        "supportsCustomAgentNudgeTranscriptStep": True,
    }

    def fn(c):
        return c.post_stream("/api/v3/runInferenceTranscript", body=body,
                             referer="/", timeout=150)
    resp, used = routed(R, sess, route, zkey, fn)
    lines = [l for l in resp.iter_lines(decode_unicode=True) if l]
    parsed = parse_chat_stream(lines, tid, used)
    reply = parsed["reply"]

    # if the stream closed before the final text landed, fall back to the
    # settled thread record (syncRecordValuesSpaceInitial — plain JSON)
    if not reply and not follow_up:
        time.sleep(4)
        reply = _fetch_thread_reply(R, sess, route, zkey, tid) or reply

    outcome = parsed["outcome"] or {}
    if not outcome:
        time.sleep(3)
        outcome = _fetch_thread_outcome(R, sess, route, zkey, tid) or {}

    rec = {
        "threadId": tid, "prompt": args.prompt, "reply": reply,
        "model": parsed["model"], "tokens": parsed["tokens"],
        "tools": [t.get("headerLabel") for t in parsed["tools"]][:6],
        "outcome": outcome, "ts": time.time(),
        "route": used, "spaceId": sid, "spaceName": sp.get("name", ""),
        "contextPageId": ctx.get("context_page_id", "")}
    sess.setdefault("chats", []).append(rec)
    ok = bool(reply) and outcome.get("status") == "completed"
    return {"ok": ok, "threadId": tid, "route": used,
            "events": len(lines), "model": parsed["model"] or "(default)",
            "reply": reply or "(no text extracted)",
            "tokens": parsed["tokens"],
            "outcome": outcome or {"status": "(unknown)"}}


def _fetch_thread_record(R: Ref, sess: dict, route: str, zkey: str,
                         tid: str) -> dict:
    sid = (sess.get("space") or {}).get("id")

    def fn(c):
        return c.post("/api/v3/syncRecordValuesSpaceInitial",
                      body={"requests": [
                          {"pointer": {"table": "thread", "id": tid,
                                       "spaceId": sid}, "version": -1}],
                          "spacePointer": {"table": "space", "id": sid,
                                           "spaceId": sid}},
                      referer="/") or {}
    raw, _ = routed(R, sess, route, zkey, fn)
    rec = ((raw.get("recordMap") or {}).get("thread") or {}).get(tid) or {}
    v = rec.get("value") or {}
    inner = v.get("value") if isinstance(v, dict) else None
    return inner if isinstance(inner, dict) else (v if isinstance(v, dict) else {})


def _fetch_thread_outcome(R: Ref, sess: dict, route: str, zkey: str,
                          tid: str) -> dict:
    try:
        rec = _fetch_thread_record(R, sess, route, zkey, tid)
        return (rec.get("data") or {}).get("last_turn_outcome") or {}
    except Exception:                                        # noqa: BLE001
        return {}


def _fetch_thread_reply(R: Ref, sess: dict, route: str, zkey: str,
                        tid: str) -> str:
    """Post-completion fallback: thread -> message ids -> thread_message
    records -> concat the text parts of the LAST agent-inference."""
    try:
        sid = (sess.get("space") or {}).get("id")
        rec = _fetch_thread_record(R, sess, route, zkey, tid)
        mids = rec.get("messages") or []
        if not mids:
            return ""

        def fn(c):
            return c.post("/api/v3/syncRecordValuesSpaceInitial",
                          body={"requests": [
                              {"pointer": {"table": "thread_message", "id": m,
                                           "spaceId": sid}, "version": -1}
                              for m in mids],
                              "spacePointer": {"table": "space", "id": sid,
                                               "spaceId": sid}},
                          referer="/") or {}
        raw, _ = routed(R, sess, route, zkey, fn)
        tms = (raw.get("recordMap") or {}).get("thread_message") or {}
        texts = []
        for m in mids:
            vv = (tms.get(m) or {}).get("value") or {}
            step_rec = vv.get("value") if isinstance(vv, dict) else {}
            step = (step_rec or {}).get("step") or {}
            if step.get("type") == "agent-inference" \
                    and isinstance(step.get("value"), list):
                texts.append("".join(
                    p.get("content", "") for p in step["value"]
                    if isinstance(p, dict) and p.get("type") == "text"))
        return "".join(texts).strip()
    except Exception:                                        # noqa: BLE001
        return ""


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
    p.add_argument("--init-from-turso", metavar="EMAIL",
                   help="bootstrap the session file from the LATEST creds the "
                        "extension captured into Turso (captured_tokens) for "
                        "this email — the default backend handoff")
    p.add_argument("--turso-url", default=TURSO_URL_DEFAULT,
                   help="libSQL HTTP URL of the Turso database "
                        "(env TURSO_DATABASE_URL)")
    p.add_argument("--turso-token", default=TURSO_TOKEN_DEFAULT,
                   help="Turso DB auth token (env TURSO_AUTH_TOKEN)")
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
    p.add_argument("--activate", action="store_true",
                   help="with --new-workspace: make the NEW space the active "
                        "target for subsequent trial/apikey/chat steps")
    p.add_argument("--space", metavar="SPACE_ID",
                   help="switch the ACTIVE space to this existing space id "
                        "(from the session's spaces[] list) before running "
                        "steps — for idempotent per-workspace re-runs")
    p.add_argument("--trial-days", type=int, default=14)
    p.add_argument("--api-key-name", default="automation-pat")
    p.add_argument("--api-key-expiration", default="1_year",
                   choices=("1_year", "90_days", "30_days", "7_days", "no_expiry"))
    p.add_argument("--prompt", default="What is 2+2? Answer with just the number.")
    p.add_argument("--page-title", default="Automation Page",
                   help="--step page: title of the page to create")
    p.add_argument("--page-content", default="",
                   help="--step page: paragraph content for the page")
    p.add_argument("--page-id", metavar="UUID",
                   help="--step instruct/skill: target an explicit page id "
                        "(default: the latest page created via --step page)")
    p.add_argument("--chat-model", metavar="CODENAME",
                   help="--step chat: model codename (list: --step models; "
                        "e.g. orange-mousse, agave-flan, angel-cake-high)")
    p.add_argument("--chat-effort", metavar="LEVEL",
                   choices=("none", "minimal", "low", "medium", "high",
                            "xhigh", "max"),
                   help="--step chat: reasoningEffort for the chosen model")
    p.add_argument("--chat-context-page", metavar="UUID",
                   help="--step chat: chat ON this page (context_page_id) — "
                        "the agent reads it and follows its directives")
    p.add_argument("--chat-block", metavar="UUID",
                   help="--step chat: blockId page-attachment variant")
    p.add_argument("--chat-thread", metavar="THREAD_ID",
                   help="--step chat: follow-up turn on an existing thread")
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
    elif args.init_from_turso:
        if not args.turso_token:
            sys.exit("--init-from-turso needs --turso-token or TURSO_AUTH_TOKEN")
        sess = init_from_turso(args.init_from_turso, args.session,
                               args.turso_url, args.turso_token)
        print(f"session initialised from Turso -> {args.session}")
    elif os.path.exists(args.session):
        sess = load_session(args.session)
    else:
        sys.exit(f"no session at {args.session} and no --init-from-creds given")

    R = load_ref(args.notion_ref)
    if args.space:
        match = [s for s in (sess.get("spaces") or [])
                 if s.get("id") == args.space]
        if not match:
            sys.exit(f"--space {args.space} not in session spaces[] — "
                     f"have {[s.get('id') for s in sess.get('spaces') or []]}")
        sess["space"] = match[0]
        print(f"active space switched -> {match[0].get('name')} "
              f"({args.space[:8]}…)")
        save_session(args.session, sess)

    steps = args.step or ["all"]
    if "all" in steps:
        steps = list(STEP_ORDER)

    runners = {"resume": step_resume, "workspace": step_workspace,
               "onboarding": step_onboarding, "trial": step_trial,
               "apikey": step_apikey, "models": step_models,
               "page": step_page, "instruct": step_instruct,
               "skill": step_skill, "chat": step_chat}
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
