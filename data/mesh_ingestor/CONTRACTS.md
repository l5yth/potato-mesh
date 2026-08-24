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

Note: non-Meshtastic protocols need a strategy to map their native node identifiers into this `!%08x` space. MeshCore uses the first 4 bytes of the node public key; Reticulum's mapping is defined below. There is no single standardized mapping in code — each protocol's provider owns its own, subject to the rules these two established: the mapping MUST be deterministic and derived from sender-side identity material, so every ingestor hearing the same node produces the same `node_id`.

#### Reticulum node id mapping

The Reticulum provider (`PROTOCOL=reticulum`, `data/mesh_ingestor/protocols/reticulum.py`) maps announces into the canonical id space as follows:

- **Canonical node id** = `!` + the first 4 bytes (8 lowercase hex chars) of the 16-byte Reticulum **destination hash**, mirroring MeshCore's first-4-bytes-of-pubkey rule. Deterministic and sender-side, so two ingestors hearing the same announce upsert the same row.
- **Full identity is preserved**: `user.publicKey` carries the complete 32-hex destination hash, so truncation loses no information a reader needs.
- `user.shortName` = the first 4 hex chars of the node id (MeshCore convention); `user.longName` = the display name decoded from announce `app_data`, falling back to the 8-hex hash prefix.
- One human peer can surface as two node rows (their `lxmf.delivery` and `nomadnetwork.node` destinations hash differently). That is faithful to Reticulum's destination model.

**Collision trade-off (accepted).** Truncating to 4 bytes means two distinct 16-byte destination hashes sharing a 4-byte prefix collapse onto one `node_id`. Within a protocol this is the same accepted trade-off MeshCore's pubkey-prefix mapping has always carried: the colliding records merge into one row, and the odds are negligible at mesh scale (~1 in 4 billion per pair). **Across protocols** the shared `nodes.node_id` keyspace makes a prefix collision a hijack risk instead of a merge, so the web **nodeinfo upsert** (`upsert_node`) refuses cross-protocol overwrites: when the stored row already carries a known protocol and an incoming record resolves to a different one, the record is skipped entirely (logged at debug level) rather than allowed to flip the row's protocol or overwrite its fields. The one exception is the established `meshtastic` → `meshcore` self-heal (bug #747): `meshtastic` doubles as the schema/classification default, so a `meshcore` record may still reclaim a default-stamped row. The guard covers the nodeinfo upsert only: position, telemetry, and last-seen touch writes key on the bare `node_id` without a protocol check, so a cross-protocol prefix collision can still attach position or telemetry fields to the row or advance its `last_heard` (extending the guard to those paths is a tracked follow-up).

**Deployment ordering.** The web whitelist must accept a protocol before any ingestor posts it: if an ingestor ships a protocol the deployed web tier does not yet know, protocol resolution files those records under the `meshtastic` default and the misclassification persists after the web tier is upgraded. Concretely for reticulum: deploy (or merge) the web change before or together with the ingestor change, never after.

### Ingest HTTP routes and payload shapes

Future providers should emit payloads that match these shapes (keys + types), which are validated by existing tests (notably `tests/test_mesh.py`).

#### `POST /api/nodes`

Payload is a mapping keyed by canonical node id, with optional top-level `”ingestor”` and `”protocol”` keys:

- `{ “!abcdef01”: { ... node fields ... }, “ingestor”: “!ingestornodeid”, “protocol”: “meshcore” }`

Protocol resolution per-row honours, in order: (1) an explicit per-node `”protocol”` field inside the node entry; (2) the wrapper-level top-level `”protocol”` key; (3) the registered ingestor's protocol (see `POST /api/ingestors`); (4) `”meshtastic”` as the final default. Valid values are `”meshtastic”`, `”meshcore”`, and `”reticulum”` — values outside this set fall through to the next source. The wrapper stamp is what the Python ingestor emits unconditionally so the web app classifies records correctly even before the ingestor heartbeat is processed (closes the startup race that misclassified MeshCore placeholders as Meshtastic).

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
- `rssi` (int|nil) — per-advert reception RSSI (SPEC RF3). Sourced from MeshCore RX-log adverts; Meshtastic reports no per-node RSSI, so the field stays absent/NULL there. The web upsert keeps the last stored value when an update omits it (`COALESCE`), so contact-roster refreshes never wipe a per-advert reading.
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

**MeshCore advert sourcing (capturing adverts from other nodes).** A MeshCore node announces itself by broadcasting an *advert* (public key + type + name + optional lat/lon). The ingestor surfaces heard adverts to `POST /api/nodes` through four complementary paths so coverage does not depend on the radio's auto-add setting or roster capacity:

- *Contact roster (rich).* The startup `ensure_contacts()` fetch plus live `NEW_CONTACT` / `NEXT_CONTACT` pushes carry the full advert (name, role, position) and upsert complete node rows. This covers every node the radio has added to its contact book.
- *Auto-update re-fetch (freshness).* The provider sets `mc.auto_update_contacts = True`, so the meshcore library re-fetches **changed** contacts (incrementally, by `lastmod`) whenever an `ADVERTISEMENT` / `PATH_UPDATE` push arrives. A re-advert from a known node therefore refreshes its `last_advert` / position without waiting for a reconnect.
- *Bare advert (reach).* The `ADVERTISEMENT` (pubkey-only) push is also handled directly: for a public key **not** in the contact roster it upserts a minimal "heard now" node (`lastHeard`, `protocol`, `user.shortName`/`publicKey` only — no name/type/position), so radios running with auto-add off still register the advertiser. Known keys are skipped (the auto-update path keeps them fresh). The Ruby web app preserves an existing long name on conflict, so this placeholder never clobbers a richer record, and a later full contact advertisement reconciles it. Reconciliation does not depend on timestamp ordering: the contact record carries `lastHeard = last_advert` (the **sender-stamped** advert-creation time), which is always older than the placeholder's wall-clock stamp — the web app's node upsert therefore fills identity fields (name, role, public key, …) that are still NULL even from an older-stamped record, while timestamps/telemetry stay freshness-guarded (ACCEPTANCE GH-A1).

- *RX-log advert (full identity + signal, roster-independent — SPEC RF3).* Companion firmware ≥ 1.16 pushes every received RF frame (`RX_LOG_DATA`) while a client is connected; the library parses `ADVERT` frames completely (full public key, name, type, optional lat/lon). The ingestor converts these to full node upserts carrying per-reception `snr` / `rssi` / `hopsAway`, so node identity and signal metrics no longer depend on the radio's contact roster at all — including when the roster is full. Absent RX-log frames (older/other builds) are never an error; the three paths above still function. Non-`ADVERT` RX-log frames are not ingested (DEBUG-only capture).

  *Position anchoring (SPEC MR5).* One advert reaches the radio several times over different flood paths, each copy carrying its own receiver-side `recv_time`. The position derived from an RX-log advert is therefore keyed on the advert's **sender-side** `adv_timestamp` — both for the `POST /api/positions` record and for the node row's `position.time` — falling back to `recv_time` only when the parser reported no usable value. `lastHeard` stays receiver-side. Because `_store_meshcore_position` derives its row id from `(node_id, position_time)`, every copy of one advert — across flood paths **and** across co-operating ingestors — collapses to a single position row. New protocols whose position data rides on rebroadcast beacons SHOULD likewise anchor on a sender-side timestamp.

**MeshCore roster-eviction assertion (SPEC RF4).** At startup the provider asserts the firmware's `AUTO_ADD_OVERWRITE_OLDEST` bit (`autoadd_config` bit `0x01`): it reads the current config and, only when the bit is unset, writes `config | 0x01` back — preserving the type-filter bits and `autoadd_max_hops`, and skipping the write (and its flash `savePrefs()`) when already set. With the bit set, a full contact roster evicts its oldest non-favourite entry instead of rejecting new contacts, so `NEW_CONTACT` coverage keeps rotating; favourites are never evicted (firmware guarantee) and the resulting `CONTACT_DELETED` pushes are deliberately ignored (the web DB retains evicted nodes; server-side retention remains the only data-expiry authority). Unconditional, no configuration knob; pre-1.16 firmware answers `ERROR`/timeout, which logs a warning and never blocks startup.

New protocols SHOULD likewise treat "node was heard" as a first-class, name-optional upsert so peer discovery does not hinge on a roster being populated.

#### `POST /api/messages`

Single message payload:

- Required: `id` (int), `rx_time` (int), `rx_iso` (string)
- Identity: `from_id` (string/int), `to_id` (string/int), `channel` (int), `portnum` (string|nil)
- Payload: `text` (string|nil), `encrypted` (string|nil), `reply_id` (int|nil), `emoji` (string|nil)
- RF: `snr` (float|nil), `rssi` (int|nil), `hop_limit` (int|nil), `hops` (int|nil), `path` (string|nil)
  - `hops` (SPEC RF1) — repeater relays actually travelled, distinct from `hop_limit`'s remaining-budget semantic. MeshCore: the native `path_len` with the `255` "direct" sentinel normalised to `0`. Meshtastic: `hopStart − hopLimit` when both are present, else absent. Additive; absent for legacy senders.
  - `path` (SPEC RF2) — MeshCore hop-hash route from the library's RX-log⇆message join (`decrypt_channels`): lowercase hex, `path_hash_size`-byte repeater hashes concatenated in travel order (last hash = the repeater heard directly). Absent on a join miss, on RX-log-less firmware, and on direct messages (E2E-encrypted, no join). Stored verbatim; no hash→node resolution is attempted. Additive.
  - Both fields are serialised back on `GET /api/messages`; neither participates in the dedup fingerprint below (the id derivation is byte-identical to pre-RF releases).
- Meta: `channel_name` (string; only when not encrypted and known), `ingestor` (canonical host id), `lora_freq`, `modem_preset`
- `protocol` (optional string; `"meshtastic"`, `"meshcore"`, or `"reticulum"`) — explicit per-record protocol stamp. Takes precedence over the value inherited from the registered ingestor; values outside the whitelist fall back to the ingestor lookup, then to `"meshtastic"`. Ingestors SHOULD stamp this on every message so the web app classifies senders correctly even before the ingestor heartbeat is processed.

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
- *Relay-rewritten `sender_timestamp` & cross-ingestor clock skew (#756 / #825).* MeshCore has been observed delivering the same physical packet twice with a rewritten `sender_timestamp`, which flips the v1 fingerprint and bypasses the `messages.id` PK collapse; and two ingestors hearing one packet stamp it with their own host clocks, which drift. To cover both, the web app runs an additional content-level dedup on insert: for `protocol = "meshcore"` with non-empty `text` and a known `from_id`, a second row matching `(from_id, to_id, channel_name, text)` within ±`MESHCORE_CONTENT_DEDUP_WINDOW_SECONDS` of `rx_time` is dropped. The match keys on the sender-stable **`channel_name`** (not the per-receiver `channel` slot index, which differs across ingestors for one logical channel — #825). The window is **300 s**: a production fleet of two live ingestors showed a consistent ~126 s inter-ingestor clock offset (median 126 s, p90 133 s), so a former 30 s window let 28 % of meshcore rows through as duplicates. **Accepted trade-off:** a sender repeating the *identical* text on the same channel **within 300 s** is silently collapsed into one row. Ingestors MUST still produce deterministic v1 ids — this content-level layer is additive, not a replacement. Pre-existing duplicates are cleared once by a `PRAGMA user_version`-gated one-shot backfill on startup (re-run when the window or key changes via `MESHCORE_CONTENT_DEDUP_BACKFILL_VERSION`). That one-shot purge is **transitive** — a chain of identical-content rows each within the window of the previous collapses to a single row even if the chain spans longer than the window — so it is deliberately more aggressive than the per-insert guard (which keeps ~one row per window gap), clearing repeated-identical-text backlogs in one historical pass; new rows are governed only by the gentler per-insert guard.
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
- `protocol` (optional string; `"meshtastic"`, `"meshcore"`, or `"reticulum"`) — explicit per-record protocol stamp; same semantics as on `POST /api/messages`.

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
- Metrics: many optional snake_case keys, one per stored column. Device:
  `battery_level`, `voltage`, `channel_utilization`, `air_util_tx`,
  `uptime_seconds`. Environment: `temperature`, `relative_humidity`,
  `barometric_pressure`, `gas_resistance`, `current`, `iaq`, `distance`,
  `lux`/`white_lux`/`ir_lux`/`uv_lux`, `wind_direction`/`wind_speed`/
  `wind_gust`/`wind_lull`, `weight`, `radiation`, `rainfall_1h`/`rainfall_24h`,
  `soil_moisture`/`soil_temperature`, and `one_wire_temperature`
  (list[float], stored as a JSON array). Power (TI-A1/A2): `ch1_voltage` …
  `ch8_voltage`, `ch1_current` … `ch8_current`. Air quality:
  `pm10_standard`/`pm25_standard`/`pm100_standard`/`pm40_standard`,
  `pm10_environmental`/`pm25_environmental`/`pm100_environmental`,
  `particles_03um`/`particles_05um`/`particles_10um`/`particles_25um`/
  `particles_40um`/`particles_50um`/`particles_100um`, `particles_tps`,
  `co2`/`co2_temperature`/`co2_humidity`,
  `form_formaldehyde`/`form_humidity`/`form_temperature`,
  `pm_temperature`/`pm_humidity`/`pm_voc_idx`/`pm_nox_idx`. Health:
  `heart_bpm`, `spo2`, `health_temperature` (body temperature — deliberately
  distinct from the ambient `temperature`). Local stats: `num_packets_tx`,
  `num_packets_rx`, `num_packets_rx_bad`, `num_online_nodes`,
  `num_total_nodes`, `num_rx_dupe`, `num_tx_relay`, `num_tx_relay_canceled`,
  `heap_total_bytes`, `heap_free_bytes`, `num_tx_dropped`, `noise_floor`
  (plus the shared `uptime_seconds`/`channel_utilization`/`air_util_tx`).
  Host: `freemem_bytes`, `diskfree1_bytes`/`diskfree2_bytes`/
  `diskfree3_bytes`, `load1`/`load5`/`load15`, `user_string` (string).
  Traffic: `packets_inspected`, `position_dedup_drops`,
  `nodeinfo_cache_hits`, `rate_limit_drops`, `unknown_packet_drops`,
  `hop_exhausted_packets`, `router_hops_preserved`. The web app also accepts
  each family nested as a sub-object (`device_metrics`, `environment_metrics`,
  `power_metrics`, `air_quality_metrics`, `local_stats`, `health_metrics`,
  `host_metrics`, `traffic_management_stats`) with camelCase or snake_case
  field names; nested family objects are consulted for **values**, not only
  for type inference. All metric additions are additive (D8) — absent keys
  are simply omitted, never sent as `null`.
- Subtype: `telemetry_type` (string|nil) — optional discriminator identifying which Meshtastic protobuf oneof was set; one of `"device"`, `"environment"`, `"power"`, `"air_quality"`, `"local_stats"`, `"health"`, `"host"`, or `"traffic"` (the last four added additively for the LocalStats / HealthMetrics / HostMetrics / TrafficManagementStats variants, TI-A1). Ingestors that detect the subtype SHOULD include this field; omit rather than send `null` when unknown. The web app infers the type from metric-field presence when absent, so old ingestors remain compatible.
- Meta: `ingestor`, `lora_freq`, `modem_preset`
- `protocol` (optional string; `"meshtastic"`, `"meshcore"`, or `"reticulum"`) — explicit per-record protocol stamp; same semantics as on `POST /api/messages`.

**MeshCore telemetry sourcing (TI-A3).** MeshCore exposes other nodes' telemetry only as on-air *pull* requests (there is no unsolicited telemetry broadcast the companion library surfaces), so the MeshCore provider collects it three ways and normalises every reading into this same payload shape with `protocol="meshcore"`: (1) **host self-telemetry** over the local companion link (`get_bat` → battery millivolts as `voltage`; `get_self_telemetry` → the host's CayenneLPP sensor list), no LoRa airtime, cadence `MESHCORE_SELF_TELEMETRY_SECONDS` (default 3600 s, matching the host-telemetry suppression window; `<= 0` disables); (2) **round-robin contact polling** (`req_telemetry_sync`, falling back to `req_status_sync` when a node reports no sensors) at one on-air request per `MESHCORE_TELEMETRY_POLL_SECONDS` (default 300 s; `<= 0` disables) regardless of roster size, with each contact additionally capped at **one poll per 24 h** (a fixed per-node cooldown, stamped at the poll attempt so unreachable nodes are not hammered; when every contact is fresh the tick transmits nothing) — and the transmit policy gates these on-air polls entirely — they require `TX_ENABLED=1` (default `0`, so an ingestor polls no other node unless its operator opts in), and the legacy `RX_ONLY=1` vetoes them regardless; the local self reads in (1) cost no airtime and are unaffected; (3) **unsolicited/tag-matched events** (`TELEMETRY_RESPONSE`, `STATUS_RESPONSE`, `BATTERY`) whenever the radio surfaces them. CayenneLPP types map to canonical keys (`temperature`, `humidity`→`relative_humidity`, `barometer`→`barometric_pressure`, `voltage`, `current` — scaled A→mA to match the Meshtastic column convention, `illuminance`→`lux`, `percentage`→`battery_level`); status `bat`/`level` millivolt gauges map to `voltage` (V). MeshCore assigns no firmware packet id, so the record `id` is the deterministic 53-bit fingerprint of *(node id, receive second, source kind)* — re-reads of the same source in the same second collapse into one row via the `telemetry.id` upsert.

#### `POST /api/neighbors`

Neighbors snapshot payload:

- Node: `node_id` (canonical string), `node_num` (int|nil)
- `neighbors`: list of entries with `neighbor_id` (canonical string), `neighbor_num` (int|nil), `snr` (float|nil), `rx_time` (int), `rx_iso` (string)
- Snapshot time: `rx_time`, `rx_iso`
- Optional: `node_broadcast_interval_secs` (int|nil), `last_sent_by_id` (canonical string|nil)
- Meta: `ingestor`, `lora_freq`, `modem_preset`
- `protocol` (optional string; `"meshtastic"`, `"meshcore"`, or `"reticulum"`) — explicit per-record protocol stamp; same semantics as on `POST /api/messages`.

#### `POST /api/traces`

Single trace payload:

- Identity: `id` (int|nil), `request_id` (int|nil)
- Endpoints: `src` (int|nil), `dest` (int|nil)
- Path: `hops` (list[int])
- Time: `rx_time` (int), `rx_iso` (string)
- Metrics: `rssi` (int|nil), `snr` (float|nil), `elapsed_ms` (int|nil)
- Meta: `ingestor`, `lora_freq`, `modem_preset`
- `protocol` (optional string; `"meshtastic"`, `"meshcore"`, or `"reticulum"`) — explicit per-record protocol stamp; same semantics as on `POST /api/messages`.

#### `POST /api/waypoints`

Single waypoint payload (Meshtastic `WAYPOINT_APP` broadcasts — community
points of interest; SPEC W1/W2). The collection is **protocol-neutral**: any
protocol may emit waypoints via this shape, Meshtastic is simply today's only
emitter.

- Required: `id` (int — the sender-assigned waypoint id, **not** a packet id), `rx_time` (int), `rx_iso` (string)
- Author: `node_id` (canonical string), `node_num` (int|nil), `from_id` (string/int)
- Content: `name` (string|nil), `description` (string|nil), `icon` (int|nil — unicode codepoint rendered as the marker glyph)
- Position: `latitude`, `longitude` (floats|nil; the protobuf `latitude_i`/`longitude_i` 1e-7 integer forms are also accepted). The paired `(0, 0)` no-fix sentinel is collapsed to NULL on both axes (issue #782 rules).
- Lifecycle: `expire` (int unix|nil — `0`/absent means **never expires** and is stored as NULL), `locked_to` (canonical string or int node num|nil — `0` means unlocked; stored as the canonical `!%08x` id)
- RF/meta: `snr` (float|nil), `rssi` (int|nil), `hop_limit` (int|nil), `payload_b64` (string|nil), `ingestor`
- `protocol` (optional string; `"meshtastic"`, `"meshcore"`, or `"reticulum"`) — explicit per-record protocol stamp; same semantics as on `POST /api/messages`.

**Upsert semantics (SPEC W5).** Rows are keyed on `(id, protocol)`: a
re-broadcast of the same waypoint id **replaces the content fields outright**
(`name`, `description`, `icon`, coordinates, `expire`, `locked_to`) — the
newest broadcast is the full new state, so a cleared description or moved pin
propagates — while RF metadata COALESCEs (an update omitting `snr` keeps the
last reading). An out-of-order re-broadcast whose `rx_time` is older than the
stored row is ignored entirely, so two ingestors relaying one waypoint can
never regress a newer edit (the C5 cross-ingestor dedup applied to POIs).

**Privacy (SPEC W3).** Waypoint `name`/`description` are user-authored
content, so the read surface is gated at **message grade**: under `PRIVATE=1`
`GET /api/waypoints` returns 404 and no `waypoints` SSE change events are
emitted. Unlike `/api/messages`, the ingest `POST` stays open in private mode
(data may be collected, never exposed). Waypoints whose author node carries
the opt-out marker are excluded from every read surface.

#### `POST /api/ingestors`

Heartbeat payload:

- `node_id` (canonical string)
- `start_time` (int), `last_seen_time` (int)
- `version` (string)
- Optional: `lora_freq`, `modem_preset`
- Optional: `protocol` (string; e.g. `"meshtastic"`, `"meshcore"`, `"reticulum"`) — declares the mesh backend for this ingestor; defaults to `"meshtastic"` when absent
- Optional: `packets` (int ≥ 0) — **mesh-activity delta (SPEC MA1/MA2).** The merged count of *every* frame this ingestor handled since its previous heartbeat: all received frames (including ignored / errored / unimplemented) **plus** its own transmissions (announcement + MeshCore telemetry polls), counted at the earliest receive/transmit seam so nothing is under-reported. It is a **per-interval delta** (reset on each send), **not** a since-boot cumulative. Additive and backward-compatible: an absent or negative value records no activity, so pre-feature ingestors are unaffected.

**Mesh-activity time-series (SPEC MA3).** Each heartbeat carrying a non-negative `packets` value appends one **append-only** row to the `ingestor_activity` table (`ingestor_id`, `at`, `packets`, `protocol`; `data/ingestor_activity.sql`); the `ingestors` snapshot row is upserted as before. Each ingestor's contribution is stored separately (never pre-summed) so a packets/hour moving average is computable across time × protocol × multiple ingestors. The row is best-effort — a failed activity insert never sinks the liveness heartbeat (still `201`). Rows are pruned by the retention worker on `at`. The read-side aggregate is served by `GET /api/stats` (`<scope>.packets.hour`, below).

**Protocol propagation**: all event records (`messages`, `positions`, `telemetry`, `traces`, `neighbors`) that reference this ingestor via their `ingestor` field inherit its `protocol` value at write time when no explicit per-record `protocol` stamp is present. Per-record stamps take precedence — the ingestor heartbeat default only kicks in when the per-record field is absent or malformed.

**POST response & validation (0.7.0).** Every `POST /api/*` ingest route returns `201 Created` with `{"status":"ok"}` on success (`POST /api/instances` returns `{"status":"registered"}`). A batch route (`messages` / `positions` / `telemetry` / `neighbors` / `traces`) accepts either a single record object or an array of them; any other top-level JSON type is rejected with `400 {"error":"invalid payload"}`, matching the `/api/nodes` and `/api/ingestors` object check. Clients should treat any `2xx` as success.

### GET endpoint filtering

All collection GET endpoints (`/api/nodes`, `/api/messages`, `/api/positions`, `/api/telemetry`, `/api/traces`, `/api/neighbors`, `/api/ingestors`, `/api/waypoints`) accept an optional `?protocol=<value>` query parameter. When present, only records whose `protocol` column matches the given value are returned. The `protocol` field is included in all GET responses.

### GET endpoint time windows

Every read endpoint enforces a server-side rolling-window floor on the data it returns. The window is fixed per route and **cannot be widened by the caller** — explicit `?since=<unix_seconds>` is treated as `MAX(since, floor)`, so a `since` older than the floor is silently clamped to the floor. Pass a `since` newer than the floor when you want to be more restrictive (incremental refresh).

| Route | Floor (default) | Notes |
| --- | --- | --- |
| `GET /api/nodes` | 7 days | filtered by `nodes.last_heard` |
| `GET /api/messages` | 7 days | filtered by `messages.rx_time` |
| `GET /api/positions` | 7 days | filtered by `COALESCE(rx_time, position_time)` |
| `GET /api/telemetry` | 7 days | filtered by `COALESCE(rx_time, telemetry_time)` |
| `GET /api/instances` | 7 days | filtered by `instances.last_update_time` |
| `GET /api/waypoints` | 7 days | filtered by `waypoints.rx_time`; rows past their `expire` timestamp are additionally excluded from the moment of expiry (SPEC W5). **404 under `PRIVATE=1`** (message-grade privacy, SPEC W3). The per-author `GET /api/waypoints/:id` (SPEC W11 — feeds the node page's Waypoints section) uses the standard per-id **28-day** window and the same expiry/privacy gates. |
| `GET /api/neighbors` | **28 days** | sparse data; widened to keep slow scrapes visible |
| `GET /api/traces` | **28 days** | sparse data; same rationale |
| `GET /api/ingestors` | **28 days** | sparse heartbeats; same rationale |
| `GET /api/.../:id` (per-id lookup) | **28 days** | every per-id route uses the extended window so callers can backfill historical context for a specific node/conversation that has dropped out of the bulk view. The `since` clamp still applies. |
| `GET /api/telemetry/aggregated` | caller-controlled | `?windowSeconds=<N>` is mandatory; defaults to 86 400 (1 day). Bounded by `MAX_QUERY_LIMIT` on bucket count, not by a hard floor. |
| `GET /api/stats` | n/a | reports activity counts at fixed `hour`/`day`/`week`/`month` buckets; response shape documented below. |

Federation peers should not assume an unbounded historical window: a peer that requests `/api/messages?since=0` from a partner expecting "everything" will only ever receive the last seven days. To pull older state, request the per-id endpoint (28 days) for the relevant nodes.

The constants live in `web/lib/potato_mesh/config.rb` (`week_seconds`, `four_weeks_seconds`).

### GET endpoint backward pagination (`?before=`)

The seven bulk collection endpoints — `GET /api/nodes`, `/api/positions`,
`/api/telemetry`, `/api/neighbors`, `/api/traces`, `/api/ingestors`, and
`/api/waypoints` — plus the
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
| `GET /api/waypoints` | `rx_time` |

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
  "total":      { "nodes": {…}, "messages": {…}, "telemetry": {…}, "packets": { "hour": 50 } },
  "meshcore":   { "nodes": {…}, "messages": {…}, "telemetry": {…}, "packets": { "hour": 50 } },
  "meshtastic": { "nodes": {…}, "messages": {…}, "telemetry": {…}, "packets": { "hour": 30 } },
  "reticulum":  { "nodes": {…}, "messages": {…}, "telemetry": {…}, "packets": { "hour": 10 } },
  "sampled": false
}
```

- **Scopes.** `total` counts every visible row regardless of protocol; `meshcore`,
  `meshtastic`, and `reticulum` are `protocol = ?` subsets, so
  `total ≥ Σ named protocols`. All three named scopes are live: `reticulum`
  shipped as an always-zero forward-looking stub and carries real counts since
  the Reticulum ingestor (`PROTOCOL=reticulum`) landed.
- **Metrics.** `nodes` counts `nodes` by `last_heard`; `messages` counts `messages`
  by `rx_time`; `telemetry` is the umbrella over `positions` + `telemetry` +
  `neighbors` + `traces` + `waypoints` (every non-message packet record — the
  waypoints table joined the umbrella per SPEC W9, amending S3) by `rx_time`;
  `packets` is the additive MA4/MA5 packets/hour rate (below).
- **Windows.** The `nodes`/`messages`/`telemetry` metrics map to
  `{ "hour", "day", "week", "month" }` integer counts at the fixed cutoffs
  (1 h / 24 h / `week_seconds` / `four_weeks_seconds`); `month` cannot exceed the
  28-day visibility floor. The `packets` metric carries only `hour` (it is a rate,
  not a windowed count).
- **Privacy.** Every metric honors the node opt-out marker. When `PRIVATE=1`, all
  `messages` counts are forced to `0` (mirroring the disabled message API);
  `nodes`/`telemetry` counts remain.
- **`<scope>.packets.hour`** (additive, SPEC MA4/MA5) carries the 24-hour
  packets/hour moving average as a rounded integer, exposed as a `packets` metric
  under each scope (single `hour` window). It is aggregated **MAX-per-protocol**:
  `MAX` over that protocol's ingestors of *(the ingestor's `packets` total in the
  last 24 h ÷ 24)* — a single radio hears ≤ what is actually transmitted, so the
  busiest vantage is the best dedup-free estimate of air traffic and never
  double-counts a frame heard by two radios. `total.packets.hour` is the **SUM**
  of the per-protocol rates (distinct protocols ride distinct frequencies, so they
  add rather than dedup); `reticulum.packets.hour` shipped as an always-zero
  stub and reports the real rate since the Reticulum ingestor landed. The rate
  only moves when the reticulum ingestor's heartbeat registers, which requires
  the operator-supplied `INGESTOR_NODE_ID` (Reticulum has no handshake revealing
  "our" node id; the provider warns at startup when it is unset). Unlike
  `messages`, it is **not** privacy-gated
  (packets are a public aggregate, no message content). Additive to the 0.7.x
  `/api/stats` tree — no version bump; the ingestor dogfeeds it for the activity
  announcement (MA6).
- **`sampled`** is unchanged: always `false` (the counts are exact, not sampled).

### GET /api/stats/activity packets/hour time-series (SPEC F2)

A bucketed packets/hour series over `ingestor_activity`, feeding the mesh-activity
map-card sparkline and the `/charts` activity figure. **snake_case** params (the
API norm): `window_seconds` (default 86 400, clamped to the 28-day floor) and
`bucket_seconds` (default 3 600); a bucket count over `MAX_QUERY_LIMIT` is a `400`.
An optional `since` bypasses the response cache.

```jsonc
[
  { "bucket_start": 1785000000, "bucket_end": 1785003600, "total": 130, "meshcore": 44, "meshtastic": 76, "reticulum": 10 },
  …
]
```

Each bucket's per-protocol value is the **MAX** over that protocol's ingestors of
their summed `packets` in the bucket, ÷ the bucket's hour-span → a packets/hour
rate; `total` is the **SUM** across protocols (matching the live
`<scope>.packets.hour`, SPEC MA4). Every known protocol (`meshcore`,
`meshtastic`, `reticulum`) emits its own series key; `reticulum` originally
folded into `total` without a key and went live with the Reticulum ingestor
(SPEC F2-2 as amended). Buckets are ascending by `bucket_start`. Additive,
read-side — no version bump.

### GET /api/events live-update stream (SSE)

A read-only **Server-Sent Events** stream (`text/event-stream`) that pushes thin
"this collection changed" notifications so the dashboard refreshes on change
instead of polling on a fixed interval. It is **outbound only** — it accepts no
body, writes nothing, and is **not** an ingest path; it carries no row data. The
fan-out is **in-process** (no MQTT/broker/cloud bus), preserving the apex
invariant; this endpoint adds no ingestor obligation (the Python ingestor never
consumes it).

Each change is one SSE frame:

```
event: change
data: {"collection":"messages","hint":1700000000}
```

- **`collection`** is one of `nodes`, `messages`, `positions`, `telemetry`,
  `neighbors`, `traces` — exactly the dashboard ingest collections. The client
  reacts by re-running its existing delta fetch (`GET /api/<collection>?since=…`)
  and merging by id; no row data is delivered over the stream.
- **A `POST /api/messages` ingest publishes *two* events — `messages` and
  `nodes`** — because a message also touches the author node's `last_heard`
  (#822). One ingest route may therefore emit more than one collection event; a
  client must handle each event independently and must not assume a 1:1
  route→event mapping.
- **`hint`** (optional integer) is the newest `rx_time`/`last_heard` seen for the
  collection — a skip hint; the client may ignore it and use its own high-water
  mark. It is currently not emitted by the server (reserved).
- The server emits an initial `: connected` comment and periodic `: keepalive`
  heartbeat comments; the connection is closed after a bounded lifetime so the
  client's `EventSource` reconnects (and resyncs).
- **Privacy.** When `PRIVATE=1` no `messages` events are emitted (mirroring the
  disabled message API); the other collections still emit. Because events carry
  no rows, opt-out / hidden rows never traverse the stream — the client always
  re-fetches through the already-filtered `GET /api/*` routes.
- **Config (web app).** `EVENTS=0` disables the stream (clients fall back to
  polling at `refresh_interval_seconds`); `SSE_HEARTBEAT_SECONDS` (default 15),
  `SSE_MAX_LIFETIME_SECONDS` (default 600), and `LIVE_SAFETY_POLL_SECONDS`
  (default 300, the client's slow fallback poll) tune the cadence. The endpoint
  is additive — no existing `/api/*` shape changes.

