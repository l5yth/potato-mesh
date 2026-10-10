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

"""Live MeshCore interface and the connection-stage shutdown sentinel."""

from __future__ import annotations

import asyncio
import threading

from .decode import _contact_to_node_dict
from .identity import _meshcore_node_id, _pubkey_prefix_to_node_id
from .route import RouteTracker


class ClosedBeforeConnectedError(ConnectionError):
    """Raised when :meth:`_MeshcoreInterface.close` is called while the
    connection coroutine is still waiting for the device handshake to complete.

    This is a :exc:`ConnectionError` subclass so callers that only handle the
    base class continue to work, while callers that need to distinguish a
    user-initiated shutdown from a hardware failure can catch this type
    specifically.
    """


class _MeshcoreInterface:
    """Live MeshCore interface managing an asyncio event loop in a background thread.

    Holds connection state, a thread-safe snapshot of known contacts, and the
    handles needed to shut down cleanly when the daemon requests a disconnect.
    """

    host_node_id: str | None = None
    """Canonical ``!xxxxxxxx`` identifier for the connected host device."""

    def __init__(self, *, target: str | None) -> None:
        """Initialise the interface with the connection *target*."""
        self._target = target
        self._mc: object | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._stop_event: asyncio.Event | None = None
        self._contacts_lock = threading.Lock()
        self._contacts: dict = {}
        self.isConnected: bool = False
        self._self_info_payload: dict | None = None
        """Most recent SELF_INFO payload received from the device, or ``None``."""
        self._roster_posted: bool = False
        """``True`` once the connection's first ``CONTACTS`` listing, the
        radio's whole roster, has posted every contact (SPEC CU2)."""
        self._route = RouteTracker()
        """RX-log copies and the default flood scope for channel-message routes."""

    # ------------------------------------------------------------------
    # Contact management (called from the asyncio thread)
    # ------------------------------------------------------------------

    def _update_contact(self, contact: dict) -> None:
        """Thread-safely add or update a contact in the local snapshot.

        Parameters:
            contact: Contact dict from a ``CONTACTS``, ``NEW_CONTACT``, or
                ``NEXT_CONTACT`` event.
        """
        pub_key = contact.get("public_key")
        if pub_key:
            with self._contacts_lock:
                self._contacts[pub_key] = contact

    def contacts_snapshot(self) -> list[tuple[str, dict]]:
        """Return a thread-safe snapshot of all known contacts as node entries.

        Returns:
            List of ``(canonical_node_id, node_dict)`` pairs, skipping any
            contact whose public key cannot be mapped to a valid node ID.
        """
        with self._contacts_lock:
            items = list(self._contacts.items())
        result = []
        for pub_key, contact in items:
            node_id = _meshcore_node_id(pub_key)
            if node_id is not None:
                result.append((node_id, _contact_to_node_dict(contact)))
        return result

    def is_known_contact(self, pub_key: str) -> bool:
        """Return ``True`` when *pub_key* is already in the contact snapshot.

        Used by the ``ADVERTISEMENT`` handler to decide whether a bare advert
        needs a placeholder upsert: known contacts are kept fresh by the
        meshcore library's auto-update re-fetch, so only non-roster public keys
        are surfaced from a bare advert.

        Parameters:
            pub_key: Full public-key hex string from an ``ADVERTISEMENT`` event.

        Returns:
            ``True`` when a contact with that public key is already tracked,
            ``False`` for an empty key or one not yet in the snapshot.
        """
        if not pub_key:
            return False
        with self._contacts_lock:
            return pub_key in self._contacts

    def lookup_node_id(self, pubkey_prefix: str) -> str | None:
        """Return the canonical node ID for the contact matching *pubkey_prefix*.

        Parameters:
            pubkey_prefix: Twelve-character hex string (six bytes) from a
                ``CONTACT_MSG_RECV`` event.

        Returns:
            Canonical ``!xxxxxxxx`` node ID, or ``None`` when no match.
        """
        with self._contacts_lock:
            return _pubkey_prefix_to_node_id(self._contacts, pubkey_prefix)

    def lookup_node_id_by_name(self, adv_name: str) -> str | None:
        """Return the canonical node ID for the contact whose ``adv_name`` matches.

        Used to resolve the sender of a MeshCore channel message from the
        ``"SenderName: body"`` text prefix when no ``pubkey_prefix`` is
        available in the event payload.  The comparison is case-sensitive
        because ``adv_name`` values come verbatim from the MeshCore firmware.

        A roster keeps a retired keypair under its old name until it is
        evicted, so several contacts can share one name.  The contact with the
        newest ``last_advert`` wins; on a tie the first one in roster order
        does (SPEC GN3).

        Parameters:
            adv_name: Advertised name to look up.  Leading and trailing
                whitespace is stripped before comparison.

        Returns:
            Canonical ``!xxxxxxxx`` node ID, or ``None`` when no contact with
            that name is known.
        """
        name = adv_name.strip() if adv_name else ""
        if not name:
            return None
        best_key = None
        best_advert = -1
        with self._contacts_lock:
            for pub_key, contact in self._contacts.items():
                contact_name = (contact.get("adv_name") or "").strip()
                if contact_name != name:
                    continue
                advert = contact.get("last_advert") or 0
                if advert > best_advert:
                    best_key, best_advert = pub_key, advert
        return _meshcore_node_id(best_key) if best_key else None

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def close(self) -> None:
        """Signal the background event loop to stop and wait for the thread.

        Safe to call multiple times and from any thread.
        """
        self.isConnected = False
        loop = self._loop
        stop_event = self._stop_event
        if loop is not None and not loop.is_closed():
            try:
                if stop_event is not None:
                    loop.call_soon_threadsafe(stop_event.set)
                else:
                    loop.call_soon_threadsafe(loop.stop)
            except RuntimeError:
                pass
        thread = self._thread
        if thread is not None and thread.is_alive():
            thread.join(timeout=5.0)
