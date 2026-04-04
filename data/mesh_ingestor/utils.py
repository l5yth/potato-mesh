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

"""Shared utility helpers for the mesh ingestor package."""

from __future__ import annotations

import time
from typing import Callable, TypeVar

_T = TypeVar("_T")


def _retry_dict_snapshot(fn: Callable[[], _T], retries: int = 3) -> _T | None:
    """Call ``fn()`` retrying on concurrent dictionary-modification errors.

    Meshtastic's node dictionary is updated on a background thread. Iterating
    it can raise a :class:`RuntimeError` with the message "dictionary changed
    size during iteration".  This helper retries the call up to ``retries``
    times, yielding the thread scheduler between attempts via :func:`time.sleep`.

    Parameters:
        fn: Zero-argument callable that performs the iteration.
        retries: Maximum number of attempts before giving up.

    Returns:
        The return value of ``fn`` on success, or ``None`` when all retries are
        exhausted.
    """

    for _ in range(max(1, retries)):
        try:
            return fn()
        except RuntimeError as err:
            # Only retry the specific concurrent-modification error; re-raise
            # anything else so genuine bugs surface immediately.
            if "dictionary changed size during iteration" not in str(err):
                raise
            # Yield to the thread scheduler to let the mutating thread complete
            # before we attempt the snapshot again.
            time.sleep(0)
    return None


__all__ = ["_retry_dict_snapshot"]
