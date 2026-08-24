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
"""Unit tests for :mod:`data.mesh_ingestor.tx_policy` (SPEC MA7).

Guards the single transmit-permission predicate and the fail-safe env parsing
behind it.  The defect these tests exist for: ``RX_ONLY`` was parsed as an exact
``== "1"`` comparison, so every near-miss spelling (``true``, ``TRUE``, ``yes``,
``" 1"``) resolved to *false* and the receive-only kill switch **failed open** —
the ingestor transmitted despite the operator having forbidden it.  The
companion defect: the opt-in flag reached no packaged deployment surface, so it
could not be set at all from `docker-compose`, the Nix module, or the image.
"""

from __future__ import annotations

import importlib
import re
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import data.mesh_ingestor.config as config
import data.mesh_ingestor.tx_policy as tx_policy

#: Every env var that participates in the transmit policy.
_TX_ENV_VARS = ("TX_ENABLED", "TX_ANNOUNCE", "RX_ONLY")


@pytest.fixture
def tx_env(monkeypatch):
    """Yield a setter that reloads :mod:`config` under a clean TX environment.

    Restores the ambient (unset) environment and reloads once more on teardown so
    a reload-based test cannot leak resolved flags into its neighbours.
    """

    def _apply(**env: str):
        for name in _TX_ENV_VARS:
            monkeypatch.delenv(name, raising=False)
        for name, value in env.items():
            monkeypatch.setenv(name, value)
        importlib.reload(config)
        return config

    yield _apply

    for name in _TX_ENV_VARS:
        monkeypatch.delenv(name, raising=False)
    importlib.reload(config)


# ---------------------------------------------------------------------------
# config._env_flag — the shared fail-safe boolean parser
# ---------------------------------------------------------------------------


class TestEnvFlag:
    """Tests for :func:`config._env_flag`."""

    @pytest.mark.parametrize("raw", ["1", "true", "TRUE", "True", "yes", "on", " 1 "])
    def test_truthy_spellings(self, monkeypatch, raw):
        """Every accepted spelling of "on" parses as ``True``, whitespace included."""
        monkeypatch.setenv("SOME_FLAG", raw)
        assert config._env_flag("SOME_FLAG", default=False, on_invalid=False) is True

    @pytest.mark.parametrize("raw", ["0", "false", "FALSE", "no", "off", " 0 "])
    def test_falsy_spellings(self, monkeypatch, raw):
        """Every accepted spelling of "off" parses as ``False``."""
        monkeypatch.setenv("SOME_FLAG", raw)
        assert config._env_flag("SOME_FLAG", default=True, on_invalid=True) is False

    @pytest.mark.parametrize("raw", ["", "   "])
    def test_blank_falls_back_to_default(self, monkeypatch, raw):
        """A blank value is treated as unset so an empty ``.env`` line is inert."""
        monkeypatch.setenv("SOME_FLAG", raw)
        assert config._env_flag("SOME_FLAG", default=True, on_invalid=False) is True

    def test_unset_falls_back_to_default(self, monkeypatch):
        """An absent variable resolves to the declared default."""
        monkeypatch.delenv("SOME_FLAG", raising=False)
        assert config._env_flag("SOME_FLAG", default=True, on_invalid=False) is True

    def test_unrecognized_uses_on_invalid_and_warns(self, monkeypatch, capsys):
        """An unparseable value resolves fail-safe and says so, loudly."""
        monkeypatch.setenv("SOME_FLAG", "maybe")
        assert config._env_flag("SOME_FLAG", default=True, on_invalid=False) is False
        out = capsys.readouterr().out
        assert "SOME_FLAG" in out and "maybe" in out
        assert "warning" in out.lower()

    def test_unrecognized_warns_even_without_debug(self, monkeypatch, capsys):
        """The warning bypasses the ``DEBUG`` guard — it is not a debug line."""
        monkeypatch.setattr(config, "DEBUG", False)
        monkeypatch.setenv("SOME_FLAG", "banana")
        config._env_flag("SOME_FLAG", default=False, on_invalid=False)
        assert "banana" in capsys.readouterr().out


# ---------------------------------------------------------------------------
# Env resolution of the three TX flags
# ---------------------------------------------------------------------------


class TestTxEnabledEnv:
    """Tests for :data:`config.TX_ENABLED`."""

    def test_defaults_off(self, tx_env):
        """Unset means no transmissions — the whole point of the change."""
        assert tx_env().TX_ENABLED is False

    @pytest.mark.parametrize("raw", ["1", "true", "TRUE", "yes", "on", " 1 "])
    def test_enabled_spellings(self, tx_env, raw):
        """Any accepted spelling of "on" enables transmission."""
        assert tx_env(TX_ENABLED=raw).TX_ENABLED is True

    @pytest.mark.parametrize("raw", ["0", "false", "no", "off"])
    def test_disabled_spellings(self, tx_env, raw):
        """Any accepted spelling of "off" keeps transmission disabled."""
        assert tx_env(TX_ENABLED=raw).TX_ENABLED is False

    def test_unrecognized_fails_safe_to_off(self, tx_env):
        """A typo must not silently grant transmit permission."""
        assert tx_env(TX_ENABLED="maybe").TX_ENABLED is False


class TestTxAnnounceEnv:
    """Tests for :data:`config.TX_ANNOUNCE`."""

    def test_defaults_off(self, tx_env):
        """Announcements are opt-in."""
        assert tx_env().TX_ANNOUNCE is False

    @pytest.mark.parametrize("raw", ["1", "true", "yes", "on", " 1 "])
    def test_enabled_spellings(self, tx_env, raw):
        """Any accepted spelling of "on" opts into announcements."""
        assert tx_env(TX_ANNOUNCE=raw).TX_ANNOUNCE is True

    def test_unrecognized_fails_safe_to_off(self, tx_env):
        """A typo must not silently opt an operator into unsolicited TX."""
        assert tx_env(TX_ANNOUNCE="sure").TX_ANNOUNCE is False


class TestLegacyRxOnlyEnv:
    """Tests for the legacy :data:`config.RX_ONLY` kill switch."""

    def test_defaults_off(self, tx_env):
        """Absent legacy flag asserts nothing; the TX_ENABLED default governs."""
        assert tx_env().RX_ONLY is False

    @pytest.mark.parametrize("raw", ["1", "true", "TRUE", "yes", "on", " 1 ", "1 "])
    def test_kill_switch_spellings_all_engage(self, tx_env, raw):
        """The regression: every one of these previously failed **open**."""
        assert tx_env(RX_ONLY=raw).RX_ONLY is True

    @pytest.mark.parametrize("raw", ["0", "false", "no", "off"])
    def test_explicitly_disengaged(self, tx_env, raw):
        """An explicit "off" does not engage the kill switch."""
        assert tx_env(RX_ONLY=raw).RX_ONLY is False

    def test_unrecognized_fails_safe_to_engaged(self, tx_env):
        """A kill switch fails toward *killed*: a typo silences TX, never grants it."""
        assert tx_env(RX_ONLY="probably").RX_ONLY is True


# ---------------------------------------------------------------------------
# The single transmit-permission predicate
# ---------------------------------------------------------------------------


def _set_policy(monkeypatch, *, tx_enabled, rx_only=False, tx_announce=False):
    """Pin the three resolved policy flags on the config module."""
    monkeypatch.setattr(config, "TX_ENABLED", tx_enabled)
    monkeypatch.setattr(config, "RX_ONLY", rx_only)
    monkeypatch.setattr(config, "TX_ANNOUNCE", tx_announce)


class TestTransmitPermitted:
    """Truth table for :func:`tx_policy.transmit_permitted`."""

    @pytest.mark.parametrize(
        ("tx_enabled", "rx_only", "expected"),
        [
            (False, False, False),  # new default: silent
            (False, True, False),  # legacy kill switch, nothing to override
            (True, False, True),  # the only permitting combination
            (True, True, False),  # RX_ONLY keeps its veto over TX_ENABLED=1
        ],
    )
    def test_matrix(self, monkeypatch, tx_enabled, rx_only, expected):
        """TX is permitted only when opted in and not vetoed by the legacy flag."""
        _set_policy(monkeypatch, tx_enabled=tx_enabled, rx_only=rx_only)
        assert tx_policy.transmit_permitted() is expected


class TestAnnouncementsPermitted:
    """Truth table for :func:`tx_policy.announcements_permitted`."""

    @pytest.mark.parametrize(
        ("tx_enabled", "tx_announce", "rx_only", "expected"),
        [
            (False, False, False, False),
            (False, True, False, False),  # TX_ENABLED=0 beats TX_ANNOUNCE=1
            (True, False, False, False),  # transmit allowed, announcing not asked for
            (True, True, False, True),  # the only permitting combination
            (True, True, True, False),  # legacy veto still wins
        ],
    )
    def test_matrix(self, monkeypatch, tx_enabled, tx_announce, rx_only, expected):
        """Announcing requires transmit permission *and* the announcement opt-in."""
        _set_policy(
            monkeypatch,
            tx_enabled=tx_enabled,
            rx_only=rx_only,
            tx_announce=tx_announce,
        )
        assert tx_policy.announcements_permitted() is expected

    def test_implies_transmit_permitted(self, monkeypatch):
        """Announcing can never be permitted where transmitting is not."""
        for tx_enabled in (False, True):
            for rx_only in (False, True):
                _set_policy(
                    monkeypatch,
                    tx_enabled=tx_enabled,
                    rx_only=rx_only,
                    tx_announce=True,
                )
                if tx_policy.announcements_permitted():
                    assert tx_policy.transmit_permitted() is True


# ---------------------------------------------------------------------------
# Diagnostics: the operator must be able to tell which gate closed
# ---------------------------------------------------------------------------


class TestDescribeTxPolicy:
    """Tests for :func:`tx_policy.describe_tx_policy`."""

    def test_names_the_resolved_state(self, monkeypatch):
        """The description carries every flag that fed the decision."""
        _set_policy(monkeypatch, tx_enabled=True, rx_only=False, tx_announce=True)
        described = tx_policy.describe_tx_policy()
        assert described["tx_enabled"] is True
        assert described["tx_announce"] is True
        assert described["rx_only"] is False
        assert described["transmit_permitted"] is True
        assert described["announcements_permitted"] is True

    def test_reports_the_blocking_gate(self, monkeypatch):
        """When TX is forbidden the description says which flag forbade it."""
        _set_policy(monkeypatch, tx_enabled=True, rx_only=True, tx_announce=True)
        assert tx_policy.describe_tx_policy()["blocked_by"] == "RX_ONLY"

        _set_policy(monkeypatch, tx_enabled=False, tx_announce=True)
        assert tx_policy.describe_tx_policy()["blocked_by"] == "TX_ENABLED"

        _set_policy(monkeypatch, tx_enabled=True, tx_announce=False)
        assert tx_policy.describe_tx_policy()["blocked_by"] == "TX_ANNOUNCE"

        _set_policy(monkeypatch, tx_enabled=True, tx_announce=True)
        assert tx_policy.describe_tx_policy()["blocked_by"] is None


class TestLogTxPolicy:
    """Tests for :func:`tx_policy.log_tx_policy` (startup diagnostics)."""

    def test_logs_resolved_policy_without_debug(self, monkeypatch, capsys):
        """The resolved policy is stated at startup even with DEBUG off."""
        monkeypatch.setattr(config, "DEBUG", False)
        _set_policy(monkeypatch, tx_enabled=False)
        tx_policy.log_tx_policy()
        out = capsys.readouterr().out.lower()
        assert "tx_enabled=false" in out
        assert "transmit_permitted=false" in out

    def test_warns_on_contradictory_configuration(self, monkeypatch, capsys):
        """TX_ENABLED=1 with RX_ONLY=1 is contradictory and must be loud."""
        monkeypatch.setattr(config, "DEBUG", False)
        _set_policy(monkeypatch, tx_enabled=True, rx_only=True)
        tx_policy.log_tx_policy()
        out = capsys.readouterr().out.lower()
        assert "warning" in out
        assert "rx_only" in out

    def test_no_contradiction_warning_when_consistent(self, monkeypatch, capsys):
        """A consistent configuration produces no warning."""
        monkeypatch.setattr(config, "DEBUG", False)
        _set_policy(monkeypatch, tx_enabled=True, rx_only=False)
        tx_policy.log_tx_policy()
        assert "warning" not in capsys.readouterr().out.lower()


# ---------------------------------------------------------------------------
# The flags must be reachable from the packaged deployment surfaces
# ---------------------------------------------------------------------------


class TestDeploymentSurface:
    """A knob nobody can set is a knob that does not exist.

    The opt-in shipped with no way to deliver it: the Compose ``environment:``
    mapping is a closed allowlist with no ``env_file:``, and the Nix module and
    image ``ENV`` blocks are equally closed.  These checks pin every packaged
    path so the next TX flag cannot repeat it.
    """

    @pytest.mark.parametrize("name", ["TX_ENABLED", "TX_ANNOUNCE"])
    def test_compose_passes_the_flag_through(self, name):
        """The base compose file maps the flag from the host env into the container.

        Only the base file is checked: ``docker-compose.dev.yml`` and
        ``.prod.yml`` are overlays (neither is a valid standalone project) and
        Compose merges the base ``environment:`` mapping into them, so the
        passthrough is inherited rather than repeated.
        """
        text = (REPO_ROOT / "docker-compose.yml").read_text(encoding="utf-8")
        assert re.search(
            rf"^\s*{name}:\s*\$\{{{name}", text, re.MULTILINE
        ), f"docker-compose.yml does not pass {name} through to the ingestor"

    @pytest.mark.parametrize("name", ["TX_ENABLED", "TX_ANNOUNCE"])
    def test_env_example_documents_the_flag(self, name):
        """The copy-this-to-.env template mentions the flag."""
        text = (REPO_ROOT / ".env.example").read_text(encoding="utf-8")
        assert re.search(rf"^{name}=", text, re.MULTILINE)

    @pytest.mark.parametrize("name", ["TX_ENABLED", "TX_ANNOUNCE"])
    def test_image_declares_the_default(self, name):
        """The ingestor image declares the flag so its default is visible."""
        text = (REPO_ROOT / "data" / "Dockerfile").read_text(encoding="utf-8")
        assert f"{name}=0" in text

    @pytest.mark.parametrize("name", ["txEnabled", "txAnnounce"])
    def test_nix_module_exposes_the_option(self, name):
        """The Nix module exposes the flag as a declarative option."""
        text = (REPO_ROOT / "flake.nix").read_text(encoding="utf-8")
        assert name in text

    def test_legacy_flag_is_not_reintroduced_to_docs(self):
        """``RX_ONLY`` stays supported in code but out of operator-facing docs."""
        readme = (REPO_ROOT / "README.md").read_text(encoding="utf-8")
        assert "RX_ONLY" not in readme
