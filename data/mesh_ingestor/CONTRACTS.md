## Mesh ingestor contracts (stable interfaces)

This repo’s ingestion pipeline is split into:

- **Python collector** (`data/mesh_ingestor/*`) which normalizes packets/events and POSTs JSON to the web app.
- **Sinatra web app** (`web/`) which accepts those payloads on `POST /api/*` ingest routes and persists them into SQLite tables defined under `data/*.sql`.

This document records the **contracts that future providers must preserve**. The intent is to enable adding new providers (MeshCore, Reticulum, …) without changing the Ruby/DB/UI read-side.

### Canonical node identity

- **Canonical node id**: `nodes.node_id` is a `TEXT` primary key and is treated as canonical across the system.
- **Format**: `!%08x` (lowercase hex, 8 chars), for example `!abcdef01`.
- **Normalization**:
  - Python currently normalizes via `data/mesh_ingestor/serialization.py:_canonical_node_id`.
  - Ruby normalizes via `web/lib/potato_mesh/application/data_processing.rb:canonical_node_parts`.
- **Dual addressing**: Ruby routes and queries accept either a canonical `!xxxxxxxx` string or a numeric node id; they normalize to `node_id`.

Note: non-Meshtastic providers will need a strategy to map their native node identifiers into this `!%08x` space. That mapping is intentionally not standardized in code yet.

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

