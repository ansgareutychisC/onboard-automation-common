"""NotionDriver — productizes the live-verified Notion onboarding flow.

Reuses EXACTLY the code paths that passed live E2E (2026-08-26):
  signup    scripts/notion_signup_warm.js   (ONE warm Zenrows Browser
            Session: session-pinned residential IP across the whole auth
            flow — satisfies Notion's csrfState IP-binding)
  provision backend/notion_e2e.py run_tail  (resume→workspace→onboarding→
            trial→apikey→chat per workspace, trial pacing built in) plus
            the optional extended steps (models/page/instruct/skill) from
            backend/notion_tail.py
  chat      notion_tail.step_chat           (NDJSON transcript, model select,
            context pages, follow-up threads)

No browser extension involved anywhere — this is the L4 route
(SKILL.md §9.1).
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from typing import Any

from .. import config
from .base import (ChatOptions, ServiceDriver, SignupOptions, TailOptions,
                   _noop)

_WARM_JS = os.path.join(config.SCRIPTS_DIR, "notion_signup_warm.js")
_MODELS_JSON = os.path.join(config.BACKEND_DIR, "notion_models_live.json")


def _evt(on_event, kind: str, **detail) -> None:
    try:
        on_event(kind, detail)
    except Exception:                                    # pragma: no cover
        pass


class NotionDriver(ServiceDriver):
    name = "notion"

    # ------------------------------------------------------------- health
    def health(self) -> dict:
        node = shutil.which("node")
        pw = os.path.isdir(os.path.join(config.NODE_PATH, "playwright"))
        ref = os.path.isdir(config.NOTION_REF_PATH)
        out: dict[str, Any] = {
            "node": bool(node),
            "playwright": pw,
            "zenrows_key": bool(config.ZENROWS_API_KEY),
            "notion_ref": ref,
            "warm_driver": os.path.exists(_WARM_JS),
            "models_file": os.path.exists(_MODELS_JSON),
        }
        try:
            self._ensure_imports()
            out["tail_import"] = True
        except Exception as e:                           # pragma: no cover
            out["tail_import"] = f"FAIL: {e}"
        out["ok"] = all(v is True for k, v in out.items() if k != "ok")
        return out

    # ---------------------------------------------------- module loading
    def _ensure_imports(self):
        """Import notion_tail/notion_e2e once (they sys.path themselves)."""
        nt = sys.modules.get("notion_tail")
        if nt is None:
            for p in (config.BACKEND_DIR, config.SCRIPTS_DIR):
                if p not in sys.path:
                    sys.path.insert(0, p)
            import notion_tail  # noqa: F401
            import notion_e2e  # noqa: F401
            nt = sys.modules["notion_tail"]
        return nt, sys.modules["notion_e2e"]

    # ------------------------------------------------------------ signup
    def signup(self, opts: SignupOptions, on_event=_noop) -> dict:
        out = os.path.join(config.DATA_DIR,
                           f"warm_creds_{os.getpid()}_{int(time.time())}.json")
        cmd = ["node", _WARM_JS, "--attempts", str(opts.attempts),
               "--country", opts.country, "--out", out]
        if opts.email:
            cmd += ["--email", opts.email]
        env = dict(os.environ)
        env["NODE_PATH"] = config.NODE_PATH + os.pathsep + \
            env.get("NODE_PATH", "")
        _evt(on_event, "signup_start", cmd=" ".join(cmd[1:]),
             email=opts.email, country=opts.country)
        t0 = time.time()
        # warm signup worst case: 5 attempts × (connect+flow+pace) ≈ 10 min
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=900,
                           env=env, cwd=config.REPO_ROOT)
        tail = "\n".join((p.stdout or "").splitlines()[-12:])
        if p.returncode != 0 or not os.path.exists(out):
            raise RuntimeError(
                f"warm signup failed rc={p.returncode} after "
                f"{time.time()-t0:.0f}s:\n{tail}")
        with open(out) as f:
            creds = json.load(f)
        try:
            os.unlink(out)
        except OSError:
            pass
        if not creds.get("tokenV2"):
            raise RuntimeError("signup returned no tokenV2 — creds incomplete")
        creds.setdefault("proxyCountry", opts.country)
        _evt(on_event, "signup_done", email=creds.get("email"),
             ip=creds.get("signupIp"), country=creds.get("proxyCountry"),
             seconds=round(time.time() - t0, 1))
        return creds

    # ---------------------------------------------------- session files
    def init_session(self, creds: dict, session_path: str) -> dict:
        nt, _ = self._ensure_imports()
        sess = {
            "email": creds.get("email", ""),
            "userId": creds["userId"],
            "deviceId": creds["deviceId"],
            "tokenV2": creds["tokenV2"],
            "clientVersion": creds.get(
                "clientVersion", nt.CLIENT_VERSION_FALLBACK),
            "createdAt": time.time(),
            "space": {}, "spaces": [], "chats": [],
        }
        os.makedirs(os.path.dirname(session_path), exist_ok=True)
        nt.save_session(session_path, sess)
        return sess

    def _load_or_init(self, creds: dict, session_path: str) -> dict:
        nt, _ = self._ensure_imports()
        if os.path.exists(session_path):
            return nt.load_session(session_path)
        return self.init_session(creds, session_path)

    # -------------------------------------------------------- provision
    def provision(self, creds: dict, session_path: str, opts: TailOptions,
                  on_event=_noop) -> dict:
        nt, e2e = self._ensure_imports()
        R = nt.load_ref(config.NOTION_REF_PATH)
        sess = self._load_or_init(creds, session_path)
        zkey = config.ZENROWS_API_KEY

        _evt(on_event, "tail_start", route=opts.route,
             workspaces=opts.workspaces)
        t0 = time.time()
        outcomes = e2e.run_tail(
            R, sess, session_path, opts.route, zkey, opts.workspaces,
            opts.chat_prompt)
        for label, res in outcomes:
            _evt(on_event, "step", label=label, result=res)

        # extended steps (optional, per live-verified notion_tail CLI):
        # models -> page1 -> instruct(page1) -> page2 -> skill(page2).
        # NOTE: notion_tail's CLI helpers signal arg problems via sys.exit()
        # → SystemExit, which is a BaseException — catch it explicitly so a
        # mis-sequenced step can NEVER kill the runner thread.
        def _safe(fn, *a, label="") -> dict:
            try:
                res = fn(*a)
                _evt(on_event, "step", label=label, result=res)
                return res if isinstance(res, dict) else {"ok": True}
            except (Exception, SystemExit) as e:         # noqa: BLE001
                res = {"error": f"{type(e).__name__}: {e}"[:200]}
                _evt(on_event, "step", label=label, result=res)
                return res

        ns = e2e.TailArgs(opts.chat_prompt, opts.workspace_name)
        ns.page_title = "Automation Page"
        ns.page_content = ""
        ns.page_id = None
        outcomes.append(("x:models", _safe(
            nt.step_models, R, sess, opts.route, zkey, ns, label="x:models")))
        page_res = _safe(nt.step_page, R, sess, opts.route, zkey, ns,
                         label="x:page")
        outcomes.append(("x:page", page_res))
        # instruct needs a page: only run if page creation succeeded
        if not page_res.get("error"):
            outcomes.append(("x:instruct", _safe(
                nt.step_instruct, R, sess, opts.route, zkey, ns,
                label="x:instruct")))
        else:
            outcomes.append(("x:instruct", {"skipped": "no page"}))
        # skill needs its OWN page (one prompt row per page — live-confirmed
        # PostgresUniqueViolation when reusing the instruction page)
        ns2 = e2e.TailArgs(opts.chat_prompt, opts.workspace_name)
        ns2.page_title = "Automation Skill"
        ns2.page_content = ""
        sp_res = _safe(nt.step_page, R, sess, opts.route, zkey, ns2,
                       label="x:skill-page")
        outcomes.append(("x:skill-page", sp_res))
        if not sp_res.get("error"):
            outcomes.append(("x:skill", _safe(
                nt.step_skill, R, sess, opts.route, zkey, ns2,
                label="x:skill")))
        else:
            outcomes.append(("x:skill", {"skipped": "no page"}))

        nt.save_session(session_path, sess)
        _evt(on_event, "tail_done", seconds=round(time.time() - t0, 1))
        return {"outcomes": [{"label": l, "result": r} for l, r in outcomes],
                "session": sess}

    # ------------------------------------------------------------- chat
    def chat(self, creds: dict, session_path: str, opts: ChatOptions,
             on_event=_noop) -> dict:
        nt, _ = self._ensure_imports()
        R = nt.load_ref(config.NOTION_REF_PATH)
        sess = self._load_or_init(creds, session_path)

        if opts.space_id:
            match = [s for s in (sess.get("spaces") or [])
                     if s.get("id") == opts.space_id]
            if not match:
                raise ValueError(
                    f"space {opts.space_id} not in session spaces "
                    f"{[s.get('id') for s in sess.get('spaces') or []]}")
            sess["space"] = match[0]
            nt.save_session(session_path, sess)

        ns = nt.argparse.Namespace(
            prompt=opts.prompt, workspace_name="Onboard Workspace",
            workspace_icon="🚀", new_workspace=False, activate=False,
            trial_days=14, api_key_name="automation-pat",
            api_key_expiration="1_year", page_title="", page_content="",
            page_id=None, chat_model=opts.model, chat_effort=opts.effort,
            chat_context_page=opts.context_page_id, chat_block=None,
            chat_thread=opts.thread_id)
        _evt(on_event, "chat_start", prompt=opts.prompt[:80],
             model=opts.model, space=sess.get("space", {}).get("id"))
        try:
            rec = nt.step_chat(R, sess, opts.route, config.ZENROWS_API_KEY,
                               ns)
        except SystemExit as e:                           # CLI arg signal
            raise RuntimeError(f"chat step rejected: {e}") from e
        nt.save_session(session_path, sess)
        _evt(on_event, "chat_done", reply=(rec.get("reply") or "")[:120],
             model=rec.get("model"))
        return rec

    # ----------------------------------------------------------- models
    def list_models(self) -> list[dict]:
        """Surfaced (business-trial) models: codename, family, display name,
        supported reasoning efforts."""
        try:
            with open(_MODELS_JSON) as f:
                data = json.load(f)
        except (OSError, json.JSONDecodeError):
            return []
        models = ((data or {}).get("available") or {}).get("models") or []
        out = []
        for m in models:
            if not isinstance(m, dict) or not m.get("model"):
                continue
            cfg = m.get("modelConfiguration") or {}
            out.append({
                "codename": m["model"],
                "name": m.get("modelMessage") or m["model"],
                "family": m.get("modelFamily") or m.get("modelProvider"),
                "display_group": m.get("displayGroup"),
                "efforts": cfg.get("supportedReasoningEfforts") or [],
                "default_effort": cfg.get("defaultReasoningEffort"),
                "context_tokens": cfg.get("maxContextTokens"),
            })
        return out
