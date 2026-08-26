"""Onboard automation productized backend (FastAPI on :3001).

Layers:
  db.py            SQLite persistence (accounts/creds/workspaces/keys/chats/jobs)
  drivers/         service-agnostic ServiceDriver ABC + Notion implementation
  runner.py        background job runner (queue, pacing, batch orchestration)
  server.py        REST API surface

Run:  python3 backend/api/server.py   (listens on 127.0.0.1:3001)
"""
