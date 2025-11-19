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

import inspect
import signal
import threading
import time

from pubsub import pub

from . import config, handlers, interfaces

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
    nodes_obj, retries: int = 3
) -> list[tuple[str, object]] | None:
    """Snapshot ``nodes_obj`` to avoid iteration errors during updates.

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
        for _ in range(max(1, retries)):
            try:
                return list(items_callable())
            except RuntimeError as err:
                if "dictionary changed size during iteration" not in str(err):
                    raise
                time.sleep(0)
        return None

    if hasattr(nodes_obj, "__iter__") and hasattr(nodes_obj, "__getitem__"):
        for _ in range(max(1, retries)):
            try:
                keys = list(nodes_obj)
                return [(key, nodes_obj[key]) for key in keys]
            except RuntimeError as err:
                if "dictionary changed size during iteration" not in str(err):
                    raise
                time.sleep(0)
        return None

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


def main(existing_interface=None) -> None:
    """Run the mesh ingestion daemon until interrupted."""

    subscribed = _subscribe_receive_topics()
    if subscribed:
        config._debug_log(
            "Subscribed to receive topics",
            context="daemon.subscribe",
            severity="info",
            topics=subscribed,
        )

    iface = existing_interface
    resolved_target = None
    retry_delay = max(0.0, config._RECONNECT_INITIAL_DELAY_SECS)

    stop = threading.Event()
    initial_snapshot_sent = False
    energy_session_deadline = None
    iface_connected_at: float | None = None
    last_seen_packet_monotonic = handlers.last_packet_monotonic()
    last_inactivity_reconnect: float | None = None
    inactivity_reconnect_secs = max(
        0.0, getattr(config, "_INACTIVITY_RECONNECT_SECS", 0.0)
    )

    energy_saving_enabled = config.ENERGY_SAVING
    energy_online_secs = max(0.0, config._ENERGY_ONLINE_DURATION_SECS)
    energy_sleep_secs = max(0.0, config._ENERGY_SLEEP_SECS)

    def _energy_sleep(reason: str) -> None:
        if not energy_saving_enabled or energy_sleep_secs <= 0:
            return
        if config.DEBUG:
            config._debug_log(
                f"energy saving: {reason}; sleeping for {energy_sleep_secs:g}s"
            )
        stop.wait(energy_sleep_secs)

    def handle_sigterm(*_args) -> None:
        stop.set()

    def handle_sigint(signum, frame) -> None:
        if stop.is_set():
            signal.default_int_handler(signum, frame)
            return
        stop.set()

    if threading.current_thread() == threading.main_thread():
        signal.signal(signal.SIGINT, handle_sigint)
        signal.signal(signal.SIGTERM, handle_sigterm)

    target = config.INSTANCE or "(no POTATOMESH_INSTANCE)"
    configured_port = config.CONNECTION
    active_candidate = configured_port
    announced_target = False
    config._debug_log(
        "Mesh daemon starting",
        context="daemon.main",
        severity="info",
        target=target,
        port=configured_port or "auto",
        channel=config.CHANNEL_INDEX,
    )
    try:
        while not stop.is_set():
            if iface is None:
                try:
                    if active_candidate:
                        iface, resolved_target = interfaces._create_serial_interface(
                            active_candidate
                        )
                    else:
                        iface, resolved_target = interfaces._create_default_interface()
                        active_candidate = resolved_target
                    interfaces._ensure_radio_metadata(iface)
                    interfaces._ensure_channel_metadata(iface)
                    handlers.register_host_node_id(
                        interfaces._extract_host_node_id(iface)
                    )
                    retry_delay = max(0.0, config._RECONNECT_INITIAL_DELAY_SECS)
                    initial_snapshot_sent = False
                    if not announced_target and resolved_target:
                        config._debug_log(
                            "Using mesh interface",
                            context="daemon.interface",
                            severity="info",
                            target=resolved_target,
                        )
                        announced_target = True
                    if energy_saving_enabled and energy_online_secs > 0:
                        energy_session_deadline = time.monotonic() + energy_online_secs
                    else:
                        energy_session_deadline = None
                    iface_connected_at = time.monotonic()
                    # Seed the inactivity tracking from the connection time so a
                    # reconnect is given a full inactivity window even when the
                    # handler still reports the previous packet timestamp.
                    last_seen_packet_monotonic = iface_connected_at
                    last_inactivity_reconnect = None
                except interfaces.NoAvailableMeshInterface as exc:
                    config._debug_log(
                        "No mesh interface available",
                        context="daemon.interface",
                        severity="error",
                        error_message=str(exc),
                    )
                    _close_interface(iface)
                    raise SystemExit(1) from exc
                except Exception as exc:
                    candidate_desc = active_candidate or "auto"
                    config._debug_log(
                        "Failed to create mesh interface",
                        context="daemon.interface",
                        severity="warn",
                        candidate=candidate_desc,
                        error_class=exc.__class__.__name__,
                        error_message=str(exc),
                    )
                    if configured_port is None:
                        active_candidate = None
                        announced_target = False
                    stop.wait(retry_delay)
                    if config._RECONNECT_MAX_DELAY_SECS > 0:
                        retry_delay = min(
                            (
                                retry_delay * 2
                                if retry_delay
                                else config._RECONNECT_INITIAL_DELAY_SECS
                            ),
                            config._RECONNECT_MAX_DELAY_SECS,
                        )
                    continue

            if energy_saving_enabled and iface is not None:
                if (
                    energy_session_deadline is not None
                    and time.monotonic() >= energy_session_deadline
                ):
                    config._debug_log(
                        "Energy saving disconnect",
                        context="daemon.energy",
                        severity="info",
                    )
                    _close_interface(iface)
                    iface = None
                    announced_target = False
                    initial_snapshot_sent = False
                    energy_session_deadline = None
                    _energy_sleep("disconnected after session")
                    continue
                if (
                    _is_ble_interface(iface)
                    and getattr(iface, "client", object()) is None
                ):
                    config._debug_log(
                        "Energy saving BLE disconnect",
                        context="daemon.energy",
                        severity="info",
                    )
                    _close_interface(iface)
                    iface = None
                    announced_target = False
                    initial_snapshot_sent = False
                    energy_session_deadline = None
                    _energy_sleep("BLE client disconnected")
                    continue

            if not initial_snapshot_sent:
                try:
                    nodes = getattr(iface, "nodes", {}) or {}
                    node_items = _node_items_snapshot(nodes)
                    if node_items is None:
                        config._debug_log(
                            "Skipping node snapshot due to concurrent modification",
                            context="daemon.snapshot",
                        )
                    else:
                        processed_snapshot_item = False
                        for node_id, node in node_items:
                            processed_snapshot_item = True
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
                        if processed_snapshot_item:
                            initial_snapshot_sent = True
                except Exception as exc:
                    config._debug_log(
                        "Snapshot refresh failed",
                        context="daemon.snapshot",
                        severity="warn",
                        error_class=exc.__class__.__name__,
                        error_message=str(exc),
                    )
                    _close_interface(iface)
                    iface = None
                    stop.wait(retry_delay)
                    if config._RECONNECT_MAX_DELAY_SECS > 0:
                        retry_delay = min(
                            (
                                retry_delay * 2
                                if retry_delay
                                else config._RECONNECT_INITIAL_DELAY_SECS
                            ),
                            config._RECONNECT_MAX_DELAY_SECS,
                        )
                    continue

            if iface is not None and inactivity_reconnect_secs > 0:
                now_monotonic = time.monotonic()
                iface_activity = handlers.last_packet_monotonic()
                if (
                    iface_activity is not None
                    and iface_connected_at is not None
                    and iface_activity < iface_connected_at
                ):
                    iface_activity = iface_connected_at
                if iface_activity is not None and (
                    last_seen_packet_monotonic is None
                    or iface_activity > last_seen_packet_monotonic
                ):
                    last_seen_packet_monotonic = iface_activity
                    last_inactivity_reconnect = None

                latest_activity = iface_activity
                if latest_activity is None and iface_connected_at is not None:
                    latest_activity = iface_connected_at
                if latest_activity is None:
                    latest_activity = now_monotonic

                inactivity_elapsed = now_monotonic - latest_activity

                connected_attr = getattr(iface, "isConnected", None)
                believed_disconnected = False
                connected_state = _connected_state(connected_attr)
                if connected_state is None:
                    if callable(connected_attr):
                        try:
                            believed_disconnected = not bool(connected_attr())
                        except Exception:
                            believed_disconnected = False
                    elif connected_attr is not None:
                        try:
                            believed_disconnected = not bool(connected_attr)
                        except Exception:  # pragma: no cover - defensive guard
                            believed_disconnected = False
                else:
                    believed_disconnected = not connected_state

                should_reconnect = believed_disconnected or (
                    inactivity_elapsed >= inactivity_reconnect_secs
                )

                if should_reconnect:
                    if (
                        last_inactivity_reconnect is None
                        or now_monotonic - last_inactivity_reconnect
                        >= inactivity_reconnect_secs
                    ):
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
                        last_inactivity_reconnect = now_monotonic
                        _close_interface(iface)
                        iface = None
                        announced_target = False
                        initial_snapshot_sent = False
                        energy_session_deadline = None
                        iface_connected_at = None
                        continue

            retry_delay = max(0.0, config._RECONNECT_INITIAL_DELAY_SECS)
            stop.wait(config.SNAPSHOT_SECS)
    except KeyboardInterrupt:  # pragma: no cover - interactive only
        config._debug_log(
            "Received KeyboardInterrupt; shutting down",
            context="daemon.main",
            severity="info",
        )
        stop.set()
    finally:
        _close_interface(iface)


__all__ = [
    "_RECEIVE_TOPICS",
    "_event_wait_allows_default_timeout",
    "_node_items_snapshot",
    "_subscribe_receive_topics",
    "_is_ble_interface",
    "_connected_state",
    "main",
]
