#!/usr/bin/env python3
"""Double-fork launcher for the onboard API server (survives toolcalls).

Usage: python3 backend/api/serve_daemon.py
Logs:   backend/api/data/api.log (rotated by size, trivially)
Ping:   curl -s localhost:3001/api/health
Stop:   kill $(cat backend/api/data/api.pid)
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
LOG = os.path.join(HERE, "data", "api.log")
PID = os.path.join(HERE, "data", "api.pid")


def daemonize() -> None:
    if os.fork():
        sys.exit(0)
    os.setsid()
    if os.fork():
        sys.exit(0)
    # detach stdio -> log file
    sys.stdout.flush()
    sys.stderr.flush()
    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    fd = os.open(LOG, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
    os.dup2(fd, 1)
    os.dup2(fd, 2)
    os.close(fd)
    with open(PID, "w") as f:
        f.write(str(os.getpid()))


def main() -> None:
    daemonize()
    repo_root = os.path.abspath(os.path.join(HERE, "..", ".."))
    sys.path.insert(0, repo_root)
    from backend.api.server import main as serve  # noqa: E402
    serve()


if __name__ == "__main__":
    main()
