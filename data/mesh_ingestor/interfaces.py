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
import re
import urllib.parse
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any

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


def _has_field(message: Any, field_name: str) -> bool:
    """Return ``True`` when ``message`` advertises ``field_name`` via ``HasField``."""

    if message is None:
        return False
    has_field = getattr(message, "HasField", None)
    if callable(has_field):
        try:
            return bool(has_field(field_name))
        except Exception:  # pragma: no cover - defensive guard
            return False
    return hasattr(message, field_name)


def _enum_name_from_field(message: Any, field_name: str, value: Any) -> str | None:
    """Return the enum name for ``value`` using ``message`` descriptors."""

    descriptor = getattr(message, "DESCRIPTOR", None)
    if descriptor is None:
        return None
    fields_by_name = getattr(descriptor, "fields_by_name", {})
    field_desc = fields_by_name.get(field_name)
    if field_desc is None:
        return None
    enum_type = getattr(field_desc, "enum_type", None)
    if enum_type is None:
        return None
    enum_values = getattr(enum_type, "values_by_number", {})
    enum_value = enum_values.get(value)
    if enum_value is None:
        return None
    return getattr(enum_value, "name", None)


def _resolve_lora_message(local_config: Any) -> Any | None:
    """Return the LoRa configuration sub-message from ``local_config``."""

    if local_config is None:
        return None
    if _has_field(local_config, "lora"):
        candidate = getattr(local_config, "lora", None)
        if candidate is not None:
            return candidate
    radio_section = getattr(local_config, "radio", None)
    if radio_section is not None:
        if _has_field(radio_section, "lora"):
            return getattr(radio_section, "lora", None)
        if hasattr(radio_section, "lora"):
            return getattr(radio_section, "lora")
    if hasattr(local_config, "lora"):
        return getattr(local_config, "lora")
    return None


def _region_frequency(lora_message: Any) -> int | None:
    """Derive the LoRa region frequency in MHz from ``lora_message``."""

    if lora_message is None:
        return None
    region_value = getattr(lora_message, "region", None)
    if region_value is None:
        return None
    enum_name = _enum_name_from_field(lora_message, "region", region_value)
    if enum_name:
        digits = re.findall(r"\d+", enum_name)
        for token in digits:
            try:
                freq = int(token)
            except ValueError:  # pragma: no cover - regex guarantees digits
                continue
            if freq >= 100:
                return freq
        for token in reversed(digits):
            try:
                return int(token)
            except ValueError:  # pragma: no cover - defensive only
                continue
    if isinstance(region_value, int) and region_value >= 100:
        return region_value
    return None


def _camelcase_enum_name(name: str | None) -> str | None:
    """Convert ``name`` from ``SCREAMING_SNAKE`` to ``CamelCase``."""

    if not name:
        return None
    parts = re.split(r"[^0-9A-Za-z]+", name.strip())
    camel_parts = [part.capitalize() for part in parts if part]
    if not camel_parts:
        return None
    return "".join(camel_parts)


def _modem_preset(lora_message: Any) -> str | None:
    """Return the CamelCase modem preset configured on ``lora_message``."""

    if lora_message is None:
        return None
    descriptor = getattr(lora_message, "DESCRIPTOR", None)
    fields_by_name = getattr(descriptor, "fields_by_name", {}) if descriptor else {}
    if "modem_preset" in fields_by_name:
        preset_field = "modem_preset"
    elif "preset" in fields_by_name:
        preset_field = "preset"
    elif hasattr(lora_message, "modem_preset"):
        preset_field = "modem_preset"
    elif hasattr(lora_message, "preset"):
        preset_field = "preset"
    else:
        return None

    preset_value = getattr(lora_message, preset_field, None)
    if preset_value is None:
        return None
    enum_name = _enum_name_from_field(lora_message, preset_field, preset_value)
    if isinstance(enum_name, str) and enum_name:
        return _camelcase_enum_name(enum_name)
    if isinstance(preset_value, str) and preset_value:
        return _camelcase_enum_name(preset_value)
    return None


def _ensure_radio_metadata(iface: Any) -> None:
    """Populate cached LoRa metadata by inspecting ``iface`` when available."""

    if iface is None:
        return

    try:
        wait_for_config = getattr(iface, "waitForConfig", None)
        if callable(wait_for_config):
            wait_for_config()
    except Exception:  # pragma: no cover - hardware dependent guard
        pass

    local_node = getattr(iface, "localNode", None)
    local_config = getattr(local_node, "localConfig", None) if local_node else None
    lora_message = _resolve_lora_message(local_config)
    if lora_message is None:
        return

    frequency = _region_frequency(lora_message)
    preset = _modem_preset(lora_message)

    updated = False
    if frequency is not None and getattr(config, "LORA_FREQ", None) is None:
        config.LORA_FREQ = frequency
        updated = True
    if preset is not None and getattr(config, "MODEM_PRESET", None) is None:
        config.MODEM_PRESET = preset
        updated = True

    if updated:
        config._debug_log(
            "Captured LoRa radio metadata",
            context="interfaces.ensure_radio_metadata",
            severity="info",
            always=True,
            lora_freq=frequency,
            modem_preset=preset,
        )


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
    """Return ``(host, port)`` when ``value`` is a numeric IP address string.

    Only literal IPv4 or IPv6 addresses are accepted, optionally paired with a
    port or scheme. Callers that start from hostnames should resolve them to an
    address before invoking this helper.

    Parameters:
        value: Numeric IP literal or URL describing the TCP interface.

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
        config._debug_log(
            "Using dummy serial interface",
            context="interfaces.serial",
            port=port_value,
        )
        return _DummySerialInterface(), "mock"
    ble_target = _parse_ble_target(port_value)
    if ble_target:
        config._debug_log(
            "Using BLE interface",
            context="interfaces.ble",
            address=ble_target,
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
        return (
            TCPInterface(hostname=host, portNumber=tcp_port),
            f"tcp://{host}:{tcp_port}",
        )
    config._debug_log(
        "Using serial interface",
        context="interfaces.serial",
        port=port_value,
    )
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
            config._debug_log(
                "Failed to open serial candidate",
                context="interfaces.auto_discovery",
                target=candidate,
                error_class=exc.__class__.__name__,
                error_message=str(exc),
            )
    try:
        return _create_serial_interface(_DEFAULT_TCP_TARGET)
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


__all__ = [
    "BLEInterface",
    "NoAvailableMeshInterface",
    "_ensure_radio_metadata",
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
