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

"""Interactive resolution when :envvar:`CONNECTION` is ``ask``."""

from __future__ import annotations

import os
from typing import IO, TextIO

from .provider import Provider

_DEFAULT_BLE_SCAN_SECS = 8.0
"""Default BLE scan duration for ``CONNECTION=ask`` when env is unset."""


def connection_is_ask(value: str | None) -> bool:
    """Return ``True`` when *value* selects interactive device picking."""

    if value is None:
        return False
    return value.strip().casefold() == "ask"


def _ble_scan_secs_from_env() -> float:
    raw = os.environ.get("ASK_BLE_SCAN_SECS", "").strip()
    if not raw:
        return _DEFAULT_BLE_SCAN_SECS
    try:
        parsed = float(raw)
    except ValueError:
        return _DEFAULT_BLE_SCAN_SECS
    return max(0.5, min(parsed, 120.0))


def _read_nonempty_line(stream: TextIO) -> str:
    while True:
        line = stream.readline()
        if line == "":
            raise SystemExit("EOF while reading connection choice; exiting.")
        stripped = line.strip()
        if stripped:
            return stripped


def _prompt_manual_target(stdin: TextIO, stdout: TextIO) -> str:
    stdout.write("Enter connection target (serial path, BLE MAC/UUID, or host:port): ")
    stdout.flush()
    return _read_nonempty_line(stdin)


def resolve_connection_ask(
    provider: Provider,
    *,
    stdin: IO[str],
    stdout: IO[str],
    ble_scan_timeout_secs: float | None = None,
) -> str:
    """List provider candidates, prompt the user, return a connection string.

    Parameters:
        provider: Active ingestor provider.
        stdin: Input stream (must be a TTY for interactive use).
        stdout: Output stream for the menu.
        ble_scan_timeout_secs: Overrides :envvar:`ASK_BLE_SCAN_SECS` when set.

    Returns:
        A non-empty connection string suitable for :data:`~config.CONNECTION`.

    Raises:
        SystemExit: When *stdin* is not a TTY or input ends unexpectedly.
    """

    if not stdin.isatty():
        raise SystemExit(
            "CONNECTION=ask requires an interactive terminal (TTY). "
            "Set CONNECTION to a serial path, BLE address, or TCP target."
        )

    timeout = (
        ble_scan_timeout_secs
        if ble_scan_timeout_secs is not None
        else _ble_scan_secs_from_env()
    )
    candidates = provider.list_connection_candidates(ble_scan_timeout_secs=timeout)

    if not candidates:
        stdout.write(
            f"No {provider.name!r} devices found automatically.\n"
            "You can still enter a target manually.\n"
        )
        stdout.flush()
        return _prompt_manual_target(stdin, stdout)

    stdout.write(f"Select connection for provider {provider.name!r}:\n")
    stdout.write("  0) Enter connection manually\n")
    for index, cand in enumerate(candidates, start=1):
        stdout.write(f"  {index}) [{cand.kind}] {cand.label}\n")
    stdout.write(f"Enter choice [0-{len(candidates)}]: ")
    stdout.flush()

    choice = _read_nonempty_line(stdin)
    if choice == "0":
        return _prompt_manual_target(stdin, stdout)

    try:
        num = int(choice, 10)
    except ValueError:
        raise SystemExit(f"Invalid choice {choice!r}; expected a number.")

    if num < 1 or num > len(candidates):
        raise SystemExit(f"Choice {num} out of range; expected 0-{len(candidates)}.")

    return candidates[num - 1].target


def scan_connection(
    provider: Provider,
    *,
    stdin: IO[str] | None = None,
    stdout: IO[str] | None = None,
    ble_scan_timeout_secs: float | None = None,
) -> str:
    """Resolve ``CONNECTION=ask`` using the given provider (public alias).

    This is a thin wrapper around :func:`resolve_connection_ask` that defaults
    ``stdin`` / ``stdout`` to standard streams.
    """

    import sys

    in_stream = stdin if stdin is not None else sys.stdin
    out_stream = stdout if stdout is not None else sys.stdout
    return resolve_connection_ask(
        provider,
        stdin=in_stream,
        stdout=out_stream,
        ble_scan_timeout_secs=ble_scan_timeout_secs,
    )


__all__ = [
    "connection_is_ask",
    "resolve_connection_ask",
    "scan_connection",
]
