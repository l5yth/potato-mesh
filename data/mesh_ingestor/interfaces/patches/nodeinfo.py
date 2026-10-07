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

"""Runtime patches that harden Meshtastic's nodeinfo handler.

They guard against a NodeInfo whose ``user.id`` is not its sender's canonical
id (SPEC NI1), and against missing ``id`` fields.
"""

from __future__ import annotations

import contextlib
import importlib
import sys

try:  # pragma: no cover - dependency optional in tests
    import meshtastic  # type: ignore
except Exception:  # pragma: no cover - dependency optional in tests
    meshtastic = None  # type: ignore[assignment]

from ...node_identity import canonical_node_id, claims_node
from ..nodeinfo_normalize import _normalise_nodeinfo_packet

_SENDER_GUARD_MARKER = "_potato_mesh_sender_guard"
"""Attribute set on the guarded NodeInfo callback, so it is wrapped only once."""


def _patch_meshtastic_nodeinfo_handler() -> None:
    """Harden the Meshtastic NodeInfo handling the ingestor relies on.

    Guards the ``NODEINFO_APP`` dispatch entry against a ``user.id`` naming
    another node (:func:`_patch_meshtastic_nodeinfo_dispatch`), and ensures
    nodeinfo packets passed to the module-level handler always include an
    ``id`` field.
    """

    module = sys.modules.get("meshtastic", meshtastic)
    if module is None:  # pragma: no cover - re-import fallback for cold caches
        with contextlib.suppress(Exception):
            module = importlib.import_module("meshtastic")
    if module is None:  # pragma: no cover - exercised only without meshtastic
        return
    globals()["meshtastic"] = module

    _patch_meshtastic_nodeinfo_dispatch(module)

    original = getattr(module, "_onNodeInfoReceive", None)
    if not callable(original):  # pragma: no cover - upstream API regression guard
        return

    mesh_interface_module = getattr(module, "mesh_interface", None)
    if mesh_interface_module is None:
        with contextlib.suppress(Exception):
            mesh_interface_module = importlib.import_module("meshtastic.mesh_interface")

    # Replace the module-level handler only once; the sentinel attribute prevents
    # re-wrapping if _patch_meshtastic_nodeinfo_handler() is called again after
    # the interface module is reloaded or re-imported.
    if not getattr(original, "_potato_mesh_safe_wrapper", False):
        module._onNodeInfoReceive = _build_safe_nodeinfo_callback(original)

    _patch_nodeinfo_handler_class(mesh_interface_module, module)


def _patch_meshtastic_nodeinfo_dispatch(module) -> None:
    """Guard the library's ``NODEINFO_APP`` dispatch entry (SPEC NI1).

    ``MeshInterface._handlePacketFromRadio`` hands a received NodeInfo to the
    ``onReceive`` of ``meshtastic.protocols[NODEINFO_APP]``.  That callback,
    ``_onNodeInfoReceive``, stores the payload's ``User`` as the profile of
    the packet's sender in ``nodesByNum`` and files the sender's entry in
    ``iface.nodes`` under the payload's ``user.id``.  A ``user.id`` naming
    another node therefore remaps the sender: the library reports its later
    packets with the other node's ``fromId``, and the node-list snapshot
    carries the sender's entry under the other node's id.  The table holds its
    own reference to the callback, so replacing the module attribute
    ``meshtastic._onNodeInfoReceive`` never reaches live packets (checked
    against meshtastic 2.7.11); the entry itself is replaced here.  The packet
    is still published, and the ingestor's NodeInfo handler drops it with a
    warning.

    Parameters:
        module: The imported ``meshtastic`` package.

    Returns:
        ``None``.  Nothing changes when the package has no dispatch table or no
        ``NODEINFO_APP`` entry, or when the entry is already guarded.
    """

    protocols = getattr(module, "protocols", None)
    port_enum = getattr(getattr(module, "portnums_pb2", None), "PortNum", None)
    port = getattr(port_enum, "NODEINFO_APP", None)
    entry = protocols.get(port) if isinstance(protocols, dict) else None
    on_receive = getattr(entry, "onReceive", None)
    replace = getattr(entry, "_replace", None)
    if not callable(on_receive) or not callable(replace):
        return
    if getattr(on_receive, _SENDER_GUARD_MARKER, False):
        return
    protocols[port] = replace(onReceive=_build_nodeinfo_sender_guard(on_receive))


def _build_nodeinfo_sender_guard(original):
    """Return a NodeInfo ``onReceive`` that ignores a ``user.id`` not its sender's.

    Parameters:
        original: The library's NodeInfo callback, ``(iface, packet)``.

    Returns:
        A callback with the same signature.  It calls ``original`` only when
        the packet's ``decoded.user.id`` is the canonical id of its numeric
        ``from`` (:func:`~data.mesh_ingestor.node_identity.claims_node`), and
        returns ``None`` otherwise, so the library's node database keeps every
        node under its own profile; when it calls ``original`` it returns what
        ``original`` returns.  ``original`` would raise ``KeyError('id')`` on
        a user without an ``id``, which ends ``_handlePacketFromRadio`` before
        the packet is published; skipped here, the packet reaches the
        ingestor, which files it under its sender.
    """

    def _guarded_on_node_info_receive(iface, packet):
        user = (packet.get("decoded") or {}).get("user") or {}
        if not claims_node(user.get("id"), canonical_node_id(packet.get("from"))):
            return None
        return original(iface, packet)

    setattr(_guarded_on_node_info_receive, _SENDER_GUARD_MARKER, True)
    return _guarded_on_node_info_receive


def _build_safe_nodeinfo_callback(original):
    """Return a wrapper that injects a missing ``id`` before dispatching."""

    def _safe_on_node_info_receive(iface, packet):  # type: ignore[override]
        normalised = _normalise_nodeinfo_packet(packet)
        if normalised is not None:
            packet = normalised

        try:
            return original(iface, packet)
        except KeyError as exc:  # pragma: no cover - defensive only
            if exc.args and exc.args[0] == "id":
                return None
            raise

    _safe_on_node_info_receive._potato_mesh_safe_wrapper = True  # type: ignore[attr-defined]
    return _safe_on_node_info_receive


def _update_nodeinfo_handler_aliases(original, replacement) -> None:
    """Ensure Meshtastic modules reference the patched ``NodeInfoHandler``."""

    for module_name, module in list(sys.modules.items()):
        if not module_name.startswith("meshtastic"):
            continue
        existing = getattr(module, "NodeInfoHandler", None)
        if existing is original:
            setattr(module, "NodeInfoHandler", replacement)


def _patch_nodeinfo_handler_class(
    mesh_interface_module, meshtastic_module=None
) -> None:
    """Wrap ``NodeInfoHandler.onReceive`` to normalise packets before callbacks."""

    if (
        mesh_interface_module is None
    ):  # pragma: no cover - exercised only without meshtastic
        return

    handler_class = getattr(mesh_interface_module, "NodeInfoHandler", None)
    if handler_class is None:  # pragma: no cover - upstream API regression guard
        return
    if getattr(
        handler_class, "_potato_mesh_safe_wrapper", False
    ):  # pragma: no cover - re-entry guard
        return

    original_on_receive = getattr(handler_class, "onReceive", None)
    if not callable(
        original_on_receive
    ):  # pragma: no cover - upstream API regression guard
        return

    class _SafeNodeInfoHandler(handler_class):  # type: ignore[misc]
        """Subclass that guards against missing node identifiers."""

        def onReceive(self, iface, packet):  # type: ignore[override]
            """Normalise ``packet`` before dispatching to the parent handler.

            Injects a canonical ``id`` field when one can be inferred from the
            packet's other fields, then delegates to the original
            ``NodeInfoHandler.onReceive``.  A ``KeyError`` on ``"id"`` is
            suppressed because some firmware versions omit the field entirely.

            Parameters:
                iface: The Meshtastic interface that received the packet.
                packet: Raw nodeinfo packet dict, possibly lacking an ``id``
                    key.

            Returns:
                The return value of the parent handler, or ``None`` when a
                missing ``"id"`` key would otherwise raise.
            """
            normalised = _normalise_nodeinfo_packet(packet)
            if normalised is not None:
                packet = normalised

            try:
                return super().onReceive(iface, packet)
            except KeyError as exc:  # pragma: no cover - defensive only
                if exc.args and exc.args[0] == "id":
                    return None
                raise

    _SafeNodeInfoHandler.__name__ = handler_class.__name__
    _SafeNodeInfoHandler.__qualname__ = getattr(
        handler_class, "__qualname__", handler_class.__name__
    )
    _SafeNodeInfoHandler.__module__ = getattr(
        handler_class, "__module__", mesh_interface_module.__name__
    )
    _SafeNodeInfoHandler.__doc__ = getattr(
        handler_class, "__doc__", _SafeNodeInfoHandler.__doc__
    )
    _SafeNodeInfoHandler._potato_mesh_safe_wrapper = True  # type: ignore[attr-defined]

    setattr(mesh_interface_module, "NodeInfoHandler", _SafeNodeInfoHandler)
    if meshtastic_module is None:
        meshtastic_module = globals().get("meshtastic")
    if meshtastic_module is not None:
        existing_top = getattr(meshtastic_module, "NodeInfoHandler", None)
        if existing_top is handler_class:  # pragma: no cover - top-level re-export
            setattr(meshtastic_module, "NodeInfoHandler", _SafeNodeInfoHandler)
    _update_nodeinfo_handler_aliases(handler_class, _SafeNodeInfoHandler)
