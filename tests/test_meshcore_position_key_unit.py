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
"""A MeshCore position row carries the key of the advert it came from (SPEC NI3).

The node id is only the first four bytes of a MeshCore public key, so the web
app needs the full key to move the node row only when the position comes from
the identity the row is bound to.  Only the HTTP queue is replaced.
"""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import data.mesh_ingestor.protocols.meshcore as meshcore  # noqa: E402
from data.mesh_ingestor.protocols.meshcore import (  # noqa: E402
    _MeshcoreInterface,
    _process_contacts,
    _store_meshcore_position,
)

PUBLIC_KEY = "aabbccdd" + "11" * 28
"""A full 32-byte MeshCore public key whose node id is ``!aabbccdd``."""


@pytest.fixture
def positions(monkeypatch):
    """Record every queued ``POST /api/positions`` body instead of sending it.

    Returns:
        A list that collects the queued position payloads.
    """

    recorded: list[dict] = []
    monkeypatch.setattr(
        meshcore._queue,
        "_queue_post_json",
        lambda route, payload, **_kw: (
            recorded.append(payload) if route == "/api/positions" else None
        ),
    )
    return recorded


def test_position_row_carries_the_advert_key(positions):
    """A position stored with a key posts it; one stored without posts none."""

    _store_meshcore_position("!aabbccdd", 51.5, -0.1, 1_700_001_234, None, PUBLIC_KEY)
    _store_meshcore_position("!aabbccdd", 51.5, -0.1, 1_700_001_235, None)

    assert positions[0]["public_key"] == PUBLIC_KEY
    assert "public_key" not in positions[1]


def test_roster_contact_position_carries_the_contact_key(positions):
    """A roster contact's position row carries the contact's full key."""

    contact = {
        "public_key": PUBLIC_KEY,
        "adv_name": "Alice",
        "adv_lat": 51.5,
        "adv_lon": -0.1,
        "last_advert": 1_700_001_234,
    }
    handlers = SimpleNamespace(
        upsert_node=lambda *_args: None,
        host_node_id=lambda: None,
        _mark_packet_activity=lambda: None,
    )

    _process_contacts({PUBLIC_KEY: contact}, _MeshcoreInterface(target=None), handlers)

    assert [(row["node_id"], row["public_key"]) for row in positions] == [
        ("!aabbccdd", PUBLIC_KEY)
    ]
