<!-- Copyright © 2025-26 l5yth & contributors -->
<!-- Licensed under the Apache License, Version 2.0 (see LICENSE) -->

## Mesh ingestor contracts (stable interfaces)

This repo’s ingestion pipeline is split into:

- Python collector (`data/mesh_ingestor/*`) which normalizes packets/events and POSTs JSON to the web app.
- Sinatra web app (`web/`) which accepts those payloads on `POST /api/*` ingest routes and persists them into SQLite tables defined under `data/*.sql`.

This document records the contracts that future protocols must preserve. New protocols (MeshCore, Reticulum, …) reuse the shared read side (`nodes`, `/api/nodes`, the stats scopes, the federation record) and extend it only additively. A read-side addition for one protocol needs its own SPEC decision and leaves the other protocols' shapes unchanged, as Reticulum's `destinations` table and `GET /api/destinations` do (SPEC Invariant IV).

### Canonical node identity

- Canonical node id: `nodes.node_id` is a `TEXT` primary key and is treated as canonical across the system.
- Format: `!%08x` (lowercase hex, 8 chars), for example `!abcdef01`.
- Ingest id forms (SPEC SL5): a node reference (`from_id`, `node_id`, `neighbor_id`, a heartbeat's `node_id`) is the canonical id, a node number (a JSON integer from 0 to 4294967295, or its decimal string), or absent; a destination (`to_id`) may also be the broadcast id `^all`. The `ingestor` field and the keys of `POST /api/nodes` take the canonical id only. The web app skips a record carrying any other id, and a neighbour entry carrying one, and still answers 201; a heartbeat with one answers 400.
- Normalization:
  - Python currently normalizes via `data/mesh_ingestor/serialization.py:_canonical_node_id`.
  - Ruby normalizes via `web/lib/potato_mesh/application/data_processing.rb:canonical_node_parts`.
- Dual addressing: Ruby routes and queries accept either a canonical `!xxxxxxxx` string or a numeric node id; they normalize to `node_id`.
- Sender (SPEC NI1): a Meshtastic record names its sender by the packet header's numeric `from`, as `!%08x`, not by the meshtastic library's `fromId`. A packet without a numeric `from` falls back to `fromId`, then `from_id`.
- A Meshtastic NodeInfo is filed under its sender only when its `user.id` is exactly the sender's canonical id. Any other `user.id`, including one that names no node or spells the sender's id another way, drops it with a warning that names both ids, and the meshtastic library does not store it either (`interfaces/patches/nodeinfo.py`). A NodeInfo without `user.id`, or with an empty one, is filed under its sender. A `num` other than its node's own is not posted: the entry carries its own node's number. The node-list snapshot posts each entry under the id the library files it under, and skips an entry whose `num` disagrees with that id.
- A Meshtastic NeighborInfo is filed under its sender too, and only when its `node_id` is the sender's node number or canonical id. Any other `node_id` drops it with a warning that names both ids. One without `node_id` is filed under its sender.
- The web app applies the same rule to the NodeInfo and NeighborInfo payloads it decrypts. A decrypted NodeInfo's own `id` and `user.id`, and a decrypted NeighborInfo's `node_id`, must each be absent or the message sender's canonical id or number; any other value drops the payload. A decrypted NodeInfo is filed under the sender's own id and number.

Note: non-Meshtastic protocols need a strategy to map their native node identifiers into this `!%08x` space. MeshCore uses the first 4 bytes of the node public key; Reticulum's mapping is defined below. There is no single standardized mapping in code - each protocol's provider owns its own, subject to the rules these two established: the mapping MUST be deterministic and derived from sender-side identity material, so every ingestor hearing the same node produces the same `node_id`.

#### Reticulum node id mapping

The Reticulum provider (`PROTOCOL=reticulum`, `data/mesh_ingestor/protocols/reticulum.py`) maps announces into the canonical id space as follows:

- Canonical node id = `!` + the first 4 bytes (8 lowercase hex chars) of the 16-byte identity hash, mirroring MeshCore's first-4-bytes-of-pubkey rule. Deterministic and sender-side (per the rule above).
- One row per identity (SPEC RE7). A Reticulum identity announces on several destinations -- one per aspect (`lxmf.delivery`, `nomadnetwork.node`, `lxmf.propagation`) -- and all of them are one node: `node_id` is the first four bytes of the *identity* hash. Each aspect becomes a row in the `destinations` table carrying its own name and role. A destination hash keys a row only when no identity can be resolved at all.
- `user.publicKey` is the announcing identity's real public key (64 bytes / 128 hex), never a destination hash -- a destination hash is a truncated hash over the identity and name hashes, not a key.
- `destination` is `{id, aspect, role}` for the destination this announce arrived on. Role is derived from the aspect: `lxmf.delivery` -> `PEER`, `nomadnetwork.node` -> `NODE`, `lxmf.propagation` -> `PROPAGATION`. `TRANSPORT` is reserved and never emitted for remote peers (see SPEC RE9 below).
- `interface` is the interface the announce was heard on, when known. Retrieved through `RNS.Reticulum`'s shared-instance-aware accessors, which RPC to a running `rnsd` and return its view; `RNS.Transport.next_hop_interface` reads only the local process's path table and answers `LocalInterface[...]` for everything.
- `identityHash` is the announcing identity's 16-byte hash.
- `user.shortName` = the first 4 hex chars of the node id; `user.longName` = the display name decoded from announce `app_data`, falling back to `"Reticulum <SHORT>"`: the protocol label plus the upper-cased first four hex of `destination.id`, or of the node id when the record carries no `destination` (SPEC RA10).

Scope. `hops == 0` means the announce came from an app on this machine (`Transport.inbound` adds a hop to every inbound packet and takes it back for a local-client or shared-instance interface), so those are always ingested -- the operator's own nodes must never be hidden by a filter. From one hop out, `RETICULUM_INTERFACES` applies: unset admits an RNode interface only, `*` admits every interface, and a list is a case-insensitive substring match on the interface name (see "Interface scope" below).

Headline name and role. The node-level `long_name`/`role` follow the node's
destinations, ranked `NODE` > `PEER` > `PROPAGATION` > `TRANSPORT`; the web app
re-derives both from the `destinations` rows on every destination write
(SPEC RE10). `role` is the highest-ranked destination's. `long_name` is the
highest-ranked announced name, else a stored name that is not a placeholder,
else the node's own placeholder (`Reticulum` plus the upper-cased first four
hex of the node id). A destination's placeholder never becomes `long_name`.
The result survives a restart and agrees across ingestors.

`TRANSPORT` is emitted for the ingestor's own host only (SPEC RE9), under
the synthetic aspect `rns.transport` and only when the local stack reports
`transport_enabled`. For every remote peer it stays absent -- no announce
exposes transport status, and the sender-side determinism rule above (SPEC
RD4) rules out inferring it from the ingestor's own path table. A provider for
another protocol must not emit `TRANSPORT` for anything but its own host.

Interface scope. An RNS stack can carry LoRa and IP interfaces at once, and an announce listener hears every announce reachable over any of them - with RNS's default `AutoInterface` (IPv6 link-local multicast) that is the entire local Reticulum network. `RETICULUM_INTERFACES` scopes ingestion by the interface the announce's path arrived on. Unset, blank or quote-only (the default) admits an RNode only: an interface whose class in `get_interface_stats()`, read through the shared instance like the name, is `RNodeInterface`, `RNodeMultiInterface` or `RNodeSubInterface`. A sub-interface prints as `<parent>[<sub>]`, with no "rnode" in it, and is matched by that name against the stats entries; the map is cached and re-read on a miss at most every 30 s. When the stats cannot be read, or do not list the interface, the name must contain `rnode`. A stack listing no RNode keeps only 0-hop announces and the host's own destinations, and warns once per connect. `*` admits every interface. Any other value is a comma-separated, case-insensitive substring allowlist of interface names (e.g. `rnode`). A filtered-out announce is not counted as this mesh's traffic. Reticulum exposes no protocol-level "this peer is on LoRa" marker, so the interface a path arrived on is the only available proxy (SPEC RN4).

Config dir. `RETICULUM_CONFIG_DIR` defaults to RNS's user default `~/.reticulum`, the directory the operator's `rnsd` uses unless `/etc/reticulum/config` or `~/.config/reticulum/config` exists (SPEC RE3, amending RN3). Interface scoping asks the shared instance which interface an announce arrived on, and that RPC authenticates with a key derived from the config dir's identity, so an ingestor with a private directory attaches to `rnsd` but cannot query it. The container images set it to `/app/.config/potato-mesh/reticulum`, where Compose mounts the `potatomesh_reticulum` volume.

The ingestor's own node id is the host's primary identity, never the transport
identity (SPEC RE8; see "Host-owned destinations" below). There is none until
something on the ingestor's RNS stack announces: `extract_host_node_id` returns
`None` and the daemon asks the provider again on every loop, so the heartbeat
registers on the loop after a local app announces. `INGESTOR_NODE_ID` overrides
the derived id. It is required where nothing on that stack announces, as with
Docker's default `potatomesh_reticulum` volume, and to pin the id when two
identities tie, since a tie is not guessed. A supplied value is canonicalised
through the Reticulum mapping, not the shared `canonical_node_id` (which
truncates a 16-byte identity hash from the wrong end -- SPEC RE5). A protocol
adding its own self-id must keep the derived id stable across restarts, or it
is worse than none. Its `extract_host_node_id` runs at connect and on every
loop while it returns `None`, so it must be cheap and must not raise.

`CONNECTION` does not apply. It names a single serial, TCP, or BLE endpoint; an RNS stack is a set of interfaces with no such endpoint. Its counterparts are disjoint rather than overlapping: `RETICULUM_CONFIG_DIR` selects the stack, `RETICULUM_INTERFACES` selects which of its interfaces to ingest from. A set `CONNECTION` is ignored and logged as ignored, because the shipped container image carries a serial default for every protocol (SPEC RN10).

Transmit policy. The provider is receive-only and has no transmit site to gate, so `PROTOCOL=reticulum` works with `TX_ENABLED=0` (the default). The underlying RNS stack is not silent at the *interface* layer, though - `AutoInterface` multicasts peer discovery, and `enable_transport` relays other nodes' traffic. That is owned by the Reticulum config the ingestor shares with `rnsd` (above). With no shared instance running, `connect` starts that stack in the ingestor's own process, and the process then transmits whatever the config enables (SPEC RN5, amended by RE3).

Collision trade-off. Truncating to 4 bytes means two distinct 16-byte identity
hashes sharing a 4-byte prefix map to one `node_id`, as two MeshCore public
keys sharing a 4-byte prefix do. The web app binds the row to the full key of
the identity that named it (SPEC NI2, NI3): `identity_hash` for Reticulum,
`public_key` for Meshtastic and MeshCore. A record under another key, or under
none, cannot change the row's names, role, hardware model, key, position or
protocol, add a destination, stamp its keyed evidence, or merge a chat
placeholder into it; it still refreshes `last_heard`, telemetry and signal
fields. A MeshCore position row carries its advert's `public_key`, so the same
holds for the node-row write of `POST /api/positions`. The row keeps the first
identity's names. A new key takes the row over once the row is positively
stale, by the merge rule of SPEC MR2. Across protocols, a prefix collision is
a hijack risk rather than a merge, so every web node-row write refuses
cross-protocol overwrites: when the stored row already carries a known
protocol and an incoming record resolves to a different one, the write is
skipped (logged at debug level). This covers the nodeinfo upsert
(`upsert_node`) and the node-row writes of positions, telemetry and last-seen
touches (`update_node_from_position`, `update_node_from_telemetry`,
`touch_node_last_seen`), whose callers pass the record's protocol. The one
exception is `meshtastic` → `meshcore` self-heal: `meshtastic` is the
schema/classification default, so a `meshcore` record may still reclaim a
default-stamped row that is not bound to another key. The `positions` and
`telemetry` rows of a colliding record are still stored under its `node_id`.

Deployment ordering. The web whitelist must accept a protocol before any ingestor posts it: if an ingestor ships a protocol the deployed web tier does not yet know, protocol resolution files those records under the `meshtastic` default and the misclassification persists after the web tier is upgraded. Concretely for reticulum: deploy (or merge) the web change before or together with the ingestor change, never after.

### Ingest filters

`ALLOWED_CHANNELS`, `HIDDEN_CHANNELS`, `PRIMARY_CHANNEL_ONLY` and `DROP_VIA_MQTT` are enforced by the ingestor before anything is POSTed; the web app applies no channel filter (SPEC CF1-CF3, VM1-VM2). One policy, `channels.ingest_filter_reason`, covers every record attributed to a channel: each packet `store_packet_dict` routes (messages, positions, telemetry, node info, traceroutes, waypoints, neighbor info, store-forward heartbeats) and each entry of the Meshtastic node-list snapshot, whose `channel` is the channel the node's last NodeInfo was heard on.

- A Meshtastic packet or nodeDB entry without `channel` was heard on index 0: proto3 omits the field when it is 0.
- A packet of another protocol without a `channel` key carries no channel attribution and skips the channel filters (a MeshCore telemetry pull). A protocol whose traffic is channel-scoped must stamp `channel` on the packets it hands to `store_packet_dict`. Records that never pass through it (MeshCore contacts and adverts, Reticulum announces) are not channel-filtered.
- An index whose name was never captured matches no `ALLOWED_CHANNELS` or `HIDDEN_CHANNELS` entry, except channel 0, which is matched by `PRIMARY_CHANNEL_NAME` (the passive UDP transport captures no channel names). That name is used for matching only; message payloads keep their `channel_name` rules.
- `DROP_VIA_MQTT` drops a packet carrying `viaMqtt: true` or `via_mqtt: true` (the latter from a proto-field-name conversion) and a nodeDB entry carrying `viaMqtt: true`; presence means true. The UDP transport maps the same `viaMqtt` key.
- `POST /api/nodes` bodies never carry the meshtastic library's `lastReceived` copy of a node's last packet.
- Known limit: a snapshot entry is published when its NodeInfo channel passes, and it carries the nodeDB's latest position, metrics and signal details (`lastHeard`, `snr`, `hopLimit`), which the radio stores whatever channel they were heard on.

### Ingest HTTP routes and payload shapes

Future providers should emit payloads that match these shapes (keys + types), which are validated by existing tests (notably `tests/test_mesh.py`).

Receive time (SPEC RK1-RK3). `rx_time` is the ingestor's receive time, in Unix seconds. A Meshtastic packet's `rxTime` comes from a radio's clock, not the ingestor's. `handlers.on_receive`, which both Meshtastic transports feed, keeps it only within 1 hour of the ingestor's clock, in either direction (`RX_TIME_TOLERANCE_SECS` in `handlers/receive_time.py`); otherwise it posts the ingestor's clock and logs a warning that names the sender and the offset, at most once per 10 minutes. MeshCore and Reticulum records keep the times their providers assign: a MeshCore roster position carries the contact's `last_advert` (SPEC RS1). The node-list snapshot's `lastHeard` comes from the radio's node database and is not checked (SPEC RK3). The web app stores `rx_time` as posted and clamps only future values, and the GET time windows below filter messages, positions and telemetry on it, so a record stamped before the window is stored but never served.

#### `POST /api/nodes`

Payload is a mapping keyed by canonical node id, with optional top-level `”ingestor”` and `”protocol”` keys:

- `{ “!abcdef01”: { ... node fields ... }, “ingestor”: “!ingestornodeid”, “protocol”: “meshcore” }`

A key that is not a canonical node id, or whose entry is not a mapping, is skipped, and the request still answers 201 (SPEC SL5). A nested `user`, `deviceMetrics`, `device_metrics`, `position`, `position.raw` or `destination` that is not a mapping is ignored, as if absent (SPEC SL10).

Protocol resolution per-row honours, in order: (1) an explicit per-node `”protocol”` field inside the node entry; (2) the wrapper-level top-level `”protocol”` key; (3) the registered ingestor's protocol (see `POST /api/ingestors`); (4) `”meshtastic”` as the final default. Valid values are `”meshtastic”`, `”meshcore”`, and `”reticulum”` - values outside this set fall through to the next source. The wrapper stamp is what the Python ingestor emits unconditionally so the web app classifies records correctly even before the ingestor heartbeat is processed (closes the startup race that misclassified MeshCore placeholders as Meshtastic).

Node entry fields are “Meshtastic-ish” (camelCase) and may include the following.
As of 0.7.0 each field is additionally accepted in snake_case (e.g.
`last_heard`, `user.short_name`, `user.hw_model`, `device_metrics.battery_level`,
`position.location_source`) so the node ingest contract is no longer
Meshtastic-camelCase-only; the existing collector keeps emitting camelCase, which
remains accepted. Per-field acceptance is nil-aware, so a camelCase value of
`false` is never overridden by a snake_case alias. Fields:

- `num` (int node number) - the number of the node the entry is keyed on. A `num` naming another node is replaced by that node's own number (SPEC NI1).
- `lastHeard` (int unix seconds)
- `snr` (float)
- `rssi` (int|nil) - per-advert reception RSSI (SPEC RF3). Sourced from MeshCore RX-log adverts; Meshtastic reports no per-node RSSI, so the field stays absent/NULL there. The web upsert keeps the last stored value when an update omits it (`COALESCE`), so contact-roster refreshes never wipe a per-advert reading.
- `hopsAway` (int)
- `isFavorite` (bool)
- `identityHash` (hex string | absent) - the full protocol-native identity hash a node is keyed on, for protocols whose identities front several destinations (today: Reticulum, whose `nodeId` is its first 4 bytes). Stored in `nodes.identity_hash` and on each of the node's `destinations` rows. Not served on the node read APIs, but returned by `GET /api/destinations`.
- `destination` (mapping | absent) - `{id, aspect, role}` for the destination this record's announce arrived on. Written to the `destinations` table and served by `GET /api/destinations`.
- `interface` (string | absent) - the interface the announce was heard on, e.g. `RNodeInterface[RNode Reticulum Berlin]`.
- `user` (mapping; e.g. `shortName`, `longName`, `macaddr`, `hwModel`, `publicKey`, `isUnmessagable`)
  - `role` (optional string) - omit when unknown. A Meshtastic record that carries `user` without `role` is stored as `CLIENT`: proto3 omits the role at its zero value, `CLIENT` (SPEC NI5). A `user` whose `hwModel` is `UNSET`, the meshtastic library's stand-in for a node it has no NodeInfo for, keeps the stored role. Known values include Meshtastic role names (e.g. `CLIENT`, `ROUTER`), MeshCore role names (`COMPANION`, `REPEATER`, `ROOM_SERVER`, `SENSOR`), and Reticulum role names (`PEER`, `NODE`, `PROPAGATION`; `TRANSPORT` for the ingestor's own host only - see "Reticulum node id mapping" above, which also covers the headline ranking)
- `deviceMetrics` (mapping; e.g. `batteryLevel`, `voltage`, `channelUtilization`, `airUtilTx`, `uptimeSeconds`)
- `position` (mapping; `latitude`, `longitude`, `altitude`, `time`, `locationSource`, `precisionBits`, optional nested `raw`)
- Optional radio metadata: `lora_freq`, `modem_preset`

Sentinel handling (issue #782). Meshtastic firmware emits `(latitude=0, longitude=0)` and `time=0` whenever the GPS module has not produced a fresh fix. Ingestors MUST normalise these sentinels before POSTing:

- `position.time <= 0` → omit the key entirely.
- `position.latitude == 0 AND position.longitude == 0` (within ±1e-9°) → omit `latitude`, `longitude`, `altitude`, and `locationSource` together; the remaining `precisionBits` / nested `raw` may still ride along.
- Single-axis zeros (`latitude == 0` *or* `longitude == 0` but not both) are legitimate equator / prime-meridian fixes and MUST be preserved.

The web application applies the same normalisation as a safety net so legacy ingestors and replayed payloads cannot reintroduce the sentinels, but new ingestors should strip them at the source so the cross-network contract stays clean.

Wire-format note for federation peers (issue #782). Position time is exposed only as `position_time` (unix seconds) on GET responses (`/api/nodes`, `/api/positions`); the redundant ISO twin (`pos_time_iso` on `/api/nodes`, `position_time_iso` on `/api/positions`) was removed in 0.7.0 - clients format `position_time` themselves. Sentinel rows are compacted by omitting `position_time` rather than emitting `0` or `"1970-01-01T00:00:00Z"`. Federation peers consuming this API and any third-party clients SHOULD treat an *absent* `position_time` as "no GPS lock recorded" and not synthesise a zero or epoch value when re-serialising. Older peers that key on `position_time == 0` may need a small adjustment.

MeshCore advert sourcing (capturing adverts from other nodes). A MeshCore node announces itself by broadcasting an *advert* (public key + type + name + optional lat/lon). The ingestor surfaces heard adverts to `POST /api/nodes` through four complementary paths so coverage does not depend on the radio's auto-add setting or roster capacity:

- *Contact roster (rich).* The startup `ensure_contacts()` fetch plus live `NEW_CONTACT` / `NEXT_CONTACT` pushes carry the full advert (name, role, position) and upsert complete node rows. This covers every node the radio has added to its contact book.
- *Auto-update re-fetch (freshness).* The provider sets `mc.auto_update_contacts = True`, so the meshcore library re-fetches changed contacts (incrementally, by `lastmod`) whenever an `ADVERTISEMENT` / `PATH_UPDATE` push arrives. A re-advert from a known node therefore refreshes its `last_advert` / position without waiting for a reconnect.
- *Bare advert (reach).* The `ADVERTISEMENT` (pubkey-only) push is also handled directly: for a public key not in the contact roster it upserts a minimal "heard now" node (`lastHeard`, `protocol`, `user.shortName`/`publicKey` only - no name/type/position), so radios running with auto-add off still register the advertiser. Known keys are skipped (the auto-update path keeps them fresh). The Ruby web app preserves an existing long name on conflict, so this placeholder never clobbers a richer record, and a later full contact advertisement reconciles it. Reconciliation does not depend on timestamp ordering: the contact record carries `lastHeard = last_advert` (the sender-stamped advert-creation time), which is always older than the placeholder's wall-clock stamp - the web app's node upsert therefore fills identity fields (name, role, public key, …) that are still NULL even from an older-stamped record, while timestamps/telemetry stay freshness-guarded (ACCEPTANCE GH-A1). A record under another key than the row's fills nothing (SPEC NI2).

- *RX-log advert (full identity + signal, roster-independent - SPEC RF3).* Companion firmware ≥ 1.16 pushes every received RF frame (`RX_LOG_DATA`) while a client is connected; the library parses `ADVERT` frames completely (full public key, name, type, optional lat/lon). The radio pushes each frame before the firmware checks it, and the library does not check the advert's signature, so the ingestor does (SPEC SG1): it posts an RX-log advert, node and position, only when the Ed25519 signature in the raw payload (`pkt_payload`) verifies under the advert's own key over `pub_key + timestamp + app_data`, the bytes `Mesh::onRecvPacket` checks. It also refuses app data longer than the 32 bytes the firmware signs, a parsed `adv_key` that is not the key in the signed bytes, and a key of small order, which no private key stands behind (SPEC SG4). Like the firmware's roster, it then posts an advert only when its signed timestamp is newer than the newest one accepted for that key, or reported by a roster contact as its `last_advert` (SPEC SG5): a replay, or the same advert heard again over another path, posts nothing. That memory is per process and mirrors the radio's roster. The first `CONTACTS` listing of a connection, the whole roster, sets which keys are roster keys; a later listing, the auto-update re-fetch of changed contacts, adds the contacts it names; `NEW_CONTACT`, which the radio pushes for an advert from a key it did not add, and `NEXT_CONTACT` only raise a roster key's timestamp. Adverts from new keys cannot push a roster key out. A key the next full listing lacks joins the other keys, of which the memory keeps the 4096 most recently accepted. A key the radio adds is protected once a listing names it, and if auto-add lets the radio's own roster be flooded, the protection is the radio's: a key stays protected while it is in the radio's roster. After a restart a key outside the roster passes its first advert, and roster keys are protected again once the connection's first listing has run. A refused advert posts nothing and logs one debug line (`context=meshcore.rx_advert`, with `node_id` and `reason`). The three paths above are not checked again: the firmware verified each advert they carry before it added the contact or pushed `ADVERTISEMENT`, and a contact added over the companion link itself is the operator's own. The ingestor converts verified adverts to full node upserts carrying the `snr` / `rssi` / `hopsAway` of each advert's first reception, so node identity and signal metrics no longer depend on the radio's contact roster at all - including when the roster is full. Absent RX-log frames (older/other builds) are never an error; the three paths above still function. Non-`ADVERT` RX-log frames are not ingested: decrypted `GRP_TXT` copies only route channel messages (see `POST /api/messages`), and the DEBUG-only capture drops their decrypted text.

  *Position anchoring (SPEC MR5).* One advert reaches the radio several times over different flood paths, each copy carrying its own receiver-side `recv_time`. The position derived from an RX-log advert is therefore keyed on the advert's sender-side `adv_timestamp` - both for the `POST /api/positions` record and for the node row's `position.time` - falling back to `recv_time` only when the parser reported no usable value. `lastHeard` stays receiver-side. Because `_store_meshcore_position` derives its row id from `(node_id, position_time)`, every copy of one advert - across flood paths and across co-operating ingestors - collapses to a single position row. One ingestor posts only the first copy it hears (SPEC SG5); the anchor collapses the copies of co-operating ingestors. New protocols whose position data rides on rebroadcast beacons SHOULD likewise anchor on a sender-side timestamp.

  *Key binding (SPEC NI3).* An advert, from any of the four paths, whose full public key differs from the key the row is bound to refreshes only `last_heard`, telemetry and the signal fields; the names, role, key and position stay those of the first key (see "Collision trade-off" above).

MeshCore roster-eviction assertion (SPEC RF4). At startup the provider asserts the firmware's `AUTO_ADD_OVERWRITE_OLDEST` bit (`autoadd_config` bit `0x01`): it reads the current config and, only when the bit is unset, writes `config | 0x01` back - preserving the type-filter bits and `autoadd_max_hops`, and skipping the write (and its flash `savePrefs()`) when already set. With the bit set, a full contact roster evicts its oldest non-favourite entry instead of rejecting new contacts, so `NEW_CONTACT` coverage keeps rotating; favourites are never evicted (firmware guarantee) and the resulting `CONTACT_DELETED` pushes are deliberately ignored (the web DB retains evicted nodes; server-side retention remains the only data-expiry authority). Unconditional, no configuration knob; pre-1.16 firmware answers `ERROR`/timeout, which logs a warning and never blocks startup.

New protocols SHOULD likewise treat "node was heard" as a first-class, name-optional upsert so peer discovery does not hinge on a roster being populated.

MeshCore chat placeholders (SPEC GN1/GN4). A MeshCore channel message names its sender only in its `SenderName: body` text. When the ingestor's roster has no contact of that name, the message carries a name-derived `from_id` and no node is POSTed for it: the web app creates the placeholder node itself when it ingests the message, flagged synthetic, and merges it into the real node once that node's contact advertisement arrives. A node entry whose `user.synthetic` is set (any truthy value, the same rule `upsert_node` applies to the flag) is therefore ignored and the request still answers 201, so a POSTed placeholder never records a reception. An `@[Name]` mention or reply prefix is not a reception and never creates, refreshes, or merges a node.

#### `POST /api/messages`

Single message payload:

- Required: `id` (int), `rx_time` (int), `rx_iso` (string)
- Identity: `from_id` (string/int), `to_id` (string/int), `channel` (int), `portnum` (string|nil)
- Payload: `text` (string|nil), `encrypted` (string|nil), `reply_id` (int|nil), `emoji` (string|nil)
- RF: `snr` (float|nil), `rssi` (int|nil), `hop_limit` (int|nil), `hops` (int|nil), `path` (string|nil), `scope` (string|nil)
  - `hops` (SPEC RF1) - repeater relays actually travelled, distinct from `hop_limit`'s remaining-budget semantic. MeshCore: the native `path_len` of a flood-routed message; the `255` sentinel marks a direct route whose hop count is unknown and is sent as `null`, never `0` (#765). Meshtastic: `hopStart − hopLimit` when both are present, else absent. Additive; absent for legacy senders.
  - MeshCore channel messages take `rssi`, `path` and `scope` from the RX-log copy the radio delivered (SPEC SC1/SC2): the ingestor enables the library's RX-log decryption (`set_decrypt_channel_logs`), keeps the decrypted `GRP_TXT` flood copies in memory (256 copies, 300 s), and matches each message to the earliest copy whose hop count equals its `path_len`. The library's own join fields (the newest copy's) are ignored. No matching copy - a frame too long for the RX log (over 173 bytes; 169 before firmware 1.16), an expired or unlogged frame, a direct route, a library without the switch - leaves all three absent while `hops` stays. Direct messages carry none of them (E2E-encrypted, never decrypted from the RX log).
  - `path` (SPEC RF2) - MeshCore hop-hash route: lowercase hex, `path_hash_size`-byte repeater hashes concatenated in travel order (last hash = the repeater heard directly); absent for a message heard straight from its sender. Stored verbatim; no hash→node resolution is attempted. Additive.
  - `scope` (SPEC SC3-SC5) - the MeshCore flood scope of the delivered copy, one of: the region name without its `#`, when the copy's `transport_codes[0]` is reproduced by the radio's own default flood scope (read after connect; the only candidate, never a private `$` region); `"*"` for a plain, unscoped `FLOOD` (also what a sender before firmware 1.10 produces); the reserved `"?"` for any other scoped flood (region unknown; `?` is not a legal region-name character). Absent with no matching copy and for other protocols. The web app accepts `*`, `?`, or 1-30 printable bytes; any other value is stored as `NULL` and the request still answers 201. No region key is ever posted or logged.
  - Merge across copies (SPEC SC6). A later copy of a stored message - the same `id`, or a content-dedup match - fills a `NULL` `scope` with any value, and replaces a stored `"?"` with a resolved region name (a scoped packet's transport code matches only its true region; a false match is about 1 in 65,536 per frame). A stored name or `"*"` is never overwritten, and a later `"?"` replaces nothing. `hops`, `path`, `snr` and `rssi` stay with the first ingestor that stored the row; the one exception is a Meshtastic copy that decrypts a stored encrypted row, which replaces its signal fields.
  - All four route fields are serialised back on `GET /api/messages` (absent when `NULL`); none participates in the dedup fingerprint below (the id derivation is byte-identical to pre-RF releases).
- Meta: `channel_name` (string; only when not encrypted and known), `ingestor` (canonical host id), `lora_freq`, `modem_preset`
- `protocol` (optional string; `"meshtastic"`, `"meshcore"`, or `"reticulum"`) - explicit per-record protocol stamp. Takes precedence over the value inherited from the registered ingestor; values outside the whitelist fall back to the ingestor lookup, then to `"meshtastic"`. Ingestors SHOULD stamp this on every message so the web app classifies senders correctly even before the ingestor heartbeat is processed.

Cross-ingestor deduplication. The `id` field is the sole dedup key - the server collapses repeat POSTs on the `messages.id` PRIMARY KEY. Protocols that lack a firmware-assigned packet ID MUST derive a stable, sender-side fingerprint so that the same physical transmission heard by multiple ingestors produces the same `id`. The id MUST fit in 53 bits (`0 <= id <= (1 << 53) - 1`) to round-trip through the JavaScript frontend without precision loss.

For MeshCore the canonical fingerprint is:

```
v1:<sender_identity>:<sender_timestamp>:<discriminator>:<text>
```

hashed with SHA-256 and truncated to 53 bits (first 7 bytes, masked). Components:

- `sender_identity` - for channel messages, the lowercased+stripped sender name parsed from a leading `SenderName:` prefix in the message text (split on the first colon, surrounding whitespace stripped); for direct messages, the sender's `pubkey_prefix` from the MeshCore event payload. Empty string when unavailable - when the channel-message text lacks any `SenderName:` prefix the dedup degrades and two distinct senders sharing timestamp + channel + text collide. In practice MeshCore clients always prefix the name; the residual risk is anonymous/malformed transmissions.
- `sender_timestamp` - Unix seconds from the sender's clock (identical across receivers).
- `discriminator` - `c<N>` for channel messages on channel `N`, `dm` for direct messages.
- `text` - the message text exactly as transmitted.

The `v1:` prefix lets the format evolve (e.g. add a channel-secret hash) without colliding with previously-written ids.

Known limitations of the v1 fingerprint:

- *Format-string ambiguity around `:`.* Components are joined with literal colons and not length-prefixed, so a colon embedded in `sender_identity` or `text` can shift the field boundary and collide two distinct triples. Rare in practice. A `v2` revision should use a delimiter that cannot appear in any component (e.g. `\x00`), or length-prefix each field.
- *meshcore_py text-decoding inconsistency.* The upstream reader strips trailing `\0` bytes on the real-time path but not on sync-replay, so one physical message heard both ways can produce two fingerprints (a duplicate row). Out of scope for the ingestor; track upstream.
- *Sender-side clock reset.* MeshCore nodes without an RTC start `sender_timestamp` from `0` after reboot, so two same-text messages from one sender within a second of power-on collapse into one row. Accepted trade-off (the alternative is no dedup at all).
- *Relay-rewritten `sender_timestamp`, differing local channel slots & cross-ingestor clock skew.* A rewritten `sender_timestamp`, or two ingestors holding one channel at different local slots (the `c<N>` discriminator is the receiver's slot index), gives one physical transmission two ids, so the `messages.id` PK collapse cannot merge the copies; clock drift between the two ingestors then separates their `rx_time`. The web app additionally dedups on insert: for `protocol = "meshcore"` with non-empty `text` and a known `from_id`, an earlier row that also has a `from_id`, within ±`MESHCORE_CONTENT_DEDUP_WINDOW_SECONDS` (default 300 s) of `rx_time`, absorbs the copy when it matches `(to_id, channel_name, text)` for a channel broadcast (`to_id = "^all"`) whose text carries a `SenderName:` prefix, and `(from_id, to_id, channel_name, text)` otherwise. Broadcasts skip `from_id` because each ingestor resolves the sender against its own roster (its pubkey id, or the name-derived synthetic id), while the prefix in `text` already names the sender. The key uses the sender-stable `channel_name`, not the per-receiver `channel` slot index. The copy is applied to the earliest such row as if it carried that row's `id` (sender ranking per SPEC MR3, columns the stored row lacks), not stored as a second row. Accepted trade-off: identical text repeated on the same channel within the window silently collapses to one row, including identical text from two devices that share a display name. Ingestors MUST still produce deterministic v1 ids - this content-level layer is additive, not a replacement. A one-shot, `PRAGMA user_version`-gated backfill (re-run by bumping `MESHCORE_CONTENT_DEDUP_BACKFILL_VERSION`, currently 3) clears pre-existing duplicates on startup with the same key, transitively (a chain of identical-content rows collapses even if the chain spans longer than the window). New rows are governed only by the per-insert guard, which does not catch copies further apart than the window, a copy without `channel_name` next to a named one, one channel stored under two different `channel_name` labels, or the concurrent-insert race below.
- *Concurrent-insert race.* The content-dedup check and the insert are not wrapped in a shared transaction, so two concurrent threads carrying the same content with different ids can both pass the check and both insert. Narrow (single-node, multi-threaded ingest) and not cleaned up retroactively, since the backfill above is one-shot. A future fix would wrap the meshcore pre-check + id-PK path in `db.transaction(:immediate)`.
- *Upstream `meshcore` reader crash on truncated advertisements.* `meshcore-py` can raise from `MessageReader.handle_rx` when an advertisement frame omits its trailing `path_hash_mode` byte, silently dropping the event (`Task exception was never retrieved`). The ingestor patches around it (`data/mesh_ingestor/protocols/_meshcore_patches.py`): logs the offending frame under `context=meshcore.reader.patch` and lets the task exit cleanly, with a loop-level `context=asyncio.unhandled` handler as backstop. Additive; removable once upstream ships a defensive length check.

#### `POST /api/positions`

Single position payload:

- Required: `id` (int), `rx_time` (int), `rx_iso` (string)
- Node: `node_id` (canonical string), `node_num` (int|nil), `num` (int|nil), `from_id` (canonical string), `to_id` (string|nil)
- Key: `public_key` (string|absent) - the full public key of the MeshCore advert or contact the position came from. A position carrying one moves the node row only when it is the key the row is bound to; the position row itself is stored either way (SPEC NI3). Meshtastic and Reticulum positions carry none.
- Position: `latitude`, `longitude`, `altitude` (floats|nil)
- Position time: `position_time` (int|nil)
- Quality: `location_source` (string|nil), `precision_bits` (int|nil), `sats_in_view` (int|nil), `pdop` (float|nil)
- Motion: `ground_speed` (float|nil), `ground_track` (float|nil)
- RF/meta: `snr`, `rssi`, `hop_limit`, `bitfield`, `payload_b64` (string|nil), `raw` (mapping|nil), `ingestor`, `lora_freq`, `modem_preset`
- `protocol` (optional string; `"meshtastic"`, `"meshcore"`, or `"reticulum"`) - explicit per-record protocol stamp; same semantics as on `POST /api/messages`.

Sentinel handling (issue #782). The same rules as `POST /api/nodes` apply here:

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
  `heart_bpm`, `spo2`, `health_temperature` (body temperature - deliberately
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
  field names; nested family objects are consulted for values, not only
  for type inference. All metric additions are additive (D8) - absent keys
  are simply omitted, never sent as `null`.
- Subtype: `telemetry_type` (string|nil) - optional discriminator identifying which Meshtastic protobuf oneof was set; one of `"device"`, `"environment"`, `"power"`, `"air_quality"`, `"local_stats"`, `"health"`, `"host"`, or `"traffic"` (the last four added additively for the LocalStats / HealthMetrics / HostMetrics / TrafficManagementStats variants, TI-A1). Ingestors that detect the subtype SHOULD include this field; omit rather than send `null` when unknown. The web app infers the type from metric-field presence when absent, so old ingestors remain compatible.
- Meta: `ingestor`, `lora_freq`, `modem_preset`
- `protocol` (optional string; `"meshtastic"`, `"meshcore"`, or `"reticulum"`) - explicit per-record protocol stamp; same semantics as on `POST /api/messages`.

MeshCore telemetry sourcing (TI-A3). MeshCore exposes other nodes' telemetry only as on-air *pull* requests (there is no unsolicited telemetry broadcast the companion library surfaces), so the MeshCore provider collects it three ways and normalises every reading into this same payload shape with `protocol="meshcore"`: (1) host self-telemetry over the local companion link (`get_bat` → battery millivolts as `voltage`; `get_self_telemetry` → the host's CayenneLPP sensor list), no LoRa airtime, cadence `MESHCORE_SELF_TELEMETRY_SECONDS` (default 3600 s, matching the host-telemetry suppression window; `<= 0` disables); (2) round-robin contact polling (`req_telemetry_sync`, falling back to `req_status_sync` when a node reports no sensors) at one on-air request per `MESHCORE_TELEMETRY_POLL_SECONDS` (default 300 s; `<= 0` disables) regardless of roster size, with each contact additionally capped at one poll per 24 h (a fixed per-node cooldown, stamped at the poll attempt so unreachable nodes are not hammered; when every contact is fresh the tick transmits nothing) - and the transmit policy gates these on-air polls entirely - they require `TX_ENABLED=1` (default `0`, so an ingestor polls no other node unless its operator opts in), and the legacy `RX_ONLY=1` vetoes them regardless; the local self reads in (1) cost no airtime and are unaffected; (3) unsolicited/tag-matched events (`TELEMETRY_RESPONSE`, `STATUS_RESPONSE`, `BATTERY`) whenever the radio surfaces them. CayenneLPP types map to canonical keys (`temperature`, `humidity`→`relative_humidity`, `barometer`→`barometric_pressure`, `voltage`, `current` - scaled A→mA to match the Meshtastic column convention, `illuminance`→`lux`, `percentage`→`battery_level`); status `bat`/`level` millivolt gauges map to `voltage` (V). MeshCore assigns no firmware packet id, so the record `id` is the deterministic 53-bit fingerprint of *(node id, receive second, source kind)* - re-reads of the same source in the same second collapse into one row via the `telemetry.id` upsert.

#### `POST /api/neighbors`

Neighbors snapshot payload:

- Node: `node_id` (canonical string), `node_num` (int|nil)
- `neighbors`: list of entries with `neighbor_id` (canonical string), `neighbor_num` (int|nil), `snr` (float|nil), `rx_time` (int), `rx_iso` (string)
- Snapshot time: `rx_time`, `rx_iso`
- Optional: `node_broadcast_interval_secs` (int|nil), `last_sent_by_id` (canonical string|nil)
- Meta: `ingestor`, `lora_freq`, `modem_preset`
- `protocol` (optional string; `"meshtastic"`, `"meshcore"`, or `"reticulum"`) - explicit per-record protocol stamp; same semantics as on `POST /api/messages`.

#### `POST /api/traces`

Single trace payload:

- Identity: `id` (int|nil), `request_id` (int|nil)
- Endpoints: `src` (int|nil), `dest` (int|nil)
- Path: `hops` (list[int])
- Time: `rx_time` (int), `rx_iso` (string)
- Metrics: `rssi` (int|nil), `snr` (float|nil), `elapsed_ms` (int|nil)
- Meta: `ingestor`, `lora_freq`, `modem_preset`
- `protocol` (optional string; `"meshtastic"`, `"meshcore"`, or `"reticulum"`) - explicit per-record protocol stamp; same semantics as on `POST /api/messages`.

#### `POST /api/waypoints`

Single waypoint payload (Meshtastic `WAYPOINT_APP` broadcasts - community
points of interest; SPEC W1/W2). The collection is protocol-neutral: any
protocol may emit waypoints via this shape, Meshtastic is simply today's only
emitter.

- Required: `id` (int - the sender-assigned waypoint id, not a packet id), `rx_time` (int), `rx_iso` (string)
- Author: `node_id` (canonical string), `node_num` (int|nil), `from_id` (string/int)
- Content: `name` (string|nil), `description` (string|nil), `icon` (int|nil - unicode codepoint rendered as the marker glyph)
- Position: `latitude`, `longitude` (floats|nil; the protobuf `latitude_i`/`longitude_i` 1e-7 integer forms are also accepted). The paired `(0, 0)` no-fix sentinel is collapsed to NULL on both axes (issue #782 rules).
- Lifecycle: `expire` (int unix|nil - `0`/absent means never expires and is stored as NULL), `locked_to` (canonical string or int node num|nil - `0` means unlocked; stored as the canonical `!%08x` id)
- RF/meta: `snr` (float|nil), `rssi` (int|nil), `hop_limit` (int|nil), `payload_b64` (string|nil), `ingestor`
- `protocol` (optional string; `"meshtastic"`, `"meshcore"`, or `"reticulum"`) - explicit per-record protocol stamp; same semantics as on `POST /api/messages`.

Upsert semantics (SPEC W5). Rows are keyed on `(id, protocol)`: a
re-broadcast of the same waypoint id replaces the content fields outright
(`name`, `description`, `icon`, coordinates, `expire`, `locked_to`) - the
newest broadcast is the full new state, so a cleared description or moved pin
propagates - while RF metadata COALESCEs (an update omitting `snr` keeps the
last reading). An out-of-order re-broadcast whose `rx_time` is older than the
stored row is ignored entirely, so two ingestors relaying one waypoint can
never regress a newer edit (the C5 cross-ingestor dedup applied to POIs).

Privacy (SPEC W3). Waypoint `name`/`description` are user-authored
content, so the read surface is gated at message grade: under `PRIVATE=1`
`GET /api/waypoints` returns 404 and no `waypoints` SSE change events are
emitted. Unlike `/api/messages`, the ingest `POST` stays open in private mode
(data may be collected, never exposed). Waypoints whose author node carries
the opt-out marker are excluded from every read surface.

#### `POST /api/ingestors`

Heartbeat payload:

- `node_id` (canonical string; a value that is not a node reference answers `400`)
- `start_time` (int), `last_seen_time` (int)
- `version` (string)
- Optional: `lora_freq`, `modem_preset`
- Optional: `protocol` (string; `"meshtastic"`, `"meshcore"` or `"reticulum"`, case and surrounding spaces ignored) - declares the mesh backend for this ingestor; defaults to `"meshtastic"` when absent or any other value (SPEC SL7)
- Optional: `packets` (int ≥ 0) - mesh-activity delta (SPEC MA1/MA2). The merged count of *every* frame this ingestor handled since its previous heartbeat: all received frames (including ignored / errored / unimplemented) plus its own transmissions (announcement + MeshCore telemetry polls), counted at the earliest receive/transmit seam so nothing is under-reported. It is a per-interval delta (reset on each send), not a since-boot cumulative. Additive and backward-compatible: an absent or negative value records no activity, so pre-feature ingestors are unaffected.

Mesh-activity time-series (SPEC MA3). Each heartbeat carrying a non-negative `packets` value appends one append-only row to the `ingestor_activity` table (`ingestor_id`, `at`, `packets`, `protocol`; `data/ingestor_activity.sql`); the `ingestors` snapshot row is upserted as before. Each ingestor's contribution is stored separately (never pre-summed) so a packets/hour moving average is computable across time × protocol × multiple ingestors. The row is best-effort - a failed activity insert never sinks the liveness heartbeat (still `201`). Rows are pruned by the retention worker on `at`. The read-side aggregate is served by `GET /api/stats` (`<scope>.packets.hour`, below).

Protocol propagation: all event records (`messages`, `positions`, `telemetry`, `traces`, `neighbors`) that reference this ingestor via their `ingestor` field inherit its `protocol` value at write time when no explicit per-record `protocol` stamp is present. Per-record stamps take precedence - the ingestor heartbeat default only kicks in when the per-record field is absent or malformed.

POST response & validation (0.7.0). Every `POST /api/*` ingest route returns `201 Created` with `{"status":"ok"}` on success (`POST /api/instances` returns `{"status":"registered"}`). A batch route (`messages` / `positions` / `telemetry` / `neighbors` / `traces`) accepts either a single record object or an array of them; any other top-level JSON type is rejected with `400 {"error":"invalid payload"}`, matching the `/api/nodes` and `/api/ingestors` object check. Clients should treat any `2xx` as success.

Field limits (SPEC SL1-SL10). Every ingest write bounds the strings it stores, in UTF-8 bytes, and still answers 201. Free text (T) is cut to its longest prefix of whole grapheme clusters within the cap (whole code points when one cluster alone is longer). A token (N: an id, key, enum label or encoded payload) over its cap is stored as `NULL`. A value within its cap is stored as posted. A numeric field is stored as a number or `NULL`, never as text: a numeric string such as `"5.5"` is converted, and text that is no number, a mapping or a list is stored as `NULL` (node `hopsAway`, `snr`, `rssi`, `isFavorite`, `user.isUnmessagable`, `deviceMetrics.*` and `position.altitude`; message `channel`, `snr`, `rssi` and `hop_limit`; every other numeric field was already converted). In every numeric field, an integer outside the signed 64-bit range and a number that is not finite are stored as `NULL`. Rows stored before the caps existed are left as they are and age out under retention.

| Field | Cap (bytes) | Policy |
| --- | --- | --- |
| node `user.longName`, a destination's name | 512 | T |
| node `user.shortName` | 16 | T |
| node `user.hwModel` / `hwModel` | 64 | N |
| node `user.role`, `destination.role` | 32 | N |
| node `user.macaddr` | 32 | N |
| node `user.publicKey` | 512 | N; a key stored as `NULL` is no keyed evidence (SPEC SL4) |
| node `identityHash`, `destination.id` | 64 | N; a destination without an id is not stored |
| `destination.aspect` | 64 | N |
| node `interface` | 256 | T |
| `location_source`, `modem_preset`, `portnum`, `telemetry_type` | 32 | N |
| message `text` | 1024 | T |
| message `encrypted`, every `payload_b64` | 512 | N |
| message `channel_name` | 64 | T |
| message `emoji` | 64 | N |
| message `path` | 512 | N |
| every `rx_iso` | 32 | N; the web app derives a missing one from `rx_time` |
| telemetry `user_string` | 256 | T, wherever the record nests it |
| telemetry `one_wire_temperature` | 8 entries | the first 8 are kept |
| waypoint `name` | 128 | T |
| waypoint `description` | 512 | T |
| heartbeat `version` | 64 | T |

Each cap sits well above the longest value the radio protocols produce. The ingestor trims a string longer than its cap plus 64 bytes, on a code-point boundary, before it posts it (`data/mesh_ingestor/field_limits.py`, SPEC SL8); the web app makes the final cut (`web/lib/potato_mesh/application/data_processing/field_limits.rb`). A field added to a payload gets a cap in both tables.

A signed instance field is never cut, since a cut value no longer matches its signature (SPEC SL6). `POST /api/instances` answers `400 {"error":"name exceeds 256 bytes"}` (likewise `version`, `channel`, `frequency` and `contact_link`), `400 {"error":"public_key exceeds 2048 bytes"}` and `400 {"error":"signature exceeds 1024 bytes"}` before it checks the signature; a crawl skips such a record from a peer's `/api/instances` and logs `warn` "Discarded remote instance entry" with that reason.

### GET endpoint filtering

All collection GET endpoints (`/api/nodes`, `/api/messages`, `/api/positions`, `/api/telemetry`, `/api/traces`, `/api/neighbors`, `/api/ingestors`, `/api/waypoints`) accept an optional `?protocol=<value>` query parameter. When present, only records whose `protocol` column matches the given value are returned. The `protocol` field is included in all GET responses.

Privacy (SPEC HC1, HC7). Under `PRIVATE=1` the read routes leave out a node whose role is `CLIENT_HIDDEN`, bulk and per id. `GET /api/nodes` omits it and `/api/nodes/:id` returns 404. `/api/positions`, `/api/telemetry`, `/api/telemetry/aggregated`, `/api/destinations` and `/api/ingestors` drop the rows whose `node_id` is that node, `/api/neighbors` a link with it at either end, and `/api/traces` a trace from or to it; a trace between other nodes keeps its row, with the hidden node removed from `hops`, and `/api/traces/:id` for the hidden node returns `[]`. The `/api/stats` counts leave its rows out, `GET /version` `last_node_update` and the well-known document's `last_update` ignore it, and `/nodes/:id` returns 404. `/api/messages` and `/api/waypoints` already return 404 under `PRIVATE=1`. The ingest `POST` routes still store its rows; with `PRIVATE` unset they are served. In either mode `/api/traces/:id` for an opted-out node returns `[]` too.

### GET endpoint time windows

Every read endpoint enforces a server-side rolling-window floor on the data it returns. The window is fixed per route and cannot be widened by the caller - explicit `?since=<unix_seconds>` is treated as `MAX(since, floor)`, so a `since` older than the floor is silently clamped to the floor. Pass a `since` newer than the floor when you want to be more restrictive (incremental refresh).

| Route | Floor (default) | Notes |
| --- | --- | --- |
| `GET /api/nodes` | 7 days | filtered by `nodes.last_heard` |
| `GET /api/messages` | 7 days | filtered by `messages.rx_time` |
| `GET /api/positions` | 7 days | filtered by `COALESCE(rx_time, position_time)` |
| `GET /api/telemetry` | 7 days | filtered by `COALESCE(rx_time, telemetry_time)` |
| `GET /api/instances` | 7 days | filtered by `instances.last_update_time` |
| `GET /api/waypoints` | 7 days | filtered by `waypoints.rx_time`; rows past their `expire` timestamp are additionally excluded from the moment of expiry (SPEC W5). 404 under `PRIVATE=1` (message-grade privacy, SPEC W3). The per-author `GET /api/waypoints/:id` (SPEC W11 - feeds the node page's Waypoints section) uses the standard per-id 28-day window and the same expiry/privacy gates. |
| `GET /api/destinations` | 7 days | filtered by the owning node's `nodes.last_heard`, the `/api/nodes` window; `?node_id=` takes the per-id 28-day window. The destination's own `last_heard` is capped at 28 days on both, and the `since` clamp applies to that cap (SPEC RA8). |
| `GET /api/neighbors` | 28 days | sparse data; widened to keep slow scrapes visible |
| `GET /api/traces` | 28 days | sparse data; same rationale |
| `GET /api/ingestors` | 28 days | sparse heartbeats; same rationale |
| `GET /api/.../:id` (per-id lookup) | 28 days | every per-id route uses the extended window so callers can backfill historical context for a specific node/conversation that has dropped out of the bulk view. The `since` clamp still applies. |
| `GET /api/telemetry/aggregated` | caller-controlled | `?windowSeconds=<N>` is mandatory; defaults to 86 400 (1 day). Bounded by `MAX_QUERY_LIMIT` on bucket count, not by a hard floor. |
| `GET /api/stats` | n/a | reports activity counts at fixed `hour`/`day`/`week`/`month` buckets; response shape documented below. |

Federation peers should not assume an unbounded historical window: a peer that requests `/api/messages?since=0` from a partner expecting "everything" will only ever receive the last seven days. To pull older state, request the per-id endpoint (28 days) for the relevant nodes.

The constants live in `web/lib/potato_mesh/config.rb` (`week_seconds`, `four_weeks_seconds`).

### GET endpoint backward pagination (`?before=`)

The eight bulk collection endpoints - `GET /api/nodes`, `/api/positions`,
`/api/telemetry`, `/api/neighbors`, `/api/traces`, `/api/ingestors`,
`/api/waypoints`, and `/api/destinations` - plus the
pre-existing `GET /api/messages` cursor accept an optional `?before=<unix_seconds>`
inclusive upper-bound cursor for backward pagination. It is the companion to
`?since=`: where `since` raises the lower bound of the window, `before` lowers the
upper bound. `before` bounds each route's primary sort column - the column it
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
| `GET /api/destinations` | `last_heard` |

To page backward through more than one `limit`-sized response (the per-request cap
is `MAX_QUERY_LIMIT` = 1000), walk newest → oldest: fetch a page, then re-request
with `before` set to the oldest sort-column value in the page just received,
de-duplicating rows by their id. The inclusive `<=` boundary intentionally repeats
any row that shares the boundary second, so none is skipped across the page break;
the client's id-dedup collapses the one-row overlap. Repeat until a short page
(fewer than `limit` rows) signals the window is exhausted. This is how a client
retrieves every in-window row instead of stalling at the newest 1000.

`before` only ever narrows the result set, so - exactly like `since` - it
cannot widen the window past the route's floor in the table above: a `before`
older than the floor merely returns fewer rows (the floor still clamps the lower
bound), and a `before` newer than "now" is a no-op. A non-positive or non-integer
`before` is ignored (treated as absent). The cursor composes with `?protocol=` and
is protocol-neutral. The per-id routes (`GET /api/.../:id`) and `GET /api/instances`
do not accept `before`.

### Reticulum radio metadata (SPEC RL1/RL3)

Reticulum announces carry no radio parameters, so the provider supplies them
from the operator's own stack.

- Source: the first `RNodeInterface` block of the shared RNS config
  (`frequency`, `bandwidth`, `spreadingfactor`, `codingrate`). Only those four
  keys, and the host position keys below, are read - the same file holds
  `rpc_key`, which is never read or logged.
- RNS stores both frequencies in Hz; they are emitted as MHz and kHz.
- `RETICULUM_FREQ` / `RETICULUM_PRESET` override the parsed values.
- The preset is a Meshtastic preset name when the BW/SF/CR triple matches
  one exactly, else `SF{sf}/BW{bw}/CR{cr}`. The name describes radio settings
  and is not an interoperability claim.
- Every Reticulum node record carries the ingestor's configured `lora_freq` /
  `modem_preset`, whatever interface it was heard on (known gap: an IP peer
  gets the RNode's values too).
  The other protocols reach `nodes.lora_freq` through their position and
  telemetry payloads; an announce carries neither, so without this the values
  never leave the ingestor heartbeat. An unresolved value is omitted, never
  sent as null.
- Read once at startup: a config file is not the running stack, and
  `get_interface_stats` exposes no radio parameters to ask instead. Reconfiguring
  `rnsd` without restarting the ingestor leaves the reported values stale.

### Host-owned destinations (SPEC RE8)

The ingestor's own aspects are discovered from the running stack. A local app's
announce reaches the ingestor at 0 hops while both are attached, but one made
before the ingestor connected is not replayed, and `rns.transport` never
announces. The discovered records are emitted with the node snapshot at connect
and on every self-node report after it (1 h), so they stay fresh on a
connection that never recycles.

- Source: 0-hop entries of the running stack's path table, mapped to their
  owning identity via `RNS.Identity.recall`.
- The host's primary identity is the one fronting the most such
  destinations, with the transport identity excluded from that count.
- Aspects are labelled by recomputing each known aspect's destination hash from
  the identity hash (a destination hash is one-way and cannot be read back).
- Emitted as ordinary node records sharing one `nodeId`, each carrying its own
  `destination` mapping, so no separate ingest route is involved.
- Refreshed through `self_node_items(iface)`, an optional provider hook that
  returns a list of `(node_id, node)` pairs. The daemon prefers it on the self-node timer
  and falls back to the single-record `self_node_item` (MeshCore). Records are
  returned only while the primary identity's node id is the registered host id,
  so a second local identity that comes to front more destinations does not
  take `rns.transport` onto its own node row through the report (the connect
  snapshot is not yet tied to the host id). Local reads only, nothing is
  transmitted. The transport gate is re-evaluated at every report.
- An aspect whose app disconnects, or whose path entry expires (RNS culls one
  7 days after its timestamp unless traffic flows through it), leaves the 0-hop
  table and is no longer refreshed.

### Reticulum host position (SPEC RP1-RP6)

Announces carry no position, so the provider publishes one for its own host
only, from the operator's own RNS config.

- Source: `latitude`, `longitude` and, if present, `height` (metres) in the
  first `RNodeInterface` block of the shared RNS config, found by the same
  block reader as the radio metadata above. Read whether or not `discoverable`
  is set. `location_cmd` is never run, and no other key leaves the parser.
- Read once per connect, as RNS's own config parser reads it: a key counts
  only under its exact name once one pair of quotes is stripped from it
  (`Latitude` is not read), and one matching pair of single or double quotes
  is stripped from each value. The radio metadata keeps its own rule:
  case-insensitive keys, values as written. No coordinates means no position. An
  invalid coordinate means no position and one warning: one coordinate without
  the other, a latitude or longitude that is not a finite number, a latitude
  beyond 90 or a longitude beyond 180 degrees, or `0, 0`. A `height` that is
  not a finite number drops only the altitude, with one warning that names the
  key but not the value.
- Published as written: no rounding and no `precisionBits`.
- Node records: every record keyed on the registered host id, in the connect
  snapshot and in every self-node report, carries `position` =
  `{latitude, longitude, altitude?, time, locationSource: "LOC_MANUAL"}`, with
  `time` the report time. No other node's record carries one.
- Bare host record: when no record carries the registered host id, because
  nothing on the stack announces (Docker's default volume), one record
  `{nodeId, lastHeard, protocol, user: {shortName, longName, role: "PEER"}}`
  named with the node's own placeholder carries the position. It has no
  `destination`, and there is none without a position.
- Positions rows: each self-node report, the first at connect and then hourly,
  posts one `POST /api/positions` row for the host: `id` (the first 7 bytes of
  SHA-256 over `reticulum:<node_id>:<time>`, masked to 53 bits), `rx_time` and
  `position_time` (the report time), `rx_iso`, `node_id`, `from_id` and
  `ingestor` (the host id), `node_num`, `latitude`, `longitude`, `altitude`
  when set, `location_source: "LOC_MANUAL"`, `protocol: "reticulum"`, and the
  configured `lora_freq` / `modem_preset`. They count in the `telemetry`
  umbrella of `GET /api/stats`.
- The row is queued before the report's node records. If it reaches a web app
  that has no row for the host yet, the unknown-node placeholder it creates is
  completed by the record that follows.
- Removal: with the keys deleted, the next connect publishes nothing. A stored
  node position stays, because the node upsert keeps one when a record omits
  it, until it is cleared in the database; no API deletes a position.

### GET /api/nodes placeholder flag (SPEC MR4)

`GET /api/nodes` and `GET /api/nodes/:id` emit `synthetic: true` on a name-derived MeshCore placeholder row - a channel sender not yet matched to a keyed contact - and omit the key on every other row (no `synthetic: false`). Placeholders come only from ingested chat senders (see the `POST /api/nodes` placeholder note), never from mentions, and the reconciliation merge folds them into the real node once its contact is stored and the name is unambiguous (SPEC MR2).

### GET /api/destinations response shape

One row per announced destination, newest `last_heard` first.

- Query params: `?limit=` (capped like other collections), `?since=` and
  `?before=` bounding `last_heard` exactly as the other bulk collections do
  (SPEC RA8), and `?node_id=` to filter to one node. All four compose.
- Floor. A destination is served only while its node is inside the window the
  node read applies - 7 days on `nodes.last_heard`, 28 days with `?node_id=`
  (the per-id window) - and its own `last_heard` is inside 28 days, the API
  visibility cap; `?since=` older than that cap is clamped to it. A node the
  table shows keeps every destination heard inside 28 days. A destination whose
  node aged out of the window, or has no node row, is not served (SPEC RA8).
- Privacy. Honors the node opt-out marker: rows whose `node_id` names an
  opted-out node are omitted, so `?node_id=` for that node returns `[]`. The
  opt-out is node-level: a marker in a non-headline destination's own name hides
  nothing, so the operator puts the marker in the node's headline name. Under
  `PRIVATE=1` the destinations of a `CLIENT_HIDDEN` node are omitted the same
  way (SPEC HC1).
- This route holds no response cache, so `since`/`before` have no cached path to
  bypass; the weak ETag varies with the cursor because it is hashed from the
  body the cursor produced.
- Fields: `id` (destination hash, hex), `node_id`, `identity_hash`, `name`,
  `aspect`, `role`, `interface`, `first_heard`, `last_heard`, `protocol`.
- `name` is the destination's announced display name, else `Reticulum` plus the
  upper-cased first four hex of its own `id`, the placeholder the ingestor sends
  for a nameless destination on the announce and host paths alike (SPEC RA10).
  A destination's placeholder is stored on a first sighting, never replaces a
  stored name and never becomes the node's `long_name`, which is the
  highest-ranked announced name, else a stored name that is not a placeholder,
  else the node's own placeholder (SPEC RE10).
- `identity_hash` groups rows belonging to one peer; several rows share it when
  an identity announces on several aspects.
- Written only by the node ingest route, from each node record's `destination`
  mapping; there is no `POST /api/destinations`.

### GET /api/stats response shape

> Breaking change in 0.7.0. Before 0.7.0 the payload was flat -
> `active_nodes: {hour,day,week,month}` plus integer-valued `meshcore`/`meshtastic`
> sub-hashes. From 0.7.0 it is the scope → metric → window tree below. The change
> is versioned (minor bump) per the backward-compat rule above. Federation
> consumers read the new shape and fall back to the old shape for pre-0.7.0
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

- Scopes. `total` counts every visible row regardless of protocol; `meshcore`,
  `meshtastic`, and `reticulum` are `protocol = ?` subsets, so
  `total ≥ Σ named protocols`. All three named scopes are live: `reticulum`
  shipped as an always-zero forward-looking stub and carries real counts since
  the Reticulum ingestor (`PROTOCOL=reticulum`) landed.
- Metrics. `nodes` counts `nodes` by `last_heard`; `messages` counts `messages`
  by `rx_time`; `telemetry` is the umbrella over `positions` + `telemetry` +
  `neighbors` + `traces` + `waypoints` (every non-message packet record - the
  waypoints table joined the umbrella per SPEC W9, amending S3) by `rx_time`;
  `packets` is the additive MA4/MA5 packets/hour rate (below).
- Windows. The `nodes`/`messages`/`telemetry` metrics map to
  `{ "hour", "day", "week", "month" }` integer counts at the fixed cutoffs
  (1 h / 24 h / `week_seconds` / `four_weeks_seconds`); `month` cannot exceed the
  28-day visibility floor. The `packets` metric carries only `hour` (it is a rate,
  not a windowed count).
- Privacy. Every metric honors the node opt-out marker. When `PRIVATE=1`, all
  `messages` counts are forced to `0` (mirroring the disabled message API), and
  the `nodes` and `telemetry` counts leave out `CLIENT_HIDDEN` nodes and the
  umbrella rows that reference one by `node_id`, `neighbor_id`, `src` or `dest`,
  as the GET routes do (SPEC HC3).
- `<scope>.packets.hour` (additive, SPEC MA4/MA5) carries the 24-hour
  packets/hour moving average as a rounded integer, exposed as a `packets` metric
  under each scope (single `hour` window). It is aggregated MAX-per-protocol:
  `MAX` over that protocol's ingestors of *(the ingestor's `packets` total in the
  last 24 h ÷ 24)* - a single radio hears ≤ what is actually transmitted, so the
  busiest vantage is the best dedup-free estimate of air traffic and never
  double-counts a frame heard by two radios. `total.packets.hour` is the SUM
  of the per-protocol rates (distinct protocols ride distinct frequencies, so they
  add rather than dedup); `reticulum.packets.hour` shipped as an always-zero
  stub and reports the real rate since the Reticulum ingestor landed. The rate
  only moves when the reticulum ingestor's heartbeat registers, which needs a
  node id: the provider derives one from the host's primary identity once
  something on its RNS stack announces and no two identities tie, and otherwise
  needs `INGESTOR_NODE_ID`,
  as with Docker's default `potatomesh_reticulum` volume (SPEC RE8). Unlike
  `messages`, it is not privacy-gated
  (packets are a public aggregate, no message content). Additive to the 0.7.x
  `/api/stats` tree - no version bump; the ingestor dogfeeds it for the activity
  announcement (MA6).
- `sampled` is unchanged: always `false` (the counts are exact, not sampled).

### GET /api/stats/activity packets/hour time-series (SPEC F2)

A bucketed packets/hour series over `ingestor_activity`, feeding the mesh-activity
map-card sparkline and the `/charts` activity figure. snake_case params (the
API norm): `window_seconds` (default 86 400, clamped to the 28-day floor) and
`bucket_seconds` (default 3 600); a bucket count over `MAX_QUERY_LIMIT` is a `400`.
An optional `since` bypasses the response cache.

```jsonc
[
  { "bucket_start": 1785000000, "bucket_end": 1785003600, "total": 130, "meshcore": 44, "meshtastic": 76, "reticulum": 10 },
  …
]
```

Each bucket's per-protocol value is the MAX over that protocol's ingestors of
their summed `packets` in the bucket, ÷ the bucket's hour-span → a packets/hour
rate; `total` is the SUM across protocols (matching the live
`<scope>.packets.hour`, SPEC MA4). Every known protocol (`meshcore`,
`meshtastic`, `reticulum`) emits its own series key; `reticulum` originally
folded into `total` without a key and went live with the Reticulum ingestor
(SPEC F2-2 as amended). Buckets are ascending by `bucket_start`. Additive,
read-side - no version bump.

### GET /api/events live-update stream (SSE)

A read-only Server-Sent Events stream (`text/event-stream`) that pushes thin
"this collection changed" notifications so the dashboard refreshes on change
instead of polling on a fixed interval. It is outbound only - it accepts no
body, writes nothing, and is not an ingest path; it carries no row data. The
fan-out is in-process (no MQTT/broker/cloud bus), preserving the apex
invariant; this endpoint adds no ingestor obligation (the Python ingestor never
consumes it).

Each change is one SSE frame:

```
event: change
data: {"collection":"messages","hint":1700000000}
```

- `collection` is one of `nodes`, `messages`, `positions`, `telemetry`,
  `neighbors`, `traces` - exactly the dashboard ingest collections. The client
  reacts by re-running its existing delta fetch (`GET /api/<collection>?since=…`)
  and merging by id; no row data is delivered over the stream.
- A `POST /api/messages` ingest publishes *two* events - `messages` and
  `nodes` - because a message also touches the author node's `last_heard`
  (#822). One ingest route may therefore emit more than one collection event; a
  client must handle each event independently and must not assume a 1:1
  route→event mapping.
- `hint` (optional integer) is the newest `rx_time`/`last_heard` seen for the
  collection - a skip hint; the client may ignore it and use its own high-water
  mark. It is currently not emitted by the server (reserved).
- The server emits an initial `: connected` comment and periodic `: keepalive`
  heartbeat comments; the connection is closed after a bounded lifetime so the
  client's `EventSource` reconnects (and resyncs).
- Privacy. When `PRIVATE=1` no `messages` events are emitted (mirroring the
  disabled message API); the other collections still emit. Because events carry
  no rows, opt-out / hidden rows never traverse the stream - the client always
  re-fetches through the already-filtered `GET /api/*` routes.
- Config (web app). `EVENTS=0` disables the stream (clients fall back to
  polling at `refresh_interval_seconds`); `SSE_HEARTBEAT_SECONDS` (default 15),
  `SSE_MAX_LIFETIME_SECONDS` (default 600), and `LIVE_SAFETY_POLL_SECONDS`
  (default 300, the client's slow fallback poll) tune the cadence. The endpoint
  is additive - no existing `/api/*` shape changes.

