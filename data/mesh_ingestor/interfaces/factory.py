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

"""Build Meshtastic interface objects from caller-supplied target strings."""

from __future__ import annotations

import sys
from typing import TYPE_CHECKING

from .. import config
from ..connection import parse_ble_target
from .targets import _DEFAULT_TCP_TARGET, _parse_network_target

if TYPE_CHECKING:  # pragma: no cover - import only used for type checking
    from meshtastic.ble_interface import BLEInterface as _BLEInterface


# Resolved on demand by ``_load_ble_interface`` so that the BLE dependency
# stays optional.  The package's ``__init__.py`` re-exports this binding so
# callers and tests can monkey-patch ``data.mesh_ingestor.interfaces.BLEInterface``
# directly.
BLEInterface = None


try:  # pragma: no cover - optional dependency may be unavailable
    from meshtastic.serial_interface import SerialInterface  # type: ignore
except Exception:  # pragma: no cover - optional dependency may be unavailable
    SerialInterface = None  # type: ignore[assignment]

try:  # pragma: no cover - optional dependency may be unavailable
    from meshtastic.tcp_interface import TCPInterface  # type: ignore
except Exception:  # pragma: no cover - optional dependency may be unavailable
    TCPInterface = None  # type: ignore[assignment]


class _DummySerialInterface:
    """In-memory replacement for ``meshtastic.serial_interface.SerialInterface``."""

    def __init__(self) -> None:
        self.nodes: dict = {}

    def close(self) -> None:  # pragma: no cover - nothing to close
        """No-op: the dummy interface holds no resources to release."""
        pass


class NoAvailableMeshInterface(RuntimeError):
    """Raised when no default mesh interface can be created."""


def _load_ble_interface():
    """Return :class:`meshtastic.ble_interface.BLEInterface` when available.

    Returns:
        The resolved BLE interface class.

    Raises:
        RuntimeError: If the BLE dependencies are not installed.
    """

    global BLEInterface
    pkg = sys.modules.get("data.mesh_ingestor.interfaces")
    pkg_ble = getattr(pkg, "BLEInterface", None) if pkg is not None else None
    if pkg_ble is not None:
        BLEInterface = pkg_ble
        return pkg_ble
    if BLEInterface is not None:
        if pkg is not None:
            setattr(pkg, "BLEInterface", BLEInterface)
        return BLEInterface

    try:
        from meshtastic.ble_interface import BLEInterface as _resolved_interface
    except ImportError as exc:  # pragma: no cover - exercised in non-BLE envs
        raise RuntimeError(
            "BLE interface requested but the Meshtastic BLE dependencies are not installed. "
            "Install the 'meshtastic[ble]' extra to enable BLE support."
        ) from exc
    BLEInterface = _resolved_interface
    if pkg is not None:
        setattr(pkg, "BLEInterface", _resolved_interface)
    for module_name in ("data.mesh_ingestor", "data.mesh"):
        mesh_module = sys.modules.get(module_name)
        if mesh_module is not None:
            setattr(mesh_module, "BLEInterface", _resolved_interface)
    return _resolved_interface


def _create_serial_interface(port: str) -> tuple[object, str]:
    """Return an appropriate mesh interface for ``port``.

    Parameters:
        port: User-supplied port string which may represent serial, BLE or TCP.

    Returns:
        ``(interface, resolved_target)`` describing the created interface.
    """

    pkg = sys.modules["data.mesh_ingestor.interfaces"]

    port_value = (port or "").strip()
    if port_value.lower() in {"", "mock", "none", "null", "disabled"}:
        config._debug_log(
            "Using dummy serial interface",
            context="interfaces.serial",
            port=port_value,
        )
        return _DummySerialInterface(), "mock"
    ble_target = parse_ble_target(port_value)
    if ble_target:
        # Determine if it's a MAC address or UUID
        address_type = "MAC" if ":" in ble_target else "UUID"
        config._debug_log(
            "Using BLE interface",
            context="interfaces.ble",
            address=ble_target,
            address_type=address_type,
        )
        return _load_ble_interface()(address=ble_target), ble_target
    network_target = _parse_network_target(port_value)
    if network_target:
        host, tcp_port = network_target
        config._debug_log(
            "Using TCP interface",
            context="interfaces.tcp",
            host=host,
            port=tcp_port,
        )
        # Resolve via the package so test fakes installed via ``sys.modules``
        # patches at ``meshtastic.tcp_interface`` propagate when interfaces
        # was imported earlier.
        tcp_cls = getattr(pkg, "TCPInterface", TCPInterface)
        return (
            tcp_cls(hostname=host, portNumber=tcp_port),
            f"tcp://{host}:{tcp_port}",
        )
    config._debug_log(
        "Using serial interface",
        context="interfaces.serial",
        port=port_value,
    )
    serial_cls = getattr(pkg, "SerialInterface", SerialInterface)
    return serial_cls(devPath=port_value), port_value


def _create_default_interface() -> tuple[object, str]:
    """Attempt to create the default mesh interface, raising on failure.

    Returns:
        ``(interface, resolved_target)`` for the discovered connection.

    Raises:
        NoAvailableMeshInterface: When no usable connection can be created.
    """

    # Resolve via the package surface so that monkeypatches against the
    # backward-compat aliases (``mesh._default_serial_targets``,
    # ``mesh._create_serial_interface``) propagate at call time.
    pkg = sys.modules["data.mesh_ingestor.interfaces"]
    default_serial_targets = pkg._default_serial_targets
    create_serial = pkg._create_serial_interface

    errors: list[tuple[str, Exception]] = []
    for candidate in default_serial_targets():
        try:
            return create_serial(candidate)
        except Exception as exc:  # pragma: no cover - hardware dependent
            errors.append((candidate, exc))
            config._debug_log(
                "Failed to open serial candidate",
                context="interfaces.auto_discovery",
                target=candidate,
                error_class=exc.__class__.__name__,
                error_message=str(exc),
            )
    try:
        return create_serial(_DEFAULT_TCP_TARGET)
    except Exception as exc:  # pragma: no cover - network dependent
        errors.append((_DEFAULT_TCP_TARGET, exc))
        config._debug_log(
            "Failed to open TCP fallback",
            context="interfaces.auto_discovery",
            target=_DEFAULT_TCP_TARGET,
            error_class=exc.__class__.__name__,
            error_message=str(exc),
        )
    if errors:
        summary = "; ".join(f"{target}: {error}" for target, error in errors)
        raise NoAvailableMeshInterface(
            f"no mesh interface available ({summary})"
        ) from errors[-1][1]
    raise NoAvailableMeshInterface("no mesh interface available")
