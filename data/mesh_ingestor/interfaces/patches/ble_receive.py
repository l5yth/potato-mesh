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

"""Patch the upstream Meshtastic BLE receive loop to avoid ``UnboundLocalError``."""

from __future__ import annotations


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
