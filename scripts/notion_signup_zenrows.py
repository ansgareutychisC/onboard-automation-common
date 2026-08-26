#!/usr/bin/env python3
"""Notion signup via Zenros (Fetch API) — probe/research driver.

SUPERSEDED FOR SIGNUP by scripts/notion_signup_warm.js (2026-08-26): the
warm Zenrows Browser Session (CDP) keeps ONE residential IP across the
whole flow and completes loginWithEmail cleanly. See
docs/ZENROWS-EVAL.md Addendum 3. This script remains the canonical
getLoginOptions PROBE tool (axis A/C/E in signup_matrix.py use it).

LIVE FINDINGS (2026-08-26, empirically tested end-to-end):

  Step                  | Zenros premium_proxy=us  | Verdict
  ----------------------|--------------------------|-------------------------
  getLoginOptions       | ~30-40% pass on fresh    | WORKS (probabilistic)
  sendTemporaryPassword | Always (after a PASS)    | WORKS
  Poll v3-mail for code  | Always (10-15s wait)     | WORKS
  loginWithEmail        | 422 RESP001 every time    | BLOCKED — IP-bound

THE BLOCKER — loginWithEmail is IP-bound:
  - Notion binds the csrfState (issued at sendTemporaryPassword time) to
    the requesting IP. When loginWithEmail arrives from a different IP,
    Notion rejects with 422 (wrapped by Zenros as RESP001 "Could not
    get content").
  - Each premium_proxy request from Zenros uses a DIFFERENT residential
    IP (random rotation). Without IP pinning, the state-vs-submit IP
    mismatch is unavoidable.
  - Zenros's `session_id` parameter (per docs at
    https://docs.zenrows.com/fetch/features/other#session-id) WOULD pin
    the IP for 10 min, but on this Zenros plan it returns
    "Empty reply from server" (HTTP 000) — likely a paid-tier feature.

PRACTICAL VERDICT — KEEP THE EXTENSION AS PRIMARY SIGNUP DRIVER:
  - Zenros CAN: probe getLoginOptions (find passing email patterns),
    trigger sendcode (code emails arrive), read code via v3-mail worker.
  - Zenros CANNOT: complete the final loginWithEmail step end-to-end.
  - The extension's signup-rest.json macro does the WHOLE flow from one
    real browser (same IP for all 3 Notion calls), so it succeeds
    deterministically. Keep the extension as the primary signup driver.

WHEN TO USE THIS SCRIPT:
  - As a RESEARCH/PROBE tool: identify which email patterns pass
    getLoginOptions via Zenros (axis A/C/E in signup_matrix.py).
  - For accounts created via extension, this script can drive the
    LOGIN flow on the existing account (if Notion's IP-binding on
    loginWithEmail is only enforced for fresh signups, not logins —
    UNTESTED).
  - As a documented negative result for the ZENROWS-EVAL addendum.

PROVEN PASSING COMBOS (for getLoginOptions only):
  - Named aliases on priv.email (admin@/support@/noreply@/billing@)
    via Zenros premium_proxy=us: 4/5 pass without captcha. (security@
    got captcha — possibly flagged as high-risk alias name.)
    These are LOGIN flows (hasAccount:true), not signup.
  - Fresh emails on v3-mail.priv.email via Zenros premium_proxy=us:
    2/5 pass. Apex priv.email: 1/3 pass. Retry-with-rotation gives
    ~90% success probability within 5 attempts (captcha rate ~30-40%).

WHAT THIS DRIVER DOES (when run):
  1. Allocates a fresh email on v3-mail.priv.email (worker subdomain,
     so code emails are readable via the v3-mail worker Bearer API).
  2. Probes getLoginOptions via Zenros premium_proxy=us until PASS
     (no challengeProvider:hcaptcha). Up to N retries.
  3. sendTemporaryPassword via Zenros (loginOptionsToken from step 2).
  4. Polls v3-mail worker for the code email (raw @ in URL — quote
     with safe='@' or Cloudflare bot-blocks urllib with error 1010).
  5. loginWithEmail via Zenros (code + csrfState). — WILL 422.
  6. On 422, returns the partial state for inspection/fallback.

Cost per attempt: ~5 Zenros credits per getLoginOptions probe, ~5 per
sendTemporaryPassword, ~5 per loginWithEmail attempt. A failing attempt
(captcha) costs ~5 credits. A passing attempt costs ~15 credits plus
the loginWithEmail retry budget.

Usage:
  python3 notion_signup_zenrows.py                  # one-shot, save to /tmp/zen_signup_creds.json
  python3 notion_signup_zenrows.py --max-retries 10 # increase retry budget
  python3 notion_signup_zenrows.py --email admin@priv.email   # use a specific email (login flow)
  python3 notion_signup_zenrows.py --out /path/to/creds.json
  python3 notion_signup_zenrows.py --no-proxy        # datacenter IP (won't pass captcha but cheap probe)
"""
import argparse, json, time, uuid, urllib.parse, urllib.request, urllib.error, re, ssl

ZENROWS_KEY = "0e43f2d6166122fa4b4aa607464f5c7d4d8ce855"
ZENROWS_API = "https://api.zenrows.com/v1/"
NOTION_VER = "23.13.20260826.0028"  # captured live 2026-08-26
V3MAIL_BASE = "https://v3-mail.priv.email"
V3MAIL_TOKEN = "Bearer a2df50bf1d1310903061cdd569b6a20a62717998dcfe52bf"
REDIRECT_URL = "/p/3c7e9d22c27d805f8768dc3399e67455"
# Cloudflare bot-blocks plain urllib on v3-mail worker host (gotcha #19).
# Need a real User-Agent AND a TLS context that doesn't trip the bot signature.
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36")
_SSL_CTX = ssl.create_default_context()


def _post_json(url, headers, body, timeout=90, return_headers=False):
    """POST JSON. Returns (status, body_text, headers_dict_if_returned)."""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body_text = r.read().decode("utf-8", "replace")
            if return_headers:
                return r.status, body_text, dict(r.headers)
            return r.status, body_text
    except urllib.error.HTTPError as e:
        body_text = e.read().decode("utf-8", "replace")
        if return_headers:
            return e.code, body_text, dict(e.headers)
        return e.code, body_text
    except Exception as e:
        if return_headers:
            return 0, f"EXC: {e}", {}
        return 0, f"EXC: {e}"


def _get(url, headers, timeout=60):
    h = {"User-Agent": UA, **headers}
    req = urllib.request.Request(url, headers=h, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=_SSL_CTX) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:
        return 0, f"EXC: {e}"


def _is_zenrows_error(body_text):
    """Detect Zenros-side transient errors (RESP001 'could not get content',
    RESP002 page 404, 'premium proxies', 'api-error-codes'). These are NOT
    Notion responses — Zenros failed at its proxy layer; retry.
    See handoff gotcha #9 and notion_tail.py:170."""
    if not body_text:
        return False
    markers = ("api-error-codes", "RESP0", "premium proxies", "Could not get content")
    return any(m in body_text[:600] for m in markers)


def zenrows_post(target_url, body, use_proxy=True, proxy_country="us",
                 timeout=90, return_headers=False, max_retries=4,
                 session_id=None):
    """POST to target via Zenros with custom_headers=true (header forwarding).

    Retries on Zenros-side transient errors (RESP001 etc.) with backoff,
    matching ZenrowsSession.request in notion_tail.py:178.

    Args:
      session_id: if set with use_proxy=True, Zenros pins all calls with
        the same session_id to one residential IP. CRITICAL for signup:
        Notion IP-binds the csrfState — sendcode and loginWithEmail MUST
        come from the same IP or loginWithEmail 422s (confirmed live
        2026-08-26: without session_id, loginWithEmail 422s every time).
    """
    last_status, last_body, last_hdrs = 0, "", {}
    for attempt in range(max_retries):
        last_status, last_body, last_hdrs = _zenrows_post_once(
            target_url, body, use_proxy=use_proxy, proxy_country=proxy_country,
            timeout=timeout, session_id=session_id)
        if not _is_zenrows_error(last_body):
            break
        if attempt < max_retries - 1:
            time.sleep(1.5 * (attempt + 1))  # 1.5, 3, 4.5s backoff
    if return_headers:
        return last_status, last_body, last_hdrs
    return last_status, last_body


def _zenrows_post_once(target_url, body, use_proxy=True, proxy_country="us",
                       timeout=90, session_id=None):
    """Single Zenros POST attempt."""
    headers = {
        "Accept-Encoding": "identity",
        "Content-Type": "application/json",
        "Notion-Audit-Log-Platform": "web",
        "Notion-Client-Version": NOTION_VER,
        "Origin": "https://app.notion.com",
        "Referer": "https://app.notion.com/signup",
    }
    params = {
        "apikey": ZENROWS_KEY,
        "url": target_url,
        "original_status": "true",
        "custom_headers": "true",
    }
    if use_proxy:
        params["premium_proxy"] = "true"
        if proxy_country:
            params["proxy_country"] = proxy_country
        # session_id only added when explicitly set AND use_proxy=True.
        # NOTE: Zenros returns "Empty reply from server" when session_id is
        # sent on the free/cheap plan — set only if you know your plan
        # supports it. The signup flow auto-rotates per-attempt instead.
        if session_id:
            params["session_id"] = session_id
    qs = urllib.parse.urlencode(params)
    return _post_json(f"{ZENROWS_API}?{qs}", headers, body, timeout=timeout,
                      return_headers=True)


def probe_get_login_options(email, use_proxy=True, proxy_country="us",
                                 session_id=None):
    """Probe getLoginOptions. Returns (passed, parsed_dict, raw)."""
    body = {"email": email, "requireWorkTypeEmail": False}
    try:
        s, b, hdrs = zenrows_post(
            "https://app.notion.com/api/v3/getLoginOptions", body,
            use_proxy=use_proxy, proxy_country=proxy_country,
            return_headers=True, session_id=session_id)
    except Exception as e:
        return False, {"exc": str(e)}, f"EXC: {e}"
    try:
        d = json.loads(b)
    except Exception:
        return False, {"parse_error": b[:200]}, b
    if d.get("challengeProvider"):
        return False, d, b
    if not d.get("loginOptionsToken"):
        return False, d, b
    return True, d, b


def send_temporary_password(email, login_options_token, device_id,
                            use_proxy=True, proxy_country="us",
                            session_id=None):
    """Call sendTemporaryPassword. Returns (passed, parsed, raw)."""
    body = {
        "email": email,
        "redirectURL": REDIRECT_URL,
        "disableLoginLink": False,
        "native": False,
        "isSignup": True,
        "shouldHidePasscode": False,
        "loginOptionsToken": login_options_token,
        "deviceId": device_id,
        "loginRouteOrigin": "signup",
    }
    s, b, hdrs = zenrows_post(
        "https://app.notion.com/api/v3/sendTemporaryPassword", body,
        use_proxy=use_proxy, proxy_country=proxy_country,
        return_headers=True, session_id=session_id)
    try:
        d = json.loads(b)
    except Exception:
        return False, {"parse_error": b[:200], "status": s}, b
    if not d.get("csrfState"):
        return False, d, b
    return True, d, b


def poll_v3mail_for_code(email, since_id=0, max_wait=180, interval=10):
    """Poll v3-mail worker for the Notion code email.

    Returns (code, raw_email_dict) or (None, reason).

    NOTE: the `@` in the email must NOT be URL-encoded to %40 — the worker
    expects the raw @. Using urllib.parse.quote with safe='@' keeps it.
    Also, plain urllib gets bot-blocked by Cloudflare (error 1010) — we
    send a real User-Agent (handled in _get).
    """
    quoted = urllib.parse.quote(email, safe="@")
    url = f"{V3MAIL_BASE}/emails?address={quoted}&limit=20&include_body=true"
    headers = {"Authorization": V3MAIL_TOKEN}
    deadline = time.time() + max_wait
    while time.time() < deadline:
        s, b = _get(url, headers, timeout=30)
        if s != 200:
            time.sleep(interval)
            continue
        try:
            d = json.loads(b)
            rows = d.get("results", [])
        except Exception:
            time.sleep(interval)
            continue
        # Find a Notion code email newer than since_id
        best = None
        for r in rows:
            rid = int(r.get("id", 0))
            if since_id and rid <= since_id:
                continue
            subject = r.get("subject", "") or ""
            from_h = r.get("from_header", "") or ""
            CODEISH = re.compile(
                r"(code|verify|verification|login|passcode|signup|otp|one[- ]?time)",
                re.I)
            if not CODEISH.search(subject):
                continue
            if not re.search(r"notion", from_h + " " + subject, re.I):
                continue
            ts = r.get("received_at") or ""
            # Parse ISO 8601 with Z (Cloudflare worker returns ISO, not strptime-default)
            try:
                # Strip the Z and parse with fromisoformat (3.11+) or strptime fallback
                ts_clean = ts.replace("Z", "+00:00")
                tsep = time.mktime(time.strptime(ts[:19], "%Y-%m-%dT%H:%M:%S"))
            except Exception:
                tsep = 0
            if not best or tsep >= best[0]:
                best = (tsep, r)
        if best:
            r = best[1]
            text = (r.get("text_body", "") or "").strip()
            first_line = (text.split("\n")[0] or "").strip()
            m = None
            if re.match(r"^[A-Za-z0-9]{4,10}$", first_line):
                m = first_line
            else:
                m = re.search(r"\b(?=\w*\d)(?=[^\s]*[A-Za-z])[A-Za-z0-9]{4,10}\b", text)
            if m:
                return (m if isinstance(m, str) else m.group(0)), r
            # Subject fallback
            sm = re.search(r"\b([A-Za-z0-9]{4,10})\b", r.get("subject", ""))
            if sm:
                return sm.group(1), r
            return None, f"code email arrived but no code in body or subject: {r.get('subject')}"
        time.sleep(interval)
    return None, "timeout waiting for code email"


def login_with_email(state, password, use_proxy=True, proxy_country="us",
                      session_id=None):
    """loginWithEmail. Returns (passed, parsed, raw, set_cookie_headers).

    Detects both Notion's error format ({"error": ...}) and Zenros-side
    transient errors (RESP001 etc.) — the latter are NOT passed-on success.
    """
    body = {
        "state": state,
        "password": password,
        "appSource": "notion",
        "loginRouteOrigin": "signup",
    }
    s, b, hdrs = zenrows_post(
        "https://app.notion.com/api/v3/loginWithEmail", body,
        use_proxy=use_proxy, proxy_country=proxy_country,
        return_headers=True, session_id=session_id)
    set_cookie = hdrs.get("Set-Cookie", "") or hdrs.get("set-cookie", "")
    # Zenros-side failure (RESP001 etc.) after all retries → fail
    if _is_zenrows_error(b):
        return False, {"zenros_error": b[:300]}, b, set_cookie
    try:
        d = json.loads(b)
    except Exception:
        return False, {"parse_error": b[:200]}, b, set_cookie
    if d.get("error"):
        return False, d, b, set_cookie
    return True, d, b, set_cookie


def extract_cookies_from_set_cookie(set_cookie_str):
    """Parse the (possibly multi-valued) Set-Cookie header from Zenros."""
    # Zenros may return Set-Cookie as a single concatenated string or a list.
    # Try splitting on comma-between-cookies (preserving Expires= dates).
    cookies = {}
    if not set_cookie_str:
        return cookies
    # Split on cookie boundaries. Set-Cookie fields look like:
    #   name=value; Expires=...; Path=/; HttpOnly; SameSite=Lax, name2=value2; ...
    # We split on ", " only when not inside an Expires= or similar date.
    parts = re.split(r",\s*(?=[A-Za-z0-9_-]+(?:%[0-9A-Fa-f]{2})?=[^;]+;)", set_cookie_str)
    for part in parts:
        m = re.match(r"([^=;\s]+)=([^;]+)", part.strip())
        if m:
            cookies[m.group(1)] = urllib.parse.unquote(m.group(2))
    return cookies


def signup(email=None, max_retries=5, use_proxy=True, proxy_country="us",
           verbose=True):
    """Drive the full Zenros signup flow.

    If email is None, allocate a fresh email on v3-mail.priv.email
    (worker subdomain so the code email is readable via the Bearer API).

    Returns dict: {email, userId, tokenV2, deviceId, clientVersion,
                   isNewSignup, loginResult} on success; {error} on failure.
    """
    if email is None:
        email = f"zen-{int(time.time())}-{uuid.uuid4().hex[:6]}@v3-mail.priv.email"
    device_id = str(uuid.uuid4())
    # session_id pins Zenros to ONE residential IP for all Notion calls in
    # this signup. Notion IP-binds the csrfState: if sendcode and login
    # come from different IPs, login 422s. (Confirmed live 2026-08-26.)
    session_id = f"notion-signup-{uuid.uuid4().hex[:12]}"
    if verbose:
        print(f"[signup] email = {email}")
        print(f"[signup] deviceId = {device_id}")
        print(f"[signup] session_id = {session_id} (pins residential IP)")

    # 1. Probe getLoginOptions until PASS (no captcha)
    login_options_token = None
    for attempt in range(1, max_retries + 1):
        if verbose:
            print(f"[signup] attempt {attempt}/{max_retries}: probing getLoginOptions...")
        ok, parsed, raw = probe_get_login_options(
            email, use_proxy=use_proxy, proxy_country=proxy_country,
            session_id=session_id)
        if ok:
            login_options_token = parsed.get("loginOptionsToken")
            if verbose:
                print(f"[signup] PASS on attempt {attempt} - loginOptionsToken acquired")
            break
        challenge = parsed.get("challengeProvider")
        if verbose:
            print(f"[signup] captcha ({challenge}) - retrying with new email...")
            # Log raw body for non-pass cases to diagnose unexpected shapes
            print(f"[signup]   raw body (first 200): {raw[:200]}")
        # New email, new attempt. Use a NEW session_id per attempt to rotate
        # the residential IP (Notion rate-limits per-IP, so pinning one IP
        # across all retry attempts causes uniform failure after the first
        # rate-limited probe). Once a probe PASSES, we keep that session_id
        # for sendcode + login so the csrfState's bound IP matches.
        session_id = f"notion-signup-{uuid.uuid4().hex[:12]}"
        email = f"zen-{int(time.time())}-{uuid.uuid4().hex[:6]}@v3-mail.priv.email"
        if verbose:
            print(f"[signup] new email = {email}")
            print(f"[signup] new session_id = {session_id}")
        time.sleep(5)  # pace to avoid rate limit
    if not login_options_token:
        return {"error": "all attempts hit captcha", "last_email": email}

    # 2. Baseline the v3-mail inbox to know the since_id
    quoted = urllib.parse.quote(email, safe="@")
    url = f"{V3MAIL_BASE}/emails?address={quoted}&limit=20&include_body=true"
    s, b = _get(url, {"Authorization": V3MAIL_TOKEN}, timeout=30)
    since_id = 0
    if s == 200:
        try:
            d = json.loads(b)
            for r in d.get("results", []):
                rid = int(r.get("id", 0))
                if rid > since_id:
                    since_id = rid
        except Exception:
            pass
    if verbose:
        print(f"[signup] mail baseline since_id = {since_id}")

    # 3. sendTemporaryPassword
    if verbose:
        print(f"[signup] sending temporary password...")
    ok, parsed, raw = send_temporary_password(
        email, login_options_token, device_id,
        use_proxy=use_proxy, proxy_country=proxy_country,
        session_id=session_id)
    if not ok:
        return {"error": "sendTemporaryPassword failed", "parsed": parsed,
                "raw": raw[:300], "email": email}
    csrf_state = parsed.get("csrfState")
    if verbose:
        print(f"[signup] ✅ csrfState acquired, code email should arrive at {email}")

    # 4. Poll v3-mail for code
    if verbose:
        print(f"[signup] polling v3-mail for code email...")
    code, email_row = poll_v3mail_for_code(email, since_id=since_id,
                                            max_wait=180, interval=10)
    if not code:
        return {"error": "code email not received", "detail": email_row,
                "email": email}
    if verbose:
        print(f"[signup] ✅ got code: {code} (from {email_row.get('subject', '')[:60]})")

    # 5. loginWithEmail
    if verbose:
        print(f"[signup] logging in with email + code...")
    ok, parsed, raw, set_cookie = login_with_email(
        csrf_state, code, use_proxy=use_proxy, proxy_country=proxy_country,
        session_id=session_id)
    if not ok:
        return {"error": "loginWithEmail failed", "parsed": parsed,
                "raw": raw[:300], "email": email}

    cookies = extract_cookies_from_set_cookie(set_cookie)
    user_id = cookies.get("notion_user_id") or parsed.get("userId") or ""
    token_v2 = cookies.get("token_v2", "")
    notion_device_id = cookies.get("notion_device_id") or device_id

    if verbose:
        print(f"[signup] ✅ isNewSignup={parsed.get('isNewSignup')}")
        print(f"[signup] userId={user_id}")
        print(f"[signup] tokenV2 (first 60 chars)={token_v2[:60]}...")
        print(f"[signup] deviceId={notion_device_id}")

    if not token_v2:
        return {"error": "no token_v2 cookie in response", "set_cookie": set_cookie[:300],
                "parsed": parsed, "email": email}

    return {
        "email": email,
        "userId": user_id,
        "tokenV2": token_v2,
        "deviceId": notion_device_id,
        "clientVersion": NOTION_VER,
        "isNewSignup": parsed.get("isNewSignup", False),
        "loginResult": parsed,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--email", help="specific email to use (else fresh on v3-mail.priv.email)")
    ap.add_argument("--max-retries", type=int, default=5)
    ap.add_argument("--out", default="/tmp/zen_signup_creds.json")
    ap.add_argument("--proxy-country", default="us")
    ap.add_argument("--no-proxy", action="store_true")
    args = ap.parse_args()

    use_proxy = not args.no_proxy
    try:
        result = signup(email=args.email, max_retries=args.max_retries,
                        use_proxy=use_proxy, proxy_country=args.proxy_country,
                        verbose=True)
    except Exception as e:
        import traceback
        result = {"error": f"unhandled exception: {e}", "traceback": traceback.format_exc()}
        print(f"\n[main] unhandled exception: {e}")
        traceback.print_exc()

    with open(args.out, "w") as f:
        json.dump(result, f, indent=2, default=str)
    print(f"\n[result] saved to {args.out}")
    print(json.dumps(result, indent=2, default=str)[:800])


if __name__ == "__main__":
    main()
