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

"""Runtime entry point for the mesh ingestor."""

from __future__ import annotations

import dataclasses
import inspect
import signal
import threading
import time

from pubsub import pub

from . import config, handlers, ingestors, interfaces
from .provider import Provider
from .utils import _retry_dict_snapshot

_RECEIVE_TOPICS = (
    "meshtastic.receive",
    "meshtastic.receive.text",
    "meshtastic.receive.position",
    "meshtastic.receive.user",
    "meshtastic.receive.POSITION_APP",
    "meshtastic.receive.NODEINFO_APP",
    "meshtastic.receive.NEIGHBORINFO_APP",
    "meshtastic.receive.TEXT_MESSAGE_APP",
    "meshtastic.receive.REACTION_APP",
    "meshtastic.receive.TELEMETRY_APP",
    "meshtastic.receive.TRACEROUTE_APP",
)


def _event_wait_allows_default_timeout() -> bool:
    """Return ``True`` when :meth:`threading.Event.wait` accepts ``timeout``.

    The behaviour changed between Python versions; this helper shields the
    daemon from ``TypeError`` when the default timeout parameter is absent.
    """

    try:
        wait_signature = inspect.signature(threading.Event.wait)
    except (TypeError, ValueError):  # pragma: no cover
        return True

    parameters = list(wait_signature.parameters.values())
    if len(parameters) <= 1:
        return True

    timeout_parameter = parameters[1]
    if timeout_parameter.kind in (
        inspect.Parameter.VAR_POSITIONAL,
        inspect.Parameter.VAR_KEYWORD,
    ):
        return True

    return timeout_parameter.default is not inspect._empty


def _subscribe_receive_topics() -> list[str]:
    """Subscribe the packet handler to all receive-related pubsub topics."""

    subscribed = []
    for topic in _RECEIVE_TOPICS:
        try:
            pub.subscribe(handlers.on_receive, topic)
            subscribed.append(topic)
        except Exception as exc:  # pragma: no cover
            config._debug_log(f"failed to subscribe to {topic!r}: {exc}")
    return subscribed


def _node_items_snapshot(
    nodes_obj: object, retries: int = 3
) -> list[tuple[str, object]] | None:
    """Snapshot ``nodes_obj`` to avoid iteration errors during updates.

    Uses :func:`~data.mesh_ingestor.utils._retry_dict_snapshot` to handle
    both dict-like objects (``items()`` callable) and sequence-like objects
    (``__iter__`` + ``__getitem__``) that Meshtastic may return depending on
    firmware version.

    Parameters:
        nodes_obj: Meshtastic nodes mapping or iterable.
        retries: Number of attempts when encountering "dictionary changed"
            runtime errors.

    Returns:
        A list of ``(node_id, node)`` tuples, ``None`` when retries are
        exhausted, or an empty list when no nodes exist.
    """

    if not nodes_obj:
        return []

    items_callable = getattr(nodes_obj, "items", None)
    if callable(items_callable):
        return _retry_dict_snapshot(lambda: list(items_callable()), retries)

    if hasattr(nodes_obj, "__iter__") and hasattr(nodes_obj, "__getitem__"):

        def _snapshot_via_keys() -> list[tuple[str, object]]:
            keys = list(nodes_obj)
            return [(key, nodes_obj[key]) for key in keys]

        return _retry_dict_snapshot(_snapshot_via_keys, retries)

    return []


def _close_interface(iface_obj) -> None:
    """Close ``iface_obj`` while respecting configured timeouts."""

    if iface_obj is None:
        return

    def _do_close() -> None:
        try:
            iface_obj.close()
        except Exception as exc:  # pragma: no cover
            if config.DEBUG:
                config._debug_log(
                    "Error closing mesh interface",
                    context="daemon.close",
                    severity="warn",
                    error_class=exc.__class__.__name__,
                    error_message=str(exc),
                )

    if config._CLOSE_TIMEOUT_SECS <= 0 or not _event_wait_allows_default_timeout():
        _do_close()
        return

    close_thread = threading.Thread(target=_do_close, name="mesh-close", daemon=True)
    close_thread.start()
    close_thread.join(config._CLOSE_TIMEOUT_SECS)
    if close_thread.is_alive():
        config._debug_log(
            "Mesh interface close timed out",
            context="daemon.close",
            severity="warn",
            timeout_seconds=config._CLOSE_TIMEOUT_SECS,
        )


def _is_ble_interface(iface_obj) -> bool:
    """Return ``True`` when ``iface_obj`` appears to be a BLE interface."""

    if iface_obj is None:
        return False
    iface_cls = getattr(iface_obj, "__class__", None)
    if iface_cls is None:
        return False
    module_name = getattr(iface_cls, "__module__", "") or ""
    return "ble_interface" in module_name


def _process_ingestor_heartbeat(iface, *, ingestor_announcement_sent: bool) -> bool:
    """Send ingestor liveness heartbeats when a host id is known.

    Parameters:
        iface: Active mesh interface used to extract a host node id when absent.
        ingestor_announcement_sent: Whether an initial heartbeat has already
            been sent during the current session.

    Returns:
        Updated ``ingestor_announcement_sent`` flag reflecting whether an
        initial heartbeat was transmitted.
    """

    host_id = handlers.host_node_id()
    if host_id is None and iface is not None:
        extracted = interfaces._extract_host_node_id(iface)
        if extracted:
            handlers.register_host_node_id(extracted)
            host_id = handlers.host_node_id()

    if host_id:
        ingestors.set_ingestor_node_id(host_id)
    heartbeat_sent = ingestors.queue_ingestor_heartbeat(
        force=not ingestor_announcement_sent
    )
    if heartbeat_sent and not ingestor_announcement_sent:
        return True
    return ingestor_announcement_sent


def _connected_state(candidate) -> bool | None:
    """Return the connection state advertised by ``candidate``.

    Parameters:
        candidate: Attribute returned from ``iface.isConnected`` on a
            Meshtastic interface. The value may be a boolean, a callable that
            yields a boolean, or a :class:`threading.Event` instance.

    Returns:
        ``True`` when the interface is believed to be connected, ``False``
        when it appears disconnected, and ``None`` when the state cannot be
        determined from the provided attribute.
    """

    if candidate is None:
        return None

    if isinstance(candidate, threading.Event):
        return candidate.is_set()

    is_set_method = getattr(candidate, "is_set", None)
    if callable(is_set_method):
        try:
            return bool(is_set_method())
        except Exception:
            return None

    if callable(candidate):
        try:
            return bool(candidate())
        except Exception:
            return None

    try:
        return bool(candidate)
    except Exception:  # pragma: no cover - defensive guard
        return None


# ---------------------------------------------------------------------------
# Loop state container
# ---------------------------------------------------------------------------


@dataclasses.dataclass
class _DaemonState:
    """All mutable state for the :func:`main` daemon loop."""

    provider: Provider
    stop: threading.Event
    configured_port: str | None
    inactivity_reconnect_secs: float
    energy_saving_enabled: bool
    energy_online_secs: float
    energy_sleep_secs: float
    retry_delay: float
    last_seen_packet_monotonic: float | None
    active_candidate: str | None

    iface: object = None
    resolved_target: str | None = None
    initial_snapshot_sent: bool = False
    energy_session_deadline: float | None = None
    iface_connected_at: float | None = None
    last_inactivity_reconnect: float | None = None
    ingestor_announcement_sent: bool = False
    announced_target: bool = False


# ---------------------------------------------------------------------------
# Per-iteration helpers (each returns True when the caller should `continue`)
# ---------------------------------------------------------------------------


def _advance_retry_delay(current: float) -> float:
    """Return the next exponential-backoff retry delay."""

    if config._RECONNECT_MAX_DELAY_SECS <= 0:
        return current
    # `current == 0` on the very first call (bootstrap); seed from config.
    next_delay = current * 2 if current else config._RECONNECT_INITIAL_DELAY_SECS
    return min(next_delay, config._RECONNECT_MAX_DELAY_SECS)


def _energy_sleep(state: _DaemonState, reason: str) -> None:
    """Sleep for the configured energy-saving interval."""

    if not state.energy_saving_enabled or state.energy_sleep_secs <= 0:
        return
    if config.DEBUG:
        config._debug_log(
            f"energy saving: {reason}; sleeping for {state.energy_sleep_secs:g}s"
        )
    state.stop.wait(state.energy_sleep_secs)


def _try_connect(state: _DaemonState) -> bool:
    """Attempt to establish the mesh interface.

    Returns:
        ``True`` when connected and the loop should proceed; ``False`` when
        the connection failed and the caller should ``continue``.
    """

    try:
        state.iface, state.resolved_target, state.active_candidate = (
            state.provider.connect(active_candidate=state.active_candidate)
        )
        handlers.register_host_node_id(state.provider.extract_host_node_id(state.iface))
        ingestors.set_ingestor_node_id(handlers.host_node_id())
        state.retry_delay = max(0.0, config._RECONNECT_INITIAL_DELAY_SECS)
        state.initial_snapshot_sent = False
        if not state.announced_target and state.resolved_target:
            config._debug_log(
                "Using mesh interface",
                context="daemon.interface",
                severity="info",
                target=state.resolved_target,
            )
            state.announced_target = True
        # Set an absolute monotonic deadline for this energy-saving session.
        # When the deadline passes, _check_energy_saving() will close the
        # interface and sleep until the next wake interval.
        if state.energy_saving_enabled and state.energy_online_secs > 0:
            state.energy_session_deadline = time.monotonic() + state.energy_online_secs
        else:
            state.energy_session_deadline = None
        state.iface_connected_at = time.monotonic()
        # Seed the inactivity tracking from the connection time so a
        # reconnect is given a full inactivity window even when the
        # handler still reports the previous packet timestamp.
        state.last_seen_packet_monotonic = state.iface_connected_at
        state.last_inactivity_reconnect = None
        return True
    except interfaces.NoAvailableMeshInterface as exc:
        config._debug_log(
            "No mesh interface available",
            context="daemon.interface",
            severity="error",
            error_message=str(exc),
        )
        _close_interface(state.iface)
        raise SystemExit(1) from exc
    except Exception as exc:
        config._debug_log(
            "Failed to create mesh interface",
            context="daemon.interface",
            severity="warn",
            candidate=state.active_candidate or "auto",
            error_class=exc.__class__.__name__,
            error_message=str(exc),
        )
        if state.configured_port is None:
            state.active_candidate = None
            state.announced_target = False
        state.stop.wait(state.retry_delay)
        state.retry_delay = _advance_retry_delay(state.retry_delay)
        return False


def _check_energy_saving(state: _DaemonState) -> bool:
    """Disconnect and sleep when energy-saving conditions are met.

    Returns:
        ``True`` when the interface was closed and the caller should
        ``continue``; ``False`` otherwise.
    """

    if not state.energy_saving_enabled or state.iface is None:
        return False

    if (
        state.energy_session_deadline is not None
        and time.monotonic() >= state.energy_session_deadline
    ):
        reason = "disconnected after session"
        log_msg = "Energy saving disconnect"
    elif (
        _is_ble_interface(state.iface)
        and getattr(state.iface, "client", object()) is None
    ):
        reason = "BLE client disconnected"
        log_msg = "Energy saving BLE disconnect"
    else:
        return False
    config._debug_log(log_msg, context="daemon.energy", severity="info")
    _close_interface(state.iface)
    state.iface = None
    state.announced_target = False
    state.initial_snapshot_sent = False
    state.energy_session_deadline = None
    _energy_sleep(state, reason)
    return True


def _try_send_snapshot(state: _DaemonState) -> bool:
    """Send the initial node snapshot via the provider.

    Returns:
        ``True`` when the snapshot succeeded (or no nodes exist yet); ``False``
        when a hard error occurred and the caller should ``continue``.
    """

    try:
        node_items = state.provider.node_snapshot_items(state.iface)
        processed_any = False
        for node_id, node in node_items:
            processed_any = True
            try:
                handlers.upsert_node(node_id, node)
            except Exception as exc:
                config._debug_log(
                    "Failed to update node snapshot",
                    context="daemon.snapshot",
                    severity="warn",
                    node_id=node_id,
                    error_class=exc.__class__.__name__,
                    error_message=str(exc),
                )
                if config.DEBUG:
                    config._debug_log(
                        "Snapshot node payload",
                        context="daemon.snapshot",
                        node=node,
                    )
        if processed_any:
            state.initial_snapshot_sent = True
        return True
    except Exception as exc:
        config._debug_log(
            "Snapshot refresh failed",
            context="daemon.snapshot",
            severity="warn",
            error_class=exc.__class__.__name__,
            error_message=str(exc),
        )
        _close_interface(state.iface)
        state.iface = None
        state.stop.wait(state.retry_delay)
        state.retry_delay = _advance_retry_delay(state.retry_delay)
        return False


def _check_inactivity_reconnect(state: _DaemonState) -> bool:
    """Reconnect when the interface has been silent for too long.

    Returns:
        ``True`` when a reconnect was triggered and the caller should
        ``continue``; ``False`` otherwise.
    """

    if state.iface is None or state.inactivity_reconnect_secs <= 0:
        return False

    now = time.monotonic()
    iface_activity = handlers.last_packet_monotonic()

    if (
        iface_activity is not None
        and state.iface_connected_at is not None
        and iface_activity < state.iface_connected_at
    ):
        iface_activity = state.iface_connected_at

    if iface_activity is not None and (
        state.last_seen_packet_monotonic is None
        or iface_activity > state.last_seen_packet_monotonic
    ):
        state.last_seen_packet_monotonic = iface_activity
        state.last_inactivity_reconnect = None

    latest_activity = iface_activity
    if latest_activity is None and state.iface_connected_at is not None:
        latest_activity = state.iface_connected_at
    if latest_activity is None:
        latest_activity = now

    inactivity_elapsed = now - latest_activity
    believed_disconnected = (
        _connected_state(getattr(state.iface, "isConnected", None)) is False
    )

    if (
        not believed_disconnected
        and inactivity_elapsed < state.inactivity_reconnect_secs
    ):
        return False

    if (
        state.last_inactivity_reconnect is not None
        and now - state.last_inactivity_reconnect < state.inactivity_reconnect_secs
    ):
        return False

    reason = (
        "disconnected"
        if believed_disconnected
        else f"no data for {inactivity_elapsed:.0f}s"
    )
    config._debug_log(
        "Mesh interface inactivity detected",
        context="daemon.interface",
        severity="warn",
        reason=reason,
    )
    state.last_inactivity_reconnect = now
    _close_interface(state.iface)
    state.iface = None
    state.announced_target = False
    state.initial_snapshot_sent = False
    state.energy_session_deadline = None
    state.iface_connected_at = None
    return True


# ---------------------------------------------------------------------------
# Loop iteration helper
# ---------------------------------------------------------------------------


def _loop_iteration(state: _DaemonState) -> bool:
    """Execute one pass of the daemon main loop.

    Encapsulates the per-iteration ``continue`` decisions so that
    :func:`main` stays within the allowed cognitive-complexity budget.

    Returns:
        ``True`` when the loop should start the next iteration immediately
        (equivalent to a ``continue``); ``False`` when the full pass
        completed and the caller should sleep before iterating again.
    """

    if state.iface is None and not _try_connect(state):
        return True
    if _check_energy_saving(state):
        return True
    if not state.initial_snapshot_sent and not _try_send_snapshot(state):
        return True
    if _check_inactivity_reconnect(state):
        return True
    state.ingestor_announcement_sent = _process_ingestor_heartbeat(
        state.iface, ingestor_announcement_sent=state.ingestor_announcement_sent
    )
    state.retry_delay = max(0.0, config._RECONNECT_INITIAL_DELAY_SECS)
    return False


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main(*, provider: Provider | None = None) -> None:
    """Run the mesh ingestion daemon until interrupted."""

    if provider is None:
        if config.PROVIDER == "meshcore":
            from .providers.meshcore import MeshcoreProvider

            provider = MeshcoreProvider()
        else:
            from .providers.meshtastic import MeshtasticProvider

            provider = MeshtasticProvider()

    subscribed = provider.subscribe()
    if subscribed:
        config._debug_log(
            "Subscribed to receive topics",
            context="daemon.subscribe",
            severity="info",
            topics=subscribed,
        )

    state = _DaemonState(
        provider=provider,
        stop=threading.Event(),
        configured_port=config.CONNECTION,
        inactivity_reconnect_secs=max(
            0.0, getattr(config, "_INACTIVITY_RECONNECT_SECS", 0.0)
        ),
        energy_saving_enabled=config.ENERGY_SAVING,
        energy_online_secs=max(0.0, config._ENERGY_ONLINE_DURATION_SECS),
        energy_sleep_secs=max(0.0, config._ENERGY_SLEEP_SECS),
        retry_delay=max(0.0, config._RECONNECT_INITIAL_DELAY_SECS),
        last_seen_packet_monotonic=handlers.last_packet_monotonic(),
        active_candidate=config.CONNECTION,
    )

    def handle_sigterm(*_args) -> None:
        """Set the stop flag so the daemon loop exits cleanly on SIGTERM."""
        state.stop.set()

    def handle_sigint(signum, frame) -> None:
        """Handle SIGINT (Ctrl-C) with graceful-first, hard-exit-second behaviour.

        The first SIGINT sets the stop flag and lets the loop finish its
        current iteration.  A second SIGINT delegates to the default handler,
        which raises :class:`KeyboardInterrupt` and terminates immediately.
        """
        if state.stop.is_set():
            signal.default_int_handler(signum, frame)
            return
        state.stop.set()

    if threading.current_thread() == threading.main_thread():
        signal.signal(signal.SIGINT, handle_sigint)
        signal.signal(signal.SIGTERM, handle_sigterm)

    config._debug_log(
        "Mesh daemon starting",
        context="daemon.main",
        severity="info",
        target=config.INSTANCE or "(no INSTANCE_DOMAIN configured)",
        port=config.CONNECTION or "auto",
        channel=config.CHANNEL_INDEX,
    )

    try:
        while not state.stop.is_set():
            if not _loop_iteration(state):
                state.stop.wait(config.SNAPSHOT_SECS)
    except KeyboardInterrupt:  # pragma: no cover - interactive only
        config._debug_log(
            "Received KeyboardInterrupt; shutting down",
            context="daemon.main",
            severity="info",
        )
        state.stop.set()
    finally:
        _close_interface(state.iface)


__all__ = [
    "_RECEIVE_TOPICS",
    "_advance_retry_delay",
    "_loop_iteration",
    "_check_energy_saving",
    "_check_inactivity_reconnect",
    "_connected_state",
    "_energy_sleep",
    "_event_wait_allows_default_timeout",
    "_is_ble_interface",
    "_node_items_snapshot",
    "_process_ingestor_heartbeat",
    "_subscribe_receive_topics",
    "_try_connect",
    "_try_send_snapshot",
    "main",
]
