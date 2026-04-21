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

"""Runtime patches applied to the upstream ``meshcore`` library.

This module exists solely to paper over bugs in the third-party
``meshcore-py`` package while we wait for upstream fixes.  Each patch is
narrow, idempotent, and preserves the original method on the target class so
that it can be reverted cleanly once a fix ships upstream.

Current patches:

* :func:`_wrap_handle_rx` — guards :meth:`meshcore.reader.MessageReader.handle_rx`
  against unhandled exceptions raised while decoding a single radio frame.
  Upstream 2.3.6 (latest at the time of writing) raises ``IndexError`` at
  ``reader.py:365`` when parsing a truncated ``DEVICE_INFO`` advertisement
  (``path_hash_mode = dbuf.read(1)[0]`` with an already-exhausted buffer).
  Because the frame is parsed inside a detached
  ``asyncio.create_task(...)`` the resulting exception surfaces as a noisy
  ``Task exception was never retrieved`` stderr dump and the decoded event
  for that frame is lost.  See GitHub issue #754.

Apply the patches by calling :func:`apply` as early as possible after the
``meshcore`` package is imported.  Re-invoking :func:`apply` is a no-op.
"""

from __future__ import annotations

from typing import Any

from .. import config

# Sentinel attribute set on a patched method so repeated imports/tests do
# not wrap the same function more than once.  The name intentionally
# includes the project slug so we can grep for it while diagnosing.
_PATCH_MARKER = "_potato_mesh_patched"

# Cap on hex bytes dumped into the log per failure.  Keeps the log line
# under a few hundred characters even for maximum-sized frames.
_PACKET_LOG_MAX_BYTES = 32


def apply() -> bool:
    """Install every known-needed patch on the upstream ``meshcore`` library.

    Safe to call multiple times; each patch is individually idempotent.

    Implicit contract with upstream: every patch here rebinds a method on
    the target *class*.  This only affects call sites that perform an
    attribute lookup at call time (``reader.handle_rx(data)``) — not call
    sites that captured an unbound reference before :func:`apply` ran
    (``_rx = reader.handle_rx``).  As of ``meshcore-py`` 2.3.6 the library
    always uses attribute-lookup-at-call, so this is fine; if a future
    release flips that, the patch silently no-ops and the original bug
    resurfaces.  Spot-check after every upstream bump.

    Returns:
        ``True`` when at least one patch was installed during this call,
        ``False`` when every patch had already been applied (or when the
        ``meshcore`` library is not importable in this environment, e.g. a
        meshtastic-only test runner).
    """
    try:
        import meshcore.reader as _reader  # type: ignore[import-not-found]
    except ImportError:
        # Meshtastic-only runtimes never load this module's caller, but
        # imports from tests may still land here.  Nothing to patch.
        return False

    return _wrap_handle_rx(_reader.MessageReader)


def _wrap_handle_rx(reader_cls: Any) -> bool:
    """Wrap ``reader_cls.handle_rx`` with an exception-swallowing shim.

    Parameters:
        reader_cls: The ``MessageReader`` class to patch in place.

    Returns:
        ``True`` when the wrap was installed on this call; ``False`` when
        the method had already been wrapped.
    """
    original = getattr(reader_cls, "handle_rx", None)
    if original is None:
        return False
    if getattr(original, _PATCH_MARKER, False):
        return False

    async def safe_handle_rx(self, data, *args, **kwargs):  # type: ignore[no-untyped-def]
        """Run the original ``handle_rx`` and convert hard failures to logs.

        A single malformed frame would otherwise kill the
        ``asyncio.create_task(reader.handle_rx(data))`` task spawned by the
        upstream connection layer, surfacing as ``Task exception was never
        retrieved`` in stderr and losing the event silently.  We log once
        with the first few bytes of the offending frame for forensics and
        then return ``None`` so the task exits cleanly.
        """
        try:
            return await original(self, data, *args, **kwargs)
        except Exception as exc:  # noqa: BLE001 — deliberately broad: a
            # single malformed frame must not kill the reader.  Narrower
            # excepts would hide future upstream failure modes (e.g.
            # ``struct.error``) the same way the current IndexError was
            # hidden before we added this shim.
            config._debug_log(
                "Suppressed meshcore reader exception on malformed frame",
                context="meshcore.reader.patch",
                severity="warning",
                always=True,
                error_class=type(exc).__name__,
                error_message=str(exc),
                packet_len=_safe_len(data),
                packet_hex=_hex_preview(data, _PACKET_LOG_MAX_BYTES),
            )
            return None

    setattr(safe_handle_rx, _PATCH_MARKER, True)
    # Preserve the pre-patch method under a stable name so operators and
    # future maintainers can revert the patch with one line.
    reader_cls._orig_handle_rx = original
    reader_cls.handle_rx = safe_handle_rx
    return True


def _safe_len(data: Any) -> int | None:
    """Return ``len(data)`` or ``None`` when the object is not sized."""
    try:
        return len(data)
    except TypeError:
        return None


def _hex_preview(data: Any, limit: int) -> str:
    """Return the first *limit* bytes of ``data`` as a lowercase hex string.

    Accepts anything that is a :class:`bytes`-like or supports ``bytes(data)``.
    On conversion failure returns an empty string — the log caller still gets
    the error class and message.
    """
    try:
        if not isinstance(data, (bytes, bytearray, memoryview)):
            data = bytes(data)
    except Exception:  # noqa: BLE001 — pure diagnostic path, never raise.
        return ""
    prefix = bytes(data[:limit])
    return prefix.hex()


__all__ = ["apply"]
