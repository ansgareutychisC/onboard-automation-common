"""Central config for the productized backend.

Secrets policy: the operator keeps git-as-disk (see .agents/SKILL.md §4.2 /
the handoff notes) — keys are committed with env-var overrides, same as
backend/notion_tail.py and scripts/notion_signup_warm.js already do.
"""
from __future__ import annotations

import os

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
BACKEND_DIR = os.path.join(REPO_ROOT, "backend")
SCRIPTS_DIR = os.path.join(REPO_ROOT, "scripts")
SESSIONS_DIR = os.path.join(BACKEND_DIR, "sessions")
DATA_DIR = os.environ.get(
    "ONBOARD_DATA_DIR", os.path.join(os.path.dirname(__file__), "data"))
DB_PATH = os.environ.get("ONBOARD_DB", os.path.join(DATA_DIR, "onboard.db"))

# ---- transports / vendors ------------------------------------------------
ZENROWS_API_KEY = os.environ.get(
    "ZENROWS_API_KEY", "0e43f2d6166122fa4b4aa607464f5c7d4d8ce855")
NOTION_REF_PATH = os.environ.get(
    "NOTION_REF_PATH", os.path.join(os.path.dirname(REPO_ROOT), "notion-ref"))
NODE_PATH = os.environ.get(
    "NODE_PATH", "/home/z/.npm-global/lib/node_modules")

# ---- operational defaults (paced per SKILL.md §9.2.4) --------------------
DEFAULT_COUNTRY = os.environ.get("ONBOARD_DEFAULT_COUNTRY", "us")
DEFAULT_SIGNUP_ATTEMPTS = 5
DEFAULT_BATCH_COOLDOWN_S = 45       # between accounts in a batch
DEFAULT_TRIAL_PACE_S = 15           # between trial activations (429 guard)
BATCH_MAX_COUNT = 10                # hard cap per batch job

API_HOST = os.environ.get("ONBOARD_API_HOST", "127.0.0.1")
API_PORT = int(os.environ.get("ONBOARD_API_PORT", "3001"))


def ensure_dirs() -> None:
    for d in (DATA_DIR, SESSIONS_DIR):
        os.makedirs(d, exist_ok=True)
