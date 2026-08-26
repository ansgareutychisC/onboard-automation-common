"""Unit tests for the productized backend (no live network calls).

Run:  python3 -m pytest backend/api/tests -x -q
"""
from __future__ import annotations

import json
import os
import sys
import time

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.abspath(os.path.join(HERE, "..", "..", "..")))

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

    def test_ip_summary(self, db):
        db.upsert_account_from_creds(CREDS)
        ips = db.ip_summary()
        assert ips[0]["ip"] == "108.200.73.169"
        assert ips[0]["accounts"] == 1

    def test_creds_from_account_roundtrip(self, db):
        aid = db.upsert_account_from_creds(CREDS)
        row = db.one("SELECT * FROM accounts WHERE id=?", (aid,))
        c = creds_from_account(row)
        assert c == {k: CREDS.get(k) for k in
                     ("email", "userId", "deviceId", "tokenV2",
                      "clientVersion")} | {
            "createdAt": row["created_at"], "route": CREDS["route"]}

    def test_recover_stale(self, db):
        jid = db.create_job("signup", {})
        db.set_job(jid, status="running")
        assert db.recover_stale_jobs() == 1
        assert db.one("SELECT status FROM jobs WHERE id=?",
                      (jid,))["status"] == "failed"


# ---------------------------------------------------------------- runner
class FakeDriver:
    """Records calls; provision returns a canned session."""
    name = "notion"

    def __init__(self):
        self.calls: list[tuple] = []
        self._n = 0

    def health(self):
        return {"ok": True}

    def signup(self, opts: SignupOptions, on_event=lambda k, d: None):
        self.calls.append(("signup", opts.email, opts.country))
        on_event("signup_start", {})
        self._n += 1
        email = opts.email or f"fake-{self._n}@v3-mail.priv.email"
        return {**CREDS, "email": email, "proxyCountry": opts.country}

    def init_session(self, creds, path):
        with open(path, "w") as f:
            json.dump(SESSION | {"email": creds["email"]}, f)
        return SESSION

    def provision(self, creds, path, opts: TailOptions,
                  on_event=lambda k, d: None):
        self.calls.append(("provision", creds["email"], opts.workspaces))
        on_event("step", {"label": "ws1:chat", "result": {"reply": "4"}})
        return {"outcomes": [{"label": "ws1:chat", "result": {"reply": "4"}}],
                "session": SESSION | {"email": creds["email"]}}

    def chat(self, creds, path, opts: ChatOptions,
             on_event=lambda k, d: None):
        self.calls.append(("chat", opts.prompt, opts.model))
        return {"threadId": "t-9", "prompt": opts.prompt, "reply": "4",
                "model": opts.model or "opal-quince", "tokens": {},
                "spaceId": "sp-1"}

    def list_models(self):
        return [{"codename": "opal-quince"}]


def wait_job(db, jid, timeout=15):
    t0 = time.time()
    while time.time() - t0 < timeout:
        row = db.one("SELECT status FROM jobs WHERE id=?", (jid,))
        if row["status"] in ("done", "failed", "cancelled"):
            return row["status"]
        time.sleep(0.05)
    return "timeout"


class TestRunner:
    def _runner(self, db, fake):
        import backend.api.drivers as drv
        orig = drv.REGISTRY["notion"]
        drv.REGISTRY["notion"] = type("F", (), {"__new__": lambda cls: fake})
        try:
            r = JobRunner(db, "notion")
            r.start()
            return r, orig
        finally:
            pass

    def test_signup_job_full_flow(self, db):
        fake = FakeDriver()
        r, orig = self._runner(db, fake)
        try:
            jid = r.enqueue("signup", {"run_tail": True,
                                       "tail": {"workspaces": 1}})
            assert wait_job(db, jid) == "done"
            acct = db.one("SELECT * FROM accounts")
            assert acct["status"] == "provisioned"
            assert acct["signup_ip"] == CREDS["signupIp"]
            assert db.stats()["workspaces"] == 1
            assert db.stats()["chats"] == 1
            items = db.query("SELECT * FROM job_items WHERE job_id=?",
                             (jid,))
            assert {i["label"] for i in items} == {"signup", "tail"}
            assert all(i["status"] == "done" for i in items)
            evs = [e["kind"] for e in db.query(
                "SELECT kind FROM events ORDER BY id")]
            assert "signup_ok" in evs and "tail_ok" in evs
        finally:
            import backend.api.drivers as drv
            drv.REGISTRY["notion"] = orig
            r.stop()

    def test_batch_with_cooldown(self, db, monkeypatch):
        monkeypatch.setattr(config, "DEFAULT_BATCH_COOLDOWN_S", 0)
        fake = FakeDriver()
        r, orig = self._runner(db, fake)
        try:
            jid = r.enqueue("batch", {"count": 3,
                                      "countries": ["us", "de", "us"],
                                      "cooldown_seconds": 0,
                                      "tail": {"workspaces": 1}})
            assert wait_job(db, jid, timeout=30) == "done"
            assert db.stats()["accounts"] == 3
            # countries rotated
            rows = db.query("SELECT proxy_country FROM accounts "
                            "ORDER BY id")
            assert [x["proxy_country"] for x in rows] == ["us", "de", "us"]
            labels = [i["label"] for i in db.query(
                "SELECT label FROM job_items WHERE job_id=?", (jid,))]
            assert "acct-2:signup" in labels and "acct-3:tail" in labels
            assert "summary" in labels
        finally:
            import backend.api.drivers as drv
            drv.REGISTRY["notion"] = orig
            r.stop()

    def test_signup_failure_isolated_in_batch(self, db, monkeypatch):
        monkeypatch.setattr(config, "DEFAULT_BATCH_COOLDOWN_S", 0)
        fake = FakeDriver()
        calls = {"n": 0}
        orig_signup = fake.signup

        def flaky_signup(opts, on_event=lambda k, d: None):
            calls["n"] += 1
            if calls["n"] == 2:
                raise RuntimeError("captcha wall")
            return orig_signup(opts, on_event)

        fake.signup = flaky_signup
        r, orig = self._runner(db, fake)
        try:
            jid = r.enqueue("batch", {"count": 3, "cooldown_seconds": 0,
                                      "tail": {"workspaces": 1}})
            assert wait_job(db, jid, timeout=30) == "done"
            assert db.stats()["accounts"] == 2   # 2 of 3 succeeded
            failed = [i for i in db.query(
                "SELECT * FROM job_items WHERE job_id=?", (jid,))
                if i["status"] == "failed"]
            assert len(failed) == 1
        finally:
            import backend.api.drivers as drv
            drv.REGISTRY["notion"] = orig
            r.stop()

    def test_chat_job(self, db):
        aid = db.upsert_account_from_creds(CREDS)
        fake = FakeDriver()
        r, orig = self._runner(db, fake)
        try:
            jid = r.enqueue("chat", {"account_id": aid, "prompt": "hi",
                                     "model": "orange-mousse"})
            assert wait_job(db, jid) == "done"
            assert fake.calls[-1] == ("chat", "hi", "orange-mousse")
        finally:
            import backend.api.drivers as drv
            drv.REGISTRY["notion"] = orig
            r.stop()

    def test_cancel(self, db, monkeypatch):
        monkeypatch.setattr(config, "DEFAULT_BATCH_COOLDOWN_S", 0)
        fake = FakeDriver()
        gate = {"release": False}
        import backend.api.runner as R
        orig_sleep = R.time.sleep

        def gated_sleep(s):
            while not gate["release"]:
                orig_sleep(0.02)

        R.time.sleep = gated_sleep
        r, orig = self._runner(db, fake)
        try:
            jid = r.enqueue("batch", {"count": 2, "cooldown_seconds": 5})
            time.sleep(0.4)     # let it get into the cooldown window
            db.set_job(jid, status="cancelled")
            gate["release"] = True
            assert wait_job(db, jid) == "cancelled"
        finally:
            R.time.sleep = orig_sleep
            import backend.api.drivers as drv
            drv.REGISTRY["notion"] = orig
            r.stop()


# ---------------------------------------------------------------- server
class TestAPI:
    @pytest.fixture()
    def client(self, db, monkeypatch):
        fake = FakeDriver()
        import backend.api.drivers as drv
        orig = drv.REGISTRY["notion"]
        drv.REGISTRY["notion"] = type("F", (), {"__new__": lambda cls: fake})
        from fastapi.testclient import TestClient
        r = JobRunner(db, "notion")
        r.start()
        app = create_app(db, r, "notion")
        with TestClient(app) as c:
            yield c, db
        r.stop()
        drv.REGISTRY["notion"] = orig

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

    def test_batch_endpoint_validation(self, client):
        c, _ = client
        assert c.post("/api/batch", json={"count": 0}).status_code == 422
        assert c.post("/api/batch", json={"count": 99}).status_code == 422

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
        c, _ = client
        assert c.get("/api/accounts/999").status_code == 404
        aid = c.get("/api/accounts").json()
        if aid:
            assert c.delete(f"/api/accounts/{aid[0]['id']}").status_code == 200
            assert c.get(f"/api/accounts/{aid[0]['id']}").status_code == 404

    def test_export_session(self, client, tmp_path, monkeypatch):
        c, db = client
        aid = db.upsert_account_from_creds(CREDS)
        monkeypatch.setattr(config, "SESSIONS_DIR", str(tmp_path))
        res = c.post(f"/api/accounts/{aid}/export-session")
        assert res.status_code == 200
        body = res.json()
        assert body["has_token"] is True
        with open(body["session_path"]) as f:
            sess = json.load(f)
        assert sess["tokenV2"] == CREDS["tokenV2"]
        assert sess["userId"] == "u-123"

    def test_models_and_stats(self, client):
        c, _ = client
        assert c.get("/api/models").json() == [{"codename": "opal-quince"}]
        assert "accounts" in c.get("/api/stats").json()
        assert c.get("/api/ips").json() == []
