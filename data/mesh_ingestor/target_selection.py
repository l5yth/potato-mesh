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

"""Interactive and non-interactive selection of mesh radio connection targets.

USB serial candidates come from :func:`~data.mesh_ingestor.connection.default_serial_targets`.
When stdin/stdout are TTYs, an optional BLE scan (Bleak) adds rows filtered by a
provider-specific advertisement matcher. Interactive mode also drops missing
``/dev/…`` (and ``COMn``) serial paths so a lone fallback such as ``/dev/ttyACM0``
does not suppress the menu on macOS. A sole **BLE** match never auto-connects (the
scan may still be discovering radios); at the prompt, a **blank line** re-runs
the scan and refreshes the list.

Environment variables:

* :envvar:`BLE_SCAN_SECS` — seconds for the interactive BLE device scan (default ``5``).
"""

from __future__ import annotations

import asyncio
import os
import re
import sys
import threading
from collections.abc import Callable

from . import config
from .connection import default_serial_targets, parse_ble_target

DEFAULT_BLE_SCAN_SECS: float = 5.0
"""Default seconds to scan for BLE devices when prompting interactively."""

# Primary Meshtastic BLE GATT service (:mod:`meshtastic.ble_interface`); duplicated
# here so we can match radios without importing optional BLE stack at module load.
MESHTASTIC_BLE_SERVICE_UUID = "6ba1b218-15a8-461f-9fa8-5dcae273eafd"

BleMatchFn = Callable[[object, object], bool]
"""Predicate ``(device, advertisement_data) -> bool`` for BLE filtering."""


def meshcore_ble_advertisement_match(device: object, adv: object) -> bool:
    """Return True when *adv* / *device* look like a MeshCore BLE companion.

    Uses the same naming rule as :mod:`meshcore.ble_cx` (advertised local name
    prefixed with ``MeshCore``), with a fallback to :attr:`BLEDevice.name`.

    Parameters:
        device: ``bleak`` :class:`~bleak.backends.device.BLEDevice`.
        adv: ``bleak`` :class:`~bleak.backends.scanner.AdvertisementData`.

    Returns:
        ``True`` when the device should be offered as a connection choice.
    """
    adv_name = getattr(adv, "local_name", None) or ""
    if adv_name.startswith("MeshCore"):
        return True
    dev_name = getattr(device, "name", None) or ""
    return bool(dev_name.startswith("MeshCore"))


def _normalize_uuid_hex(value: object) -> str:
    """Strip non-hex from a UUID string for comparison."""

    return re.sub(r"[^0-9a-fA-F]", "", str(value)).casefold()


def _adv_has_meshtastic_service_uuid(adv: object) -> bool:
    """Return True when advertisement service UUIDs include the Meshtastic service."""

    want = _normalize_uuid_hex(MESHTASTIC_BLE_SERVICE_UUID)
    if not want:
        return False
    uuids = getattr(adv, "service_uuids", None) or ()
    for raw in uuids:
        if _normalize_uuid_hex(raw) == want:
            return True
    return False


def meshtastic_ble_advertisement_match(device: object, adv: object) -> bool:
    """Return True when the BLE advertisement likely belongs to a Meshtastic node.

    Matches when:

    * The Meshtastic GATT service UUID appears in ``advertisement.service_uuids``
      (works even when the local name is a short/custom label), or
    * The advertised local name or :attr:`BLEDevice.name` contains
      ``meshtastic`` (case insensitive).

    Parameters:
        device: ``bleak`` :class:`~bleak.backends.device.BLEDevice`.
        adv: ``bleak`` :class:`~bleak.backends.scanner.AdvertisementData`.

    Returns:
        ``True`` when the device should be offered as a Meshtastic connection choice.
    """
    if _adv_has_meshtastic_service_uuid(adv):
        return True
    adv_name = (getattr(adv, "local_name", None) or "").casefold()
    dev_name = (getattr(device, "name", None) or "").casefold()
    return "meshtastic" in adv_name or "meshtastic" in dev_name


def _local_serial_path_likely_present(path: str) -> bool:
    """Return False for missing ``/dev/…`` or ``COMn`` device nodes; else True."""

    trimmed = (path or "").strip()
    if not trimmed:
        return False
    if trimmed.startswith("/dev/"):
        try:
            return os.path.exists(trimmed)
        except OSError:
            return False
    upper = trimmed.upper()
    if upper.startswith("COM") and len(trimmed) > 3 and trimmed[3:].isdecimal():
        try:
            return os.path.exists(trimmed)
        except OSError:
            return False
    return True


def ble_scan_timeout_seconds(
    *, env_keys: tuple[str, ...] = ("BLE_SCAN_SECS",)
) -> float:
    """Parse BLE scan duration from :envvar:`BLE_SCAN_SECS` (or *env_keys* for tests).

    Parameters:
        env_keys: Env var names to try in order. Non-numeric values are skipped.

    Returns:
        Non-negative duration in seconds, defaulting to :data:`DEFAULT_BLE_SCAN_SECS`.
    """
    for key in env_keys:
        raw = os.environ.get(key)
        if raw is None:
            continue
        text = raw.strip()
        if not text:
            continue
        try:
            return max(0.0, float(text))
        except ValueError:
            continue
    return DEFAULT_BLE_SCAN_SECS


async def async_ble_candidates(
    timeout: float,
    match_fn: BleMatchFn,
    *,
    context: str,
) -> list[tuple[str, str]]:
    """Scan for BLE devices satisfying *match_fn*.

    Parameters:
        timeout: Seconds to run the BLE scan.
        match_fn: Filter for ``(device, adv)`` pairs.
        context: Log context string for :func:`config._debug_log`.

    Returns:
        Sorted ``(address, menu_label)`` pairs suitable for interactive picking.
    """
    try:
        from bleak import BleakScanner
    except ImportError:
        config._debug_log(
            "BLE scan skipped (bleak not installed)",
            context=context,
            severity="warning",
            always=True,
        )
        return []

    try:
        discovered = await BleakScanner.discover(
            timeout=timeout,
            return_adv=True,
        )
    except Exception as exc:
        config._debug_log(
            "BLE scan failed",
            context=context,
            severity="warning",
            always=True,
            error=str(exc),
        )
        return []

    out: list[tuple[str, str]] = []
    seen: set[str] = set()
    for _key, (device, adv) in discovered.items():
        if not match_fn(device, adv):
            continue
        address = device.address
        if address in seen:
            continue
        seen.add(address)
        local_name = getattr(adv, "local_name", None) or ""
        device_name = getattr(device, "name", None) or ""
        disp = (local_name or device_name or address).strip()
        label = f"BLE  {disp}  ({address})"
        out.append((address, label))
    out.sort(key=lambda item: item[1].casefold())
    return out


def sync_ble_candidates(
    timeout: float,
    match_fn: BleMatchFn,
    *,
    context: str,
    thread_name: str,
) -> list[tuple[str, str]]:
    """Run :func:`async_ble_candidates` on a fresh event loop in a thread."""
    holder: list[list[tuple[str, str]]] = [[]]
    err: list[BaseException | None] = [None]

    def _runner() -> None:
        try:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            try:
                holder[0] = loop.run_until_complete(
                    async_ble_candidates(timeout, match_fn, context=context)
                )
            finally:
                loop.close()
        except BaseException as exc:
            err[0] = exc

    thread = threading.Thread(target=_runner, name=thread_name, daemon=True)
    thread.start()
    thread.join(timeout=max(timeout, 0.0) + 15.0)
    if thread.is_alive():
        config._debug_log(
            "BLE scan thread did not finish in time",
            context=context,
            severity="warning",
            always=True,
        )
        return []
    if err[0] is not None:
        config._debug_log(
            "BLE scan thread raised",
            context=context,
            severity="warning",
            always=True,
            error=str(err[0]),
        )
        return []
    return holder[0]


def gather_connection_choices(
    *,
    include_ble: bool,
    ble_scan_timeout: float,
    ble_match_fn: BleMatchFn,
    ble_context: str,
    ble_thread_name: str,
    require_existing_serial_paths: bool = False,
) -> list[tuple[str, str]]:
    """Build ordered ``(target, label)`` rows for USB serial and optional BLE.

    Parameters:
        require_existing_serial_paths: When ``True``, skip ``/dev/…`` and ``COMn``
            entries that are absent on the filesystem so interactive pickers are
            not reduced to a bogus fallback such as ``/dev/ttyACM0`` on macOS.
    """
    choices: list[tuple[str, str]] = []
    seen: set[str] = set()
    for path in default_serial_targets():
        if path in seen:
            continue
        if require_existing_serial_paths and not _local_serial_path_likely_present(
            path
        ):
            continue
        seen.add(path)
        choices.append((path, f"USB serial  {path}"))
    if include_ble:
        for address, label in sync_ble_candidates(
            ble_scan_timeout,
            ble_match_fn,
            context=ble_context,
            thread_name=ble_thread_name,
        ):
            if address not in seen:
                seen.add(address)
                choices.append((address, label))
    return choices


def interactive_pick_connection_target(
    choices: list[tuple[str, str]],
    *,
    provider_label: str,
    log_context: str,
    refresh_choices: Callable[[], list[tuple[str, str]]] | None = None,
) -> str:
    """Print a menu and return the chosen connection string.

    A single **non-BLE** target (USB path, TCP, etc.) is still auto-selected.
    A single **BLE** MAC/UUID is never auto-selected so a longer scan can surface
    more devices; use a blank line (when *refresh_choices* is set) to scan again.
    """
    while True:
        if len(choices) == 1:
            only = choices[0][0]
            if parse_ble_target(only) is None:
                config._debug_log(
                    f"Auto-selected {provider_label} connection (only candidate)",
                    context=log_context,
                    target=only,
                )
                return only

        if not choices:
            if refresh_choices is None:
                raise ConnectionError(
                    f"No {provider_label} connection targets to choose from."
                )
            print(
                f"\nNo {provider_label} interfaces found. "
                "Press Enter to scan again (or Ctrl+C to abort).\n",
                flush=True,
            )
            input()
            choices = refresh_choices()
            config._debug_log(
                "Refreshed connection candidate list (empty previous scan)",
                context=log_context,
                count=len(choices),
            )
            continue

        print(
            f"\nNo CONNECTION set; select a {provider_label} interface:\n", flush=True
        )
        for i, (_target, label) in enumerate(choices, start=1):
            print(f"  {i}) {label}", flush=True)
        upper = len(choices)
        hint = "blank line = scan again" if refresh_choices else ""
        sep = ", " if hint else ""
        prompt = f"\nEnter choice [1-{upper}]{sep}{hint}: "
        while True:
            raw = input(prompt).strip()
            if not raw:
                if refresh_choices is not None:
                    print("\nScanning for devices…\n", flush=True)
                    choices = refresh_choices()
                    config._debug_log(
                        "Refreshed connection candidate list",
                        context=log_context,
                        count=len(choices),
                    )
                    break
                print("Please enter a number.", flush=True)
                continue
            if not raw.isdigit():
                print("Please enter a number.", flush=True)
                continue
            idx = int(raw, 10)
            if 1 <= idx <= upper:
                picked = choices[idx - 1][0]
                config._debug_log(
                    f"Interactive {provider_label} connection selected",
                    context=log_context,
                    target=picked,
                )
                return picked
            print(f"Choose between 1 and {upper}.", flush=True)


def resolve_connection_target_when_unset(
    *,
    provider_label: str,
    log_context: str,
    ble_match_fn: BleMatchFn,
    ble_context: str,
    ble_thread_name: str,
) -> str:
    """Pick a connection target when *CONNECTION* / *active_candidate* is unset."""
    interactive = sys.stdin.isatty() and sys.stdout.isatty()
    ble_timeout = ble_scan_timeout_seconds()

    choices = gather_connection_choices(
        include_ble=interactive,
        ble_scan_timeout=ble_timeout,
        ble_match_fn=ble_match_fn,
        ble_context=ble_context,
        ble_thread_name=ble_thread_name,
        require_existing_serial_paths=interactive,
    )
    if not choices:
        raise ConnectionError(
            f"No {provider_label} connection targets found "
            "(no present USB/COM serial devices and no matching BLE radios). "
            "Set CONNECTION to a serial device, BLE address, or host:port."
        )
    if not interactive:
        picked = choices[0][0]
        config._debug_log(
            f"{provider_label} auto-connection (non-interactive): using first USB candidate",
            context=log_context,
            target=picked,
        )
        return picked

    def _refresh_choices() -> list[tuple[str, str]]:
        return gather_connection_choices(
            include_ble=True,
            ble_scan_timeout=ble_scan_timeout_seconds(),
            ble_match_fn=ble_match_fn,
            ble_context=ble_context,
            ble_thread_name=ble_thread_name,
            require_existing_serial_paths=True,
        )

    return interactive_pick_connection_target(
        choices,
        provider_label=provider_label,
        log_context=log_context,
        refresh_choices=_refresh_choices,
    )


__all__ = [
    "DEFAULT_BLE_SCAN_SECS",
    "MESHTASTIC_BLE_SERVICE_UUID",
    "BleMatchFn",
    "async_ble_candidates",
    "ble_scan_timeout_seconds",
    "gather_connection_choices",
    "interactive_pick_connection_target",
    "meshcore_ble_advertisement_match",
    "meshtastic_ble_advertisement_match",
    "resolve_connection_target_when_unset",
    "sync_ble_candidates",
]
