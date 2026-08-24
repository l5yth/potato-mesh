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

"""Read-only diagnostic probe for Meshtastic ``via_mqtt`` provenance (issue #884).

This module answers one empirical question before any filtering feature is
built: **does a packet that a neighbouring node bridged from MQTT onto LoRa
still carry the ``via_mqtt`` bit when our radio receives it over the air?**

Meshtastic carries ``via_mqtt`` both on :class:`MeshPacket` (per transmission)
and on :class:`NodeInfo` (per node-database entry).  The protobuf field has no
presence, so ``MessageToDict`` omits it when false — a key that is *present* is
always ``True``, and an absent key means "not flagged".

The discriminator this probe exists to capture is the pairing of ``via_mqtt``
with **RF receive metadata** (``rxSnr`` / ``rxRssi``).  Those fields are stamped
by the local radio when it demodulates a transmission, so a packet carrying
both was genuinely heard over the air *and* is flagged as MQTT-originated —
which is exactly the ``mqtt-over-rf`` case a packet-level filter would need to
catch.  A ``via_mqtt`` packet with no RF metadata would instead have arrived
through the host's own MQTT client, which PotatoMesh never operates.

Nothing here mutates packets, drops traffic, transmits, or changes what is
POSTed to the web app: the probe only counts and logs.  It is inert unless the
operator sets :envvar:`VIA_MQTT_PROBE`, and is intended to be deleted once the
question is settled.
"""

from __future__ import annotations

import threading
from collections.abc import Iterable, Mapping

from . import config
from .serialization import _canonical_node_id, _first

#: Emit a rolling tally after every N probed packets.  Small enough that a quiet
#: mesh still produces a summary within a reasonable window, large enough that a
#: busy mesh does not drown the log in tallies.
_SUMMARY_EVERY = 25

#: Upper bound on how many distinct flagged sender IDs are echoed in a summary
#: line, so one pathological mesh cannot produce an unbounded log record.
_MAX_LISTED_SENDERS = 20

#: Stable ordering for tally output, so successive summaries line up visually.
_CLASSIFICATIONS = (
    "mqtt-over-rf",
    "mqtt-no-rf",
    "direct-rf",
    "no-rf-metadata",
)

#: Guards the module-level counters, which are written from the Meshtastic
#: pubsub background thread (packets) and the daemon main thread (snapshots).
_LOCK = threading.Lock()

#: Per-classification packet tallies since process start.
_counts: dict[str, int] = {name: 0 for name in _CLASSIFICATIONS}

#: Distinct canonical node IDs seen sending ``via_mqtt``-flagged packets.
_flagged_senders: set[str] = set()

#: Total packets the probe has classified, used to pace summary emission.
_probed_total = 0


def probe_enabled() -> bool:
    """Return ``True`` when the operator has switched the probe on.

    Read through :mod:`~data.mesh_ingestor.config` at call time rather than
    captured at import, so a test (or a future reload) that flips
    :data:`config.VIA_MQTT_PROBE` takes effect immediately.

    Returns:
        ``True`` when :envvar:`VIA_MQTT_PROBE` resolved truthy.
    """

    return bool(getattr(config, "VIA_MQTT_PROBE", False))


def _classify(via_mqtt: bool, has_rf_metadata: bool) -> str:
    """Bucket one packet by MQTT provenance and RF-reception evidence.

    Parameters:
        via_mqtt: Whether the packet carried a truthy ``via_mqtt`` flag.
        has_rf_metadata: Whether the local radio stamped ``rxSnr`` / ``rxRssi``,
            which it only does for a transmission it actually demodulated.

    Returns:
        One of :data:`_CLASSIFICATIONS`.  ``"mqtt-over-rf"`` is the finding that
        would justify a packet-level filter; ``"mqtt-no-rf"`` would instead
        indicate a host-side MQTT client, which PotatoMesh never runs.
    """

    if via_mqtt:
        return "mqtt-over-rf" if has_rf_metadata else "mqtt-no-rf"
    return "direct-rf" if has_rf_metadata else "no-rf-metadata"


def _emit_summary(total: int, counts: dict[str, int], senders: list[str]) -> None:
    """Log the rolling tally.

    Parameters:
        total: Number of packets classified so far.
        counts: Snapshot of the per-classification tallies.
        senders: Sorted, already-truncated list of flagged sender IDs.
    """

    config._debug_log(
        "via_mqtt probe tally",
        context="via_mqtt_probe.summary",
        severity="info",
        always=True,
        probed_packets=total,
        flagged_senders=senders,
        **{name.replace("-", "_"): counts[name] for name in _CLASSIFICATIONS},
    )


def probe_packet(packet: Mapping, decoded: Mapping) -> None:
    """Classify and log one received packet's MQTT provenance.

    A no-op unless :func:`probe_enabled` is true.  Never raises: the probe is a
    diagnostic bolted onto the live ingest path, so a malformed packet must
    degrade to a warning rather than interrupt ingestion.

    Parameters:
        packet: Packet mapping as published by the mesh interface.
        decoded: Decoded payload section, used only to report ``portnum``.

    Returns:
        ``None``.  Side effects are limited to counters and log output.
    """

    if not probe_enabled():
        return

    try:
        _probe_packet_inner(packet, decoded)
    except Exception as exc:
        config._debug_log(
            "via_mqtt probe failed; ingestion unaffected",
            context="via_mqtt_probe.packet",
            severity="warning",
            always=True,
            error_class=exc.__class__.__name__,
            error_message=str(exc),
        )


def _probe_packet_inner(packet: Mapping, decoded: Mapping) -> None:
    """Do the work of :func:`probe_packet` without the failure guard.

    Split out so the guard in :func:`probe_packet` stays a single narrow
    ``try`` around a named call rather than wrapping a long body.

    Parameters:
        packet: Packet mapping as published by the mesh interface.
        decoded: Decoded payload section, used only to report ``portnum``.
    """

    global _probed_total

    raw_flag = _first(packet, "viaMqtt", "via_mqtt", default=None)
    via_mqtt = bool(raw_flag)

    snr = _first(packet, "rxSnr", "rx_snr", "snr", default=None)
    rssi = _first(packet, "rxRssi", "rx_rssi", "rssi", default=None)
    has_rf_metadata = snr is not None or rssi is not None

    classification = _classify(via_mqtt, has_rf_metadata)

    from_raw = _first(packet, "fromId", "from_id", "from", default=None)
    from_id = _canonical_node_id(from_raw) or from_raw

    with _LOCK:
        _counts[classification] += 1
        if via_mqtt and from_id is not None:
            _flagged_senders.add(str(from_id))
        _probed_total += 1
        total = _probed_total
        due_for_summary = total % _SUMMARY_EVERY == 0
        counts_snapshot = dict(_counts)
        senders_snapshot = sorted(_flagged_senders)[:_MAX_LISTED_SENDERS]

    config._debug_log(
        "via_mqtt probe packet",
        context="via_mqtt_probe.packet",
        severity="info",
        always=True,
        classification=classification,
        via_mqtt=via_mqtt,
        from_id=from_id,
        portnum=_first(decoded, "portnum", default=None),
        channel=_first(packet, "channel", default=0),
        rx_snr=snr,
        rx_rssi=rssi,
        hop_limit=_first(packet, "hopLimit", "hop_limit", default=None),
        hop_start=_first(packet, "hopStart", "hop_start", default=None),
        relay_node=_first(packet, "relayNode", "relay_node", default=None),
    )

    if due_for_summary:
        _emit_summary(total, counts_snapshot, senders_snapshot)


def probe_snapshot(node_items: Iterable[tuple[str, object]]) -> None:
    """Report how much of the radio's node database carries ``via_mqtt``.

    Complements :func:`probe_packet` with the other half of the picture: the
    node-database flag is *sticky* (the Meshtastic client merges NodeInfo
    updates with ``dict.update``, and a false ``via_mqtt`` is omitted rather
    than sent, so the key can never be cleared once set).  Quantifying how many
    roster entries are flagged shows how much of the dashboard's node list
    originates from MQTT-bridged nodes rather than live local reception.

    A no-op unless :func:`probe_enabled` is true.  Never raises, and never
    consumes a one-shot iterator destructively for the caller — callers pass an
    already-materialised list.

    Parameters:
        node_items: ``(node_id, node)`` pairs as returned by a provider's
            ``node_snapshot_items``.

    Returns:
        ``None``.  Side effects are limited to log output.
    """

    if not probe_enabled():
        return

    try:
        total = 0
        flagged: list[str] = []
        for node_id, node in node_items:
            total += 1
            if bool(_first(node, "viaMqtt", "via_mqtt", default=None)):
                flagged.append(str(node_id))
        config._debug_log(
            "via_mqtt probe node snapshot",
            context="via_mqtt_probe.snapshot",
            severity="info",
            always=True,
            snapshot_nodes=total,
            flagged_nodes=len(flagged),
            flagged_node_ids=sorted(flagged)[:_MAX_LISTED_SENDERS],
        )
    except Exception as exc:
        config._debug_log(
            "via_mqtt probe snapshot failed; ingestion unaffected",
            context="via_mqtt_probe.snapshot",
            severity="warning",
            always=True,
            error_class=exc.__class__.__name__,
            error_message=str(exc),
        )


def _reset_probe_state() -> None:
    """Clear probe counters. Intended for use in tests only."""

    global _probed_total

    with _LOCK:
        for name in _CLASSIFICATIONS:
            _counts[name] = 0
        _flagged_senders.clear()
        _probed_total = 0


__all__ = [
    "probe_enabled",
    "probe_packet",
    "probe_snapshot",
    "_reset_probe_state",
]
