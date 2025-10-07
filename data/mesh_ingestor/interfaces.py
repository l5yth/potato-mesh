"""Mesh interface discovery helpers."""

from __future__ import annotations

import glob
import ipaddress
import re
import urllib.parse
from collections.abc import Mapping
from typing import TYPE_CHECKING

from meshtastic.serial_interface import SerialInterface
from meshtastic.tcp_interface import TCPInterface

from . import config, serialization

if TYPE_CHECKING:  # pragma: no cover - import only used for type checking
    from meshtastic.ble_interface import BLEInterface as _BLEInterface

BLEInterface = None


def _patch_meshtastic_nodeinfo_handler() -> None:
    """Ensure Meshtastic nodeinfo packets always include an ``id`` field."""

    try:
        import meshtastic  # type: ignore
    except Exception:  # pragma: no cover - dependency optional in tests
        return

    original = getattr(meshtastic, "_onNodeInfoReceive", None)
    if not callable(original):
        return
    if getattr(original, "_potato_mesh_safe_wrapper", False):
        return

    def _safe_on_node_info_receive(iface, packet):  # type: ignore[override]
        candidate_mapping: Mapping | None = None
        if isinstance(packet, Mapping):
            candidate_mapping = packet
        elif hasattr(packet, "__dict__") and isinstance(packet.__dict__, Mapping):
            candidate_mapping = packet.__dict__

        node_id = None
        if candidate_mapping is not None:
            node_id = serialization._canonical_node_id(candidate_mapping.get("id"))
            if node_id is None:
                user_section = candidate_mapping.get("user")
                if isinstance(user_section, Mapping):
                    node_id = serialization._canonical_node_id(user_section.get("id"))
            if node_id is None:
                for key in ("fromId", "from_id", "from", "num", "nodeId", "node_id"):
                    node_id = serialization._canonical_node_id(
                        candidate_mapping.get(key)
                    )
                    if node_id:
                        break

            if node_id:
                if not isinstance(candidate_mapping, dict):
                    try:
                        candidate_mapping = dict(candidate_mapping)
                    except Exception:
                        candidate_mapping = {
                            k: candidate_mapping[k] for k in candidate_mapping
                        }
                if candidate_mapping.get("id") != node_id:
                    candidate_mapping["id"] = node_id
                packet = candidate_mapping

        try:
            return original(iface, packet)
        except KeyError as exc:  # pragma: no cover - defensive only
            if exc.args and exc.args[0] == "id":
                return None
            raise

    _safe_on_node_info_receive._potato_mesh_safe_wrapper = True  # type: ignore[attr-defined]
    meshtastic._onNodeInfoReceive = _safe_on_node_info_receive


_patch_meshtastic_nodeinfo_handler()

_DEFAULT_TCP_PORT = 4403
_DEFAULT_TCP_TARGET = "http://127.0.0.1"

_DEFAULT_SERIAL_PATTERNS = (
    "/dev/ttyACM*",
    "/dev/ttyUSB*",
    "/dev/tty.usbmodem*",
    "/dev/tty.usbserial*",
    "/dev/cu.usbmodem*",
    "/dev/cu.usbserial*",
)

_BLE_ADDRESS_RE = re.compile(r"^(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$")


class _DummySerialInterface:
    """In-memory replacement for ``meshtastic.serial_interface.SerialInterface``."""

    def __init__(self) -> None:
        self.nodes: dict = {}

    def close(self) -> None:  # pragma: no cover - nothing to close
        pass


def _parse_ble_target(value: str) -> str | None:
    """Return an uppercase BLE MAC address when ``value`` matches the format."""

    if not value:
        return None
    value = value.strip()
    if not value:
        return None
    if _BLE_ADDRESS_RE.fullmatch(value):
        return value.upper()
    return None


def _parse_network_target(value: str) -> tuple[str, int] | None:
    """Return ``(host, port)`` when ``value`` is an IP address string."""

    if not value:
        return None

    value = value.strip()
    if not value:
        return None

    def _validated_result(host: str | None, port: int | None) -> tuple[str, int] | None:
        if not host:
            return None
        try:
            ipaddress.ip_address(host)
        except ValueError:
            return None
        return host, port or _DEFAULT_TCP_PORT

    parsed_values = []
    if "://" in value:
        parsed_values.append(urllib.parse.urlparse(value, scheme="tcp"))
    parsed_values.append(urllib.parse.urlparse(f"//{value}", scheme="tcp"))

    for parsed in parsed_values:
        try:
            port = parsed.port
        except ValueError:
            port = None
        result = _validated_result(parsed.hostname, port)
        if result:
            return result

    if value.count(":") == 1 and not value.startswith("["):
        host, _, port_text = value.partition(":")
        try:
            port = int(port_text) if port_text else None
        except ValueError:
            port = None
        result = _validated_result(host, port)
        if result:
            return result

    return _validated_result(value, None)


def _load_ble_interface():
    """Return :class:`meshtastic.ble_interface.BLEInterface` when available."""

    global BLEInterface
    if BLEInterface is not None:
        return BLEInterface

    try:
        from meshtastic.ble_interface import BLEInterface as _resolved_interface
    except ImportError as exc:  # pragma: no cover - exercised in non-BLE envs
        raise RuntimeError(
            "BLE interface requested but the Meshtastic BLE dependencies are not installed. "
            "Install the 'meshtastic[ble]' extra to enable BLE support."
        ) from exc
    BLEInterface = _resolved_interface
    try:
        import sys

        for module_name in ("data.mesh_ingestor", "data.mesh"):
            mesh_module = sys.modules.get(module_name)
            if mesh_module is not None:
                setattr(mesh_module, "BLEInterface", BLEInterface)
    except Exception:  # pragma: no cover - defensive only
        pass
    return _resolved_interface


def _create_serial_interface(port: str) -> tuple[object, str]:
    """Return an appropriate mesh interface for ``port``."""

    port_value = (port or "").strip()
    if port_value.lower() in {"", "mock", "none", "null", "disabled"}:
        config._debug_log(f"using dummy serial interface for port={port_value!r}")
        return _DummySerialInterface(), "mock"
    ble_target = _parse_ble_target(port_value)
    if ble_target:
        config._debug_log(f"using BLE interface for address={ble_target}")
        return _load_ble_interface()(address=ble_target), ble_target
    network_target = _parse_network_target(port_value)
    if network_target:
        host, tcp_port = network_target
        config._debug_log(f"using TCP interface for host={host!r} port={tcp_port!r}")
        return (
            TCPInterface(hostname=host, portNumber=tcp_port),
            f"tcp://{host}:{tcp_port}",
        )
    config._debug_log(f"using serial interface for port={port_value!r}")
    return SerialInterface(devPath=port_value), port_value


class NoAvailableMeshInterface(RuntimeError):
    """Raised when no default mesh interface can be created."""


def _default_serial_targets() -> list[str]:
    """Return a list of candidate serial device paths for auto-discovery."""

    candidates: list[str] = []
    seen: set[str] = set()
    for pattern in _DEFAULT_SERIAL_PATTERNS:
        for path in sorted(glob.glob(pattern)):
            if path not in seen:
                candidates.append(path)
                seen.add(path)
    if "/dev/ttyACM0" not in seen:
        candidates.append("/dev/ttyACM0")
    return candidates


def _create_default_interface() -> tuple[object, str]:
    """Attempt to create the default mesh interface, raising on failure."""

    errors: list[tuple[str, Exception]] = []
    for candidate in _default_serial_targets():
        try:
            return _create_serial_interface(candidate)
        except Exception as exc:  # pragma: no cover - hardware dependent
            errors.append((candidate, exc))
            config._debug_log(f"failed to open serial candidate {candidate!r}: {exc}")
    try:
        return _create_serial_interface(_DEFAULT_TCP_TARGET)
    except Exception as exc:  # pragma: no cover - network dependent
        errors.append((_DEFAULT_TCP_TARGET, exc))
        config._debug_log(f"failed to open TCP fallback {_DEFAULT_TCP_TARGET!r}: {exc}")
    if errors:
        summary = "; ".join(f"{target}: {error}" for target, error in errors)
        raise NoAvailableMeshInterface(
            f"no mesh interface available ({summary})"
        ) from errors[-1][1]
    raise NoAvailableMeshInterface("no mesh interface available")


__all__ = [
    "BLEInterface",
    "NoAvailableMeshInterface",
    "_DummySerialInterface",
    "_DEFAULT_TCP_PORT",
    "_DEFAULT_TCP_TARGET",
    "_create_default_interface",
    "_create_serial_interface",
    "_default_serial_targets",
    "_load_ble_interface",
    "_parse_ble_target",
    "_parse_network_target",
    "SerialInterface",
    "TCPInterface",
]
