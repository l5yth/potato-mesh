# Copyright (C) 2025 l5yth
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

"""High-level API for the potato-mesh ingestor."""

from __future__ import annotations

import signal as signal  # re-exported for compatibility
import threading as threading  # re-exported for compatibility
import sys
import types

from . import channels, config, daemon, handlers, interfaces, queue, serialization

__all__: list[str] = []


def _reexport(module) -> None:
    names = getattr(module, "__all__", [])
    for name in names:
        globals()[name] = getattr(module, name)
    __all__.extend(names)


def _export_constants() -> None:
    globals()["json"] = queue.json
    globals()["urllib"] = queue.urllib
    globals()["glob"] = interfaces.glob
    __all__.extend(["json", "urllib", "glob", "threading", "signal"])


for _module in (channels, daemon, handlers, interfaces, queue, serialization):
    _reexport(_module)

_export_constants()

_CONFIG_ATTRS = {
    "CONNECTION",
    "SNAPSHOT_SECS",
    "CHANNEL_INDEX",
    "DEBUG",
    "INSTANCE",
    "API_TOKEN",
    "LORA_FREQ",
    "MODEM_PRESET",
    "_RECONNECT_INITIAL_DELAY_SECS",
    "_RECONNECT_MAX_DELAY_SECS",
    "_CLOSE_TIMEOUT_SECS",
    "_debug_log",
}

# Legacy export maintained for backwards compatibility.
_CONFIG_ATTRS.add("PORT")

_INTERFACE_ATTRS = {"BLEInterface", "SerialInterface", "TCPInterface"}

_QUEUE_ATTRS = set(queue.__all__)
_HANDLER_ATTRS = set(handlers.__all__)
_DAEMON_ATTRS = set(daemon.__all__)
_SERIALIZATION_ATTRS = set(serialization.__all__)
_INTERFACE_EXPORTS = set(interfaces.__all__)

__all__.extend(sorted(_CONFIG_ATTRS))
__all__.extend(sorted(_INTERFACE_ATTRS))


class _MeshIngestorModule(types.ModuleType):
    """Module proxy that forwards config and interface state."""

    def __getattr__(self, name: str):  # type: ignore[override]
        """Resolve attributes by delegating to the underlying submodules."""

        if name in _CONFIG_ATTRS:
            return getattr(config, name)
        if name in _INTERFACE_ATTRS:
            return getattr(interfaces, name)
        if name in _INTERFACE_EXPORTS:
            return getattr(interfaces, name)
        raise AttributeError(name)

    def __setattr__(self, name: str, value):  # type: ignore[override]
        """Propagate assignments to the appropriate submodule."""

        if name in _CONFIG_ATTRS:
            setattr(config, name, value)
            super().__setattr__(name, value)
            return
        if name in _INTERFACE_ATTRS:
            setattr(interfaces, name, value)
            super().__setattr__(name, value)
            return
        handled = False
        if name in _INTERFACE_EXPORTS:
            setattr(interfaces, name, value)
            super().__setattr__(name, getattr(interfaces, name, value))
            handled = True
        if name in _QUEUE_ATTRS:
            setattr(queue, name, value)
            super().__setattr__(name, getattr(queue, name, value))
            handled = True
        if name in _HANDLER_ATTRS:
            setattr(handlers, name, value)
            super().__setattr__(name, getattr(handlers, name, value))
            handled = True
        if name in _DAEMON_ATTRS:
            setattr(daemon, name, value)
            super().__setattr__(name, getattr(daemon, name, value))
            handled = True
        if name in _SERIALIZATION_ATTRS:
            setattr(serialization, name, value)
            super().__setattr__(name, getattr(serialization, name, value))
            handled = True
        if handled:
            return
        super().__setattr__(name, value)


sys.modules[__name__].__class__ = _MeshIngestorModule
