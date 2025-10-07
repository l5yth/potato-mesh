"""PotatoMesh mesh daemon helpers."""

from __future__ import annotations

import base64
import dataclasses
import glob
import heapq
import inspect
import ipaddress
import itertools
import json
import math
import os
import re
import signal
import threading
import time
import urllib
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Mapping
from functools import lru_cache
from typing import TYPE_CHECKING

from pubsub import pub

from .config import (
    API_TOKEN,
    CHANNEL_INDEX,
    DEBUG,
    INSTANCE,
    PORT,
    SNAPSHOT_SECS,
    _CLOSE_TIMEOUT_SECS,
    _RECONNECT_INITIAL_DELAY_SECS,
    _RECONNECT_MAX_DELAY_SECS,
    _debug_log,
)
from .daemon import (
    _RECEIVE_TOPICS,
    _event_wait_allows_default_timeout,
    _node_items_snapshot,
    _subscribe_receive_topics,
    main,
    on_receive,
)
from .interfaces import (
    BLEInterface,
    NoAvailableMeshInterface,
    SerialInterface,
    TCPInterface,
    _BLE_ADDRESS_RE,
    _DEFAULT_SERIAL_PATTERNS,
    _DEFAULT_TCP_PORT,
    _DEFAULT_TCP_TARGET,
    _DummySerialInterface,
    _create_default_interface,
    _create_serial_interface,
    _default_serial_targets,
    _load_ble_interface,
    _parse_ble_target,
    _parse_network_target,
)
from .packets import (
    DecodeError,
    MessageToDict,
    ProtoMessage,
    _canonical_node_id,
    _coerce_float,
    _coerce_int,
    _decode_nodeinfo_payload,
    _extract_payload_bytes,
    _first,
    _get,
    _iso,
    _merge_mappings,
    _node_num_from_id,
    _node_to_dict,
    _nodeinfo_metrics_dict,
    _nodeinfo_position_dict,
    _nodeinfo_user_dict,
    _pkt_to_dict,
    store_neighborinfo_packet,
    store_nodeinfo_packet,
    store_packet_dict,
    store_position_packet,
    store_telemetry_packet,
    upsert_node,
)
from .post_queue import (
    _DEFAULT_POST_PRIORITY,
    _MESSAGE_POST_PRIORITY,
    _NEIGHBOR_POST_PRIORITY,
    _NODE_POST_PRIORITY,
    _POST_QUEUE,
    _POST_QUEUE_ACTIVE,
    _POST_QUEUE_COUNTER,
    _POST_QUEUE_LOCK,
    _POSITION_POST_PRIORITY,
    _TELEMETRY_POST_PRIORITY,
    _clear_post_queue,
    _drain_post_queue,
    _enqueue_post_json,
    _post_json,
    _queue_post_json,
)

__all__ = [
    "API_TOKEN",
    "BLEInterface",
    "CHANNEL_INDEX",
    "DEBUG",
    "DecodeError",
    "INSTANCE",
    "MessageToDict",
    "Mapping",
    "NoAvailableMeshInterface",
    "PORT",
    "ProtoMessage",
    "SNAPSHOT_SECS",
    "SerialInterface",
    "TCPInterface",
    "TYPE_CHECKING",
    "_BLE_ADDRESS_RE",
    "_CLOSE_TIMEOUT_SECS",
    "_DEFAULT_POST_PRIORITY",
    "_DEFAULT_SERIAL_PATTERNS",
    "_DEFAULT_TCP_PORT",
    "_DEFAULT_TCP_TARGET",
    "_DummySerialInterface",
    "_MESSAGE_POST_PRIORITY",
    "_NEIGHBOR_POST_PRIORITY",
    "_NODE_POST_PRIORITY",
    "_POST_QUEUE",
    "_POST_QUEUE_ACTIVE",
    "_POST_QUEUE_COUNTER",
    "_POST_QUEUE_LOCK",
    "_POSITION_POST_PRIORITY",
    "_RECEIVE_TOPICS",
    "_RECONNECT_INITIAL_DELAY_SECS",
    "_RECONNECT_MAX_DELAY_SECS",
    "_TELEMETRY_POST_PRIORITY",
    "_canonical_node_id",
    "_clear_post_queue",
    "_coerce_float",
    "_coerce_int",
    "_decode_nodeinfo_payload",
    "_default_serial_targets",
    "_drain_post_queue",
    "_enqueue_post_json",
    "_event_wait_allows_default_timeout",
    "_extract_payload_bytes",
    "_first",
    "_get",
    "_iso",
    "_load_ble_interface",
    "_merge_mappings",
    "_node_items_snapshot",
    "_node_num_from_id",
    "_node_to_dict",
    "_nodeinfo_metrics_dict",
    "_nodeinfo_position_dict",
    "_nodeinfo_user_dict",
    "_parse_ble_target",
    "_parse_network_target",
    "_pkt_to_dict",
    "_post_json",
    "_queue_post_json",
    "_subscribe_receive_topics",
    "_debug_log",
    "base64",
    "dataclasses",
    "glob",
    "heapq",
    "inspect",
    "ipaddress",
    "itertools",
    "json",
    "lru_cache",
    "main",
    "math",
    "on_receive",
    "os",
    "pub",
    "re",
    "signal",
    "store_neighborinfo_packet",
    "store_nodeinfo_packet",
    "store_packet_dict",
    "store_position_packet",
    "store_telemetry_packet",
    "threading",
    "time",
    "upsert_node",
    "urllib",
    "urllib.error",
    "urllib.parse",
    "urllib.request",
]
