#!/usr/bin/env python3
"""Zenrows retry matrix for Notion signup captcha gate.

The handoff (§3) identified that hCaptcha is decided at `getLoginOptions`
time from request metadata (IP reputation × email-newness × rate). This
script probes `getLoginOptions` across multiple axes and reports which
combos return WITHOUT `challengeProvider: hcaptcha` for a fresh address.

NOTE on the supabase-edge × Zenrows chain (axis B from the handoff):
DROPPED. The supabase proxy docs explicitly state "ASN blocking (AS16509)
All IPs are AWS" is something it cannot defeat, AND it doesn't change what
Notion sees when chained through Zenros (Zenros uses its OWN residential
IPs to talk to Notion, regardless of who talked to api.zenrows.com). The
real region-of-residential-IP knob is Zenros's own `proxy_country` param.
That's what axis E below tests.

Axes:
  A. Email reputation, NO proxy: named aliases on priv.email via Zenros
     direct (datacenter IP to api.zenrows.com, then Zenros fetches the
     Notion signup page from a Zenros datacenter IP, no residential).
     Cheapest signal: does email reputation alone unblock getLoginOptions?
  A2. Same aliases via Zenros premium_proxy=us — Zenros uses a US
      residential IP to talk to Notion. (This is the config that let
      onboard@ pass in the original Zenrows-EVAL.)
  C. Fresh arbitrary emails via Zenros premium_proxy=us — confirms the
     captcha gate still hits unknown addresses.
  E. Region rotation: admin@ priv.email × Zenros premium_proxy × 5
     countries (us/eu/jp/kr/br) — does the residential IP's country
     affect Notion's anti-abuse scoring?
  D. Humanization confirmation: js_render=true + fill+click instructions.
     (Expected null result: captcha is decided at getLoginOptions time,
      before any DOM interaction.)

Cost-aware: each probe is ~5 credits without js_render, ~25 with.
Total full matrix ≈ 25 probes ≈ 130 credits.

Usage:
  python3 signup_matrix.py --axis A     # named aliases, no proxy
  python3 signup_matrix.py --axis A2    # named aliases, premium_proxy us
  python3 signup_matrix.py --axis C     # fresh emails, premium_proxy us
  python3 signup_matrix.py --axis E     # admin@ × 5 countries
  python3 signup_matrix.py --axis D     # humanization null-result
  python3 signup_matrix.py --axis all   # everything
"""
import argparse, json, sys, time, uuid, urllib.parse, urllib.request, urllib.error

ZENROWS_KEY = "0e43f2d6166122fa4b4aa607464f5c7d4d8ce855"
ZENROWS_API = "https://api.zenrows.com/v1/"
SB_PROXY = "https://pxrpbzmnwtxqpvqgqdqt.supabase.co/functions/v1/proxy"
SB_TOKEN = "Bearer test-token-1"
NOTION_VER = "23.13.20260826.0028"  # captured live 2026-08-26 from Zenrows probe

NAMED_ALIASES = ["admin@", "support@", "noreply@", "billing@", "security@"]
DOMAIN = "priv.email"
REGIONS = ["us-east-1", "eu-west-1", "ap-northeast-1", "sa-east-1"]


def _post_json(url, headers, body, timeout=60):
    """POST JSON, return (status, body_text)."""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:
        return 0, f"EXC: {e}"


def _get(url, headers, timeout=60):
    req = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:
        return 0, f"EXC: {e}"


def _parse_get_login_options(body_text):
    """Return dict with has_account, challenge_provider, login_options_token."""
    try:
        d = json.loads(body_text)
    except Exception as e:
        return {"parse_error": str(e), "raw": body_text[:200]}
    return {
        "hasAccount": d.get("hasAccount"),
        "challengeProvider": d.get("challengeProvider"),
        "loginOptionsToken": bool(d.get("loginOptionsToken")),
        "raw_keys": list(d.keys())[:10],
    }


def zenrows_get_login_options(email, use_proxy=False, proxy_country=None,
                              js_render=False, js_instructions=None):
    """POST getLoginOptions via Zenrows, return (status, parsed_dict, raw)."""
    target_url = "https://app.notion.com/api/v3/getLoginOptions"
    headers = {
        "Accept-Encoding": "identity",
        "Content-Type": "application/json",
        "Notion-Audit-Log-Platform": "web",
        "Notion-Client-Version": NOTION_VER,
        "Origin": "https://app.notion.com",
        "Referer": "https://app.notion.com/signup",
    }
    body = {"email": email, "requireWorkTypeEmail": False}
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
    if js_render:
        params["js_render"] = "true"
    if js_instructions:
        params["js_instructions"] = json.dumps(js_instructions)
    qs = urllib.parse.urlencode(params)
    s, b = _post_json(f"{ZENROWS_API}?{qs}", headers, body, timeout=90)
    return s, _parse_get_login_options(b), b


def sb_zenrows_get_login_options(email, region):
    """[DROPPED] Chain supabase-edge -> Zenrows -> Notion.

    KEPT for documentation only — see module docstring for why axis B
    was dropped (supabase proxy doesn't change what Notion sees through
    Zenros; only Zenros's own `proxy_country` matters).
    """
    raise NotImplementedError(
        "Axis B dropped — see module docstring. Use axis E (Zenros proxy_country) instead."
    )


def verdict(parsed):
    """PASS = no challengeProvider and loginOptionsToken present."""
    if "parse_error" in parsed:
        return "PARSE_ERROR"
    if parsed.get("challengeProvider"):
        return f"CAPTCHA({parsed['challengeProvider']})"
    if parsed.get("loginOptionsToken"):
        return "PASS"
    if parsed.get("hasAccount") is True and not parsed.get("challengeProvider"):
        # hasAccount=true with no challengeProvider and no token is suspicious —
        # likely the templated stub from the handoff's "fresh arbitrary addresses"
        return "STUB_hasAccount_no_token"
    return "UNCLEAR"


def run_axis_A():
    """Named aliases via Zenrows, no proxy (the cheapest matrix)."""
    print("\n=== AXIS A: named aliases via Zenrows (no proxy) ===")
    results = []
    for alias in NAMED_ALIASES:
        email = alias + DOMAIN
        print(f"\n[A] probing {email} ...", flush=True)
        s, p, raw = zenrows_get_login_options(email, use_proxy=False)
        v = verdict(p)
        print(f"    HTTP {s} | {v} | hasAccount={p.get('hasAccount')} "
              f"challenge={p.get('challengeProvider')} token={p.get('loginOptionsToken')}")
        if s != 200 or v != "PASS":
            print(f"    raw: {raw[:300]}")
        results.append({"axis": "A", "email": email, "use_proxy": False,
                        "status": s, "verdict": v, "parsed": p})
        time.sleep(2)  # be polite
    # Also try with premium_proxy for the named aliases
    print("\n[A.2] same aliases via Zenrows premium_proxy=us ...", flush=True)
    for alias in NAMED_ALIASES:
        email = alias + DOMAIN
        print(f"\n[A.2] probing {email} (premium_proxy us) ...", flush=True)
        s, p, raw = zenrows_get_login_options(email, use_proxy=True,
                                              proxy_country="us")
        v = verdict(p)
        print(f"    HTTP {s} | {v} | hasAccount={p.get('hasAccount')} "
              f"challenge={p.get('challengeProvider')} token={p.get('loginOptionsToken')}")
        if s != 200 or v != "PASS":
            print(f"    raw: {raw[:300]}")
        results.append({"axis": "A.2", "email": email, "use_proxy": True,
                        "proxy_country": "us", "status": s, "verdict": v,
                        "parsed": p})
        time.sleep(3)
    return results


def run_axis_C():
    """Fresh arbitrary addresses via Zenrows (no proxy + premium_proxy us)."""
    print("\n=== AXIS C: fresh arbitrary emails via Zenrows ===")
    results = []
    for i in range(3):
        email = f"matrix-c-{int(time.time())}-{i}@{DOMAIN}"
        for variant in ("no_proxy", "premium_us"):
            use_proxy = variant == "premium_us"
            print(f"\n[C/{variant}] probing {email} ...", flush=True)
            s, p, raw = zenrows_get_login_options(
                email, use_proxy=use_proxy, proxy_country="us" if use_proxy else None)
            v = verdict(p)
            print(f"    HTTP {s} | {v} | hasAccount={p.get('hasAccount')} "
                  f"challenge={p.get('challengeProvider')} token={p.get('loginOptionsToken')}")
            if s != 200 or v != "PASS":
                print(f"    raw: {raw[:300]}")
            results.append({"axis": "C", "variant": variant, "email": email,
                            "status": s, "verdict": v, "parsed": p})
            time.sleep(3)
    return results


def run_axis_E():
    """Axis E: admin@ × Zenros premium_proxy × 5 countries.

    Per the user's hypothesis: does Notion's anti-abuse score by the
    residential IP's country? If yes, some countries should pass while
    others get captcha. If no, all should pass (or all captcha).

    Note: proxy_country codes use Zenros's 2-letter country codes
    (us, eu is not a country — use specific ones). Per Zenros docs the
    supported values are 2-letter ISO country codes.
    """
    print("\n=== AXIS E: admin@ × Zenros premium_proxy × 5 countries ===")
    countries = ["us", "gb", "jp", "kr", "br"]
    email = "admin@" + DOMAIN
    results = []
    for country in countries:
        print(f"\n[E/{country}] {email} via premium_proxy={country} ...",
              flush=True)
        s, p, raw = zenrows_get_login_options(email, use_proxy=True,
                                              proxy_country=country)
        v = verdict(p)
        print(f"    HTTP {s} | {v} | hasAccount={p.get('hasAccount')} "
              f"challenge={p.get('challengeProvider')} token={p.get('loginOptionsToken')}")
        if s != 200 or v != "PASS":
            print(f"    raw: {raw[:400]}")
        results.append({"axis": "E", "country": country, "email": email,
                        "status": s, "verdict": v, "parsed": p})
        time.sleep(5)  # pace to avoid per-IP rate limit
    return results


def run_axis_D():
    """Humanization null-result confirmation (js_render + fill+click).

    The hypothesis: even with full JS render + form fill + click,
    getLoginOptions STILL returns challengeProvider: hcaptcha for fresh
    emails on Zenrows IPs — proving the gate is metadata-driven, not
    behavior-driven.
    """
    print("\n=== AXIS D: humanization null-result (js_render + fill+click) ===")
    email = f"matrix-d-{int(time.time())}@{DOMAIN}"
    # JS instructions: fill the email field, click Continue, wait
    instructions = [
        {"fill": ["#login-input-email", email]},
        {"click": "button[type=submit]"},
        {"wait": 3000},
    ]
    print(f"\n[D] probing {email} with js_render + instructions ...", flush=True)
    s, p, raw = zenrows_get_login_options(
        email, use_proxy=True, proxy_country="us",
        js_render=True, js_instructions=instructions)
    v = verdict(p)
    print(f"    HTTP {s} | {v} | hasAccount={p.get('hasAccount')} "
          f"challenge={p.get('challengeProvider')} token={p.get('loginOptionsToken')}")
    print(f"    raw: {raw[:500]}")
    return [{"axis": "D", "email": email, "js_render": True,
             "status": s, "verdict": v, "parsed": p}]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--axis", default="all",
                    choices=["A", "A2", "C", "E", "D", "all"])
    ap.add_argument("--out", default="/home/z/my-project/scripts/signup_matrix_results.json")
    args = ap.parse_args()

    all_results = []
    if args.axis in ("A", "all"):
        all_results.extend(run_axis_A())  # already covers A and A.2 inline
    if args.axis in ("C", "all"):
        all_results.extend(run_axis_C())
    if args.axis in ("E", "all"):
        all_results.extend(run_axis_E())
    if args.axis in ("D", "all"):
        all_results.extend(run_axis_D())

    print("\n=== SUMMARY ===")
    pass_count = sum(1 for r in all_results if r["verdict"] == "PASS")
    captcha_count = sum(1 for r in all_results if r["verdict"].startswith("CAPTCHA"))
    other_count = len(all_results) - pass_count - captcha_count
    print(f"Total probes: {len(all_results)} | PASS: {pass_count} | "
          f"CAPTCHA: {captcha_count} | OTHER: {other_count}")
    print("\nBy axis:")
    for axis in sorted({r["axis"] for r in all_results}):
        axis_results = [r for r in all_results if r["axis"] == axis]
        axis_pass = sum(1 for r in axis_results if r["verdict"] == "PASS")
        print(f"  {axis}: {axis_pass}/{len(axis_results)} PASS")

    with open(args.out, "w") as f:
        json.dump(all_results, f, indent=2, default=str)
    print(f"\nResults saved to {args.out}")


if __name__ == "__main__":
    main()
