<!-- Copyright © 2025-26 l5yth & contributors -->
<!-- Licensed under the Apache License, Version 2.0 (see LICENSE) -->

## Mesh ingestor contracts (stable interfaces)

This repo’s ingestion pipeline is split into:

- **Python collector** (`data/mesh_ingestor/*`) which normalizes packets/events and POSTs JSON to the web app.
- **Sinatra web app** (`web/`) which accepts those payloads on `POST /api/*` ingest routes and persists them into SQLite tables defined under `data/*.sql`.

This document records the **contracts that future protocols must preserve**. The intent is to enable adding new protocols (MeshCore, Reticulum, …) without changing the Ruby/DB/UI read-side.

### Canonical node identity

- **Canonical node id**: `nodes.node_id` is a `TEXT` primary key and is treated as canonical across the system.
- **Format**: `!%08x` (lowercase hex, 8 chars), for example `!abcdef01`.
- **Normalization**:
  - Python currently normalizes via `data/mesh_ingestor/serialization.py:_canonical_node_id`.
  - Ruby normalizes via `web/lib/potato_mesh/application/data_processing.rb:canonical_node_parts`.
- **Dual addressing**: Ruby routes and queries accept either a canonical `!xxxxxxxx` string or a numeric node id; they normalize to `node_id`.

Note: non-Meshtastic protocols will need a strategy to map their native node identifiers into this `!%08x` space. That mapping is intentionally not standardized in code yet.

### Ingest HTTP routes and payload shapes

Future providers should emit payloads that match these shapes (keys + types), which are validated by existing tests (notably `tests/test_mesh.py`).

#### `POST /api/nodes`

Payload is a mapping keyed by canonical node id, with an optional top-level `”ingestor”` key:

- `{ “!abcdef01”: { ... node fields ... }, “ingestor”: “!ingestornodeid” }`

When `”ingestor”` is present the protocol is inherited from the registered ingestor (see `POST /api/ingestors`); omitting it defaults to `”meshtastic”`.

Node entry fields are “Meshtastic-ish” (camelCase) and may include:

- `num` (int node number)
- `lastHeard` (int unix seconds)
- `snr` (float)
- `hopsAway` (int)
- `isFavorite` (bool)
- `user` (mapping; e.g. `shortName`, `longName`, `macaddr`, `hwModel`, `publicKey`, `isUnmessagable`)
  - `role` (optional string) — omit when unknown; known values include Meshtastic role names (e.g. `CLIENT`, `ROUTER`) and MeshCore role names (`COMPANION`, `REPEATER`, `ROOM_SERVER`, `SENSOR`)
- `deviceMetrics` (mapping; e.g. `batteryLevel`, `voltage`, `channelUtilization`, `airUtilTx`, `uptimeSeconds`)
- `position` (mapping; `latitude`, `longitude`, `altitude`, `time`, `locationSource`, `precisionBits`, optional nested `raw`)
- Optional radio metadata: `lora_freq`, `modem_preset`

#### `POST /api/messages`

Single message payload:

- Required: `id` (int), `rx_time` (int), `rx_iso` (string)
- Identity: `from_id` (string/int), `to_id` (string/int), `channel` (int), `portnum` (string|nil)
- Payload: `text` (string|nil), `encrypted` (string|nil), `reply_id` (int|nil), `emoji` (string|nil)
- RF: `snr` (float|nil), `rssi` (int|nil), `hop_limit` (int|nil)
- Meta: `channel_name` (string; only when not encrypted and known), `ingestor` (canonical host id), `lora_freq`, `modem_preset`

**Cross-ingestor deduplication.** The `id` field is the sole dedup key — the server collapses repeat POSTs on the `messages.id` PRIMARY KEY. Protocols that lack a firmware-assigned packet ID MUST derive a stable, sender-side fingerprint so that the same physical transmission heard by multiple ingestors produces the same `id`. The id MUST fit in 53 bits (`0 <= id <= (1 << 53) - 1`) to round-trip through the JavaScript frontend without precision loss.

For MeshCore the canonical fingerprint is:

```
v1:<sender_identity>:<sender_timestamp>:<discriminator>:<text>
```

hashed with SHA-256 and truncated to 53 bits (first 7 bytes, masked). Components:

- `sender_identity` — for channel messages, the lowercased+stripped sender name parsed from a leading `SenderName:` prefix in the message text (split on the first colon, surrounding whitespace stripped); for direct messages, the sender's `pubkey_prefix` from the MeshCore event payload. Empty string when unavailable — when the channel-message text lacks any `SenderName:` prefix the dedup degrades and two distinct senders sharing timestamp + channel + text collide. In practice MeshCore clients always prefix the name; the residual risk is anonymous/malformed transmissions.
- `sender_timestamp` — Unix seconds from the sender's clock (identical across receivers).
- `discriminator` — `c<N>` for channel messages on channel `N`, `dm` for direct messages.
- `text` — the message text exactly as transmitted.

The `v1:` prefix lets the format evolve (e.g. add a channel-secret hash) without colliding with previously-written ids.

**Known limitations of the v1 fingerprint:**

- *Format-string ambiguity around `:`.* Components are joined with literal colons and not length-prefixed, so a colon embedded in `sender_identity` or `text` shifts the boundary between fields. In theory two distinct triples (e.g. `sender_identity="a:b"` vs `sender_identity="a"` with a leading `b:` in `text`) can produce the same fingerprint. In practice this is vanishingly rare — MeshCore sender names rarely contain colons and even then both senders would have to land on the same timestamp/channel — but a `v2` revision should switch to a delimiter that cannot appear in any component (e.g. `\x00`) or length-prefix each field.
- *meshcore_py text-decoding inconsistency.* The upstream `meshcore_py` reader strips trailing `\0` bytes on the real-time `CHANNEL_MSG_RECV` path but not on the sync-replay path. If the same physical message is heard once in real-time and once via sync-replay, the byte sequences differ → different fingerprints → duplicate row. Out of scope for the ingestor; track upstream.
- *Sender-side clock reset.* MeshCore nodes without an RTC start `sender_timestamp` from `0` after reboot. Two messages from the same sender containing the same text within one second of power-on collapse into a single row. Acceptable trade-off given the alternative (no dedup at all).
- *Relay-rewritten `sender_timestamp` (#756).* MeshCore has been observed delivering the same physical packet twice with a rewritten `sender_timestamp` (≈10 s later, same `from_id`/`channel`/`text`), which flips the v1 fingerprint and bypasses the `messages.id` PK collapse. To cover this, the web app runs an additional content-level dedup on insert: for `protocol = "meshcore"` with non-empty `text` and a known `from_id`, a second row matching `(from_id, to_id, channel, text)` within ±30 s of `rx_time` is dropped (window lives in `MESHCORE_CONTENT_DEDUP_WINDOW_SECONDS`). The window is ~3× the observed relay delta; legitimate rapid re-sends of identical short text (e.g. `hi`, `ack`, `ok`, `test`) from the same sender on the same channel **within 30 s** will be silently collapsed into one row. Ingestors MUST still produce deterministic v1 ids — this content-level layer is additive, not a replacement. Pre-existing duplicates are cleared once by a `PRAGMA user_version`-gated one-shot backfill on startup.
- *Concurrent-insert race (#756).* The content-dedup SELECT and the downstream INSERT are not currently wrapped in a shared transaction, so two concurrent Puma threads carrying the same content with different ids can both pass the pre-check and both insert. Duplicates produced this way are narrow (single-node multi-threaded ingest) and are not cleaned up on subsequent boots because the backfill is one-shot. If the race is ever observed in production, tighten `insert_message` to wrap the meshcore pre-check + id-PK path in `db.transaction(:immediate)`.
- *Upstream `meshcore` reader crash on truncated advertisements (#754).* `meshcore-py` 2.3.6 (latest at the time of writing) raises `IndexError` from `MessageReader.handle_rx` at `reader.py:365` when a `DEVICE_INFO`/advertisement frame declares `fw_ver >= 10` but omits the trailing `path_hash_mode` byte. Because the frame is parsed inside a detached `asyncio.create_task(...)`, the exception surfaces as `Task exception was never retrieved` on stderr and the event for that frame is lost. The ingestor installs a runtime patch (`data/mesh_ingestor/protocols/_meshcore_patches.py`) that wraps `handle_rx`, logs one line with the first 32 bytes of the offending frame under `context=meshcore.reader.patch`, and lets the task exit cleanly; a loop-level handler (`context=asyncio.unhandled`) catches anything the targeted patch misses. Both shims are additive and will be removed once upstream ships a defensive length check.

#### `POST /api/positions`

Single position payload:

- Required: `id` (int), `rx_time` (int), `rx_iso` (string)
- Node: `node_id` (canonical string), `node_num` (int|nil), `num` (int|nil), `from_id` (canonical string), `to_id` (string|nil)
- Position: `latitude`, `longitude`, `altitude` (floats|nil)
- Position time: `position_time` (int|nil)
- Quality: `location_source` (string|nil), `precision_bits` (int|nil), `sats_in_view` (int|nil), `pdop` (float|nil)
- Motion: `ground_speed` (float|nil), `ground_track` (float|nil)
- RF/meta: `snr`, `rssi`, `hop_limit`, `bitfield`, `payload_b64` (string|nil), `raw` (mapping|nil), `ingestor`, `lora_freq`, `modem_preset`

#### `POST /api/telemetry`

Single telemetry payload:

- Required: `id` (int), `rx_time` (int), `rx_iso` (string)
- Node: `node_id` (canonical string|nil), `node_num` (int|nil), `from_id`, `to_id`
- Time: `telemetry_time` (int|nil)
- Packet: `channel` (int), `portnum` (string|nil), `bitfield` (int|nil), `hop_limit` (int|nil)
- RF: `snr` (float|nil), `rssi` (int|nil)
- Raw: `payload_b64` (string; may be empty string when unknown)
- Metrics: many optional snake_case keys (`battery_level`, `voltage`, `temperature`, etc.)
- Subtype: `telemetry_type` (string|nil) — optional discriminator identifying which Meshtastic protobuf oneof was set; one of `"device"`, `"environment"`, `"power"`, or `"air_quality"`. Ingestors that detect the subtype SHOULD include this field; omit rather than send `null` when unknown. The web app infers the type from metric-field presence when absent, so old ingestors remain compatible.
- Meta: `ingestor`, `lora_freq`, `modem_preset`

#### `POST /api/neighbors`

Neighbors snapshot payload:

- Node: `node_id` (canonical string), `node_num` (int|nil)
- `neighbors`: list of entries with `neighbor_id` (canonical string), `neighbor_num` (int|nil), `snr` (float|nil), `rx_time` (int), `rx_iso` (string)
- Snapshot time: `rx_time`, `rx_iso`
- Optional: `node_broadcast_interval_secs` (int|nil), `last_sent_by_id` (canonical string|nil)
- Meta: `ingestor`, `lora_freq`, `modem_preset`

#### `POST /api/traces`

Single trace payload:

- Identity: `id` (int|nil), `request_id` (int|nil)
- Endpoints: `src` (int|nil), `dest` (int|nil)
- Path: `hops` (list[int])
- Time: `rx_time` (int), `rx_iso` (string)
- Metrics: `rssi` (int|nil), `snr` (float|nil), `elapsed_ms` (int|nil)
- Meta: `ingestor`, `lora_freq`, `modem_preset`

#### `POST /api/ingestors`

Heartbeat payload:

- `node_id` (canonical string)
- `start_time` (int), `last_seen_time` (int)
- `version` (string)
- Optional: `lora_freq`, `modem_preset`
- Optional: `protocol` (string; e.g. `"meshtastic"`, `"meshcore"`) — declares the mesh backend for this ingestor; defaults to `"meshtastic"` when absent

**Protocol propagation**: all event records (`messages`, `positions`, `telemetry`, `traces`, `neighbors`) that reference this ingestor via their `ingestor` field will inherit its `protocol` value at write time.

### GET endpoint filtering

All collection GET endpoints (`/api/nodes`, `/api/messages`, `/api/positions`, `/api/telemetry`, `/api/traces`, `/api/neighbors`, `/api/ingestors`) accept an optional `?protocol=<value>` query parameter. When present, only records whose `protocol` column matches the given value are returned. The `protocol` field is included in all GET responses.

