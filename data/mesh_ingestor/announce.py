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

"""Activity announcement: dogfeed the instance API and build the broadcast text.

SPEC decision **MA6** — the ingestor periodically broadcasts a one-line activity
summary on its protocol's default channel, drawing the numbers **back from the
target instance's own API** (dogfeeding: one radio may not see the whole mesh).

This module owns the read-only *dogfeed* HTTP client (GET ``/version`` and
``/api/stats`` — both public, no auth) and the character-limited message builder.
The transmit primitive lives on each provider (``send_channel_announcement``,
MA9); the scheduling and the ``RX_ONLY`` / privacy / 24-hour gates live in the
daemon (MA7/MA8). Every fetch fails **soft** — any network or
shape error returns ``None`` so the caller can fail closed.
"""

from __future__ import annotations

import json
import time
import urllib.request

from . import config

#: Conservative single-frame text limits per protocol (SPEC MA6). ASCII bytes ≈
#: characters; the announcement template is short, so truncation is only a
#: safety net for an unusually long instance domain.
ANNOUNCE_CHAR_LIMITS = {"meshtastic": 200, "meshcore": 140}

#: Fallback character limit for an unrecognised protocol.
_DEFAULT_CHAR_LIMIT = 140

#: Human-facing protocol labels used in the announcement line.
_PROTOCOL_DISPLAY_NAMES = {"meshtastic": "Meshtastic", "meshcore": "MeshCore"}

#: Timeout (seconds) for each dogfeed GET.
_DOGFEED_TIMEOUT_SECS = 10

#: Browser-like headers mirroring :mod:`~data.mesh_ingestor.queue` so an instance
#: behind Cloudflare does not block the dogfeed request.
_HTTP_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json",
    "Accept-Language": "en-US,en;q=0.9",
}


def _get_json(url: str, *, timeout: float = _DOGFEED_TIMEOUT_SECS) -> dict | None:
    """GET *url* and parse a JSON object.

    Parameters:
        url: Absolute URL to fetch.
        timeout: Socket timeout in seconds.

    Returns:
        The decoded mapping, or ``None`` on any network / decode error or when
        the payload is not a JSON object.
    """

    req = urllib.request.Request(url, headers=dict(_HTTP_HEADERS))
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except Exception as exc:
        config._debug_log(
            "dogfeed GET failed",
            context="announce.get",
            severity="warn",
            url=url,
            error_class=exc.__class__.__name__,
            error_message=str(exc),
        )
        return None
    return payload if isinstance(payload, dict) else None


def fetch_private_mode(
    instance_url: str, *, timeout: float = _DOGFEED_TIMEOUT_SECS
) -> bool | None:
    """Return the target instance's ``private_mode`` flag from ``GET /version``.

    Parameters:
        instance_url: Base URL of the PotatoMesh instance (e.g. ``https://mesh``).
        timeout: Socket timeout in seconds.

    Returns:
        ``True`` / ``False`` for a well-formed response, or ``None`` when the
        fetch fails or the flag is absent/malformed. The caller treats ``None``
        as "assume private, skip" (fail-closed — SPEC MA7 / Invariant II).
    """

    data = _get_json(f"{instance_url}/version", timeout=timeout)
    if not isinstance(data, dict):
        return None
    config_block = data.get("config")
    if not isinstance(config_block, dict):
        return None
    value = config_block.get("private_mode")
    return value if isinstance(value, bool) else None


def fetch_activity(
    instance_url: str, protocol: str, *, timeout: float = _DOGFEED_TIMEOUT_SECS
) -> tuple[int, float | int] | None:
    """Return ``(active_nodes, packets_per_hour)`` for *protocol* from ``/api/stats``.

    These are the mesh-wide numbers the announcement quotes (SPEC MA6):
    ``active_nodes`` = ``<protocol>.nodes.day`` and ``packets_per_hour`` =
    ``<protocol>.packets.hour`` (the MA4 rate exposed under each scope).

    Parameters:
        instance_url: Base URL of the PotatoMesh instance.
        protocol: ``"meshtastic"`` or ``"meshcore"``.
        timeout: Socket timeout in seconds.

    Returns:
        A ``(active_nodes, packets_per_hour)`` tuple, or ``None`` on any
        fetch/parse error or malformed shape.
    """

    data = _get_json(f"{instance_url}/api/stats", timeout=timeout)
    if not isinstance(data, dict):
        return None
    scope = data.get(protocol)
    if not isinstance(scope, dict):
        return None
    nodes = scope.get("nodes")
    packets = scope.get("packets")
    if not isinstance(nodes, dict) or not isinstance(packets, dict):
        return None
    active_nodes = nodes.get("day")
    packets_per_hour = packets.get("hour")
    if not isinstance(active_nodes, int) or not isinstance(
        packets_per_hour, (int, float)
    ):
        return None
    return int(active_nodes), packets_per_hour


def protocol_display_name(protocol: str | None) -> str:
    """Return the human-facing protocol label used in the announcement.

    Parameters:
        protocol: Protocol key (e.g. ``"meshcore"``).

    Returns:
        A display label (``"MeshCore"``), the capitalised key for an unknown
        protocol, or ``""`` when *protocol* is empty.
    """

    if not protocol:
        return ""
    return _PROTOCOL_DISPLAY_NAMES.get(protocol, protocol.capitalize())


def build_announcement(
    protocol: str,
    active_nodes: int,
    packets_per_hour: float | int,
    instance_url: str,
    *,
    char_limit: int | None = None,
) -> str:
    """Build the activity announcement line (SPEC MA6).

    Format: ``"<Protocol> activity in the last 24h: <N> active nodes, <M>
    packets/hour. <instance_url>"``, truncated to the protocol's character limit.

    Parameters:
        protocol: ``"meshtastic"`` or ``"meshcore"``.
        active_nodes: 24-hour active-node count for *protocol*.
        packets_per_hour: 24-hour packets/hour moving average for *protocol*.
        instance_url: Base URL of the instance (already carries the scheme).
        char_limit: Optional explicit limit; defaults to the protocol's entry in
            :data:`ANNOUNCE_CHAR_LIMITS`.

    Returns:
        The announcement string, truncated to fit the character limit.
    """

    text = (
        f"{protocol_display_name(protocol)} activity in the last 24h: "
        f"{active_nodes} active nodes, {packets_per_hour} packets/hour. "
        f"{instance_url}"
    )
    limit = (
        char_limit
        if char_limit is not None
        else ANNOUNCE_CHAR_LIMITS.get(protocol, _DEFAULT_CHAR_LIMIT)
    )
    if limit is not None and len(text) > limit:
        text = text[:limit]
    return text


# ---------------------------------------------------------------------------
# Scheduling & gating (SPEC MA7/MA8)
# ---------------------------------------------------------------------------

#: The first announcement is withheld until the ingestor has been running this
#: long, so the dogfed 24-hour numbers are accurate over a full window and a
#: restart storm cannot spam the channel (SPEC MA7 d).
ANNOUNCE_INITIAL_DELAY_SECS = 24 * 60 * 60

#: Minimum spacing between announcement cycles once eligible (SPEC MA8).
ANNOUNCE_INTERVAL_SECS = 24 * 60 * 60


def announcements_enabled() -> bool:
    """Return whether announcements may be transmitted at all (SPEC MA7 a).

    ``True`` only when :data:`~data.mesh_ingestor.config.RX_ONLY` is off — the
    reused receive-only flag (default off) is the single transmit gate; there is
    no separate enable switch.

    Returns:
        ``True`` when the transmit gate permits an announcement.
    """

    return not getattr(config, "RX_ONLY", False)


def announce_due(*, start_time: float, last_announce: float | None, now: float) -> bool:
    """Return whether an announcement cycle is due (SPEC MA7 d / MA8).

    Parameters:
        start_time: Unix time the ingestor started.
        last_announce: Unix time of the previous cycle, or ``None`` if none yet.
        now: Current unix time.

    Returns:
        ``True`` when at least :data:`ANNOUNCE_INITIAL_DELAY_SECS` have elapsed
        since *start_time* **and** at least :data:`ANNOUNCE_INTERVAL_SECS` since
        *last_announce*.
    """

    if now - start_time < ANNOUNCE_INITIAL_DELAY_SECS:
        return False
    if last_announce is not None and now - last_announce < ANNOUNCE_INTERVAL_SECS:
        return False
    return True


def send_announcement_to_instance(
    provider: object, iface: object, instance_url: str, protocol: str
) -> bool:
    """Dogfeed one instance and, unless it is private, build and send the line.

    The privacy gate is **fail-closed** (SPEC MA7 c / Invariant II): the
    announcement is sent only when ``/version`` explicitly reports
    ``private_mode == False``; a ``True`` flag or any fetch/parse error skips it.

    Parameters:
        provider: Active mesh provider exposing ``send_channel_announcement``.
        iface: Live mesh interface to transmit through.
        instance_url: Base URL of the target PotatoMesh instance.
        protocol: The ingestor's protocol (``"meshtastic"`` / ``"meshcore"``).

    Returns:
        ``True`` when an announcement was transmitted, ``False`` otherwise.
    """

    if fetch_private_mode(instance_url) is not False:
        config._debug_log(
            "Activity announcement skipped: instance private or unreachable",
            context="announce.tx",
            url=instance_url,
        )
        return False
    numbers = fetch_activity(instance_url, protocol)
    if numbers is None:
        config._debug_log(
            "Activity announcement skipped: no activity numbers from instance",
            context="announce.tx",
            url=instance_url,
        )
        return False
    active_nodes, packets_per_hour = numbers
    send = getattr(provider, "send_channel_announcement", None)
    if not callable(send):
        config._debug_log(
            "Activity announcement skipped: provider cannot transmit",
            context="announce.tx",
            url=instance_url,
            protocol=protocol,
        )
        return False
    text = build_announcement(protocol, active_nodes, packets_per_hour, instance_url)
    # Emitted for every outbound announcement so each TX is traceable end-to-end
    # (the provider then logs the mesh-layer send).
    config._debug_log(
        "Activity announcement transmitting",
        context="announce.tx",
        url=instance_url,
        protocol=protocol,
        active_nodes=active_nodes,
        packets_per_hour=packets_per_hour,
        text=text,
    )
    send(iface, text)
    return True


def run_announcement_cycle(
    provider: object, iface: object, *, protocol: str | None = None
) -> bool:
    """Announce to **every** configured instance domain (SPEC MA6/MA8 per-domain).

    Each instance is dogfed and sent its own numbers/link independently; a
    failure against one instance never aborts the others.

    Parameters:
        provider: Active mesh provider.
        iface: Live mesh interface.
        protocol: Override protocol; defaults to
            :data:`~data.mesh_ingestor.config.PROTOCOL`.

    Returns:
        ``True`` when at least one announcement was transmitted.
    """

    protocol = protocol or getattr(config, "PROTOCOL", "meshtastic")
    sent_any = False
    for instance_url, _api_token in getattr(config, "INSTANCES", ()):
        try:
            if send_announcement_to_instance(provider, iface, instance_url, protocol):
                sent_any = True
        except Exception as exc:
            config._debug_log(
                "activity announcement failed",
                context="announce.cycle",
                severity="warn",
                url=instance_url,
                error_class=exc.__class__.__name__,
                error_message=str(exc),
            )
    return sent_any


def maybe_run_announcements(
    provider: object,
    iface: object,
    *,
    start_time: float,
    last_announce: float | None,
    now: float | None = None,
) -> float | None:
    """Daemon entry point: run an announcement cycle when scheduled (SPEC MA7/MA8).

    Applies the enable / RX-only gate and the 24-hour schedule, then dogfeeds and
    announces to each configured instance. The cycle timestamp advances whenever
    the schedule fires (whether or not any instance was actually announced to),
    so a private or unreachable instance is retried on the next 24-hour tick
    rather than on every loop iteration.

    Parameters:
        provider: Active mesh provider.
        iface: Live mesh interface.
        start_time: Unix time the ingestor started.
        last_announce: Unix time of the previous cycle, or ``None``.
        now: Current unix time; defaults to :func:`time.time`.

    Returns:
        The updated ``last_announce`` timestamp — *now* when a cycle ran, else
        the unchanged *last_announce*.
    """

    if now is None:
        now = time.time()
    if not announcements_enabled():
        return last_announce
    if not announce_due(start_time=start_time, last_announce=last_announce, now=now):
        return last_announce
    run_announcement_cycle(provider, iface)
    return now


__all__ = [
    "ANNOUNCE_CHAR_LIMITS",
    "ANNOUNCE_INITIAL_DELAY_SECS",
    "ANNOUNCE_INTERVAL_SECS",
    "announce_due",
    "announcements_enabled",
    "build_announcement",
    "fetch_activity",
    "fetch_private_mode",
    "maybe_run_announcements",
    "protocol_display_name",
    "run_announcement_cycle",
    "send_announcement_to_instance",
]
