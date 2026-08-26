"""Unit/integration tests for the productized backend (no live network).

Run:  python3 -m pytest backend/api/tests -q
"""
from __future__ import annotations

import json
import os
import sys
import threading
import time

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.abspath(os.path.join(HERE, "..", "..", "..")))

import backend.api.drivers as drvmod              # noqa: E402
from backend.api import config                     # noqa: E402
from backend.api.db import DB, creds_from_account, session_path_for  # noqa: E402
from backend.api.drivers.base import (ChatOptions, SignupOptions,     # noqa: E402
                                      TailOptions)
from backend.api.runner import JobRunner           # noqa: E402
from backend.api.server import create_app          # noqa: E402

CREDS = {
    "email": "test-1@v3-mail.priv.email",
    "userId": "u-123",
    "deviceId": "d-456",
    "tokenV2": "v03%3AeyJfake.fake.fake",
    "clientVersion": "23.13.20260826.0537",
    "createdAt": 1756166400,
    "isNewSignup": True,
    "route": "zenrows-browser-session",
    "signupIp": "108.200.73.169",
    "proxyCountry": "us",
    "cookies": {"token_v2": "v03%3AeyJfake.fake.fake",
                "notion_user_id": "u-123"},
}

SESSION = {
    "email": CREDS["email"], "userId": "u-123", "deviceId": "d-456",
    "tokenV2": "v03%3AeyJfake.fake.fake",
    "clientVersion": "23.13.20260826.0537",
    "space": {"id": "sp-1", "name": "Onboard Workspace", "viewId": "v-1"},
    "spaces": [{"id": "sp-1", "name": "Onboard Workspace", "viewId": "v-1"}],
    "trials": {"sp-1": {"status": "trialing", "tier": "business",
                        "type": "subscribed_admin"}},
    "apiKeys": {"sp-1": {"token": "ntn_fake123", "name": "automation-pat",
                         "verified": True}},
    "chats": [{"threadId": "t-1", "prompt": "2+2?", "reply": "4",
               "model": "opal-quince", "outcome": {"status": "completed"},
               "spaceId": "sp-1", "route": "direct", "tokens": {}}],
    "pages": [{"id": "pg-1", "title": "Automation Page",
               "url": "https://notion.so/pg-1", "kind": "page"}],
}


@pytest.fixture()
def db(tmp_path):
    return DB(str(tmp_path / "test.db"))


def wait_job(db, jid, timeout=15):
    t0 = time.time()
    while time.time() - t0 < timeout:
        row = db.one("SELECT status FROM jobs WHERE id=?", (jid,))
        if row["status"] in ("done", "failed", "cancelled"):
            return row["status"]
        time.sleep(0.05)
    return "timeout"


def fake_driver_class(fake):
    """Build a driver FACTORY whose instances share `fake` (for registry
    patching via monkeypatch.setitem — auto-reverts, no leaks)."""
    return type("FakeDriverFactory", (), {"__new__": staticmethod(lambda cls: fake)})


# ------------------------------------------------------------------ db.py
class TestDB:
    def test_schema_and_upsert(self, db):
        aid = db.upsert_account_from_creds(CREDS)
        row = db.one("SELECT * FROM accounts WHERE id=?", (aid,))
        assert row["email"] == CREDS["email"]
        assert row["signup_ip"] == "108.200.73.169"
        assert row["proxy_country"] == "us"
        assert row["mail_provider"] == "v3-mail"
        # idempotent on same email
        aid2 = db.upsert_account_from_creds(CREDS)
        assert aid2 == aid
        assert db.stats()["accounts"] == 1

    def test_sync_session_idempotent(self, db):
        aid = db.upsert_account_from_creds(CREDS)
        db.sync_session(aid, SESSION)
        db.sync_session(aid, SESSION)      # twice — no dupes
        ws = db.query("SELECT * FROM workspaces")
        assert len(ws) == 1 and ws[0]["space_id"] == "sp-1"
        assert ws[0]["trial_status"] in ("trialing", "subscribed_admin")
        assert len(db.query("SELECT * FROM api_keys")) == 1
        assert len(db.query("SELECT * FROM chats")) == 1
        assert len(db.query("SELECT * FROM pages")) == 1
        assert db.stats()["trialing"] == 1

    def test_sync_session_updates_changed_state(self, db):
        """Re-sync with CHANGED trial status + a second page + a prompt
        assignment upgrades the page kind (the UPDATE branches)."""
        aid = db.upsert_account_from_creds(CREDS)
        db.sync_session(aid, SESSION)
        sess2 = json.loads(json.dumps(SESSION))
        sess2["trials"]["sp-1"]["status"] = "cancelled_by_stripe"
        sess2["space"] = {"id": "sp-2", "name": "W2", "viewId": "v-2"}
        sess2["spaces"].append({"id": "sp-2", "name": "W2", "viewId": "v-2"})
        sess2["pages"].append({"id": "pg-2", "title": "Automation Skill"})
        sess2["prompts"] = {"pg-1": {"promptType": "instruction"},
                            "pg-2": {"promptType": "skill"}}
        db.sync_session(aid, sess2)
        w1 = db.one("SELECT * FROM workspaces WHERE space_id='sp-1'")
        assert w1["trial_status"] == "cancelled_by_stripe"
        assert w1["active"] == 0
        assert db.one("SELECT active FROM workspaces WHERE space_id='sp-2'"
                      )["active"] == 1
        kinds = {p["page_id"]: p["kind"] for p in db.query(
            "SELECT page_id, kind FROM pages")}
        assert kinds["pg-1"] == "instruction"   # upgraded from 'page'
        assert kinds["pg-2"] == "skill"
        # malformed rows are skipped silently
        db.sync_session(aid, {"spaces": [{"name": "no-id"}],
                              "chats": [{"prompt": "no-thread"}],
                              "apiKeys": {"sp-1": {"name": "no-token"}}})

    def test_masking(self, db):
        aid = db.upsert_account_from_creds(CREDS)
        db.sync_session(aid, SESSION)
        masked = db.get_account(aid, reveal=False)
        assert masked["token_v2"].endswith("…")
        assert "cookies_json" in masked and "bytes" in masked["cookies_json"]
        assert masked["api_keys"][0]["token"].endswith("…")
        revealed = db.get_account(aid, reveal=True)
        assert revealed["token_v2"] == CREDS["tokenV2"]
        assert revealed["api_keys"][0]["token"] == "ntn_fake123"

    def test_ip_summary_groups_per_ip(self, db):
        for i in range(3):
            db.upsert_account_from_creds({
                **CREDS, "email": f"a{i}@v3-mail.priv.email",
                "signupIp": "1.2.3.4" if i < 2 else "9.9.9.9"})
        ips = {r["ip"]: r for r in db.ip_summary()}
        assert ips["1.2.3.4"]["accounts"] == 2
        assert ips["9.9.9.9"]["accounts"] == 1
        assert ips["1.2.3.4"]["route"] == "zenrows-browser-session"

    def test_creds_from_account_roundtrip(self, db):
        aid = db.upsert_account_from_creds(CREDS)
        row = db.one("SELECT * FROM accounts WHERE id=?", (aid,))
        c = creds_from_account(row)
        assert c["tokenV2"] == CREDS["tokenV2"]
        assert c["userId"] == "u-123"

    def test_recover_stale_fails_items(self, db):
        jid = db.create_job("signup", {})
        db.set_job(jid, status="running")
        item = db.add_job_item(jid, "signup", status="running")
        assert db.recover_stale_jobs() == 1
        assert db.one("SELECT status FROM jobs WHERE id=?",
                      (jid,))["status"] == "failed"
        assert db.one("SELECT status FROM job_items WHERE id=?",
                      (item,))["status"] == "failed"

    def test_execute_insert_returns_rowid(self, db):
        jid = db.execute(
            "INSERT INTO jobs (type, params_json, status, created_at)"
            " VALUES ('x','{}','queued','now')")
        assert jid > 0
        n = db.execute("UPDATE jobs SET status='running' WHERE id=?", (jid,))
        assert n == 1
        n0 = db.execute("UPDATE jobs SET status='done' WHERE id=99999")
        assert n0 == 0


# ---------------------------------------------------------------- runner
class FakeDriver:
    """Records calls; honors the driver CONTRACT (session file writes)."""
    name = "notion"

    def __init__(self):
        self.calls: list[tuple] = []
        self._n = 0

    def health(self):
        return {"ok": True}

    def signup(self, opts: SignupOptions, on_event=lambda k, d: None,
               cancel_fn=None):
        self.calls.append(("signup", opts.email, opts.country, opts.attempts))
        on_event("signup_start", {})
        self._n += 1
        email = opts.email or f"fake-{self._n}@v3-mail.priv.email"
        return {**CREDS, "email": email, "proxyCountry": opts.country}

    def init_session(self, creds, path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            json.dump(SESSION | {"email": creds["email"]}, f)
        return SESSION

    def load_session_file(self, path):
        with open(path) as f:
            return json.load(f)

    def provision(self, creds, path, opts: TailOptions,
                  on_event=lambda k, d: None):
        self.calls.append(("provision", creds["email"], opts.workspaces))
        on_event("step", {"label": "ws1:chat", "result": {"reply": "4"}})
        return {"outcomes": [{"label": "ws1:chat", "result": {"reply": "4"}}],
                "session": SESSION | {"email": creds["email"]}}

    def chat(self, creds, path, opts: ChatOptions,
             on_event=lambda k, d: None):
        self.calls.append(("chat", opts.prompt, opts.model))
        # CONTRACT (like the real driver): persist the new thread into the
        # session file so the runner can re-load + sync it into the DB
        sess = dict(SESSION, chats=[dict(SESSION["chats"][0],
                                         threadId="t-9",
                                         prompt=opts.prompt,
                                         model=opts.model or "opal-quince")])
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            json.dump(sess, f)
        return {"threadId": "t-9", "prompt": opts.prompt, "reply": "4",
                "model": opts.model or "opal-quince", "tokens": {},
                "spaceId": "sp-1"}

    def list_models(self):
        return [{"codename": "opal-quince"}]


@pytest.fixture()
def fake():
    return FakeDriver()


@pytest.fixture()
def runner(db, fake, monkeypatch):
    monkeypatch.setitem(drvmod.REGISTRY, "notion", fake_driver_class(fake))
    r = JobRunner(db, "notion")
    r.start()
    yield r
    r.stop()


class TestRunner:
    def test_signup_job_full_flow(self, db, runner, fake):
        jid = runner.enqueue("signup", {"run_tail": True,
                                        "attempts": 4,
                                        "tail": {"workspaces": 1}})
        assert wait_job(db, jid) == "done"
        acct = db.one("SELECT * FROM accounts")
        assert acct["status"] == "provisioned"
        assert acct["signup_ip"] == CREDS["signupIp"]
        assert db.stats()["workspaces"] == 1
        assert db.stats()["chats"] == 1
        # attempts plumbed through to the driver
        assert fake.calls[0][3] == 4
        items = db.query("SELECT * FROM job_items WHERE job_id=?", (jid,))
        assert {i["label"] for i in items} == {"signup", "tail"}
        assert all(i["status"] == "done" for i in items)
        evs = [e["kind"] for e in db.query(
            "SELECT kind FROM events ORDER BY id")]
        assert "signup_ok" in evs and "tail_ok" in evs

    def test_batch_with_cooldown(self, db, runner):
        jid = runner.enqueue("batch", {"count": 3,
                                       "countries": ["us", "de", "us"],
                                       "cooldown_seconds": 0,
                                       "tail": {"workspaces": 1}})
        assert wait_job(db, jid, timeout=30) == "done"
        assert db.stats()["accounts"] == 3
        rows = db.query("SELECT proxy_country FROM accounts ORDER BY id")
        assert [x["proxy_country"] for x in rows] == ["us", "de", "us"]
        labels = [i["label"] for i in db.query(
            "SELECT label FROM job_items WHERE job_id=?", (jid,))]
        assert "acct-2:signup" in labels and "acct-3:tail" in labels
        assert "summary" in labels

    def test_signup_failure_isolated_in_batch(self, db, runner, fake):
        calls = {"n": 0}
        orig_signup = fake.signup

        def flaky_signup(opts, on_event=lambda k, d: None, cancel_fn=None):
            calls["n"] += 1
            if calls["n"] == 2:
                raise RuntimeError("captcha wall")
            return orig_signup(opts, on_event)

        fake.signup = flaky_signup
        jid = runner.enqueue("batch", {"count": 3, "cooldown_seconds": 0,
                                       "tail": {"workspaces": 1}})
        assert wait_job(db, jid, timeout=30) == "done"
        assert db.stats()["accounts"] == 2   # 2 of 3 succeeded
        failed = [i for i in db.query(
            "SELECT * FROM job_items WHERE job_id=?", (jid,))
            if i["status"] == "failed"]
        assert len(failed) == 1
        summary = db.one("SELECT detail_json FROM job_items WHERE label="
                         "'summary'")
        assert json.loads(summary["detail_json"]) == {"ok": 2, "failed": 1}

    def test_tail_all_steps_failed_marks_account_failed(self, db, fake,
                                                        monkeypatch):
        """A tail whose every step errors must NOT claim provisioned."""
        class AllErrorFake(FakeDriver):
            def provision(self, creds, path, opts, on_event=lambda k, d: None):
                on_event("step", {"label": "ws1:x", "result": {"error": "e"}})
                return {"outcomes": [{"label": "ws1:x",
                                      "result": {"error": "e"}}],
                        "session": {}}

        monkeypatch.setitem(drvmod.REGISTRY, "notion",
                            fake_driver_class(AllErrorFake()))
        r = JobRunner(db, "notion")
        r.start()
        try:
            aid = db.upsert_account_from_creds(CREDS)
            jid = r.enqueue("tail", {"account_id": aid})
            assert wait_job(db, jid) == "done"   # job ran, but…
            assert db.one("SELECT status FROM accounts WHERE id=?",
                          (aid,))["status"] == "failed"
            item = db.one("SELECT status FROM job_items WHERE job_id=?",
                          (jid,))
            assert item["status"] == "failed"
        finally:
            r.stop()

    def test_chat_job_persists_thread(self, db, runner):
        aid = db.upsert_account_from_creds(CREDS)
        jid = runner.enqueue("chat", {"account_id": aid, "prompt": "hi",
                                      "model": "orange-mousse"})
        assert wait_job(db, jid) == "done"
        threads = db.query("SELECT thread_id, model FROM chats "
                           "WHERE account_id=?", (aid,))
        # the session-file reload path synced the fake's new thread
        assert {t["thread_id"] for t in threads} == {"t-9"}
        assert threads[0]["model"] == "orange-mousse"

    def test_systemexit_does_not_kill_runner(self, db, fake, monkeypatch):
        """REGRESSION (live incident, see worklog): notion_tail's CLI
        helpers sys.exit(); SystemExit must fail the JOB, not the THREAD —
        the runner must keep serving subsequent jobs."""
        state = {"n": 0}
        orig_signup = fake.signup

        def exit_once(opts, on_event=lambda k, d: None, cancel_fn=None):
            state["n"] += 1
            if state["n"] == 1:
                raise SystemExit("session file missing 'tokenV2'")
            return orig_signup(opts, on_event)

        fake.signup = exit_once
        monkeypatch.setitem(drvmod.REGISTRY, "notion",
                            fake_driver_class(fake))
        r = JobRunner(db, "notion")
        r.start()
        try:
            j1 = r.enqueue("signup", {"run_tail": False})
            assert wait_job(db, j1) == "failed"
            assert "SystemExit" in db.one(
                "SELECT error FROM jobs WHERE id=?", (j1,))["error"]
            assert r._thread is not None and r._thread.is_alive()

            j2 = r.enqueue("signup", {"run_tail": False})
            assert wait_job(db, j2) == "done"        # still serving
            assert db.stats()["accounts"] == 1
        finally:
            r.stop()

    def test_cancel_endpoint_stops_work_early(self, db, fake, monkeypatch):
        """Cancel DURING a blocked signup via the real endpoint; prove the
        work actually stopped (subsequent accounts never ran)."""
        in_signup, release = threading.Event(), threading.Event()
        orig_signup = fake.signup

        def slow_signup(opts, on_event=lambda k, d: None, cancel_fn=None):
            in_signup.set()
            release.wait(timeout=10)     # simulate the warm-signup subprocess
            return orig_signup(opts, on_event)

        fake.signup = slow_signup
        monkeypatch.setitem(drvmod.REGISTRY, "notion",
                            fake_driver_class(fake))
        r = JobRunner(db, "notion")
        r.start()
        from fastapi.testclient import TestClient
        try:
            app = create_app(db, r, "notion")
            with TestClient(app) as c:
                res = c.post("/api/batch", json={"count": 3,
                                                 "cooldown_seconds": 0})
                jid = res.json()["job_id"]
                assert in_signup.wait(timeout=5)     # account 1 signing up
                assert c.post(f"/api/jobs/{jid}/cancel"
                              ).json()["cancelled"] is True
                release.set()                        # let it finish
                # wait for RUNNER quiescence — the status flip alone races
                # the still-working thread
                t0 = time.time()
                while time.time() - t0 < 20:
                    busy = db.one(
                        "SELECT COUNT(*) n FROM job_items WHERE job_id=?"
                        " AND status IN ('running','pending')", (jid,))["n"]
                    if busy == 0:
                        break
                    time.sleep(0.05)
                time.sleep(0.2)
                assert db.one("SELECT status FROM jobs WHERE id=?",
                              (jid,))["status"] == "cancelled"
                assert db.stats()["accounts"] == 1   # acct-2/3 never ran
                labels = {i["label"] for i in db.query(
                    "SELECT label FROM job_items WHERE job_id=?", (jid,))}
                assert "acct-2:signup" not in labels
                # endpoint edges
                assert c.post("/api/jobs/999/cancel").status_code == 404
                assert c.post(f"/api/jobs/{jid}/cancel"
                              ).json()["cancelled"] is False
        finally:
            release.set()
            r.stop()

    def test_reenqueue_after_stop_rearms(self, db, fake, monkeypatch):
        """stop() then start() (via enqueue) must process new jobs —
        the old code left them 'queued' forever."""
        monkeypatch.setitem(drvmod.REGISTRY, "notion",
                            fake_driver_class(fake))
        r = JobRunner(db, "notion")
        r.start()
        r.stop()
        jid = r.enqueue("signup", {"run_tail": False})
        assert wait_job(db, jid) == "done"


# ---------------------------------------------------------------- server
class TestAPI:
    @pytest.fixture()
    def client(self, db, fake, monkeypatch):
        monkeypatch.setitem(drvmod.REGISTRY, "notion",
                            fake_driver_class(fake))
        from fastapi.testclient import TestClient
        r = JobRunner(db, "notion")
        r.start()
        app = create_app(db, r, "notion")
        with TestClient(app) as c:
            yield c, db
        r.stop()

    def test_health(self, client):
        c, _ = client
        res = c.get("/api/health")
        assert res.status_code == 200
        assert res.json()["deps"]["ok"] is True

    def test_signup_endpoint_and_polling(self, client):
        c, db = client
        res = c.post("/api/signup", json={"country": "us"})
        assert res.status_code == 200
        jid = res.json()["job_id"]
        for _ in range(100):
            j = c.get(f"/api/jobs/{jid}").json()
            if j["status"] in ("done", "failed"):
                break
            time.sleep(0.05)
        assert j["status"] == "done"
        accounts = c.get("/api/accounts").json()
        assert len(accounts) == 1
        assert accounts[0]["signup_ip"] == CREDS["signupIp"]
        detail = c.get(f"/api/accounts/{accounts[0]['id']}").json()
        assert detail["token_v2"].endswith("…")     # masked by default
        assert c.get(f"/api/accounts/{accounts[0]['id']}?reveal=1"
                     ).json()["token_v2"] == CREDS["tokenV2"]

    def test_validation_edges(self, client):
        c, _ = client
        assert c.post("/api/batch", json={"count": 0}).status_code == 422
        assert c.post("/api/batch", json={"count": 99}).status_code == 422
        assert c.post("/api/batch",
                      json={"count": 1, "cooldown_seconds": -5}
                      ).status_code == 422     # pacing is IP hygiene — no opt-out
        assert c.post("/api/batch",
                      json={"count": 1, "cooldown_seconds": 9999}
                      ).status_code == 422
        assert c.post("/api/signup", json={"attempts": 0}).status_code == 422
        assert c.post("/api/signup", json={"attempts": 11}).status_code == 422
        aid = c.get("/api/accounts").json()
        if aid:
            assert c.post(f"/api/accounts/{aid[0]['id']}/chat",
                          json={"prompt": ""}).status_code == 422
            assert c.post(f"/api/accounts/{aid[0]['id']}/tail",
                          json={"workspaces": 9}).status_code == 422

    def test_chat_endpoint(self, client):
        c, db = client
        aid = db.upsert_account_from_creds(CREDS)
        res = c.post(f"/api/accounts/{aid}/chat",
                     json={"prompt": "what is 2+2?"})
        jid = res.json()["job_id"]
        for _ in range(100):
            j = c.get(f"/api/jobs/{jid}").json()
            if j["status"] in ("done", "failed"):
                break
            time.sleep(0.05)
        assert j["status"] == "done"
        reply = j["items"][0]["detail"]["reply"]
        assert reply == "4"

    def test_404s_and_delete(self, client):
        c, db = client
        assert c.get("/api/accounts/999").status_code == 404
        assert c.post("/api/accounts/999/chat",
                      json={"prompt": "x"}).status_code == 404
        assert c.post("/api/accounts/999/tail",
                      json={"workspaces": 1}).status_code == 404
        assert c.get("/api/jobs/999").status_code == 404
        assert c.post("/api/jobs/999/cancel").status_code == 404
        aid = db.upsert_account_from_creds(CREDS)
        db.sync_session(aid, SESSION)
        assert db.stats()["accounts"] == 1
        assert c.delete(f"/api/accounts/{aid}").status_code == 200
        assert c.get(f"/api/accounts/{aid}").status_code == 404
        assert db.stats()["accounts"] == 0     # cascade removed children
        assert db.stats()["workspaces"] == 0

    def test_export_session(self, client, tmp_path, monkeypatch):
        c, db = client
        aid = db.upsert_account_from_creds(CREDS)
        monkeypatch.setattr(config, "SESSIONS_DIR", str(tmp_path))
        res = c.post(f"/api/accounts/{aid}/export-session")
        assert res.status_code == 200
        body = res.json()
        assert body["created"] is True and body["has_token"] is True
        with open(body["session_path"]) as f:
            sess = json.load(f)
        assert sess["tokenV2"] == CREDS["tokenV2"]
        assert sess["userId"] == "u-123"
        # second call must NOT clobber (report existing)
        res2 = c.post(f"/api/accounts/{aid}/export-session")
        assert res2.json()["created"] is False

    def test_export_session_incomplete_creds_409(self, client, monkeypatch):
        c, db = client
        aid = db.execute(
            "INSERT INTO accounts (email, status, created_at)"
            " VALUES ('x@y.z','created','now')")
        monkeypatch.setattr(config, "SESSIONS_DIR", "/tmp/sess-409")
        assert c.post(f"/api/accounts/{aid}/export-session"
                      ).status_code == 409

    def test_models_and_stats(self, client):
        c, _ = client
        assert c.get("/api/models").json() == [{"codename": "opal-quince"}]
        assert "accounts" in c.get("/api/stats").json()
        assert c.get("/api/ips").json() == []
