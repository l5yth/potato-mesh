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
"""Regression guards for #765: MeshCore channel messages lost path and RSSI.

Both defects are pinned against the real ``meshcore`` reader, not a fake
(SPEC SC1/SC2, ACCEPTANCE SC-R1):

* the runner set ``mc.decrypt_channels = True``, an attribute ``MeshCore``
  does not have, so the library's RX-log join never ran and no channel
  message carried a path or an RSSI;
* the library's join copies the newest RX-log copy of a message, so a 3-hop
  message could carry a later 5-hop copy's path and RSSI.  The ingestor takes
  the delivered copy instead: the earliest flood copy whose hop count equals
  the message's ``path_len``.
"""

from __future__ import annotations

import asyncio
import sys
import threading
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import meshcore  # noqa: E402 - path setup
import meshcore_frames as frames  # noqa: E402 - pytest puts tests/ on sys.path

import data.mesh_ingestor.channels as _channels  # noqa: E402
import data.mesh_ingestor.protocols.meshcore as _mod  # noqa: E402
from data.mesh_ingestor.protocols.meshcore import runner as _runner  # noqa: E402
from data.mesh_ingestor.protocols.meshcore import (  # noqa: E402
    _MeshcoreInterface,
    _make_event_handlers,
)


async def _idle_poll(_mc, _iface) -> None:
    """Telemetry loop stand-in that returns at once."""


async def _start_and_stop(iface: _MeshcoreInterface) -> list:
    """Run ``_run_meshcore`` until it signals readiness, then stop it.

    Parameters:
        iface: Interface the runner populates.

    Returns:
        The runner's single-element error holder.
    """
    connected = threading.Event()
    error_holder: list = [None]
    task = asyncio.create_task(
        _mod._run_meshcore(iface, "/dev/ttyUSB0", connected, error_holder)
    )
    for _ in range(1000):
        await asyncio.sleep(0)
        if connected.is_set():
            break
    iface._stop_event.set()
    await task
    return error_holder


def test_meshcore_class_offers_the_join_setter_and_no_attribute():
    """SC1 contract: the pinned library enables the join through a method.

    ``MeshCore.set_decrypt_channel_logs`` exists and flips the reader's flag;
    ``MeshCore.decrypt_channels`` does not exist, so assigning it is a no-op.
    """
    assert callable(getattr(meshcore.MeshCore, "set_decrypt_channel_logs", None))
    assert not hasattr(meshcore.MeshCore, "decrypt_channels")
    mc = meshcore.MeshCore(frames.FakeConnection())
    assert not hasattr(mc, "decrypt_channels")
    assert mc._reader.decrypt_channels is False
    mc.set_decrypt_channel_logs(True)
    assert mc._reader.decrypt_channels is True


def test_runner_turns_the_real_library_join_on(monkeypatch):
    """SC1: after startup the real reader decrypts channel RX-log frames.

    Drives ``_run_meshcore`` with the real ``MeshCore`` class.  The defect
    left ``mc._reader.decrypt_channels`` ``False`` and wrote a stray
    ``decrypt_channels`` attribute on the instance instead.
    """
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)
    monkeypatch.setattr(_mod, "MeshCore", frames.offline_meshcore())
    monkeypatch.setattr(
        _runner, "_make_connection", lambda *_a, **_k: frames.FakeConnection()
    )
    monkeypatch.setattr(_runner, "_telemetry_poll_loop", _idle_poll)
    monkeypatch.setattr(_channels, "_CHANNEL_LOOKUP", {})

    iface = _MeshcoreInterface(target=None)
    error_holder = asyncio.run(_start_and_stop(iface))

    assert error_holder[0] is None
    mc = iface._mc
    assert (
        mc._reader.decrypt_channels is True
    ), "the runner must enable the library's RX-log join (set_decrypt_channel_logs)"
    assert "decrypt_channels" not in vars(mc), "stray attribute; the join stays off"


def _rx_copy(path: bytes, *, snr: float, rssi: int) -> bytes:
    """Build the RX-log push of one plain-flood copy of the shared message.

    Parameters:
        path: Repeater hashes the copy travelled, one byte each.
        snr: Reception SNR in dB.
        rssi: Reception RSSI in dBm.

    Returns:
        A ``LOG_RX_DATA`` frame.
    """
    payload = frames.grp_txt_payload(frames.channel_secret())
    return frames.rx_log_frame(
        frames.raw_packet(payload, path=path), snr=snr, rssi=rssi
    )


_COPY_3_HOPS = _rx_copy(bytes.fromhex("f0bf44"), snr=10.0, rssi=-96)
_COPY_5_HOPS = _rx_copy(bytes.fromhex("f0bf4411aa"), snr=5.0, rssi=-100)
_COPY_3_HOPS_OTHER_ROUTE = _rx_copy(bytes.fromhex("a1b2c3"), snr=2.0, rssi=-110)


@pytest.mark.parametrize(
    ("copies", "path_len", "path", "rssi"),
    [
        # Delivered over 3 hops; a 5-hop copy arrives later.
        ([_COPY_3_HOPS, _COPY_5_HOPS], 3, "f0bf44", -96),
        # Delivered over 5 hops; a 3-hop copy arrives later.
        ([_COPY_5_HOPS, _COPY_3_HOPS], 5, "f0bf4411aa", -100),
        # Two 3-hop copies over different repeaters: the first one is delivered.
        ([_COPY_3_HOPS, _COPY_3_HOPS_OTHER_ROUTE], 3, "f0bf44", -96),
    ],
    ids=["three-then-five", "five-then-three", "same-hops-two-routes"],
)
def test_channel_message_takes_the_delivered_copy(
    monkeypatch, copies, path_len, path, rssi
):
    """SC2: path and RSSI come from the copy the radio delivered.

    The firmware delivers a flood message from the first copy it hears and
    drops later copies as already seen; its ``path_len`` is that copy's hop
    count.  The library's join returns the newest copy instead.  The join is
    switched on by the test itself, so this isolates the copy selection.
    """
    captured: list = []
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)
    monkeypatch.setattr(_mod.config, "DEBUG", False)
    frames.install_stub_handlers(monkeypatch, captured)
    monkeypatch.setattr(_channels, "_CHANNEL_LOOKUP", {})
    hmap = _make_event_handlers(_MeshcoreInterface(target=None), "/dev/ttyUSB0")

    message = frames.channel_msg_v3_frame(path_len=path_len)
    asyncio.run(
        frames.feed_reader([frames.channel_info_frame(), *copies, message], hmap)
    )

    assert len(captured) == 1
    packet = captured[0]
    assert packet["decoded"]["text"] == frames.TEXT
    assert packet["hops"] == path_len
    assert packet["path"] == path
    assert packet["rssi"] == rssi
