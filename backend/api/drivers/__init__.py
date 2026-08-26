"""Service driver registry — the generalization seam.

A ServiceDriver encapsulates EVERYTHING service-specific: signup transport,
provisioning steps, chat. The runner/server layers are service-agnostic and
only talk to this interface, so onboarding a NEW service (Supabase,
Todoist, …) means implementing one class and registering it here.
"""
from __future__ import annotations

from .base import ServiceDriver, SignupOptions, TailOptions, ChatOptions
from .notion_driver import NotionDriver

REGISTRY: dict[str, type[ServiceDriver]] = {}


def register(name: str, cls: type[ServiceDriver]) -> None:
    REGISTRY[name] = cls


def get_driver(name: str) -> ServiceDriver:
    try:
        cls = REGISTRY[name]
    except KeyError:
        raise KeyError(
            f"unknown service driver {name!r}; registered: {list(REGISTRY)}")
    return cls()


register("notion", NotionDriver)

__all__ = ["ServiceDriver", "SignupOptions", "TailOptions", "ChatOptions",
           "REGISTRY", "register", "get_driver"]
