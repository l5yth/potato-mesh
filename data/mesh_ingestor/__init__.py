"""High-level API for the potato-mesh ingestor."""

from __future__ import annotations

import signal as signal  # re-exported for compatibility
import threading as threading  # re-exported for compatibility
import sys
import types

from . import config, daemon, handlers, interfaces, queue, serialization

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


for _module in (daemon, handlers, interfaces, queue, serialization):
    _reexport(_module)

_export_constants()

_CONFIG_ATTRS = {
    "PORT",
    "SNAPSHOT_SECS",
    "CHANNEL_INDEX",
    "DEBUG",
    "INSTANCE",
    "API_TOKEN",
    "_RECONNECT_INITIAL_DELAY_SECS",
    "_RECONNECT_MAX_DELAY_SECS",
    "_CLOSE_TIMEOUT_SECS",
    "_debug_log",
}

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
        if name in _CONFIG_ATTRS:
            return getattr(config, name)
        if name in _INTERFACE_ATTRS:
            return getattr(interfaces, name)
        if name in _INTERFACE_EXPORTS:
            return getattr(interfaces, name)
        raise AttributeError(name)

    def __setattr__(self, name: str, value):  # type: ignore[override]
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
