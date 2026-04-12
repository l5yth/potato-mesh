# Copyright © 2025-26 l5yth & contributors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Configuration helpers for the potato-mesh ingestor."""

from __future__ import annotations

import math
import os
from datetime import datetime, timezone
from typing import Any

DEFAULT_SNAPSHOT_SECS = 60
"""Default interval, in seconds, between state snapshot uploads."""

DEFAULT_CHANNEL_INDEX = 0
"""Default LoRa channel index used when none is specified."""

DEFAULT_RECONNECT_INITIAL_DELAY_SECS = 5.0
"""Initial reconnection delay applied after connection loss."""

DEFAULT_RECONNECT_MAX_DELAY_SECS = 60.0
"""Maximum reconnection backoff delay applied by the ingestor."""

DEFAULT_CLOSE_TIMEOUT_SECS = 5.0
"""Grace period for interface shutdown routines to complete."""

DEFAULT_INACTIVITY_RECONNECT_SECS = float(60 * 60)
"""Interval before forcing a reconnect when no packets are observed."""

DEFAULT_ENERGY_ONLINE_DURATION_SECS = 300.0
"""Duration to stay online before entering a low-power sleep cycle."""

DEFAULT_ENERGY_SLEEP_SECS = float(6 * 60 * 60)
"""Sleep duration used when energy saving mode is active."""

DEFAULT_INGESTOR_HEARTBEAT_SECS = float(60 * 60)
"""Interval between ingestor heartbeat announcements."""

DEFAULT_SELF_NODE_REPORT_INTERVAL_SECS = float(60 * 60)
"""Interval between periodic forced self-node re-reports from the daemon."""

CONNECTION = os.environ.get("CONNECTION")
"""Optional connection target for the mesh interface.

When unset, platform-specific defaults will be inferred by the interface
implementations.
"""

SNAPSHOT_SECS = DEFAULT_SNAPSHOT_SECS
"""Interval, in seconds, between state snapshot uploads."""

CHANNEL_INDEX = int(os.environ.get("CHANNEL_INDEX", str(DEFAULT_CHANNEL_INDEX)))
"""Index of the LoRa channel to select when connecting."""

DEBUG = os.environ.get("DEBUG") == "1"

_KNOWN_PROTOCOLS = ("meshtastic", "meshcore")

_raw_protocol = os.environ.get("PROTOCOL", "meshtastic").strip().lower()
if _raw_protocol not in _KNOWN_PROTOCOLS:
    raise ValueError(
        f"Unknown PROTOCOL={_raw_protocol!r}. "
        f"Valid options: {', '.join(_KNOWN_PROTOCOLS)}"
    )

PROTOCOL = _raw_protocol
"""Active ingestion protocol, selected via the :envvar:`PROTOCOL` environment variable.

Accepted values are ``meshtastic`` (default) and ``meshcore``.
"""


def _parse_lora_freq_env(raw: str | None) -> float | int | None:
    """Parse the ``FREQUENCY`` environment variable into a numeric LoRa frequency.

    Returns an :class:`int` for whole-number strings (e.g. ``"868"``), a
    :class:`float` for decimal strings (e.g. ``"869.525"``), or ``None`` when
    *raw* is empty, absent, non-numeric, or non-finite (e.g. ``"inf"``).

    Non-numeric labels such as ``"EU_868"`` intentionally return ``None`` so
    that :data:`LORA_FREQ` is left unset and :func:`~interfaces._ensure_radio_metadata`
    can still populate it from the detected radio configuration.

    Parameters:
        raw: Raw value of the ``FREQUENCY`` environment variable.

    Returns:
        Numeric frequency value, or ``None``.
    """
    if not raw:
        return None
    stripped = raw.strip()
    if not stripped:
        return None
    try:
        as_float = float(stripped)
    except ValueError:
        return None
    if not math.isfinite(as_float):
        return None
    return int(as_float) if as_float == int(as_float) else as_float


def _parse_channel_names(raw_value: str | None) -> tuple[str, ...]:
    """Normalise a comma-separated list of channel names.

    Parameters:
        raw_value: Raw environment string containing channel names separated by
            commas. ``None`` and empty segments are ignored.

    Returns:
        A tuple of unique, non-empty channel names preserving input order while
        deduplicating case-insensitively.
    """

    if not raw_value:
        return ()

    normalized_entries: list[str] = []
    seen: set[str] = set()
    for part in raw_value.split(","):
        name = part.strip()
        if not name:
            continue
        key = name.casefold()
        if key in seen:
            continue
        seen.add(key)
        normalized_entries.append(name)

    return tuple(normalized_entries)


def _parse_hidden_channels(raw_value: str | None) -> tuple[str, ...]:
    """Compatibility wrapper that parses hidden channel names."""

    return _parse_channel_names(raw_value)


HIDDEN_CHANNELS = _parse_hidden_channels(os.environ.get("HIDDEN_CHANNELS"))
"""Channel names configured to be ignored by the ingestor."""

ALLOWED_CHANNELS = _parse_channel_names(os.environ.get("ALLOWED_CHANNELS"))
"""Explicitly permitted channel names; when set, other channels are ignored."""


def _resolve_instance_domain() -> str:
    """Resolve the configured instance domain from the environment.

    Reads the :envvar:`INSTANCE_DOMAIN` variable. When the value does not
    contain a scheme, ``https://`` is prepended automatically.

    .. note::

        Kept for backward compatibility with existing tests and callers.
        New code should use :func:`_resolve_instance_domains` instead.
    """

    configured_instance = os.environ.get("INSTANCE_DOMAIN", "").rstrip("/")

    if configured_instance and "://" not in configured_instance:
        return f"https://{configured_instance}"

    return configured_instance


def _normalise_domain(raw: str) -> str:
    """Strip whitespace and trailing slashes, prepend ``https://`` when needed.

    Parameters:
        raw: Single domain string to normalise.

    Returns:
        A URL string with a scheme prefix.
    """

    domain = raw.strip().rstrip("/")
    if domain and "://" not in domain:
        return f"https://{domain}"
    return domain


def _resolve_instance_domains() -> tuple[tuple[str, str], ...]:
    """Parse :envvar:`INSTANCE_DOMAIN` and :envvar:`API_TOKEN` into paired tuples.

    When ``INSTANCE_DOMAIN`` contains comma-separated values, each entry is
    treated as an independent target.  ``API_TOKEN`` is either broadcast to
    every target (single value) or positionally paired (comma-separated with
    a matching count).

    Returns:
        A tuple of ``(instance_url, api_token)`` pairs, deduplicated by URL.

    Raises:
        ValueError: When the number of comma-separated tokens exceeds the
            number of domains.
    """

    raw_domain = os.environ.get("INSTANCE_DOMAIN", "")
    raw_token = os.environ.get("API_TOKEN", "")

    domains: list[str] = []
    seen: set[str] = set()
    for part in raw_domain.split(","):
        normalised = _normalise_domain(part)
        if not normalised:
            continue
        key = normalised.casefold()
        if key in seen:
            continue
        seen.add(key)
        domains.append(normalised)

    if not domains:
        return ()

    tokens = [t.strip() for t in raw_token.split(",")]
    # A single token (including empty string) is broadcast to all domains.
    if len(tokens) == 1:
        token = tokens[0]
        return tuple((d, token) for d in domains)

    if len(tokens) != len(domains):
        raise ValueError(
            f"API_TOKEN has {len(tokens)} comma-separated values but "
            f"INSTANCE_DOMAIN has {len(domains)}; counts must match or "
            f"API_TOKEN must be a single value"
        )

    return tuple(zip(domains, tokens))


INSTANCES: tuple[tuple[str, str], ...] = _resolve_instance_domains()
"""Paired ``(instance_url, api_token)`` tuples derived from the environment."""

INSTANCE = INSTANCES[0][0] if INSTANCES else _resolve_instance_domain()
"""First configured instance URL, kept for backward compatibility."""

API_TOKEN = INSTANCES[0][1] if INSTANCES else os.environ.get("API_TOKEN", "")
"""API token for the first configured instance, kept for backward compatibility."""
ENERGY_SAVING = os.environ.get("ENERGY_SAVING") == "1"
"""When ``True``, enables the ingestor's energy saving mode."""

LORA_FREQ: float | int | str | None = _parse_lora_freq_env(os.environ.get("FREQUENCY"))
"""Frequency of the local node's configured LoRa region in MHz or raw region label.

Pre-seeded from the ``FREQUENCY`` environment variable when set to a finite
numeric value, allowing operators to override auto-detected values.
Non-numeric or non-finite values are ignored so that auto-detection from the
radio interface can still fill this in.
"""

MODEM_PRESET: str | None = None
"""CamelCase modem preset name reported by the local node."""

_RECONNECT_INITIAL_DELAY_SECS = DEFAULT_RECONNECT_INITIAL_DELAY_SECS
_RECONNECT_MAX_DELAY_SECS = DEFAULT_RECONNECT_MAX_DELAY_SECS
_CLOSE_TIMEOUT_SECS = DEFAULT_CLOSE_TIMEOUT_SECS
_INACTIVITY_RECONNECT_SECS = DEFAULT_INACTIVITY_RECONNECT_SECS
_ENERGY_ONLINE_DURATION_SECS = DEFAULT_ENERGY_ONLINE_DURATION_SECS
_ENERGY_SLEEP_SECS = DEFAULT_ENERGY_SLEEP_SECS
_INGESTOR_HEARTBEAT_SECS = DEFAULT_INGESTOR_HEARTBEAT_SECS
_SELF_NODE_REPORT_INTERVAL_SECS = DEFAULT_SELF_NODE_REPORT_INTERVAL_SECS


def _debug_log(
    message: str,
    *,
    context: str | None = None,
    severity: str = "debug",
    always: bool = False,
    **metadata: Any,
) -> None:
    """Print ``message`` with a UTC timestamp when ``DEBUG`` is enabled.

    Parameters:
        message: Text to display when debug logging is active.
        context: Optional logical component emitting the message.
        severity: Log level label to embed in the formatted output.
        always: When ``True``, bypasses the :data:`DEBUG` guard.
        **metadata: Additional structured log metadata.
    """

    normalized_severity = severity.lower()

    if not DEBUG and not always and normalized_severity == "debug":
        return

    timestamp = datetime.now(timezone.utc).isoformat(timespec="milliseconds")
    timestamp = timestamp.replace("+00:00", "Z")
    parts = [f"[{timestamp}]", "[potato-mesh]", f"[{normalized_severity}]"]
    if context:
        parts.append(f"context={context}")
    for key, value in sorted(metadata.items()):
        parts.append(f"{key}={value!r}")
    parts.append(message)
    print(" ".join(parts))


__all__ = [
    "CONNECTION",
    "SNAPSHOT_SECS",
    "CHANNEL_INDEX",
    "DEBUG",
    "HIDDEN_CHANNELS",
    "ALLOWED_CHANNELS",
    "INSTANCE",
    "INSTANCES",
    "API_TOKEN",
    "ENERGY_SAVING",
    "LORA_FREQ",
    "MODEM_PRESET",
    "_RECONNECT_INITIAL_DELAY_SECS",
    "_RECONNECT_MAX_DELAY_SECS",
    "_CLOSE_TIMEOUT_SECS",
    "_INACTIVITY_RECONNECT_SECS",
    "_ENERGY_ONLINE_DURATION_SECS",
    "_ENERGY_SLEEP_SECS",
    "_INGESTOR_HEARTBEAT_SECS",
    "_SELF_NODE_REPORT_INTERVAL_SECS",
    "_debug_log",
]
