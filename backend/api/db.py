"""SQLite persistence for the onboard-automation backend.

Single-file WAL database (default backend/api/data/onboard.db). This DB is
the durable credential store (git-as-disk policy: the DB file is committed
so creds survive sandbox recycles — GitHub is the hard disk).

Design notes:
- one row per Notion ACCOUNT (identity), child rows for workspaces/keys/
  chats/pages created by the tail;
- credentials (token_v2 JWT, full cookie jar, device id) stored verbatim
  so a session can be REPLAYED (export-session regenerates the exact
  session file notion_tail.py consumes);
- IP hygiene (SKILL.md §9.5): signup_ip + proxy_country + signup_route
  live ON the account row; the events table keeps a full audit trail.
"""
from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from datetime import datetime, timezone
from typing import Any

from . import config

_SCHEMA = """
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  user_id TEXT,
  device_id TEXT,
  client_version TEXT,
  token_v2 TEXT,
  cookies_json TEXT,
  status TEXT NOT NULL DEFAULT 'created',   -- created|provisioned|failed|dead
  signup_route TEXT,
  signup_ip TEXT,
  proxy_country TEXT,
  mail_provider TEXT,
  is_new_signup INTEGER DEFAULT 1,
  session_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS workspaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL,
  name TEXT,
  icon TEXT,
  view_id TEXT,
  trial_status TEXT,
  trial_tier TEXT,
  trial_type TEXT,
  active INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(account_id, space_id)
);
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  workspace_id TEXT,
  name TEXT,
  token TEXT,
  expiration TEXT,
  verified INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  workspace_id TEXT,
  thread_id TEXT,
  prompt TEXT,
  reply TEXT,
  model TEXT,
  effort TEXT,
  outcome_json TEXT,
  tokens_json TEXT,
  route TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  page_id TEXT,
  title TEXT,
  url TEXT,
  kind TEXT,                                -- page|instruction|skill
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,                       -- signup|tail|chat|batch
  params_json TEXT,
  status TEXT NOT NULL DEFAULT 'queued',    -- queued|running|done|failed|cancelled
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  started_at TEXT,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS job_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  account_id INTEGER,
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending|running|done|failed|skipped
  detail_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  account_id INTEGER,
  job_id INTEGER,
  kind TEXT NOT NULL,
  detail_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_ws_account ON workspaces(account_id);
CREATE INDEX IF NOT EXISTS idx_keys_account ON api_keys(account_id);
CREATE INDEX IF NOT EXISTS idx_chats_account ON chats(account_id);
CREATE INDEX IF NOT EXISTS idx_pages_account ON pages(account_id);
CREATE INDEX IF NOT EXISTS idx_items_job ON job_items(job_id);
CREATE INDEX IF NOT EXISTS idx_events_account ON events(account_id);
"""


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


class DB:
    """Thread-safe wrapper (connection-per-call; SQLite serialized by a lock)."""

    def __init__(self, path: str | None = None):
        self.path = path or config.DB_PATH
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        self._lock = threading.Lock()
        with self._conn() as c:
            c.executescript(_SCHEMA)

    def _conn(self) -> sqlite3.Connection:
        c = sqlite3.connect(self.path, timeout=30)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA journal_mode=WAL")
        c.execute("PRAGMA foreign_keys=ON")
        return c

    # ------------------------------------------------------------ generic
    def execute(self, sql: str, params: tuple | list = ()) -> int:
        with self._lock, self._conn() as c:
            cur = c.execute(sql, params)
            c.commit()
            return cur.lastrowid or -1

    def query(self, sql: str, params: tuple | list = ()) -> list[dict]:
        with self._lock, self._conn() as c:
            return [dict(r) for r in c.execute(sql, params).fetchall()]

    def one(self, sql: str, params: tuple | list = ()) -> dict | None:
        rows = self.query(sql, params)
        return rows[0] if rows else None

    # ---------------------------------------------------------- accounts
    def upsert_account_from_creds(self, creds: dict) -> int:
        """Create or refresh an account row from a signup creds dict."""
        email = creds["email"]
        existing = self.one("SELECT id FROM accounts WHERE email=?", (email,))
        now = _now()
        fields = dict(
            user_id=creds.get("userId"),
            device_id=creds.get("deviceId"),
            client_version=creds.get("clientVersion"),
            token_v2=creds.get("tokenV2"),
            cookies_json=json.dumps(creds.get("cookies") or {}),
            signup_route=creds.get("route"),
            signup_ip=creds.get("signupIp"),
            proxy_country=creds.get("proxyCountry"),
            mail_provider="v3-mail" if "v3-mail" in email else
                          ("priv.email" if "priv.email" in email else "other"),
            is_new_signup=1 if creds.get("isNewSignup", True) else 0,
            status=creds.get("status", "created"),
            updated_at=now,
        )
        if existing:
            aid = existing["id"]
            sets = ", ".join(f"{k}=?" for k in fields)
            self.execute(f"UPDATE accounts SET {sets} WHERE id=?",
                         [*fields.values(), aid])
            return aid
        cols = ["email", "created_at", *fields.keys()]
        vals = [email, now, *fields.values()]
        ph = ",".join("?" * len(cols))
        return self.execute(
            f"INSERT INTO accounts ({','.join(cols)}) VALUES ({ph})", vals)

    def set_account_status(self, aid: int, status: str,
                           session_path: str | None = None) -> None:
        self.execute(
            "UPDATE accounts SET status=?, session_path=COALESCE(?,session_path),"
            " updated_at=? WHERE id=?",
            (status, session_path, _now(), aid))

    def touch_account_session(self, aid: int, session_path: str) -> None:
        self.execute("UPDATE accounts SET session_path=?, updated_at=? "
                     "WHERE id=?", (session_path, _now(), aid))

    # ----------------------------- sync tail results (session -> tables) --
    def sync_session(self, aid: int, sess: dict) -> None:
        """Idempotently mirror a notion_tail session dict into the tables."""
        now = _now()
        for sp in sess.get("spaces") or []:
            sid = sp.get("id")
            if not sid:
                continue
            trial = (sess.get("trials") or {}).get(sid) or {}
            row = self.one(
                "SELECT id FROM workspaces WHERE account_id=? AND space_id=?",
                (aid, sid))
            common = (sp.get("name"), sp.get("icon"), sp.get("viewId"),
                      trial.get("status") or trial.get("type"),
                      trial.get("tier"), trial.get("type"),
                      1 if (sess.get("space") or {}).get("id") == sid else 0)
            if row:
                self.execute(
                    "UPDATE workspaces SET name=?, icon=?, view_id=?,"
                    " trial_status=?, trial_tier=?, trial_type=?, active=?"
                    " WHERE id=?", (*common, row["id"]))
            else:
                self.execute(
                    "INSERT INTO workspaces (account_id, space_id, name, icon,"
                    " view_id, trial_status, trial_tier, trial_type, active,"
                    " created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                    (aid, sid, *common, now))
        for sid, k in (sess.get("apiKeys") or {}).items():
            tok = k.get("token")
            if not tok:
                continue
            if not self.one(
                    "SELECT id FROM api_keys WHERE account_id=? AND token=?",
                    (aid, tok)):
                self.execute(
                    "INSERT INTO api_keys (account_id, workspace_id, name,"
                    " token, expiration, verified, created_at)"
                    " VALUES (?,?,?,?,?,?,?)",
                    (aid, sid, k.get("name") or "automation-pat", tok,
                     k.get("expiration") or "1_year",
                     1 if k.get("verified") else 0, now))
        known_threads = {
            r["thread_id"] for r in self.query(
                "SELECT thread_id FROM chats WHERE account_id=?", (aid,))}
        for ch in sess.get("chats") or []:
            tid = ch.get("threadId")
            if not tid or tid in known_threads:
                continue
            self.execute(
                "INSERT INTO chats (account_id, workspace_id, thread_id,"
                " prompt, reply, model, effort, outcome_json, tokens_json,"
                " route, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (aid, ch.get("spaceId"), tid, ch.get("prompt"),
                 ch.get("reply"), ch.get("model"), ch.get("effort"),
                 json.dumps(ch.get("outcome"), default=str),
                 json.dumps(ch.get("tokens")), ch.get("route"), now))
        prompts = sess.get("prompts") or {}
        for pg in sess.get("pages") or []:
            pid = pg.get("id")
            if not pid or self.one(
                    "SELECT id FROM pages WHERE account_id=? AND page_id=?",
                    (aid, pid)):
                continue
            # derive kind from prompt assignments (instruction/skill pages
            # carry a prompt row; plain pages stay 'page')
            kind = (prompts.get(pid) or {}).get("promptType") or "page"
            existing_page = self.one(
                "SELECT id, kind FROM pages WHERE account_id=? AND page_id=?",
                (aid, pid))
            if existing_page:
                if not existing_page["kind"]:
                    self.execute("UPDATE pages SET kind=? WHERE id=?",
                                 (kind, existing_page["id"]))
                continue
            self.execute(
                "INSERT INTO pages (account_id, page_id, title, url, kind,"
                " created_at) VALUES (?,?,?,?,?,?)",
                (aid, pid, pg.get("title"), pg.get("url"), kind, now))
        self.execute("UPDATE accounts SET updated_at=? WHERE id=?", (now, aid))

    # ------------------------------------------------------------- jobs
    def create_job(self, jtype: str, params: dict) -> int:
        return self.execute(
            "INSERT INTO jobs (type, params_json, status, created_at)"
            " VALUES (?,?, 'queued', ?)",
            (jtype, json.dumps(params, default=str), _now()))

    def set_job(self, jid: int, **fields: Any) -> None:
        fields["updated_at"] = _now()
        sets = ", ".join(f"{k}=?" for k in fields)
        self.execute(f"UPDATE jobs SET {sets} WHERE id=?",
                     [*fields.values(), jid])

    def add_job_item(self, jid: int, label: str, account_id: int | None = None,
                     status: str = "pending", detail: dict | None = None) -> int:
        return self.execute(
            "INSERT INTO job_items (job_id, account_id, label, status,"
            " detail_json, created_at) VALUES (?,?,?,?,?,?)",
            (jid, account_id, label, status,
             json.dumps(detail, default=str) if detail else None, _now()))

    def set_job_item(self, item_id: int, status: str,
                     detail: dict | None = None) -> None:
        d = None
        if detail is not None:
            row = self.one("SELECT detail_json FROM job_items WHERE id=?",
                           (item_id,))
            if row and row["detail_json"]:
                try:
                    merged = json.loads(row["detail_json"])
                except json.JSONDecodeError:
                    merged = {}
                merged.update(detail)
                d = json.dumps(merged, default=str)
            else:
                d = json.dumps(detail, default=str)
        self.execute(
            "UPDATE job_items SET status=?, detail_json=COALESCE(?,detail_json),"
            " updated_at=? WHERE id=?", (status, d, _now(), item_id))

    def add_event(self, kind: str, account_id: int | None = None,
                  job_id: int | None = None, detail: dict | None = None) -> None:
        self.execute(
            "INSERT INTO events (ts, account_id, job_id, kind, detail_json)"
            " VALUES (?,?,?,?,?)",
            (_now(), account_id, job_id, kind,
             json.dumps(detail, default=str) if detail else None))

    # ------------------------------------------------------------- views
    @staticmethod
    def _mask(row: dict) -> dict:
        out = dict(row)
        if out.get("token_v2"):
            out["token_v2"] = out["token_v2"][:14] + "…"
        if out.get("cookies_json"):
            out["cookies_json"] = f"<{len(out['cookies_json'])} bytes>"
        return out

    def list_accounts(self, limit: int = 100, offset: int = 0,
                      reveal: bool = False) -> list[dict]:
        rows = self.query(
            "SELECT * FROM accounts ORDER BY id DESC LIMIT ? OFFSET ?",
            (limit, offset))
        counts = {r["account_id"]: r for r in self.query(
            "SELECT account_id, COUNT(*) n FROM workspaces GROUP BY account_id")}
        keys = {r["account_id"]: r["n"] for r in self.query(
            "SELECT account_id, COUNT(*) n FROM api_keys GROUP BY account_id")}
        chats = {r["account_id"]: r["n"] for r in self.query(
            "SELECT account_id, COUNT(*) n FROM chats GROUP BY account_id")}
        for r in rows:
            r["workspaces_n"] = counts.get(r["id"], {}).get("n", 0)
            r["keys_n"] = keys.get(r["id"], 0)
            r["chats_n"] = chats.get(r["id"], 0)
            if not reveal:
                r = DB._mask_inplace(r)
        return rows

    @staticmethod
    def _mask_inplace(row: dict) -> dict:
        row.update(DB._mask(row))
        return row

    def get_account(self, aid: int, reveal: bool = False) -> dict | None:
        row = self.one("SELECT * FROM accounts WHERE id=?", (aid,))
        if not row:
            return None
        if not reveal:
            DB._mask_inplace(row)
        row["workspaces"] = self.query(
            "SELECT * FROM workspaces WHERE account_id=? ORDER BY id", (aid,))
        row["api_keys"] = [
            dict(r, token=(r["token"] if reveal else r["token"][:10] + "…"))
            for r in self.query(
                "SELECT * FROM api_keys WHERE account_id=? ORDER BY id", (aid,))]
        row["chats"] = self.query(
            "SELECT * FROM chats WHERE account_id=? ORDER BY id DESC LIMIT 50",
            (aid,))
        row["pages"] = self.query(
            "SELECT * FROM pages WHERE account_id=? ORDER BY id", (aid,))
        return row

    def ip_summary(self) -> list[dict]:
        return self.query(
            "SELECT signup_ip ip, proxy_country country, signup_route route,"
            " COUNT(*) accounts, MIN(created_at) first_at,"
            " MAX(created_at) last_at FROM accounts"
            " WHERE signup_ip IS NOT NULL"
            " GROUP BY signup_ip, proxy_country ORDER BY first_at")

    def stats(self) -> dict:
        def cnt(sql: str, p: tuple = ()) -> int:
            return (self.one(sql, p) or {}).get("n", 0)
        return {
            "accounts": cnt("SELECT COUNT(*) n FROM accounts"),
            "provisioned": cnt(
                "SELECT COUNT(*) n FROM accounts WHERE status='provisioned'"),
            "workspaces": cnt("SELECT COUNT(*) n FROM workspaces"),
            "trialing": cnt(
                "SELECT COUNT(*) n FROM workspaces WHERE"
                " trial_status IN ('trialing','subscribed_admin')"),
            "api_keys": cnt("SELECT COUNT(*) n FROM api_keys"),
            "chats": cnt("SELECT COUNT(*) n FROM chats"),
            "jobs": cnt("SELECT COUNT(*) n FROM jobs"),
            "distinct_signup_ips": cnt(
                "SELECT COUNT(DISTINCT signup_ip) n FROM accounts"),
        }

    def recover_stale_jobs(self) -> int:
        """Mark jobs left 'running'/'queued' by a server restart as failed."""
        now = _now()
        with self._lock, self._conn() as c:
            cur = c.execute(
                "UPDATE jobs SET status='failed', error='interrupted by"
                " server restart', updated_at=?, finished_at=?"
                " WHERE status IN ('running','queued')", (now, now))
            c.commit()
            return cur.rowcount


def session_path_for(aid: int, email: str) -> str:
    safe = "".join(ch for ch in email if ch.isalnum() or ch in "._-")[:60]
    return os.path.join(config.SESSIONS_DIR, f"{aid:04d}_{safe}.json")


def creds_from_account(row: dict) -> dict:
    """Regenerate a notion_tail creds dict from an account row (replay)."""
    return {
        "email": row["email"],
        "userId": row["user_id"],
        "deviceId": row["device_id"],
        "tokenV2": row["token_v2"],
        "clientVersion": row["client_version"],
        "createdAt": row["created_at"],
        "route": row["signup_route"],
    }
