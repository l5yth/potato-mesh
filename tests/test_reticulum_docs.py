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
"""The README states Reticulum's scope (ACCEPTANCE RE-A15).

Reticulum ships experimental and announce-only in 1.0.0 (SPEC RD7, maintainer
decision 2026-10-05), and the RNS stack the ingestor uses transmits whatever
its config enables, from the ingestor's own process when no ``rnsd`` runs
(SPEC RN5 as amended by RE3).  Each check reads ``README.md`` only.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]


def _readme() -> str:
    """Return the README text.

    Returns:
        Contents of ``README.md`` at the repository root.
    """
    return (REPO_ROOT / "README.md").read_text(encoding="utf-8")


def _section(title: str) -> str:
    """Return one ``###`` section of the README, up to the next heading.

    Parameters:
        title: Heading text after ``### ``.

    Returns:
        The section body.
    """
    match = re.search(
        rf"^### {re.escape(title)}\n(.*?)(?=^#{{2,3}} )",
        _readme(),
        re.MULTILINE | re.DOTALL,
    )
    assert match, f"README.md has no ### {title} section"
    return match.group(1)


def test_badge_reads_experimental():
    """The Reticulum badge says experimental, not supported (SPEC RD7)."""
    badges = re.findall(r"Reticulum-[a-z]+-[0-9a-f]+", _readme())
    assert badges == ["Reticulum-experimental-7b61ff"]


def test_feature_bullets_mark_reticulum_experimental():
    """Both "Supports ..." bullets carry the same scope as the badge."""
    bullets = re.findall(r"^\s*\* Supports .*Reticulum.*$", _readme(), re.MULTILINE)
    assert len(bullets) == 2
    assert all("Reticulum (experimental, announce-only)" in b for b in bullets)


def test_section_states_experimental_and_announce_only():
    """The Reticulum section opens with its scope and what it does not ingest.

    The host's own position is the one exception (SPEC RP8), so the sentence
    names other nodes' positions rather than positions in general.
    """
    section = _section("Reticulum")
    assert "experimental and announce-only" in section
    assert re.search(
        r"Messages,\s+telemetry and other nodes'\s+positions are not ingested", section
    )


def test_section_states_the_host_position_and_how_to_stop_it():
    """The section says the RNS keys are published and how to stop it (RP8).

    Peers still stay off the map, so the closing line keeps saying so for them
    and no longer claims it for every Reticulum node.
    """
    section = _section("Reticulum")
    assert re.search(
        r"publishes the `latitude`, `longitude` and `height` \(metres\) keys\s+"
        r"of the first `RNodeInterface` in your RNS config",
        section,
    )
    assert re.search(
        r"Remove the keys and restart the ingestor to stop the updates", section
    )
    assert re.search(
        r"If that block already\s+sets them, for example for RNS interface discovery,"
        r"\s+they are published after\s+the upgrade",
        section,
    )
    assert "DELETE FROM positions" in section
    # A `!` inside double quotes is history expansion in bash and zsh, so the
    # pasted command spells the id's `!` as char(33) and carries none.
    command = next(line for line in section.splitlines() if line.startswith("sqlite3 "))
    assert "WHERE node_id = char(33) || '27716218'" in command
    assert "!" not in command
    assert re.search(r"Other than this\s+host, they also show dashes", section)
    assert not re.search(
        r"Reticulum nodes show dashes for battery and position", section
    )


def test_section_says_what_the_diagnostics_lines_mean():
    """The connect and hourly lines are named, with what to do on a warning (RG4)."""
    text = " ".join(_section("Reticulum").split())
    assert "After each connect the ingestor logs `Reticulum stack state`" in text
    assert "`role='client'` means it is attached to `rnsd`" in text
    assert "Every hour it logs `Reticulum announce summary`" in text
    assert (
        "a warning when no announce reached the ingestor or the interface scope "
        "dropped all of them; follow its `hints`."
    ) in text


def test_docs_name_what_the_rns_stack_transmits():
    """No blanket "never transmits": the stack's own traffic is named (SPEC RN5)."""
    section = _section("Reticulum")
    assert "never transmits" not in section
    assert "`enable_transport`" in section
    assert re.search(r"no `rnsd`\s+running", section)
    assert "PROTOCOL=reticulum" in _section("Transmitting on the mesh")


@pytest.mark.parametrize(
    "name", ["ALLOWED_CHANNELS", "HIDDEN_CHANNELS", "PRIMARY_CHANNEL_ONLY"]
)
def test_channel_filter_rows_say_reticulum_ignores_them(name):
    """A channel filter never sees an announce (SPEC CF1); its row says so."""
    row = re.search(rf"^\| `{name}` \|.*$", _readme(), re.MULTILINE)
    assert row, f"README.md has no {name} row"
    assert "Ignored under `PROTOCOL=reticulum`." in row.group(0)
