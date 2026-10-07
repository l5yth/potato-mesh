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

"""Generic packet dispatcher, node upsert, and the main receive callback."""

from __future__ import annotations

import base64
import contextlib
import importlib
import json
import sys
import time
from collections.abc import Mapping

from .. import channels, config, queue
from ..serialization import (
    _canonical_node_id,
    _coerce_int,
    _first,
    _iso,
    _pkt_to_dict,
    upsert_payload,
)
from . import _state, ignored as _ignored_mod
from .neighborinfo import store_neighborinfo_packet
from .nodeinfo import store_nodeinfo_packet
from .position import store_position_packet
from .radio import _apply_radio_metadata, _apply_radio_metadata_to_nodes
from .receive_time import replace_skewed_rx_time
from .telemetry import store_router_heartbeat_packet, store_telemetry_packet
from .position import store_traceroute_packet
from .waypoint import store_waypoint_packet


def _portnum_candidates(name: str) -> set[int]:
    """Return Meshtastic port number candidates for ``name``.

    Meshtastic ships two protobuf module layouts (legacy and modern).  Both are
    probed so that port-number comparisons work regardless of which firmware
    version is installed.

    Parameters:
        name: Port name to look up in Meshtastic ``PortNum`` enums.

    Returns:
        Set of integer port numbers resolved from all available Meshtastic
        modules.
    """

    candidates: set[int] = set()
    for module_name in (
        "meshtastic.portnums_pb2",
        "meshtastic.protobuf.portnums_pb2",
    ):
        module = sys.modules.get(module_name)
        if module is None:
            with contextlib.suppress(ModuleNotFoundError):
                module = importlib.import_module(module_name)
        if module is None:
            continue
        portnum_enum = getattr(module, "PortNum", None)
        value_lookup = getattr(portnum_enum, "Value", None) if portnum_enum else None
        if callable(value_lookup):
            with contextlib.suppress(Exception):
                candidate = _coerce_int(value_lookup(name))
                if candidate is not None:
                    candidates.add(candidate)
        constant_value = getattr(module, name, None)
        candidate = _coerce_int(constant_value)
        if candidate is not None:
            candidates.add(candidate)
    return candidates


def _coerce_emoji_codepoint(raw: object) -> str | None:
    """Normalise an emoji candidate, converting numeric codepoints to characters.

    Meshtastic firmware may transmit reaction emoji as a Unicode codepoint
    integer (e.g. ``128077`` for 👍) rather than as the character itself.
    Values above 127 are treated as codepoints and converted via :func:`chr`;
    small values (≤ 127) are preserved as strings so that slot markers such as
    ``"1"`` pass through unchanged.

    When a numeric value claims to be a codepoint but lies outside the valid
    Unicode range (``> 0x10FFFF``), ``None`` is returned rather than the
    decimal string form — storing a multi-digit integer as the emoji would
    leak garbage into the rendered chat (numeric strings of length > 1 are
    not valid slot markers either).

    Parameters:
        raw: Raw emoji value from a decoded packet field.

    Returns:
        Normalised emoji string, or ``None`` when *raw* is empty or invalid.
    """

    if raw is None:
        return None

    # Numeric value (int / float) -------------------------------------------
    if isinstance(raw, (int, float)):
        n = int(raw)
        if n > 127:
            try:
                return chr(n)
            except (ValueError, OverflowError):
                # Value claimed to be a codepoint but is out of Unicode range;
                # do NOT preserve the decimal form (would render as garbage).
                return None
        text = str(raw).strip()
        return text or None

    # String (possibly a digit-encoded codepoint) ---------------------------
    try:
        text = str(raw).strip()
    except Exception:
        return None
    if not text:
        return None
    if text.isdigit():
        n = int(text)
        if n > 127:
            try:
                return chr(n)
            except (ValueError, OverflowError):
                # See comment above — multi-digit numeric strings outside the
                # Unicode range are not valid emoji nor slot markers.
                return None
    return text


#: Maximum Unicode codepoint length for text that may still qualify as a
#: reaction placeholder.  A bare emoji (single grapheme) is at most 2
#: codepoints — for example a base character plus a single variation
#: selector (U+FE0F).  Multi-codepoint ZWJ families (👨‍👩‍👧, 🏳️‍🌈) are
#: NOT accepted as placeholder text intentionally: matching them would
#: also let through short CJK messages like ``"你好世界吗"`` (5 codepoints,
#: no ASCII letters), causing real prose to be misclassified as a reaction.
#: This constant must stay aligned with the JS frontend's
#: ``isReactionPlaceholderText`` (``message-replies.js``); changing one
#: side without the other re-introduces ingest/render disagreement.
_REACTION_PLACEHOLDER_MAX_CODEPOINTS = 2


def _is_reaction_placeholder_text(text: str | None) -> bool:
    """Return ``True`` when *text* looks like a reaction slot or count marker.

    Reaction packets carry either no text at all, a small numeric count (e.g.
    ``"1"``, ``"3"``), or occasionally a bare emoji character.  Anything that
    looks like substantive prose should cause the packet to be classified as a
    regular text message instead of a reaction.

    Parameters:
        text: Message text to inspect (may be ``None``).

    Returns:
        ``True`` when *text* is absent, blank, a digit string, or a short
        non-ASCII-letter sequence (bare emoji).
    """

    if not text:
        return True
    stripped = text.strip()
    if not stripped:
        return True
    if stripped.isdigit():
        return True
    # Bare emoji heuristic — see _REACTION_PLACEHOLDER_MAX_CODEPOINTS.
    if len(stripped) <= _REACTION_PLACEHOLDER_MAX_CODEPOINTS and not any(
        c.isascii() and c.isalpha() for c in stripped
    ):
        return True
    return False


def _is_likely_reaction(
    portnum: str | None,
    portnum_int: int | None,
    reply_id: int | None,
    emoji: str | None,
    text: str | None,
) -> bool:
    """Determine whether a packet should be classified as a reaction.

    A packet is a reaction when it carries the ``REACTION_APP`` portnum
    explicitly, **or** when it has both a ``reply_id`` and an ``emoji`` and its
    text content is absent or a mere placeholder (digit slot / bare emoji).

    Parameters:
        portnum:     String portnum label from the packet.
        portnum_int: Integer portnum, if available.
        reply_id:    Reply-to message identifier.
        emoji:       Normalised emoji string (after codepoint coercion).
        text:        Message text extracted from the packet.

    Returns:
        ``True`` when the packet should be treated as a reaction.
    """

    if portnum == "REACTION_APP":
        return True
    reaction_port_candidates = _portnum_candidates("REACTION_APP")
    if portnum_int is not None and portnum_int in reaction_port_candidates:
        return True
    if reply_id is not None and emoji is not None:
        return _is_reaction_placeholder_text(text)
    return False


def _is_encrypted_flag(value: object) -> bool:
    """Return ``True`` when ``value`` represents an encrypted payload.

    Meshtastic may express the encrypted flag as a boolean, an integer, or a
    string depending on how the packet was decoded.  All representations are
    normalised to a Python bool.

    Parameters:
        value: Raw encrypted field from a Meshtastic packet.

    Returns:
        ``True`` when the payload is considered encrypted, ``False`` otherwise.
    """

    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"", "0", "false", "no"}:
            return False
        return True
    return bool(value)


def _hops_travelled(packet: Mapping, hop_limit: object) -> int | None:
    """Return the number of repeater hops a message actually travelled.

    Prefers an explicit ``hops`` value stamped by a protocol handler (MeshCore
    normalizes its native ``path_len`` field this way, including the
    255-means-direct sentinel).  Falls back to the Meshtastic derivation
    ``hopStart - hopLimit``: ``hopStart`` is the sender's initial hop budget
    and ``hopLimit`` the budget remaining on receipt, so their difference is
    the relay count (SPEC RF1).  Distinct from the stored ``hop_limit`` field,
    which keeps its remaining-budget semantic unchanged.

    Parameters:
        packet: Normalized packet mapping possibly carrying ``hops`` and/or
            ``hopStart``/``hop_start``.
        hop_limit: The already-extracted ``hopLimit``/``hop_limit`` value
            (passed in so the caller's single extraction is reused).

    Returns:
        The hop count as an ``int``, or ``None`` when neither source is
        present or a value cannot be coerced to an integer.
    """
    explicit = _first(packet, "hops", default=None)
    if explicit is not None:
        try:
            return int(explicit)
        except (TypeError, ValueError):
            return None
    hop_start = _first(packet, "hopStart", "hop_start", default=None)
    if hop_start is None or hop_limit is None:
        return None
    try:
        return int(hop_start) - int(hop_limit)
    except (TypeError, ValueError):
        return None


#: DEBUG log line for each ingest-filter drop reason; the channel wording is
#: kept verbatim from the per-filter checks the shared gate replaced.
_FILTER_LOG_MESSAGES = {
    "non-primary-channel": "Ignored packet on non-primary channel",
    "disallowed-channel": "Ignored packet on disallowed channel",
    "hidden-channel": "Ignored packet on hidden channel",
    "via_mqtt": "Ignored via_mqtt packet",
}


def _packet_channel(packet: Mapping, decoded: Mapping) -> tuple[int, bool]:
    """Return the channel ``packet`` was heard on and whether that is known.

    Meshtastic stamps the channel on every ``MeshPacket`` header, whatever the
    port, and proto3 omits the field when it is ``0``: a Meshtastic packet
    without one was heard on the primary channel.  Packets synthesised by
    other protocols carry ``channel`` only when they have one (MeshCore chat
    stamps it); one without it (a MeshCore telemetry pull) has no channel
    attribution, so no channel filter may guess one (SPEC CF2).

    Parameters:
        packet: Packet dictionary emitted by the mesh interface.
        decoded: The packet's ``decoded`` section.

    Returns:
        ``(channel_index, attributed)``.  ``channel_index`` falls back to ``0``
        when the packet carries no channel or an unparseable one;
        ``attributed`` is ``False`` only for a packet of another protocol that
        carries no ``channel`` at all.
    """

    raw = _first(decoded, "channel", default=None)
    if raw is None:
        raw = _first(packet, "channel", default=None)
    attributed = raw is not None or packet.get("protocol") in (None, "meshtastic")
    try:
        return int(raw if raw is not None else 0), attributed
    except Exception:
        return 0, attributed


def upsert_node(node_id: object, node: object) -> None:
    """Schedule an upsert for a single node.

    Serialises ``node`` via :func:`upsert_payload`, drops the meshtastic
    library's ``lastReceived`` packet copy, enriches the result with radio
    metadata and the current host node identifier, then enqueues a POST to
    ``/api/nodes``.

    Parameters:
        node_id: Canonical identifier for the node in the ``!xxxxxxxx`` format.
        node: Node object or mapping to serialise for the API payload.

    Returns:
        ``None``. The payload is forwarded to the shared HTTP queue.
    """

    payload = upsert_payload(node_id, node)
    serialised = payload[node_id]
    if isinstance(serialised, dict):
        # A library nodeDB entry carries the whole last packet heard from the
        # node, possibly one from a filtered channel; it is not part of the
        # /api/nodes contract (SPEC CF3).  Dropped from the serialised copy,
        # never the library's dict, so a dict the library mutates mid-snapshot
        # fails this node alone, inside the caller's per-node error handling.
        serialised.pop("lastReceived", None)
    payload = _apply_radio_metadata_to_nodes(payload)
    payload["ingestor"] = _state.host_node_id()
    # Per-record protocol stamp closes the startup race where the web app
    # processes a node upsert before the ingestor heartbeat registers a
    # protocol mapping for ``ingestor`` — see CONTRACTS.md.
    payload["protocol"] = config.PROTOCOL
    queue._queue_post_json("/api/nodes", payload, priority=queue._NODE_POST_PRIORITY)

    if config.DEBUG:
        from ..serialization import _get

        user = _get(payload[node_id], "user") or {}
        short = _get(user, "shortName")
        long = _get(user, "longName")
        config._debug_log(
            "Queued node upsert payload",
            context="handlers.upsert_node",
            node_id=node_id,
            short_name=short,
            long_name=long,
        )


def store_packet_dict(packet: Mapping) -> None:
    """Route a decoded packet to the appropriate storage handler.

    Every packet first passes the shared ingest filter
    (:func:`~data.mesh_ingestor.channels.ingest_filter_reason`); a dropped one
    is recorded as ignored with that reason.  The rest are classified by
    ``portnum`` (string and integer forms) and the presence of well-known
    decoded sub-sections, then delegated to the corresponding ``store_*``
    handler.

    Parameters:
        packet: Packet dictionary emitted by the mesh interface.

    Returns:
        ``None``. Side-effects depend on the specific handler invoked.
    """

    decoded = packet.get("decoded") or {}

    # One gate for every port (SPEC CF1/CF2, VM2): the dispatch below hands
    # telemetry, traceroutes, node info, positions, waypoints, neighbor info
    # and store-forward heartbeats to handlers that POST directly, so the
    # channel and via_mqtt filters must run before it, not only on messages.
    channel, attributed = _packet_channel(packet, decoded)
    reason = channels.ingest_filter_reason(
        channel if attributed else None,
        via_mqtt=bool(_first(packet, "viaMqtt", "via_mqtt", default=False)),
    )
    if reason is not None:
        _ignored_mod._record_ignored_packet(packet, reason=reason)
        log_fields = {
            "channel": channel,
            "channel_name": channels.channel_name(channel),
        }
        if reason == "disallowed-channel":
            log_fields["allowed_channels"] = channels.allowed_channel_names()
        config._debug_log(
            _FILTER_LOG_MESSAGES[reason],
            context="handlers.store_packet_dict",
            **log_fields,
        )
        return

    portnum_raw = _first(decoded, "portnum", default=None)
    portnum = str(portnum_raw).upper() if portnum_raw is not None else None
    portnum_int = _coerce_int(portnum_raw)

    telemetry_section = (
        decoded.get("telemetry") if isinstance(decoded, Mapping) else None
    )
    if (
        portnum == "TELEMETRY_APP"
        or portnum_int == 65
        or isinstance(telemetry_section, Mapping)
    ):
        store_telemetry_packet(packet, decoded)
        return

    traceroute_section = (
        decoded.get("traceroute") if isinstance(decoded, Mapping) else None
    )
    traceroute_port_ints = _portnum_candidates("TRACEROUTE_APP")

    if (
        portnum == "TRACEROUTE_APP"
        or (portnum_int is not None and portnum_int in traceroute_port_ints)
        or isinstance(traceroute_section, Mapping)
    ):
        store_traceroute_packet(packet, decoded)
        return

    if portnum in {"5", "NODEINFO_APP"}:
        store_nodeinfo_packet(packet, decoded)
        return

    if portnum in {"4", "POSITION_APP"}:
        store_position_packet(packet, decoded)
        return

    # Waypoints (community POIs, SPEC W1) were previously unhandled and fell
    # through to the message/ignored paths. Route by portnum (string or int)
    # or by the presence of a decoded ``waypoint`` section, mirroring the
    # traceroute dispatch above.
    waypoint_section = decoded.get("waypoint") if isinstance(decoded, Mapping) else None
    waypoint_port_ints = _portnum_candidates("WAYPOINT_APP")
    if (
        portnum == "WAYPOINT_APP"
        or (portnum_int is not None and portnum_int in waypoint_port_ints)
        or isinstance(waypoint_section, Mapping)
    ):
        store_waypoint_packet(packet, decoded)
        return

    neighborinfo_section = (
        decoded.get("neighborinfo") if isinstance(decoded, Mapping) else None
    )
    if portnum == "NEIGHBORINFO_APP" or isinstance(neighborinfo_section, Mapping):
        store_neighborinfo_packet(packet, decoded)
        return

    store_forward_port_candidates = _portnum_candidates("STORE_FORWARD_APP")
    store_forward_section = (
        decoded.get("storeforward") if isinstance(decoded, Mapping) else None
    )
    if portnum == "STORE_FORWARD_APP" or (
        portnum_int is not None and portnum_int in store_forward_port_candidates
    ):
        if not isinstance(store_forward_section, Mapping):
            _ignored_mod._record_ignored_packet(
                packet, reason="unsupported-store-forward"
            )
            return
        rr = str(store_forward_section.get("rr") or "").upper()
        if rr == "ROUTER_HEARTBEAT":
            store_router_heartbeat_packet(packet)
            return
        _ignored_mod._record_ignored_packet(
            packet, reason="unsupported-store-forward-rr"
        )
        return

    text = _first(decoded, "payload.text", "text", "data.text", default=None)
    encrypted = _first(decoded, "payload.encrypted", "encrypted", default=None)
    if encrypted is None:
        encrypted = _first(packet, "encrypted", default=None)
    reply_id_raw = _first(
        decoded,
        "payload.replyId",
        "payload.reply_id",
        "data.replyId",
        "data.reply_id",
        "replyId",
        "reply_id",
        default=None,
    )
    reply_id = _coerce_int(reply_id_raw)
    emoji_raw = _first(
        decoded,
        "payload.emoji",
        "data.emoji",
        "emoji",
        default=None,
    )
    emoji = _coerce_emoji_codepoint(emoji_raw)

    routing_section = decoded.get("routing") if isinstance(decoded, Mapping) else None
    routing_port_candidates = _portnum_candidates("ROUTING_APP")
    if text is None and (
        portnum == "ROUTING_APP"
        or (portnum_int is not None and portnum_int in routing_port_candidates)
        or isinstance(routing_section, Mapping)
    ):
        routing_payload = _first(decoded, "payload", "data", default=None)
        if routing_payload is not None:
            if isinstance(routing_payload, bytes):
                text = base64.b64encode(routing_payload).decode("ascii")
            elif isinstance(routing_payload, str):
                text = routing_payload
            else:
                try:
                    text = json.dumps(routing_payload, ensure_ascii=True)
                except TypeError:
                    text = str(routing_payload)
            if isinstance(text, str):
                text = text.strip() or None

    allowed_port_values = {"1", "TEXT_MESSAGE_APP", "REACTION_APP", "ROUTING_APP"}
    allowed_port_ints = {1}

    reaction_port_candidates = _portnum_candidates("REACTION_APP")
    for candidate in reaction_port_candidates:
        allowed_port_ints.add(candidate)
        allowed_port_values.add(str(candidate))

    for candidate in routing_port_candidates:
        allowed_port_ints.add(candidate)
        allowed_port_values.add(str(candidate))

    if isinstance(routing_section, Mapping) and portnum_int is not None:
        allowed_port_ints.add(portnum_int)
        allowed_port_values.add(str(portnum_int))

    is_reaction_packet = _is_likely_reaction(
        portnum, portnum_int, reply_id, emoji, text
    )
    if is_reaction_packet and portnum_int is not None:
        allowed_port_ints.add(portnum_int)
        allowed_port_values.add(str(portnum_int))

    if portnum and portnum not in allowed_port_values:
        if portnum_int not in allowed_port_ints:
            _ignored_mod._record_ignored_packet(packet, reason="unsupported-port")
            return

    encrypted_flag = _is_encrypted_flag(encrypted)
    if not any([text, encrypted_flag, emoji is not None, reply_id is not None]):
        _ignored_mod._record_ignored_packet(packet, reason="no-message-payload")
        return

    channel_name_value = channels.channel_name(channel)

    pkt_id = _first(packet, "id", "packet_id", "packetId", default=None)
    if pkt_id is None:
        _ignored_mod._record_ignored_packet(packet, reason="missing-packet-id")
        return
    rx_time = int(_first(packet, "rxTime", "rx_time", default=time.time()))
    from_id = _first(packet, "fromId", "from_id", "from", default=None)
    to_id = _first(packet, "toId", "to_id", "to", default=None)

    if (from_id is None or str(from_id) == "") and config.DEBUG:
        try:
            raw = json.dumps(packet, default=str)
        except Exception:
            raw = str(packet)
        config._debug_log(
            "Packet missing from_id",
            context="handlers.store_packet_dict",
            packet=raw,
        )

    snr = _first(packet, "snr", "rx_snr", "rxSnr", default=None)
    rssi = _first(packet, "rssi", "rx_rssi", "rxRssi", default=None)
    hop = _first(packet, "hopLimit", "hop_limit", default=None)
    hops = _hops_travelled(packet, hop)
    # Hop-hash route stamped by the MeshCore handler (RF2); Meshtastic packets
    # never carry it.  Guarded to strings so a malformed value is dropped
    # rather than serialized as garbage.
    path = _first(packet, "path", default=None)
    if not isinstance(path, str):
        path = None
    # Flood scope stamped by the MeshCore handler (SPEC SC4): a region name,
    # ``*`` (unscoped) or ``?`` (scoped, region unknown).  Same string guard.
    scope = _first(packet, "scope", default=None)
    if not isinstance(scope, str):
        scope = None

    to_id_normalized = str(to_id).strip() if to_id is not None else ""

    if (
        not is_reaction_packet
        and channel == 0
        and not encrypted_flag
        and to_id_normalized
        and to_id_normalized.lower() != "^all"
    ):
        if config.DEBUG:
            config._debug_log(
                "Skipped direct message on primary channel",
                context="handlers.store_packet_dict",
                from_id=_canonical_node_id(from_id) or from_id,
                to_id=_canonical_node_id(to_id) or to_id,
                channel=channel,
            )
        _ignored_mod._record_ignored_packet(packet, reason="skipped-direct-message")
        return

    message_payload = {
        "id": int(pkt_id),
        "rx_time": rx_time,
        "rx_iso": _iso(rx_time),
        "from_id": from_id,
        "to_id": to_id,
        "channel": channel,
        "portnum": str(portnum) if portnum is not None else None,
        "text": text,
        "encrypted": encrypted,
        "snr": float(snr) if snr is not None else None,
        "rssi": int(rssi) if rssi is not None else None,
        "hop_limit": int(hop) if hop is not None else None,
        "hops": hops,
        "path": path,
        "scope": scope,
        "reply_id": reply_id,
        "emoji": emoji,
        "ingestor": _state.host_node_id(),
        # Per-record protocol stamp closes the startup race where the web app
        # processes a message before the ingestor heartbeat registers a
        # protocol mapping for ``ingestor`` — see CONTRACTS.md.  A handler-set
        # override (e.g. MeshCore packets carry ``"protocol": "meshcore"``) wins
        # over the daemon-wide configured default.
        "protocol": packet.get("protocol") or config.PROTOCOL,
    }

    if not encrypted_flag and channel_name_value:
        message_payload["channel_name"] = channel_name_value
    queue._queue_post_json(
        "/api/messages",
        _apply_radio_metadata(message_payload),
        priority=queue._MESSAGE_POST_PRIORITY,
    )

    if config.DEBUG:
        from_label = _canonical_node_id(from_id) or from_id
        to_label = _canonical_node_id(to_id) or to_id
        payload_desc = "Encrypted" if text is None and encrypted else text
        log_kwargs = {
            "context": "handlers.store_packet_dict",
            "from_id": from_label,
            "to_id": to_label,
            "channel": channel,
            "channel_display": channel_name_value or channel,
            "payload": payload_desc,
        }
        if channel_name_value:
            log_kwargs["channel_name"] = channel_name_value
        config._debug_log("Queued message payload", **log_kwargs)


def on_receive(packet: object, interface: object) -> None:
    """Callback registered with Meshtastic to capture incoming packets.

    Subscribed to all ``meshtastic.receive.*`` pubsub topics, and called by
    the UDP transport for every packet it decodes.  The packet is
    deduplicated via a ``_potatomesh_seen`` flag before being normalised, its
    radio ``rxTime`` is checked against the host clock
    (:func:`~data.mesh_ingestor.handlers.receive_time.replace_skewed_rx_time`,
    SPEC RK2), and it is dispatched to :func:`store_packet_dict`.

    Parameters:
        packet: Packet payload supplied by the Meshtastic pubsub topic.
        interface: Interface instance that produced the packet. Only used for
            compatibility with Meshtastic's callback signature.

    Returns:
        ``None``. Packets are serialised and enqueued asynchronously.
    """

    if isinstance(packet, dict):
        if packet.get("_potatomesh_seen"):
            return
        packet["_potatomesh_seen"] = True

    _state._mark_packet_seen()

    packet_dict = None
    try:
        packet_dict = _pkt_to_dict(packet)
        # The radio stamps rxTime with its own clock; one off the host clock
        # by more than the tolerance gives way to the host clock (SPEC RK2).
        packet_dict = replace_skewed_rx_time(packet_dict)
        store_packet_dict(packet_dict)
    except Exception as exc:
        info = (
            list(packet_dict.keys()) if isinstance(packet_dict, dict) else type(packet)
        )
        config._debug_log(
            "Failed to store packet",
            context="handlers.on_receive",
            severity="warn",
            error_class=exc.__class__.__name__,
            error_message=str(exc),
            packet_info=info,
        )


__all__ = [
    "_is_encrypted_flag",
    "_portnum_candidates",
    "on_receive",
    "store_packet_dict",
    "upsert_node",
]
