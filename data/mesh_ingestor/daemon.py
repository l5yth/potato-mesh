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
    "meshtastic.receive.TELEMETRY_APP",
)


_RECONNECT_INACTIVITY_SECS = 3600.0


class _ReconnectEvent:
    """Track state for hourly reconnect attempts."""

    __slots__ = ("reason", "next_attempt_at")

    def __init__(self) -> None:
        self.reason: str | None = None
        self.next_attempt_at: float = 0.0

    def set(self, reason: str, when: float) -> None:
        """Schedule a reconnect attempt for ``when`` due to ``reason``."""

        if self.reason == reason and self.next_attempt_at:
            self.next_attempt_at = max(self.next_attempt_at, when)
            return
        self.reason = reason
        self.next_attempt_at = when

    def clear(self) -> None:
        """Reset the reconnect state."""

        self.reason = None
        self.next_attempt_at = 0.0

    def due(self, now: float) -> bool:
        """Return ``True`` when a reconnect attempt is permitted."""

        if self.reason is None:
            return True
        return now >= self.next_attempt_at

    def defer(self, now: float) -> None:
        """Delay the next allowed reconnect attempt by one interval."""

        if self.reason is None:
            return
        self.next_attempt_at = now + _RECONNECT_INACTIVITY_SECS


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
                config._debug_log(f"error while closing mesh interface: {exc}")

    if config._CLOSE_TIMEOUT_SECS <= 0 or not _event_wait_allows_default_timeout():
        _do_close()
        return

    close_thread = threading.Thread(target=_do_close, name="mesh-close", daemon=True)
    close_thread.start()
    close_thread.join(config._CLOSE_TIMEOUT_SECS)
    if close_thread.is_alive():
        print(
            "[warn] mesh interface did not close within "
            f"{config._CLOSE_TIMEOUT_SECS:g}s; continuing shutdown"
        )


def main() -> None:
    """Run the mesh ingestion daemon until interrupted."""

    subscribed = _subscribe_receive_topics()
    if config.DEBUG and subscribed:
        config._debug_log(f"subscribed to receive topics: {', '.join(subscribed)}")

    iface = None
    resolved_target = None
    retry_delay = max(0.0, config._RECONNECT_INITIAL_DELAY_SECS)

    stop = threading.Event()
    initial_snapshot_sent = False
    reconnect_event = _ReconnectEvent()
    last_seen_stream_disconnect = interfaces._last_stream_disconnect_monotonic() or 0.0

    def handle_sigterm(*_args) -> None:
        stop.set()

    def handle_sigint(signum, frame) -> None:
        if stop.is_set():
            signal.default_int_handler(signum, frame)
            return
        stop.set()

    signal.signal(signal.SIGINT, handle_sigint)
    signal.signal(signal.SIGTERM, handle_sigterm)

    target = config.INSTANCE or "(no POTATOMESH_INSTANCE)"
    configured_port = config.PORT
    active_candidate = configured_port
    announced_target = False
    print(
        f"Mesh daemon: nodes+messages → {target} | port={configured_port or 'auto'} | channel={config.CHANNEL_INDEX}"
    )
    try:
        while not stop.is_set():
            now_monotonic = time.monotonic()
            stream_disconnect_monotonic = (
                interfaces._last_stream_disconnect_monotonic() or 0.0
            )
            if stream_disconnect_monotonic > last_seen_stream_disconnect:
                last_seen_stream_disconnect = stream_disconnect_monotonic
                if iface is not None:
                    print(
                        "[warn] mesh interface disconnected; scheduling hourly reconnect"
                    )
                    _close_interface(iface)
                    iface = None
                    announced_target = False
                    reconnect_event.set("disconnect", now_monotonic)

            if iface is None:
                if not reconnect_event.due(now_monotonic):
                    wait_for = reconnect_event.next_attempt_at - now_monotonic
                    if wait_for > 0:
                        stop.wait(min(config.SNAPSHOT_SECS, wait_for))
                    continue
                try:
                    if active_candidate:
                        iface, resolved_target = interfaces._create_serial_interface(
                            active_candidate
                        )
                    else:
                        iface, resolved_target = interfaces._create_default_interface()
                        active_candidate = resolved_target
                    retry_delay = max(0.0, config._RECONNECT_INITIAL_DELAY_SECS)
                    initial_snapshot_sent = False
                    reconnect_event.clear()
                    handlers._mark_receive_activity()
                    if not announced_target and resolved_target:
                        print(f"[info] using mesh interface: {resolved_target}")
                        announced_target = True
                except interfaces.NoAvailableMeshInterface as exc:
                    print(f"[error] {exc}")
                    _close_interface(iface)
                    raise SystemExit(1) from exc
                except Exception as exc:
                    candidate_desc = active_candidate or "auto"
                    print(
                        f"[warn] failed to create mesh interface ({candidate_desc}): {exc}"
                    )
                    if reconnect_event.reason:
                        now_retry = time.monotonic()
                        reconnect_event.defer(now_retry)
                        wait_for = max(0.0, reconnect_event.next_attempt_at - now_retry)
                        if wait_for > 0:
                            stop.wait(min(config.SNAPSHOT_SECS, wait_for))
                        continue
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

            now_monotonic = time.monotonic()
            if iface is not None:
                last_receive_monotonic = handlers._last_receive_monotonic()
                inactivity = now_monotonic - last_receive_monotonic
                if inactivity >= _RECONNECT_INACTIVITY_SECS:
                    print(
                        "[warn] no mesh data received for 3600s; scheduling hourly reconnect"
                    )
                    _close_interface(iface)
                    iface = None
                    announced_target = False
                    reconnect_event.set("inactivity", now_monotonic)
                    continue

            if not initial_snapshot_sent:
                try:
                    nodes = getattr(iface, "nodes", {}) or {}
                    node_items = _node_items_snapshot(nodes)
                    if node_items is None:
                        config._debug_log(
                            "skipping node snapshot; nodes changed during iteration"
                        )
                    else:
                        processed_snapshot_item = False
                        for node_id, node in node_items:
                            processed_snapshot_item = True
                            try:
                                handlers.upsert_node(node_id, node)
                            except Exception as exc:
                                print(
                                    f"[warn] failed to update node snapshot for {node_id}: {exc}"
                                )
                                if config.DEBUG:
                                    config._debug_log(f"node object: {node!r}")
                        if processed_snapshot_item:
                            initial_snapshot_sent = True
                except Exception as exc:
                    print(f"[warn] failed to update node snapshot: {exc}")
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

            retry_delay = max(0.0, config._RECONNECT_INITIAL_DELAY_SECS)
            stop.wait(config.SNAPSHOT_SECS)
    except KeyboardInterrupt:  # pragma: no cover - interactive only
        config._debug_log("received KeyboardInterrupt; shutting down")
        stop.set()
    finally:
        _close_interface(iface)


__all__ = [
    "_RECEIVE_TOPICS",
    "_event_wait_allows_default_timeout",
    "_node_items_snapshot",
    "_subscribe_receive_topics",
    "main",
]
