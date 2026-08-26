"""ServiceDriver ABC — the service-agnostic contract.

Lifecycle the runner drives:
    signup()  ->  creds dict (incl. IP-hygiene fields)  ->  DB account row
    provision()  ->  step outcomes + updated session dict  ->  DB sync
    chat()  ->  one reply record

Every method takes an ``on_event`` callback (kind, detail) so the runner
can stream progress into job_items without knowing service internals.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
import json
from dataclasses import dataclass, field
from typing import Any, Callable

EventFn = Callable[[str, dict], None]
CancelFn = Callable[[], bool]


def _noop(kind: str, detail: dict) -> None:  # pragma: no cover
    pass


def _never_cancel() -> bool:  # pragma: no cover
    return False


@dataclass
class SignupOptions:
    email: str | None = None          # None -> driver allocates a fresh one
    country: str = "us"               # proxy_country for the warm browser
    attempts: int = 5                 # captcha-gate retries (rotating IP+email)


@dataclass
class TailOptions:
    workspaces: int = 1               # workspaces to provision per account
    chat_prompt: str = "What is 2+2? Answer with just the number."
    route: str = "auto"               # notion_tail route: auto|direct|zenrows
    workspace_name: str = "Onboard Workspace"
    trial_pace_s: int = 15            # between trial activations (429 guard)


@dataclass
class ChatOptions:
    prompt: str = "What is 2+2? Answer with just the number."
    model: str | None = None          # codename, e.g. orange-mousse
    effort: str | None = None         # low|medium|high …
    space_id: str | None = None       # None -> active space
    context_page_id: str | None = None
    thread_id: str | None = None      # follow-up turn on an existing thread
    route: str = "auto"


@dataclass
class StepOutcome:
    label: str
    result: dict = field(default_factory=dict)


class ServiceDriver(ABC):
    """One instance per service. Must be stateless across calls."""

    name: str = "base"

    @abstractmethod
    def health(self) -> dict:
        """Dependency probe: transports, refs, binaries. No side effects."""

    @abstractmethod
    def signup(self, opts: SignupOptions, on_event: EventFn = _noop,
               cancel_fn: CancelFn = _never_cancel) -> dict:
        """Create one fresh account. Returns the creds dict (email, identity
        fields, auth token(s), signupIp, proxyCountry, route, cookies).
        cancel_fn: poll periodically during long operations (e.g. a signup
        subprocess); return/raise promptly when it returns True."""

    @abstractmethod
    def init_session(self, creds: dict, session_path: str) -> dict:
        """Materialize the driver's session file from creds (replay entry)."""

    @abstractmethod
    def provision(self, creds: dict, session_path: str, opts: TailOptions,
                  on_event: EventFn = _noop) -> dict:
        """Run the post-signup provisioning tail. Returns
        {"outcomes": [StepOutcome-like dicts], "session": <final session>}."""

    @abstractmethod
    def chat(self, creds: dict, session_path: str, opts: ChatOptions,
             on_event: EventFn = _noop) -> dict:
        """One chat turn. Returns the reply record (reply, model, tokens…)."""

    def load_session_file(self, session_path: str) -> dict:
        """Re-read the driver's own session file (default: JSON).
        Runners use this to re-sync DB rows after chat turns."""
        with open(session_path) as f:
            return json.load(f)

    def list_models(self) -> list[dict]:  # optional capability
        return []
