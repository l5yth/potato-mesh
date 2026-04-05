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

"""Protocol implementations.

This package contains protocol-specific implementations (Meshtastic,
MeshCore, and others in the future).
"""

from __future__ import annotations

from .meshtastic import MeshtasticProvider


def __getattr__(name: str) -> object:
    """Lazy-load protocol classes and exceptions that carry optional heavy dependencies.

    ``MeshcoreProvider`` and ``ClosedBeforeConnectedError`` are imported on
    demand so that the MeshCore library (once wired in) is not loaded at
    startup when ``PROTOCOL=meshtastic``.
    """
    if name == "MeshcoreProvider":
        from .meshcore import MeshcoreProvider

        return MeshcoreProvider
    if name == "ClosedBeforeConnectedError":
        from .meshcore import ClosedBeforeConnectedError

        return ClosedBeforeConnectedError
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


__all__ = ["MeshtasticProvider", "MeshcoreProvider", "ClosedBeforeConnectedError"]
