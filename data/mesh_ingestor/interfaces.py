# Copyright (C) 2025 l5yth
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

"""Mesh interface discovery helpers for interacting with Meshtastic hardware."""

from __future__ import annotations

import glob
import ipaddress
import logging
import re
import threading
import time
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


def _patch_meshtastic_ble_receive_loop() -> None:
    """Prevent ``UnboundLocalError`` crashes in Meshtastic's BLE reader."""

    try:
        from meshtastic import ble_interface as _ble_interface_module  # type: ignore
    except Exception:  # pragma: no cover - dependency optional in tests
        return

    ble_class = getattr(_ble_interface_module, "BLEInterface", None)
    if ble_class is None:
        return

    original = getattr(ble_class, "_receiveFromRadioImpl", None)
    if not callable(original):
        return
    if getattr(original, "_potato_mesh_safe_wrapper", False):
        return

    FROMRADIO_UUID = getattr(_ble_interface_module, "FROMRADIO_UUID", None)
    BleakDBusError = getattr(_ble_interface_module, "BleakDBusError", ())
    BleakError = getattr(_ble_interface_module, "BleakError", ())
    logger = getattr(_ble_interface_module, "logger", None)
    time = getattr(_ble_interface_module, "time", None)

    if not FROMRADIO_UUID or logger is None or time is None:
        return

    def _safe_receive_from_radio(self):  # type: ignore[override]
        while self._want_receive:
            if self.should_read:
                self.should_read = False
                retries: int = 0
                while self._want_receive:
                    if self.client is None:
                        logger.debug("BLE client is None, shutting down")
                        self._want_receive = False
                        continue

                    payload: bytes = b""
                    try:
                        payload = bytes(self.client.read_gatt_char(FROMRADIO_UUID))
                    except BleakDBusError as exc:
                        logger.debug("Device disconnected, shutting down %s", exc)
                        self._want_receive = False
                        payload = b""
                    except BleakError as exc:
                        if "Not connected" in str(exc):
                            logger.debug("Device disconnected, shutting down %s", exc)
                            self._want_receive = False
                            payload = b""
                        else:
                            raise ble_class.BLEError("Error reading BLE") from exc

                    if not payload:
                        if not self._want_receive:
                            break
                        if retries < 5:
                            time.sleep(0.1)
                            retries += 1
                            continue
                        break

                    logger.debug("FROMRADIO read: %s", payload.hex())
                    self._handleFromRadio(payload)
            else:
                time.sleep(0.01)

    _safe_receive_from_radio._potato_mesh_safe_wrapper = True  # type: ignore[attr-defined]
    ble_class._receiveFromRadioImpl = _safe_receive_from_radio


_patch_meshtastic_ble_receive_loop()


_STREAM_DISCONNECT_LOCK = threading.Lock()
_STREAM_DISCONNECT_MONOTONIC: float | None = None


class _StreamDisconnectHandler(logging.Handler):
    """Capture serial disconnect warnings emitted by Meshtastic."""

    def emit(
        self, record: logging.LogRecord
    ) -> None:  # pragma: no cover - logging glue
        message = record.getMessage()
        if "Meshtastic serial port disconnected" not in message:
            return
        now = time.monotonic()
        with _STREAM_DISCONNECT_LOCK:
            global _STREAM_DISCONNECT_MONOTONIC
            _STREAM_DISCONNECT_MONOTONIC = now


def _install_stream_disconnect_handler() -> None:
    try:
        from meshtastic import stream_interface as _stream_interface_module  # type: ignore
    except Exception:  # pragma: no cover - dependency optional in tests
        return

    logger = getattr(_stream_interface_module, "logger", None)
    if logger is None:
        return

    for handler in getattr(logger, "handlers", ()):  # pragma: no cover - defensive
        if getattr(handler, "_potato_mesh_stream_disconnect", False):
            return

    handler = _StreamDisconnectHandler()
    handler.setLevel(logging.WARNING)
    handler._potato_mesh_stream_disconnect = True  # type: ignore[attr-defined]
    logger.addHandler(handler)


def _last_stream_disconnect_monotonic() -> float | None:
    with _STREAM_DISCONNECT_LOCK:
        return _STREAM_DISCONNECT_MONOTONIC


_install_stream_disconnect_handler()


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
    """Return an uppercase BLE MAC address when ``value`` matches the format.

    Parameters:
        value: User-provided target string.

    Returns:
        The normalised MAC address or ``None`` when validation fails.
    """

    if not value:
        return None
    value = value.strip()
    if not value:
        return None
    if _BLE_ADDRESS_RE.fullmatch(value):
        return value.upper()
    return None


def _parse_network_target(value: str) -> tuple[str, int] | None:
    """Return ``(host, port)`` when ``value`` is an IP address string.

    Parameters:
        value: Hostname or URL describing the TCP interface.

    Returns:
        A ``(host, port)`` tuple or ``None`` when parsing fails.
    """

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
    """Return :class:`meshtastic.ble_interface.BLEInterface` when available.

    Returns:
        The resolved BLE interface class.

    Raises:
        RuntimeError: If the BLE dependencies are not installed.
    """

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
    """Return an appropriate mesh interface for ``port``.

    Parameters:
        port: User-supplied port string which may represent serial, BLE or TCP.

    Returns:
        ``(interface, resolved_target)`` describing the created interface.
    """

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
    """Return candidate serial device paths for auto-discovery."""

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
    """Attempt to create the default mesh interface, raising on failure.

    Returns:
        ``(interface, resolved_target)`` for the discovered connection.

    Raises:
        NoAvailableMeshInterface: When no usable connection can be created.
    """

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
    "_install_stream_disconnect_handler",
    "_last_stream_disconnect_monotonic",
    "_load_ble_interface",
    "_parse_ble_target",
    "_parse_network_target",
    "SerialInterface",
    "TCPInterface",
]
