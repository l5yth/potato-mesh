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
"""Unit tests for ``data/mesh.sh``, the bare-metal ingestor start script.

Each test runs the real script under ``bash`` in pytest's ``tmp_path``, as
``test_configure_script.py`` does, with stub ``python``, ``.venv/bin/python``
and ``pip`` first on ``PATH``.  Nothing touches the network or a real venv and
no ingestor runs.  Only the lock is real: the stubs hand the script's
``fcntl.flock`` one-liner to the interpreter that runs pytest.

Starts that share one ``.venv`` take turns to build it and run pip (SPEC VL1),
install only when ``requirements.txt`` or the interpreter changed (VL2), and
work in ``data/`` wherever they are started from (VL3).  Every venv mutation
(the venv build, each pip run) logs when it begins and ends, and waits up to
:data:`RENDEZVOUS_S` for the expected number of starts to be inside a mutation
at once.  Without the lock they all arrive within that wait, so an overlap
shows without relying on scheduling luck; with it, each mutation waits alone.
"""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]

SCRIPT = REPO_ROOT / "data" / "mesh.sh"
"""The script under test."""

REQUIREMENTS = REPO_ROOT / "data" / "requirements.txt"
"""The runtime manifest the script installs (SPEC DP3)."""

UNITS = ("meshtastic", "meshcore", "reticulum")
"""One start per ingestor unit, all sharing ``data/.venv`` on one host."""

RENDEZVOUS_S = 1
"""Longest time a stub mutation waits for the other starts to join it.

Unlocked starts join within milliseconds; a locked mutation waits it out alone,
so it bounds the run time of the parallel tests, not their verdict.
"""

_KNOBS = {
    "NO_PYTHON": "0",
    "PIP_FAIL": "0",
    "PIP_KILL": "0",
    "INGESTOR_S": "0",
    "PY_VERSION": "3.14.7",
}
"""Stub settings of a start, each overridable per start (:meth:`Host.env`)."""

_LIB = r"""
# log EVENT...: append "UNIT EVENT..." to the event log.  One printf to the
# O_APPEND log is one write, so the line order is the order of the events,
# across parallel starts too.
log() { printf '%s %s\n' "$UNIT" "$*" >>"$SHARED/events.log"; }

# enter KEY: mark this process as inside a venv mutation and log it.
enter() {
    mkdir -p "$SHARED/inside"
    : >"$SHARED/inside/$$"
    log ENTER "$1"
}

# rendezvous KEY HOLD_S: wait until EXPECT processes are inside a mutation at
# once or RENDEZVOUS_S seconds pass, hold HOLD_S seconds, then unmark.  The
# first waiter to count EXPECT sets a latch for KEY, so every waiter leaves.
rendezvous() {
    local latch tries inside
    latch="$SHARED/latch.$(printf '%s' "$1" | tr -c 'A-Za-z0-9' '_')"
    for ((tries = RENDEZVOUS_S * 50; tries > 0; tries--)); do
        inside=("$SHARED"/inside/*)
        [ "${#inside[@]}" -ge "$EXPECT" ] && : >"$latch"
        [ -e "$latch" ] && break
        sleep 0.02
    done
    sleep "$2"
    rm -f "$SHARED/inside/$$"
}
"""
"""Shell helpers shared by the stubs."""

_PYTHON = r"""#!/usr/bin/env bash
# Stub system python.  NO_PYTHON=1 makes it a host without one (stock Debian
# ships only python3).  `-c` runs the real interpreter (the flock one-liner).
# `-m venv [--clear] DIR` empties DIR first under --clear, as CPython does, then
# lays out DIR/bin/python.
set -u
. "$STUBS/lib.sh"
if [ "$NO_PYTHON" = 1 ]; then echo "python: command not found" >&2; exit 127; fi
if [ "${1:-}" = -c ]; then exec "$REAL_PYTHON" "$@"; fi
if [ "${1:-}" = -m ] && [ "${2:-}" = venv ]; then
    dir="${!#}"
    enter venv
    case " $* " in
        *" --clear "*) [ -d "$dir" ] && find "$dir" -mindepth 1 -maxdepth 1 -exec rm -rf {} + ;;
    esac
    log CLEARED
    rendezvous venv 0.2
    mkdir -p "$dir/bin"
    cp "$STUBS/venv-python" "$dir/bin/python"
    chmod +x "$dir/bin/python"
    log LEAVE 0
    exit 0
fi
exit 99
"""
"""Stub for the ``python`` on ``PATH`` that builds the venv."""

_VENV_PYTHON = r"""#!/usr/bin/env bash
# Stub .venv/bin/python.  `-c` runs the flock one-liner on the real interpreter,
# only under -I -S (the lock loads nothing from site-packages, VL1), prints
# PY_VERSION for sys.version, and as the prefix probe fails while .venv/BROKEN
# exists.  `-m pip` runs the stub pip.  `-u mesh.py` fails unless mesh.py is in
# the working directory, else logs EXEC and sleeps INGESTOR_S seconds in place
# of the ingestor.
set -u
. "$STUBS/lib.sh"
flags=()
while [ "${1:-}" = -I ] || [ "${1:-}" = -S ]; do flags+=("$1"); shift; done
case "${1:-}" in
    -c)
        case "${2:-}" in
            *fcntl*)
                [ "${flags[*]:-}" = "-I -S" ] || exit 1
                exec "$REAL_PYTHON" "${flags[@]}" "$@" ;;
            *sys.version*) echo "$PY_VERSION"; exit 0 ;;
        esac
        [ -e "$(dirname "$0")/../BROKEN" ] && exit 1
        exit 0 ;;
    -m) shift 2; exec pip "$@" ;;
    -u)
        [ -f "${2:-}" ] || { echo "can't open file '$PWD/${2:-}'" >&2; exit 2; }
        log EXEC
        exec sleep "$INGESTOR_S" ;;
esac
exit 99
"""
"""Stub for ``.venv/bin/python``, copied in by the stub ``python -m venv``."""

_PIP = r"""#!/usr/bin/env bash
# Stub pip: installs nothing.  `-r FILE` must name an existing file.  Each call
# is one venv mutation; PIP_FAIL=1 fails it, PIP_FAIL=-r fails only the
# `install -r` run, PIP_KILL=1 kills the script that ran it with SIGKILL.
set -u
. "$STUBS/lib.sh"
prev=
for arg in "$@"; do
    if [ "$prev" = -r ] && [ ! -f "$arg" ]; then
        echo "ERROR: Could not open requirements file: $arg" >&2
        exit 1
    fi
    prev="$arg"
done
enter "pip $*"
rendezvous "pip $*" 0.2
if [ "$PIP_KILL" = 1 ]; then log LEAVE killed; kill -9 "$PPID"; exit 1; fi
if [ "$PIP_FAIL" = 1 ]; then log LEAVE 1; exit 1; fi
if [ "$PIP_FAIL" = -r ] && [ "${2:-}" = -r ]; then log LEAVE 1; exit 1; fi
log LEAVE 0
"""
"""Stub pip."""


class Host:
    """A temporary checkout: ``data/`` with the script, stub interpreters, a log."""

    def __init__(self, root: Path) -> None:
        """Lay out ``data/``, the stubs and the shared log dir under *root*.

        Parameters:
            root: Empty directory, normally pytest's ``tmp_path``.
        """
        self.root = root
        self.data = root / "data"
        self.stubs = root / "stubs"
        self.shared = root / "shared"
        self.procs: list[subprocess.Popen] = []
        for path in (self.data, self.stubs, self.shared):
            path.mkdir()
        (self.data / "mesh.sh").write_bytes(SCRIPT.read_bytes())
        (self.data / "requirements.txt").write_bytes(REQUIREMENTS.read_bytes())
        (self.data / "mesh.py").write_text("", encoding="utf-8")
        (self.stubs / "lib.sh").write_text(_LIB, encoding="utf-8")
        for name, text in (
            ("python", _PYTHON),
            ("venv-python", _VENV_PYTHON),
            ("pip", _PIP),
        ):
            stub = self.stubs / name
            stub.write_text(text, encoding="utf-8")
            stub.chmod(0o755)
        self.reset()

    def reset(self) -> None:
        """Empty the event log and drop the rendezvous latches."""
        (self.shared / "events.log").write_text("", encoding="utf-8")
        for latch in self.shared.glob("latch.*"):
            latch.unlink()

    def env(self, unit: str, expect: int = 1, **extra: str) -> dict[str, str]:
        """Return the environment of one start.

        Parameters:
            unit: Name written to every log line of the start.
            expect: Mutations a stub waits for before it proceeds.
            extra: Overrides of :data:`_KNOBS` (``PIP_FAIL``, ``PY_VERSION``...)
                and other variables (``CDPATH``).

        Returns:
            The full environment, stubs first on ``PATH``.
        """
        return {
            **os.environ,
            "PATH": f"{self.stubs}{os.pathsep}{os.environ['PATH']}",
            "STUBS": str(self.stubs),
            "SHARED": str(self.shared),
            "REAL_PYTHON": sys.executable,
            "RENDEZVOUS_S": str(RENDEZVOUS_S),
            "EXPECT": str(expect),
            "UNIT": unit,
            **_KNOBS,
            **extra,
        }

    def build_venv(self) -> None:
        """Create ``data/.venv`` as an operator would, then :meth:`reset`."""
        subprocess.run(
            [str(self.stubs / "python"), "-m", "venv", ".venv"],
            cwd=self.data,
            env=self.env("setup"),
            check=True,
        )
        self.reset()

    def start(
        self, unit: str, expect: int = 1, *, from_root: str = "", **extra: str
    ) -> subprocess.Popen:
        """Start the script as *unit* and return the process.

        Parameters:
            unit: Name written to every log line of the start.
            expect: Mutations a stub waits for before it proceeds.
            from_root: The script's path to run from the checkout root
                (``./data/mesh.sh``); empty runs ``./mesh.sh`` from ``data/``.
            extra: Overrides of :data:`_KNOBS` and other variables.

        Returns:
            The running ``bash`` process, with text stdout and stderr piped.
        """
        proc = subprocess.Popen(
            ["bash", from_root or "./mesh.sh"],
            cwd=self.root if from_root else self.data,
            env=self.env(unit, expect, **extra),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        self.procs.append(proc)
        return proc

    def run(self, unit: str = "meshtastic", **options) -> int:
        """Run one start to completion and return its exit status.

        Parameters:
            unit: Name written to every log line of the start.
            options: Keyword arguments of :meth:`start`.

        Returns:
            The exit status, negative for a signal.
        """
        proc = self.start(unit, **options)
        proc.communicate(timeout=60)
        return proc.returncode

    def events(self) -> list[tuple[str, str]]:
        """Return ``(unit, event)`` for every logged event, in order."""
        text = (self.shared / "events.log").read_text(encoding="utf-8")
        return [tuple(line.split(" ", 1)) for line in text.splitlines()]

    def installs(self) -> int:
        """Return how many pip runs have started."""
        return sum(event.startswith("ENTER pip ") for _, event in self.events())

    def builds(self) -> int:
        """Return how many venv builds have started."""
        return sum(event == "ENTER venv" for _, event in self.events())

    def max_overlap(self) -> int:
        """Return the most venv mutations that were in progress at once."""
        open_now = peak = 0
        for _, event in self.events():
            if event.startswith("ENTER "):
                open_now += 1
                peak = max(peak, open_now)
            elif event.startswith("LEAVE "):
                open_now -= 1
        return peak

    def execs(self) -> list[str]:
        """Return the units that reached the ingestor ``exec``, sorted."""
        return sorted(unit for unit, event in self.events() if event == "EXEC")

    def wait_for(self, unit: str, event: str, timeout: float = 10.0) -> bool:
        """Poll the log until *unit* logs *event*.

        Parameters:
            unit: The start to watch.
            event: The event to wait for.
            timeout: Seconds to wait.

        Returns:
            Whether the event was logged in time.
        """
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if (unit, event) in self.events():
                return True
            time.sleep(0.05)
        return False

    def stop(self) -> None:
        """Kill every start that is still running and reap it."""
        for proc in self.procs:
            if proc.poll() is None:
                proc.kill()
            proc.communicate(timeout=30)


@pytest.fixture
def fresh(tmp_path: Path):
    """Yield a :class:`Host` with no ``.venv`` yet, as on a first install.

    Parameters:
        tmp_path: pytest's per-test directory.

    Yields:
        The host; every start still running at teardown is killed.
    """
    built = Host(tmp_path)
    yield built
    built.stop()


@pytest.fixture
def host(fresh: Host) -> Host:
    """Return a :class:`Host` whose ``.venv`` exists, as on a running host.

    Parameters:
        fresh: The host to build the venv in.

    Returns:
        The host, its event log empty.
    """
    fresh.build_venv()
    return fresh


def test_parallel_starts_install_one_at_a_time(host):
    """Three units starting at once never run two installs together (VL1)."""
    procs = [host.start(unit, expect=len(UNITS)) for unit in UNITS]
    for proc in procs:
        proc.communicate(timeout=120)
    assert host.max_overlap() == 1
    assert [proc.returncode for proc in procs] == [0, 0, 0]
    assert host.execs() == sorted(UNITS)


def test_first_starts_build_the_venv_once(fresh):
    """Three units starting with no ``.venv`` build it once, one at a time (VL1)."""
    procs = [fresh.start(unit, expect=len(UNITS)) for unit in UNITS]
    for proc in procs:
        proc.communicate(timeout=120)
    assert (fresh.max_overlap(), fresh.builds()) == (1, 1)
    assert fresh.execs() == sorted(UNITS)


def test_rebuild_of_a_broken_venv_keeps_later_starts_out(host):
    """Starts that arrive while one rebuilds the venv wait for it (VL1)."""
    (host.data / ".venv" / "BROKEN").write_text("", encoding="utf-8")
    first = host.start(UNITS[0], expect=len(UNITS))
    assert host.wait_for(UNITS[0], "CLEARED")
    later = [host.start(unit, expect=len(UNITS)) for unit in UNITS[1:]]
    for proc in (first, *later):
        proc.communicate(timeout=120)
    assert host.max_overlap() == 1
    assert host.execs() == sorted(UNITS)


def test_lock_is_released_before_the_ingestor_starts(host):
    """A running ingestor does not keep the next start waiting (VL1)."""
    host.start("meshtastic", INGESTOR_S="8")
    assert host.wait_for("meshtastic", "EXEC")
    host.start("meshcore")
    assert host.wait_for("meshcore", "EXEC", timeout=5)


def test_killed_install_leaves_no_stale_lock(host):
    """A start killed mid-install does not block the next one (VL1)."""
    assert host.run("meshtastic", PIP_KILL="1") == -signal.SIGKILL
    assert host.execs() == []
    host.start("meshcore")
    assert host.wait_for("meshcore", "EXEC", timeout=10)


def test_a_host_without_python_starts_from_its_venv(host):
    """Once ``.venv`` exists no start calls ``python``, which Debian lacks (VL1)."""
    assert [host.run(NO_PYTHON="1") for _ in range(2)] == [0, 0]
    assert host.execs() == ["meshtastic", "meshtastic"]


def test_first_start_without_python_stops_before_any_change(fresh):
    """With no ``.venv`` and no ``python`` a start exits 127 and says why (VL1)."""
    proc = fresh.start("meshtastic", NO_PYTHON="1")
    _, err = proc.communicate(timeout=60)
    assert (proc.returncode, fresh.builds(), fresh.installs()) == (127, 0, 0)
    assert "python: command not found" in err


def test_restart_with_unchanged_requirements_skips_pip(host):
    """A second start with the same requirements.txt runs no pip (VL2)."""
    assert host.run() == 0
    before = host.installs()
    assert host.run() == 0
    assert (before, host.installs() - before) == (2, 0)


def test_changed_requirements_reinstall(host):
    """An edited requirements.txt is installed on the next start (VL2)."""
    assert host.run() == 0
    before = host.installs()
    with (host.data / "requirements.txt").open("a", encoding="utf-8") as fh:
        fh.write("# changed\n")
    assert host.run() == 0
    assert host.installs() - before == 2


def test_changed_interpreter_reinstalls(host):
    """A new interpreter version installs into its own site-packages (VL2)."""
    assert host.run(PY_VERSION="3.14.7") == 0
    before = host.installs()
    assert host.run(PY_VERSION="3.15.0") == 0
    assert host.installs() - before == 2


@pytest.mark.parametrize("failing", ["1", "-r"], ids=["pip-upgrade", "requirements"])
def test_failed_install_is_retried_on_next_start(host, failing):
    """A failed pip run, the first or the second, stops the start and both run
    again next time: the stamp is written after both succeed (VL2)."""
    assert host.run(PIP_FAIL=failing) == 1
    assert host.execs() == []
    before = host.installs()
    assert host.run() == 0
    assert host.installs() - before == 2


def test_rebuilt_venv_installs_again(host):
    """A venv rebuilt over a broken one installs again: the stamp is in it (VL2)."""
    assert host.run() == 0
    (host.data / ".venv" / "BROKEN").write_text("", encoding="utf-8")
    before = (host.builds(), host.installs())
    assert host.run() == 0
    assert (host.builds() - before[0], host.installs() - before[1]) == (1, 2)


@pytest.mark.parametrize("script", ["./data/mesh.sh", "data/mesh.sh"])
def test_start_from_the_checkout_root_works_in_data(host, script):
    """A start from the checkout root (README: ``./data/mesh.sh``) runs in
    ``data/``, also with an exported ``CDPATH`` that holds a ``data/`` (VL3)."""
    decoy = host.shared / "decoy"
    (decoy / "data").mkdir(parents=True)
    status = host.run(from_root=script, CDPATH=str(decoy))
    assert (status, host.execs()) == (0, ["meshtastic"])
    assert sorted(path.name for path in host.root.iterdir()) == [
        "data",
        "shared",
        "stubs",
    ]
    assert (host.data / ".venv.lock").is_file()
    assert list((decoy / "data").iterdir()) == []
