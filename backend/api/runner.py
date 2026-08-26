"""Background job runner — sequential by design.

WHY sequential (not parallel): the Zenrows Browser Session plan gives ONE
concurrent remote-browser slot, and the target rate-limits identity-creating
mutations per IP (SKILL.md §9.2.4). Batch throughput therefore comes from
retries+rotation inside one signup, and PACING between accounts — not from
parallelism. The hook for future parallelism is `cooldown_seconds` +
per-country rotation: when a second vendor slot exists, spread accounts
across countries.

Job graph:
  POST /api/signup  -> job(type=signup)   [items: signup, tail?]
  POST /api/batch   -> job(type=batch)    [items: acct-N:signup, acct-N:tail]
  POST /api/.../tail -> job(type=tail)
  POST /api/.../chat -> job(type=chat)

All progress lands in job_items + events (DB), so the UI polls
GET /api/jobs/{id} and renders live.
"""
from __future__ import annotations

import json
import queue
import threading
import time
import traceback
from typing import Any, Callable

from . import config
from .db import DB, creds_from_account, session_path_for
from .drivers import (ChatOptions, ServiceDriver, SignupOptions,
                      TailOptions, get_driver)

EventHandler = Callable[[int, str, dict], None]   # (job_id, kind, detail)


class JobRunner:
    def __init__(self, db: DB, driver_name: str = "notion"):
        self.db = db
        self.driver_name = driver_name
        self._q: queue.Queue[int] = queue.Queue()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._listeners: list[EventHandler] = []
        self._lock = threading.Lock()
        n = self.db.recover_stale_jobs()
        if n:
            self.db.add_event("runner_recovered", detail={"stale_jobs": n})

    # ------------------------------------------------------- lifecycle
    def start(self) -> None:
        # lock-guarded: two concurrent enqueue()s on a dead thread must not
        # spawn two loops (parallel jobs would break the sequential design
        # — one vendor browser slot, per-IP rate limits)
        with self._lock:
            if self._thread and self._thread.is_alive():
                return
            self._stop.clear()   # re-arm after stop(): don't strand jobs
            # drain stale stop-sentinels from a previous stop() — otherwise
            # the fresh loop consumes -1 and exits immediately, stranding
            # everything enqueued after the restart
            keep = []
            while True:
                try:
                    v = self._q.get_nowait()
                except queue.Empty:
                    break
                if v != -1:
                    keep.append(v)
            for v in keep:
                self._q.put(v)
            self._thread = threading.Thread(target=self._loop,
                                            name="job-runner", daemon=True)
            self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._q.put(-1)
        if self._thread and self._thread is not threading.current_thread():
            self._thread.join(timeout=5)

    def add_listener(self, fn: EventHandler) -> None:
        with self._lock:
            self._listeners.append(fn)

    def _emit(self, job_id: int | None, kind: str, detail: dict) -> None:
        with self._lock:
            listeners = list(self._listeners)
        for fn in listeners:
            try:
                fn(job_id, kind, detail)
            except Exception:                            # pragma: no cover
                pass

    # --------------------------------------------------------- enqueue
    def enqueue(self, jtype: str, params: dict) -> int:
        jid = self.db.create_job(jtype, params)
        self.db.add_event("job_enqueued", job_id=jid, detail={
            "type": jtype, "params": params})
        self._q.put(jid)
        self.start()
        return jid

    # -------------------------------------------------------- the loop
    def _loop(self) -> None:
        while not self._stop.is_set():
            jid = self._q.get()
            if jid == -1:
                break
            try:
                self._run_job(jid)
            except BaseException as e:                   # noqa: BLE001
                # SystemExit from in-process CLI helpers (notion_tail uses
                # sys.exit for arg validation) MUST NOT kill the runner
                # thread — a dead thread leaves jobs 'running' forever.
                print(f"[runner] FATAL in job {jid}: {e!r}", flush=True)
                try:
                    self.db.set_job(jid, status="failed",
                                    error=f"{type(e).__name__}: {e}"[:500],
                                    finished_at=self._ts())
                except Exception:                        # noqa: BLE001
                    pass
                traceback.print_exc()
        print("[runner] loop exited", flush=True)

    def _run_job(self, jid: int) -> None:
        job = self.db.one("SELECT * FROM jobs WHERE id=?", (jid,))
        if not job or job["status"] not in ("queued",):
            return
        params = json.loads(job["params_json"] or "{}")
        self.db.set_job(jid, status="running", started_at=self._ts())
        self._emit(jid, "job_started", {"type": job["type"]})
        driver = get_driver(self.driver_name)
        try:
            if job["type"] == "signup":
                self._do_signup(jid, driver, params, standalone=True)
            elif job["type"] == "batch":
                self._do_batch(jid, driver, params)
            elif job["type"] == "tail":
                self._do_tail(jid, driver, params)
            elif job["type"] == "chat":
                self._do_chat(jid, driver, params)
            else:                                        # pragma: no cover
                raise ValueError(f"unknown job type {job['type']}")
            status = self.db.one(
                "SELECT status FROM jobs WHERE id=?", (jid,))["status"]
            if status == "running":   # a cancelled job keeps 'cancelled'
                # conditional write — a cancel landing between the read and
                # this write must NOT be overwritten back to done
                n = self.db.execute(
                    "UPDATE jobs SET status='done', finished_at=?"
                    " WHERE id=? AND status='running'",
                    (self._ts(), jid))
                if n:
                    self._emit(jid, "job_done", {})
        except _Cancelled:
            # conditional: only flip non-terminal states (a job that just
            # finished done must not be downgraded)
            self.db.execute(
                "UPDATE jobs SET status='cancelled', finished_at=?"
                " WHERE id=? AND status IN ('queued','running')",
                (self._ts(), jid))
            self._emit(jid, "job_cancelled", {})
        except Exception as e:
            self.db.set_job(jid, status="failed", error=str(e)[:500],
                            finished_at=self._ts())
            self.db.add_event("job_failed", job_id=jid,
                              detail={"error": str(e)[:500]})
            self._emit(jid, "job_failed", {"error": str(e)[:200]})

    @staticmethod
    def _ts() -> str:
        return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    def _check_cancel(self, jid: int) -> None:
        row = self.db.one("SELECT status FROM jobs WHERE id=?", (jid,))
        if row and row["status"] == "cancelled":
            raise _Cancelled()

    # ----------------------------------------------------- job bodies
    def _signup_with_tracking(self, jid: int, driver: ServiceDriver,
                              params: dict, label: str) -> int:
        """signup -> DB account row. Returns account id. Raises on failure."""
        item = self.db.add_job_item(jid, label, status="running")
        try:
            self._check_cancel(jid)
            so = SignupOptions(
                email=params.get("email"),
                country=params.get("country") or config.DEFAULT_COUNTRY,
                attempts=int(params.get("attempts")
                              or config.DEFAULT_SIGNUP_ATTEMPTS))
            t0 = time.time()

            def on_event(kind: str, detail: dict) -> None:
                self.db.set_job_item(item, "running", detail)
                self._emit(jid, f"signup.{kind}", detail)

            # cancel probe: lets the driver kill a live signup subprocess
            # instead of blocking the runner for up to 15 min
            cancel_fn = (lambda: (self.db.one(
                "SELECT status FROM jobs WHERE id=?", (jid,))
                or {}).get("status") == "cancelled")
            creds = driver.signup(so, on_event=on_event, cancel_fn=cancel_fn)
            aid = self.db.upsert_account_from_creds(creds)
            self.db.add_event("signup_ok", account_id=aid, job_id=jid,
                              detail={"email": creds.get("email"),
                                      "ip": creds.get("signupIp"),
                                      "country": creds.get("proxyCountry"),
                                      "seconds": round(time.time() - t0, 1)})
            self.db.set_job_item(
                item, "done", {"account_id": aid, "email": creds.get("email"),
                               "ip": creds.get("signupIp"),
                               "country": creds.get("proxyCountry")})
            return aid
        except Exception as e:
            self.db.set_job_item(item, "failed", {"error": str(e)[:300]})
            self.db.add_event("signup_fail", job_id=jid,
                              detail={"error": str(e)[:300]})
            # a driver-side cancel (killed subprocess) converts to the
            # cooperative cancel signal so the job ends 'cancelled'
            row = self.db.one("SELECT status FROM jobs WHERE id=?", (jid,))
            if row and row["status"] == "cancelled":
                raise _Cancelled() from e
            raise

    def _tail_with_tracking(self, jid: int, driver: ServiceDriver,
                            aid: int, params: dict, label: str) -> dict:
        """provision an existing account; syncs results into the DB."""
        item = self.db.add_job_item(jid, label, account_id=aid,
                                    status="running")
        acct = self.db.one("SELECT * FROM accounts WHERE id=?", (aid,))
        if not acct:
            self.db.set_job_item(item, "failed", {"error": "no account"})
            raise ValueError(f"account {aid} not found")
        try:
            self._check_cancel(jid)
            creds = creds_from_account(acct)
            spath = acct["session_path"] or session_path_for(aid, acct["email"])
            top = params.get("tail") or {}
            to = TailOptions(
                workspaces=max(1, int(top.get("workspaces", 1))),
                chat_prompt=top.get(
                    "chat_prompt", "What is 2+2? Answer with just the number."),
                route=top.get("route", "auto"),
                workspace_name=top.get("workspace_name", "Onboard Workspace"),
                trial_pace_s=int(top.get("trial_pace_s",
                                         config.DEFAULT_TRIAL_PACE_S)))

            def on_event(kind: str, detail: dict) -> None:
                self.db.set_job_item(item, "running", {kind: detail})
                self._emit(jid, f"tail.{kind}", detail)

            out = driver.provision(creds, spath, to, on_event=on_event)
            self.db.sync_session(aid, out["session"])
            self.db.touch_account_session(aid, spath)
            errs = [o["label"] for o in out["outcomes"]
                    if isinstance(o.get("result"), dict)
                    and o["result"].get("error")]
            # a tail whose every step errored must NOT report success:
            # item failed + account stays non-provisioned
            self.db.set_job_item(item, "failed" if errs else "done",
                                 {"steps": len(out["outcomes"]),
                                  "step_errors": errs})
            self.db.set_account_status(
                aid, "provisioned" if not errs else "failed", spath)
            self.db.add_event("tail_ok" if not errs else "tail_partial",
                              account_id=aid, job_id=jid,
                              detail={"steps": len(out["outcomes"]),
                                      "errors": errs})
            return out
        except Exception as e:
            self.db.set_job_item(item, "failed", {"error": str(e)[:300]})
            self.db.add_event("tail_fail", account_id=aid, job_id=jid,
                              detail={"error": str(e)[:300]})
            raise

    def _do_signup(self, jid: int, driver: ServiceDriver, params: dict,
                   standalone: bool) -> None:
        aid = self._signup_with_tracking(jid, driver, params, "signup")
        if params.get("run_tail", standalone):
            self._tail_with_tracking(
                jid, driver, aid, params, "tail")

    def _do_batch(self, jid: int, driver: ServiceDriver, params: dict) -> None:
        count = max(1, min(int(params.get("count", 1)),
                           config.BATCH_MAX_COUNT))
        cooldown = float(params.get("cooldown_seconds",
                                    config.DEFAULT_BATCH_COOLDOWN_S))
        countries = params.get("countries") or [params.get("country")
                                                or config.DEFAULT_COUNTRY]
        ok = failed = 0
        for i in range(count):
            self._check_cancel(jid)
            params_i = {**params,
                        "country": countries[i % len(countries)]}
            if i > 0 and cooldown > 0:
                self._emit(jid, "batch.cooldown",
                           {"seconds": cooldown,
                            "next_index": i})
                # interruptible cooldown
                for _ in range(int(cooldown)):
                    self._check_cancel(jid)
                    time.sleep(1)
            try:
                aid = self._signup_with_tracking(
                    jid, driver, params_i, f"acct-{i+1}:signup")
                self._tail_with_tracking(
                    jid, driver, aid, params_i, f"acct-{i+1}:tail")
                ok += 1
            except _Cancelled:
                raise
            except Exception as e:                       # noqa: BLE001
                failed += 1
                self._emit(jid, "batch.account_failed",
                           {"index": i + 1, "error": str(e)[:200]})
                # keep going: batch semantics = best effort per account
        self.db.add_job_item(
            jid, "summary", status="done",
            detail={"ok": ok, "failed": failed})

    def _do_tail(self, jid: int, driver: ServiceDriver, params: dict) -> None:
        self._tail_with_tracking(jid, driver, int(params["account_id"]),
                                 params, "tail")

    def _do_chat(self, jid: int, driver: ServiceDriver, params: dict) -> None:
        aid = int(params["account_id"])
        item = self.db.add_job_item(jid, "chat", account_id=aid,
                                    status="running")
        acct = self.db.one("SELECT * FROM accounts WHERE id=?", (aid,))
        if not acct:
            self.db.set_job_item(item, "failed", {"error": "no account"})
            raise ValueError(f"account {aid} not found")
        try:
            self._check_cancel(jid)
            creds = creds_from_account(acct)
            spath = acct["session_path"] or session_path_for(aid, acct["email"])
            co = ChatOptions(
                prompt=params["prompt"],
                model=params.get("model"),
                effort=params.get("effort"),
                space_id=params.get("space_id"),
                context_page_id=params.get("context_page_id"),
                thread_id=params.get("thread_id"),
                route=params.get("route", "auto"))

            def on_event(kind: str, detail: dict) -> None:
                self.db.set_job_item(item, "running", detail)
                self._emit(jid, f"chat.{kind}", detail)

            rec = driver.chat(creds, spath, co, on_event=on_event)
            # persist the chat into the DB (the session file was already
            # updated by the driver; sync picks up the new thread record)
            try:
                sess = driver.load_session_file(spath)
            except (OSError, ValueError) as e:
                sess = {}
                self._emit(jid, "chat.session_reload_failed",
                           {"error": str(e)[:160]})
            if sess:
                self.db.sync_session(aid, sess)
            self.db.set_job_item(item, "done", {
                "reply": rec.get("reply"), "model": rec.get("model"),
                "thread_id": rec.get("threadId"),
                "tokens": rec.get("tokens")})
            self.db.add_event("chat_ok", account_id=aid, job_id=jid,
                              detail={"model": rec.get("model"),
                                      "chars": len(rec.get("reply") or "")})
        except Exception as e:
            self.db.set_job_item(item, "failed", {"error": str(e)[:300]})
            raise


class _Cancelled(Exception):
    """Internal control-flow for cancelled jobs."""
