#!/usr/bin/env python3
"""Double-fork launcher for the onboard API server (survives toolcalls).

Usage:  python3 backend/api/serve_daemon.py
Logs:   backend/api/data/api.log
Ping:   curl -s localhost:3001/api/health
Stop:   kill $(cat backend/api/data/api.pid)

Holds an exclusive flock on data/api.lock for the daemon's lifetime so a
second launch aborts BEFORE recover_stale_jobs() would mark the live
server's jobs as interrupted.
"""
import fcntl
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
LOG = os.path.join(HERE, "data", "api.log")
PID = os.path.join(HERE, "data", "api.pid")
LOCK = os.path.join(HERE, "data", "api.lock")


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def daemonize() -> None:
    if os.fork():
        sys.exit(0)
    os.setsid()
    if os.fork():
        sys.exit(0)
    # detach stdio -> log file; stdin -> /dev/null (children inherit)
    sys.stdout.flush()
    sys.stderr.flush()
    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    devnull = os.open("/dev/null", os.O_RDONLY)
    os.dup2(devnull, 0)
    fd = os.open(LOG, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
    os.dup2(fd, 1)
    os.dup2(fd, 2)
    if fd > 2:
        os.close(fd)
    with open(PID, "w") as f:
        f.write(str(os.getpid()))


def main() -> None:
    os.makedirs(os.path.dirname(LOCK), exist_ok=True)
    # single-instance guard (checked pre-daemon so a stray second launch
    # exits loudly instead of corrupting the live one's job state)
    lock = open(LOCK, "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        pid = "?"
        try:
            raw = open(PID).read().strip()
            pid = f"{raw} ({'ALIVE' if _pid_alive(int(raw)) else 'stale'})"
        except (OSError, ValueError):
            pass
        sys.exit(f"another API instance holds {LOCK} (pid file says {pid})")
    # the flock must SURVIVE daemonization — inherit via the fork chain by
    # keeping `lock` referenced in the daemon process
    daemonize()
    repo_root = os.path.abspath(os.path.join(HERE, "..", ".."))
    sys.path.insert(0, repo_root)
    from backend.api.server import main as serve  # noqa: E402
    try:
        serve()
    finally:
        try:
            fcntl.flock(lock, fcntl.LOCK_UN)
        except OSError:
            pass


if __name__ == "__main__":
    main()
