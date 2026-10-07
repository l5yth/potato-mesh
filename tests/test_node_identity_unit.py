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
"""Unit tests for :mod:`data.mesh_ingestor.node_identity`."""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from data.mesh_ingestor.node_identity import (  # noqa: E402 - path setup
    canonical_node_id,
    claims_node,
    node_num_from_id,
)


def test_canonical_node_id_accepts_numeric():
    assert canonical_node_id(1) == "!00000001"
    assert canonical_node_id(0xABCDEF01) == "!abcdef01"
    assert canonical_node_id(1.0) == "!00000001"


def test_canonical_node_id_accepts_string_forms():
    assert canonical_node_id("!ABCDEF01") == "!abcdef01"
    assert canonical_node_id("0xABCDEF01") == "!abcdef01"
    assert canonical_node_id("abcdef01") == "!abcdef01"
    assert canonical_node_id("123") == "!0000007b"


def test_canonical_node_id_passthrough_caret_destinations():
    assert canonical_node_id("^all") == "^all"


def test_node_num_from_id_parses_canonical_and_hex():
    assert node_num_from_id("!abcdef01") == 0xABCDEF01
    assert node_num_from_id("abcdef01") == 0xABCDEF01
    assert node_num_from_id("0xabcdef01") == 0xABCDEF01
    assert node_num_from_id(123) == 123


def test_canonical_node_id_rejects_none_and_empty():
    assert canonical_node_id(None) is None
    assert canonical_node_id("") is None
    assert canonical_node_id("   ") is None


def test_canonical_node_id_rejects_negative():
    assert canonical_node_id(-1) is None
    assert canonical_node_id(-0xABCDEF01) is None


def test_canonical_node_id_truncates_overflow():
    # Values wider than 32 bits are masked, not rejected.
    assert canonical_node_id(0x1_ABCDEF01) == "!abcdef01"


def test_node_num_from_id_rejects_none_and_empty():
    assert node_num_from_id(None) is None
    assert node_num_from_id("") is None
    assert node_num_from_id("not-hex") is None


def test_claims_node_takes_the_canonical_id_or_the_node_number():
    """A claim names a node only in its canonical forms (SPEC NI1)."""

    assert claims_node("!a1a1a1a1", "!a1a1a1a1") is True
    assert claims_node(0xA1A1A1A1, "!a1a1a1a1") is True
    assert claims_node("!b2b2b2b2", "!a1a1a1a1") is False
    assert claims_node(0xB2B2B2B2, "!a1a1a1a1") is False


def test_claims_node_refuses_other_spellings_and_values():
    """Another spelling of the id, a non-id or a missing node is no claim."""

    for claimed in ("!A1A1A1A1", "a1a1a1a1", "2711724449", "!Decrypted", None, True):
        assert claims_node(claimed, "!a1a1a1a1") is False
    assert claims_node(-1, "!ffffffff") is False
    assert claims_node(0x1_0000_0000, "!00000000") is False
    assert claims_node("!a1a1a1a1", None) is False
