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

"""Event-handler closures for MeshCore protocol messages."""

from __future__ import annotations

import sys
import time

from ... import config, ingestors as _ingestors
from .advert_replay import (
    _accept_advert_timestamp,
    _raise_roster_advert,
    _take_roster_listing,
)
from .advert_signature import _rx_advert_signature_problem, _rx_advert_signed_timestamp
from .decode import (
    _advert_to_node_dict,
    _contact_to_node_dict,
    _derive_modem_preset,
    _rx_advert_position_time,
    _rx_advert_to_node_dict,
    _self_info_to_node_dict,
)
from .identity import _derive_synthetic_node_id, _meshcore_node_id
from .interface import _MeshcoreInterface
from .messages import (
    _derive_message_id,
    _normalize_hops,
    _parse_sender_name,
)
from .position import _store_meshcore_position
from .route import without_decrypted_text
from .telemetry import _make_telemetry_handlers


def _process_self_info(
    payload: dict, iface: _MeshcoreInterface, handlers: object
) -> None:
    """Apply a ``SELF_INFO`` payload: set host_node_id, upsert the host node,
    and capture LoRa radio metadata into the shared config cache.

    Parameters:
        payload: Event payload dict containing at minimum ``public_key`` and
            optionally ``name``, ``adv_lat``, ``adv_lon``, ``radio_freq``,
            ``radio_bw``, ``radio_sf``, ``radio_cr``.
        iface: Active interface whose :attr:`host_node_id` will be updated.
        handlers: Module reference for :func:`~data.mesh_ingestor.handlers`
            functions (passed to avoid circular-import issues).
    """
    # Cache the payload so node_snapshot_items / self_node_item can use it later.
    iface._self_info_payload = payload

    pub_key = payload.get("public_key", "")
    node_id = _meshcore_node_id(pub_key)

    # Capture radio metadata BEFORE upserting the node so that
    # _apply_radio_metadata_to_nodes finds populated values on the very first
    # SELF_INFO.  Never overwrite a previously cached value.
    radio_freq = payload.get("radio_freq")
    if radio_freq is not None and getattr(config, "LORA_FREQ", None) is None:
        config.LORA_FREQ = radio_freq
    modem_preset = _derive_modem_preset(
        payload.get("radio_sf"), payload.get("radio_bw"), payload.get("radio_cr")
    )
    if modem_preset is not None and getattr(config, "MODEM_PRESET", None) is None:
        config.MODEM_PRESET = modem_preset

    if node_id:
        iface.host_node_id = node_id
        handlers.register_host_node_id(node_id)
        # Queue the ingestor registration BEFORE any node upserts so the web
        # backend assigns the correct protocol to all subsequent records.
        # Radio metadata (LORA_FREQ, MODEM_PRESET) is captured just above and
        # will be included in the heartbeat payload by queue_ingestor_heartbeat.
        _ingestors.queue_ingestor_heartbeat(force=True, node_id=node_id)
        handlers.upsert_node(node_id, _self_info_to_node_dict(payload))
        lat = payload.get("adv_lat")
        lon = payload.get("adv_lon")
        if lat is not None and lon is not None and (lat or lon):
            _store_meshcore_position(
                node_id, lat, lon, int(time.time()), handlers.host_node_id(), pub_key
            )

    config._debug_log(
        "MeshCore radio metadata captured",
        context="meshcore.self_info.radio",
        severity="info",
        lora_freq=radio_freq,
        modem_preset=modem_preset,
    )

    # Companion-link read, not an over-air frame: advance the reconnect clock
    # but do not count it as air traffic (SPEC MA1, Model A).
    handlers._mark_packet_activity()
    config._debug_log(
        "MeshCore self-info received",
        context="meshcore.self_info",
        node_id=node_id,
        name=payload.get("name"),
    )


def _process_contacts(
    contacts: dict,
    iface: _MeshcoreInterface,
    handlers: object,
    *,
    full_listing: bool = False,
) -> None:
    """Apply a bulk ``CONTACTS`` payload: update the local snapshot and upsert nodes.

    The listing also sets which keys the RX-log replay memory treats as the
    radio's roster (SPEC SG5, :func:`.advert_replay._take_roster_listing`).

    Parameters:
        contacts: Mapping of full ``public_key`` hex strings to contact dicts.
        iface: Active interface whose contact snapshot will be updated.
        handlers: Module reference for :func:`~data.mesh_ingestor.handlers`.
        full_listing: ``True`` when *contacts* is the radio's whole roster
            (the first listing of a connection), ``False`` for a listing of
            changed contacts only (the auto-update re-fetch).
    """
    last_adverts: dict[str, object] = {}
    for pub_key, contact in contacts.items():
        node_id = _meshcore_node_id(pub_key)
        if node_id is None:
            continue
        iface._update_contact(contact)
        last_adverts[pub_key] = contact.get("last_advert")
        handlers.upsert_node(node_id, _contact_to_node_dict(contact))
        lat = contact.get("adv_lat")
        lon = contact.get("adv_lon")
        if lat is not None and lon is not None and (lat or lon):
            last_advert = contact.get("last_advert")
            # Roster replay, not a live reception: stamp rx_time from the
            # contact's real last_advert so the web app does not warm a
            # long-dead contact's last_heard to now (issue #853, SPEC RS1).
            _store_meshcore_position(
                node_id,
                lat,
                lon,
                last_advert,
                handlers.host_node_id(),
                pub_key,
                rx_time=last_advert,
            )
    # The firmware verified each listed contact's last advert: the listing
    # sets the roster pool, whose timestamps refuse an RX-log copy of those
    # adverts, or older ones (SPEC SG5).
    _take_roster_listing(last_adverts, full=full_listing)
    # Companion-link roster fetch, not over-air frames: clock only (Model A).
    handlers._mark_packet_activity()


def _process_contact_update(
    contact: dict, iface: _MeshcoreInterface, handlers: object
) -> None:
    """Apply a single ``NEW_CONTACT`` or ``NEXT_CONTACT`` event.

    Parameters:
        contact: Contact dict containing at minimum ``public_key``.
        iface: Active interface whose contact snapshot will be updated.
        handlers: Module reference for :func:`~data.mesh_ingestor.handlers`.
    """
    pub_key = contact.get("public_key", "")
    node_id = _meshcore_node_id(pub_key)
    if node_id is None:
        return
    iface._update_contact(contact)
    # Raises a roster member's timestamp only, never adds a member: the radio
    # pushes NEW_CONTACT for an advert from a key it did not add (SPEC SG5).
    _raise_roster_advert(pub_key, contact.get("last_advert"))
    handlers.upsert_node(node_id, _contact_to_node_dict(contact))
    lat = contact.get("adv_lat")
    lon = contact.get("adv_lon")
    if lat is not None and lon is not None and (lat or lon):
        last_advert = contact.get("last_advert")
        # Roster replay, not a live reception: stamp rx_time from the contact's
        # real last_advert so the web app does not warm a long-dead contact's
        # last_heard to now (issue #853, SPEC RS1).
        _store_meshcore_position(
            node_id,
            lat,
            lon,
            last_advert,
            handlers.host_node_id(),
            pub_key,
            rx_time=last_advert,
        )
    # Contact update follows an advert already counted at RX_LOG_DATA: clock
    # only, so the same reception is not counted twice (Model A).
    handlers._mark_packet_activity()
    config._debug_log(
        "MeshCore contact updated",
        context="meshcore.contact",
        node_id=node_id,
        name=contact.get("adv_name"),
    )


def _make_event_handlers(iface: _MeshcoreInterface, target: str | None) -> dict:
    """Build async callbacks for each relevant MeshCore event type.

    All callbacks are closures over *iface* and *target* so they can update
    connection state and forward data to the ingest queue without global state.

    Parameters:
        iface: The active :class:`_MeshcoreInterface` instance.
        target: Human-readable connection target for log messages.

    Returns:
        Mapping of ``EventType`` member name → async callback coroutine.
    """
    # Deferred imports to avoid a circular dependency: meshcore is imported by
    # protocols/__init__.py which is imported by the top-level mesh_ingestor
    # package, while handlers.py and channels.py import from that same package.
    from ... import channels as _channels
    from ... import handlers as _handlers

    async def on_channel_info(evt) -> None:
        payload = evt.payload or {}
        idx = payload.get("channel_idx")
        name = payload.get("channel_name", "")
        if idx is not None and name:
            _channels.register_channel(idx, name)

    async def on_self_info(evt) -> None:
        _process_self_info(evt.payload or {}, iface, _handlers)

    # The first CONTACTS listing of a connection is the radio's whole roster:
    # each connection builds a new MeshCore, whose first fetch asks with
    # since = 0.  Later listings come from the auto-update re-fetch, which asks
    # only for contacts changed since the newest lastmod (SPEC SG5).
    full_listing_seen = False

    async def on_contacts(evt) -> None:
        nonlocal full_listing_seen
        _process_contacts(
            evt.payload or {}, iface, _handlers, full_listing=not full_listing_seen
        )
        full_listing_seen = True

    async def on_contact_update(evt) -> None:
        _process_contact_update(evt.payload or {}, iface, _handlers)

    async def on_advertisement(evt) -> None:
        # A bare ADVERTISEMENT push carries only the advertiser's public key.
        payload = evt.payload or {}
        pub_key = payload.get("public_key", "")
        node_id = _meshcore_node_id(pub_key)
        if node_id is None:
            return
        # Known contacts are kept current by the meshcore library's auto-update
        # re-fetch (its built-in _contact_change handler reacts to this same
        # ADVERTISEMENT push and re-fetches changed contacts), so re-emitting
        # them here would only add redundant POSTs.  Surface ONLY nodes the
        # radio did not add to its roster (manual-add / auto-add off), for which
        # the bare advert is otherwise the only signal that the node was heard.
        if iface.is_known_contact(pub_key):
            return
        _handlers.upsert_node(node_id, _advert_to_node_dict(pub_key))
        # The advert frame is counted once at its RX_LOG_DATA seam; here we only
        # advance the reconnect clock so the bare push is not double-counted.
        _handlers._mark_packet_activity()
        config._debug_log(
            "MeshCore advert from non-roster node",
            context="meshcore.advert",
            node_id=node_id,
        )

    async def on_channel_msg(evt) -> None:
        payload = evt.payload or {}
        sender_ts = payload.get("sender_timestamp")
        text = payload.get("text")
        if sender_ts is None or not text:
            return

        rx_time = int(time.time())
        channel_idx = payload.get("channel_idx", 0)

        # MeshCore channel messages carry no sender identifier in the event
        # payload.  Try to resolve the sender from the "SenderName: body"
        # convention embedded in the message text, matched against the known
        # contacts roster.  When the contacts roster does not contain the
        # sender, the message carries a name-derived synthetic from_id.  No
        # node is POSTed for it: the web app mints the placeholder from the
        # message text once the message has passed the channel filters, and
        # migrates it to the real node ID when a contact advertisement arrives
        # (SPEC GN4).  ``@[Name]`` mentions are not receptions and never become
        # nodes (SPEC GN1).
        sender_name = _parse_sender_name(text)
        from_id = iface.lookup_node_id_by_name(sender_name) if sender_name else None
        if from_id is None and sender_name:
            from_id = _derive_synthetic_node_id(sender_name)

        # The dedup fingerprint uses the parsed sender name (lowercased and
        # stripped) rather than ``from_id``: each ingestor independently
        # resolves Alice to either her real ``!aabbccdd`` (when she is in its
        # contact roster) or to a synthetic id derived from her name; the
        # parsed name lives in the message text itself, so it is identical
        # across all receivers regardless of roster state.
        sender_identity = (sender_name or "").strip().lower()

        # Path, RSSI and flood scope come from the RX-log copy the radio
        # delivered: the earliest one whose hop count equals ``path_len``
        # (SPEC SC2-SC4).  The library's own ``path``/``RSSI`` fields name the
        # newest copy and are ignored.  No matching copy (frame never logged,
        # expired, join off) leaves all three absent; ``hops`` stays (SC9).
        hops = _normalize_hops(payload.get("path_len"))
        route = iface._route.channel_route(payload, hops)

        packet = {
            "id": _derive_message_id(
                sender_identity, sender_ts, f"c{channel_idx}", text
            ),
            "rxTime": rx_time,
            "rx_time": rx_time,
            "from_id": from_id,
            "to_id": "^all",
            "channel": channel_idx,
            "snr": payload.get("SNR"),
            "rssi": route.get("rssi"),
            "hops": hops,
            "path": route.get("path"),
            "scope": route.get("scope"),
            "protocol": "meshcore",
            "decoded": {
                "portnum": "TEXT_MESSAGE_APP",
                "text": text,
                "channel": channel_idx,
            },
        }
        # Decoded channel message: its on-air frame is already counted at the
        # RX_LOG_DATA seam (GRP_TXT), so advance the clock only (Model A).
        _handlers._mark_packet_activity()
        _handlers.store_packet_dict(packet)
        config._debug_log(
            "MeshCore channel message",
            context="meshcore.channel_msg",
            channel=channel_idx,
            sender=sender_name,
            from_id=from_id,
        )

    async def on_contact_msg(evt) -> None:
        payload = evt.payload or {}
        sender_ts = payload.get("sender_timestamp")
        text = payload.get("text")
        if sender_ts is None or not text:
            return

        rx_time = int(time.time())
        pubkey_prefix = payload.get("pubkey_prefix", "")
        from_id = iface.lookup_node_id(pubkey_prefix)
        # ``pubkey_prefix`` is already a sender-side stable identifier (the
        # first six bytes of the sender's public key); ``"dm"`` namespaces
        # direct messages so they cannot collide with channel messages that
        # happen to share the other components.
        packet = {
            "id": _derive_message_id(pubkey_prefix or "", sender_ts, "dm", text),
            "rxTime": rx_time,
            "rx_time": rx_time,
            "from_id": from_id,
            "to_id": iface.host_node_id,
            "channel": 0,
            "snr": payload.get("SNR"),
            "hops": _normalize_hops(payload.get("path_len")),
            "protocol": "meshcore",
            "decoded": {
                "portnum": "TEXT_MESSAGE_APP",
                "text": text,
                "channel": 0,
            },
        }
        # Decoded direct message: its on-air frame is already counted at the
        # RX_LOG_DATA seam (TEXT_MSG), so advance the clock only (Model A).
        _handlers._mark_packet_activity()
        _handlers.store_packet_dict(packet)

    async def on_rx_log_data(evt) -> None:
        payload = evt.payload or {}
        # Count every RX-log frame here, once, before the ADVERT/non-ADVERT
        # split (SPEC MA1, Model A). The firmware emits one RX_LOG_DATA frame
        # per received over-air frame — the complete per-frame ground truth of
        # "what is in the air" — while the decoded high-level events
        # (CHANNEL_MSG_RECV, CONTACT_MSG_RECV, ADVERTISEMENT, telemetry
        # responses) are duplicates of these same frames and only advance the
        # reconnect clock. Counting precedes the DEBUG-capture drop, the
        # malformed-advert skip and the signature and replay checks, so no
        # received frame — ignored, errored, forged, replayed, or
        # unimplemented — is under-reported.
        _handlers._mark_packet_seen()
        # Remember each decrypted channel-message copy so on_channel_msg can
        # take its delivered copy's route (SPEC SC2); other frames are ignored.
        iface._route.observe(payload)
        if payload.get("payload_typename") != "ADVERT":
            # Non-ADVERT RF frames keep their DEBUG-only observability, routed
            # explicitly now that RX_LOG_DATA is a handled event and no longer
            # reaches the unhandled catch-all (RF3).  The capture never keeps
            # the library-decrypted channel text (SPEC SC8).  Resolved via the
            # parent package so test fakes installed with monkeypatch apply.
            pkg = sys.modules["data.mesh_ingestor.protocols.meshcore"]
            pkg._record_meshcore_message(
                without_decrypted_text(payload),
                source=f"{target or 'auto'}:RX_LOG_DATA",
            )
            return

        pub_key = payload.get("adv_key", "")
        node_id = _meshcore_node_id(pub_key)
        if node_id is None:
            # Malformed advert (absent/short key, parse failure upstream) —
            # tolerated without raising (RF3).
            config._debug_log(
                "Malformed RX-log advert skipped",
                context="meshcore.rx_advert",
                severity="warning",
            )
            return

        # The radio logs every frame before the firmware checks it, and the
        # library parses an advert without checking its signature, so an
        # RX-log advert posts its node and position only when its signature
        # holds under a key not of small order (SPEC SG1, SG4) and its signed
        # timestamp is newer than the last one accepted for that key (SG5):
        # a replay, or the same advert over another path, posts nothing.  The
        # replay check runs only on a verified advert, so a forged timestamp
        # is never remembered.  The drop logs at debug level: a forged, broken
        # or repeated frame is per-packet noise a warning would flood the log
        # with.
        reason = _rx_advert_signature_problem(payload)
        if reason is None and not _accept_advert_timestamp(
            pub_key, _rx_advert_signed_timestamp(payload)
        ):
            reason = "replayed advert"
        if reason is not None:
            config._debug_log(
                "Unverified RX-log advert dropped",
                context="meshcore.rx_advert",
                node_id=node_id,
                reason=reason,
            )
            return

        _handlers.upsert_node(node_id, _rx_advert_to_node_dict(payload))
        lat = payload.get("adv_lat")
        lon = payload.get("adv_lon")
        if lat is not None and lon is not None and (lat or lon):
            _store_meshcore_position(
                node_id,
                lat,
                lon,
                # Sender-side advert timestamp, so every flood copy of one
                # advert collapses to a single position row (SPEC MR5).
                _rx_advert_position_time(payload),
                _handlers.host_node_id(),
                pub_key,
            )
        config._debug_log(
            "MeshCore RX-log advert",
            context="meshcore.rx_advert",
            node_id=node_id,
            name=payload.get("adv_name"),
            snr=payload.get("snr"),
            rssi=payload.get("rssi"),
            hops=payload.get("path_len"),
        )

    async def on_contact_deleted(evt) -> None:
        # Deliberate no-op (SPEC RF5): the radio evicting a contact from its
        # roster (AUTO_ADD_OVERWRITE_OLDEST, RF4) must not delete anything
        # from the dashboard — the web DB intentionally retains evicted nodes
        # and ``retention.rb`` stays the only data-expiry authority.
        payload = evt.payload or {}
        config._debug_log(
            "MeshCore contact evicted from radio roster",
            context="meshcore.contact_deleted",
            node_id=_meshcore_node_id(payload.get("pubkey", "")),
        )

    async def on_disconnected(evt) -> None:
        iface.isConnected = False
        config._debug_log(
            "MeshCore node disconnected",
            context="meshcore.disconnect",
            target=target or "unknown",
            severity="warning",
            always=True,
        )

    return {
        "CHANNEL_INFO": on_channel_info,
        "SELF_INFO": on_self_info,
        "CONTACTS": on_contacts,
        "NEW_CONTACT": on_contact_update,
        "NEXT_CONTACT": on_contact_update,
        "ADVERTISEMENT": on_advertisement,
        "CHANNEL_MSG_RECV": on_channel_msg,
        "CONTACT_MSG_RECV": on_contact_msg,
        "CONTACT_DELETED": on_contact_deleted,
        "RX_LOG_DATA": on_rx_log_data,
        "DISCONNECTED": on_disconnected,
        # Telemetry surfaces (TI-A3): contact/self telemetry pulls, status
        # responses, and the host battery event.
        **_make_telemetry_handlers(iface, _handlers),
    }
