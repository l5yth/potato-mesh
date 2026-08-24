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
"""Shared pytest fixtures for the ingestor test suite."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import data.mesh_ingestor.config as config


@pytest.fixture
def permit_tx(monkeypatch):
    """Permit mesh transmission for a test that exercises a transmit path.

    Transmission is off by default (SPEC MA7), so a test of transmit *machinery*
    would otherwise stop at the policy gate and pass vacuously — asserting "no
    frame was sent" while never reaching the code it means to check.  Request
    this fixture to isolate the machinery from the policy; the policy itself is
    covered in ``tests/test_tx_policy_unit.py``.

    Yields:
        The patched :mod:`~data.mesh_ingestor.config` module, so a test can
        narrow the policy further (e.g. re-engage ``RX_ONLY``).
    """

    monkeypatch.setattr(config, "TX_ENABLED", True)
    monkeypatch.setattr(config, "TX_ANNOUNCE", True)
    monkeypatch.setattr(config, "RX_ONLY", False)
    return config
