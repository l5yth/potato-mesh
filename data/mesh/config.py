"""Configuration values and logging helpers for the mesh daemon."""

from __future__ import annotations

import os
import time

# Environment-driven configuration values -------------------------------------------------

PORT = os.environ.get("MESH_SERIAL")
SNAPSHOT_SECS = int(os.environ.get("MESH_SNAPSHOT_SECS", "60"))
CHANNEL_INDEX = int(os.environ.get("MESH_CHANNEL_INDEX", "0"))
DEBUG = os.environ.get("DEBUG") == "1"
INSTANCE = os.environ.get("POTATOMESH_INSTANCE", "").rstrip("/")
API_TOKEN = os.environ.get("API_TOKEN", "")


# Reconnect configuration: retry delays are adjustable via environment variables to ease
# testing while keeping sensible defaults in production.
_RECONNECT_INITIAL_DELAY_SECS = float(os.environ.get("MESH_RECONNECT_INITIAL", "5"))
_RECONNECT_MAX_DELAY_SECS = float(os.environ.get("MESH_RECONNECT_MAX", "60"))
_CLOSE_TIMEOUT_SECS = float(os.environ.get("MESH_CLOSE_TIMEOUT", "5"))


def _debug_log(message: str) -> None:
    """Print ``message`` with a UTC timestamp when ``DEBUG`` is enabled."""

    if not DEBUG:
        return

    timestamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    print(f"[{timestamp}] [debug] {message}")


__all__ = [
    "API_TOKEN",
    "CHANNEL_INDEX",
    "DEBUG",
    "INSTANCE",
    "PORT",
    "SNAPSHOT_SECS",
    "_CLOSE_TIMEOUT_SECS",
    "_RECONNECT_INITIAL_DELAY_SECS",
    "_RECONNECT_MAX_DELAY_SECS",
    "_debug_log",
]
