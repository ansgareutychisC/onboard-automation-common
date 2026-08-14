"""onboard_common.exceptions

Exception hierarchy for the bridge client. Vendor-agnostic — service-specific
errors should subclass these or live in the service's own exceptions module.
"""

from __future__ import annotations
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from .protocol import CommandResult


class BridgeError(Exception):
    """Base error for any bridge-related failure."""


class BridgeConnectionError(BridgeError):
    """Could not connect to the bridge daemon / worker."""


class BridgeNotConnectedError(BridgeConnectionError):
    """No extension is connected to the bridge."""


class BridgeTimeoutError(BridgeError):
    """Command timed out waiting for a result from the extension."""


class BridgeCommandError(BridgeError):
    """The extension returned ok=false for a command."""

    def __init__(self, message: str, *, command_result: Optional["CommandResult"] = None):
        super().__init__(message)
        self.command_result = command_result
        self.message = message

    def __str__(self) -> str:
        if self.command_result and self.command_result.data:
            return f"{self.message} (data={self.command_result.data})"
        return self.message


class BridgeAuthError(BridgeError):
    """Authentication failed with the bridge server."""


class BridgeProtocolError(BridgeError):
    """Received a malformed message from the extension or server."""
