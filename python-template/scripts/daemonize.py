"""scripts.daemonize

Double-fork daemon helper. The container's bash wrapper kills the entire
descendant tree at toolcall end, so `nohup`/`setsid` alone die. A
double-forked process reparents to PID 1 (tini) and escapes the kill.

Usage:
    from scripts.daemonize import daemonize, DaemonManager
    daemonize(pid_file="/tmp/bridge.pid", log_file="/tmp/bridge.log")
    # After this returns, we're in the daemon process. Exec into the real
    # server:
    import sys
    sys.argv = ["run_bridge.py", "--host", "0.0.0.0", "--port", "8787"]
    exec(open("/path/to/run_bridge.py").read())
"""

from __future__ import annotations
import os
import sys
import time
from pathlib import Path


def daemonize(pid_file: str | None = None, log_file: str | None = None) -> None:
    """
    Double-fork the current process to detach from the controlling terminal
    and the bash toolcall's descendant tree.

    After this function returns, the original parent has exited and the
    current process is the reparented grandchild (parent = PID 1).

    :param pid_file: if set, write the daemon's PID to this file
    :param log_file: if set, redirect stdout/stderr to this file (else /dev/null)
    """
    # First fork
    if os.fork() > 0:
        # Parent exits immediately
        os._exit(0)

    # Become session leader (decouple from controlling terminal)
    os.setsid()

    # Second fork
    if os.fork() > 0:
        # First child exits
        os._exit(0)

    # We're now the grandchild — reparented to PID 1

    # Reset umask
    os.umask(0o022)

    # Redirect stdio
    sys.stdout.flush()
    sys.stderr.flush()
    devnull = os.open("/dev/null", os.O_RDWR)
    os.dup2(devnull, 0)
    if log_file:
        log_fd = os.open(log_file, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
        os.dup2(log_fd, 1)
        os.dup2(log_fd, 2)
        os.close(log_fd)
    else:
        os.dup2(devnull, 1)
        os.dup2(devnull, 2)
    os.close(devnull)

    if pid_file:
        Path(pid_file).parent.mkdir(parents=True, exist_ok=True)
        with open(pid_file, "w") as f:
            f.write(str(os.getpid()))


class DaemonManager:
    """Manages a double-forked daemon via a PID file."""

    def __init__(self, pid_file: str, log_file: str | None = None):
        self.pid_file = pid_file
        self.log_file = log_file

    @property
    def pid(self) -> int | None:
        try:
            return int(Path(self.pid_file).read_text().strip())
        except (FileNotFoundError, ValueError):
            return None

    @property
    def is_running(self) -> bool:
        pid = self.pid
        if not pid:
            return False
        try:
            os.kill(pid, 0)
            return True
        except (ProcessLookupError, PermissionError):
            return False

    def status(self) -> dict:
        return {
            "pid": self.pid,
            "running": self.is_running,
            "pid_file": self.pid_file,
            "log_file": self.log_file,
        }

    def kill(self) -> bool:
        pid = self.pid
        if not pid:
            return False
        try:
            os.kill(pid, 15)  # SIGTERM
            time.sleep(0.5)
            if self.is_running:
                os.kill(pid, 9)  # SIGKILL
        except ProcessLookupError:
            pass
        try:
            Path(self.pid_file).unlink()
        except FileNotFoundError:
            pass
        return True
