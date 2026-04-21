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
"""Unit tests for the runtime patch installed against the upstream ``meshcore``
library to suppress ``MessageReader.handle_rx`` crashes on malformed frames.

Covers GitHub issue #754.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from data.mesh_ingestor.protocols import (  # noqa: E402 - path setup
    _meshcore_patches,
)


class _FakeReader:
    """Stand-in for ``meshcore.reader.MessageReader`` that lets us control
    what ``handle_rx`` raises without dragging in the real library's
    framing state machine."""

    def __init__(self, raise_exc: BaseException | None = None, return_value=None):
        self._raise_exc = raise_exc
        self._return_value = return_value
        self.received: list[bytes] = []

    async def handle_rx(self, data):
        self.received.append(bytes(data))
        if self._raise_exc is not None:
            raise self._raise_exc
        return self._return_value


def _install_patch_on(cls) -> None:
    """Run the real wrap helper against an arbitrary class so the tests do
    not mutate the installed ``meshcore.reader.MessageReader``."""
    _meshcore_patches._wrap_handle_rx(cls)


def _run(coro):
    return asyncio.run(coro)


def test_apply_is_idempotent():
    """``apply()`` wrapping twice must not double-wrap the target method."""

    class Target:
        async def handle_rx(self, data):
            return "ok"

    first_wrap = _meshcore_patches._wrap_handle_rx(Target)
    second_wrap = _meshcore_patches._wrap_handle_rx(Target)

    assert first_wrap is True
    assert second_wrap is False
    # Marker is present on the wrapper so future imports short-circuit.
    assert getattr(Target.handle_rx, _meshcore_patches._PATCH_MARKER, False) is True
    # Original is preserved for revert.
    assert hasattr(Target, "_orig_handle_rx")


def test_apply_returns_false_when_already_patched(monkeypatch):
    """Once ``_wrap_handle_rx`` has been applied, ``apply()`` at module
    level observes the sentinel and short-circuits rather than rewrapping."""

    class Target:
        async def handle_rx(self, data):
            return None

    _meshcore_patches._wrap_handle_rx(Target)

    # Replace ``meshcore.reader.MessageReader`` with our pre-patched Target
    # so ``apply()`` cannot accidentally wrap a real class in the test env.
    import meshcore.reader as reader_module

    original_cls = reader_module.MessageReader
    monkeypatch.setattr(reader_module, "MessageReader", Target)
    try:
        assert _meshcore_patches.apply() is False
    finally:
        monkeypatch.setattr(reader_module, "MessageReader", original_cls)


def test_index_error_swallowed_and_logged(monkeypatch):
    """The exact failure mode reported in #754: ``IndexError`` on a malformed
    frame must not propagate and must emit one structured warning."""

    class Target(_FakeReader):
        pass

    _install_patch_on(Target)
    instance = Target(raise_exc=IndexError("index out of range"))

    # Force the debug logger to always emit so we can capture the log line
    # regardless of the ``DEBUG`` env flag during test runs.
    from data.mesh_ingestor import config

    emitted: list[tuple[str, dict]] = []

    def _capture_log(message, **kwargs):
        emitted.append((message, kwargs))

    monkeypatch.setattr(config, "_debug_log", _capture_log)

    # Should return None rather than raise.
    result = _run(instance.handle_rx(b"\x01\x02\x03\x04"))
    assert result is None

    assert emitted, "patched handle_rx should have logged the suppressed error"
    message, kwargs = emitted[-1]
    assert "malformed frame" in message
    assert kwargs["context"] == "meshcore.reader.patch"
    assert kwargs["severity"] == "warning"
    assert kwargs["error_class"] == "IndexError"
    assert kwargs["error_message"] == "index out of range"
    assert kwargs["packet_len"] == 4
    assert kwargs["packet_hex"] == "01020304"


def test_unrelated_return_value_preserved():
    """When the original ``handle_rx`` returns normally, the wrapper must
    forward the exact return value and not swallow it."""

    class Target(_FakeReader):
        pass

    _install_patch_on(Target)
    sentinel = object()
    instance = Target(return_value=sentinel)

    result = _run(instance.handle_rx(b"\x00"))
    assert result is sentinel
    assert instance.received == [b"\x00"]


def test_packet_dump_truncated_to_max(monkeypatch):
    """Large frames must be truncated in the hex dump so a noisy device
    cannot flood the log."""

    class Target(_FakeReader):
        pass

    _install_patch_on(Target)
    instance = Target(raise_exc=ValueError("boom"))

    from data.mesh_ingestor import config

    emitted: list[dict] = []

    def _capture_log(message, **kwargs):
        emitted.append(kwargs)

    monkeypatch.setattr(config, "_debug_log", _capture_log)

    payload = bytes(range(256)) * 2  # 512 bytes
    result = _run(instance.handle_rx(payload))
    assert result is None

    kwargs = emitted[-1]
    # Hex length is exactly 2 * cap bytes.
    expected_len = 2 * _meshcore_patches._PACKET_LOG_MAX_BYTES
    assert len(kwargs["packet_hex"]) == expected_len
    # And matches the first N real bytes of the payload.
    assert (
        kwargs["packet_hex"] == payload[: _meshcore_patches._PACKET_LOG_MAX_BYTES].hex()
    )
    assert kwargs["packet_len"] == 512


def test_hex_preview_handles_non_bytes():
    """Defensive: ``_hex_preview`` accepts bytearray / memoryview and any
    object convertible via ``bytes(...)`` without raising."""

    assert (
        _meshcore_patches._hex_preview(bytearray(b"\xde\xad\xbe\xef"), 4) == "deadbeef"
    )
    assert _meshcore_patches._hex_preview(memoryview(b"\x01\x02"), 8) == "0102"
    assert _meshcore_patches._hex_preview("not-bytes", 4) == ""


def test_safe_len_handles_unsized():
    assert _meshcore_patches._safe_len(b"\x01\x02") == 2
    assert _meshcore_patches._safe_len(12345) is None


def test_apply_skips_gracefully_when_meshcore_missing(monkeypatch):
    """If ``meshcore`` is not importable, ``apply()`` must return ``False``
    instead of raising.  Simulated by injecting an ImportError into
    ``meshcore.reader``'s import machinery."""

    # Block the import by clearing both the submodule and the parent, so
    # that ``import meshcore.reader`` inside ``apply()`` triggers a fresh
    # resolution that fails.
    monkeypatch.setitem(sys.modules, "meshcore.reader", None)
    assert _meshcore_patches.apply() is False


def test_run_loop_exception_handler_routes_to_debug_log(monkeypatch):
    """The loop-level safety net installed in ``_run_loop`` must forward
    asyncio's unhandled-exception contexts through ``config._debug_log``."""

    from data.mesh_ingestor import config
    from data.mesh_ingestor.protocols import meshcore

    emitted: list[tuple[str, dict]] = []

    def _capture_log(message, **kwargs):
        emitted.append((message, kwargs))

    monkeypatch.setattr(config, "_debug_log", _capture_log)

    loop = asyncio.new_event_loop()
    try:
        meshcore._log_unhandled_loop_exception(
            loop,
            {"message": "synthetic task failure", "exception": RuntimeError("boom")},
        )
    finally:
        loop.close()

    assert emitted, "loop handler should forward to the structured logger"
    message, kwargs = emitted[-1]
    assert message == "synthetic task failure"
    assert kwargs["context"] == "asyncio.unhandled"
    assert kwargs["severity"] == "error"
    assert kwargs["error_class"] == "RuntimeError"
    assert kwargs["error_message"] == "boom"


def test_wrap_returns_false_when_class_has_no_handle_rx():
    """If a future upstream release renames ``handle_rx`` or we point the
    patch at the wrong class, ``_wrap_handle_rx`` must report the no-op
    rather than silently install nothing on a random attribute."""

    class Bare:
        pass

    assert _meshcore_patches._wrap_handle_rx(Bare) is False
    assert not hasattr(Bare, "_orig_handle_rx")


def test_loop_handler_defaults_when_context_minimal(monkeypatch):
    """Covers the fallback branches of ``_log_unhandled_loop_exception`` —
    missing ``message`` (defaults to a fixed string) and missing
    ``exception`` (``error_class``/``error_message`` come through as ``None``).
    Both are real asyncio code paths: task-cancellation and unhandled-future
    warnings arrive with one-or-the-other key unset."""

    from data.mesh_ingestor import config
    from data.mesh_ingestor.protocols import meshcore

    emitted: list[tuple[str, dict]] = []

    def _capture_log(message, **kwargs):
        emitted.append((message, kwargs))

    monkeypatch.setattr(config, "_debug_log", _capture_log)

    loop = asyncio.new_event_loop()
    try:
        # Empty context exercises both fallbacks at once.
        meshcore._log_unhandled_loop_exception(loop, {})
    finally:
        loop.close()

    assert emitted, "loop handler should still emit something for a bare context"
    message, kwargs = emitted[-1]
    assert message == "Unhandled asyncio task exception"
    assert kwargs["context"] == "asyncio.unhandled"
    assert kwargs["severity"] == "error"
    assert kwargs["error_class"] is None
    assert kwargs["error_message"] is None


def test_loop_handler_logs_task_name_when_present(monkeypatch):
    """Asyncio includes the failing ``task`` object in its context dict when
    the exception comes from ``create_task(...)``.  The handler extracts the
    task's name so operators can correlate log lines with the frame that
    blew up when several readers share a loop."""

    from data.mesh_ingestor import config
    from data.mesh_ingestor.protocols import meshcore

    emitted: list[dict] = []

    def _capture_log(message, **kwargs):
        emitted.append(kwargs)

    monkeypatch.setattr(config, "_debug_log", _capture_log)

    async def _dummy():
        return None

    loop = asyncio.new_event_loop()
    try:
        task = loop.create_task(_dummy(), name="meshcore-reader-42")
        # Let the task finish so we don't leak a pending future.
        loop.run_until_complete(task)
        meshcore._log_unhandled_loop_exception(
            loop,
            {
                "message": "synthetic",
                "exception": ValueError("bad frame"),
                "task": task,
            },
        )
    finally:
        loop.close()

    assert emitted[-1]["task"] == "meshcore-reader-42"
