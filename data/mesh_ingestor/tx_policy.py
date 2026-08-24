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
"""The ingestor's single transmit-permission predicate (SPEC MA7).

PotatoMesh ingestors are listeners first.  Everything they put on the air is
therefore gated here, in one place, rather than re-derived by each caller.

**Why this module exists.**  Transmit policy used to be expressed twice, at two
different altitudes and in two different idioms: ``announce.py`` composed two
defensive ``getattr`` reads, while the MeshCore telemetry loop wrote
``poll_interval = 0 if config.RX_ONLY else ...`` at loop entry.  Two independent
sites meant two independent chances to get the parsing wrong (both did), the
gate sat a layer *above* the transmit primitives rather than beside them, and
adding a knob meant finding every idiom by hand.  One predicate, consulted at
each transmit site next to :func:`~data.mesh_ingestor.activity.record_tx`, makes
"may I transmit?" and "count this transmission" one decision per site.

**The policy.**  Two operator flags and one retired predecessor:

===============  =========  =========================================
``TX_ENABLED``   ``RX_ONLY``  transmit?
===============  =========  =========================================
unset            unset      **no** — the default; a pure listener
unset            set        no
set              unset      **yes**
set              set        no — the legacy veto wins, and warns
===============  =========  =========================================

:data:`~data.mesh_ingestor.config.TX_ANNOUNCE` then gates the announcement
specifically, on top of a permitting :func:`transmit_permitted`.

Only *mesh* transmissions are covered.  Companion-link reads over USB/BLE to the
operator's own radio (host self-telemetry, contact roster, channel queries) cost
no airtime, are not transmissions, and are never gated here.
"""

from __future__ import annotations

from typing import Any

from . import config

#: Context label used for every log line this module emits.
_LOG_CONTEXT = "tx.policy"


def transmit_permitted() -> bool:
    """Return whether the ingestor may transmit on the mesh at all (SPEC MA7 a).

    The one predicate every transmit site consults.  Call it immediately before
    the send, beside :func:`~data.mesh_ingestor.activity.record_tx`, so the
    decision to transmit and the accounting for it stay together.

    Returns:
        ``True`` only when :data:`~data.mesh_ingestor.config.TX_ENABLED` is on
        and the legacy :data:`~data.mesh_ingestor.config.RX_ONLY` veto is off.
    """

    return bool(config.TX_ENABLED) and not config.RX_ONLY


def announcements_permitted() -> bool:
    """Return whether the periodic activity announcement may be sent (SPEC MA7 b).

    Strictly narrower than :func:`transmit_permitted`: announcing is unsolicited
    traffic on a shared human channel, so it needs its own opt-in on top of the
    master switch.

    Returns:
        ``True`` when transmission is permitted **and**
        :data:`~data.mesh_ingestor.config.TX_ANNOUNCE` is on.
    """

    return transmit_permitted() and bool(config.TX_ANNOUNCE)


def describe_tx_policy() -> dict[str, Any]:
    """Return the resolved transmit policy as a structured mapping.

    Used for the startup log line and for the "which gate closed?" diagnostic.
    An operator who opts in and hears nothing on air must be able to tell *why*
    without waiting out a 24-hour observation window per hypothesis.

    ``blocked_by`` names the **first** flag that forbids announcing, checked
    outermost-first (master switch, then legacy veto, then the announcement
    opt-in), or ``None`` when every gate permits.

    Returns:
        Mapping with the three raw flags, both derived permissions, and
        ``blocked_by``.
    """

    tx_enabled = bool(config.TX_ENABLED)
    rx_only = bool(config.RX_ONLY)
    tx_announce = bool(config.TX_ANNOUNCE)

    if not tx_enabled:
        blocked_by: str | None = "TX_ENABLED"
    elif rx_only:
        blocked_by = "RX_ONLY"
    elif not tx_announce:
        blocked_by = "TX_ANNOUNCE"
    else:
        blocked_by = None

    return {
        "tx_enabled": tx_enabled,
        "tx_announce": tx_announce,
        "rx_only": rx_only,
        "transmit_permitted": transmit_permitted(),
        "announcements_permitted": announcements_permitted(),
        "blocked_by": blocked_by,
    }


def log_tx_policy() -> None:
    """State the resolved transmit policy once, at startup.

    Emitted at ``info`` (not ``debug``) so it appears without ``DEBUG=1``: what
    an ingestor will and will not put on the air is operator-visible behavior,
    not a debugging detail, and silence is otherwise indistinguishable from
    misconfiguration.

    Additionally warns when :data:`~data.mesh_ingestor.config.TX_ENABLED` and the
    legacy :data:`~data.mesh_ingestor.config.RX_ONLY` are both set.  That state
    is contradictory but representable — typically a stale ``.env`` line meeting
    a newly-added one — and it resolves to *silence*, which is the surprising
    direction for whoever just set ``TX_ENABLED=1``.
    """

    policy = describe_tx_policy()

    if policy["tx_enabled"] and policy["rx_only"]:
        _debug_log = config._debug_log
        _debug_log(
            "TX_ENABLED=1 is overridden by the legacy RX_ONLY=1 kill switch; "
            "nothing will be transmitted. Unset RX_ONLY to allow transmission.",
            context=_LOG_CONTEXT,
            severity="warning",
        )

    config._debug_log(
        "Transmit policy resolved",
        context=_LOG_CONTEXT,
        severity="info",
        always=True,
        tx_enabled=policy["tx_enabled"],
        tx_announce=policy["tx_announce"],
        rx_only=policy["rx_only"],
        transmit_permitted=policy["transmit_permitted"],
        announcements_permitted=policy["announcements_permitted"],
    )


__all__ = [
    "transmit_permitted",
    "announcements_permitted",
    "describe_tx_policy",
    "log_tx_policy",
]
