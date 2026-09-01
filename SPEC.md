<!-- Copyright © 2025-26 l5yth & contributors -->
<!-- Licensed under the Apache License, Version 2.0 (see LICENSE) -->

# PotatoMesh — Product & Engineering Charter (SPEC)

> **Status:** Draft for confirmation (Phase 0 of the kickoff protocol).
> **Nature:** This is a *retrofit guardrail charter* for a mature, shipping
> project (v0.7). It does not design new behavior — it codifies the intent and
> non-negotiable invariants that already hold, **judged against current shipping
> behavior**, so future work by Claude or contributors cannot drift from them.
> The numbered decisions in [§6](#6-key-decisions-confirmation-checklist) must be
> **re-verified at every later checkpoint** (each build bucket, the independent
> review) to prevent drift.

Companion document: [`ACCEPTANCE.md`](./ACCEPTANCE.md) turns every invariant and
decision below into a command-backed, zero-context pass/fail check.

---

## 1. Vision & Apex

**PotatoMesh is a federated Meshtastic & MeshCore node dashboard for a local
community. No MQTT clutter — just local LoRa aether.**

It lets a community stand up its own dashboard fed only by radios its members
actually operate, optionally federate as equals with other communities, and do
so while respecting the privacy of operators and node owners.

### Apex invariant — the line in the sand

> **Local LoRa only. PotatoMesh must never connect to, depend on, or ingest from
> an MQTT broker or any cloud message bus.**

This is the project's identity and its differentiator: every other Meshtastic
dashboard leans on MQTT/cloud. "Local aether only" is what makes PotatoMesh
*PotatoMesh*. When any other invariant, feature, or convenience collides with
this rule, **this rule wins.** Its loss would mean the project is no longer
PotatoMesh.

**Precision (so the rule is enforceable, not superstitious):** the apex bans
PotatoMesh *acting as* an MQTT/cloud client or carrying such a dependency. It
does **not** ban *recording Meshtastic's own `via_mqtt` / `viaMqtt` provenance
flag* (`data/mesh_ingestor/handlers/nodeinfo.py`). That field is metadata about
how a *foreign* node was heard; surfacing it actually serves the invariant by
letting operators identify and reason about MQTT-bridged nodes. The acceptance
check targets dependencies and broker connections, not the substring `mqtt`.

---

## 2. The Four Hard Invariants (ranked)

All four are non-negotiable. They are listed in **priority order**: when two
collide, the higher-ranked one wins. In practice they rarely conflict; the only
conflict that occurs in the running system today (privacy vs. federation) is
already resolved below and in code.

### I. Local LoRa only — never MQTT/cloud  *(apex)*
The dashboard is fed exclusively by ingestors attached to physical radios
(serial / TCP / BLE) that push data through the authenticated `POST /api/*`
routes. No component pulls from MQTT or a cloud broker, and no manifest carries
a broker client. See [Apex](#apex-invariant--the-line-in-the-sand).

### II. Privacy & consent first
`PRIVATE=1` hides the chat UI, disables the message APIs, and excludes hidden
clients from public listings. Node opt-out markers
(`PotatoMesh::Config::NODE_OPT_OUT_MARKER`) and data-retention policies
(`web/lib/potato_mesh/application/retention.rb`) are honored everywhere data is
read or exported. **When privacy collides with federation, privacy wins** —
`PRIVATE=1` always disables federation regardless of `FEDERATION`. Any change
that increases exposure of operators or node owners loses to consent, retention,
and opt-out.

### III. Decentralized, opt-in federation
Instances discover and crawl one another as peers (`FEDERATION` toggle, periodic
well-known refresh, staleness eviction). There is **no central authority,
registry, or gatekeeper**; any instance can run fully isolated (`FEDERATION=0`)
and remain fully functional. Federation publishes only signed, public metadata
and respects remote `isPrivate` peers (`application/federation/crawl.rb`).

### IV. Protocol parity & pluggability
Meshtastic and MeshCore are both first-class; neither is privileged in the data
model or UI. New protocols (e.g. Reticulum) plug in behind the `MeshProtocol`
abstraction (`data/mesh_ingestor/mesh_protocol.py`) and the canonical wire
contract (`data/mesh_ingestor/CONTRACTS.md`) **without changing the Ruby / DB /
UI read-side.**

---

## 3. Cross-cutting decisions

### 3.1 Invariant priority / tie-break order
**Local-LoRa (apex) → Privacy & consent → Federation → Parity.** Higher wins on
collision. The documented `PRIVATE` > `FEDERATION` rule is the concrete instance
of Privacy > Federation and must remain true in code.

### 3.2 Fixed technology stack (per component)
The stack is a guardrail, not an implementation detail. It is **fixed** per
component; a rewrite into another language/framework requires a fresh kickoff,
not an incremental PR.

| Component | Stack (locked) |
| --- | --- |
| `web/` | Ruby + **Sinatra ~> 4**, **SQLite** (sqlite3), Puma, Rackup, kramdown, sanitize, ferrum (headless Chromium for OG image), prometheus-client |
| `data/` | **Python** ingestor — `meshtastic`, `meshcore`, `bleak` (BLE), `protobuf`; `black` + `pytest` |
| `matrix/` | **Rust** — tokio, reqwest (rustls-tls), axum, serde, clap, tracing |
| `app/` | **Flutter / Dart** — http, shared_preferences, flutter_local_notifications, workmanager |

### 3.3 The web app is data-in-by-POST only
The Sinatra app is **never** run attached to a radio. Its only data intake is the
authenticated `POST /api/*` surface; this is what allows many community ingestors
to feed one dashboard with no duplication (dedup by id). SQLite is the system of
record.

### 3.4 Stable data & API contract
- Canonical node id is `!%08x` (lowercase 8-hex), treated as canonical
  system-wide; new protocols must map their native ids into this space.
- The `POST`/`GET` route shapes and event schemas in
  [`data/mesh_ingestor/CONTRACTS.md`](./data/mesh_ingestor/CONTRACTS.md) are the
  contract. They evolve **backward-compatibly**; a breaking change must be
  versioned (as the MeshCore dedup fingerprint already is: `v1:` prefix).
- `POST` routes require `Authorization: Bearer <API_TOKEN>`; `GET` collection
  routes enforce server-side rolling-window floors that callers cannot widen.

### 3.5 Engineering quality bar (from `CLAUDE.md`, non-negotiable for new code)
- **100% unit test coverage** — every line, branch, and path. Codecov target
  **100%**, threshold **10%**, enforced on **both `project` and `patch`**.
- **100% API documentation** to the language standard (PDoc / RDoc / JSDoc /
  rustdoc / dartdoc), plus inline comments where logic is not self-evident.
- **Apache v2 notice on every file**, exact string
  `Copyright © 2025-26 l5yth & contributors` — full header block for source
  files, 2-line notice for non-source files.
- **Formatters clean**: `black` (Python), `rufo` (Ruby).
- **All suites green**: `pytest` (data), `rspec` + `npm test` (web), `cargo test`
  (matrix), `flutter test` (app).
- **CI on every PR to `main` and every push to `main`**, covering each touched
  language; **weekly Dependabot** for every ecosystem.
- **Modularity**: prefer small, single-purpose units; split modules that grow
  large.

---

## 4. Per-component scope

### 4.1 `web/` — Sinatra dashboard *(mature)*
The only public surface and the system of record. Serves the map + chat UI and
the read APIs; accepts ingest via authenticated `POST`; performs federation
(well-known doc, peer crawl, staleness eviction), Prometheus `/metrics`,
OG-image generation, and custom Markdown pages. Enforces invariants II & III.

### 4.2 `data/mesh_ingestor` — Python ingestor *(mature)*
The **only** component that touches radios and the **only** data source. Connects
over serial / TCP / BLE, normalizes Meshtastic **and** MeshCore packets to the
canonical contract, and POSTs them. Multiple ingestors per instance are
supported. Embodies invariants I & IV; honors `ALLOWED_CHANNELS` /
`HIDDEN_CHANNELS` and sentinel-position normalization.

### 4.3 `matrix/` — Matrix bridge *(WIP, read-only)*
A one-way reader bridge: it **reads** messages from a PotatoMesh instance's
public API and forwards them to a configured Matrix channel. No radio. It is a
consumer of the public API and **must not introduce any new ingest path**; it
respects `PRIVATE` (no messages to forward when message APIs are disabled).

### 4.4 `app/` — Flutter mobile app *(WIP, read-only)*
A read-only mobile **reader** of messages on the local aether. `GET`-only client;
no posting, no radio. Respects `PRIVATE`.

> **WIP boundary:** the Matrix bridge and mobile app are feature-bounded as
> *readers* above, but are held to the **same engineering bar** (§3.5) as the
> mature components — 100% test/doc/license/CI applies to all code regardless of
> maturity.

---

## 5. Non-goals (explicit)

- **No MQTT/cloud ingest path — ever.** (Apex.)
- **No central federation authority, registry, or gatekeeper.** Federation is
  peer-to-peer and opt-in.
- **No analytics, tracking, or phone-home.** The only outbound traffic is opt-in
  federation of signed public metadata.
- **The web app is never radio-attached** — data arrives only via authenticated
  `POST`.
- **No privileging of one mesh protocol** over another in the data model or UI.

---

## 6. Key decisions (confirmation checklist)

Per the kickoff protocol, **every item below must be confirmed explicitly**
before I proceed to `ACCEPTANCE.md`. Confirm all, or call out any `D#` to change.

| # | Decision | Source |
| --- | --- | --- |
| **D1** | This SPEC is a **retrofit guardrail charter**, judged against current shipping behavior — not a design for new features. | interview |
| **D2** | **Apex invariant = Local-LoRa-only / never MQTT or cloud**, and it wins every collision. The ban targets broker dependencies & connections, **not** recording Meshtastic's `via_mqtt` provenance flag. | interview + code |
| **D3** | The **four hard invariants** (all non-negotiable): I Local-LoRa-only, II Privacy & consent, III Decentralized opt-in federation, IV Protocol parity & pluggability. | interview |
| **D4** | **Priority / tie-break order:** Local-LoRa → Privacy → Federation → Parity. `PRIVATE` > `FEDERATION` is preserved as the concrete Privacy > Federation rule. | proposed |
| **D5** | **Doc layout:** two root files — `SPEC.md` + `ACCEPTANCE.md` — each opening with vision + ranked invariants, then per-component sections. | interview |
| **D6** | **`ACCEPTANCE.md` enforces four layers**, each as a command-backed, zero-context check: (a) invariant conformance, (b) the restated engineering bar, (c) API & event contracts, (d) operator-facing behavior. | interview |
| **D7** | **Stack is fixed per component** (web=Ruby/Sinatra 4+SQLite, data=Python, matrix=Rust, app=Flutter); a language/framework rewrite needs a new kickoff. | proposed |
| **D8** | **Data/API contract is stable & backward-compatible**: canonical `!%08x` ids, the `CONTRACTS.md` shapes, `POST` auth, `GET` window floors; breaking changes must be versioned. | proposed + code |
| **D9** | **Engineering quality bar** (§3.5) is part of acceptance and applies to all new code: 100% tests, 100% docs, Apache headers, linters, CI on PR+push, weekly Dependabot, Codecov 100%/10% on project **and** patch. | CLAUDE.md |
| **D10** | **Component scope/status:** web + ingestor are mature (full feature acceptance); matrix bridge = one-way reader, mobile app = read-only reader (both WIP, no radio, no new ingest path) — all held to the same engineering bar. | README + interview |
| **D11** | **Non-goals** (§5) are in force: no MQTT ingest, no central federation authority, no analytics/phone-home, web never radio-attached, no protocol privileging. | proposed |

---

## Feature: Chat channel test-deprioritization

Pushes throwaway "test"/"ping"/"bot" channels to the end of the chat channel
tabs so a community's real channels lead. Presentation-only; integrates solely
with the channel-ordering sort in
`web/public/assets/js/app/chat-log-tabs.js` (`buildChatTabModel`).

| # | Decision | Source |
| --- | --- | --- |
| **F1** | **Three-tier channel-tab ordering** in the dashboard and `/chat`: (1) default/primary channels (channel index 0 — e.g. Public, MediumFast, "0"); (2) custom channels (index > 0, e.g. hashtag channels); (3) **test channels last**. Within each tier the existing ordering is preserved unchanged: 7-day message-count descending, then label alphabetical. | interview |
| **F2** | **Test-channel detection** is by the channel's resolved display **label**: the label contains the standalone word `ping`, `test`, or `bot`, case-insensitive, matched at **word boundaries**. So "Camping", "Robotics", "Contest", "Botswana" are **not** test channels; concatenated forms ("MyBot", "test2") are intentionally **not** matched either — the rule favors zero false positives over catching every variant. | interview |
| **F3** | **Default/primary channels are never demoted.** Test classification only reorders custom (index > 0) channels; an index-0 channel always leads even if its name matches a keyword, so the primary community feed is never hidden. | interview |
| **F4** | **Presentation-only & protocol-neutral.** Reorders tabs only — no change to channel membership, message contents/counts, the default-active tab (still the primary), or any data/API surface. Detection is by channel name and identical for MeshCore and Meshtastic, so the change **extends** Invariant IV (protocol parity) without privileging either protocol. | interview |

---

## Feature: /api/stats activity counts (messages & telemetry)

Extends `GET /api/stats` from active-node counts only to a uniform
`{ scope: { metric: { hour, day, week, month } } }` tree covering **nodes**,
**messages**, and **telemetry**, each as a grand `total` and a per-protocol
breakdown. The response shape changes incompatibly, so the change is a
**versioned breaking change** released as **0.7.0** with **one-way** federation
compatibility (new instances read old peers; old instances reading a new peer
degrade gracefully to their existing node-list fallback). Integrates with
`web/lib/potato_mesh/application/queries/node_queries.rb`
(`query_active_node_stats`), the `GET /api/stats` route in
`application/routes/api.rb`, the federation consumer in
`application/federation/crawl.rb`, `PotatoMesh::Config.version_fallback`, and
`data/mesh_ingestor/CONTRACTS.md`.

| # | Decision | Source |
| --- | --- | --- |
| **S1** | **Breaking, versioned response shape.** `/api/stats` returns `{ <scope>: { <metric>: { hour, day, week, month } }, sampled }` where `<scope>` ∈ {`total`, `meshcore`, `meshtastic`, `reticulum`} and `<metric>` ∈ {`nodes`, `messages`, `telemetry`}. This **breaks** the prior flat shape (`active_nodes` / flat `meshcore` / flat `meshtastic`) and is therefore a **versioned** break per D8: it ships under a minor bump to **0.7.0**, applied in lockstep across the five language manifests that `tests/test_version_sync.py` keeps in sync (`data.VERSION`, `Config.version_fallback`, `web/package.json`, `app/pubspec.yaml`, `matrix/Cargo.toml` + `Cargo.lock`), plus the maintainer's `git tag v0.7.0` release. **Explicitly amends D8's "evolve backward-compatibly" expectation for this route**; the apex (I) and privacy (II) invariants are untouched. | interview (D8 amendment) |
| **S2** | **`total` is unfiltered; protocol scopes are subsets.** `total.<metric>` counts all rows regardless of protocol; `meshcore` / `meshtastic` / `reticulum` are `WHERE protocol = ?` subsets (so `total` ≥ Σ named protocols). `total.nodes` reproduces the prior `active_nodes`, and `meshcore.nodes` / `meshtastic.nodes` reproduce the prior flat per-protocol node counts — identical values, relocated. | interview |
| **S3** | **`telemetry` is an umbrella metric.** The `telemetry` count aggregates **positions + telemetry + neighbors + traces** (every non-message, non-nodeinfo packet record), counted by each table's `rx_time`. `messages` counts the `messages` table by `rx_time`; `nodes` counts `nodes` by `last_heard` (unchanged from today). | interview |
| **S4** | **Activity windows unchanged.** Every count uses the existing cutoffs — `hour` (3600s), `day` (86 400s), `week` (`week_seconds`), `month` (`four_weeks_seconds`) — so no count can surface activity beyond the 28-day API visibility floor (preserves C4 / `MAX_QUERY_LIMIT` reasoning). | interview + code |
| **S5** | **Privacy: messages zeroed in private mode** (Invariant II). When `private_mode?`, every `messages` count (in `total` and all protocol scopes) is **0**, mirroring the `PRIVATE=1` message-API 404 (A2a) so stats never leak message volume that privacy hides. Node counts keep the `CLIENT_HIDDEN` exclusion; **all** metrics honor the node opt-out marker via the per-table opt-out filter (`opt_out_self_filter` for `nodes`; `opt_out_node_id_filter` / `opt_out_node_num_filter` for the message and telemetry-umbrella tables, matching the existing list endpoints). Telemetry/positions/neighbors/traces are not gated by `PRIVATE`, so those counts remain reported. | interview |
| **S6** | **`reticulum` is a first-class protocol scope.** As first shipped, `reticulum` was a forward-looking zero stub: always emitted with all-zero counts, adding no ingest path and never entering `KNOWN_PROTOCOLS`. **Amended with the Reticulum ingestor** (`PROTOCOL=reticulum`, the passive RNS announce listener): `reticulum` now **enters `KNOWN_PROTOCOLS`** — the `?protocol=` query param and the per-record/wrapper ingest whitelist accept `meshcore` + `meshtastic` + `reticulum` — and the scope carries **live** `WHERE protocol = ?` counts exactly like the other named scopes (S2 applies unchanged). The stub served its purpose: the response shape extended to a live third protocol without another break, and no protocol is privileged (Invariant IV). | interview (amended) |
| **S7** | **One-way federation compatibility (new reads old).** Federation consumers (`crawl.rb`) try the new shape first (`total.nodes[window]`, `meshcore.nodes.day`, `meshtastic.nodes.day`) then fall back to the old shape (`active_nodes[window]`, `meshcore.day`, `meshtastic.day`), then to the existing node-list fallback. Detection is **structural** (key presence/shape) — no in-band version field. New instances read both old and new peers; old instances reading a new peer degrade gracefully (the accepted one-way limit). | interview |

---

## Bugfix: API casing consistency

Removes two casing inconsistencies on the HTTP API, shipped within the same
versioned 0.7.0 break. Background: every read collection (`/api/nodes`,
`/api/messages`, `/api/positions`, …) and `/api/stats` already emit snake_case;
the lone camelCase **read response** was `/version`, and `POST /api/nodes` was the
lone camelCase **ingest input** (Meshtastic-shaped). PotatoMesh is multi-protocol
and no longer bound to the Meshtastic JSON convention, so the contract is amended
to standardise on snake_case while preserving compatibility where it is load-bearing.

| # | Decision | Source |
| --- | --- | --- |
| **BF1** | **`/version` response is snake_case.** Top-level `last_node_update` and the `config` block (`site_name`, `map_center` {`lat`,`lon`}, `private_mode`, `instance_domain`, `contact_link`, `contact_link_url`, `max_distance_km`, `refresh_interval_seconds`) replace the prior camelCase keys. A versioned breaking change (0.7.0); consumers are the Flutter app and external clients. | interview |
| **BF2** | **`POST /api/nodes` additionally accepts snake_case** node fields (`last_heard`, `user.short_name`/`long_name`/`hw_model`, `device_metrics.battery_level`, `position.location_source`, …) via a **nil-aware** `pick_alias` (a `false` camelCase value is never overridden by a snake_case alias). **Additive** — the Python ingestor's camelCase output keeps working, so no ingestor change is required. | interview |
| **BF3** | **The signed federation wire is unchanged** (Invariant III). `/.well-known/potato-mesh` and `/api/instances` keep their camelCase keys (`isPrivate`, `lastUpdateTime`, `nodesCount`, …) because those keys are inside the instance **signature** (`federation/signature.rb`); renaming them would break cross-version signature verification bilaterally. **Superseded by FS1–FS6** (next release): the wire is deliberately migrated to snake_case v2 with a `signature_version` marker and v1-backward-accept, so the break is one-way and versioned rather than silent. | code |
| **BF4** | **Out of scope (deferred).** The Flutter app's `/version` reader (`app/lib/main.dart`) and the server→frontend `data-app-config` DOM channel (`frontend_app_config`) keep camelCase for now and are tracked as separate follow-ups; the frontend dashboard is unaffected (it reads `data-app-config`, not `/version`). | interview |
| **BF5** | **`POST /api/instances` accepts snake_case aliases** for its optional fields (`contact_link`, `nodes_count`, `meshcore_nodes_count`, `meshtastic_nodes_count`) in addition to camelCase (third-party / cross-version compat); `id`/`lastUpdateTime`/`isPrivate` were already dual-keyed. The signed canonical payload (camelCase) is unchanged. (I6) **Superseded by FS1** (the signed canonical and announced payload are now snake_case v2; the dual-key acceptance remains as the v1-backward path). | interview |
| **BF6** | **Position time is exposed only as `position_time`** (unix int) on GET responses; the redundant ISO twin (`pos_time_iso` on `/api/nodes`, `position_time_iso` on `/api/positions`) is removed — clients format it themselves. (I2) | interview |
| **BF7** | **All `POST /api/*` ingest routes return `201 Created`** (was `200`), matching `/api/instances`. The Python ingestor accepts any 2xx (`queue.py` urlopen); the matrix bridge is GET-only. (I3) | interview |
| **BF8** | **List POST routes validate the top-level payload.** `/api/messages`, `/positions`, `/telemetry`, `/neighbors`, `/traces` reject a non-Array/non-Hash body with `400 {"error":"invalid payload"}`, matching `/api/nodes` strictness. (I5) | interview |

---

## Bugfix/Migration: Federation signature v2 (snake_case wire, signed counts)

Migrates the federation wire (instance announcement, `GET /api/instances`,
`/.well-known/potato-mesh`) from camelCase to snake_case and closes the
unsigned-field gap, as a **deliberate, versioned break to Invariant III** with
receiver-side backward compatibility. The two signed surfaces keep distinct roles
(well-known = fetched-from-origin identity anchor; announcement = relayable
attribute bundle) but share one snake_case canonicalizer, one `signature_version`
marker, and one fallback chain (option **U0**).

| # | Decision | Source |
| --- | --- | --- |
| **FS1** | **Snake_case federation wire** via one shared canonicalizer: `public_key` (was `publicKey`/`pubkey`), `last_update` (was `lastUpdate`/`lastUpdateTime`), `is_private`, `contact_link`, `nodes_count`, `meshcore_nodes_count`, `meshtastic_nodes_count`, `reticulum_nodes_count`, `signature_algorithm`, `signed_payload`, `signature_version`. Single-token keys (`id`, `domain`, `name`, `version`, `channel`, `frequency`, `latitude`, `longitude`, `signature`) unchanged. DB columns (`pubkey`, `last_update_time`) stay internal, mapped at the wire boundary. | interview |
| **FS2** | **Every announced count is signed** — the announcement canonical includes `nodes_count`, `meshcore_nodes_count`, `meshtastic_nodes_count`, and `reticulum_nodes_count`; **no unsigned attribute remains** in the announcement. `reticulum_nodes_count` shipped as a forward-compat signed constant `0` and, **since the Reticulum ingestor landed, carries the live Reticulum node count**. Because the v2 canonical already included the field, the signature shape is unchanged: pre-Reticulum peers keep signing `reticulum_nodes_count: 0`, those signatures still verify here, and such peers simply relay `0` for a Reticulum-carrying instance until upgraded — a display-only lag, not a verification break. Counts are still **recomputed** from the peer's live `/api/nodes` on receipt — the signature authenticates the sender's snapshot (integrity), the recompute keeps the displayed figure fresh. | interview (amended) |
| **FS3** | **`signature_version` is stamped inside the signed canonical** (not only the envelope), so the format cannot be silently downgraded. Current version = `2`; legacy payloads without it are treated as `v1`. | interview |
| **FS4** | **Send-snake, accept-both (U0).** Instances sign and send **v2 (snake)**. `verify_instance_signature` and the well-known validator try the **v2 snake** canonical, then fall back to the **v1 camel** canonical, each composed with the existing `contact_link`-strip and domain-casing fallbacks. One canonicalizer + fallback chain is shared by both signers (their field sets differ; the mechanism/casing/marker/fallback are shared). | interview |
| **FS5** | **Versioned one-way break** (amends Invariant III, mirrors S7): old peers cannot verify a v2 signature and stop accepting this instance until upgraded (accepted cost); new instances accept old peers' v1 signatures, so a mixed fleet converges. | interview |
| **FS6** | **`last_update`** is the sole wire name for the instance update time across both signed surfaces. | interview |
| **FS7** | **Flutter `/api/instances` reader deferred** (extends BF4). `app/lib/main.dart` `MeshInstance.fromJson` still reads `isPrivate`/`lastUpdateTime` (camelCase) and is intentionally **not** migrated, consistent with the standing decision to defer all Flutter work. Low impact: `GET /api/instances` never serves an `is_private: true` entry (private instances 404 the endpoint via `federation_enabled?`; remote private peers are rejected at registration/crawl), so privacy stays enforced server-side — the stale reads only blank the app's `last_update`/`is_private` display until the client is updated. | review |

---

## Feature: Frontend persistent data cache

Persists the dashboard's read-side data in the browser so a reload or revisit
paints instantly from cache and only **cache misses** (absent or stale rows) hit
the API. Frontend-only (vanilla JS, existing stack); no API/DB/ingestor change.

**Conflict check against existing decisions.** *Apex I (local LoRa)* —
**consistent**: storage is the local browser only, no broker/cloud, no new
dependency. *Invariant IV (parity)* — **extends**: the cache is keyed by the
canonical `!%08x` id uniformly across protocols, privileging neither. *D8
(contract + GET window floors)* — **consistent/extends**: no API change, the
client TTL is bounded by the server's visibility window, and the cache schema is
versioned in D8's spirit. *§3.3 (SQLite is the system of record)* —
**consistent**: the cache is a read-side performance layer that defers to the
server for freshness (hence the 24 h node TTL). *Invariant II (privacy & consent)*
— **contradicts as-is** (persisting messages and node positions to disk is new
on-disk retention) and is therefore **explicitly amended** for this read-side
cache by **FC4**; the apex is untouched.

| # | Decision | Source |
| --- | --- | --- |
| **FC1** | **Persistent, id-keyed client cache.** Every dashboard GET collection — `nodes`, `messages` (incl. `encrypted`), `positions`, `telemetry`, `neighbors`, `traces` — is cached in the browser via **IndexedDB** (chosen over `localStorage` because a busy instance's rows exceed the ~5 MB synchronous-string budget), keyed by the canonical record id; `neighbors` use their existing composite `(node_id, neighbor_id)` key. The cache survives reload and revisit. | interview |
| **FC2** | **Seed-then-delta refresh (reconciles "only misses fetch" with a live view).** On load the UI paints from cache and each collection's `since` high-water mark is seeded from the newest cached row; the existing auto-refresh then fetches only rows newer than the cache and merges by id (the established `since`/`mergeById` model). A **cache miss** = a row/collection absent or past its TTL → fetched. The auto-refresh cadence is unchanged. | interview |
| **FC3** | **Two-tier lifetime — staleness (refetch) ≠ eviction (delete), per collection.** A cached entry becomes **stale** (a fresh fetch is preferred over the cached copy) after its *staleness TTL*; it is **evicted** (deleted) only after its longer *retention window*, and **nothing younger than 7 days is ever evicted** — so an inactive node stays cached and displayed up to 7 days instead of vanishing at its 24 h staleness (we must not lose inactive nodes). Per collection: **nodes** → stale **24 h** (metadata mutates), evict **7 d**; **traces & neighbors** → stale + evict **28 d**; **messages, positions, telemetry** → stale + evict **7 d**. No window exceeds the server's own visibility floor (7-day bulk list; 28-day per-id node & trace windows = `four_weeks_seconds` / `TRACE_MAX_AGE_SECONDS`), so the cache never surfaces rows the API would no longer return (C4). | interview |
| **FC4** | **Privacy safeguards — amends Invariant II.** New client-side persistence is permitted only bounded: (i) when the instance reports **PRIVATE** mode the cache is disabled **and** any existing cache is wiped; (ii) only data the API already returns is stored (opt-out / `CLIENT_HIDDEN` rows are server-excluded; a node opt-out propagates to clients within the 24 h node TTL); (iii) TTL caps per FC3; (iv) a **clear-cache operation** (`clearDataCache`) that empties the store on demand — the action behind a "clear cached data" control; the **visible UI control is a tracked follow-up (deferred)**, the capability ships and is tested now. This explicitly amends Invariant II for the dashboard read-side cache; consent/retention/opt-out remain authoritative and the apex (I) is untouched. | interview (II amendment) |
| **FC5** | **Bounded size.** The FC3 retention windows (evict oldest-first beyond each collection's window) together with the API's own row caps (`NODE_LIMIT`, snapshot limits) bound the store, so it cannot grow without bound. | interview |
| **FC6** | **Versioned cache schema.** The cache carries a schema-version tag; a version bump — or a change of instance identity (e.g. `instance_domain`) — discards the cache, so a data-shape change can never serve mis-shaped entries. Mirrors D8 ("breaking changes are versioned"). | proposed |
| **FC7** | **Read-side only, graceful degradation.** The cache never feeds any POST/ingest path and never alters API responses (§3.3, Apex I). If browser storage is unavailable, quota-exceeded, or throws, the app silently falls back to today's network-only behavior. | proposed |

---

## Feature: Asset cache-busting (versioned static assets)

After a deploy, browsers must run fresh JS/CSS without a manual hard-refresh.
Achieved by stamping `?v=<APP_VERSION>` on every template-written asset URL **and**
injecting one `<script type="importmap">` that remaps every served
`/assets/js/**/*.js` module to its versioned URL — so the *entire* ES-module graph
is invalidated each release, not just the entry points. Presentation/delivery-layer
only; integrates with `web/lib/potato_mesh/application/helpers/` (new `asset_url`
helper + import-map builder) and the asset references in `views/layouts/app.erb`,
`views/charts.erb`, `views/federation.erb`, `views/node_detail.erb`.

| # | Decision | Source |
| --- | --- | --- |
| **AV1** | **Version is the cache key.** Busting is keyed to `PotatoMesh::Application::APP_VERSION`, resolved by `resolve_app_version` in precedence order: (1) a non-blank `ENV["APP_VERSION"]` baked into the build (**AV6**), (2) the `git describe --tags --long --abbrev=7` value, (3) `Config.version_fallback` when git metadata is absent. Every source is normalized to a single **`v` prefix** (e.g. `v0.7.4`), so `/version`, the footer, the federation self-record, and the User-Agent advertise the same shape for every build shape. When the version changes, every asset URL changes and browsers refetch. *Documented limitation (narrowed by AV6):* a build with **neither** a baked `APP_VERSION` **nor** git metadata yields the constant fallback version, so an untagged redeploy won't change the buster — inherent in reusing `APP_VERSION`. **AV6** closes this for the Docker image (the primary deploy mode). | interview |
| **AV2** | **`asset_url(path)` helper.** A helper under `web/lib/potato_mesh/application/helpers/` appends `?v=<APP_VERSION>` to an absolute asset path. It is applied to every template-written JS `<script src>`, CSS `<link href>`, and the inline ES-module `import … from '…'` specifiers in `charts.erb`, `federation.erb`, `node_detail.erb`. | interview |
| **AV3** | **Full module-graph busting via import map.** Because `?v=` on an entry-point URL does **not** propagate to that module's relative `import './x.js'`, the layout `<head>` emits exactly one `<script type="importmap">` (before any module loads) mapping every served production `/assets/js/**/*.js` module (excluding `__tests__`) to its `?v=<APP_VERSION>` URL. This invalidates the whole transitive graph (e.g. `main.js` + its 33 imports), not just the entry points. **Safety property:** a module absent from the map degrades to today's unversioned-but-working load — a missing entry can never break a working import. Browsers without import-map support degrade to today's behavior (entry points still busted via AV2). | interview |
| **AV4** | **Scope = JS + CSS only; native, no new egress.** Only executable/style assets are versioned (all JS + `base.css`). Images, favicons, and SVG icons keep today's `Last-Modified`/`ETag` revalidation (a stale logo is cosmetic, not behavioral). The mechanism uses the native browser import-map feature — **no new dependency, build step, external host, or analytics param** — so apex (I), privacy (II), federation (III), parity (IV), fixed-stack (D7), contract (D8), and no-phone-home (D11) all hold unchanged. The version query is not part of any `/api/*` contract (D8): Sinatra serves the same static file regardless of query string. | interview |
| **AV5** | **Engineering bar (D9).** The helper and import-map builder ship with 100% unit tests + RDoc, Apache headers, `rufo`-clean; all existing suites stay green. View/app specs that assert exact asset markup are **updated** to the versioned form, not removed. | CLAUDE.md |
| **AV6** | **Baked, `v`-prefixed `APP_VERSION` + explicit immutable gate.** The published image ships without `.git` (`.dockerignore` excludes it), so `web/Dockerfile` declares `ARG APP_VERSION` → `ENV APP_VERSION` and `.github/workflows/docker.yml` passes `--build-arg APP_VERSION=$(git describe --tags --long --abbrev=7)` from its full checkout (to the **web** image only). `resolve_app_version` prefers this non-blank ENV, normalized through the same grammar as the git branch **and** forced to a single `v` prefix, so a baked value renders **identically** to a bare-metal checkout at the same commit (`v0.7.4`). Immutability is gated on an explicit **`APP_VERSION_PINNED`** flag — `true` for a baked-ENV or git-derived version, `false` for the constant fallback — **not** a value comparison against `Config.version_fallback` (which would misfire now that the fallback is itself `v`-prefixed). A pinned build's in-image `?v=` buster is unique per build, so `AssetCacheControl` serves versioned JS/CSS `public, max-age=31536000, immutable`; a plain `docker build` with no build-arg stays not-pinned → bounded `max-age=300`. `Config.version_fallback` itself stays bare semver (`0.7.4`) for the polyglot manifest sync (`test_version_sync.py`); only the runtime `APP_VERSION` is `v`-prefixed. Verified by **CA-A3**. | issue #871 |

---

## Feature: Uniform backward pagination (`?before=`) for bulk collection APIs

Generalizes the `/api/messages` backward-pagination cursor (issue #796, **C7**) to
the other five bulk collection GETs so a client can page **backward through** the
visibility window instead of stalling at the newest `MAX_QUERY_LIMIT` (1000) rows.
Motivated by an external consumer (`l5yth/meshint`) that could not retrieve more
than 1000 nodes from `GET /api/nodes`. Read-side only; integrates with the GET
routes in `web/lib/potato_mesh/application/routes/api.rb`, the query helpers in
`web/lib/potato_mesh/application/queries/` (`node_queries.rb`,
`telemetry_queries.rb`, `federation_queries.rb`; `common.rb` already provides the
`coerce_positive_or_nil` cursor coercion), and the GET-window documentation in
`data/mesh_ingestor/CONTRACTS.md`.

**Conflict check against existing decisions.** *D8 (stable contract + GET window
floors)* — **extends**: `before` is a new optional, additive parameter (absent ⇒
today's behavior) and only ever *narrows*, so it needs no version bump and no
federation-compat fallback (unlike the 0.7.0 `/api/stats` break, **S1**). *C4
(floors cannot be widened)* / *C7 (messages `before`)* — **extends**: the proven
#796 keyset cursor is applied uniformly; the `MAX(since, floor)` clamp and
`MAX_QUERY_LIMIT` cap are untouched. *Invariant I (apex)* — **consistent**:
read-side query param, no broker/dependency/egress. *Invariant II (privacy)* —
**consistent**: opt-out / `CLIENT_HIDDEN` / private-mode gates are unchanged and a
narrowing upper bound can never surface a hidden row; no new on-disk retention.
*Invariant IV (parity)* — **extends**: the cursor is protocol-neutral and composes
with the existing `?protocol=` filter. No invariant is contradicted, so this
feature adds new decisions without amending any prior one.

| # | Decision | Source |
| --- | --- | --- |
| **BP1** | **Uniform `?before=` on the six bulk collections.** `GET /api/{nodes, positions, telemetry, neighbors, traces, ingestors}` accept an optional `?before=<unix_seconds>` upper-bound cursor, mirroring the existing `GET /api/messages` behavior (**C7**). `before` is an **inclusive** (`<=`) ceiling on each route's **primary sort column** — the column it already `ORDER BY … DESC`: `rx_time` for `positions`/`telemetry`/`neighbors`/`traces`, `last_heard` for `nodes`, `last_seen_time` for `ingestors`. The per-id routes (`/api/.../:id`) and `/api/instances` are **out of scope**. | interview |
| **BP2** | **Narrows only — never widens (preserves C4/D8).** `before` composes with the existing server-side window floor as an *additional upper bound*: the effective window is `MAX(since, floor) ≤ t ≤ before`. Because `before` only removes *newer* rows, no value can reach past the 7-day / 28-day floor (a `before` older than the floor simply yields fewer/zero rows; a `before` in the future is a no-op). It therefore needs **no clamp** of its own (unlike `since`, which is clamped *up* to the floor). A non-positive or non-integer `before` is ignored as absent via the existing `coerce_positive_or_nil`, identical to messages. `MAX_QUERY_LIMIT` per request is unchanged — `before` pages *through* the window, not *beyond* it. | interview + code |
| **BP3** | **Keyset mechanics identical to messages (#796).** The caller walks newest → oldest: each page is `ORDER BY <sort_col> DESC LIMIT n`, then the **oldest `<sort_col>` value of the page** becomes the next `before`, de-duplicating by the collection's id client-side. The inclusive boundary deliberately overlaps consecutive pages by any rows sharing the boundary second so none is skipped; client dedup collapses the overlap. This is the established **C7 / PL-A2** walk applied uniformly. | interview + code |
| **BP4** | **Additive & backward-compatible — no version bump.** `before` is a new optional query parameter; when absent every route behaves exactly as today, and existing consumers (including the federation crawl) are unaffected. Unlike **S1**, this is *not* a breaking change: no manifest version bump and no old/new shape fallback are required. **Extends** D8's backward-compatibility rule rather than amending it. | interview |
| **BP5** | **Protocol-neutral (Invariant IV).** The cursor is identical for all rows regardless of protocol and composes with the existing `?protocol=` filter; neither Meshtastic nor MeshCore is privileged. | interview |
| **BP6** | **Apex & privacy untouched (Invariants I/II).** Read-side only — no broker, dependency, or egress (I). The existing opt-out, `CLIENT_HIDDEN`, and private-mode behaviors are unchanged, and because `before` only narrows it can never expose a row a route would otherwise hide (II). No new on-disk retention is introduced. | interview + code |
| **BP7** | **Cache-bypass parity with messages.** A request carrying `before` (like one carrying `since > 0`) **bypasses** the shared `ApiCache` response cache, which only memoises the default newest-page feed; the cache key for the cached (no-`before`, no-`since`) path is unchanged, so history pages never pollute or evict the hot newest-page entry. | code |
| **BP8** | **Engineering bar (D9).** Ships with 100% unit tests across the route and query layers (mirroring the existing messages-`before` specs), RDoc on every edited method, Apache headers intact, `rufo`-clean; all existing Ruby/JS/Python suites stay green. | CLAUDE.md |
| **BP9** | **Out of scope (deferred, tracked).** This feature ships the **server capability only**. (a) Wiring the browser data cache / JS data-fetchers to *backfill* collections via `before` (beyond the existing messages pager) is a tracked follow-up — the capability is unblocked, not wired. (b) The lone camelCase query params `windowSeconds` / `bucketSeconds` on `GET /api/telemetry/aggregated` and (c) the missing `limit` / `since` / `protocol` params on `GET /api/instances` are recorded here as known API-handling inconsistencies and tracked as **separate follow-ups**, deliberately excluded to keep this feature compartmentalized. | interview |
---

## Feature: Live updates (SSE change pub/sub)

Replaces the dashboard's fixed 60-second refresh poll with immediate,
change-driven updates. An **in-process, in-memory** publish/subscribe registry
inside the Sinatra app emits a thin "this collection changed" event whenever an
ingest `POST` writes; browsers subscribe over **Server-Sent Events** (`GET
/api/events`, native `EventSource`) and react by running their existing
delta-fetch against the legacy `/api` endpoints. No row data crosses the push,
no new dependency, and **no broker or cloud bus** — the pub/sub is a local,
single-process fan-out. Integrates with the six `POST /api/*` ingest routes and
their existing `ApiCache.invalidate_prefix` calls
(`web/lib/potato_mesh/application/routes/ingest.rb`), a new
`application/pubsub.rb` registry + `GET /api/events` route, `application.rb`
(lifecycle wiring), `config.rb` / `helpers/config_helpers.rb` (`private_mode?`,
toggle, intervals, `data-app-config`), and on the frontend `main.js` (the
`setInterval(refresh, REFRESH_MS)` loop), `main/data-fetchers.js`, `settings.js`,
a new `main/` SSE-client module, `main/data-cache.js` (seed-then-delta), and
`main/data-merge.js` (merge-by-id). The event shape is documented in
`data/mesh_ingestor/CONTRACTS.md`.

**Conflict check against existing decisions.** *Apex I (local LoRa / no
MQTT/broker)* — **consistent**: the pub/sub is in-memory and in-process, carries
no broker dependency, and SSE is plain HTTP on the existing app (`guard-edits.py`
would block a broker manifest entry regardless). *Invariant II (privacy)* —
**consistent (+ safeguard)**: events are thin (no rows) and the client re-fetches
through the already-filtered `/api`, so opt-out / `CLIENT_HIDDEN` never traverse
the push; `messages` events are additionally suppressed under `PRIVATE`, mirroring
A2a. *Invariant III (federation)* — **consistent**: local browser↔server only, no
peer push. *Invariant IV (parity)* — **consistent/extends**: events name the
*collection*, never the protocol; both protocols fetch identically. *§3.3
(POST-only intake)* — **extends**: `GET /api/events` is outbound, read-only, never
an ingest path; SQLite stays the system of record. *D7 (fixed stack)* —
**consistent**: SSE needs no gem (Sinatra streaming + native `EventSource`); the
in-memory fan-out is per-process (current single-process `ruby app.rb` deploy), a
documented limitation covered by the PS5 safety poll. *D8 (stable contract)* —
**extends**: additive endpoint, no existing `/api/*` shape change. *FC2 / FC-A2 /
FC-R1 (cache "auto-refresh cadence unchanged")* — **amended, not silently
overridden** by **PS7**: the seed-then-delta mechanism is untouched; only the
*trigger* changes from a 60 s timer to event-driven + safety poll. The apex (I) is
untouched.

| # | Decision | Source |
| --- | --- | --- |
| **PS1** | **In-process, broker-free pub/sub (apex-safe).** Change notifications are delivered by an **in-memory, in-process** publish/subscribe registry inside the Sinatra app — no MQTT, no external broker, no new dependency or cloud bus (Invariant I). Delivered to browsers over **SSE** (`text/event-stream`) via the browser-native `EventSource`, served by Sinatra streaming under the existing single-process Puma. *Documented limitation:* in-memory fan-out is per-process; a clustered multi-worker deployment would not fan out across workers — out of scope, covered by the PS5 safety poll. | interview + apex |
| **PS2** | **New read-side GET stream; never an ingest path.** A single new endpoint **`GET /api/events`** (SSE) is the subscribe surface. It is outbound/read-only: it accepts no body, writes nothing, and is **not** an ingest route; SQLite remains the system of record (§3.3). Additive to the API contract (D8): no existing `/api/*` shape changes. | interview + §3.3/D8 |
| **PS3** | **Thin per-collection 'go-fetch' events.** Each event names only the collection that changed — one of `nodes`, `messages`, `positions`, `telemetry`, `neighbors`, `traces` — optionally with the newest `rx_time`/`last_heard` as a skip-hint. **No row data** is carried. The client reacts by running its **existing** delta fetch (`since=<cached high-water>`) against the legacy `/api` endpoints and merging by id through the FC2 cache — reusing every current privacy gate, window floor (C4), and merge path; privileges no protocol (Invariant IV). | interview |
| **PS4** | **Publish-on-change at the existing write points, coalesced.** The six `POST /api/*` ingest routes publish their collection's change event after a successful write, co-located with the existing `ApiCache.invalidate_prefix` calls in `routes/ingest.rb`. Rapid bursts are **coalesced/throttled per collection** (a short debounce window) so a flood of message POSTs yields a bounded ping rate, not one event per row. | interview + code |
| **PS5** | **Push replaces the 60 s poll; reconnect-resync + slow safety poll.** The frontend's fixed 60 s refresh timer is **removed as the primary driver**. SSE pings trigger the matching delta fetch immediately. On every SSE (re)connect the client runs a full delta **resync** to recover anything missed during a gap. A **slow background safety poll** (default 5 min, configurable) remains as a fallback for environments where SSE is blocked, buffered, or silently dead, and for any non-fan-out deployment (PS1). | interview |
| **PS6** | **Privacy: no `messages` events when PRIVATE (Invariant II).** Under `PRIVATE=1` the server emits **no `messages` change events** and the `GET /api/events` stream carries none, mirroring the `/api/messages` 404 (A2a). Because events are thin (no row data) and the client re-fetches through the already-filtered `/api` endpoints, opt-out / `CLIENT_HIDDEN` rows never traverse the push. Defense-in-depth; Invariant II is preserved. | interview + Invariant II |
| **PS7** | **Amends FC2/FC-A2/FC-R1 cadence wording (named, not silent).** The seed-then-delta cache *mechanism* is unchanged (still `since=<high-water>`, only-misses-fetch, merge-by-id). Only the **trigger** changes: from a fixed 60 s cadence to event-driven (SSE ping / reconnect resync / slow safety poll). FC-A2 and FC-R1's "auto-refresh cadence is unchanged" clause is **explicitly amended** to "the fetch trigger is event-driven with a slow safety-poll fallback; the delta/merge/cache contract is unchanged." | interview (FC2 amendment) |
| **PS8** | **Graceful degradation & engineering bar (D9).** If `EventSource` is unavailable, the stream errors, or a config flag disables it, the client silently falls back to the safety poll (today's network-only behavior) — the push is **never load-bearing**. All new code (the pub/sub registry, the `GET /api/events` route, the frontend SSE client) ships with 100% unit tests, full API docs (RDoc/JSDoc), the exact Apache header, and `rufo`-clean formatting; all existing suites stay green. | D9 + proposed |
| **PS9** | **Request-thread budget reserves capacity for non-SSE traffic (realizes PS8 server-side).** Each open `GET /api/events` stream pins **one Puma request thread** for its lifetime (the `pump` runs synchronously on it). So the Puma pool **must** stay larger than the SSE subscriber cap by a reserve: `puma_max_threads ≥ MAX_SUBSCRIBERS + sse_thread_reserve`, so that **at least `sse_thread_reserve` threads** (32 by default) always remain for API reads, ingest `POST`s, and the federation self-fetch even when every SSE slot is occupied. Enforced two ways: (a) the pool is sized **in code** via `server_settings[:Threads]` (default `16:96`, env `MIN_THREADS`/`MAX_THREADS`) — never left to Puma's MRI default of 5; and (b) `PubSub.subscribe`'s effective cap is **clamped** to `min(MAX_SUBSCRIBERS, puma_max_threads − sse_thread_reserve)` (env `SSE_THREAD_RESERVE`, default 32; defaults reconcile to the original 64), so a subscription flood gets `503` → safety poll (PS8) instead of starving the server. Without this a handful of dashboard clients took the whole instance down (502 everywhere). | bugfix (production incident) |

---

## Feature: Live-update visual feedback (flash + control cleanup)

Builds on the SSE pub/sub feature (PS1–PS8) to make live updates *visible*: when a
change arrives over SSE the affected element briefly flashes white, so a watching
operator sees **where** an update landed without scanning. The poll-era controls
(the "Refresh" button and the "last updated" timestamp) are removed, since push
makes them redundant; the play/pause toggle stays. Frontend-only (vanilla JS +
`base.css`) except one additive server change: `POST /api/messages` also publishes
a `nodes` change event (because a message ingest already touches the author node's
`last_heard`, #822). Integrates with `views/layouts/app.erb` (control removal),
`web/public/assets/js/app/main.js` (`refresh`/`runLiveRefresh` wiring, node-table +
map-marker + chat render paths), `chat-tabs.js` (tab header), `node-rendering.js`
(`data-node-id` rows), a new flash helper under `web/public/assets/js/app/main/`
(+ `__tests__`), `web/public/assets/styles/base.css` (the highlight keyframe), and
`web/lib/potato_mesh/application/routes/ingest.rb` (the `nodes`-on-message publish).

**Conflict check against existing decisions.** *PS5 (push replaced poll)* —
**realizes**: removing the Refresh button + "last updated" field is PS5's UI
consequence. *PS4 (publish-on-change)* — **extends**: the messages route now also
publishes `nodes` (the table it already writes via #822). *PS6 / Invariant II
(privacy)* — **consistent**: in `PRIVATE` the message route 404s before publish, so
no `messages`/`nodes` event fires from a message; node events are not privacy-gated.
*CR-A1/CR-A2/CR-A3 (incremental render)* — **consistent (guarded)**: the flash
touches only already-rendered/cached DOM after render, never re-materializing, so an
idle tick still materializes 0 entries. *FC-A2 / PS-A7 (seed-then-delta)* —
**consistent**: flashing is gated to SSE-ping deltas, so cold/warm seed, resync, and
the safety poll never flash (no strobe). *Apex I / §3.3 / Invariant IV / A4c / D1* —
**consistent**: read-side visual + one in-process publish call; protocol-neutral; no
ingest path, no `/version` change. No invariant is contradicted.

| # | Decision | Source |
| --- | --- | --- |
| **VF1** | **Remove poll-era controls.** The `#refreshBtn` button and the `#status` "last updated" field are removed from the dashboard (along with their `main.js` handlers, the `refreshing…`/`updated <time>` status writes, and the `.refresh-timestamp` style). The `#autorefreshToggle` play/pause control is **kept** — it still pauses both the live stream and the safety poll (PS5). Manual refresh and a timestamp are redundant once push delivers updates. | interview |
| **VF2** | **Flash only on SSE-ping deltas.** The white highlight fires **only** for rows delivered by an SSE-ping-driven targeted refresh (`runLiveRefresh`). The initial load (cold **or** warm-cache catch-up), the reconnect resync, and the slow safety poll do **not** flash — so the screen never strobes on load and a flash unambiguously means "this changed live while you were watching." Accepted limit: a change recovered *only* by resync or the safety poll updates without a flash. | interview |
| **VF3** | **What flashes, per collection.** A `nodes` / `positions` / `telemetry` ping flashes the affected node's **map marker and node-table row** (the changed node ids are read from the ping's delta rows by `node_id`). A `messages` ping flashes the **message row** (the whole row) and the **channel tab header**; because the message ingest also touches the author node (#822), `POST /api/messages` **additionally publishes `nodes`** (extends PS4), so the author node's marker + table row flash too, with a freshly-updated "last seen". Detection is by id/collection, identical for both protocols (Invariant IV). **Scope:** `neighbors` / `traces` updates do **not** flash (they update silently) — a deliberate, documented boundary, deferrable to a follow-up. | interview |
| **VF4** | **Render before flash.** The highlight is applied **after** the affected DOM is rendered and positioned in the same update tick — the node-table row + map marker, and the chat message row + channel tab, are materialized/placed first, then flashed (a post-render `requestAnimationFrame`/microtask step). This guarantees the flash lands on the final, placed element and is never applied to a not-yet-rendered element or an element still at its old position/offscreen. | interview |
| **VF5** | **Brief, accessible highlight.** The flash is **white**, lasts **<100 ms**, and is a one-shot CSS highlight with **no layout shift** (e.g. background/overlay only). It **respects `prefers-reduced-motion`**: when the user has reduce-motion enabled the highlight is suppressed via an `@media (prefers-reduced-motion: reduce)` guard — the data still updates live, only the animation is withheld. **Amended by LV1/LV2/LV5** (Feature: Live-update feedback v2): the <100 ms one-shot white flash is replaced by a ~1.2 s role-colour fade with per-element stacked timers, plus a map-marker wave; the white onset and reduced-motion suppression are retained. | interview |
| **VF6** | **Preserve render & cache invariants (read-side only).** The flash is applied to **already-rendered/cached** DOM nodes (the chat entry cache, existing table rows, existing markers); it **never** re-materializes chat entries or issues per-node fetches, so an idle tick still materializes **0** entries (CR-A1) and the seed-then-delta cache (FC-A2) is untouched. The only non-frontend change is the additive `nodes` publish on message ingest, which is moot under `PRIVATE` (the message route 404s first), preserving Invariant II / PS6. | proposed |
| **VF7** | **Engineering bar (D9).** The flash-trigger logic (changed-id selection, after-render ordering, SSE-ping-only gating, message⇒node fan-out) ships with 100% unit tests, JSDoc, and the exact Apache header; the `ingest.rb` `nodes`-on-message publish is covered by a Ruby spec; existing view/app specs that assert the removed controls are **updated** to assert their absence (not deleted). CSS keyframes have no gating command, so the criterion is the trigger logic + a view assertion; all existing suites stay green. | D9 + proposed |

---

## Feature: Live-update feedback v2 (fade, stacking, map wave, dedup, full log)

Reworks the live-update visual feedback shipped as VF1-VF7. The <100 ms white
strobe read as a glitch; this replaces it with a slower, legible fade and closes
the remaining live-update UX gaps. **Deliberately amends VF2/VF3/VF5** (the
flash's duration/colour/scope) while keeping their invariants (SSE-ping gating,
render-before-flash, reduced-motion). Frontend-only except one server change: a
per-collection publish cooldown in `application/pubsub.rb`.

**Conflict check.** *Apex I / privacy II / parity IV* - consistent: read-side
visuals + one in-process cooldown (no broker, no row data on the push); messages
still 404 under `PRIVATE` so message fades/log are moot there; role colours come
from `getRoleColor` for both protocols. *VF2 (SSE-ping gating)* / *VF4
(render-before-flash)* / *CR-A1 (idle materialises 0)* - retained. *PS4
(coalesced/throttled)* - realised: LV6 adds the actual time-window the structural
coalescing lacked.

| # | Decision | Source |
| --- | --- | --- |
| **LV1** | **Fade replaces strobe (amends VF5).** The highlight is a **~1.2 s** animation: the element flashes white, then fades through its **role colour** with increasing transparency back to its normal appearance. Applies to node-table rows and chat message rows. The white *onset*, no-layout-shift, and `prefers-reduced-motion` suppression of VF5 are retained; only the duration (<100 ms -> ~1.2 s) and the white->role-colour fade are new. | interview |
| **LV2** | **Per-element stacked timers.** Each highlighted element runs its **own** ~1.2 s clock; many elements updating within the window each fade independently, and re-updating the same element **restarts** its clock cleanly (the prior removal timer is cancelled, so a re-flash never truncates early). No shared/global flash clock. | interview |
| **LV3** | **Role-colour stamped at render.** The fade's role colour is `getRoleColor(role, protocol)`, written as a CSS custom property (`--flash-role-color`) onto the element at render time, so the keyframe needs no per-element JS and the flash helper only toggles a class. Protocol-neutral (Meshtastic + MeshCore palettes via `getRoleColor`), preserving Invariant IV. | interview + code |
| **LV4** | **Message fades its row + only its own channel tab (fixes VF3 in practice).** A `messages` ping fades the message row wherever rendered and highlights **only the message's own channel-tab header**, never merely the active tab; the message->tab map drives it. The author-node row + marker also fade via the existing message->nodes publish (#822). | interview |
| **LV5** | **Map-marker wave.** On a node highlight the marker emits an expanding **wave** ring (start ~12 px radius, grow to a bounded radius, fade transparency toward the role colour over ~1.2 s) in addition to the marker's own white->role fade. The wave is a transient, non-interactive overlay removed after the animation (no layout shift). `neighbors`/`traces` still emit nothing (VF3 boundary kept). | interview |
| **LV6** | **Publish settle window (server-side dedup).** The in-process pub/sub holds a brief **settle window** (default **1 s**, env-tunable) when a change lands, coalescing a burst so N ingestors relaying one packet yield one client refresh/flash, not N; each changed collection still emits at most once per window (structural pending-map coalescing). Server-side, in-process (apex-safe, no broker); realises PS4's "short debounce" with an actual time window. | interview |
| **LV7** | **Log tab logs every live-event class — node-centrically, never message bodies.** The chat **Log** tab carries one entry per live event across all collections (nodes/messages/positions/telemetry/neighbors/traces), but a **message body never appears in the Log** — bodies live only in their channel tab. **Amends the earlier LV7** ("plaintext chat messages now appear in the Log"), which was an oversight. Each event maps to: a **new node** → "☀️ New node: <name>"; an **advert / node-info update** → "💾 Updated node info (advert)"; a **decrypted message** → "💾 Updated node info (message)" for its sender (no text); a **position** → "📍 Broadcasted position info: <values>" (colon, matching the neighbour entry); a **neighbour** → "🏘️ Broadcasted neighbor info: <peer>"; **telemetry** → "🔋 Broadcasted telemetry — <values>"; a **trace** → "👣 Caught trace: <path>"; an **encrypted message** → "🔒 encrypted message on channel <id>". The generic "Updated node info (<reason>)" fires **only when no more-specific entry already represents that heard** (a position/telemetry/neighbour/trace/message claims the node's `last_heard`, suppressing a redundant advert line). Presentation-only, protocol-neutral; honours the hidden-protocol and PRIVATE gates already applied to the chat. | interview (LV7 amendment) |
| **LV8** | **Channel-tab dropdown selector.** A compact selector control (a downward triangle) lists all channel tabs and jumps to a chosen one, independent of the (now-preserved, LD-A2) horizontal scroll. Presentation-only; does not change tab order, the default-active tab, or any data surface. | interview |
| **LV9** | **Engineering bar / invariants (D9).** All new code ships with 100% unit tests, JSDoc/RDoc, the exact Apache header, and clean linters; existing suites stay green. Apex (I), privacy (II - messages still 404 under PRIVATE; the LV6 cooldown is in-process), and parity (IV) are untouched. `prefers-reduced-motion` suppresses **all** new motion (fade + wave). | D9 + proposed |

---

## Feature: Reliable dark basemap (CARTO Dark Matter) + tolerant tile loading

Swaps the map basemap from the `openstreetmap.fr/hot` community tile server to
**CARTO Dark Matter**. The HOT server was found unreliable: its origin/render
backend times out on any cache-miss tile (deep-zoom / less-popular) while only
low-zoom cached tiles still serve, and the dashboard's first `tileerror` then
escalated that into a full-map offline placeholder. CARTO Dark Matter is a
keyless, CORS-enabled (`access-control-allow-origin: *`), natively dark-grey
basemap CDN. Because Dark Matter is already dark-grey, the per-theme CSS
`grayscale/invert` tile-filter pipeline — the last remnant of the removed light
theme — is deleted end-to-end, and the dashboard stops killing the basemap on
isolated tile errors. Frontend + view/config only (vanilla JS, `base.css`, Ruby
config); no new dependency, no API/DB/ingestor change, and tiles are fetched
browser→CDN exactly as today (no server proxy).

**Conflict check.** *Apex I (local LoRa / no broker)* — **consistent**: a raster
CDN is not an MQTT/cloud message bus; no manifest/dependency change
(`guard-edits.py` untriggered); tiles are browser→CDN as before. *Invariant II
(privacy) / D11 (no phone-home)* — **consistent**: CARTO's public CDN is keyless
and cookieless, so it does not worsen the third-party tile egress
`openstreetmap.fr` already carried, and adds no per-operator credential.
*Invariant IV (parity)* — **consistent**: the basemap is protocol-neutral.
*D7 (fixed stack)* — **consistent**: native Leaflet URL + config/CSS deletions,
no new package or build step. *D8 (stable contract)* — **consistent**:
`tileFilters` lives only in the `data-app-config` DOM channel
(`frontend_app_config`), never in `/version` or any `/api/*` shape, so its removal
is frontend-internal — no contract change, no version bump. No invariant is
contradicted; the change is a net simplification.

| # | Decision | Source |
| --- | --- | --- |
| **DM1** | **Provider swap to CARTO Dark Matter.** The single, de-duplicated tile-URL constant becomes `https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png` (subdomains `abcd`, `detectRetina` for the `{r}` HiDPI suffix), replacing `https://{s}.tile.openstreetmap.fr/hot/…` on **both** the dashboard map (`main.js`) and the federation map (`federation-page.js`). Keyless public CDN; returns `access-control-allow-origin: *` so the existing `crossOrigin:'anonymous'` is satisfied; natively dark-grey, so "keep the dark/grey style" holds with no filter. **Superseded by HT1** — HOT is restored as the primary basemap (dark-filtered) and CARTO Dark Matter is retained only as a per-tile fallback, not the sole provider. | interview + probe |
| **DM2** | **Native dark style; the CSS tile-filter pipeline is removed.** Dark Matter is already styled, so the per-theme `grayscale/invert` filter (which existed only to grey out the colourful HOT tiles and is the last **light-theme** remnant) is deleted end-to-end: Ruby `DEFAULT_TILE_FILTER_LIGHT`/`DEFAULT_TILE_FILTER_DARK`, `map_tile_filter_light`/`map_tile_filter_dark`, `tile_filters`, and the `tileFilters` key in `frontend_app_config` (`config_helpers.rb`); JS `TILE_FILTER_LIGHT`/`TILE_FILTER_DARK`, `resolveTileFilter` + the tile filter-application/MutationObserver machinery in `main.js`, `applyTileFilter`/`resolveTheme`/`themechange` in `federation-page.js`, `tileFilters` in `settings.js`, and the `window.applyFiltersToAllTiles` hook in `theme.js`; CSS `--map-tile-filter-light`, `--map-tiles-filter`, and the `.map-tiles { filter: … }` rules in `base.css`. The broader theme system is already dark-only (`resolve_initial_theme` returns `"dark"`). **Partially superseded by HT2** — a dark tile filter is reintroduced as a frontend-only static CSS constant applied to HOT tiles (CARTO fallback tiles stay unfiltered); the Ruby `tile_filters` / `data-app-config` `tileFilters` plumbing removed here stays removed. | interview |
| **DM3** | **Tolerate isolated tile errors (dashboard).** The first `tileerror` no longer flips the whole map to the offline placeholder. Isolated tile failures remain individual blank tiles (Leaflet default); `activateOfflineTiles` fires **only** when the basemap is comprehensively unavailable — **zero** successful tile loads across the initial viewport (provider unreachable/blocked). After **any** successful `tileload` the basemap is latched "alive" and subsequent isolated `tileerror`s never trigger the offline switch; recovery is automatic on later loads. The offline `GridLayer` (`main/offline-tile-layer.js`) is retained as the last-resort fallback. The federation map has no kill-basemap logic today, so it receives only DM1+DM2. | interview |
| **DM4** | **Adjacent light remnants removed.** `<meta name="color-scheme" content="dark light">` → `content="dark"` (`views/layouts/app.erb`); `background.js`'s `body.classList.contains('dark') ? '#0e1418' : '#f6f3ee'` ternary collapses to the dark colour `'#0e1418'`. (The broader dead light **CSS palette** is handled separately by DM7.) | interview |
| **DM5** | **No attribution overlay (keep the clean look).** The map keeps `attributionControl:false` as today; no `© OpenStreetMap / © CARTO` credit is rendered. Accepted trade-off: this under-attributes CARTO/OSM — the same posture already taken with the HOT tiles — and is chosen to preserve the existing clean map style. | interview |
| **DM6** | **Engineering bar & invariants (D9).** No server-side broker/dependency/egress; no `/api/*` or `/version` contract change; protocol-neutral. Every changed JS/Ruby unit ships with 100% unit tests (existing tile-filter specs are **updated or removed-as-dead**, never left dangling), JSDoc/RDoc, the exact Apache header, and `rufo`/`black`-clean formatting; all existing suites stay green. | D9 + proposed |
| **DM7** | **Dead light CSS palette collapsed (dark-only).** `base.css` carried a full light token palette in `:root`, always overridden by an always-applied `body.dark { … }` token block, plus `html { color-scheme: light }`. Since `body` is always `dark` (`resolve_initial_theme` is fixed `"dark"`), the light half never rendered. The dual palette is collapsed to a **single dark `:root`** (the former `body.dark` token values promoted up, so `html` itself resolves dark tokens too), the `body.dark` *token* block and the light/`data-theme` `color-scheme` rules are removed, and `html { color-scheme: dark }`. `body.dark` *component* rules are untouched (still apply, `body` always has the class), so the rendered dark appearance is unchanged — verified by screenshot. | interview (scope expansion, approved) |

---

## Feature: HOT primary basemap (dark-filtered) with per-tile CARTO fallback

Reinstates the OpenStreetMap France **HOT** (Humanitarian OSM Team) tile server as
the **primary** basemap on both maps, dark-styled by the reintroduced
`grayscale/invert` CSS filter, and demotes **CARTO Dark Matter** (the DM1 provider)
to a **per-tile fallback**: any HOT tile that errors or fails to load within
**1000 ms** is individually replaced by the CARTO tile at the same coordinate.
CARTO Dark Matter proved reliable but too dark for the default look; HOT
(dark-filtered) is the desired style, with CARTO as the dependable safety net and
the offline placeholder (DM3) behind both. **Deliberately amends DM1 and DM2** (the
sole-provider swap and the end-to-end filter deletion) while keeping their
invariant posture (no attribution, dark-only theme, no broker, no contract change).
Frontend-only (vanilla JS, `base.css`); no API/DB/ingestor change and no Ruby
`tile_filters` / `data-app-config` return.

**Conflict check.** *DM1 (CARTO sole basemap)* — **contradicts → amended** (HT1:
HOT primary, CARTO fallback). *DM2 (filter pipeline deleted)* — **contradicts →
amended** (HT2: dark filter reintroduced as a frontend-only static constant,
HOT-only). *DM3 (offline placeholder)* — **extends** (offline is now the last tier,
reached only when both HOT and CARTO fail). *DM4 / DM7 (dark-only)* —
**consistent** (stays dark-only; the light filter is dropped as dead code).
*DM5 (no attribution)* — **reaffirmed**. *Apex I* — **consistent**: HOT and CARTO
are raster tile CDNs, not MQTT/cloud brokers; no manifest/dependency change
(`guard-edits.py` untriggered); tiles are browser→CDN as before. *Invariant II /
D11 (no phone-home)* — **consistent**: both providers are keyless and cookieless,
and CARTO is fetched only for a HOT tile that failed, so common-case egress is
HOT-only — no new per-operator credential and no telemetry. *Invariant IV
(parity)* — **consistent**: the basemap is protocol-neutral, identical for
Meshtastic and MeshCore. *D7 (fixed stack)* — **consistent**: native Leaflet
URL/layer config, no new package or build step. *D8 (stable contract)* —
**consistent**: the filter is a frontend constant; nothing enters `/version` or any
`/api/*` shape, so no version bump. No invariant is contradicted.

| # | Decision | Source |
| --- | --- | --- |
| **HT1** | **HOT primary; CARTO retained as fallback (amends DM1).** The shared basemap's **primary** layer is OpenStreetMap France HOT — `https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png` (`subdomains:'abc'`, `maxZoom:19`, `crossOrigin:'anonymous'`, `className:'map-tiles'`) — restored on **both** the dashboard (`main.js`) and federation (`federation-page.js`) maps. CARTO Dark Matter (`https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png`, `subdomains:'abcd'`, `detectRetina:true`, `crossOrigin:'anonymous'`) is **kept** but only as the per-tile fallback source (HT3), never the primary. HOT already ran with `crossOrigin:'anonymous'` before #831 (it serves permissive CORS), so the headless OG-image capture stays untainted. **Amends DM1** (CARTO-as-sole-provider). | interview |
| **HT2** | **Dark filter for HOT only; frontend constant, dark-only (amends DM2).** The `grayscale(1) invert(1) brightness(0.9) contrast(1.08)` filter is reintroduced **only** as a static CSS rule on the per-tile class `.map-tiles-hot`, styling the natively-colourful HOT tiles dark. (Leaflet stamps a layer's `className` on the tile *container*, not each `<img>`, so per-tile HOT/CARTO filtering needs a per-tile class; the container keeps its unchanged `map-tiles` tag for the tile-pane opacity.) **CARTO fallback tiles are exempt** — a swapped tile drops `.map-tiles-hot` for `.map-tiles-fallback` (`filter:none`), because CARTO is already dark and `invert(1)` would render it light; offline placeholder tiles carry neither class and stay unfiltered too. **No light-theme filter** is added (the app is dark-only per DM7 — a light variant would be dead code). The removed per-theme machinery is **not** restored: no Ruby `tile_filters`/`DEFAULT_TILE_FILTER_*`, no `frontend_app_config`/`data-app-config` `tileFilters`, no JS `resolveTileFilter`/`applyFiltersToAllTiles`/MutationObserver, no `--map-tile*-filter` custom property. The filter lives entirely in one static `base.css` rule (D8 contract untouched). **Amends DM2** (which deleted the filter end-to-end). | interview |
| **HT3** | **Per-tile 1000 ms timeout → CARTO (the core mechanism).** A custom Leaflet `TileLayer` (built by the shared factory) overrides tile creation: for each tile it sets the HOT `src` and starts a **1000 ms** timer (a single named constant, the source of truth). If the HOT image fires `error` **or** the timer elapses before `load`, the tile's `src` is swapped to the CARTO URL for the same `{z}/{x}/{y}` and the `map-tiles-fallback` marker is applied (HT2). A successful HOT `load` clears the timer and keeps the filtered HOT tile. The timeout value and the swap-decision/URL logic are pure and Leaflet-free for standalone unit testing (mirroring `main/tile-failure-policy.js`); the thin `createTile` wiring is covered via the leaflet-stub harness. | interview |
| **HT4** | **Fallback ladder; offline placeholder is the last tier (extends DM3).** Leaflet's `tileload` reaches the DM3 `tile-failure-policy` when **either** HOT or the CARTO fallback serves a tile (the basemap is "alive" if either provider works); `tileerror` is signalled **only** when the CARTO fallback tile *also* fails. Thus an isolated HOT failure that CARTO covers never trips the offline switch, and `activateOfflineTiles` (`main/offline-tile-layer.js`) fires only when tiles fail comprehensively on **both** providers — preserving DM3/DM-A3 tolerance one tier lower. The offline `GridLayer` tier stays **dashboard-only**, exactly as DM3 scoped it. | interview |
| **HT5** | **Both maps share one basemap factory (parity, no duplication).** A single `createBasemapLayer(L)` in the shared basemap module (`basemap-config.js`) builds the HOT-primary / per-tile-CARTO-fallback layer and is called by **both** `main.js` and `federation-page.js` — preserving DM-A1's "one shared basemap definition referenced by both maps." Both maps render HOT (dark-filtered) with the identical CARTO fallback. The federation map keeps **no** kill-basemap/offline logic (unchanged from DM3): a tile that fails on both providers simply stays blank there. Protocol-neutral (Invariant IV). | interview |
| **HT6** | **No attribution (reaffirms DM5).** Both maps keep `attributionControl:false`; no `© OpenStreetMap / © CARTO` credit is rendered. Accepted under-attribution trade-off — now spanning both providers — chosen to preserve the clean map style, unchanged from DM5. | interview |
| **HT7** | **Apex / privacy / stack / contract all untouched.** HOT and CARTO are raster tile CDNs, not MQTT/cloud brokers — the apex (I) holds and `guard-edits.py` is untriggered (no manifest/dependency change). Both are keyless and cookieless, and CARTO is requested only for a HOT tile that failed, so the common case egresses to HOT alone — no new phone-home or per-operator credential (II / D11). Native Leaflet only, no new package or build step (D7). The dark filter is a frontend CSS constant and never enters `/version`, `data-app-config`, or any `/api/*` shape, so there is no contract change or version bump (D8). | proposed |
| **HT8** | **Engineering bar (D9).** The new/changed frontend units — the shared `createBasemapLayer` factory, the per-tile timeout/fallback tile layer, and its pure timeout/URL helpers — ship with **100% unit tests**, full JSDoc, the exact Apache header, and clean linters; all existing suites stay green. The DM-era tile tests are **updated**, not left dangling: `__tests__/config.test.js`, `__tests__/federation-page.test.js`, the leaflet-stub map-init harness, and `main/__tests__/tile-failure-policy.test.js` are retargeted to the HOT-primary + CARTO-fallback wiring. | D9 + proposed |

---

## Bugfix: Basemap provider blend (chess-pattern fix)

The HOT-primary / per-tile-CARTO-fallback basemap (**HT1–HT3**) rendered a
**light/dark checkerboard** in normal use: HOT tiles that beat the per-tile
deadline showed dark-filtered, while tiles that missed it fell back to the
**unfiltered, natively-dark CARTO Dark Matter** (HT2's deliberate `filter:none`
exemption) — two visibly different looks tiling the same viewport. The mix was
*routine*, not rare, because HOT (`openstreetmap.fr`) is slow and HT3's **1000 ms**
deadline was aggressive, so a healthy fraction of tiles fell back on every load
(and re-raced, so the pattern shifted on each pan/zoom). This is a **spec-silent**
consequence of HT2 (filtered-HOT vs unfiltered-CARTO look different *by
construction*) meeting HT3 (frequent per-tile fallback) — no acceptance criterion
was violated; the contract was silent on the visual seam. The fix attacks both
halves: make fallback *rare* (graceful timeout) **and** make the two providers
*look alike* (colored CARTO source + shared dark filter). Frontend-only
(`basemap-config.js`, `base.css`); no API/DB/ingestor change and no contract move
(HT7 posture preserved: still frontend constants, off `/version` and
`data-app-config`).

**Conflict check.** *HT1 (CARTO source = Dark Matter)* — **amended** (BL2: CARTO
Voyager). *HT2 (CARTO fallback exempt from the filter)* — **amended** (BL3: the
fallback shares HOT's filter; HT2's "already dark → don't invert" rationale is void
because the source is now light/colored). *HT3 (1000 ms)* — **amended** (BL1:
2500 ms). *HT4 / HT5 (fallback ladder, shared factory, both maps)* —
**consistent**: the per-tile swap mechanism, the offline last tier, and the single
`createBasemapLayer` factory are unchanged; the federation map shares the `#map`
filter selector, so the blend lands on both maps (parity, Invariant IV). *HT6 (no
attribution)* — **reaffirmed**: Voyager is OSM+CARTO like Dark Matter and
`attributionControl:false` is unchanged. *Apex I / privacy II / D7 / D8 / D11* —
**untouched**: Voyager is a keyless, cookieless, CORS-enabled raster CDN like Dark
Matter; no manifest/dependency/contract change, no version bump. The pattern may
still not be eliminated 100% (a genuinely-failing HOT tile whose CARTO cover is
also slow can briefly flash), but under normal latency both levers together make
it rare and, when it occurs, near-invisible.

| # | Decision | Source |
| --- | --- | --- |
| **BL1** | **Graceful per-tile timeout: 1000 ms → 2500 ms (amends HT3).** `FALLBACK_TIMEOUT_MS` (the single source of truth in `basemap-config.js`) is raised to **2500 ms**, so a slow-but-arriving HOT tile beats the deadline instead of falling back — restoring CARTO to the *rare safety net* HT3 intended, given HOT's real-world latency. Fewer routine fallbacks is the first half of removing the checkerboard. Accepted cost: when HOT is genuinely dead, the blank→CARTO recovery for that tile is up to 2.5 s (was 1 s); the offline tier (HT4) is unaffected. | interview |
| **BL2** | **Colored CARTO source: Dark Matter → Voyager (amends HT1).** The fallback URL becomes `https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png` (same `subdomains:'abcd'`, `detectRetina`, `crossOrigin:'anonymous'`; keyless CORS CDN). Voyager is CARTO's natively-colourful, light-background raster style — chosen precisely so the *same* dark filter that greys HOT greys it too. (A natively-dark source could not be filtered to match — HT2's original constraint — which is why HT2 exempted it; BL3 removes that exemption because BL2 removes its cause.) | interview |
| **BL3** | **Shared dark filter on the fallback tile (amends HT2).** `.map-tiles-fallback` no longer renders `filter:none`; it carries the **same** `grayscale(1) invert(1) brightness(0.9) contrast(1.08)` filter as `.map-tiles-hot`, expressed as one comma-grouped `base.css` rule (the single source of truth for the value). Both providers therefore converge to one coherent dark look, so a viewport mixing HOT and CARTO tiles is no longer a checkerboard — the second half of the fix. The per-tile class swap in `fallback-tile-layer.js` is **unchanged**; only what `.map-tiles-fallback` *does* in CSS changes. Offline placeholder tiles still carry neither class and stay unfiltered. | interview |
| **BL4** | **Both maps, one rule; posture preserved (reaffirms HT5 / HT7).** The federation map shares the dashboard's `#map` container, so the single `base.css` filter rule and the shared `createBasemapLayer` factory land the blend on **both** maps identically (parity, Invariant IV). The filter value and the timeout stay **frontend constants** — no Ruby `tile_filters`, no `/version` / `data-app-config` key, no `/api/*` change, no version bump (HT7 / D8 unchanged). | proposed |

---

## Feature: MeshCore RF metrics (RSSI/SNR/hops/path) & roster-eviction assertion

Closes the MeshCore↔Meshtastic RF-metrics parity gap (issue #762 for MeshCore):
messages gain RSSI/SNR/hops-travelled/path, and node records gain per-advert
signal metrics, all sourced from data the `meshcore` library already delivers
but the ingestor currently drops. Three mechanisms: (1) native `path_len`/`SNR`
fields on the message sync events; (2) the library's built-in RX-log⇆message
join enabled via `decrypt_channels`; (3) a new `RX_LOG_DATA` subscription
handling on-air `ADVERT` frames (full node identity + signal metrics,
roster-independent). Additionally the ingestor asserts the firmware's
`AUTO_ADD_OVERWRITE_OLDEST` roster-eviction bit at startup so a full contact
roster keeps rotating instead of rejecting new contacts. Integrates with
`data/mesh_ingestor/protocols/meshcore/{handlers,runner,decode,interface,_constants}.py`,
the packet store path in `data/mesh_ingestor/handlers/`, `CONTRACTS.md`, one
additive SQLite migration (`messages.hops`, `messages.path`, `nodes.rssi`), the
message/node mappings in `web/lib/potato_mesh/application/data_processing/`,
and the serializers in `queries/`.

**Conflict check against existing decisions.** *Apex I (local LoRa)* —
**consistent**: every new datum arrives over the existing local serial/BLE/TCP
radio link; `decrypt_channels` is local crypto using channel keys the radio
already holds; no broker, dependency, or egress (`guard-edits.py` untriggered).
*Invariant II (privacy & consent)* — **consistent**: no new data class (channel
messages already arrive decrypted via companion sync; adverts are public
broadcasts already stored via the contact path); server-side opt-out,
`PRIVATE`, and retention gates are untouched. The startup config write (RF4) is
a **device** mutation, not a data exposure — treated as a §4.2 scope extension,
documented operator-visibly in the README rather than silent. *Invariant IV
(parity)* — **extends**: fills MeshCore's missing `rxSnr`/`rxRssi`/hops
equivalents using the columns Meshtastic already populates; the new `hops`
column is computed for **both** protocols. *D8/§3.4 (stable contract)* —
**extends**: strictly additive fields (`hops`/`path` on messages, `rssi` on
nodes; adverts otherwise reuse the already-accepted `snr`/`hops_away` node
fields), no version bump. *A4e (MeshCore adverts gap)* — **extends**: RX-log
adverts enrich non-roster nodes with full identity; the bare-`ADVERTISEMENT`
minimal upsert stays as the fallback for builds without RX-log frames (A4e
criteria updated, not removed). *MD-A1/MW-A1 (MeshCore dedup)* —
**consistent**: `_derive_message_id` inputs stay byte-identical (RF6). No
decision is contradicted.

| # | Decision | Source |
| --- | --- | --- |
| **RF1** | **Hops-travelled on messages, both protocols.** Message packets gain a `hops` field = repeater relays actually travelled: MeshCore reads the native `path_len` on `CONTACT_MSG_RECV`/`CHANNEL_MSG_RECV` (the `255` "direct" sentinel normalizes to `0`; the 2-bit `path_hash_mode` prefix is masked off); Meshtastic computes `hopStart − hopLimit` when both are present (else omits). Stored in a new **additive** `messages.hops INTEGER` column — deliberately distinct from `hop_limit` (remaining budget, a different semantic, left untouched). MeshCore V3 sync frames' native `SNR` continues to flow into the existing `messages.snr` column. | interview + code |
| **RF2** | **Channel-message RSSI/path via the library's RX-log join.** The runner sets `mc.decrypt_channels = True`; the `meshcore` lib then matches each `CHANNEL_MSG_RECV` to its on-air frame by `SHA256(sender_timestamp + text)` and injects `RSSI`, `path`, `recv_time` (channel secrets are already registered by `_ensure_channel_names`, so no new key handling). The handler forwards `RSSI` → the existing `messages.rssi` column and the hop-hash route → a new **additive** `messages.path TEXT` column (lowercase hex, `path_hash_size`-byte hashes concatenated in travel order, last = the repeater heard directly; raw material for a future topology view, no hash→node resolution attempted now). **DM RSSI is explicitly out of scope** — direct messages are E2E-encrypted so no RX-log join exists; DMs still get native SNR + hops via RF1. | interview + code |
| **RF3** | **RX-log `ADVERT` frames become full node upserts (roster-independent).** A new `RX_LOG_DATA` subscription handles frames with `payload_typename == "ADVERT"`: `adv_key` (full 32-byte pubkey) → canonical `!%08x` id, `adv_name` → long name, `adv_type` → role via `_MESHCORE_ADV_TYPE_ROLE`, `adv_lat`/`adv_lon` → position store, and per-reception `snr` → `nodes.snr`, `path_len` → `nodes.hops_away` (existing, already-accepted node fields), `rssi` → a new **additive** `nodes.rssi INTEGER` column (Meshtastic has no per-node RSSI source — `NodeInfo` carries only SNR — so it stays `NULL` there; the column itself is protocol-neutral). This restores full node identity even when the radio's roster is full, closing the anonymous-placeholder gap. **Only `ADVERT` frames are handled**; other RX-log payload types stay in the DEBUG-only catch-all, and `RX_LOG_DATA` no longer falls through to `ignored-meshcore.txt`. Degrades gracefully: companion firmware ≥ 1.16 pushes RX-log frames unconditionally while a client is connected, but if none arrive (other builds), RF1 metrics and the existing bare-`ADVERTISEMENT` fallback (A4e) still function — absent frames are never an error. | interview + code |
| **RF4** | **Always-on roster-eviction assertion (extends §4.2 ingestor scope).** At startup (after connect, `_ensure_channel_names`-style error tolerance) the ingestor reads `get_autoadd_config` and, **only if** bit `0x01` (`AUTO_ADD_OVERWRITE_OLDEST`) is unset, writes `config \| 0x01` back — a read-modify-write that preserves the type-filter bits 1–4 and never touches `autoadd_max_hops`; when the bit is already set no write occurs (the firmware `savePrefs()`es every set — skipping avoids flash wear). Unconditional by deliberate choice — **no env/config knob**; the behavior is documented in the README (deliberate and operator-visible, not silent), favourites are never evicted (firmware guarantee), and the write persists in device flash. `ERROR`/timeout from pre-1.16 firmware logs a warning and continues. This is the ingestor's **first and only** radio-config write, bounded to this single bit. | interview |
| **RF5** | **`CONTACT_DELETED` becomes an explicit no-op handler.** Roster eviction (RF4) makes the firmware emit `PUSH_CODE_CONTACT_DELETED` per evicted contact; the event moves from the DEBUG catch-all to an explicit debug-logged no-op in the handler map — the web DB **intentionally retains** evicted nodes (dashboard history is independent of roster capacity; `retention.rb` remains the only data-expiry authority). | interview |
| **RF6** | **Additive contract; dedup fingerprint frozen.** `CONTRACTS.md` documents the new fields (`messages.hops`/`messages.path`, `nodes.rssi`), the `255`→direct rule, the path hex format, and the advert→node field mapping. All changes are **additive** (D8: no version bump): the POST routes accept and the GET routes serialize the new fields; absent fields stay `NULL`. The MeshCore dedup fingerprint (`_derive_message_id` inputs) and the `v1:` content-dedup scheme are **byte-identical** — new fields ride alongside, never inside, the id derivation (MD-A1/MW-A1 preserved). | interview + code |
| **RF7** | **Store + API only; UI display deferred.** v1 ends at the JSON API — no dashboard rendering of the new metrics (chat hover, node popup, topology view from `path` are tracked follow-ups). Closes #762 for MeshCore at the data layer. | interview |
| **RF8** | **Engineering bar (D9).** All new/changed units ship with 100% unit tests (including: RF1 hops normalization edge cases, RF2 join-absent fallback, RF3 malformed-advert tolerance, RF4 read-modify-write/skip/error paths, RF5 no-op), full PDoc/RDoc, the exact Apache header, `black`/`rufo` clean; every existing suite stays green. | CLAUDE.md |

---

## Feature: Live relative-time tick (dynamic timers)

Makes every rendered relative-time field count up in real time between data
refreshes — "last seen 4s" becomes 5s, 6s, … without waiting for the next
fetch — so a displayed age is never stale. Pure display-side ticking of the
strings the existing formatters already produce; frontend-only (vanilla JS), no
API/DB/ingestor change. Integrates with
`web/public/assets/js/app/main/format-utils.js` (`timeAgo`), the node-table and
map-overlay render paths in `main.js`, the node-detail table
(`node-page/single-node-table.js` via
`node-page-charts/display-formatters.js#formatRelativeSeconds`), the federation
instances table (`federation-page.js`), and a new shared ticker module under
`web/public/assets/js/app/main/`.

**Conflict check.** *PS5/PS7 (poll removed; fetch is event-driven)* —
**consistent**: the ticker is a pure presentation clock — no fetch, no cadence
change, no cache write (FC2 untouched). *VF1 (poll-era "last updated" control
removed)* — **consistent**: no global timestamp control returns; ticking is
per-field on data ages. *VF4/VF6, LV1/LV2, CR-A1 (fades on already-rendered
DOM; idle tick materializes 0)* — **extends (guarded)**: the tick mutates age
text in place only and never re-renders rows/markers/chat entries, so fades are
never restarted or truncated. *LD-A2/LD-A3/CL-A3 (scroll + open-overlay
survival)* — **consistent**: in-place text writes cannot reset scroll or close
overlays; an open popup's age ticking extends LD-A3's spirit. *D7 (fixed
stack)* / *D8 (stable contract)* — **consistent**: vanilla JS, no new
dependency, nothing enters `/version`, `data-app-config`, or any `/api/*`
shape. *Invariants I/II/IV* — **consistent**: no network egress at all,
displays only already-fetched data, ages tick identically for every protocol.
No existing decision is contradicted or amended.

| # | Decision | Source |
| --- | --- | --- |
| **RT1** | **Live-ticking ages, display-only.** Every rendered relative-time field — the node-table "last seen" / "last position" cells, the marker short-info overlay's "Last seen" line, the node-detail (`/n/:id`) last-seen / last-position rows, and the federation instances "last update" column — counts up in real time between data refreshes. **Amended in-interview:** the marker overlay (`openShortInfoOverlay`) previously displayed *no* time field (the "Last seen" popup builder `buildMapPopupHtml` is runtime-dead, reachable only from tests), so the overlay **gains** a "Last seen" line — new visible content, sourced from the `lastHeard` already in its payload, ticking while the overlay is open; the legacy popup builder is wired with tick markup for completeness. The tick is a presentation clock only: it triggers **no** fetch, alters no refresh cadence (PS5/PS7), and never touches the data cache (FC2). | interview (amended) |
| **RT2** | **One shared ~1 s ticker; in-place text mutation only.** A single shared interval drives all registered fields: each tick re-evaluates the age string with the **unchanged** existing formatters (`timeAgo` / `formatRelativeSeconds`) and writes the DOM **only when the string changed** (so "3d 4h" fields update rarely, "4s" fields every second). The ticker mutates existing text in place and never re-renders rows, markers, or chat entries — preserving CR-A1 (idle materializes 0), LD-A2/CL-A3 (scroll), LD-A3 (open overlays), and the LV1/LV2 fade timers. **Amended in-build:** the federation page's local formatter turned out to be a *distinct format* (`5m ago` — coarse, suffixed), not a duplicate of `timeAgo`; it is hoisted **verbatim** into shared `format-utils.js` as `timeAgoSuffixed` (one definition repo-wide) and registered as the ticker's `ago-suffixed` variant — RT4's format preservation wins over literal consolidation. | interview (amended) |
| **RT3** | **Wall-clock truth: independent of pause; idle when hidden.** Ages keep ticking regardless of the `#autorefreshToggle` play/pause state — the toggle pauses *data* updates (PS5), not the clock. When the tab is hidden the ticker idles (no background work) and snaps every field to its correct value the moment the tab becomes visible again. | interview |
| **RT4** | **Format & contract unchanged.** The output format stays exactly today's (`4s`, `3m 12s`, `5h 2m`, `3d 4h`; empty/invalid timestamps keep rendering exactly as today). Frontend-only: no API, `/version`, or `data-app-config` change (D8), vanilla JS with no new dependency (D7), protocol-neutral (Invariant IV), no network egress and no new data exposure (Invariants I/II). | interview |
| **RT5** | **Engineering bar (D9).** The ticker module and every touched render path ship with 100% unit tests, full JSDoc, the exact Apache header, and clean linters; all existing suites stay green. Existing formatter specs (`format-utils.test.js`, display-formatter tests) remain valid unchanged — the format is untouched; render-path specs are **updated** only where fields gain tick registration. | CLAUDE.md |

---

## Feature: Dual stacked basemap layers (HOT over CARTO, no timeout)

Replaces the per-tile HOT→CARTO *timeout-and-swap* basemap (HT1–HT3, BL1–BL3)
with **two always-on, simultaneously-loaded tile layers**: CARTO Voyager as the
bottom **base** layer and OpenStreetMap France **HOT** as the opaque **overlay**
on top. Both are requested at once on every viewport; a HOT tile paints over the
CARTO cell beneath it as it arrives (a per-tile fade), so a slow HOT tile shows
the already-present CARTO tile in the meantime rather than a blank cell or a
deadline-driven fallback. This structurally eliminates the light/dark
checkerboard the timeout mechanism produced: there is no per-tile deadline to
miss, both providers wear the *same* dark filter, and the two layers composite to
one coherent dark basemap. HOT was observed to time out so often that the
2500 ms per-tile deadline (BL1) was still insufficient and the map routinely
checkerboarded; stacking the layers removes the deadline entirely. The custom
per-tile fallback tile layer (`main/fallback-tile-layer.js`) and its timeout
constant are retired. Frontend-only (vanilla JS `basemap-config.js`, `base.css`,
README doc line); no API/DB/ingestor change and no Ruby `tile_filters` /
`data-app-config` return.

**Conflict check.** *HT1 (CARTO "never the primary", only a per-tile fallback
source)* — **contradicts → amended** (SB1: CARTO is a permanent base layer under
HOT). *HT3 (per-tile 1000 ms→CARTO swap) / BL1 (raised to 2500 ms)* —
**contradicts → amended** (SB1: the per-tile deadline and swap mechanism are
deleted, not re-tuned). *HT2 (dark filter on the per-tile class `.map-tiles-hot`,
CARTO exempt) / BL3 (fallback shares HOT's filter, per-tile)* — **amended** (SB3:
the identical filter *value* now sits on the per-**layer** containers
`.map-tiles-hot` / `.map-tiles-fallback`, because with no per-tile swap Leaflet
stamps the class on the layer container, not each `<img>`; both providers stay
filtered, as BL3 already established). *HT4 / DM3 (offline placeholder is the last
tier)* — **extends** (SB5: the single liveness policy is now fed by *both* layers;
the placeholder fires only when the whole viewport fails on both providers).
*HT5 / BL4 (one shared `createBasemapLayer` factory on both maps)* —
**consistent** (SB1: the factory still owns the whole basemap and both maps call
it; it now returns two layers instead of one). *HT6 / DM5 (no attribution)* —
**reaffirmed** (SB7). *BL2 (colored Voyager fallback source)* — **reaffirmed**
(SB1 keeps the Voyager URL). *HT7 (common-case egress is HOT-only; CARTO fetched
only on a HOT-tile failure)* — **contradicts → amended** (SB6: both CDNs are
requested on every viewport, so third-party tile egress is now two CDNs, not one;
still keyless, cookieless, no credential/analytics/identifier — D11 holds).
*Apex I* — **consistent**: HOT and CARTO are raster tile CDNs, not MQTT/cloud
brokers; no manifest/dependency change (`guard-edits.py` untriggered); tiles are
browser→CDN as before. *Invariant II / D11 (no phone-home)* — **consistent under
the SB6 amendment**: egress doubles to a second keyless CDN but carries no
per-operator credential, cookie, analytics beacon, or user/mesh identifier — only
tile coordinates. *Invariant IV (parity)* — **consistent**: the basemap is
protocol-neutral, identical for Meshtastic and MeshCore and on both maps.
*D7 (fixed stack)* — **consistent**: native Leaflet `L.tileLayer` × 2, no new
package or build step (the custom subclass is *removed*). *D8 (stable contract)* —
**consistent**: filter, opacity, and z-index are frontend constants; nothing
enters `/version`, `data-app-config`, or any `/api/*` shape, so no version bump.
No invariant is contradicted.

| # | Decision | Source |
| --- | --- | --- |
| **SB1** | **Two always-on stacked layers from one factory (amends HT1, HT3, BL1).** The shared `createBasemapLayer(L)` (in `basemap-config.js`) returns **two** native `L.tileLayer` instances — a CARTO **Voyager** base (`https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png`, `subdomains:'abcd'`, `detectRetina:true`, `crossOrigin:'anonymous'`, `className:'map-tiles-fallback'`, `zIndex:1`) and a **HOT** overlay (`https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png`, `subdomains:'abc'`, `maxZoom:19`, `crossOrigin:'anonymous'`, `className:'map-tiles-hot'`, `zIndex:2`) — both added to **both** the dashboard (`main.js`) and federation (`federation-page.js`) maps. Both are fetched simultaneously on every viewport; there is **no** per-tile deadline or swap. The custom `main/fallback-tile-layer.js` (its `FALLBACK_TIMEOUT_MS`, `wireTileFallback`, `buildFallbackTileUrl`, `HOT_TILE_CLASS`/`FALLBACK_TILE_CLASS`) and `basemap-config.js`'s `prefersRetinaTiles` are **retired** — CARTO retina is handled by Leaflet's native `detectRetina`. The tile **URLs** are unchanged from BL2. **Amends HT1** (CARTO becomes a permanent base layer, not merely a per-tile fallback source) and **HT3/BL1** (the timeout mechanism is deleted, not re-tuned). | interview |
| **SB2** | **HOT opaque on top; per-tile dissolve via Leaflet-native fade.** The HOT overlay renders at full layer opacity (1) so a loaded HOT tile completely covers the CARTO cell beneath it. Each HOT tile fades in 0→1 over Leaflet's built-in tile-fade (~200 ms, `fadeAnimation` left **enabled** — the app does not disable it and adds **no** competing custom opacity transition that would fight Leaflet's inline tile-opacity management), so the CARTO→HOT handover reads as a dissolve rather than a pop, and a slow HOT tile shows the already-present CARTO tile underneath meanwhile. Because HOT always paints over CARTO where it arrives, and both wear the same dark filter (SB3), a viewport mixing arrived-HOT and not-yet-arrived (CARTO-showing) cells never reads as a checkerboard. | interview |
| **SB3** | **Shared dark filter on the per-layer containers (amends HT2/BL3 selector; value unchanged).** The single-source-of-truth filter `grayscale(1) invert(1) brightness(0.9) contrast(1.08)` (identical value to BL3, with its `-webkit-` twin) is applied in one `base.css` rule to the two layer containers `#map .leaflet-layer.map-tiles-hot, #map .leaflet-layer.map-tiles-fallback`. With no per-tile swap, Leaflet stamps each layer's `className` on its **container** (`.leaflet-layer`), and `filter` on a container greys that provider's whole tile set as one group; both providers therefore converge to the same dark look. The removed per-theme machinery is **not** restored: no Ruby `tile_filters`/`DEFAULT_TILE_FILTER_*`, no `frontend_app_config`/`data-app-config` `tileFilters`, no JS `resolveTileFilter`/`applyFiltersToAllTiles`/MutationObserver, no `--map-tile*-filter` custom property. Offline placeholder tiles carry neither class and stay unfiltered. **Amends HT2/BL3** (per-tile → per-layer selector; the filter *value* and its single-rule home are unchanged). | interview |
| **SB4** | **Single pane dimming veil (brightness parity).** Tile dimming collapses to one rule `#map .leaflet-tile-pane { opacity: 0.5625 }`; `.leaflet-layer` returns to opacity 1 and the former `#map .leaflet-tile.map-tiles { opacity: 0.75 }` selector is removed (the `map-tiles` container class is gone). `0.5625 = 0.75 × 0.75` is the *effective* brightness the single pre-SB layer rendered at (pane 0.75 × layer 0.75), so the two stacked layers composite to **exactly today's** brightness. Dimming once at the pane makes the result independent of how many layers are in the tile pane — including when the offline placeholder (SB5) is added as a third. | interview |
| **SB5** | **One liveness policy fed by both layers (extends HT4/DM3).** A single `createTileFailurePolicy` instance (`main/tile-failure-policy.js`, unchanged) receives `tileload` / `tileerror` / `load` from **both** layers on the dashboard: a `tileload` from **either** provider latches the basemap "alive", and `activateOfflineTiles` fires only when the whole initial viewport produced **zero** successful tiles across both layers (comprehensive dual outage). Thus HOT-down/CARTO-up **and** CARTO-down/HOT-up each keep a working map; only a both-providers outage reaches the offline placeholder. The offline switch removes **both** online layers. The offline `GridLayer` tier stays **dashboard-only** (the federation map keeps no kill-basemap logic, unchanged from DM3/HT5). **Extends HT4/DM3** (the ladder's top rung is now two parallel providers instead of one primary-with-fallback). | interview |
| **SB6** | **Always-on dual egress; privacy posture (amends HT7).** Both keyless, cookieless raster-tile CDNs (HOT `openstreetmap.fr`, CARTO `cartocdn.com`) are now requested on **every** viewport — HT3's "CARTO only on a HOT-tile failure" conditionality is gone — so third-party tile egress is **two** CDNs rather than one, and CARTO now sees each viewer's IP/`Referer` on every pan/zoom rather than only on a HOT failure. Neither CDN receives a credential, cookie, analytics beacon, API key, or any user/mesh/operator identifier — only standard `{z}/{x}/{y}` tile coordinates — so **D11 (no phone-home) holds**: the bar is telemetry, which neither provider is sent. The doubled egress is documented **operator-visibly** in the README (a deliberate, disclosed trade-off, not silent). Reaffirms HT6/DM5 (no attribution) and Apex I (raster CDNs, not brokers; `guard-edits.py` untriggered). **Amends HT7** (which banked on common-case HOT-only egress). | interview |
| **SB7** | **Stack & contract untouched (reaffirms D7/D8, HT5/BL4).** Native Leaflet only — two `L.tileLayer`s, **no** custom subclass, no new package or build step (D7). The dark filter, the pane opacity, and the layer z-indices are frontend constants; none enters `/version`, `data-app-config`, or any `/api/*` shape, so there is no contract change and no version bump (D8). The whole basemap still lives behind the one shared `createBasemapLayer` factory called by both maps (HT5/BL4), and it is protocol-neutral (Invariant IV). | proposed |
| **SB8** | **Engineering bar (D9).** The new/changed frontend units — the `createBasemapLayer` factory (now returning the base+overlay pair) and the layer-option constants — ship with **100% unit tests**, full JSDoc, the exact Apache header, and clean linters; all existing suites stay green. Retired-module tests are **deleted, not left dangling**: `main/__tests__/fallback-tile-layer.test.js` is removed with its module. `__tests__/basemap-blend.test.js`, `__tests__/basemap-config.test.js`, `__tests__/federation-page.test.js`, `__tests__/config.test.js`, and the leaflet-stub map-init harness are **retargeted** to the two-layer wiring. **BL-A1** (which asserted `FALLBACK_TIMEOUT_MS === 2500`) and **HT-A3** (the per-tile swap mechanism) are **amended**, not silently broken. | D9 + proposed |

---

## Bugfix: MeshCore duplicate-node reconciliation (stale same-name identities)

One physical MeshCore node surfaced as **three** dashboard rows: its live
pubkey-derived row, a *retired* pubkey-derived row (an old keypair still present
in ≥1 community roster), and the name-derived synthetic placeholder. Root
causes, confirmed by deterministic reproduction: (a) the #755/#803 synthetic
merge deadlocks as soon as a **second** same-name real row exists, because its
ambiguity guard is absolute and unbounded in time; (b) duplicate message copies
from co-operating ingestors overwrite `messages.from_id` last-writer-wins and
bump their own `from_id` node's `last_heard`, so a retired identity that any
stale roster still name-resolves receives eternal liveness and never ages out;
(c) RX-log advert positions are keyed on receiver-side `recv_time`, so one
advert flood mints one position row per copy and per ingestor. Integrates with
`web/lib/potato_mesh/application/data_processing/{node_writes,messages}.rb`,
`application/database.rb` (migration + #755 startup backfill),
`application/queries/node_queries.rb`,
`data/mesh_ingestor/protocols/meshcore/{handlers,decode}.py`, and
`data/mesh_ingestor/CONTRACTS.md`.

**Conflict check against existing decisions.** *MC-A1 / #755 machinery* —
**amended, not silently overridden** (MR2): the documented "never merge when two
same-name reals exist" rule gains a keyed-evidence freshness bound; the
single-candidate base semantics are untouched. *RF3 (RX-log adverts)* —
**extends** (MR5): only the position-time anchor moves from receiver-side to
sender-side; the node mapping, `lastHeard`, and signal metrics are unchanged.
*RF5 / retention* — **consistent**: no new deletion path; a retired identity
simply stops receiving phantom liveness and ages out of the 7-day views while
`retention.rb` remains the only data-expiry authority. *D8 (stable contract)* —
**extends**: `nodes.last_advert_heard` (internal), the `synthetic` response
field (MR4), and the sender-side position anchor are all additive; no version
bump. *Invariant II (privacy)* — **consistent**: `synthetic: true` reveals only
that a row is a name-derived placeholder (derived from public chat text); no
new data class is exposed and opt-out/`PRIVATE` gates are untouched. *Invariant
IV (parity)* — **consistent**: the evidence column is written by one
protocol-neutral rule (any keyed, non-synthetic record); the resolution rules
are scoped to MeshCore only because the synthetic-placeholder mechanism is
MeshCore's own; Meshtastic behavior is byte-identical. *Apex I* — untouched.

| # | Decision | Source |
| --- | --- | --- |
| **MR1** | **Keyed-evidence column.** Additive `nodes.last_advert_heard INTEGER` records the newest time a node was heard via a **key-authenticated record** — any non-synthetic upsert carrying `user.publicKey` (MeshCore contact/advert/self-info; Meshtastic NodeInfo with a key) — using the record's own heard time (sender-side `last_advert` for roster contacts, reception time for RX-log adverts), advancing forward-only. Name-inferred paths (message touches, chat placeholders) never write it. Written by a **separate, unguarded** statement, not a column in the main upsert: that upsert skips any record older than the stored `last_heard`, so a node whose `last_heard` was pushed to "now" by message touches would otherwise never record evidence from its own (sender-side-stamped, hence older) adverts — the exact situation the column exists to resolve. The migration seeds **no backfill**; every live device re-arms on its next advert/roster snapshot. | interview |
| **MR2** | **Positive-staleness merge ambiguity (amends #755/#803 guard).** A same-name real row stops creating merge **ambiguity** only once it is *positively known* to be retired: `COALESCE(last_advert_heard, position_time)` **exists and** is older than `now − four_weeks_seconds`. **Absence of evidence is never staleness** — a `NULL` (a row predating the column; a node that has not re-advertised) keeps blocking exactly as today, so the post-migration window, and any quiet node, cannot be mis-merged. `position_time` is the legacy fallback signal because a MeshCore position is only ever written from a key-authenticated record (roster contact, advert, self-info) and never from chat text, making it valid historical keyed evidence. `merge_synthetic_nodes` bails when a not-positively-stale *other* real exists; `merge_into_real_node` folds into the survivor when all rivals but one are positively stale (≥2 live, or unknown rivals, keep refusing); the #755 startup backfill applies the same predicate. Single-candidate semantics are unchanged. The retired row itself is never deleted by the merge. *Accepted limitation:* a live node with a stale GPS fix and no evidence yet looks retired until its next advert (one advert cycle, self-healing); a retired identity that never stored a position stays "unknown" and keeps blocking, awaiting manual resolution. | interview |
| **MR3** | **Duplicate-copy sender resolution (MeshCore).** When a MeshCore message copy arrives for an existing row with a different `from_id`, the ids are ranked — live-or-unproven real (2) > positively-stale real (1) > synthetic/unknown (0), using the same predicate as MR2 — and the incoming id replaces the stored one only on a **strictly higher** rank (ties keep the existing id; the empty/missing-`from_id` fill is unchanged). Applied on both collapse paths: the primary `id`-PK update **and** the `ConstraintException` insert-race fallback, which is precisely where two ingestors' copies meet. The sender-side ensure/touch block targets the **resolved winner**, so a losing copy grants no liveness to its own node — a retired identity's `last_heard` freezes and it ages out of the 7-day views naturally. Meshtastic message handling is byte-identical. | interview |
| **MR4** | **`synthetic` exposed on the node API.** `GET /api/nodes` and `GET /api/nodes/:id` emit `synthetic: true` on name-derived placeholder rows and omit the key on real rows (matching the API's compact nil/blank convention — no `synthetic: false` noise). Additive per D8; documented in `CONTRACTS.md`. | interview |
| **MR5** | **Sender-side position anchor for RX-log adverts (extends RF3).** The RX-advert path keys positions on the advert's own `adv_timestamp` (exposed by the `meshcore` library parser), falling back to `recv_time` when absent/zero, for both the `POST /api/positions` record and the node-row `position.time` anchor; `lastHeard` stays receiver-side. All flood copies of one advert — across paths **and** across ingestors — collapse to a single position identity, restoring the documented dedup intent; no grace window is needed. | interview + code |
| **MR6** | **Engineering bar (D9).** Every touched unit ships with unit tests (evidence tracking, both merge directions incl. retained refusals, rank-resolution cases, adv-timestamp keying + fallback, API flag), full RDoc/PDoc, Apache headers, `black`/`rufo` clean; all suites stay green. | CLAUDE.md |


---

## Bugfix: MeshCore roster sync must not warm `last_heard` (issue #853)

Loading the MeshCore contact roster re-stamped every positioned contact's
`last_heard` to the sync wall-clock, so a node last actually heard months ago
reappeared as **active**. `ensure_contacts()` runs at launch and on every
reconnect (and `auto_update_contacts` re-fetches on adverts); each positioned
contact then POSTed `/api/positions` with `rx_time = now`, and the web folds
`rx_time` into `last_heard` via `MAX` (`update_node_from_position`). The
node-upsert path already used the contact's real `last_advert` (MR1's stated
intent); only the position path violated it. Integrates with
`data/mesh_ingestor/protocols/meshcore/{position,handlers}.py`.

**Conflict check.** *MR1 (roster contacts anchor on `last_advert`)* — **extends**:
this brings the position path into line with the principle MR1 already stated
for the node-upsert path; nothing in MR1 changes. *MR5 (RX-log advert position
anchor)* — **consistent**: the RX-advert path is a genuinely-live reception and
keeps `rx_time = now`; only its `position_time` uses `adv_timestamp`, unchanged.
*RF5 / retention* — **consistent**: no new deletion; a dead contact simply stops
being warmed and ages out of the 7-day window. *D8 (stable contract)* —
**consistent**: no `/api/*` shape change (the `rx_time` field already exists);
the web side is untouched. *Apex I / Invariant IV* — untouched (local RX only,
protocol-neutral position handling).

| # | Decision | Source |
| --- | --- | --- |
| **RS1** | **Roster-sync positions carry the contact's real reception time.** `_store_meshcore_position` gains an explicit `rx_time` override (default = wall clock). The two roster-sync callers — `_process_contacts` (bulk `CONTACTS`) and `_process_contact_update` (`NEW_CONTACT`/`NEXT_CONTACT`) — pass the contact's `last_advert` as that `rx_time`, so the web-side `last_heard = MAX(rx_time, position_time)` resolves to `last_advert` rather than `now`. A live `NEW_CONTACT` has `last_advert ≈ now`, so it is unaffected; only genuinely-old roster contacts get a truthful old `last_heard`. The **genuinely-live** position paths — host `SELF_INFO` and on-air RX-log `ADVERT` (`on_rx_log_data`) — keep `rx_time = now` (their `last_heard` must advance). Ingestor-side only; the web `update_node_from_position` `MAX` logic is correct for real packets and is left unchanged. | interview + code |
| **RS2** | **Engineering bar (D9).** The changed position helper and roster handlers ship with unit tests (roster `rx_time = last_advert`; `rx_time` override; live self-info / RX-advert still `now`), full PDoc, Apache headers, `black`-clean; all suites stay green. | CLAUDE.md |

---

## Bugfix: Frontend design & UX audit remediation (D-001…D-040)

Remediates the 2026-07-22 design/UX audit of the dashboard frontend: 39 of its
40 findings reproduced deterministically against source, live server HTML, and
computed WCAG contrast (D-039 — "sort indicators invisible until first click" —
did **not** reproduce: `sortState` initialises to `last_heard`/`desc` and
`updateSortIndicators()` runs at init, so it is rejected). No finding violated
an existing SPEC decision or acceptance criterion — the contract was silent on
empty states, accessibility, contrast, information architecture, and visual
encoding; this section closes that gap. The maintainer gates from the audit are
ratified as contract: the map is the landing thesis, static pages belong to a
secondary tier, **dark-only is identity**, operator-facing theme tokens are in
scope, and the reduced mobile table is legitimate but must be curated.

**Conflict check against existing decisions.** *DM7 (dead light palette
collapsed)* — **extends**: the remaining light *component* literals + their
`body.dark` overrides (explicitly left by DM7) are now folded to single dark
rules; rendered appearance unchanged. *VF5/LV1–LV9 (flash/fade/wave,
reduced-motion)* — **consistent/extends**: `prefers-reduced-motion` additionally
gates Leaflet zoom easing and the chat-tablist smooth scroll (motion LV9 never
covered). *RT1–RT4 (relative-time tick)* — **extends RT2**: the shared ~1 s
tick additionally refreshes row age-bucket attributes (write-on-change, no
re-render; markers stamp their bucket at render only — a deliberate VF3-style
boundary). *LD-A2 (horizontal tab scroll preserved)* / *LV8 (tab dropdown)* —
**consistent**: the strip keeps its scroll behaviour on desktop; ≤900 px the
strip is hidden and LV8's dropdown is the sole channel navigation. *Invariant
IV (parity)* — **extends**: MeshCore/Meshtastic gain a shape channel (square vs
circle markers) — differentiation, not privilege; both remain equally legible
and equally featured. *FS1–FS6 (signed federation wire)* — **consistent**: the
CHANNEL→preset migration (UX12) keeps every wire/JSON **key** unchanged
(`channel` now carries the resolved preset string), so no third signature
break. *D8 (stable contract)* — **consistent**: no `/api/*` shape change;
`/version` keys unchanged (values follow UX12 resolution). *Apex I / privacy
II* — untouched: presentation-layer only, no dependency, no egress.

| # | Decision | Source |
| --- | --- | --- |
| **UX1** | **Audit ratified; D-039 rejected.** The 39 reproduced findings are defects to fix; D-039 is dropped as not-reproduced (init stamps the default ▼). Line-number evidence re-based after #851. | audit + review |
| **UX2** | **Accessibility floor: WCAG 2.1 AA contrast (1.4.3) for UI text.** Role-badge text colour is computed from the badge background's luminance (both palettes, all roles ≥ 4.5:1; kills the one-off `meshcoreRoleTextColors` map); chat log entries render `--muted`; errors render a new `--danger: #ff6b6b` token (≥ 4.5:1 on `--bg`); links use the single `--accent` (the `body.dark a { color:#9bd }` override is deleted); the four `#4a90e2` focus-ring literals become `var(--accent)`. | interview |
| **UX3** | **Token aliases, not a rename.** `:root` gains `--border: var(--line)`, `--surface: var(--bg2)`, `--table-header-bg: var(--table-head-bg)`, `--hover-bg: var(--row-alt)` (fixing the federation table's undefined-token borders/sticky header) plus `--danger`. The audit's full `--pm-*` operator-theming rename is **deferred** to a follow-up feature. | interview |
| **UX4** | **Degenerate states speak.** The layout ships a `<noscript>` notice; the nodes table ships a server-rendered `nodes-empty-row` ("No nodes heard yet — waiting for the first ingestor report.") that JS removes once nodes render and restores when the set is empty; empty table cells render a muted `—` dash (overlay parity); the empty-map placeholder stripes rise to 8–12 % white and always show the placeholder message when no positions exist. | interview |
| **UX5** | **Freshness is visible state.** Rows and markers carry an age bucket — `live` (< 3 h), `today` (< 24 h), `stale` — stamped at render; CSS dims stale rows and accent-rules live rows; markers scale `fillOpacity` .85/.55/.30 by bucket. Buckets on rows refresh via the shared RT2 tick (attribute write-on-change; extends RT2). Markers restamp on data refresh only. | interview |
| **UX6** | **Live/paused is legible.** The `#autorefreshToggle` becomes a text-bearing control: `● live` while streaming, `❚❚ paused HH:MM` when paused (timestamp = pause moment). Same element/id, aria semantics kept. | interview |
| **UX7** | **Protocol shape channel + line key.** MeshCore markers render as square chips (`L.divIcon`), Meshtastic stays circular — colour keeps encoding role, shape encodes protocol (colourblind-safe). The legend's existing neighbor/trace toggle buttons gain 24 px line samples (solid = neighbor, dashed = traceroute), closing the missing-key gap without new controls. | interview |
| **UX8** | **Legend defaults honest.** `/map` renders the legend expanded on desktop (collapsed ≤ 659 px and on the dashboard); the toggle label reads `Hide legend` / `Show legend` with a suffix **only** when role filters are active (mirrors the aria gating). | interview |
| **UX9** | **Table IA curated.** Nodes table: a grouped second header row (Identity · Radio · Activity · Health · Utilization · Environment · Position) whose colspans are JS-maintained across the responsive tiers; ≤ 659 px survivors become Protocol/Short/Long/Last Seen/**Battery** (Role hides); a per-row `+` disclosure reveals the hidden fields as a definition list; rows get a hover state and a whole-row click that follows the long-name link; numeric columns right-align in the mono face with `tabular-nums` and the unit-bearing headers name their units (`Battery %`, `Voltage V`); `thead` was already sticky (the pre-existing bare `th` rule) and the fold gives it a solid background; both tables gain visually-hidden `<caption>`s and `scope="col"`; the dashboard gains visually-hidden section `h2`s. Federation table: Preset terminology (UX12), priority column order (Name · Domain · Preset · Frequency · Active …), lat/lon behind responsive tiers. | interview |
| **UX10** | **Number honesty.** Utilisation renders 1 decimal; battery > 100 renders `100% ⚡` (powered sentinel); voltage with \|V\| < 0.01 renders the dash. | interview |
| **UX11** | **Shell economics.** Site title clamps (`clamp(18px, 2.2vw, 28px)`, 40 vw ellipsis); the hamburger breakpoint rises to 1100 px; static pages move from both navs to the footer links row; the `(week)` count leaves the h1/tab title — the meta line becomes `N nodes today · M this week` with the day figure in `--fg`; the federation nav count gains a `title` tooltip; the Charts nav drops its protocol icon; the region selector collapses behind a compact 🌐 toggle; the announcement banner wraps to ≤ 3 lines under 600 px; the colocated-hub hit area grows to 32 px (16 px visual); chat ≤ 900 px shows the LV8 dropdown only (28 px arrows on desktop); chat entries get an 8ch hanging indent; `Select region ...` becomes `Other regions…`. | interview |
| **UX12** | **Join surface + preset config migration (deprecating, fallback-compatible).** New env vars `MESHTASTIC_PRESET` (default `#LongFast` — the pre-existing `DEFAULT_CHANNEL` constant, so stock instances keep today's advertised strings) + `MESHTASTIC_FREQ` (default `915MHz`) and `MESHCORE_PRESET` + `MESHCORE_FREQ` (both empty ⇒ MeshCore line hidden). `CHANNEL`/`FREQUENCY` are **deprecated but honoured as fallbacks** for the Meshtastic pair. A `join-line` strip in the meta row renders `Meshtastic · <preset> · <freq>` (+ `MeshCore · <preset> · <freq>` when configured), linking to the About page when one exists. Terminology moves channel→preset everywhere operator-facing (federation table header **Preset**); every wire/JSON **key** (`channel` in `/version`, `data-app-config`, the signed federation payload) is unchanged and now carries the resolved Meshtastic preset string — no signature or contract break (FS1/BF3/D8 hold). README documents the migration. | interview |
| **UX13** | **Map-first mobile landing, CSS only — found already implemented.** The audited route-swap was rejected (impossible viewport-conditionally server-side); the agreed CSS mechanism turned out to already ship: the ≤ 1024 px media block orders the chat panel after the map (`.chat-panel { order: 2 }`), so the mobile dashboard paints map-first today. Verified against source during the fix; no change was needed and the audit's D-004 evidence is corrected accordingly. Desktop order, routes, and bookmarks unchanged. | interview + review |
| **UX14** | **Keyboard/AT equivalence declared.** `#map` gains `aria-describedby` pointing to a visually-hidden note naming the nodes table as the keyboard-accessible equivalent (markers stay pointer-driven — Leaflet focus retrofit rejected); tables/captions/scope per UX9. | interview |
| **UX15** | **Engineering bar (D9).** Every change ships with 100 % unit tests (JS `node:test`, RSpec), full JSDoc/RDoc, the exact Apache header, `rufo`-clean formatting; all existing suites stay green; view specs asserting moved markup are updated, not deleted. | CLAUDE.md |

---

## Bugfix: UX audit follow-up (design review remediation)

Remediates a Claude-Design review of the shipped UX-audit dashboard (8 numbered
fixes plus 4 smaller "also spotted" items), each traced to a concrete
`base.css` / `web/views/` / `assets/js/app/` cause. It is presentation-layer
only: no dependency, no egress, no `/api/*`, `/version`, or `data-app-config`
change, so **all four apex invariants and D7/D8 hold** by construction. Protocol
parity (Invariant IV) is preserved — FU3 keeps the MeshCore-diamond /
Meshtastic-circle distinction as differentiation, not privilege.

**Conflict check against existing decisions.** *UX7/D-013 (MeshCore square chip,
`2 × radius`)* — **amended** (FU3: equal-area rotated diamond at
`round(radius × 1.78)`; a raw `2r` square out-weighed the circle ~27 %). *UX7/
D-014 (legend dash sample `6 6`)* — **amended** (FU5: the 24 px **sample** uses
`6 2` so it inks both ends; the on-map traces stay `6 6`). *UX11/D-033 (chat
hang `8ch`)* — **amended** (FU1/FU9: hang is `19ch` — the real prefix width —
and inline badge/icon/reply descendants zero the inherited `text-indent`). *UX11/
D-029 (region toggle 🌐)* — **amended** (FU2: 🌍, greyscale-until-open). *UX12/
D-002 (join strip in the meta row with a `details` link)* — **amended** (FU4:
the strip moves to the footer beside the About link and the redundant `details`
link is dropped). *UX11/D-026 (meta day/week line)* — **extends** (FU4: the line
is unchanged; per-protocol counts are added to the two toggle buttons). *UX9/
D-006/D-007/D-017 (nodes table)* — **extends** (FU6 condenses row density, FU7
lists only reported fields in the disclosure row, FU10 pins both header rows).
*UX8 (legend defaults)* — **extends** (FU12: columns top-align; no default
change). *Footer slim variant* — **retired** (FU8). No invariant is contradicted.

| # | Decision | Source |
| --- | --- | --- |
| **FU1** | **Chat badge sits in its colour box.** `text-indent` is inherited, so the D-033 hang re-applied to the inline-block `.short-name` / `.protocol-icon` / `.chat-entry-reply` inside `.chat-entry-msg`/`-node`. A `:where(...) :where(...)` reset zeros it on those descendants at specificity 0. | review |
| **FU2** | **Region toggle reads as a place.** The glyph is 🌍 (was 🌐, a generic "web" mark); the button is greyscale/dimmed by default and returns to full colour + an accent frame on hover and `[aria-expanded="true"]` — the colour is the open-state feedback the toggle lacked. No JS change (`aria-expanded` already flips). | review |
| **FU3** | **MeshCore marker is an equal-area diamond (amends UX7/D-013).** The chip is sized `round(radius × 1.78)` (16 px at radius 9 ≈ the circle's `πr²`), rotated 45° and corner-rounded in `base.css`; the rotation is CSS-only so the divIcon box and anchor are unchanged and the container keeps `overflow: visible`. | review |
| **FU4** | **Join strip → footer; counts → toggles; `details` dropped (amends UX12/D-002, extends UX11/D-026).** The `.join-line` moves from the meta row to `_footer.erb` (rendered from the `Sanitizer` preset helpers, MeshCore entry only when both values are set). The two otherwise-unlabelled protocol toggles gain a per-protocol count span filled from the same 7-day figure as the legend column counts. The `details` link is removed — the footer's About link is beside the strip now. Every wire/JSON key is untouched (FS1/D8 hold). | review |
| **FU5** | **Legend dash sample inks both ends (amends UX7/D-014).** `legendLineSampleSvg('trace')` uses `stroke-dasharray="6 2"`, which tiles the 22 px sample exactly (6+2+6+2+6); the map traceroutes keep `6 6`. | review |
| **FU6** | **Condensed nodes table.** Row density is scoped to `#nodes` (`thead th` 5/8, `tbody td` 3/8 + `line-height 1.35`, group row 3/8), taking rows from ~30 px to ~20 px without shrinking the 12 px type; the waiting row keeps a roomy 12/8 via an id-scoped selector that outranks the tight rule. | review |
| **FU7** | **Disclosure row lists only reported fields (extends UX9).** `filterReportedFields` drops null/empty/em-dash fields but **keeps honest zeros** (a `0 %` util or `0 V` is a real reading — UX10 number-honesty); an all-absent set falls back to one muted "No additional fields reported." line. | review + interview |
| **FU8** | **Footer chrome on every route.** The transparent `.app-footer--slim` variant (and its full-screen padding reset) is deleted and the `slim` local dropped; the still-`position: fixed` footer now paints opaque with a lift shadow on Charts / Federation / `/pages/*` instead of floating over body copy. Geometry is unchanged (it was already fixed), so no content is newly occluded. | review |
| **FU9** | **Chat hang is the real prefix width (amends UX11/D-033).** The `[HH:MM:SS][freq][MF]` prefix is 19 characters, so the hanging indent is `19ch` — wrapped lines land under the message column instead of mid-timestamp. | review |
| **FU10** | **Both nodes-table header rows pin (extends UX9).** The group row becomes `position: sticky; top: 0` (was `static`) with a fixed 24 px border-box height; the column row pins at `top: 24px`, so the grouped header no longer scrolls away leaving the column row unbacked. | review |
| **FU11** | **Badge meets the 44 px touch floor.** On `pointer: coarse`, a transparent centred `::after` lifts the `.short-name[data-node-info]` hit box to 44 px without changing its look; fine pointers keep the tight target so dense chat lines do not cross-capture clicks. | review |
| **FU12** | **Legend columns share a top baseline (extends UX8).** `legend-column--bottom` is removed so the shorter MeshCore column top-aligns with Meshtastic; the two protocol titles sit on one line. | review |
| **FU13** | **Engineering bar (D9).** Every change ships with 100 % unit coverage on new/changed lines (JS `node:test`, RSpec), full JSDoc/RDoc, the exact Apache header, `rufo`-clean specs; all existing suites stay green; view/JS specs asserting moved markup are updated, not deleted. | CLAUDE.md |

---

## Bugfix: Post-deploy design review (detail view, footer, marker recency)

Answers four post-deploy asks against `992d6bb` (the deployed audit tree): three
real gaps the audit left behind and one feature with a trade-off. Presentation
layer only — no dependency, no egress, no `/api/*`, `/version`, or
`data-app-config` change, so **all four apex invariants and D7/D8 hold**.
Protocol parity (Invariant IV) is preserved: PD3 gives both protocols the same
freshness-pane treatment.

**Conflict check against existing decisions.** *UX9/D-007 (disclosure — mobile
loses nothing) and UX4/D-020 (muted dash)* — **extended to `/nodes/:id`** (PD1):
those were `#nodes`-scoped and never reached the detail table, which reused the
global `.nodes-col--*` hide rules and lost columns with no disclosure. *FU4/FU8
(static pages → footer)* — **regression fixed** (PD2): the enlarged
single-`inline-flex` links row wrapped and stranded a separator; the links become
their own tier and separators become dots. *`getRoleRenderPriority` render order
(role-major z-order; MeshCore "companion above infrastructure")* — **amended**
(PD3): **recency becomes the coarse stacking channel** and role the fine one, so
a live low-priority node now paints over a stale high-priority one — the map
answers "what is alive now", not "where is the infrastructure". The ladder is
**preserved but subordinated** to freshness (it still orders within a pane), and
the pre-existing protocol pane-split (every MeshCore chip painting over every
Meshtastic circle, because `divIcon`→`markerPane` sits above `circleMarker`→
`overlayPane`) narrows to within-a-bucket, since both marker types now share the
three freshness panes. *FU10 (sticky group-header `24px` offset)* — **hardened**
(PD4). No invariant is contradicted.

| # | Decision | Source |
| --- | --- | --- |
| **PD1** | **The `/nodes/:id` detail view is a spec sheet, not a table (extends UX9/UX4).** `single-node-table.js` renders a grouped `<dt>/<dd>` spec sheet (Activity · Health · Utilization · Environment · Position) reusing `.node-detail__row`; it carries **no** `.nodes-col--*` classes, so nothing is `display:none`'d on a single-record page and no disclosure column is needed; absent telemetry renders the muted `.cell-empty` dash (fixing the blank-cell half). It reflows to one column ≤ 659 px with no horizontal scroll. Identity and the long name live in the page header (`detail-html.js`) and are not repeated; the pointless self-link to the current page is dropped. The one-record table's whole cost (18 columns of horizontal scroll) bought nothing — a table compares rows, and there is one row. | review |
| **PD2** | **Footer is two intentional tiers with dot separators (fixes an FU4/FU8 regression).** `.footer-links` becomes its own tier (`flex-basis: 100%`) so the row can no longer strand the version→links separator on line one; every `.footer-separator` is `·` at `margin: 0 5px; color: var(--muted)` (a dot wants more air, less weight than an em dash); the chat label shortens to `chat:` (the instance name is already the title and logo). The `≤ 600px` stack rule is unchanged. | review |
| **PD3** | **Marker stacking: recency-major via three freshness panes (amends the role-priority z-order).** The map creates three Leaflet panes — `markers-stale` < `markers-today` < `markers-live` (ascending z-index) — and every marker, **circle and chip**, is assigned its `nodeAgeBucket` pane (`freshnessPaneForBucket`). Freshness is the coarse channel; the existing `getRoleRenderPriority` ladder still orders **within** a pane. A live Meshtastic circle now paints over a stale MeshCore chip. This **inverts** the old guarantee (a stale ROUTER drops below a live CLIENT, and MeshCore's "companion above infrastructure" holds only within a bucket) — the deliberate trade for a liveness dashboard; role keeps its own untouched colour/shape channel. It also **narrows** the pre-existing protocol pane-split (chips no longer unconditionally top circles — only within one bucket). No representation change, so `circleMarker` performance is kept. | interview + review |
| **PD4** | **Sticky group-header offset hardened (FU10).** The group row's `height: 24px` and the column row's `top: 24px` are a coupled pair; `white-space: nowrap` on `.nodes-group-header th` stops a longer label / translation / narrow tier from wrapping the group row and overlapping the two sticky rows. A comment names the coupling. | review |
| **PD5** | **Engineering bar (D9).** Each fix shipped with a fail-first check (Phase 2), 100 % coverage on new/changed lines, full JSDoc, the exact Apache header, `rufo`/`black`-clean; all prior suites stay green; specs asserting the old detail table / footer markup are updated, not deleted. | CLAUDE.md |

---

## Bugfix: Legend shape key & chat log overflow

Two deployed-CSS defects and one legend-key gap from a final frontend review.
Presentation layer only — no dependency, no egress, no `/api/*`, `/version`, or
`data-app-config` change; all four apex invariants and D7/D8 hold. Protocol
parity (Invariant IV) is preserved: the legend keys both protocols' shapes
equally.

**Conflict check.** *UX7 (marker shape channel; the neighbor/trace line key)* —
**extended** (LC1): the legend now also keys the role-swatch shape (circle vs
diamond), the channel the map used but the panel never keyed; the swatch is the
marker at legend size (same `nodeMarkerShapeForProtocol` mapping, same
`side = radius × 1.78` area rule, same ring + 3px corner). *Legend filter visual
feedback* — **fixed** (LC2): the pressed-state rule existed but a lower
specificity than the global button reset meant it never painted. *UX11/D-033
(chat hanging indent)* — **extended** (LC3): wrapped lines already hung at 19ch,
but unbreakable tokens were never broken, so the panel scrolled sideways;
`overflow-wrap: anywhere` on the same rule closes it. No invariant is
contradicted.

| # | Decision | Source |
| --- | --- | --- |
| **LC1** | **Legend swatches key the marker shape (extends UX7).** `buildRoleButtons` stamps each swatch `legend-swatch--diamond` (MeshCore) or `legend-swatch--circle` (Meshtastic) from `nodeMarkerShapeForProtocol` — one source of truth with the map. `base.css` renders the circle at 12px and the diamond as an equal-area 11px square rotated 45° (the map's `side = radius × 1.78`) with the chip's 3px corners, both carrying the marker's `1px rgba(0,0,0,.7)` ring, in a 16px slot so the diagonal never clips the label. The swatch is the marker at legend size, not a second drawing of it. Freshness (opacity) is deliberately **not** keyed (the recommended shapes-only option). | review |
| **LC2** | **Legend pressed state paints (specificity fix).** A role chip is a `<button>`; the reset `button:not(.chat-tab):not(.sort-button)` (0,2,1) outranked the bare `.legend-item[aria-pressed="true"]` (0,2,0), so every chip computed to `#333` and only `font-weight` distinguished selected from filtered. The selector is now `button.legend-item[aria-pressed="true"]` (0,2,1), which wins on source order — the selected blue paints. | review |
| **LC3** | **Chat log never scrolls horizontally (extends UX11/D-033).** `.chat-tabpanel` is `overflow-y: auto`, so its x-axis is a scroll container; nothing broke long tokens. `overflow-wrap: anywhere` on `.chat-entry-msg, .chat-entry-node` wraps unbreakable tokens under the 19ch hang and lowers the entry's min-content width so it can never exceed the panel. `anywhere`, not `break-word`; no `overflow-x: hidden` (which would only mask the next regression). | review |
| **LC4** | **Engineering bar (D9).** Each fix shipped with a fail-first check (Phase 2), full JSDoc/comments, the exact Apache header, clean linters; all prior suites stay green; the `buildRoleButtons` filter specs gain the swatch-shape assertion, none removed. | CLAUDE.md |

---

## Feature: Mesh activity reporting & announcements

Turns each ingestor from a pure listener into a reporter **and** an announcer.
(1) **Reporting:** every ingestor counts *every* frame it handles — all received
frames (including ignored / errored / unimplemented) plus its own transmissions —
as one merged `packets` figure and appends the per-interval delta to its hourly
`POST /api/ingestors` heartbeat; the web app persists a per-ingestor activity
time-series so a **packets/hour moving average** is computable across
time × protocol × multiple ingestors. (2) **Announcing** ("we stop listening and
start talking"): each ingestor periodically broadcasts a one-line activity summary
on its protocol's default channel, drawing the numbers **back from the target
instance's own API** (dogfeeding, so one radio's partial view never
under-represents the mesh). Integrates with
`data/mesh_ingestor/handlers/_state.py` (RX/TX counting seam), `ingestors.py`
(heartbeat payload), `config.py` + `tx_policy.py` (the `TX_ENABLED` /
`TX_ANNOUNCE` transmit policy), `daemon.py`
(announce schedule), `mesh_protocol.py` + `protocols/{meshtastic,meshcore,meshtastic_udp}`
(optional send), a new announce + instance-stats-GET module, `data/ingestors.sql`
plus a new `data/ingestor_activity.sql` table,
`web/lib/potato_mesh/application/routes/{ingest,api}.rb`, the query + retention
layers, and `data/mesh_ingestor/CONTRACTS.md`.

**Conflict check against existing decisions.** *Invariant I (apex / local-LoRa)*
— **consistent, extends §4.2**: the announcement is a LoRa transmission on the
local aether and the dogfeed is an HTTP GET to the ingestor's *own* instance; no
MQTT/broker/cloud dependency or connection is added (A1 stays clean), and ingestor
TX already exists (`RX_ONLY`, MeshCore telemetry polls), so this widens an existing
capability rather than crossing the apex line. *Invariant II (privacy)* —
**extends**: a new gate suppresses the announcement unless the target instance
reports non-private, read authoritatively from its `/version` and **fail-closed**
on any fetch error; only public aggregates (active nodes, packet rate) are ever
announced. *Invariant III (federation) & §5 (no analytics / phone-home)* —
**consistent, new authorized behavior**: the announcement publishes an *unsigned
public activity line on the community's local mesh* — not the signed federation
wire, not cloud egress, not third-party analytics — and is **opt-in**, requiring
both `TX_ENABLED=1` and `TX_ANNOUNCE=1` (MA7). Unsolicited transmission on a
shared human channel is authorized here only as an operator-chosen behavior,
never as a default: consent to *deploy an ingestor* is not consent to *speak on
the community's channel* (Invariant II). *Invariant IV (parity & pluggability)* — **extends**: sending is an
*optional, duck-typed* provider capability, not a new formal `MeshProtocol` member,
so the `A4b` conformance contract and every existing provider are untouched; both
protocols announce identically. *D8 (stable contract)* — **extends**: the heartbeat
`packets` field, the `/api/stats` `<scope>.packets.hour` metric, and the activity table
are all additive; no version bump. *§3.3 (web is POST-only intake)* —
**consistent**: the dogfeed is a read; no new ingest path. No invariant is
contradicted.

| # | Decision | Source |
| --- | --- | --- |
| **MA1** | **Merged packet counter — count everything, at the earliest seam.** Each ingestor maintains one merged `packets` counter incremented on **every received frame** — *all of them, including ignored / errored / unimplemented / unsupported-port packets* — counted at the earliest common receive seam (`handlers/_state._mark_packet_seen`, already invoked by both the Meshtastic `on_receive` path and every MeshCore handler/telemetry path *before* any dispatch or filtering), **plus every ingestor-initiated transmission** (the announcement itself and the existing MeshCore telemetry/status polls). RX and TX are deliberately **merged** into a single figure (no separate breakdown). "We don't want to under-report" is satisfied at source: counting precedes every drop/ignore decision. A build-phase check confirms each protocol's RX entry funnels through the seam so no family is missed. | interview |
| **MA2** | **Heartbeat carries the per-interval delta.** `POST /api/ingestors` gains an additive optional `packets` field = frames counted since the previous heartbeat (a per-interval **delta**, not a since-boot cumulative), reset to zero each time a heartbeat is queued. Per-interval deltas map one-to-one onto time-series rows and are restart-safe (a reboot simply starts a fresh interval). Absent ⇒ treated as `0`, so pre-feature ingestors and the existing `tests/test_mesh.py` fixtures are unaffected (D8). | interview |
| **MA3** | **Per-ingestor activity time-series (the moving-average schema).** A new append-only table `ingestor_activity` (`ingestor_id TEXT`, `at INTEGER`, `packets INTEGER`, `protocol TEXT`, indexed on `at`) records one row per heartbeat delta. This is the schema that makes a packets/hour moving average computable while distinguishing **multiple protocols and multiple ingestors per protocol** (each ingestor's contribution is kept separate rather than pre-summed). The `ingestors` snapshot table (one row per node) is unchanged. Rows are pruned by the existing retention worker (window ≥ the 24 h the announcement needs; sized with the other activity floors). | proposed |
| **MA4** | **Aggregation = MAX per protocol; `total` = SUM across protocols (dedup-free "in the air").** The mesh-wide packets/hour for a protocol is `MAX` over that protocol's ingestors of *(that ingestor's total `packets` reported in the last 24 h ÷ 24)*. A single radio can only hear ≤ what is actually transmitted, so the busiest single vantage is the best dedup-free estimate of unique air traffic and can never double-count a frame heard by two radios (true per-frame dedup is impossible anyway — ignored/errored frames carry no id). The **`total`** rate is the **SUM** of the per-protocol rates — different protocols ride different frequencies/channels, so their frames never overlap in the air and add rather than dedup. **Amended pre-release:** `total` first shipped as a MAX over *every* ingestor regardless of protocol, which under-counted it to the single busiest protocol (e.g. meshcore 44 + meshtastic 76 rendered as 76, not 120); corrected to the cross-protocol SUM. The fixed `÷ 24` denominator (not ÷ elapsed) keeps the rate stable and avoids divide-by-small spikes; an ingestor with < 24 h of data simply reads lower and ramps up (moot in practice — the announcement fires only ≥ 24 h after start, MA7). *Accepted limitation:* the per-protocol MAX under-estimates the true union when different radios are busiest in different hours. | interview |
| **MA5** | **Exposure as an additive per-scope `packets` metric.** `GET /api/stats` exposes the MA4 24 h MAX-aggregated moving average under each scope as `<scope>.packets.hour` — a `packets` metric carrying a single `hour` window (it is a rate, not a windowed count, so no day/week/month keys), consistent with the S1 `scope → metric → window` layout. `reticulum.packets.hour` shipped as a forward-looking `0` stub and is **live** since the Reticulum ingestor landed (the S6 amendment), computed like its siblings; `total.packets.hour` is the **SUM** of the per-protocol rates (MA4). The rest of the S1 tree is untouched, so this needs **no** version bump. The announcement's active-node figure reuses the existing `<protocol>.nodes.day` count (already deduped by `node_id`); only packets/hour is new. **Amended pre-release:** the field originally shipped (unreleased, on `main`) as a top-level `packets_per_hour: { total, meshcore, meshtastic, reticulum }` map; it is superseded here by the per-scope `packets.hour` form for consistency with the S1 tree. Because it was merged but **not yet in any tagged release** and is **not** on the signed federation wire, the reshape carries **no** version bump, federation-compat fallback, or signature break — only the in-repo `announce.py` dogfeed reader (MA6) and the specs/docs move with it. | proposed (amended) |
| **MA6** | **Announcement content, drawn from the instance's own API (dogfeeding).** Each ingestor broadcasts, for its own configured protocol, a single line formatted to that protocol's character limit: `"<Protocol> activity in the last 24h: <N> active nodes, <M> packets/hour. https://<domain>"`. `<N>` and `<M>` are fetched **from the target instance** (`GET /api/stats` → `<protocol>.nodes.day` and `<protocol>.packets.hour`), never computed from the ingestor's local view — because one ingestor may not see the whole mesh. `<domain>` is the configured `INSTANCE_DOMAIN`. Reporting (MA1–MA4) is independent and continues regardless of announcement state. | interview |
| **MA7** | **Announcement is quadruple-gated, behind a default-off transmit policy.** An announcement is transmitted only when **all** hold: (a) **`TX_ENABLED=1`** — the master switch for *every* ingestor-initiated mesh transmission (the announcement and the MeshCore on-air telemetry polls alike), **default `0`**; (b) **`TX_ANNOUNCE=1`** — a second, narrower opt-in for the announcement specifically, **default `0`**, because unsolicited traffic on a shared human channel is a distinct decision from polling a node for its battery level; (c) **≥ 24 h have elapsed since ingestor start** — so the first numbers are accurate over a full window and restarts cannot spam the channel; (d) the target instance reports **non-private** — the ingestor GETs `<domain>/version` and honors `config.private_mode`, re-checked every cycle, and **fails closed** (skips) on any fetch/parse error, so a privacy signal is never missed (Invariant II). The legacy **`RX_ONLY=1`** remains supported as a **veto** over (a) — a kill switch an operator deliberately engaged is never silently overridden — but is retired from operator-facing documentation, since leaving `TX_ENABLED` unset now expresses the same intent by default. **Amended twice.** MA7 originally made `RX_ONLY` the *single* transmit gate with no separate enable env, leaving the announcement **on by default**; in the field that made every stock ingestor start talking on its community's default channel without its operator having chosen to. It was then reversed to an `ANNOUNCE=1` opt-in — but that left the wider hole unaddressed: MeshCore telemetry polling still transmitted by default, and `RX_ONLY`, the only switch that stopped it, was parsed as an exact `== "1"` string comparison, so `RX_ONLY=true` **failed open** and transmitted anyway. This amendment inverts the whole axis: transmission is off unless asked for, the policy has one representation (`tx_policy.py`) consulted at every transmit site, and every flag parses fail-safe toward silence. | interview (amended ×2) |
| **MA8** | **Default channel/scope + 24 h cadence.** The announcement is broadcast on the protocol's **default channel and scope** — Meshtastic channel `CHANNEL_INDEX` (default `0`) via the interface text-send; MeshCore its public/default channel — honoring existing `ALLOWED_CHANNELS`/`HIDDEN_CHANNELS` intent. After the initial ≥ 24 h wait it repeats **every 24 h**, per configured instance domain (an ingestor with several `INSTANCE_DOMAIN` targets announces each with its own numbers and link). TX volume is negligible (~1 frame/day/domain). | proposed |
| **MA9** | **Optional duck-typed provider send.** Transmission is exposed as a new **optional** provider method (e.g. `send_channel_announcement(iface, text)`) accessed via `getattr(provider, …, None)` — mirroring the existing optional `self_node_item` extension — so the `@runtime_checkable MeshProtocol` interface and its `A4b` isinstance conformance are unchanged, and a provider that cannot transmit (or a receive-only transport) simply omits it. Both `meshtastic` and `meshcore` providers implement it; neither protocol is privileged. | interview |
| **MA10** | **Engineering bar (D9).** Every new/changed unit ships with 100 % unit tests (counter increment across RX families + TX; heartbeat delta + reset; activity-table write + retention; MAX-aggregation math incl. multi-ingestor; the `/api/stats` field; the four announcement gates (`TX_ENABLED`, `TX_ANNOUNCE`, the 24 h wait, fail-closed privacy) plus the `RX_ONLY` veto, the fail-safe env parsing of each flag, and their delivery through every packaged deployment surface; per-protocol send), full PDoc/RDoc, Apache headers, `black`/`rufo` clean; `pytest`/`rspec`/`npm test` stay green; `CONTRACTS.md` documents the additive heartbeat field, the activity schema, and the `/api/stats` addition. | CLAUDE.md |

---

## Feature: Mesh activity map card (frontend)

Surfaces the MA5 `<scope>.packets.hour` rate on the dashboard as a "Mesh
activity" card in the map's bottom-left corner (the recommended treatment from
the imported Claude-Design review, option 1a). Frontend/read-side only:
integrates with `web/public/assets/js/app/stats.js` (parses the new `packets`
rates), a new `web/public/assets/js/app/map-activity-card.js` module, the map
setup + stats callback in `web/public/assets/js/app/main.js`, and
`web/public/assets/styles/base.css`. Consumes the existing `GET /api/stats` with
**no** API/DB/ingestor change.

**Conflict check against existing decisions.** *Invariant I (apex)* —
**consistent**: a read-side consumer of the existing local API; no broker,
dependency, or egress. *Invariant II (privacy)* — **consistent**: packets are a
public aggregate (no message content), already un-gated by `PRIVATE` (MA5); the
card shows only rates the API already returns. *Invariant IV (parity)* —
**extends**: both protocols render identically and either can be toggled; neither
is privileged. *D8 (contract) / §3.3 (POST-only intake)* — **consistent**: no new
endpoint or shape; the card reads `<scope>.packets.hour` as it ships. *AV3
(cache-busting)* — **consistent**: the new module self-registers in the automatic
import map. No invariant is contradicted.

| # | Decision | Source |
| --- | --- | --- |
| **MA-F1** | **Placement & source.** A "Mesh activity" card renders as a Leaflet control at the map's **bottom-left** (mirroring the roles legend bottom-right) on the dashboard and `/map`. Its figures come from `GET /api/stats` `<scope>.packets.hour` (parsed by `stats.js` into `stats.packets = { total, meshcore, meshtastic }`); on a stats-fetch failure the local-count fallback carries no packets, so the card simply hides. Recommended design option 1a / treatment A ("Signal card"). | interview + design |
| **MA-F2** | **Content.** A pulsing live-dot + "Mesh activity" label; the big tabular **total** packets/h; the placeholder sparkline (MA-F5); and one row per protocol (Meshtastic, then MeshCore, then Reticulum) carrying the protocol icon, label, a share-bar sized to the busiest visible protocol, and the tabular rate. **Amended with the Reticulum ingestor** (the S6 amendment): `reticulum` was originally never rendered while it was a zero stub; the card now renders a Reticulum row identically to the other two, and the card's existing zero-state rule already keeps an idle protocol row honest. | design (amended) |
| **MA-F3** | **Zero-state unmount.** The card is hidden entirely (`.map-activity-card--hidden`, `hidden`, emptied) whenever the visible total is `0` or the payload carries no packet rates — the map's one free corner is never occupied by an empty card. | interview + design |
| **MA-F4** | **Toggle-reactive rebasing (Invariant IV parity).** A protocol hidden via the meta-row protocol toggle (the existing `hiddenProtocols` set) drops its row and rebases the displayed total to the **sum of the visible** protocol rates — the same treatment for both protocols, identical to how the node counts already rebase. Toggling re-runs `applyFilter`, which re-renders the card; hiding **all** protocols unmounts it. | interview + code |
| **MA-F5** | **Sparkline (superseded by F2-4).** As first shipped in F1 the 24-hour sparkline was a **deterministic placeholder** (`data-placeholder="true"`), never claiming to be live. **Superseded by F2-4:** it now renders the real 24 h `total` series from `GET /api/stats/activity`, and is simply **omitted** when that series is unavailable — the card never shows a fake curve. | interview |
| **MA-F6** | **Engineering bar (D9) & scope.** Frontend/read-side only — no API/DB/ingestor change (D8, §3.3), apex (I) untouched. The DOM-building logic lives in `map-activity-card.js` at **100 % unit coverage** (JSDoc, Apache header); `main.js` holds only the Leaflet-control wiring + the one render call in the stats callback (integration-only, matching the sibling legend control). The module self-registers in the cache-busting import map (AV3). `npm test` stays green; no Ruby/Python change. | CLAUDE.md |

---

## Feature: Mesh activity time-series (F2)

Adds a bucketed packets/hour time-series over `ingestor_activity` so the map
card's 24 h sparkline (MA-F5) and a protocol-aware `/charts` figure render on
real history instead of a placeholder. Backend: `GET /api/stats/activity` +
`query_activity_buckets` (`web/lib/potato_mesh/application/queries/ingestor_queries.rb`)
+ the route in `application/routes/api.rb`. Frontend: `map-activity-card.js`
(real sparkline) and `charts-page.js` + `views/charts.erb` (the new figure).
Read-side, additive; no ingest or DB-schema change.

**Conflict check.** *Apex I / §3.3* — **consistent**: a read of the existing
local DB; no broker, egress, or ingest path. *Privacy II* — **consistent**:
packets are a public aggregate (no message content), un-gated like MA5. *Parity
IV* — **extends**: the series and the chart are per-protocol and equal, and the
`/charts` intro stops naming a single protocol. *D8* — **extends**: a new
additive endpoint (snake_case params, no version bump); the camelCase
`/aggregated` params remain BP9's separate migration. No invariant is
contradicted.

| # | Decision | Source |
| --- | --- | --- |
| **F2-1** | **New `GET /api/stats/activity`.** Bucketed packets/hour series over `ingestor_activity`, mirroring `/api/telemetry/aggregated` (window clamped to the 28-day floor, bucket count capped at `MAX_QUERY_LIMIT`, `ApiCache`), but with **snake_case** `window_seconds`/`bucket_seconds` params — the API norm. Returns `[{ bucket_start, bucket_end, total, meshcore, meshtastic }, …]` ascending. The lone camelCase params on `/aggregated` stay the tracked BP9 migration, not folded in here. | interview |
| **F2-2** | **Per-bucket aggregation mirrors MA4.** Within each bucket, per protocol = **MAX** over that protocol's ingestors of their summed packets; `total` = **SUM** across protocols; each ÷ (`bucket_seconds`/3600) to a packets/hour rate. **Amended with the Reticulum ingestor** (the S6 amendment): `reticulum` originally folded into `total` without a series key of its own; each bucket now emits a live `reticulum` key alongside `meshcore` and `meshtastic` (consistent with `query_packets_per_hour`, whose reticulum rate went live at the same time). | interview + code (amended) |
| **F2-3** | **No new retention.** `ingestor_activity` is already retained a year; the 28-day API clamp is the only ceiling. The card requests **24 h / 1 h** buckets, the `/charts` figure **7 d / 2 h**. | code |
| **F2-4** | **Card real sparkline.** The MA-F5 placeholder is replaced by the real 24 h series from `/api/stats/activity`, fetched on a slower cadence with its own short cache (the trend moves slowly — not every refresh). On fetch failure the sparkline is omitted but the live total/rows (from `/api/stats`) still render — the card never regresses to a fake curve. | interview |
| **F2-5** | **Charts page — protocol-aware, all-protocol.** A "Mesh activity" figure (packets/h per protocol, 7 d) is added to `/charts` **between** the channel-utilization and environmental figures. The intro no longer names "Meshtastic": the aggregated telemetry (`query_telemetry_buckets`) already carries **all** protocols (MeshCore telemetry included since the telemetry pull shipped) — the prior wording mislabelled all-protocol data. Invariant IV. | interview |
| **F2-6** | **Engineering bar (D9).** 100 % unit tests (rspec for `query_activity_buckets` + the route; node --test for the card sparkline + charts figure), full RDoc/JSDoc, Apache headers, `rufo`/`black` clean; `CONTRACTS.md` documents the new endpoint; all suites stay green. | CLAUDE.md |

---

## Bugfix: Neighbor/trace legend toggles highlight when visible

The neighbor-line and trace-line legend toggles set `aria-pressed="true"` when their
lines were **hidden**, so `button.legend-item[aria-pressed="true"]` (the selected/
highlighted style, LC2) painted them highlighted while the lines were off — reversed
relative to the role chips, which highlight when a role is **visible**. Fixed in
`web/public/assets/js/app/main.js` (`updateNeighborLinesToggleState` /
`updateTraceLinesToggleState`). Presentation-only; no data/API change.

| # | Decision | Source |
| --- | --- | --- |
| **NT1** | The neighbor/trace line toggles set `aria-pressed="true"` when their lines are **visible** (highlighted = shown), consistent with the role chips (LC2) and the meta-row protocol toggles; previously reversed (pressed when hidden). Presentation-only, no data/API change. | review |

---

## Bugfix: Mesh activity design-review remediation

A Claude-Design review of the shipped F1/F2 work against the 1a/1c/1d design. The
card, the real-data sparkline, and the toggle rebasing all matched or bettered the
design; this section remediates the one regression and the mobile/charts
divergences it found. Presentation + read-side only; no API/DB change.
**Conflict check:** **fixes** an MA-F3 regression and **extends** MA-F4/MA-F5/F2-4
(the sparkline now rebases with the toggles); consistent with all invariants.

| # | Decision | Source |
| --- | --- | --- |
| **MR1** | **Idle card stays hidden on mobile (MA-F3 regression fix).** The mobile media query set `.map-activity-card { display: flex }`, which outranked `.map-activity-card--hidden { display: none }` (equal specificity, later rule) and the `[hidden]` attribute, so an idle card painted an empty pill over the map. `.map-activity-card--hidden { display: none }` is re-declared inside the media query. | review |
| **MR2** | **Mobile strip is a full-width caption (design 1d).** Below the mobile breakpoint the bottom-left Leaflet control spans the map (`left: 0; right: 0`, 8px inset) at ≥ 32px tall with the protocol split pushed to the far edge (`margin-left: auto`), so it reads as a map caption rather than a content-width corner pill. | review |
| **MR3** | **Mobile breakpoint aligned to the app band.** The strip triggers at ≤ 659px (the app's mobile band, UX9), not a one-off 640px. | review |
| **MR4** | **Sparkline headroom.** `sparklinePathsFromSeries` scales to `max × 1.15`, so the busiest hour's vertex sits below the box edge and the 1.5px stroke is never clipped. | review |
| **MR5** | **Sparkline rebases with the toggles.** The curve is the sum of the **visible** protocols per bucket (from `/api/stats/activity`'s per-protocol fields), so it agrees with the headline total once a protocol is toggled off — previously the number rebased but the curve stayed all-protocol. Extends MA-F4 / F2-4. | review |
| **MR6** | **Card is a labelled `group`.** The card root carries `role="group"` so its `aria-label` is announced (a bare div's is not); children stay readable, unlike `role="img"`. | review |
| **MR7** | **`/charts` intro is protocol-neutral.** The all-protocol "Network telemetry trends" heading no longer carries the single Meshtastic badge (`charts.erb`), matching the de-scoped copy (F2-5). | review |
| **MR8** | **Utilization second-axis (design 1c) explicitly out of scope.** The packets/h right-hand axis overlay on the channel-utilization chart was **not** built — the standalone "Mesh activity" figure (F2-5) is the shipped scope; recorded so the design is not re-litigated. | review |

---

## Bugfix: MeshCore RX packet undercount & position radio metadata

Two MeshCore ingestor defects where the ingestor under-reports data it already
holds. **(a)** The packet counter drastically under-counts MeshCore RF traffic:
`on_rx_log_data` (`protocols/meshcore/handlers.py`) counted only `ADVERT`
RX-log frames and dropped every other received frame (`REQ`, `RESPONSE`,
`GRP_TXT`, `TEXT_MSG`, `ANON_REQ`, `PATH`, `ACK`, …) to the `DEBUG`-only capture
via an early `return` that never reached the counting seam — violating **MA1**
("count *every* received frame, including ignored / errored / unimplemented").
Field evidence: 31 171 uncounted non-`ADVERT` RX-log frames over ~3 days on one
node. **(b)** MeshCore position POSTs omit `lora_freq`/`modem_preset`: the
protocol-specific builder (`protocols/meshcore/position.py`) posts directly and
never called `_apply_radio_metadata`, so every `/api/positions` row landed with
nil radio config (empirically 0 of 3 278) even though the ingestor had captured
those values at `SELF_INFO` — unlike MeshCore message and node POSTs, which are
enriched.

**Conflict check.** *MA1 (count everything at the earliest seam)* — **fixes**:
(a) restores the invariant for the MeshCore RX-log family that was silently
dropped; the corrected mechanism (**PC2**) refines MA1's "every MeshCore
handler" phrasing to the RX-log seam without changing the goal. *RF3 (only
`ADVERT` RX-log frames upsert nodes)* — **preserved**: non-`ADVERT` frames still
never upsert and stay in the `DEBUG`-only capture (PC2 only adds *counting*, not
storing). *MA4 (MAX-per-protocol aggregation)* — **untouched**: only the
per-ingestor RX count changes. *Invariants I/II (apex/privacy)* —
**consistent**: no broker/egress, no new on-disk retention; radio metadata is
already carried on other MeshCore records. *Invariant IV (parity)* —
**consistent**: Meshtastic already counts every frame at `on_receive` and its
positions already carry radio metadata; this brings MeshCore to parity.

| # | Decision | Source |
| --- | --- | --- |
| **PC1** | **Root cause = an early `return` before the counting seam (implementation defect, MA1 right).** Non-`ADVERT` `RX_LOG_DATA` frames were routed to `_record_meshcore_message` and returned *before* any `_mark_packet_seen`, so they were never counted. MA1's own "a build-phase check confirms each protocol's RX entry funnels through the seam" did not catch this family. | interview + code |
| **PC2** | **Model A — count at the `RX_LOG_DATA` seam; decoded events are clock-only.** The MeshCore firmware emits exactly one `RX_LOG_DATA` frame per received over-air frame (the complete per-frame ground truth of "what is in the air"), while the decoded high-level events (`CHANNEL_MSG_RECV`, `CONTACT_MSG_RECV`, bare `ADVERTISEMENT`, `NEW_CONTACT`/`NEXT_CONTACT`, remote telemetry/status responses) are duplicates of those same frames (the `decrypt_channels` RX-log join, **RF2**, confirms both events fire for one frame). So MeshCore counts **every** frame **once** at `on_rx_log_data` — before the `ADVERT`/non-`ADVERT` split, the malformed-advert skip, and the DEBUG-capture drop — and the decoded seams advance the reconnect clock only. This eliminates both the undercount (all frame types now count) and any double-count (decoded duplicates do not re-count). | interview (Model A) |
| **PC3** | **Reconnect clock decoupled from the counter (`_mark_packet_activity`).** `_mark_packet_seen` previously did two jobs — advance `_last_packet_monotonic` (the inactivity-reconnect clock, `daemon._check_inactivity_reconnect`) *and* count. A new `handlers/_state._mark_packet_activity` does the clock update alone; `_mark_packet_seen` = `_mark_packet_activity` + `activity.record_packet`. Every MeshCore seam that stops counting still calls `_mark_packet_activity`, so its **reconnect timing is unchanged** — only the counter is deduplicated. Companion-link reads (`SELF_INFO`, `CONTACTS`, host self-telemetry) are clock-only too: they are not over-air traffic. *One deliberate, benign effect:* non-`ADVERT` RX-log frames now advance the clock as well (the old early `return` skipped both the count **and** the clock), so inactivity-reconnect fires marginally *less* eagerly — overheard RF traffic is proof the link is alive, so this is strictly more correct, not a regression. | code |
| **PC4** | **Accepted caveat: firmware without RX logging.** Because RX counting now flows solely through `RX_LOG_DATA`, a MeshCore build that does not push RX-log frames counts ~0 RX (TX still counts). Companion firmware ≥ 1.16 pushes RX-log frames unconditionally while a client is connected (**RF3**), which is the supported target, so this is the deliberate, documented cost of an accurate per-frame count over a partial-but-firmware-robust estimate. | interview + code |
| **PC5** | **MeshCore position POSTs carry captured radio metadata.** `_store_meshcore_position` applies `_apply_radio_metadata` before posting, adding `lora_freq`/`modem_preset` from the values captured at `SELF_INFO` (absent ⇒ omitted, never nil-stamped), matching MeshCore message/node POSTs and the Meshtastic position path. An audit of every `_queue_post_json` builder confirmed positions were the **only** omission; no web-side fallback is added (the ingestor is the source of truth). | interview + code |

---

## Bugfix: Canonical node-id lookups (bridge bang-stripping, digit-only refs)

Live failure (2026-07-27): the Matrix bridge requested node lookups with the
canonical id's `!` stripped, and `GET /api/nodes/:id` resolves a bang-less
digit-only ref exclusively as a Meshtastic node **num** — so a message from
`!27336717` (an 8-hex id composed entirely of decimal digits, ~2.3% of the id
space) failed its node lookup five polls in a row and was dropped by the
poison tracker, while `/api/nodes` listed the node and `/api/nodes/!27336717`
returned 200. **Conflict check:** **extends** D8 (the `!%08x` id is canonical
system-wide — the bridge must not transform it on the wire) and D8's
backward-compatible evolution rule (the route fallback is additive: every
currently-resolving ref resolves identically); consistent with all four
invariants (read-side only, no new egress, protocol-neutral — the ambiguity
hits Meshtastic and MeshCore ids alike).

| # | Decision | Source |
| --- | --- | --- |
| **NL1** | **The bridge requests nodes by the full canonical id** — `/api/nodes/%21<hex>` (the URL-encoded `!%08x` form), never the bare hex. Root-cause fix on the consumer side per D8; effective against current production servers without any web deploy. | interview |
| **NL2** | **`GET /api/nodes/:id` gains a hex-id fallback for digit-only refs.** A bang-less ref matching `\A[0-9]{8}\z` keeps its existing num-first resolution; only when the num interpretation matches nothing is it retried once as the canonical `!<8-digit-hex>` id. Deterministic precedence (a genuine num match always wins), additive (no currently-resolving ref changes meaning), and scoped to the per-id nodes route only — bulk/query-param refs are untouched. Hardens the API for any bang-stripping client beyond the bridge. | interview |

---

## Feature: Meshtastic waypoints (first-class POI layer, issue #848)

Meshtastic `WAYPOINT_APP` broadcasts — community points of interest with a
name, description, icon glyph, coordinates, optional expiry, and optional
lock-to node — are currently dropped unhandled by the ingestor. This feature
makes them a first-class stored collection: ingested from the radio, POSTed to
the web app, persisted in SQLite, served by an additive `GET /api/waypoints`,
and rendered per the confirmed design (claude.ai/design project
`PotatoMesh Waypoints.dc.html`, screens 1a/1b) on both maps, the Log tab, and
the map legend. **Variant selection (re-rolled with explicit per-variant
sign-off): 1c-B teardrop-pin marker, 1d-C minimal detail card, 1e-A legend
toggle in the Meshtastic column** — superseding the initially assumed
1c-A/1d-A defaults; the 1d-C choice moves the card's omitted fields onto the
node page (**W11**, amending W10). Integrates
with `data/mesh_ingestor/handlers/` (new waypoint handler + dispatch),
`events.py`, `CONTRACTS.md`, web `routes/ingest.rb` + `routes/api.rb` + a
waypoint queries module + schema migration, `application/pubsub.rb`,
`stats`/`node_queries` (telemetry umbrella), and on the frontend `main.js`
(map layer + legend), the data-fetcher/cache/merge modules, the chat-log
renderer, and `base.css`.

**Conflict check against existing decisions.** *Apex I (local LoRa)* —
**consistent**: waypoints arrive only from radios through the existing
ingestor → authenticated `POST` path; no broker, no new dependency, no new
egress (the map layer reuses the SB1 basemap stack unchanged). *Invariant II
(privacy)* — **extends**: waypoints carry user-authored text and are gated at
**message grade** (stricter than today's telemetry treatment): `PRIVATE=1`
404s the routes and suppresses their SSE events, mirroring A2a/PS6; the
author's opt-out marker excludes their waypoints everywhere. *Invariant III
(federation)* — **consistent**: no federation-wire change. *Invariant IV
(parity)* — **extends**: the wire contract and collection are protocol-neutral
(protocol-stamped rows; any protocol may feed them — the mirror image of
MeshCore-only adverts, A4e); Meshtastic is simply today's only emitter, and
the legend toggle sits in the Meshtastic column exactly as the existing
neighbor/trace line toggles already do (`main.js` `meshtasticCol`). *§3.3 /
D8 (contract)* — **extends**: additive snake_case routes following every
established convention (C1 bearer auth, IC-A3 201, IC-A4 payload validation,
C3 canonical ids, C4 window floors, BP1-style `?before=` cursor from day one);
no existing shape changes, no version break. *S3 (/api/stats telemetry
umbrella)* — **explicitly amended by W9** (waypoints join the umbrella).
*PS3/PS4/PS6 (SSE)* — **extends**: `waypoints` becomes the seventh
collection. *FC1/FC3 (frontend cache)* — **extends**: new collection at the
7 d / 7 d message-grade tier. *LV7 (Log tab)* — **explicitly amended by W7**
(one new entry class; bodies still never reach the Log). *VF3 (flash scope)*
— **extends**: waypoints join neighbors/traces in the documented
"updates silently" boundary. No decision is contradicted.

| # | Decision | Source |
| --- | --- | --- |
| **W1** | **First-class waypoint collection (the goal).** `WAYPOINT_APP` packets become a stored, protocol-stamped `waypoints` collection: ingested by the Python ingestor, POSTed via `POST /api/waypoints`, persisted in SQLite (system of record, §3.3), served by `GET /api/waypoints`, and rendered as a map layer on the dashboard and `/map` with a detail overlay, Log-tab entries, and a legend toggle — design screens 1a/1b, variants 1c-A / 1d-A / 1e-A. Stored fields: waypoint `id`, `name`, `description`, `icon` (unicode codepoint, rendered as the marker glyph), `latitude`/`longitude`, `expire` (unix, 0/absent = never), `locked_to` (canonical node id or null), author node id/num, `rx_time` + snapshot/radio metadata, `protocol`. | interview |
| **W2** | **Protocol-neutral contract; Meshtastic is today's only emitter (Invariant IV).** The `waypoints` event shape in `CONTRACTS.md` carries the standard protocol stamp and canonical `!%08x` ids; any future protocol may feed the same collection (parallel: MeshCore-only adverts, A4e). The legend toggle lives in the Meshtastic column (1e-A) because only Meshtastic populates the layer today — the same column that already hosts the neighbor/trace line toggles; nothing in the data model, API, or storage privileges a protocol. | interview |
| **W3** | **Message-grade privacy (Invariant II).** Waypoint `name`/`description` are user-authored content, so waypoints are gated like messages: under `PRIVATE=1`, `GET /api/waypoints` (and every waypoint read surface) returns **404**, no `waypoints` SSE events are emitted (mirrors A2a + PS6), and the frontend renders no waypoint UI; `POST` ingest still 401s/succeeds per C1 (data may be collected, never exposed). The author's node opt-out marker excludes their waypoints from every read surface via the existing opt-out filters (S5 pattern). FC4 already disables + wipes the browser cache in private mode, covering the client side. | interview |
| **W4** | **Additive API per established conventions (D8).** `POST /api/waypoints`: bearer auth (C1), `201 Created` (IC-A3), top-level Array/Hash validation (IC-A4), snake_case fields, canonical `!%08x` author/`locked_to` ids (C3). `GET /api/waypoints`: snake_case rows, server-side 7-day rolling-window floor on `rx_time` that callers cannot widen (C4), `MAX_QUERY_LIMIT` cap, `?since=`, BP1-style inclusive `?before=` keyset cursor, and the `?protocol=` filter (gated by `KNOWN_PROTOCOLS`, unchanged). Both routes documented in `CONTRACTS.md`; purely additive — no existing shape changes, no version break (D8 stays backward-compatible). | interview |
| **W5** | **Upsert by waypoint id; expiry honored; no hard delete.** Rows dedup/upsert on the waypoint `id` + `protocol` across ingestors (C5's cross-ingestor dedup applied to POIs): a re-broadcast updates name/description/icon/coords/`expire`/`locked_to` and advances `rx_time`. A waypoint whose `expire` has passed is **excluded** from `GET /api/waypoints` and the UI from that moment (the design's dimming ladder warns beforehand); `expire` 0/absent = never expires. Never-expiring waypoints age out of the API via the standard 7-day window on last heard (`rx_time`), like every bulk collection. No new retention knob and no physical delete-at-expiry sweep — retention/eviction stays the existing machinery. | interview |
| **W6** | **Map layer per the confirmed design (re-rolled: 1c-B / 1d-C / 1e-A).** Marker = 24 px **teardrop pin** (1c-B: the dark overlay chrome — `#1c1c1c`, hairline `--fg` border — as a three-round-one-sharp-corner square rotated −45° so the sharp corner is the tail, glyph counter-rotated upright, tail tip anchored on the coordinate, rendered above node markers); marker opacity follows the expiry ladder (remaining < 1 h → 0.4, < 24 h → 0.7, else 1; `never` → 1), mirroring the age-bucket freshness ladder, with a **📌 fallback glyph** for missing/invalid icon codepoints (confirmed). Clicking opens the **minimal detail card** (1d-C) in the standard short-info-overlay chrome (standard anchoring confirmed over the mock's quadrant-avoidance): `<glyph> <name>`, description, `<expiry> · by <badge>` — coordinates, the `wpt <id>`, and the locked-to reference move to the node page (**W11**). The legend gains a **Waypoints** toggle with live count in the Meshtastic column (1e-A), following the existing pressed-state/`aria-pressed` conventions (UX8, NT-A1); toggle state is **session-only** like the line toggles (confirmed), and hiding a protocol also hides its waypoints (confirmed coupling). The neighbor/trace line toggles drop their `Show/Hide` label prefix to the mock's static labels (state carried by the pressed styling + `aria-label`) — an explicit user amendment shipped with this re-roll. | interview (re-roll) + design |
| **W7** | **Log-tab entry class (explicitly amends LV7's enumerated list).** A waypoint broadcast adds one Log entry: `📌 Broadcasted waypoint <glyph> <name> — Lat: <lat>, Lon: <lon>, Expires: <relative|never>`. The waypoint **description never appears in the Log** (name only, per the design) — preserving LV7's "bodies never reach the Log" principle for the user-authored long text. Under `PRIVATE` the collection 404s (W3), so no entries exist; the hidden-protocol gate applies as for other entries. | interview (LV7 amendment) |
| **W8** | **Live updates & cache (extends PS3/PS4/PS6, FC1/FC3; re-rolled onto the flashing side of VF3).** `waypoints` becomes the **seventh** SSE collection: the new POST route publishes a thin coalesced change event (PS4/LV6 settle window), suppressed entirely under `PRIVATE` (W3/PS6). The frontend delta-fetches by `since`/merge-by-id through the existing cache with **message-grade TTLs (stale 7 d / evict 7 d, FC3 tier)**. **Re-roll amendment (supersedes the earlier silent-side decision):** waypoints **flash** — `POST /api/waypoints` additionally publishes `nodes` (the ingest advances the author's `last_heard`, mirroring positions/messages, extending PS4/VF3), so the author's row + marker flash with a fresh "last seen", and a waypoint delta fades its own pin via the standard `.live-flash` element fade (LV1/LV2 timers; pins are divIcon markers). | interview (re-roll) |
| **W9** | **Stats: telemetry umbrella gains waypoints (explicitly amends S3).** The `/api/stats` `telemetry` umbrella becomes **positions + telemetry + neighbors + traces + waypoints**, counted by `rx_time` with the S4 windows, the S5 opt-out filters, and the S2 subset property intact (waypoint rows are protocol-stamped). S-A3 is re-baselined to the five-table umbrella. Waypoint frames already count in the ingestor's packets/hour activity metric (MA1 counts every frame) — unchanged. No response-shape change, so no version break. | interview (S3 amendment) |
| **W10** | **Scope boundary & engineering bar (D9/D10; amended by the re-roll).** Web + ingestor only: the matrix bridge, Flutter app, and federation wire are untouched (read-only consumers may ignore the new collection per D10); MeshCore emits no waypoints; no `/version` or config-surface change. **Amendment:** the original "node-detail page untouched" clause is **superseded by W11** — the 1d-C card choice moves the omitted waypoint fields onto the node page, explicitly signed off. All new code meets D9: 100% unit tests (Python + Ruby + JS), 100% API docs (PDoc/RDoc/JSDoc), the exact Apache header per file type, `black`/`rufo` clean, all suites green; no new dependency or ecosystem (Dependabot/CI unchanged). | interview + CLAUDE.md |
| **W11** | **Node-page Waypoints section + per-author lookup (re-roll; amends W10, extends W4).** `GET /api/waypoints/:id` returns the waypoints authored by one node (canonical id or num ref), with the standard per-id **28-day** window on `rx_time` (widened from the 7-day bulk floor exactly like every other per-id route), the same expiry exclusion, opt-out filter, protocol filter, and the W3 PRIVATE GET/HEAD 404 (the wildcard filter covers the path). The node detail page (and its dashboard overlay) renders a **Waypoints** section listing each broadcast with the fields the minimal card omits — glyph+name, `wpt <id>`, 5-decimal coords, `Expires: in …/expired/never`, `🔒 Locked to <badge>`, live-ticking heard age — and the section is simply absent when the node has none. Additive route (no version break, D8); documented in `CONTRACTS.md`. | interview (re-roll) |

## Bugfix: Reticulum loose ends — identity keying, dest-hash back-reference, interface scope (#888)

The Reticulum ingestor (#890) and web tier (#889) landed the shape originally
proposed in #888 rather than the conventions settled in its review thread. The
decisions below record what was settled, and the two questions the review raised
that the merged code did not answer. Acceptance: `ACCEPTANCE.md` **RN-A1…RN-A8**,
**RN-R1**.

**Invariant check.** *I (local LoRa only)* — **unaffected**: nothing here adds a
broker or bus; Reticulum remains a locally-attached stack. *II (privacy)* —
**extends**: `dest_hash` joins `public_key` as a stored-but-never-served
identifier, and the interface allowlist narrows what is collected at all.
*III (federation)* — **unaffected**: no wire or signature change. *IV (parity)* —
**upheld**: `reticulum` keeps the same treatment as its siblings, and RN2 fixes a
renderer that had been silently dropping it.

| # | Decision | Source |
| --- | --- | --- |
| **RN1** | **Node id is the identity hash, not a destination hash; `publicKey` is a real key; destination hashes get their own list.** A Reticulum destination hash is a truncated hash over the identity hash and the name hash — not a key, and not stable across a peer's aspects, so one physical peer announcing `lxmf.delivery` and `nomadnetwork.node` presented **two unrelated node rows** and a `user.publicKey` that was not a public key. The canonical `!%08x` id is therefore derived from the **identity hash** (`RNS.Identity.hash`, taken from the identity RNS hands the announce handler, falling back to `RNS.Identity.recall`), which merges every aspect onto one row; `user.publicKey` carries the identity's real public key; and the destination hashes ride a `destHash` **list**, stored as a sorted JSON array in the new `nodes.dest_hash` column and **unioned** on upsert (two ingestors may each have heard a different subset). This supersedes the mapping #890 documented in `CONTRACTS.md`. | interview (#888 review) |
| **RN2** | **Every renderer of `/api/stats/activity` draws every protocol it serves.** `query_activity_buckets` emits a live `reticulum` key per bucket (F2-2 as amended), but the `/charts` figure's line list was frozen to two protocols: a reticulum-carrying mesh rendered two flat-zero lines, its real traffic invisible and the y-axis unscaled, while the map card rendered the same payload correctly. Both renderers now enumerate all three. The general rule: a protocol present in the payload and absent from a renderer is a defect, not a styling choice (Invariant IV). | code |
| **RN3** | **The ingestor keeps its own Reticulum config directory.** `RETICULUM_CONFIG_DIR` unset resolved to RNS's user default `~/.reticulum`, so installing an ingestor silently adopted whatever transport-node configuration the operator ran there — including `enable_transport` and every interface defined in it. It now defaults to an **app-owned** directory (`$XDG_CONFIG_HOME/potato-mesh/reticulum`, else `~/.config/potato-mesh/reticulum`) and is reachable from the container surfaces MA10 covers: `.env.example`, `docker-compose.yml`, and both `data/Dockerfile` stages. An operator who *does* want to share a stack sets the variable explicitly. Defaulting somewhere app-owned rather than requiring the variable keeps `PROTOCOL=reticulum` a one-line change. Under Compose the RNS config gets its **own** named volume (`potatomesh_reticulum`) nested inside the shared config mount: Docker seeds a *new empty* named volume from the image path, so the directory arrives owned by the ingestor image's user rather than by whoever seeded `potatomesh_config` (the web image, whose user is pinned to uid 1000, while the ingestor image's is not). The image pre-creates the directory before its `chown` so the seed carries the right ownership, and sets `XDG_CONFIG_HOME=/app/.config` so even a blanked `RETICULUM_CONFIG_DIR` falls back inside the mount rather than into the container's unmounted home. **Two residual caveats, accepted:** seeding only happens for an *empty* volume, so a pre-existing `potatomesh_reticulum` is never re-owned; and the ingestor image does not pin its uid (`adduser -S` takes the next free system id), so a base-image change could shift it and strand an existing volume. Pinning the uid would strand volumes created by the current images, which is the worse trade today. **Known gap:** the NixOS module in `flake.nix` exposes no `protocol` option at all, so no non-default `PROTOCOL` (`meshcore` included) is selectable there; that predates this change and closing it is a separate decision, so MA10's "every packaged deployment" is satisfied here only for the container surfaces. | interview (#888 review) |
| **RN4** | **Announce ingestion may be scoped to named interfaces; unscoped is the default.** An RNS stack can carry LoRa and IP interfaces at once, and RNS's own default config enables an `AutoInterface` (IPv6 link-local multicast), so an unscoped listener ingests every announce on the operator's LAN — the whole local Reticulum network in the dashboard. `RETICULUM_INTERFACES` restricts ingestion to announces whose path arrived on a matching interface (lowercased substring match, e.g. `rnode`), read from the path-table entry RNS records *before* dispatching handlers. **Empty is the default and ingests everything**, preserving shipped behaviour; a filtered-out announce is not counted as this mesh's traffic. This is the mechanism for the review's "how do I know a peer is a LoRa peer" question; it does not answer it automatically, because Reticulum exposes no protocol-level LoRa marker — only the interface a path arrived on. | interview (#888 review) |
| **RN5** | **Standing up an RNS stack is not a transmit site under MA7 (explicit, and a documented caveat).** The provider is receive-only: it sends no announce, message, or poll, so it has no transmit site to gate with `tx_policy` and `PROTOCOL=reticulum` stays useful with `TX_ENABLED=0` (the default). **Caveat, deliberately accepted:** the underlying RNS stack is not silent at the *interface* layer — an `AutoInterface` multicasts peer discovery, and a config with `enable_transport` set relays other nodes' traffic. That behaviour is owned by the Reticulum configuration rather than by any ingestor code path, which is exactly why RN3 stops the ingestor from adopting the operator's config and RN4 lets the operator bound what it listens to. Recorded here so the boundary is a decision rather than an oversight; revisit if a future Reticulum cut transmits. | interview (#888 review) |
| **RN6** | **`dest_hash` is stored, never served.** `public_key` has never appeared in a node API projection; `dest_hash` is likewise an on-air identifier and follows the same rule. It exists so a destination hash seen on the wire can be traced back to the node row that owns it — a correlation aid for operators reading the database, not a public field (Invariant II). | code + Invariant II |
| **RN8** | **A scoped ingestor seeds its own RNS config (extends RN3/RN4).** RN3 decided the config dir's *ownership* and said nothing about its *contents*, and RN4's allowlist turned out to be unanswerable without them: RNS decides whether to attach to an external `rnsd` from the `share_instance` **config option**, and the shared-instance socket is keyed on `instance_name`, not `configdir` — so an app-owned directory alone does not stop the ingestor joining the operator's stack, and once attached every announce arrives over one `LocalInterface` where no per-interface allowlist can discriminate. When `RETICULUM_INTERFACES` is set the ingestor therefore **writes a starter config** (only when absent — an operator-authored file is never touched) carrying `share_instance = No` and **no enabled interface**: a stock `AutoInterface` is named `AutoInterface[Default Interface]`, which matches no sensible allowlist, so seeding one would relocate the blackout rather than remove it. A freshly scoped ingestor therefore hears nothing until its interfaces are configured, and **warns at startup that this is so**. Where the ingestor is on a shared instance anyway (the upgrade path, whose config dir predates this and is never seeded), the allowlist **fails open** — ingesting everything, warning once — because over-ingestion is recoverable and a silent blackout is not. **Amends RN5's rationale**: the interface layer is no longer purely "owned by the Reticulum configuration rather than by any ingestor code path", since this code path writes that configuration; it still adds no transmit site of its own, and seeding *no* interface means the seeded stack multicasts nothing until the operator enables something. | review (#893) |
| **RN7** | **Both #889/#890 schema additions carry an automatic upgrade path and a standalone migration.** `instances.reticulum_nodes_count` (#889) and `nodes.dest_hash` (this change) are added by guarded, idempotent `PRAGMA table_info` + `ALTER TABLE ... ADD COLUMN` blocks in `Database.ensure_schema_upgrades` — the path that actually runs at boot; `data/migrations/*.sql` files are reference-only and executed by nothing. #889 shipped the boot guard but skipped the migration companion the four preceding schema changes all shipped; both are restored, and `data/nodes.sql` / `data/instances.sql` carry the canonical shape for fresh databases. | code |

## Bugfix: Reticulum self-identity and connection-variable scope (#888)

Answers the two questions left open on #888 after #893: why `INGESTOR_NODE_ID`
was required for `PROTOCOL=reticulum`, and whether `CONNECTION` conflicts with
`RETICULUM_CONFIG_DIR` / `RETICULUM_INTERFACES`. Acceptance: `ACCEPTANCE.md`
**RN-A9**, **RN-A10**.

**Invariant check.** *I (local LoRa only)* - **unaffected**: no broker, no bus;
the identity is a local key file. *II (privacy)* - **unaffected**: the identity
is the ingestor's own and appears in no API projection beyond the node id the
heartbeat already registered. *III (federation)* - **unaffected**: no wire or
signature change. *IV (parity)* - **upheld**: Reticulum gains the self-identity
every other protocol gets from its handshake, by the only means Reticulum
offers.

| # | Decision | Source |
| --- | --- | --- |
| **RN9** | ~~**The ingestor owns a Reticulum identity.**~~ **Superseded by RE5.** #896 had the provider generate and persist its own RNS identity (`potato_mesh_identity`, `0600`, inside `RETICULUM_CONFIG_DIR`) and derive `!xxxxxxxx` from it "through the same identity-hash rule applied to every peer (RN1), so there is no second, private id rule". The reasoning was sound and its premise then held; two later decisions removed it. **RE1** re-keyed peers on the *destination* hash, so an identity-keyed ingestor row would have *become* the second, private rule it was written to avoid. **RE3** reverted `RETICULUM_CONFIG_DIR` to the operator's `~/.reticulum`, so the key would be written into the directory `rnsd` owns rather than a private one. The goal it set — no operator configuration required — is kept in full by RE5, which derives the id from the transport identity the config dir already holds and writes nothing. | interview (#896, superseded) |
| **RN10** | **`CONNECTION` does not apply to Reticulum; the variables are disjoint, not in conflict.** The review asked whether `CONNECTION` and `RETICULUM_CONFIG_DIR`/`RETICULUM_INTERFACES` collide. They do not overlap: `CONNECTION` names **one** serial, TCP, or BLE endpoint, and an RNS stack is a **set of interfaces** with no such endpoint - which is why `ReticulumProvider.connect` has always ignored `active_candidate`/`CONNECTION` and synthesised `reticulum://<configdir>` instead. The Reticulum split is `RETICULUM_CONFIG_DIR` = *which stack* (RN3), `RETICULUM_INTERFACES` = *which of its interfaces to ingest from* (RN4). What was wrong was not the model but its silence: `data/Dockerfile` sets `CONNECTION=/dev/ttyACM0` in the shared env block of **both** stages, so an operator switching to `PROTOCOL=reticulum` inherits a serial path that reads as if it applies and is dropped without a word. `connect` now says so once at `info`. **The image default is deliberately left in place**: dropping it would change how `PROTOCOL=meshtastic`/`meshcore` containers resolve their port (from a fixed path to `default_serial_targets()` auto-detection, which ends at `/dev/ttyACM0` anyway but is not the same thing), and a Reticulum follow-up is the wrong change to carry it. Recorded so the residue is a decision rather than an oversight. | interview (#888 follow-up) |

## Feature: Reticulum visual identity (RNS tile, role ramp, one colour code)

Implements the Claude-Design review `RNS Icon.dc.html` (project
`4307d9c6-96e6-4d50-a019-24f9e9052395`), turns 1 and 2a-2c plus the roles
legend. Reticulum shipped functionally in #889/#890 and #893 but with a
placeholder tile and no visual identity of its own: the committed
`reticulum.svg` drew an outline triangle on near-black `#010101`, a hair off the
MeshCore tile and indistinguishable from it at 12 px. Acceptance:
`ACCEPTANCE.md` **RD-A1...RD-A8**, **RD-R1**.

**Design stance: forward-compatible.** Two of these decisions deliberately build
the full shape ahead of the data behind it - RD4 ships a `TRANSPORT` role no
announce currently populates, and RD6 gives Reticulum a marker shape no RNS node
can currently render, having no position. That is intent, not an oversight: the
visual language is designed whole now so the gaps can be filled in later without
re-opening the design. Read those two decisions as reserved slots.

**Invariant check.** *I (local LoRa only)* - **unaffected**: presentation only,
no new ingest path. *II (privacy)* - **unaffected**: no new field reaches a read
surface; the role added by RD4 is derived from an announce the ingestor already
receives, and rides the existing `role` column. *III (federation)* -
**unaffected**: no wire or signature change; the instances column already exists
(#889) and only the asset behind it changes. *IV (protocol parity)* -
**upheld and strengthened**: a third protocol gains the same visual channels the
other two have (tile, role palette, marker shape, chart line, badge) rather than
borrowing Meshtastic's.

**Conflict check.** *S6 (reticulum is a first-class protocol scope)* -
**consistent**; this is the visual half of it. *UX7 / FU3 / LC1 (marker shape is
the protocol channel; MeshCore's equal-area diamond; swatches carry the marker
shape)* - **extends**: a third shape joins the channel. FU3's equal-area rule is
scoped to the map divIcon and does not bind the legend swatch, which has always
been eyeballed (11 px diamond against a 12 px circle). *UX8 (legend pressed
state / `aria-pressed`)* - **extends**: the third column inherits the
conventions unchanged. *UX2 (badge text clears 4.5:1)* - **consistent**:
verified, see RD5. *RN1 (identity merge)* - **extends**: RD4's precedence exists
only because RN1 collapses a peer's aspects onto one row. *MA-F2 / MA5 / F2-2* -
**consistent**: the card already renders a Reticulum row and the series key is
already live. *RN2 (Reticulum chart line)* - **superseded** by RD3 on colour
only; the line itself stays. *F2-A3* - **contradicted and amended**, see RD3;
this is the one contradiction in the feature and it was raised and chosen
explicitly rather than absorbed silently.

| # | Decision | Source |
| --- | --- | --- |
| **RD1** | **The Reticulum tile is the trifoil on violet `#7b61ff`** (design 1c). One node, three links out to the vertices of a near-equilateral triangle - multi-hop transport with no centre and no hierarchy. Optically rather than mathematically centred: the hub sits at the tile's centre `(75, 75)` rather than at the triangle's centroid `(75, 88.43)`, so apex and base carry equal air (40.3 each) and the **spokes are deliberately unequal** - 40.3 up, 61.6 to each base vertex. Their bearings are therefore 130.9 / 98.3 / 130.9 degrees apart, not 120: equalising them would drop the figure low in its box. Flat tile colour, flat glyph colour (`#FBFBFB`), full-bleed square, no corner radius, rendered 12 px inline / 13 px in the instances table / 20 px in the meta-row toggle - the rules both shipping tiles already follow. Violet is furthest from both in hue *and* value and is unclaimed elsewhere in the dark palette. The Reticulum mark itself does not survive a 12 px square, so the tile deliberately does not attempt it. **`protocol-helpers.js` needs no change**: it already exports `RETICULUM_ICON_SRC`, `isReticulumProtocol` and the `protocolIconPrefixHtml` branch, so the tile is the only thing RD1 itself adds. (RD7 separately adds a `buildReticulumIconImg` DOM builder for the legend header.) | design (turn 1) |
| **RD2** | **MeshCore's tile background moves `#010101` to `#1f2937`.** Pure black was the one tile that read as an absence of colour rather than a colour, and it is what made the placeholder Reticulum tile indistinguishable from it. The dark blue keeps MeshCore clearly the darkest of the three, makes the row look chosen rather than defaulted, and finally agrees with the MeshCore README badge, which has always carried `#1f2937`. Glyph colour unchanged. | design (turn 2c) |
| **RD3** | **One colour code across table, meta row and figure (amends F2-A3).** The `/charts` mesh-activity lines repoint at their tiles: Meshtastic `#8856a7` to `#67ea94`, Reticulum to `#7b61ff` (superseding RN2's `#31a354`). MeshCore keeps `#3182bd` because black cannot be a line on a dark chart - so the tie is **2-of-3 by design**, not an oversight. Before this the page taught one colour code in the table and a different one in the figure, and dropping violet in beside `#8856a7` would have put two purples on one figure with the newest protocol as the low flat line. **F2-A3 asserts the current pair and is therefore amended, not merely updated.** | design (turn 2b) + interview |
| **RD4** | **Reticulum roles are derived from the announce aspect and ranked (extends RN1).** `lxmf.propagation` joins `_ANNOUNCE_ASPECTS`, and an identity's role is the **highest-ranked aspect it has announced on during this ingestor session**: `PROPAGATION > TRANSPORT > NODE > PEER`. **Known limitation, deliberately not fixed here:** the accumulator is in-memory and per-process, and the web upsert writes `role=COALESCE(excluded.role, nodes.role)`, so an ingestor restart - or a second ingestor that hears only the lower aspect - can *demote* a stored role. The neighbouring `dest_hash` column solves the same problem with a SQL-side union (RN1); `role` would need a rank-aware `MAX` in the shared, protocol-generic upsert to match, which is out of scope for a visual-identity feature and is tracked as a follow-up. A fixed rank is required, not a direct mapping: RN1 collapses a peer's aspects onto one row and the web upsert writes `role=COALESCE(excluded.role, nodes.role)`, so a direct mapping would make a dual-aspect peer's role **flip on every announce**, oscillating its badge and its legend bucket. **`TRANSPORT` stays unpopulated**: no announce exposes it, and inferring it from our own path table would make it a property of the ingestor's vantage point rather than of the node - two ingestors would disagree, breaking CONTRACTS' sender-side determinism rule. | interview |
| **RD5** | **`reticulumRoleColors` is a four-step violet ramp**, light to dark: `PEER #cabffa`, `NODE #a08bff`, `TRANSPORT #8b74ff`, `PROPAGATION #4a32b8`, joining `roleColors` and `meshcoreRoleColors` behind `getRoleColors`. Ties the badges to the tile. **Measured** against `getContrastTextColor`: 10.86 / 6.71 / 5.31 / 8.61 - all clear the UX2 4.5:1 floor - while the tile's own `#7b61ff` lands at **4.39:1** and fails, which is exactly why `TRANSPORT` is one step lighter than the tile rather than equal to it. `TRANSPORT` ships in the ramp although RD4 leaves it unpopulated, so the ramp is complete the moment a source exists. Until this ramp existed, Reticulum nodes inherited the Meshtastic palette. | design (turn 1) + measured |
| **RD6** | **Hexagon is Reticulum's shape channel - legend-only in practice** (extends UX7/LC1). `clip-path: polygon(50% 0%, 100% 27%, 100% 73%, 50% 100%, 0% 73%, 0% 27%)` on the 12 px swatch, taken from the design rather than re-derived. **Stated honestly:** a Reticulum announce carries no position, so an RNS node never renders a map marker - the shape exists so the legend swatch can key protocol the way LC1 requires, and `nodeMarkerShapeForProtocol` gains a branch whose map output is currently unreachable. Chosen over the design prose's triangle. | design + interview |
| **RD7** | **Third legend column and README badge.** The legend gains an RNS column carrying the tile, label, live 7-day count and the four role filters, inheriting UX8's pressed-state and `aria-pressed` conventions unchanged. The README gains a Reticulum badge in the tile's own `#7b61ff` - where MeshCore's badge uses `#1f2937` rather than a true black that would vanish against the badge row, violet needs no such adjustment. **The badge reads `supported`, not the design's `planned`**: the brief chose `planned` on the premise that the ingestor did not exist and instructed "swap the word when `PROTOCOL=reticulum` ships", which it did in #890. This changes the badge colour from the `#1f2937` that #893 shipped. | design (turn 2c) + interview |
| **RD8** | **Scope boundary.** *(Its federation-column clause — an em dash for a zero RNS count — is **superseded by RL4**, which distinguishes absent from zero for all three protocols.)*  Panel **2d** - the mesh-activity figure redesign (line-end labels, 10% area fills, per-line weight and opacity, gridline and axis restyle) - is **deferred to its own feature**: it is a figure redesign that stands alone, it would land as options on the shared `node-page-charts` renderers, and no other figure on the page needs any of it. The **federation map needs no protocol work**: its markers colour by total active node count through `colorForNodeCount` and its legend keys those buckets, so violet never means a bucket there. The instances column gains one **deliberate behaviour change** (the only user-visible one outside the assets): an instance with no RNS nodes now renders an em dash rather than a tile beside a zero. This was *not* the prior behaviour - `normalize_instance_row` serves `reticulum_nodes_count` as `|| 0` so a crawler re-verifying a relayed v2 record rebuilds the canonical the sender signed (FS2), which left the renderer's `== null` em-dash branch unreachable for this column alone, so every federated row carried a tile beside its count. RD1 made that a bright violet tile, and during rollout almost every federated instance reports zero - a tile in every cell would make the column look broken rather than new. The two sibling columns can still tell absent from zero and are untouched. | interview + design |

## Bugfix: Reticulum end-to-end field findings (#893 hardware test)

The first run against a real RNode and a live `rnsd` disproved two assumptions
this project had built on. Acceptance: `ACCEPTANCE.md` **RE-A1...RE-A8**,
**RE-R1**.

**Invariant check.** *I* — **unaffected**. *II (privacy)* — **extends**:
`identity_hash` joins `public_key` as stored-but-never-served; `destinations`
is served, and carries only what a peer broadcast. *III* — **unaffected**.
*IV (parity)* — **upheld**: `destinations` is protocol-neutral; a node with one
destination simply has one row.

| # | Decision | Source |
| --- | --- | --- |
| **RE1** | ~~**One row per announced destination (reverses RN1).**~~ **Superseded by RE7** — the destinations table (RE2) already carries the per-aspect names and roles, so splitting node rows was redundant; the naming problem RE1 solved is a presentation concern. Original reasoning preserved:  RN1 keyed rows on the identity so a peer's aspects merged. The field test showed the cost: the aspects carry **different names** — `lxmf.delivery` announced "Afri Nomad Orion", `nomadnetwork.node` announced "Department of Decentralization" — so the merged row was named from one aspect and roled from another. `node_id` is the first four bytes of the **destination hash** again; `nodes.identity_hash` groups the rows into a peer, and how that grouping is *presented* is a separate design pass. `_ROLE_RANK`, `_rank_role`, `_record_role` and the cross-ingestor `dest_hash` union are all removed: one aspect per row leaves nothing to rank or merge. | field test |
| **RE2** | **Destinations are a table, and they are served.** `destinations` (`id`, `node_id`, `identity_hash`, `name`, `aspect`, `role`, `interface`, `first_heard`, `last_heard`) **replaces** the `nodes.dest_hash` JSON column — a column and a table modelling one relationship would drift — and is served by `GET /api/destinations`. Named for `RNS.Destination`, not "aspects": an aspect is one component of a destination's name. | interview |
| **RE3** | **Interface scoping works through a shared instance (amends RN4, retires RN8).** `RNS.Reticulum`'s accessors RPC to a running `rnsd` and return **its** view of which interface an announce arrived on; `RNS.Transport.next_hop_interface` reads only the local path table and answers `LocalInterface[...]` for everything, which is what made the allowlist look unanswerable. The config seeding (RN8) and the fail-open both existed solely to work around that and are **removed**. RPC auth is keyed on the config dir's identity, so the ingestor must share the operator's directory — which is why RN3's default reverts to `~/.reticulum`. | field test |
| **RE4** | **A 0-hop announce is always ingested.** `Transport.inbound` adds a hop to every inbound packet and takes it back for a local-client or shared-instance interface, so zero hops can only mean "announced by an app on this machine". Filtering purely on interface name hid the operator's own nodes, because every local destination legitimately reads `LocalInterface[rns/default]`. `RETICULUM_INTERFACES` now applies from one hop out, where the interface is real. | field test |
| **RE5** | **The host node id is derived, and canonicalised the Reticulum way.** `canonical_node_id` keeps the low 32 bits of a hex value — right for a Meshtastic node num, wrong for a 16-byte identity hash, which it truncates from the opposite end; the ingestor registered `!86c39940` while its own peer row read `!27716218`. A raw identity hash now maps through `_reticulum_node_id`. When `INGESTOR_NODE_ID` is unset the id is derived from `RNS.Transport.internal_identity()` rather than warned about: an operator should not have to grep a nomadnet logfile for it. | field test |
| **RE6** | **Protocol-scoped settings say so, and the transmit gate is logged when it blocks something.** `CONNECTION` is Meshtastic/MeshCore only and is documented as such; Reticulum takes its target from `RETICULUM_CONFIG_DIR`. The announcement policy check moves **after** the due check, so the suppression line names the gate only when it actually blocks a due announcement instead of once per 60 s loop — the startup `Transmit policy resolved` line already carries that diagnosis. | field test |


## Documentation: operator docs, flag coverage, API coverage (audit)

An audit pass, not a behaviour change: no application code moved. It closes the
drift between what the code reads and what the documents say, and fixes the two
places where an operator-facing document had silently stopped being true.

*I (local LoRa only)* — **unaffected**: no ingest path changed.
*II (privacy & consent)* — **strengthened**: the dual-CDN tile egress is disclosed
again (SB6/D11), and `configure.sh` now asks about transmitting instead of
writing the defaults silently.
*III (federation)* — **unaffected**.
*IV (parity)* — **upheld and repaired**: `configure.sh` and the NixOS module were
Meshtastic-only, so two of the three supported protocols could not be configured
through the documented tooling at all.

| # | Decision | Source |
| --- | --- | --- |
| **DOC1** | **Operator documentation answers "do X to achieve Y".** No design rationale, no history, no justification of a default: those live in `SPEC.md`. Where a *reason* is what an operator must act on (why `PRIMARY_CHANNEL_NAME` is required for UDP), it stays — the test is whether the reader needs it to configure the thing correctly, not whether it is interesting. | interview |
| **DOC2** | **Two documentation tiers.** `README.md` documents **every** environment variable either config file reads — no exemptions, since a variable that exists only in code is undiscoverable. The **operator-facing** subset is additionally piped through `.env.example`, Compose, the NixOS module, and each service image that reads it. Internal tuning knobs (thread pools, timeouts, SSE and federation internals) are README-only: pre-declaring two dozen of them buries the handful an operator sets. | interview |
| **DOC3** | **The configuration surfaces are protocol-neutral.** `configure.sh` asks which protocol to run and branches its radio, connection, and summary blocks on the answer; the NixOS module gained `ingestor.protocol`, the Reticulum options, and the UDP options. A wizard that can only produce a Meshtastic `.env` contradicts invariant IV regardless of what the ingestor supports. | audit |
| **DOC4** | **Documented endpoints include the ones that are not APIs**, and the absence of one is itself documented: `/version`, `/metrics`, `/.well-known/potato-mesh`, `/og-image.png`, `robots.txt`, `sitemap.xml`, the page routes — and an explicit statement that there is **no** health endpoint, because there is none and a reader would otherwise go looking. | interview |
| **DOC5** | **`CONTRACTS.md` is checked against what is actually served.** It claimed `identityHash` reached no read API, which stopped being true when `GET /api/destinations` landed, and it referenced a `dest_hash` column that RE2 had already replaced. A contract describing a dropped column is worse than silence, so the destinations read shape is now specified there alongside the other GET contracts. | audit |

## Feature: Identity-keyed Reticulum nodes and host aspect discovery (#888)

Corrects the data model to the one the protocol implies: an identity is a node,
and its destinations are aspects of it.

*I (local LoRa only)* — **unaffected**: discovery reads the local stack, no new
network path.
*II (privacy & consent)* — **unaffected**: no new data leaves the instance; the
transport aspect is the operator's own node, gated on their own config.
*III (federation)* — **unaffected**.
*IV (parity)* — **upheld**: identity-keyed rows are a Reticulum-shaped answer to
a Reticulum-shaped question; no other protocol changes.

| # | Decision | Source |
| --- | --- | --- |
| **RE7** | **One node record per identity (restores RN1, supersedes RE1).** A peer announcing `lxmf.delivery`, `lxmf.propagation` and `nomadnetwork.node` is **one** node with three destinations, not three nodes; the node count counts identities. Verified against RNS itself: `RNS.Destination.hash(bytes.fromhex("27716218…"), "lxmf", "delivery")` reproduces the field's `4cf985bf…`, and likewise for the propagation and nomadnetwork aspects — the three captured destinations provably belong to one identity. The per-aspect display names and roles that motivated RE1 live in the `destinations` table (RE2), which is what made the row split unnecessary. **Known consequence, deliberately deferred:** the node-level `long_name` and `role` are whichever aspect announced most recently, so a multi-aspect peer's headline name can alternate; the destinations table holds the per-aspect truth and choosing what to surface is the frontend pass. A destination hash keys a row only when no identity can be resolved at all. | interview |
| **RE8** | **The host's node id is its discovered primary identity, and its aspects are ingested.** The 0-hop entries of the running stack's path table are the destinations announced by apps on this machine (RE4); `RNS.Identity.recall` maps each to its owning identity, and the identity fronting the **most** of them is the host's primary. Ties are **not** guessed — path-table ordering is unstable, so an ambiguous host must set `INGESTOR_NODE_ID` — and an undiscoverable host returns `None`, which the daemon retries rather than treating as fatal. The **transport identity is excluded from the pick**: RNS generates it as an independent keypair, so it matches none of the operator's announced destinations, and keying on it registered `!fbf8e338` for a host whose primary identity was `27716218…`. Aspects are labelled by *recomputing* each known aspect's destination hash from the identity hash and matching it against the local set, since a destination hash is one-way. The host's aspects are re-emitted on every snapshot, which doubles as the periodic refresh. | interview + field test |
| **RE10** | **The headline name and role follow a fixed aspect preference: `NODE` > `PEER` > `PROPAGATION` > `TRANSPORT`.** RE7 accepted that a multi-aspect peer's node-level `long_name`/`role` would follow whichever announce arrived last, alternating the headline and churning the row on every announce. They are now derived from the node's **ranked** destinations instead. Deliberately *not* the RD5 colour-ramp order, which sequences a violet gradient: this ranks how well an aspect identifies the peer — a node address names the operator's node, a delivery address names its owner, a propagation store is infrastructure, and the transport instance is an implementation detail. Resolved **in SQL from the `destinations` rows** on every destination write, not in an ingestor-side accumulator: the answer then survives a restart and agrees across ingestors, which is exactly the durability the RD4 known-limitation lacked. Name and role resolve **independently**, so an aspect carrying a role but no display name cannot blank the headline. | interview |
| **RE9** | **`TRANSPORT` is emitted for the ingestor's own host only, gated on whether the *stack* routes (amends RD4/CONTRACTS; gate corrected by RA12).** The transport identity is recorded as one more destination of the host under the synthetic aspect `rns.transport`, with `identity_hash` set to the **primary** identity: the association is local fact for our own machine, not an inference from a vantage point, so two ingestors on that host agree and every remote peer is untouched — CONTRACTS' sender-side determinism rule still holds. The gate is required, not cosmetic: the transport identity exists on **every** stack while only a transport-enabled one relays, so reporting the role ungated would assert something false on the default configuration. This populates the `TRANSPORT` slot RD5 reserved. | interview |

## Feature: Reticulum aspects — identity groups and the identity page (#888)

Makes RE7 visible. An identity has been one node since RE7, but the UI still
rendered a peer's four addresses as four unexplained rows' worth of dashes; this
gives the identity a parent row, its destinations sub-rows, and a page of its
own. Design: `Reticulum Aspects.dc.html` (panels 1a/1b/1c).

*I (local LoRa only)* — **unaffected**: read-side rendering over rows the
ingestor already writes.
*II (privacy & consent)* — **unaffected**: destinations carry no message content
and are already served; `PRIVATE` gates nothing new here.
*III (federation)* — **unaffected**: the federation record and `/api/nodes` are
untouched.
*IV (parity)* — **upheld**: grouping is Reticulum-shaped because only Reticulum
holds several addresses per node. Meshtastic and Meshcore rows render exactly as
before, including their bare counts. Two decisions here are cross-protocol and
both remove protocol-specific behaviour rather than adding it: RA6 (detail views
stop rendering dashes) and RA9 (each protocol falls back to its own base role
instead of Meshtastic's `CLIENT`).

| # | Decision | Source |
| --- | --- | --- |
| **RA1** | **Identities are parent rows, destinations are sub-rows.** Reticulum's protocol cell becomes the disclosure control — `▸`/`▾` in place of the tile glyph, keeping the tile's violet inset so a group reads as Reticulum before it opens. The parent carries the identity's canonical `!xxxxxxxx`, the RE10-derived `long_name`, and the **newest** `last_heard` across its destinations. An identity with a single destination renders as a plain row with **no caret** — a disclosure that reveals one row is a lie about depth. The parent's name is read from the server-derived value, never re-ranked client-side, so the table and the API cannot drift. | design 1a |
| **RA2** | **Sub-row anatomy and sort.** The aspect takes over the first two columns as its own leading cell — the one thing a destination has that its identity does not. `Short` keeps the per-destination role badge coloured from `reticulumRoleColors` (RD5), `Long Name` carries the destination's own name and `[!id]`, and every remaining column reports `—`: a destination has no battery, no position, no radio. Sorting always sorts **parents**; sub-rows follow their parent rather than sorting independently, so a sort never interleaves one identity's addresses with another's. | design 1a |
| **RA3** | **Counts read `identities (destinations)`.** The Reticulum protocol toggle and the map legend's Reticulum column header both read `3 (8)`. Meshtastic and Meshcore keep a bare count: the bracket appears only where a node can hold more than one address, so it marks a real distinction instead of decorating every protocol. The first number is the existing node count (identities, since RE7) and is unchanged; the second is derived client-side from the destinations already loaded. | design 1a |
| **RA4** | **The table joins one bulk `GET /api/destinations` client-side by `node_id`.** Read-side: `/api/nodes`, its CONTRACTS shape, the federation record and the mobile client are all untouched, and a non-Reticulum deployment carries nothing extra. Rejected embedding destinations in `/api/nodes` — that changes the most widely consumed payload in the project for a view only one protocol uses — and a third grouped endpoint, which would be a third representation of rows two endpoints already serve. | interview |
| **RA5** | **`/nodes/:id` is the identity page.** The spec sheet renders only the groups Reticulum can fill — Identity (full 32-hex identity hash, destination count, interface) and Activity (first heard, last seen, role). Health, Utilization, Environment and Position are **not rendered at all** rather than rendered empty, which is RA6 applied to this page; telemetry charts, neighbours, traces and waypoints stay absent by the mechanism `detail-html.js` already uses (a section that renders `''` is not pushed). A Destinations table carries the **full 32-hex destination hashes** — the only place they appear, because they are what a reader needs to message the peer — and a destination's own `/nodes/!id` canonicalises to its identity's page. | design 1b |
| **RA6** | **Detail views drop the em-dash; the table keeps it (amends UX4 **and PD1**).** UX4 required a muted `—` in empty cells *with overlay parity*, and PD1 restated it for the `/nodes/:id` spec sheet ("absent telemetry renders the muted `.cell-empty` dash"). Both are amended, because a rule stated twice has to be amended twice or the second copy silently reinstates it. Parity is now broken deliberately: a detail view renders a field only when it has a value, and a group only when a field survives, with a single muted `No telemetry reported.` — reusing the `.node-extra__empty` voice — when none do. The **table keeps its dashes**: at table width there is room, and a dash there separates "not reported" from "still loading", which a detail view does not need to distinguish because it renders after its data. This removes sixteen dashes and four empty groups from a Reticulum node's overlay, and applies to every protocol. | design 1c |
| **RA7** | **`rns.transport` stays the stored aspect and displays as "no aspect".** The design shows the transport row with an em-dash aspect. The synthetic aspect is load-bearing — it is what maps the row to the `TRANSPORT` role (RE9) — so it remains in the data and this is a **display rule only**. Keeps the ingestor contract and the UI honest at once. | interview |
| **RA8** | **`/api/destinations` gains the collection contract, and the table loads it in the background.** It takes `?limit=`, `?since=` and `?before=`, bounding `last_heard` — its primary sort column — exactly as the seven bulk collections do (BP1), including the inclusive `<=` boundary and its one-row overlap. Consistency is the point: an endpoint that pages differently from its siblings is a trap for every client. The dashboard walks pages **in the background** after first paint rather than blocking on them, so a mesh with many destinations degrades to "groups fill in shortly" instead of a stalled table; the row hierarchy renders from `/api/nodes` alone and gains its chips, counts and sub-rows as pages arrive. | interview |

| **RA9** | **Every protocol falls back to its own base role, not Meshtastic's.** `CLIENT` is a **Meshtastic** role, but it was the fallback everywhere a node reported none — labelling a Meshcore node as something Meshcore has no concept of, and a Reticulum node likewise, in the table, the marker tooltip, the short-info overlay, and every badge colour. `defaultRoleFor(protocol)` now resolves `meshtastic → CLIENT`, `meshcore → COMPANION`, `reticulum → PEER`: the plain participant that carries no additional function. `getRoleColor` falls back **within the node's own palette** before reaching for the Meshtastic one, so a role-less Meshcore node is no longer painted Meshtastic blue. The ingestor-side synthetic-placeholder default gains its missing `reticulum → PEER` branch (Meshtastic keeps `CLIENT_HIDDEN`, which deliberately hides a node not yet heard from). An unknown or absent protocol keeps `CLIENT`, so nothing that never named a protocol changes. | field report |

| **RA10** | **A generic name is built from the *head* of a Reticulum id, and names the row it is on.** Two defects, one rule. (a) The placeholder took the **last** four hex digits while the badge showed the **first**, so `!27716218` badged `2771` and read `Reticulum 6218` — two names for one row. Reticulum ids are the head of a 16-byte hash, so the head identifies them; a Meshtastic id is a node num whose **low** bits are the conventional short id, and it keeps the tail. (b) A destination with no announced name borrowed its *identity's* placeholder, so destination `!fee521eb` read `Reticulum 6218` — the name of a different thing entirely. Each row is now named from its own hash. The ingestor's `_reticulum_placeholder_name` and the web tier's `placeholder_short_id` must stay in lockstep: the latter is what recognises a placeholder so a real announced name is never overwritten by one, and a drift fails that guard **open**, silently. Both sides pin the same fixture strings for that reason. | field report |
| **RA11** | **The row controls do not set the row's height, and the caret sits with the `+`.** A 24 px `min-height` on the disclosure made a Reticulum parent ~33 px against ~24 px for every other row; both controls now sit inside the row's line box, with the 44 px touch target restored on coarse pointers via a transparent `::after` — the pattern `.short-name` already uses. The caret moves from the protocol cell to the trailing cell beside `+`, which **restores the protocol tile** to Reticulum rows: swapping the glyph for the caret (as RA1 first specified) cost them their only protocol marker in the table. The trailing column is therefore always present — a table column cannot be shown per row — while the `+` keeps its own responsive rule, so its behaviour is unchanged. The caret carries **no violet fill**: RD5 pins `#7b61ff` as failing the UX2 4.5:1 floor behind text (4.39:1 at best), and with the tile restored the caret no longer needs to carry the protocol's colour. **Amends RA1.** | field report |

| **RA12** | **The transport gate asks the stack, not the process (corrects RE9).** `RNS.Reticulum.transport_enabled()` answers "does **this process** route traffic". On connecting to a shared instance RNS *forces* the client's flag to `False` regardless of the config file, so an ingestor attached to `rnsd` read `False` even with `enable_transport = Yes` — and the operator's own host never grew its `TRANSPORT` destination. The stack's answer comes from `get_interface_stats`, which RPCs to the shared instance and reports a `transport_id` **only** when that instance is routing. A standalone transport node still short-circuits on its own flag with no RPC. The distinction matters beyond this gate: any "is the stack doing X" question asked from a client process has the same trap. | field report |

## Feature: Reticulum finalization — radio metadata, chat tags, federation zeros (#888)

Closes the last places where Reticulum is structurally emptier than its two
siblings: it reported no frequency and no preset, so the nodes table, the
ingestor heartbeat and the chat/log tags all rendered blanks for it.

*I (local LoRa only)* — **unaffected**: reads a local config file and the rows
already ingested; no new network path.
*II (privacy & consent)* — **unaffected**: radio parameters are the operator's
own settings, already published for the other two protocols.
*III (federation)* — **touched**: RL4 changes how every protocol's node count
renders in the instances table. The signed record and its canonicalisation are
untouched; only presentation moves.
*IV (parity)* — **this is the point**: frequency and preset were the last two
columns where Reticulum could not answer. RL4 likewise makes one rule serve all
three protocols instead of Reticulum having its own.

| # | Decision | Source |
| --- | --- | --- |
| **RL1** | **Reticulum radio metadata comes from the shared RNS config, with env override.** `frequency`, `bandwidth`, `spreadingfactor` and `codingrate` are read from the `RNodeInterface` section of the config dir the ingestor already shares with `rnsd` (RE3); `RETICULUM_FREQ` and `RETICULUM_PRESET` override them, mirroring how `FREQUENCY` already overrides the auto-detected `LORA_FREQ`. The file is the **only** source available: `get_interface_stats` carries `bitrate`, airtime and channel load but **no** radio parameters (zero occurrences of frequency/sf/cr in the RPC payload), and a shared-instance client's own `Transport.interfaces` holds only its local-client interface, never the RNode. **Known cost (RA12's shape):** a config file is not the running stack, so editing the config and reloading `rnsd` without restarting the ingestor leaves the reported values stale. Unlike the transport gate there is no RPC alternative to prefer. | interview |
| **RL2** | **The preset label is a Meshtastic preset name when the parameters match exactly, else `SF/BW/CR`.** The fallback reuses `_custom_preset_label` in `interfaces/radio.py`, which already emits `SF{sf}/BW{bw}/CR{cr}` — the same shape MeshCore's decoder produces — so no second format is invented. **Two costs, accepted deliberately.** (a) The name borrows another protocol's vocabulary: a Reticulum radio labelled `LongFast` shares air parameters with a Meshtastic `LongFast` mesh but is **not** interoperable with it, and the label invites that inference. (b) The BW/SF/CR→preset table is **hand-maintained**: the Meshtastic Python package defines the preset *enum* but not its parameters, which live in firmware, so nothing in the dependency tree can verify the table and it can drift from upstream. It is therefore pinned by an explicit test that states its provenance. | interview |
| **RL3** | **The chat and log frequency/preset tags need no code of their own.** `createAnnouncementEntry` builds them from `formatNodeAnnouncementPrefix` and `formatChatPresetTag({presetCode: metadata.presetCode})`; both were blank for Reticulum only because the underlying values were absent, so RL1/RL2 fill them. Recorded as a decision rather than left implicit so the behaviour is pinned by a test and cannot silently regress if the tag renderers are refactored. | interview |
| **RL4** | **Federation node counts: absent is a dash, zero is a muted zero, non-zero gets the tile.** One rule for all three protocol columns, replacing two: MeshCore and Meshtastic tested `== null` (so a real `0` drew a tile) while Reticulum tested `!value` (so `0` and absent were indistinguishable). Zero and "not reported" now read differently, which is the honest distinction, and the tile appears only where it carries information — answering the objection that motivated the previous em-dash rule, since during rollout most instances report `0` and would otherwise fill the column with tiles. **Supersedes** the CHANGELOG-recorded dash rule from the visual-identity work. Reticulum's `normalize_instance_row` still serves `\|\| 0` for signature canonicalisation (FS2), so its column renders a zero rather than a dash — unchanged and intentional. | interview |
| **RL5** | **A destination's identifier links to its identity page.** RA5 specified that `/nodes/!<destination>` canonicalises to the owning identity, and the route does — but nothing in the UI ever emitted that link, so the behaviour was reachable only by typing a URL. The `[!xxxxxxxx]` in a table sub-row and the destination hash on the identity page become links, and the identity page's destination rows carry anchors so a link lands on the row it names. A claim in the spec that no interface exercises is indistinguishable from a claim that is false. | review follow-up |

| **RL6** | **`destinations` is a retention target.** The table carries no foreign key to `nodes`, so nothing cascaded when a node was purged and a destination row outlived it indefinitely — invisible to every view except an unfiltered `GET /api/destinations`, in a table that only grew. It is swept on `last_heard`, the same column its node uses, so the two age out together. Delete order is immaterial precisely because there is no constraint between them. | operator report |

## Bugfix: SSRF guard missed IPv6 transition addresses (NAT64/6to4/Teredo)

`restricted_ip_address?` decided what federation may connect to by delegating to
Ruby's `IPAddr#loopback?` / `#private?` / `#link_local?`. Those predicates
classify an address by its *literal form* against a fixed table of special-use
ranges; they do not decode IPv6 transition addressing, in which an IPv4
destination is embedded in an IPv6 address and reached through a gateway. A peer
publishing an AAAA record of `64:ff9b::a9fe:a9fe` therefore passed the guard and
the federation client pinned `Net::HTTP#ipaddr` to it, reaching
`169.254.169.254` — cloud instance metadata — on any network with a NAT64
gateway. `#private?` is also RFC1918-only, so CGNAT (`100.64.0.0/10`) passed
likewise. Reported by tonghuaroot; CWE-918.

*I (local LoRa only)* — **unaffected**: no ingest path, broker or radio surface
is touched; the change only narrows an existing outbound HTTP destination check.
*II (privacy & consent)* — **strengthened**: the bug let a remote peer steer this
instance's outbound requests at its operator's internal infrastructure.
*III (federation)* — **this is the point**: §5 limits outbound traffic to "opt-in
federation of signed public metadata". A peer-chosen request to loopback or
metadata is outside that, and SS2 keeps the narrowing from costing reachability.
*IV (parity)* — **unaffected**: the guard is protocol-agnostic.

| # | Decision | Source |
| --- | --- | --- |
| **SS1** | **The restricted set is stated, not borrowed.** `restricted_ip_address?` matches an explicit, named list of CIDR ranges (`RESTRICTED_IP_RANGES`) instead of delegating the decision to `IPAddr`'s predicates. The predicates answer a *taxonomy* question ("is this literal in a special-use range stdlib knows about"); the guard asks a *reachability* question ("can a peer steer us somewhere we forbid"). Borrowing one to answer the other is the root defect, and it is silent by construction: every range stdlib does not model is a bypass that no test names. The list adds `100.64.0.0/10` (RFC6598 CGNAT — real internal space on carrier and cloud networks, and not RFC1918), widens the unspecified check from `0.0.0.0` to `0.0.0.0/8` (RFC1122 "this network"), and restricts `::/16` in one line rather than enumerating the unspecified address, `::1`, IPv4-mapped `::ffff:0:0/96` and the deprecated IPv4-compatible `::a.b.c.d` separately — RFC4291 §2.4 reserves that space outright, so no federation peer can legitimately publish an address in it. The slice deliberately stops at `/16` and not `/8`: the well-known NAT64 prefix `64:ff9b::` also sits in `::/8`, and SS2 requires that one be decoded. It also adds `fec0::/10` (RFC 3879 site-local), which no predicate models. **The list is not a superset of the predicates, and deliberately so.** `IPAddr#private?`, `#loopback?` and `#link_local?` recognise an IPv4-mapped address by testing bits 80–95 == `ffff` *without* requiring bits 0–79 to be zero, so they misreport ordinary global addresses as internal — `2606:4700:4700::ffff:a9fe:a9fe` reads as **link-local** (its low 32 bits are `169.254.169.254`) and `2001:db8:1:2:3:ffff:a00:1` as **private**. Those reach nothing internal (they are not IPv4-mapped at all), so retiring that stdlib defect necessarily permits addresses the predicates restricted; the two cannot both hold, and the false positive is the one to drop. Every other divergence runs the safe way: two independently written differential sweeps agree on the property — over 606,400 and 600,000 addresses respectively (dense IPv4; random IPv6; dense coverage of every prefix either rule touches; and dense coverage of the pattern that exposes the stdlib defect — bits 80–95 == `ffff` under an arbitrary prefix with an internal-looking low 32 bits), **every** newly-permitted address fell in this class and **none** embedded an internal target. The property is the claim; the absolute counts (54,321 and 71,124 newly permitted) are artefacts of each sweep's sampling weights, are not reproducible from the repo, and are not part of the contract. The property itself **is** pinned in the suite, by an example asserting that the stdlib predicates and this guard disagree on that class — it fails if a future Ruby fixes `IPAddr`. | security report + code + review |
| **SS2** | **Transition addresses are decoded and re-checked, not blanket-blocked.** For NAT64 (`64:ff9b::/96`, RFC6052), 6to4 (`2002::/16`, RFC3056) and Teredo (`2001::/32`, RFC4380 — both the server IPv4 and the XOR-obfuscated client IPv4), the embedded IPv4 is extracted and run through SS1's list; the address is restricted if it is itself in a restricted range or **any** payload it can be read as carrying is. That "any" is deliberate. ISATAP is the reason for it: its marker rides the *interface identifier* rather than the prefix, so it can appear under a prefix the branch above does not match and is therefore tested independently rather than as another arm of that branch. The one visible consequence is that two readings can overlap — a Teredo address whose flags are `0x0000` and whose obfuscated port is `0x5efe` has the same 32 bits read twice under two encodings (`2001:0:4136:e378:0:5efe:a00:1` yields Teredo client `245.255.255.254` *and* ISATAP `10.0.0.1`, and is blocked on the second). It over-blocks, so it fails closed, and it requires an exact flags/port coincidence — an accepted cost of not making the mechanisms mutually exclusive, recorded so it is not mistaken for a decode bug. Decoding is reserved for prefixes that carry real traffic. Where the whole prefix is local or reserved by definition — RFC8215's local-use `64:ff9b:1::/48`, and `::/16` — SS1 restricts it outright, since decoding an address no peer can legitimately hold only adds a branch that can be got wrong. Blanket-blocking those prefixes — the shape the report proposed — is strictly worse: on an IPv6-only network with DNS64, **every** IPv4-only peer is synthesised into `64:ff9b::/96`, so the blanket rule silently ends federation with all of them, and it buys no security, because a NAT64 address embedding a *public* IPv4 was never a threat. RFC 5214 **ISATAP** is decoded too, its marker (`00-00-5E-FE` / `02-00-5E-FE`) read at bits 64..95. **Known limit:** RFC6052 also permits operator-chosen NAT64 prefixes (/32…/64), and RFC 5969 6rd derives its prefix per-operator; neither is statically recognisable, and neither approach covers them. This is a narrowing of the attack surface, not a closure of it. | interview + review |
| **SS3** | **All four call sites widen together, deliberately.** `restricted_ip_address?` gates the outbound federation client (`federation/http_client.rb`), the inbound `POST /api/instances` pre-check and upsert (`routes/ingest.rb`, `federation/instance_records.rb`), and the instance's decision to publish its **own** record (`federation/self_instance.rb`). The last is a behaviour change beyond the reported bug: an instance whose `INSTANCE_DOMAIN` is a literal CGNAT or transition address stops self-registering. That is correct — such an address is not reachable by the peers the record advertises it to — and is recorded here rather than discovered later. Host-address discovery (`public_ip_address?`, `protected_ip_address?`) uses separate `Addrinfo`-aware helpers and is **not** affected — which leaves the two halves of `networking.rb` disagreeing about CGNAT, since discovery would still classify a `100.64.0.0/10` host address as public. No live inconsistency follows (self-registration additionally requires `INSTANCE_DOMAIN_SOURCE == :environment`), and aligning discovery is deliberately out of scope for a security fix. **A second deferral, recorded so it is not lost:** `resolve_remote_ip_addresses` returns `[]` *without* raising whenever `Addrinfo.getaddrinfo` yields no records at all **or** none that parses as an `IPAddr` (the guard is `unique_addresses.any? && …`, so an empty list skips it either way), and `build_remote_http_client` then leaves `Net::HTTP#ipaddr` unset and lets Net::HTTP resolve the host itself — unpinned and unguarded. No trigger could be constructed on Ruby 3.4 (zone-ids parse; a bracketed-IPv6 host raises `Socket::ResolutionError`, which both callers convert to a closed failure), but it is a fail-*open* default on the pin path and predates this fix. Closing it is a separate change. | code + review |
| **SS4** | **Engineering bar (D9).** The restricted and allowed sets are pinned by a table-driven unit spec (`spec/networking_spec.rb`) carrying at least one example per range and per transition mechanism, with the decoding helpers covered directly rather than only through `restricted_ip_address?`, plus end-to-end examples at the real chokepoint (`spec/federation_spec.rb`, through `build_remote_http_client`) — including a positive one asserting an IPv4-only peer behind DNS64 still connects, so SS2's cost model is enforced and not merely asserted. The differential sweep behind SS1 is out-of-band rather than a committed test, since it asserts a relationship to *deleted* code; what **is** committed is the consequence — an example asserting that the stdlib predicates and this guard disagree on the false-positive class, which fails if a future Ruby fixes `IPAddr` and the SS1 prose needs revisiting. Spec tables are block locals, not constants, so generic names do not leak onto `Object`. Full RDoc, Apache header, `rufo`-clean. | CLAUDE.md |
| **SS5** | **Accepted cost: CGNAT peers can no longer federate.** `100.64.0.0/10` is genuine internal space and a genuine SSRF target, but it is also **Tailscale's** allocation, so an operator federating two instances across a tailnet — or reachable only behind carrier NAT — is cut off by SS1 with a `restricted domain` rejection. The range is kept restricted because federation (Invariant III) publishes a domain intended for *arbitrary* peers to resolve and fetch, and an address only reachable from inside one overlay does not satisfy that; an operator who wants overlay-local federation is asking for something the guard cannot distinguish from the reported attack. Recorded as a cost rather than discovered in the field. No escape hatch ships with this fix — adding one is a separate decision, not a bugfix. | review |
