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

"""Runtime patches that harden Meshtastic's nodeinfo handler against missing ``id`` fields."""

from __future__ import annotations

import contextlib
import importlib
import sys

try:  # pragma: no cover - dependency optional in tests
    import meshtastic  # type: ignore
except Exception:  # pragma: no cover - dependency optional in tests
    meshtastic = None  # type: ignore[assignment]

from ..nodeinfo_normalize import _normalise_nodeinfo_packet


def _patch_meshtastic_nodeinfo_handler() -> None:
    """Ensure Meshtastic nodeinfo packets always include an ``id`` field."""

    module = sys.modules.get("meshtastic", meshtastic)
    if module is None:
        with contextlib.suppress(Exception):
            module = importlib.import_module("meshtastic")
    if module is None:
        return
    globals()["meshtastic"] = module

    original = getattr(module, "_onNodeInfoReceive", None)
    if not callable(original):
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

    if mesh_interface_module is None:
        return

    handler_class = getattr(mesh_interface_module, "NodeInfoHandler", None)
    if handler_class is None:
        return
    if getattr(handler_class, "_potato_mesh_safe_wrapper", False):
        return

    original_on_receive = getattr(handler_class, "onReceive", None)
    if not callable(original_on_receive):
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
        if existing_top is handler_class:
            setattr(meshtastic_module, "NodeInfoHandler", _SafeNodeInfoHandler)
    _update_nodeinfo_handler_aliases(handler_class, _SafeNodeInfoHandler)
