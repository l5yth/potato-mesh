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

"""Meshtastic protocol implementation."""

from __future__ import annotations

import time
from collections.abc import Mapping

from pubsub import pub

from .. import (
    activity,
    channels,
    config,
    daemon as _daemon,
    handlers,
    interfaces,
    tx_policy,
)
from ..handlers.receive_time import RX_TIME_TOLERANCE_SECS, radio_clock_offset
from ..node_identity import canonical_node_id
from ..serialization import _coerce_int
from ..utils import _retry_dict_snapshot


class MeshtasticProvider:
    """Meshtastic ingestion protocol (current default)."""

    name = "meshtastic"

    def __init__(self):
        self._subscribed: list[str] = []
        self._keep_snapshot_clock(0, None)

    def subscribe(self) -> list[str]:
        """Subscribe Meshtastic pubsub receive topics."""

        if self._subscribed:
            return list(self._subscribed)

        subscribed = []
        for topic in _daemon._RECEIVE_TOPICS:
            try:
                pub.subscribe(handlers.on_receive, topic)
                subscribed.append(topic)
            except Exception as exc:  # pragma: no cover
                config._debug_log(f"failed to subscribe to {topic!r}: {exc}")
        self._subscribed = subscribed
        return list(subscribed)

    def connect(
        self, *, active_candidate: str | None
    ) -> tuple[object, str | None, str | None]:
        """Create a Meshtastic interface using the existing interface helpers."""

        iface = None
        resolved_target = None
        next_candidate = active_candidate

        if active_candidate:
            iface, resolved_target = interfaces._create_serial_interface(
                active_candidate
            )
        else:
            iface, resolved_target = interfaces._create_default_interface()
            next_candidate = resolved_target

        interfaces._ensure_radio_metadata(iface)
        interfaces._ensure_channel_metadata(iface)

        return iface, resolved_target, next_candidate

    def extract_host_node_id(self, iface: object) -> str | None:
        return interfaces._extract_host_node_id(iface)

    def node_snapshot_items(self, iface: object) -> list[tuple[str, object]]:
        """Return a stable snapshot of all known nodes from ``iface``.

        Uses :func:`~data.mesh_ingestor.utils._retry_dict_snapshot` to
        tolerate concurrent modifications from the Meshtastic background
        thread.  The entries are the library's own dicts, not copies (SPEC
        CF3).  It also reads the radio's clock and uptime for this snapshot
        from the radio's own entry, which :meth:`snapshot_filter_reason` and
        :meth:`snapshot_entry` apply to each entry (SPEC RK4).

        Parameters:
            iface: Live Meshtastic interface whose ``nodes`` dict to snapshot.

        Returns:
            List of ``(node_id, node_dict)`` tuples, or an empty list when
            the snapshot fails after retries.
        """

        nodes = getattr(iface, "nodes", {}) or {}
        result = _retry_dict_snapshot(lambda: list(nodes.items()))
        if result is None:
            # No entries to apply a clock to; keep none from a past snapshot.
            self._keep_snapshot_clock(0, None)
            config._debug_log(
                "Skipping node snapshot due to concurrent modification",
                context="meshtastic.snapshot",
            )
            return []
        self._read_snapshot_clock(iface, nodes)
        return result

    def _read_snapshot_clock(self, iface: object, nodes: object) -> None:
        """Keep this snapshot's clock correction, read from the own entry (SPEC RK4).

        The radio's own entry (:func:`_own_entry`) carries its clock's
        reading at connect (see
        :func:`~data.mesh_ingestor.handlers.receive_time.radio_clock_offset`)
        and its uptime (:func:`_uptime_secs`).  Three cases:

        - A reading more than :data:`RX_TIME_TOLERANCE_SECS` off the host
          clock: every entry is posted with ``lastHeard`` minus that offset.
          Another clock, an earlier boot's, stamped an entry more than the
          tolerance after the reading, or one the shift would post at ``0``
          or below; it is skipped.  With an uptime, an entry stamped more
          than the tolerance before this boot started, by the radio's clock,
          is an earlier boot's too: it is posted as stamped, unless it lies
          more than the tolerance ahead of the host clock, which skips it.
        - A reading within the tolerance: every entry is posted as stamped.
        - No reading: entries are posted as stamped, except one stamped more
          than the tolerance ahead of the host clock: a fast clock stamped
          it, and the web app would store it as heard now.

        In every case an entry without a positive ``lastHeard`` is posted as
        it is.  Only the first case uses the uptime.

        Parameters:
            iface: Live Meshtastic interface.
            nodes: Its ``nodes`` object, already read for the snapshot.
        """

        host_now = int(time.time())
        own = _own_entry(iface, nodes)
        offset = radio_clock_offset(
            None if own is None else own.get("lastHeard"), host_now
        )
        if offset is None:
            self._keep_snapshot_clock(0, host_now + RX_TIME_TOLERANCE_SECS)
        elif offset == 0:
            self._keep_snapshot_clock(0, None)
        else:
            # host_now + offset is the radio's reading, which came from
            # ``own``, so ``own`` is a mapping here.
            radio_now = host_now + offset
            uptime = _uptime_secs(own)
            # This boot started ``uptime`` seconds before the reading, by the
            # radio's clock.  A previous boot's uptime, left in the own entry
            # until this boot's first device telemetry, is mostly larger: it
            # moves the boot start earlier, so fewer entries count as an
            # earlier boot's, down to the rule without an uptime.  An uptime
            # this boot refreshed lags by up to one telemetry interval and
            # moves the boot start later by as much; the tolerance absorbs a
            # lag of up to 1 hour.
            self._keep_snapshot_clock(
                offset,
                radio_now + RX_TIME_TOLERANCE_SECS,
                boot_floor=(
                    None
                    if uptime is None
                    else radio_now - uptime - RX_TIME_TOLERANCE_SECS
                ),
                host_newest=host_now + RX_TIME_TOLERANCE_SECS,
            )

    def _keep_snapshot_clock(
        self,
        offset: int,
        newest: int | None,
        *,
        boot_floor: int | None = None,
        host_newest: int | None = None,
    ) -> None:
        """Keep the clock correction of the snapshot that starts (SPEC RK4).

        The counts of shifted, skipped and unshifted entries restart at zero.

        Parameters:
            offset: Radio clock minus host clock, subtracted from each posted
                ``lastHeard``; ``0`` shifts nothing.
            newest: Newest ``lastHeard`` the snapshot posts; ``None`` posts
                any.
            boot_floor: Oldest ``lastHeard`` this boot's clock can have
                stamped, by the radio's uptime; an older one is an earlier
                boot's and is posted as stamped.  ``None``, without an
                uptime, counts every entry as this boot's.
            host_newest: Newest earlier-boot ``lastHeard`` the snapshot
                posts, the host clock plus the tolerance; read only with a
                ``boot_floor``.
        """

        self._clock_offset = offset
        self._clock_newest = newest
        self._clock_boot_floor = boot_floor
        self._clock_host_newest = host_newest
        self._clock_shifted = 0
        self._clock_skipped = 0
        self._clock_unshifted = 0

    def snapshot_filter_reason(self, node_id: str, node: object) -> str | None:
        """Return why the node-list snapshot must not publish ``node`` (SPEC CF3, NI1).

        An **optional**, duck-typed provider hook (like ``self_node_item``):
        :func:`~data.mesh_ingestor.daemon._try_send_snapshot` asks it about
        each entry and skips the ones it names.

        An entry whose ``num`` disagrees with the id it is filed under is not
        that node's entry: the meshtastic library files a node under the
        ``user.id`` of its last NodeInfo, so one naming another node would
        post the sender's entry under the other node's id (SPEC NI1).  An
        entry without a ``num`` is not checked.

        A nodeDB entry records in ``channel`` the local channel index the
        radio last heard the node's NodeInfo on; proto3 omits it when it is
        ``0``, so an entry without one belongs to the primary channel.
        ``viaMqtt`` drives ``DROP_VIA_MQTT``.  Only that channel decides: a
        published entry still carries the nodeDB's latest position and
        metrics, which the radio stores whatever channel they were heard on
        (a documented limit, SPEC CF3).

        An entry whose ``lastHeard`` is newer than this snapshot's clock
        allows (see :meth:`node_snapshot_items`), or one the shift of
        :meth:`snapshot_entry` would post at ``0`` or below, was stamped by
        another clock, an earlier boot's, and no shift of this snapshot fits
        it (SPEC RK4).  So is one stamped before this boot started, which is
        posted as stamped, and skipped only when it lies more than the
        tolerance ahead of the host clock.  The channel reasons come first,
        so the snapshot's radio-clock warning counts only the entries
        skipped for their time.

        Parameters:
            node_id: Id the entry is filed under in ``iface.nodes``.
            node: The nodeDB entry.

        Returns:
            ``"num-mismatch"`` for an entry filed under another node's id,
            else the :func:`~data.mesh_ingestor.channels.ingest_filter_reason`
            verdict, else ``"clock-epoch"`` for an entry stamped by another
            clock than the snapshot's; ``None`` for an entry that is not a
            mapping.
        """

        if not isinstance(node, Mapping):
            return None
        if _filed_under_another_id(node_id, node):
            return "num-mismatch"
        reason = channels.ingest_filter_reason(
            _coerce_int(node.get("channel")) or 0,
            via_mqtt=bool(node.get("viaMqtt")),
        )
        if reason is None and self._clock_newest is not None:
            last_heard = _stamped_last_heard(node)
            if last_heard is not None and self._clock_epoch(last_heard):
                self._clock_skipped += 1
                return "clock-epoch"
        return reason

    def _clock_epoch(self, last_heard: int) -> bool:
        """Return whether this snapshot skips an entry for its time (SPEC RK4).

        Read only while the snapshot keeps a newest time (see
        :meth:`_keep_snapshot_clock`).

        Parameters:
            last_heard: The entry's positive ``lastHeard``.

        Returns:
            ``True`` for a stamp later than the newest the snapshot posts, an
            earlier boot's stamp more than the tolerance ahead of the host
            clock, or a stamp the shift would post at ``0`` or below, 1970 or
            before by the host clock.
        """

        if last_heard > self._clock_newest:
            return True
        if self._earlier_boot(last_heard):
            # Posted as stamped, so the guard without a reading applies.
            return last_heard > self._clock_host_newest
        # With no offset kept, a positive time is never shifted to 0.
        return last_heard - self._clock_offset <= 0

    def _earlier_boot(self, last_heard: int) -> bool:
        """Return whether ``last_heard`` was stamped before this boot (SPEC RK4).

        Parameters:
            last_heard: The entry's positive ``lastHeard``.

        Returns:
            ``True`` for a stamp older than the snapshot's boot floor, more
            than the tolerance before the boot started, which only a snapshot
            that read the radio's uptime keeps.
        """

        return (
            self._clock_boot_floor is not None and last_heard < self._clock_boot_floor
        )

    def snapshot_entry(self, node_id: str, node: object) -> object:
        """Return ``node`` as the node-list snapshot posts it (SPEC RK4).

        An **optional**, duck-typed provider hook like
        :meth:`snapshot_filter_reason`:
        :func:`~data.mesh_ingestor.daemon._try_send_snapshot` passes it each
        entry the filter lets through, inside its per-node error handling,
        and upserts what it returns.

        A radio whose clock reading at connect lay more than
        :data:`~data.mesh_ingestor.handlers.receive_time.RX_TIME_TOLERANCE_SECS`
        off the host clock stamped every ``lastHeard`` in its nodeDB by that
        clock.  The entry is posted with ``lastHeard`` minus the offset, so it
        keeps the age the radio's clock gives it, counted from the host
        clock: a node the radio heard 10 minutes ago is posted 10 minutes
        old.  The shift is made on a shallow copy, so the library's dict
        keeps the radio's value, and the copy is made inside the per-node
        handling, so a dict the library mutates meanwhile fails that entry
        alone (SPEC CF3).  An entry the shift would post at ``0`` or below
        never gets here: :meth:`snapshot_filter_reason` skips it.  An entry
        stamped before this boot started, by the radio's uptime, was stamped
        by an earlier boot's clock and is posted as stamped.

        Parameters:
            node_id: Id the entry is filed under in ``iface.nodes``.
            node: The nodeDB entry.

        Returns:
            A shallow copy of ``node`` with the shifted ``lastHeard``;
            ``node`` itself when nothing is shifted: no offset kept, an entry
            that is not a mapping, one without a positive ``lastHeard``, or
            an earlier boot's, which counts as ``unshifted``.
        """

        if not self._clock_offset or not isinstance(node, Mapping):
            return node
        last_heard = _stamped_last_heard(node)
        if last_heard is None:
            return node
        if self._earlier_boot(last_heard):
            self._clock_unshifted += 1
            return node
        entry = dict(node)
        entry["lastHeard"] = last_heard - self._clock_offset
        self._clock_shifted += 1
        return entry

    @property
    def snapshot_clock_warning(self) -> dict[str, int] | None:
        """Fields of this snapshot's radio-clock warning (SPEC RK4).

        Read by :func:`~data.mesh_ingestor.daemon._try_send_snapshot` once it
        has handled every entry, so a snapshot logs one warning however many
        entries it shifts.

        Returns:
            ``None`` unless this snapshot shifts its entries for a radio
            clock past the tolerance; then ``offset_secs`` (radio clock minus
            host clock), ``shifted`` (entries :meth:`snapshot_entry` shifted)
            and ``skipped`` (entries skipped as ``clock-epoch``), plus
            ``unshifted`` (earlier-boot entries posted as stamped) when the
            snapshot read the radio's uptime.
        """

        if not self._clock_offset:
            return None
        fields = {
            "offset_secs": self._clock_offset,
            "shifted": self._clock_shifted,
            "skipped": self._clock_skipped,
        }
        # Without an uptime no entry can count as unshifted, so the field
        # also tells whether the snapshot read one.
        if self._clock_boot_floor is not None:
            fields["unshifted"] = self._clock_unshifted
        return fields

    def send_channel_announcement(self, iface: object, text: str) -> None:
        """Broadcast an activity announcement on the default channel (SPEC MA6/MA9).

        Sends *text* on channel :data:`~data.mesh_ingestor.config.CHANNEL_INDEX`
        via the Meshtastic interface and counts the transmission toward the
        merged activity total (MA1). This is an **optional**, duck-typed provider
        method (not a formal :class:`MeshProtocol` member); the daemon resolves
        it via ``getattr`` and skips it when absent.

        Enforces the transmit gates **here**, at the transmit primitive, rather
        than relying on the caller: this method is a public, duck-typed provider
        capability, so any second caller (a CLI, an operator script, a future
        scheduler) must not be able to put traffic on the air by reaching past
        the daemon's own check.

        Parameters:
            iface: Active Meshtastic interface exposing ``sendText``.
            text: Announcement string to transmit.
        """

        if not tx_policy.announcements_permitted():
            return
        send_text = getattr(iface, "sendText", None)
        if not callable(send_text):
            return
        activity.record_tx()
        send_text(text, channelIndex=config.CHANNEL_INDEX)
        config._debug_log(
            "Meshtastic activity announcement transmitted",
            context="meshtastic.tx",
            channel=config.CHANNEL_INDEX,
            chars=len(text),
        )


def _filed_under_another_id(node_id: str, node: Mapping) -> bool:
    """Return whether ``node`` is another node's entry filed under ``node_id`` (SPEC NI1).

    The meshtastic library files a node under the ``user.id`` of its last
    NodeInfo, so one naming another node files the sender's entry under the
    other node's id.  An entry without a ``num`` is not checked.

    Parameters:
        node_id: Id the entry is filed under in ``iface.nodes``.
        node: The nodeDB entry.

    Returns:
        ``True`` when the entry's ``num`` maps to an id other than
        ``node_id``.
    """

    num = _coerce_int(node.get("num"))
    return num is not None and canonical_node_id(num) != canonical_node_id(node_id)


def _stamped_last_heard(node: Mapping) -> int | None:
    """Return the time a radio's clock stamped on ``node`` (SPEC RK4).

    Parameters:
        node: The nodeDB entry.

    Returns:
        ``lastHeard`` as an integer, or ``None`` when it does not parse as a
        positive one: the entry then counts as one without ``lastHeard``,
        as the own entry does for the clock reading
        (:func:`~data.mesh_ingestor.handlers.receive_time.radio_clock_offset`).
    """

    last_heard = _coerce_int(node.get("lastHeard"))
    return last_heard if last_heard is not None and last_heard > 0 else None


def _own_entry(iface: object, nodes: object) -> Mapping | None:
    """Return the radio's own nodeDB entry (SPEC RK4).

    The entry is looked up once, under the host id ``daemon._try_connect``
    registers when its ``num`` maps to that id (the ``num-mismatch`` check of
    :meth:`MeshtasticProvider.snapshot_filter_reason`), else through the
    meshtastic library's ``getMyNodeInfo()``, which finds it by the radio's
    node number.  Another node's entry filed under the host id (SPEC NI1)
    carries that node's time, which read as the radio's clock would shift a
    correct clock's entries by the node's age; it is never returned.
    Neither lookup copies the nodeDB.

    Parameters:
        iface: Live Meshtastic interface.
        nodes: Its ``nodes`` object, already read for the snapshot.

    Returns:
        The own entry, whose ``lastHeard`` is the radio's clock reading and
        whose ``deviceMetrics`` carries its uptime, or ``None`` when none is
        found.  A ``getMyNodeInfo`` that raises counts as no entry: the
        library formats the whole nodeDB into a debug line first, which a
        concurrent update can break, and the snapshot must not fail for it.
    """

    host_id = handlers.host_node_id()
    if host_id is not None and isinstance(nodes, Mapping):
        own = nodes.get(host_id)
        if isinstance(own, Mapping) and not _filed_under_another_id(host_id, own):
            return own
    get_my_node_info = getattr(iface, "getMyNodeInfo", None)
    if not callable(get_my_node_info):
        return None
    try:
        own = get_my_node_info()
    except Exception:
        return None
    return own if isinstance(own, Mapping) else None


def _uptime_secs(own: Mapping) -> int | None:
    """Return the radio's uptime from its own nodeDB entry (SPEC RK4).

    The firmware refreshes ``deviceMetrics.uptimeSeconds`` of its own entry
    whenever it sends device telemetry (``DeviceTelemetry`` ``sendTelemetry``
    calls ``nodeDB->updateTelemetry`` for its own node number).

    Parameters:
        own: The radio's own entry (:func:`_own_entry`).

    Returns:
        The uptime in seconds, or ``None`` unless it is a positive ``int``:
        a ``bool`` (an ``int`` subclass), a float, a string or a value of
        ``0`` or below is no uptime.
    """

    metrics = own.get("deviceMetrics")
    uptime = metrics.get("uptimeSeconds") if isinstance(metrics, Mapping) else None
    if isinstance(uptime, bool) or not isinstance(uptime, int) or uptime <= 0:
        return None
    return uptime


__all__ = ["MeshtasticProvider"]
