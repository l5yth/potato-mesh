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

"""Public ``MeshcoreProvider`` satisfying the :class:`MeshProtocol` interface."""

from __future__ import annotations

import asyncio
import sys
import threading

from ... import config
from ._constants import _CONNECT_TIMEOUT_SECS
from .decode import _self_info_to_node_dict
from .identity import _meshcore_node_id
from .interface import _MeshcoreInterface


class MeshcoreProvider:
    """MeshCore ingestion provider.

    Connects to a MeshCore node via serial port, BLE, or TCP/IP.  The
    connection type is inferred from the target string; see :meth:`connect`
    for routing rules.

    The provider runs MeshCore's ``asyncio`` event loop in a background daemon
    thread.  Incoming ``SELF_INFO``, ``CONTACTS``, ``NEW_CONTACT``,
    ``CHANNEL_MSG_RECV``, and ``CONTACT_MSG_RECV`` events are forwarded to the
    HTTP ingest queue via the shared handler functions.
    """

    name = "meshcore"

    def subscribe(self) -> list[str]:
        """Return subscribed topic names.

        MeshCore uses an ``asyncio`` event system rather than a pubsub bus,
        so there are no topics to register at startup.
        """
        return []

    def connect(
        self, *, active_candidate: str | None
    ) -> tuple[object, str | None, str | None]:
        """Connect to a MeshCore node via serial, BLE, or TCP.

        Starts an asyncio event loop in a background daemon thread, performs
        the MeshCore companion-protocol handshake, and blocks until the node's
        self-info is received or the timeout expires.

        Connection type is inferred from *active_candidate* (or
        :data:`~data.mesh_ingestor.config.CONNECTION`):

        * BLE MAC / UUID → :class:`meshcore.BLEConnection`
        * ``host:port`` → :class:`meshcore.TCPConnection`
        * serial path → :class:`meshcore.SerialConnection`
        * ``None`` / empty → first candidate from
          :func:`~data.mesh_ingestor.connection.default_serial_targets`

        Parameters:
            active_candidate: Previously resolved connection target, or
                ``None`` to fall back to
                :data:`~data.mesh_ingestor.config.CONNECTION`.

        Returns:
            ``(iface, resolved_target, next_active_candidate)`` matching the
            :class:`~data.mesh_ingestor.provider.Provider` contract.

        Raises:
            ConnectionError: When the node does not complete the handshake
                within :data:`_CONNECT_TIMEOUT_SECS` seconds.
        """
        target: str | None = active_candidate or config.CONNECTION

        if not target:
            # Look up via the package so test fakes installed via
            # ``monkeypatch.setattr(mod, "default_serial_targets", ...)`` apply.
            pkg = sys.modules["data.mesh_ingestor.protocols.meshcore"]
            candidates = pkg.default_serial_targets()
            target = candidates[0] if candidates else "/dev/ttyACM0"

        config._debug_log(
            "Connecting to MeshCore node",
            context="meshcore.connect",
            target=target,
        )

        iface = _MeshcoreInterface(target=target)
        connected_event = threading.Event()
        error_holder: list = [None]

        # Resolve the runner + asyncio handler via the parent package so test
        # fakes installed via ``monkeypatch.setattr(mod, "_run_meshcore", ...)``
        # apply at call time.
        pkg = sys.modules["data.mesh_ingestor.protocols.meshcore"]

        def _run_loop() -> None:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            # Second line of defence around issue #754: if a detached task
            # inside the upstream ``meshcore`` library ever raises an
            # exception we do not anticipate in ``_meshcore_patches``, funnel
            # it through our logger instead of the default handler (which
            # only writes ``Task exception was never retrieved`` to stderr).
            loop.set_exception_handler(pkg._log_unhandled_loop_exception)
            iface._loop = loop
            try:
                loop.run_until_complete(
                    pkg._run_meshcore(iface, target, connected_event, error_holder)
                )
            finally:
                loop.close()

        thread = threading.Thread(target=_run_loop, name="meshcore-loop", daemon=True)
        iface._thread = thread
        thread.start()

        if not connected_event.wait(timeout=_CONNECT_TIMEOUT_SECS):
            iface.close()
            raise ConnectionError(
                f"Timed out waiting for MeshCore node at {target!r} "
                f"after {_CONNECT_TIMEOUT_SECS:g}s."
            )

        if error_holder[0] is not None:
            iface.close()
            raise error_holder[0]

        return iface, target, target

    def extract_host_node_id(self, iface: object) -> str | None:
        """Return the canonical ``!xxxxxxxx`` host node ID from the interface.

        Parameters:
            iface: Active :class:`_MeshcoreInterface` returned by
                :meth:`connect`.
        """
        return getattr(iface, "host_node_id", None)

    def self_node_item(self, iface: object) -> tuple[str, dict] | None:
        """Return the ``(node_id, node_dict)`` pair for the host self-node.

        Uses the most recently cached ``SELF_INFO`` payload stored on the
        interface.  Returns ``None`` when no SELF_INFO has been received yet
        or when the public key cannot be mapped to a valid node ID.

        Parameters:
            iface: Active :class:`_MeshcoreInterface` instance.

        Returns:
            ``(canonical_node_id, node_dict)`` tuple or ``None``.
        """
        if not isinstance(iface, _MeshcoreInterface):
            return None
        payload = getattr(iface, "_self_info_payload", None)
        if not payload:
            return None
        node_id = _meshcore_node_id(payload.get("public_key", ""))
        if not node_id:
            return None
        return node_id, _self_info_to_node_dict(payload)

    def node_snapshot_items(self, iface: object) -> list[tuple[str, dict]]:
        """Return a snapshot of all known MeshCore contacts as node entries.

        Includes the host self-node when a ``SELF_INFO`` payload has already
        been received, so that the initial snapshot sent by the daemon
        covers the local device even when the background event loop delivers
        ``SELF_INFO`` before the snapshot is taken.

        Parameters:
            iface: Active :class:`_MeshcoreInterface` instance.  Any other
                object type causes an empty list to be returned.

        Returns:
            List of ``(canonical_node_id, node_dict)`` pairs suitable for
            passing to :func:`~data.mesh_ingestor.handlers.upsert_node`.
        """
        if not isinstance(iface, _MeshcoreInterface):
            return []
        items: list[tuple[str, dict]] = list(iface.contacts_snapshot())
        self_item = self.self_node_item(iface)
        if self_item is not None:
            items.append(self_item)
        return items
