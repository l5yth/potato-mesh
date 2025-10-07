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


def _event_wait_allows_default_timeout() -> bool:
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
    subscribed = _subscribe_receive_topics()
    if config.DEBUG and subscribed:
        config._debug_log(f"subscribed to receive topics: {', '.join(subscribed)}")

    iface = None
    resolved_target = None
    retry_delay = max(0.0, config._RECONNECT_INITIAL_DELAY_SECS)

    stop = threading.Event()
    initial_snapshot_sent = False

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
            if iface is None:
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
