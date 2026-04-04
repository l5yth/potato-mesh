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

"""Interactive CLI to write a mesh ingestor ``.env`` file (path optional on the command line)."""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

from . import env_file, meshcore_probe, meshtastic_probe, tui
from .connection_parse import connection_kind
from .devices import list_serial_paths, scan_ble_devices

# Matches local `cd web && ./app.sh` / README examples (Sinatra default port).
_LOCAL_INSTANCE_DOMAIN = "http://127.0.0.1:41447"
_LOCAL_INSTANCE_NORMALIZED = frozenset(
    {
        "http://127.0.0.1:41447",
        "http://localhost:41447",
    }
)


def _normalized_instance_url(value: str) -> str:
    return (value or "").strip().rstrip("/").lower()


def _instance_domain_prefers_local_default(existing_domain: str) -> bool:
    """True when *existing_domain* is empty or already the usual local dev URL."""

    n = _normalized_instance_url(existing_domain)
    if not n:
        return True
    return n in _LOCAL_INSTANCE_NORMALIZED


def _default_env_path() -> Path:
    """``<repository-root>/.env`` (``mesh_env/__main__.py`` → parents[2] is repo root)."""

    return (Path(__file__).resolve().parents[2] / ".env").resolve()


def _parse_env_file_arg(argv: list[str] | None) -> Path:
    """Parse optional ``PATH`` positional; default :func:`_default_env_path`."""

    parser = argparse.ArgumentParser(
        description="Interactive wizard to write a potato-mesh ingestor .env file.",
    )
    parser.add_argument(
        "env_file",
        nargs="?",
        default=None,
        metavar="PATH",
        help="Env file to read/write (default: <repository>/.env)",
    )
    ns = parser.parse_args(argv)
    raw = (ns.env_file or "").strip()
    if not raw:
        return _default_env_path()
    return Path(raw).expanduser().resolve()


def _profile_label_from_env_path(path: Path) -> str | None:
    """Return the profile segment for ``.env-<profile>`` filenames; ``None`` for default ``.env``."""

    name = path.name
    prefix = ".env-"
    if not name.startswith(prefix):
        return None
    rest = name[len(prefix) :].strip()
    return rest or None


def _csv_casefold_frozen(raw: str) -> frozenset[str]:
    return frozenset(p.casefold() for p in (x.strip() for x in raw.split(",")) if p)


_HINT_BLE_ADDR = "Use the address your OS shows for the radio (MAC or UUID)."
_HINT_SERIAL_PATH = (
    "Path to the USB serial device (Linux often /dev/ttyACM0 or ttyUSB0)."
)


def _prompt_ble_address(message: str, existing: str) -> str:
    return tui.text(message, existing, hint=_HINT_BLE_ADDR)


def _prompt_serial_path(message: str, default: str) -> str:
    return tui.text(message, default, hint=_HINT_SERIAL_PATH)


def _pick_connection_string(existing: str) -> str:
    kind = tui.select(
        "How should the ingestor connect to the radio?",
        [
            ("Serial USB", "serial"),
            ("Bluetooth (BLE)", "ble"),
            ("TCP (host:port or [IPv6]:port)", "tcp"),
        ],
        default_value=connection_kind(existing),
        hint=(
            "Serial is a direct USB device. BLE uses a short scan to list nearby radios. "
            "TCP targets an IP host:port (tunnel, proxy, or meshtasticd)."
        ),
    )
    if kind == "ble":
        tui.print_info("\nScanning for BLE devices (8s)…")
        try:
            found = asyncio.run(scan_ble_devices(8.0))
        except Exception as exc:
            tui.print_info(f"Bleak scan failed: {exc}")
            return _prompt_ble_address("Enter BLE MAC or UUID", existing)
        if not found:
            tui.print_info("No devices found.")
            return _prompt_ble_address("Enter BLE MAC or UUID", existing)
        choices: list[tuple[str, str]] = [
            (f"{name}  ({addr})", addr) for name, addr in found
        ]
        choices.append(("Type address manually…", "__manual__"))
        default_ble = found[0][1]
        exn = existing.strip()
        if exn:
            for _name, addr in found:
                if addr.upper() == exn.upper() or addr == exn:
                    default_ble = addr
                    break
        pick = tui.select(
            "Choose a BLE device:",
            choices,
            default_value=default_ble,
            hint="Pick your radio from the scan, or type an address if it is missing.",
        )
        if pick == "__manual__" or pick is None:
            return _prompt_ble_address("BLE MAC or UUID", existing)
        return pick
    if kind == "tcp":
        return tui.text(
            "TCP target (e.g. 192.168.1.5:4403 or mesh.local:4403)",
            existing,
            hint="Host and port where the radio or bridge accepts a TCP connection (often :4403).",
        )

    paths = list_serial_paths()
    if not paths:
        return _prompt_serial_path("Serial device path", existing or "/dev/ttyACM0")
    choices = [(p, p) for p in paths]
    choices.append(("Other… type a custom path", "__custom__"))
    default_val = existing if existing in paths else paths[0]
    pick = tui.select(
        "Choose a serial device:",
        choices,
        default_value=default_val,
        hint="Choose the port your radio appears as, or type another path if needed.",
    )
    if pick == "__custom__" or pick is None:
        return _prompt_serial_path("Serial device path", existing or paths[0])
    return pick


def _channel_filter_value(
    rows: list[tuple[int, str]],
    label_short: str,
    *,
    all_label: str,
    existing: str,
    field_hint: str,
) -> str:
    """Build ``ALLOWED_CHANNELS`` or ``HIDDEN_CHANNELS`` (comma-separated names).

    *field_hint* is dim explanatory text for what this env var does in the ingestor.
    """

    if not rows:
        return tui.text(
            f"{label_short} — comma-separated channel names (leave empty for no filter)",
            existing,
            hint=field_hint,
        )

    ex_stripped = existing.strip()
    if not ex_stripped:
        mode_default = "all"
    else:
        parts = [x.strip() for x in existing.split(",") if x.strip()]
        row_names_cf = {name.casefold() for _, name in rows}
        mode_default = (
            "pick"
            if parts and all(p.casefold() in row_names_cf for p in parts)
            else "type"
        )

    mode = tui.select(
        f"Configure {label_short}",
        [
            (all_label, "all"),
            ("Pick from discovered channels (checkboxes)", "pick"),
            ("Type comma-separated names", "type"),
        ],
        default_value=mode_default,
        hint=field_hint,
    )
    if mode == "type" or mode is None:
        return tui.text(
            "Comma-separated channel names",
            existing,
            hint="Names are matched case-insensitively against what the radio reports.",
        )
    if mode == "all":
        return ""

    choices: list[tuple[str, str]] = []
    for idx, name in rows:
        title = f"LoRa index {idx} — {name}"
        choices.append((title, name))
    picked = tui.checkbox(
        "Toggle channels with ↑/↓ and Space; Enter confirms.",
        choices,
        prechecked_values=_csv_casefold_frozen(existing),
        hint=(
            "Leaving none checked clears this filter (same as choosing allow-all / hide-none above)."
        ),
    )
    if not picked:
        return ""
    # Preserve stable order by first appearance in *rows*
    order = [name for _, name in rows]
    seen: set[str] = set()
    ordered: list[str] = []
    for n in order:
        if n in picked and n not in seen:
            ordered.append(n)
            seen.add(n)
    for n in picked:
        if n not in seen:
            ordered.append(n)
            seen.add(n)
    return ",".join(ordered)


def main(argv: list[str] | None = None) -> int:
    path = _parse_env_file_arg(sys.argv[1:] if argv is None else argv)
    tui.show_welcome(
        path,
        profile_name=_profile_label_from_env_path(path),
        is_new_file=not path.is_file(),
    )

    existing = env_file.load_managed_from_file(path)
    parsed_env = (
        env_file.parse_env_lines(path.read_text(encoding="utf-8", errors="replace"))
        if path.is_file()
        else {}
    )

    total_steps = 7
    step_i = 0

    def step(title: str) -> None:
        nonlocal step_i
        step_i += 1
        tui.step_header(step_i, total_steps, title)

    step("Backend provider")
    prov_default = existing.get("PROVIDER", "meshtastic")
    if prov_default not in ("meshtastic", "meshcore"):
        prov_default = "meshtastic"
    provider = tui.select(
        "Backend provider",
        [
            ("Meshtastic", "meshtastic"),
            ("MeshCore", "meshcore"),
        ],
        default_value=prov_default,
        hint="Which firmware stack the ingestor speaks: Meshtastic is the common default; MeshCore uses the other backend.",
    )
    if provider not in ("meshtastic", "meshcore") or provider is None:
        tui.print_error("Invalid provider.")
        return 1

    step("Connection")
    conn_default = existing.get("CONNECTION", "")
    conn_mode = tui.select(
        "How do you want to set CONNECTION (where the ingestor reaches the radio)?",
        [
            (
                "Guided — choose serial port, BLE device after scan, or enter TCP host:port",
                "guided",
            ),
            (
                "Manual — paste or type the full CONNECTION string (e.g. /dev/ttyACM0, "
                "BLE MAC/UUID, or host:port)",
                "manual",
            ),
        ],
        default_value=("manual" if conn_default.strip() else "guided"),
        hint="CONNECTION is the ingestor’s link to the radio: device path, BLE address, or TCP host:port.",
    )
    if conn_mode == "manual":
        connection = tui.text(
            "CONNECTION",
            conn_default,
            hint="Paste the same value you would set in `.env`: serial path, BLE MAC/UUID, or host:port.",
        )
    else:
        # "guided", None (e.g. cancelled select), or unknown → use menus
        connection = _pick_connection_string(conn_default)
    if not connection:
        tui.print_error("CONNECTION is required.")
        return 1

    step("Channel discovery")
    rows: list[tuple[int, str]] = []
    probe_note: str | None = None
    tui.print_info(
        "Connecting briefly to read channel names from the radio (skips ahead if unavailable)…"
    )
    if provider == "meshtastic":
        fb = parsed_env.get("CHANNEL", "").strip() or None
        rows, err = meshtastic_probe.probe_channels(connection, channel_fallback=fb)
        probe_note = err
    else:
        rows, err = meshcore_probe.probe_channels(connection)
        probe_note = err
    if probe_note:
        tui.print_dim(f"Channel probe: {probe_note}")
    if rows:
        tui.print_info(f"Discovered {len(rows)} channel(s).")
    else:
        tui.print_dim(
            "No channel names from probe (you can still set allow/hide filters manually)."
        )

    step("Allow / hide channels by name")
    allowed = _channel_filter_value(
        rows,
        "ALLOWED_CHANNELS",
        all_label="Allow all channels (recommended unless you need a strict allowlist)",
        existing=existing.get("ALLOWED_CHANNELS", ""),
        field_hint=(
            "If set, only traffic on these channel names is ingested; leave empty to allow every channel."
        ),
    )
    hidden = _channel_filter_value(
        rows,
        "HIDDEN_CHANNELS",
        all_label="Do not hide any channel by name",
        existing=existing.get("HIDDEN_CHANNELS", ""),
        field_hint="Traffic on these channel names is dropped; leave empty to hide nothing by name.",
    )

    if provider == "meshcore" and allowed.strip():
        tui.print_warning(
            "MeshCore packets often lack Meshtastic-style channel names in the ingestor; "
            "a non-empty ALLOWED_CHANNELS can drop traffic until names match runtime metadata. "
            "Prefer “allow all” unless you have verified behavior."
        )

    step("Instance URL & API token")
    existing_inst = existing.get("INSTANCE_DOMAIN", "")
    inst_mode = tui.select(
        "INSTANCE_DOMAIN — where is your PotatoMesh web UI?",
        [
            (f"Local default ({_LOCAL_INSTANCE_DOMAIN})", "local"),
            ("Remote or custom URL", "custom"),
        ],
        default_value=(
            "local"
            if _instance_domain_prefers_local_default(existing_inst)
            else "custom"
        ),
        hint="The ingestor POSTs decoded mesh events to this PotatoMesh server (same URL you open in a browser).",
    )
    if inst_mode == "local":
        instance = _LOCAL_INSTANCE_DOMAIN
    else:
        instance = tui.text(
            "INSTANCE_DOMAIN (full URL or hostname; https:// added if no scheme)",
            existing_inst,
            hint="Use a full URL when in doubt; a bare hostname gets https:// prepended by the ingestor.",
        )
    token = tui.text(
        "API_TOKEN",
        existing.get("API_TOKEN", ""),
        hint="Shared secret required on ingest HTTP requests; must match API_TOKEN on the web server.",
    )

    step("Debug & energy saving")
    debug = (
        "1"
        if tui.confirm(
            "Enable DEBUG=1?",
            existing.get("DEBUG", "0") == "1",
            hint="Extra ingestor logging and debug-only file traces; useful for troubleshooting, noisy otherwise.",
        )
        else "0"
    )
    energy = (
        "1"
        if tui.confirm(
            "Enable ENERGY_SAVING=1?",
            existing.get("ENERGY_SAVING", "0") == "1",
            hint="Disconnects and sleeps on a schedule to cut CPU/BLE use; may miss brief traffic between wakeups.",
        )
        else "0"
    )

    merged: dict[str, str] = {
        "PROVIDER": provider,
        "CONNECTION": connection,
        "ALLOWED_CHANNELS": allowed,
        "HIDDEN_CHANNELS": hidden,
        "INSTANCE_DOMAIN": instance,
        "API_TOKEN": token,
        "DEBUG": debug,
        "ENERGY_SAVING": energy,
    }

    step("Write .env file")
    if not tui.confirm(
        f"Write configuration to {path}?",
        True,
        hint="Only wizard-managed keys are updated; other lines in the file stay unchanged.",
    ):
        tui.print_aborted()
        return 0

    env_file.merge_write_env(path, merged)
    tui.print_saved(path, connection_kind(connection))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        tui.print_cancelled()
        raise SystemExit(130) from None
