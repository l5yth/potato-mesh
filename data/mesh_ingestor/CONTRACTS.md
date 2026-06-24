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

Payload is a mapping keyed by canonical node id, with optional top-level `”ingestor”` and `”protocol”` keys:

- `{ “!abcdef01”: { ... node fields ... }, “ingestor”: “!ingestornodeid”, “protocol”: “meshcore” }`

Protocol resolution per-row honours, in order: (1) an explicit per-node `”protocol”` field inside the node entry; (2) the wrapper-level top-level `”protocol”` key; (3) the registered ingestor's protocol (see `POST /api/ingestors`); (4) `”meshtastic”` as the final default. Valid values are `”meshtastic”` and `”meshcore”` — values outside this set fall through to the next source. The wrapper stamp is what the Python ingestor emits unconditionally so the web app classifies records correctly even before the ingestor heartbeat is processed (closes the startup race that misclassified MeshCore placeholders as Meshtastic).

Node entry fields are “Meshtastic-ish” (camelCase) and may include the following.
**As of 0.7.0 each field is additionally accepted in snake_case** (e.g.
`last_heard`, `user.short_name`, `user.hw_model`, `device_metrics.battery_level`,
`position.location_source`) so the node ingest contract is no longer
Meshtastic-camelCase-only; the existing collector keeps emitting camelCase, which
remains accepted. Per-field acceptance is nil-aware, so a camelCase value of
`false` is never overridden by a snake_case alias. Fields:

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

**Sentinel handling (issue #782).** Meshtastic firmware emits `(latitude=0, longitude=0)` and `time=0` whenever the GPS module has not produced a fresh fix. Ingestors MUST normalise these sentinels before POSTing:

- `position.time <= 0` → omit the key entirely.
- `position.latitude == 0 AND position.longitude == 0` (within ±1e-9°) → omit `latitude`, `longitude`, `altitude`, and `locationSource` together; the remaining `precisionBits` / nested `raw` may still ride along.
- Single-axis zeros (`latitude == 0` *or* `longitude == 0` but not both) are legitimate equator / prime-meridian fixes and MUST be preserved.

The web application applies the same normalisation as a safety net so legacy ingestors and replayed payloads cannot reintroduce the sentinels, but new ingestors should strip them at the source so the cross-network contract stays clean.

**Wire-format note for federation peers (issue #782).** Position time is exposed **only** as `position_time` (unix seconds) on GET responses (`/api/nodes`, `/api/positions`); the redundant ISO twin (`pos_time_iso` on `/api/nodes`, `position_time_iso` on `/api/positions`) was **removed in 0.7.0** — clients format `position_time` themselves. Sentinel rows are compacted by **omitting** `position_time` rather than emitting `0` or `"1970-01-01T00:00:00Z"`. Federation peers consuming this API and any third-party clients SHOULD treat an *absent* `position_time` as "no GPS lock recorded" and not synthesise a zero or epoch value when re-serialising. Older peers that key on `position_time == 0` may need a small adjustment.

#### `POST /api/messages`

Single message payload:

- Required: `id` (int), `rx_time` (int), `rx_iso` (string)
- Identity: `from_id` (string/int), `to_id` (string/int), `channel` (int), `portnum` (string|nil)
- Payload: `text` (string|nil), `encrypted` (string|nil), `reply_id` (int|nil), `emoji` (string|nil)
- RF: `snr` (float|nil), `rssi` (int|nil), `hop_limit` (int|nil)
- Meta: `channel_name` (string; only when not encrypted and known), `ingestor` (canonical host id), `lora_freq`, `modem_preset`
- `protocol` (optional string; `"meshtastic"` or `"meshcore"`) — explicit per-record protocol stamp. Takes precedence over the value inherited from the registered ingestor; values outside the whitelist fall back to the ingestor lookup, then to `"meshtastic"`. Ingestors SHOULD stamp this on every message so the web app classifies senders correctly even before the ingestor heartbeat is processed.

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
- `protocol` (optional string; `"meshtastic"` or `"meshcore"`) — explicit per-record protocol stamp; same semantics as on `POST /api/messages`.

**Sentinel handling (issue #782).** The same rules as `POST /api/nodes` apply here:

- `position_time <= 0` → set to `nil`.
- `latitude == 0 AND longitude == 0` (within ±1e-9°) → set `latitude`, `longitude`, `altitude`, and `location_source` all to `nil`. Equator / prime-meridian fixes with one non-zero axis survive.

MeshCore providers that obtain a contact advertisement with `(0, 0)` SHOULD drop the entire advertisement rather than queue a coordinate-less position row.

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
- `protocol` (optional string; `"meshtastic"` or `"meshcore"`) — explicit per-record protocol stamp; same semantics as on `POST /api/messages`.

#### `POST /api/neighbors`

Neighbors snapshot payload:

- Node: `node_id` (canonical string), `node_num` (int|nil)
- `neighbors`: list of entries with `neighbor_id` (canonical string), `neighbor_num` (int|nil), `snr` (float|nil), `rx_time` (int), `rx_iso` (string)
- Snapshot time: `rx_time`, `rx_iso`
- Optional: `node_broadcast_interval_secs` (int|nil), `last_sent_by_id` (canonical string|nil)
- Meta: `ingestor`, `lora_freq`, `modem_preset`
- `protocol` (optional string; `"meshtastic"` or `"meshcore"`) — explicit per-record protocol stamp; same semantics as on `POST /api/messages`.

#### `POST /api/traces`

Single trace payload:

- Identity: `id` (int|nil), `request_id` (int|nil)
- Endpoints: `src` (int|nil), `dest` (int|nil)
- Path: `hops` (list[int])
- Time: `rx_time` (int), `rx_iso` (string)
- Metrics: `rssi` (int|nil), `snr` (float|nil), `elapsed_ms` (int|nil)
- Meta: `ingestor`, `lora_freq`, `modem_preset`
- `protocol` (optional string; `"meshtastic"` or `"meshcore"`) — explicit per-record protocol stamp; same semantics as on `POST /api/messages`.

#### `POST /api/ingestors`

Heartbeat payload:

- `node_id` (canonical string)
- `start_time` (int), `last_seen_time` (int)
- `version` (string)
- Optional: `lora_freq`, `modem_preset`
- Optional: `protocol` (string; e.g. `"meshtastic"`, `"meshcore"`) — declares the mesh backend for this ingestor; defaults to `"meshtastic"` when absent

**Protocol propagation**: all event records (`messages`, `positions`, `telemetry`, `traces`, `neighbors`) that reference this ingestor via their `ingestor` field inherit its `protocol` value at write time when no explicit per-record `protocol` stamp is present. Per-record stamps take precedence — the ingestor heartbeat default only kicks in when the per-record field is absent or malformed.

**POST response & validation (0.7.0).** Every `POST /api/*` ingest route returns `201 Created` with `{"status":"ok"}` on success (`POST /api/instances` returns `{"status":"registered"}`). A batch route (`messages` / `positions` / `telemetry` / `neighbors` / `traces`) accepts either a single record object or an array of them; any other top-level JSON type is rejected with `400 {"error":"invalid payload"}`, matching the `/api/nodes` and `/api/ingestors` object check. Clients should treat any `2xx` as success.

### GET endpoint filtering

All collection GET endpoints (`/api/nodes`, `/api/messages`, `/api/positions`, `/api/telemetry`, `/api/traces`, `/api/neighbors`, `/api/ingestors`) accept an optional `?protocol=<value>` query parameter. When present, only records whose `protocol` column matches the given value are returned. The `protocol` field is included in all GET responses.

### GET endpoint time windows

Every read endpoint enforces a server-side rolling-window floor on the data it returns. The window is fixed per route and **cannot be widened by the caller** — explicit `?since=<unix_seconds>` is treated as `MAX(since, floor)`, so a `since` older than the floor is silently clamped to the floor. Pass a `since` newer than the floor when you want to be more restrictive (incremental refresh).

| Route | Floor (default) | Notes |
| --- | --- | --- |
| `GET /api/nodes` | 7 days | filtered by `nodes.last_heard` |
| `GET /api/messages` | 7 days | filtered by `messages.rx_time` |
| `GET /api/positions` | 7 days | filtered by `COALESCE(rx_time, position_time)` |
| `GET /api/telemetry` | 7 days | filtered by `COALESCE(rx_time, telemetry_time)` |
| `GET /api/instances` | 7 days | filtered by `instances.last_update_time` |
| `GET /api/neighbors` | **28 days** | sparse data; widened to keep slow scrapes visible |
| `GET /api/traces` | **28 days** | sparse data; same rationale |
| `GET /api/ingestors` | **28 days** | sparse heartbeats; same rationale |
| `GET /api/.../:id` (per-id lookup) | **28 days** | every per-id route uses the extended window so callers can backfill historical context for a specific node/conversation that has dropped out of the bulk view. The `since` clamp still applies. |
| `GET /api/telemetry/aggregated` | caller-controlled | `?windowSeconds=<N>` is mandatory; defaults to 86 400 (1 day). Bounded by `MAX_QUERY_LIMIT` on bucket count, not by a hard floor. |
| `GET /api/stats` | n/a | reports activity counts at fixed `hour`/`day`/`week`/`month` buckets; response shape documented below. |

Federation peers should not assume an unbounded historical window: a peer that requests `/api/messages?since=0` from a partner expecting "everything" will only ever receive the last seven days. To pull older state, request the per-id endpoint (28 days) for the relevant nodes.

The constants live in `web/lib/potato_mesh/config.rb` (`week_seconds`, `four_weeks_seconds`).

### GET endpoint backward pagination (`?before=`)

The six bulk collection endpoints — `GET /api/nodes`, `/api/positions`,
`/api/telemetry`, `/api/neighbors`, `/api/traces`, and `/api/ingestors` — plus the
pre-existing `GET /api/messages` cursor accept an optional `?before=<unix_seconds>`
**inclusive upper-bound cursor** for backward pagination. It is the companion to
`?since=`: where `since` raises the lower bound of the window, `before` lowers the
upper bound. `before` bounds each route's **primary sort column** — the column it
already orders by, newest first:

| Route | `before` bounds |
| --- | --- |
| `GET /api/nodes` | `last_heard` |
| `GET /api/messages` | `rx_time` |
| `GET /api/positions` | `rx_time` |
| `GET /api/telemetry` | `rx_time` |
| `GET /api/neighbors` | `rx_time` |
| `GET /api/traces` | `rx_time` |
| `GET /api/ingestors` | `last_seen_time` |

To page backward through more than one `limit`-sized response (the per-request cap
is `MAX_QUERY_LIMIT` = 1000), walk newest → oldest: fetch a page, then re-request
with `before` set to the **oldest sort-column value** in the page just received,
de-duplicating rows by their id. The inclusive `<=` boundary intentionally repeats
any row that shares the boundary second, so none is skipped across the page break;
the client's id-dedup collapses the one-row overlap. Repeat until a short page
(fewer than `limit` rows) signals the window is exhausted. This is how a client
retrieves **every** in-window row instead of stalling at the newest 1000.

`before` **only ever narrows** the result set, so — exactly like `since` — it
**cannot widen** the window past the route's floor in the table above: a `before`
older than the floor merely returns fewer rows (the floor still clamps the lower
bound), and a `before` newer than "now" is a no-op. A non-positive or non-integer
`before` is ignored (treated as absent). The cursor composes with `?protocol=` and
is protocol-neutral. The per-id routes (`GET /api/.../:id`) and `GET /api/instances`
do **not** accept `before`.

### GET /api/stats response shape

> **Breaking change in 0.7.0.** Before 0.7.0 the payload was flat —
> `active_nodes: {hour,day,week,month}` plus integer-valued `meshcore`/`meshtastic`
> sub-hashes. From 0.7.0 it is the scope → metric → window tree below. The change
> is versioned (minor bump) per the backward-compat rule above. Federation
> consumers read the new shape and **fall back to the old shape** for pre-0.7.0
> peers (one-way compatibility); see `application/federation/crawl.rb`.

`GET /api/stats` returns counts as a `scope → metric → window` tree:

```jsonc
{
  "total":      { "nodes": {…}, "messages": {…}, "telemetry": {…} },
  "meshcore":   { "nodes": {…}, "messages": {…}, "telemetry": {…} },
  "meshtastic": { "nodes": {…}, "messages": {…}, "telemetry": {…} },
  "reticulum":  { "nodes": {…}, "messages": {…}, "telemetry": {…} },  // stub: always 0
  "sampled": false
}
```

- **Scopes.** `total` counts every visible row regardless of protocol; `meshcore`,
  `meshtastic`, and `reticulum` are `protocol = ?` subsets, so
  `total ≥ Σ named protocols`. `reticulum` is a forward-looking stub (no Reticulum
  ingestor exists yet) and is always all-zero.
- **Metrics.** `nodes` counts `nodes` by `last_heard`; `messages` counts `messages`
  by `rx_time`; `telemetry` is the umbrella over `positions` + `telemetry` +
  `neighbors` + `traces` (every non-message packet record) by `rx_time`.
- **Windows.** Each metric maps to `{ "hour", "day", "week", "month" }` integer
  counts at the fixed cutoffs (1 h / 24 h / `week_seconds` / `four_weeks_seconds`);
  `month` cannot exceed the 28-day visibility floor.
- **Privacy.** Every metric honors the node opt-out marker. When `PRIVATE=1`, all
  `messages` counts are forced to `0` (mirroring the disabled message API);
  `nodes`/`telemetry` counts remain.
- **`sampled`** is unchanged: always `false` (the counts are exact, not sampled).

