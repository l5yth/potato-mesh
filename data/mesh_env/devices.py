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

"""Serial path discovery and BLE scanning (wizard-only; patterns match ``mesh_ingestor.connection``)."""

from __future__ import annotations

import glob

DEFAULT_SERIAL_PATTERNS: tuple[str, ...] = (
    "/dev/ttyACM*",
    "/dev/ttyUSB*",
    "/dev/tty.usbmodem*",
    "/dev/tty.usbserial*",
    "/dev/cu.usbmodem*",
    "/dev/cu.usbserial*",
)


def list_serial_paths() -> list[str]:
    """Return deduplicated serial device paths (same glob rules as the ingestor)."""

    candidates: list[str] = []
    seen: set[str] = set()
    for pattern in DEFAULT_SERIAL_PATTERNS:
        for path in sorted(glob.glob(pattern)):
            if path not in seen:
                candidates.append(path)
                seen.add(path)
    if "/dev/ttyACM0" not in seen:
        candidates.append("/dev/ttyACM0")
    return candidates


async def scan_ble_devices(timeout: float = 8.0) -> list[tuple[str, str]]:
    """Return ``(name_or_unknown, address)`` for discovered BLE peripherals."""

    from bleak import BleakScanner

    devices = await BleakScanner.discover(timeout=timeout)
    out: list[tuple[str, str]] = []
    for d in devices:
        name = (d.name or "").strip() or "(no name)"
        addr = getattr(d, "address", None) or str(d)
        out.append((name, addr))
    out.sort(key=lambda x: (x[0].lower(), x[1]))
    return out
