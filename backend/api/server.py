"""REST API for the onboard-automation backend (127.0.0.1:3001).

API-first: every operation is triggerable programmatically (curl);
the web UX (Next.js on :3000) is a plain consumer of these endpoints.

Run:   python3 backend/api/serve_daemon.py   (daemon; logs data/api.log)
  or:  python3 -m backend.api.server         (foreground)
Probe: curl -s localhost:3001/api/health
"""
from __future__ import annotations

import json
import os
import time
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from . import config
from .db import DB, creds_from_account, session_path_for
from .drivers import get_driver
from .runner import JobRunner


# ---------------------------------------------------------------- bodies
class SignupBody(BaseModel):
    email: str | None = None
    country: str = config.DEFAULT_COUNTRY
    attempts: int = Field(default=config.DEFAULT_SIGNUP_ATTEMPTS, ge=1, le=10)
    run_tail: bool = True
    tail: "TailBody | None" = None


class TailBody(BaseModel):
    workspaces: int = Field(default=1, ge=1, le=5)
    chat_prompt: str = "What is 2+2? Answer with just the number."
    route: str = "auto"
    workspace_name: str = "Onboard Workspace"
    trial_pace_s: int = config.DEFAULT_TRIAL_PACE_S


class BatchBody(BaseModel):
    count: int = Field(default=2, ge=1, le=config.BATCH_MAX_COUNT)
    country: str | None = None
    countries: list[str] | None = None     # rotate across these
    cooldown_seconds: float = Field(
        default=config.DEFAULT_BATCH_COOLDOWN_S, ge=0, le=3600)
    attempts: int = Field(default=config.DEFAULT_SIGNUP_ATTEMPTS, ge=1, le=10)
    tail: TailBody | None = None


class ChatBody(BaseModel):
    prompt: str = Field(min_length=1, max_length=4000)
    model: str | None = None
    effort: str | None = None
    space_id: str | None = None
    context_page_id: str | None = None
    thread_id: str | None = None
    route: str = "auto"


class CancelBody(BaseModel):
    pass


def create_app(db: DB | None = None, runner: JobRunner | None = None,
               driver_name: str = "notion") -> FastAPI:
    app = FastAPI(title="onboard-automation backend",
                  version="1.1.0", docs_url="/api/docs")
    app.add_middleware(
        CORSMiddleware,
        # the web UX reaches this API through the Caddy gateway
        # (?XTransformPort=3001) from any preview origin — the backend is
        # loopback-bound, so permissive CORS is safe here.
        allow_origins=["*"],
        allow_methods=["*"], allow_headers=["*"])
    db = db or DB()
    # eager runner construction: a lazy path here would race two
    # JobRunners into existence (and the 2nd's recover_stale_jobs would
    # fail the 1st's just-queued job)
    if runner is None:
        runner = JobRunner(db, driver_name)
    state = {"db": db, "runner": runner,
             "driver_name": driver_name}

    def need_runner() -> JobRunner:
        runner.start()          # no-op if alive; safe re-arm after stop()
        return runner

    # ------------------------------------------------------------- meta
    @app.get("/api/health")
    def health() -> dict:
        try:
            drv = get_driver(state["driver_name"])
            deps = drv.health()
        except Exception as e:                            # noqa: BLE001
            deps = {"ok": False, "error": str(e)[:200]}
        return {"status": "ok", "service": state["driver_name"],
                "version": app.version, "db": os.path.relpath(
                    db.path, config.REPO_ROOT), "deps": deps}

    @app.get("/api/stats")
    def stats() -> dict:
        return db.stats()

    @app.get("/api/models")
    def models() -> list[dict]:
        return get_driver(state["driver_name"]).list_models()

    @app.get("/api/ips")
    def ips() -> list[dict]:
        return db.ip_summary()

    @app.get("/api/events")
    def events(limit: int = Query(default=50, ge=1, le=500)) -> list[dict]:
        return db.query("SELECT * FROM events ORDER BY id DESC LIMIT ?",
                        (limit,))

    # --------------------------------------------------------- accounts
    @app.get("/api/accounts")
    def list_accounts(limit: int = Query(default=100, ge=1, le=500),
                      offset: int = Query(default=0, ge=0),
                      reveal: bool = False) -> list[dict]:
        return db.list_accounts(limit, offset, reveal)

    @app.get("/api/accounts/{aid}")
    def get_account(aid: int, reveal: bool = False) -> dict:
        row = db.get_account(aid, reveal)
        if not row:
            raise HTTPException(404, f"account {aid} not found")
        return row

    @app.delete("/api/accounts/{aid}")
    def delete_account(aid: int) -> dict:
        row = db.one("SELECT id FROM accounts WHERE id=?", (aid,))
        if not row:
            raise HTTPException(404, f"account {aid} not found")
        db.execute("DELETE FROM accounts WHERE id=?", (aid,))
        db.add_event("account_deleted", detail={"account_id": aid})
        return {"deleted": aid}

    @app.post("/api/accounts/{aid}/export-session")
    def export_session(aid: int) -> dict:
        """Regenerate the notion_tail session file from stored creds
        (session replay entry point). Only writes when the file is MISSING —
        never clobbers a richer existing session (workspaces/keys/chats)."""
        acct = db.one("SELECT * FROM accounts WHERE id=?", (aid,))
        if not acct:
            raise HTTPException(404, f"account {aid} not found")
        drv = get_driver(state["driver_name"])
        spath = acct["session_path"] or session_path_for(aid, acct["email"])
        if os.path.exists(spath):
            return {"session_path": spath, "email": acct["email"],
                    "has_token": bool(acct["token_v2"]), "created": False}
        if not (acct["token_v2"] and acct["user_id"] and acct["device_id"]):
            raise HTTPException(
                409, f"account {aid} has incomplete creds in the DB "
                     f"(token/user/device) — cannot build a session")
        sess = drv.init_session(creds_from_account(acct), spath)
        db.touch_account_session(aid, spath)
        return {"session_path": spath, "email": sess.get("email"),
                "has_token": bool(sess.get("tokenV2")), "created": True}

    # ------------------------------------------------------------ jobs
    @app.post("/api/signup")
    def signup(body: SignupBody) -> dict:
        params: dict[str, Any] = body.model_dump()
        params["tail"] = (body.tail or TailBody()).model_dump()
        jid = need_runner().enqueue("signup", params)
        return {"job_id": jid, "poll": f"/api/jobs/{jid}"}

    @app.post("/api/batch")
    def batch(body: BatchBody) -> dict:
        params = body.model_dump()
        if body.tail:
            params["tail"] = body.tail.model_dump()
        jid = need_runner().enqueue("batch", params)
        return {"job_id": jid, "poll": f"/api/jobs/{jid}"}

    @app.post("/api/accounts/{aid}/tail")
    def tail(aid: int, body: TailBody) -> dict:
        if not db.one("SELECT id FROM accounts WHERE id=?", (aid,)):
            raise HTTPException(404, f"account {aid} not found")
        params = {"account_id": aid, "tail": body.model_dump()}
        jid = need_runner().enqueue("tail", params)
        return {"job_id": jid, "poll": f"/api/jobs/{jid}"}

    @app.post("/api/accounts/{aid}/chat")
    def chat(aid: int, body: ChatBody) -> dict:
        if not db.one("SELECT id FROM accounts WHERE id=?", (aid,)):
            raise HTTPException(404, f"account {aid} not found")
        params = body.model_dump() | {"account_id": aid}
        jid = need_runner().enqueue("chat", params)
        return {"job_id": jid, "poll": f"/api/jobs/{jid}"}

    @app.get("/api/jobs")
    def jobs(limit: int = Query(default=50, ge=1, le=500)) -> list[dict]:
        return db.query("SELECT * FROM jobs ORDER BY id DESC LIMIT ?",
                        (limit,))

    @app.get("/api/jobs/{jid}")
    def job(jid: int) -> dict:
        row = db.one("SELECT * FROM jobs WHERE id=?", (jid,))
        if not row:
            raise HTTPException(404, f"job {jid} not found")
        row["items"] = db.query(
            "SELECT * FROM job_items WHERE job_id=? ORDER BY id", (jid,))
        for it in row["items"]:
            it["detail"] = json.loads(it.pop("detail_json") or "null")
        return row

    @app.post("/api/jobs/{jid}/cancel")
    def cancel(jid: int) -> dict:
        row = db.one("SELECT status FROM jobs WHERE id=?", (jid,))
        if not row:
            raise HTTPException(404, f"job {jid} not found")
        if row["status"] in ("done", "failed", "cancelled"):
            return {"job_id": jid, "status": row["status"],
                    "cancelled": False}
        # conditional write — never downgrade a job that just finished
        n = db.execute(
            "UPDATE jobs SET status='cancelled', finished_at=?"
            " WHERE id=? AND status IN ('queued','running')",
            (time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), jid))
        if n:
            db.add_event("job_cancel_requested", job_id=jid)
        return {"job_id": jid, "status": "cancelled",
                "cancelled": bool(n)}

    return app


def main() -> None:
    import uvicorn
    config.ensure_dirs()
    db = DB()
    runner = JobRunner(db, "notion")
    runner.start()
    app = create_app(db, runner, "notion")
    print(f"[api] onboard backend on {config.API_HOST}:{config.API_PORT} "
          f"(db={db.path})", flush=True)
    uvicorn.run(app, host=config.API_HOST, port=config.API_PORT,
                log_level="info")


if __name__ == "__main__":
    main()
