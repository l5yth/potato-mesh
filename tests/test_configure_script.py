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
"""Unit tests for ``configure.sh``, the Docker Compose setup script.

Each test runs the real script under ``bash`` in pytest's ``tmp_path`` with its
answers piped on stdin, then asserts on the Compose env file it writes there
and on the lines it echoes.  ``read -p`` prints no prompt without a terminal,
so the answers are one line per prompt, in the order the script asks.

Under ``PROTOCOL=reticulum`` the script asks for ``INGESTOR_NODE_ID``, which
Docker needs (SPEC RE8), and states the RNode default of
``RETICULUM_INTERFACES`` (SPEC RN4, amended).
"""

from __future__ import annotations

import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]

SCRIPT = REPO_ROOT / "configure.sh"
"""The script under test."""

ENV_FILE = ".env"
"""The Compose env file the script writes in its working directory."""

TOKEN = "f" * 64
"""A seeded API token, so the script keeps it rather than generating one."""

NODE_ID = "!27716218"
"""A canonical ``!xxxxxxxx`` node id."""

IDENTITY_HASH = "27716218762CFD2864141EF286C39940"
"""A full 32-hex identity hash, upper-cased to cover the ``A-F`` range."""

RETRY = "Not a valid node id"
"""Start of the line the script prints before asking for the node id again."""

_SITE = [""] * 5
"""Instance domain, site name, map centre, map zoom, max distance: defaults."""

_SHARED = [""] * 8
"""Chat link, debug, federation, private mode, allowed and hidden channels,
image architecture and image tag: defaults."""


def _reticulum(*node_id_answers: str, interfaces: str = "") -> list[str]:
    """Return the answers for a ``reticulum`` run.

    Parameters:
        node_id_answers: Each answer to the node id prompt, retries included.
        interfaces: Answer to the interfaces prompt.

    Returns:
        One answer per prompt: the RNS config dir, the node id attempts, the
        interfaces, frequency, preset, transmit and keep-token prompts follow
        the protocol and shared sections.
    """
    return [
        *_SITE,
        "reticulum",
        *_SHARED,
        "",
        *node_id_answers,
        interfaces,
        "",
        "",
        "",
        "",
    ]


def _meshtastic() -> list[str]:
    """Return the answers for a ``meshtastic`` run: every prompt at its default.

    Returns:
        Protocol, preset, frequency, the shared section, connection target,
        transmit and keep-token answers.
    """
    return [*_SITE, "meshtastic", "", "", *_SHARED, "", "", ""]


def _run(
    tmp_path: Path, answers: list[str], **seed: str
) -> subprocess.CompletedProcess:
    """Seed the env file and run ``configure.sh`` in *tmp_path*.

    Parameters:
        tmp_path: Working directory for the run.
        answers: One line per prompt.
        seed: ``KEY=VALUE`` pairs written (quoted) before the run.

    Returns:
        The finished process, with text stdout and stderr.
    """
    lines = [f"API_TOKEN={TOKEN}", *(f'{key}="{value}"' for key, value in seed.items())]
    (tmp_path / ENV_FILE).write_text("\n".join(lines) + "\n", encoding="utf-8")
    return subprocess.run(
        ["bash", str(SCRIPT)],
        cwd=tmp_path,
        input="\n".join(answers) + "\n",
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )


def _configure(tmp_path: Path, answers: list[str], **seed: str) -> tuple[str, dict]:
    """Run ``configure.sh`` to completion and read the env file it wrote.

    Parameters:
        tmp_path: Working directory for the run.
        answers: One line per prompt.
        seed: ``KEY=VALUE`` pairs written (quoted) before the run.

    Returns:
        ``(stdout, env)`` where *env* maps each written key to its raw value,
        quotes included.
    """
    result = _run(tmp_path, answers, **seed)
    assert result.returncode == 0, result.stderr
    pairs = (
        line.split("=", 1)
        for line in (tmp_path / ENV_FILE).read_text(encoding="utf-8").splitlines()
        if "=" in line and not line.startswith("#")
    )
    return result.stdout, dict(pairs)


def test_reticulum_asks_for_the_ingestor_node_id(tmp_path):
    """Docker Reticulum needs the id (SPEC RE8): asked, written, summarised."""
    out, env = _configure(tmp_path, _reticulum(NODE_ID))
    assert (env.get("INGESTOR_NODE_ID"), env.get("RETICULUM_INTERFACES")) == (
        f'"{NODE_ID}"',
        None,
    )
    assert "Required in Docker.\n" in out
    assert f"Ingestor Node ID: {NODE_ID}" in out


def test_reticulum_node_id_is_validated(tmp_path):
    """Blank, malformed and short answers are asked again; the valid one is kept."""
    attempts = ["", "nonsense", "27716218", "!2771621", NODE_ID]
    out, env = _configure(tmp_path, _reticulum(*attempts))
    assert env.get("INGESTOR_NODE_ID") == f'"{NODE_ID}"'
    assert out.count(RETRY) == len(attempts) - 1
    assert "RETICULUM_INTERFACES" not in env


def test_reticulum_accepts_a_32_hex_identity_hash(tmp_path):
    """The full identity hash is written as typed; the provider maps it (RE5)."""
    out, env = _configure(tmp_path, _reticulum(IDENTITY_HASH))
    assert env.get("INGESTOR_NODE_ID") == f'"{IDENTITY_HASH}"'
    assert RETRY not in out


def test_end_of_input_stops_the_node_id_prompt(tmp_path):
    """Input that ends on an invalid id exits with an error instead of looping."""
    # Every answer up to the node id prompt, one invalid id, then end of input.
    result = _run(tmp_path, [*_SITE, "reticulum", *_SHARED, "", "nonsense"])
    assert result.returncode != 0
    assert result.stdout.count(RETRY) == 1
    env_text = (tmp_path / ENV_FILE).read_text(encoding="utf-8")
    assert "INGESTOR_NODE_ID" not in env_text


def test_existing_node_id_is_offered_as_the_default(tmp_path):
    """A valid id already in the file is kept by a blank answer."""
    _out, env = _configure(tmp_path, _reticulum(""), INGESTOR_NODE_ID=NODE_ID)
    assert env.get("INGESTOR_NODE_ID") == f'"{NODE_ID}"'


def test_an_invalid_existing_node_id_is_not_offered(tmp_path):
    """A malformed id in the file is no default: a blank answer asks again."""
    out, env = _configure(tmp_path, _reticulum("", NODE_ID), INGESTOR_NODE_ID="!xyz")
    assert env.get("INGESTOR_NODE_ID") == f'"{NODE_ID}"'
    assert out.count(RETRY) == 1


def test_other_protocols_are_not_asked_and_keep_the_value(tmp_path):
    """The UDP transport reads the id too, so a Meshtastic run leaves it alone."""
    out, env = _configure(tmp_path, _meshtastic(), INGESTOR_NODE_ID="!aabbccdd")
    assert env.get("INGESTOR_NODE_ID") == '"!aabbccdd"'
    assert "Required in Docker" not in out


def test_reticulum_summary_states_the_defaults(tmp_path):
    """Blank answers mean the Compose volume and RNode interfaces only."""
    out, env = _configure(tmp_path, _reticulum(NODE_ID))
    assert "RNS Config Dir: 'potatomesh_reticulum volume'" in out
    assert "Interfaces: 'RNode only'" in out
    assert "RETICULUM_CONFIG_DIR" not in env


def test_star_is_written_for_every_interface(tmp_path):
    """``*`` reaches the env file and the summary verbatim, never globbed."""
    (tmp_path / "decoy").touch()
    out, env = _configure(tmp_path, _reticulum(NODE_ID, interfaces="*"))
    assert env.get("RETICULUM_INTERFACES") == '"*"'
    assert "Interfaces: *" in out
