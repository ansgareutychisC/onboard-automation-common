"""onboard_common

Common library for onboarding automation tools. Provides:
  - ExtensionBridge: async client for the unified browser extension
  - Protocol constants mirroring extension/lib/protocol.js
  - Exception hierarchy

Usage:
    from onboard_common import ExtensionBridge, CommandType

    async with ExtensionBridge("http://127.0.0.1:8787") as bridge:
        await bridge.wait_for_extension(timeout=60)
        result = await bridge.tabs_open("https://example.com")
        tab_id = result.get("tabId")
        await bridge.form_fill(tab_id, "input[name=email]", "user@example.com")
        await bridge.form_click(tab_id, "button[type=submit]")
"""

from .extension_bridge import ExtensionBridge
from .protocol import (
    PROTOCOL_VERSION, CommandType, MessageType, LogLevel, Context,
    Command, CommandResult, DEFAULT_TIMEOUT_MS,
)
from .exceptions import (
    BridgeError, BridgeConnectionError, BridgeNotConnectedError,
    BridgeTimeoutError, BridgeCommandError, BridgeAuthError, BridgeProtocolError,
)

__all__ = [
    "PROTOCOL_VERSION",
    "CommandType", "MessageType", "LogLevel", "Context",
    "Command", "CommandResult", "DEFAULT_TIMEOUT_MS",
    "ExtensionBridge",
    "BridgeError", "BridgeConnectionError", "BridgeNotConnectedError",
    "BridgeTimeoutError", "BridgeCommandError", "BridgeAuthError", "BridgeProtocolError",
]

__version__ = "1.0.0"
