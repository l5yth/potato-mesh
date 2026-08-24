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

import base64
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


#: Values accepted as "on" by :func:`_env_flag`, compared case-insensitively
#: after stripping.  Deliberately broader than the historic exact-``"1"`` test:
#: a transmit switch spelled ``true`` must not silently mean *transmit*.
_TRUTHY_FLAG_VALUES = frozenset({"1", "true", "yes", "on"})

#: Values accepted as "off" by :func:`_env_flag`.
_FALSY_FLAG_VALUES = frozenset({"0", "false", "no", "off"})


def _env_flag(name: str, *, default: bool, on_invalid: bool) -> bool:
    """Resolve a boolean environment variable, failing safe on garbage.

    Boolean env vars were historically compared as ``os.environ.get(X) == "1"``,
    which silently resolved ``true``/``TRUE``/``yes``/``" 1"`` to :data:`False`.
    For a *transmit* switch that is a fail-**open** bug: an operator who wrote
    ``RX_ONLY=true`` got an ingestor that transmitted anyway.  This parser
    accepts the common spellings, strips surrounding whitespace (so a stray
    space in a ``.env`` file is inert, matching :data:`MESH_UDP_PORT`), and
    resolves anything it cannot understand to *on_invalid* — which each caller
    sets to whichever value means "do not transmit" — after warning loudly.

    A blank value is treated as unset so an empty ``.env`` line means "default",
    not "off" — the same blank tolerance :data:`MESH_UDP_PORT` has.

    Unparseable values **warn rather than raise**, deliberately unlike
    :data:`TRANSPORT` and :data:`PROTOCOL` (which reject an unknown value at
    import) and unlike :data:`MESH_UDP_PORT` (whose ``int()`` raises on
    anything non-numeric).  Those are *selectors*: with no safe fallback,
    refusing to start is the only correct answer.  A transmit flag has one — it
    can resolve toward silence — so a typo costs the operator a feature they
    have to notice is missing, not an ingestor that crash-loops and stops
    receiving.  Since receiving is the ingestor's whole job, staying up while
    transmitting nothing strictly dominates.

    Parameters:
        name: Environment variable to read.
        default: Value used when the variable is unset or blank.
        on_invalid: Value used when the variable holds an unrecognized string.
            Callers pass the fail-safe side of their own switch.

    Returns:
        The resolved boolean.
    """

    raw = os.environ.get(name)
    if raw is None:
        return default
    normalized = raw.strip().lower()
    if not normalized:
        return default
    if normalized in _TRUTHY_FLAG_VALUES:
        return True
    if normalized in _FALSY_FLAG_VALUES:
        return False
    _debug_log(
        f"Unrecognized {name} value; treating as {'1' if on_invalid else '0'}",
        context="config",
        severity="warning",
        variable=name,
        value=raw,
        resolved=on_invalid,
        accepted=sorted(_TRUTHY_FLAG_VALUES | _FALSY_FLAG_VALUES),
    )
    return on_invalid

_KNOWN_PROTOCOLS = ("meshtastic", "meshcore", "reticulum")

_raw_protocol = os.environ.get("PROTOCOL", "meshtastic").strip().lower()
if _raw_protocol not in _KNOWN_PROTOCOLS:
    raise ValueError(
        f"Unknown PROTOCOL={_raw_protocol!r}. "
        f"Valid options: {', '.join(_KNOWN_PROTOCOLS)}"
    )

PROTOCOL = _raw_protocol
"""Active ingestion protocol, selected via the :envvar:`PROTOCOL` environment variable.

Accepted values are ``meshtastic`` (default), ``meshcore``, and ``reticulum``.
"""

RETICULUM_CONFIG_DIR = os.environ.get("RETICULUM_CONFIG_DIR", "").strip() or None
"""Optional Reticulum config directory for ``PROTOCOL=reticulum``.

Passed as ``configdir`` to :class:`RNS.Reticulum`; ``None`` (the default, and
the fallback for a blank value) lets RNS use its standard user config at
``~/.reticulum``."""

_raw_transport = os.environ.get("TRANSPORT", "api").strip().lower()
if _raw_transport not in ("api", "udp"):
    raise ValueError(f"Unknown TRANSPORT={_raw_transport!r}. Valid options: api, udp")
TRANSPORT = _raw_transport
"""Active ingestor transport: ``api`` (Meshtastic library) or ``udp`` (passive multicast)."""

PRIMARY_CHANNEL_ONLY = os.environ.get("PRIMARY_CHANNEL_ONLY") == "1"
"""When ``True``, only channel index 0 (PRIMARY) is ingested; all else is dropped."""

_raw_primary_key = os.environ.get("PRIMARY_CHANNEL_KEY", "AQ==").strip() or "AQ=="
try:
    # Decode exactly the way meshtastic_udp_decode.expand_default_key later
    # will, so a malformed key fails HERE with a clear startup error (parity
    # with the TRANSPORT/PROTOCOL validation above) instead of surfacing as a
    # lazy binascii.Error out of connect() that the daemon's generic
    # reconnect handler would swallow and retry forever.
    # binascii.Error and UnicodeEncodeError both subclass ValueError.
    base64.b64decode(_raw_primary_key.encode("ascii"), validate=True)
except ValueError as exc:
    raise ValueError(
        f"PRIMARY_CHANNEL_KEY is not valid base64: {_raw_primary_key!r}. "
        "Provide the channel PSK exactly as printed by `meshtastic --info` "
        '(e.g. "AQ==" for the default key).'
    ) from exc

PRIMARY_CHANNEL_KEY = _raw_primary_key
"""Base64 PSK used to decrypt the primary channel; defaults to the Meshtastic default key.

Validated as base64 at import time: a malformed value raises :class:`ValueError`
immediately (like an unknown :data:`TRANSPORT`), rather than failing lazily
inside ``channel_hash``/``decrypt_meshpacket`` during ``connect()``."""

PRIMARY_CHANNEL_NAME = os.environ.get("PRIMARY_CHANNEL_NAME", "").strip()
"""Name of the primary channel (e.g. ``"MediumFast"``), used to compute the
channel hash that identifies primary-channel traffic on the UDP multicast.

For a channel whose name is left blank in the radio config, this is the LoRa
modem-preset name the firmware substitutes when hashing (``"LongFast"``,
``"MediumFast"``, ``"ShortFast"``, ...) -- i.e. the name shown for channel 0 by
``meshtastic --info``. Required for UDP primary-channel filtering: two channels
can share the default ``AQ==`` key (a SECONDARY channel added with the default
PSK), so decryptability alone cannot distinguish PRIMARY from SECONDARY -- only
the per-channel hash of *(name, key)* can. When blank, UDP primary-only mode
fails closed (drops every packet) rather than risk leaking a secondary channel."""

MESH_UDP_GROUP = os.environ.get("MESH_UDP_GROUP", "224.0.0.69").strip() or "224.0.0.69"
"""IPv4 multicast group joined in UDP transport mode."""

MESH_UDP_PORT = int(os.environ.get("MESH_UDP_PORT", "4403").strip() or "4403")
"""UDP port for the Mesh-via-UDP multicast group.

The value is stripped and falls back to ``4403`` when blank, matching the other
UDP env vars, so a whitespace/empty ``MESH_UDP_PORT`` in a ``.env`` file does not
raise ``ValueError`` at import and prevent the service from starting."""

INGESTOR_NODE_ID = os.environ.get("INGESTOR_NODE_ID", "").strip() or None
"""Optional ``!xxxxxxxx`` host node id used for the ingestor heartbeat in UDP mode."""

TX_ENABLED = _env_flag("TX_ENABLED", default=False, on_invalid=False)
"""Master switch for every ingestor-initiated mesh transmission (SPEC MA7 a).

**Default off.**  An ingestor is a listener first: deploying one to feed a
dashboard does not imply consent to put traffic on the community's air.  Until
this is set, the ingestor is a pure receiver — no activity announcement, and no
MeshCore on-air contact telemetry/status polls.

Local companion-link reads (host self-telemetry, the contact roster, channel
queries) are *not* mesh transmissions: they travel over USB/BLE to the operator's
own radio, cost no airtime, and continue regardless of this flag.

Set ``TX_ENABLED=1`` to allow transmission.  This is the only documented transmit
switch; :data:`RX_ONLY` is its retired predecessor and still vetoes it.
Announcements additionally require :data:`TX_ANNOUNCE`.
"""

TX_ANNOUNCE = _env_flag("TX_ANNOUNCE", default=False, on_invalid=False)
"""Opt in to the periodic activity announcement (SPEC MA7 b).

**Default off**, and subordinate to :data:`TX_ENABLED`: the announcement is the
ingestor's only *unsolicited* transmission on a shared human channel, and local
conventions on automated traffic differ widely, so it takes a second deliberate
opt-in on top of the master switch.  ``TX_ENABLED=0`` overrides
``TX_ANNOUNCE=1``; both must be on before a single announcement is sent.
"""

RX_ONLY = _env_flag("RX_ONLY", default=False, on_invalid=True)
"""Legacy receive-only kill switch — superseded by :data:`TX_ENABLED`.

Honored wherever it reaches the process environment, so an existing deployment
that sets it keeps working, but removed from operator-facing documentation and
deliberately **not** added to the packaged deployment surfaces (compose, the
image, the Nix module) — it was never settable there, and new configurations
express the same intent by simply leaving :data:`TX_ENABLED` unset, which is now
the default.

It remains a **veto**.  Where it is set, no ingestor-initiated transmission
happens even if ``TX_ENABLED=1`` is also present — a kill switch an operator
deliberately engaged is never silently overridden by a flag that arrives later
in the same ``.env`` file.  That combination is contradictory, so
:func:`~data.mesh_ingestor.tx_policy.log_tx_policy` warns about it at startup.

Note the deliberately asymmetric fail-safe: an unparseable value resolves to
:data:`True` (silence), because for a kill switch the safe reading of garbage is
*engaged*.
"""

MESHCORE_TELEMETRY_POLL_SECONDS = int(
    os.environ.get("MESHCORE_TELEMETRY_POLL_SECONDS", "300").strip() or "300"
)
"""Seconds between successive MeshCore contact telemetry polls (TI-A3).

MeshCore exposes other nodes' telemetry only via on-air pull requests, so the
provider round-robins the contact roster issuing one request per interval —
airtime is bounded to one request per ``MESHCORE_TELEMETRY_POLL_SECONDS``
regardless of roster size.  Values ``<= 0`` disable contact polling entirely
(host self-telemetry is governed separately by
``MESHCORE_SELF_TELEMETRY_SECONDS``).  Stripped with a default fallback like
``MESH_UDP_PORT`` so a blank value in a ``.env`` file cannot break startup."""

MESHCORE_SELF_TELEMETRY_SECONDS = int(
    os.environ.get("MESHCORE_SELF_TELEMETRY_SECONDS", "3600").strip() or "3600"
)
"""Seconds between MeshCore host self-telemetry reads (battery + sensors).

Self reads are local companion-link commands (no LoRa airtime).  The default
matches the host-telemetry suppression window in
``handlers._state._HOST_TELEMETRY_INTERVAL_SECS`` (one hour) so more frequent
reads would only be suppressed anyway.  Values ``<= 0`` disable self polling."""


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
    "TRANSPORT",
    "PRIMARY_CHANNEL_ONLY",
    "PRIMARY_CHANNEL_KEY",
    "PRIMARY_CHANNEL_NAME",
    "MESH_UDP_GROUP",
    "MESH_UDP_PORT",
    "INGESTOR_NODE_ID",
    "RETICULUM_CONFIG_DIR",
    "TX_ENABLED",
    "TX_ANNOUNCE",
    "RX_ONLY",
    "PROTOCOL",
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
