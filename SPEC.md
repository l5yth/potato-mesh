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
| **S6** | **`reticulum` is a forward-looking zero stub.** A `reticulum` scope is always emitted with all-zero counts and an in-code `# stub` comment, so the shape extends to future protocols without another break. It adds **no** ingest path (Invariant I), privileges no protocol (Invariant IV), and does **not** enter `KNOWN_PROTOCOLS` (which still gates the `?protocol=` query param at `meshcore` + `meshtastic`). | interview |
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
| **FS2** | **Every announced count is signed** — the announcement canonical includes `nodes_count`, `meshcore_nodes_count`, `meshtastic_nodes_count`, and a forward-compat `reticulum_nodes_count` (0 until a Reticulum ingestor exists); **no unsigned attribute remains** in the announcement. Counts are still **recomputed** from the peer's live `/api/nodes` on receipt — the signature authenticates the sender's snapshot (integrity), the recompute keeps the displayed figure fresh. | interview |
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
| **AV1** | **Version is the cache key.** Busting is keyed to `PotatoMesh::Application::APP_VERSION` (the existing `git describe --tags --long --abbrev=7` value, or `Config.version_fallback` when git metadata is absent). When the version changes, every asset URL changes and browsers refetch. *Documented limitation:* a build with no git metadata yields a constant fallback version, so an untagged redeploy won't change the buster — the limitation inherent in reusing `APP_VERSION`, accepted here. | interview |
| **AV2** | **`asset_url(path)` helper.** A helper under `web/lib/potato_mesh/application/helpers/` appends `?v=<APP_VERSION>` to an absolute asset path. It is applied to every template-written JS `<script src>`, CSS `<link href>`, and the inline ES-module `import … from '…'` specifiers in `charts.erb`, `federation.erb`, `node_detail.erb`. | interview |
| **AV3** | **Full module-graph busting via import map.** Because `?v=` on an entry-point URL does **not** propagate to that module's relative `import './x.js'`, the layout `<head>` emits exactly one `<script type="importmap">` (before any module loads) mapping every served production `/assets/js/**/*.js` module (excluding `__tests__`) to its `?v=<APP_VERSION>` URL. This invalidates the whole transitive graph (e.g. `main.js` + its 33 imports), not just the entry points. **Safety property:** a module absent from the map degrades to today's unversioned-but-working load — a missing entry can never break a working import. Browsers without import-map support degrade to today's behavior (entry points still busted via AV2). | interview |
| **AV4** | **Scope = JS + CSS only; native, no new egress.** Only executable/style assets are versioned (all JS + `base.css`). Images, favicons, and SVG icons keep today's `Last-Modified`/`ETag` revalidation (a stale logo is cosmetic, not behavioral). The mechanism uses the native browser import-map feature — **no new dependency, build step, external host, or analytics param** — so apex (I), privacy (II), federation (III), parity (IV), fixed-stack (D7), contract (D8), and no-phone-home (D11) all hold unchanged. The version query is not part of any `/api/*` contract (D8): Sinatra serves the same static file regardless of query string. | interview |
| **AV5** | **Engineering bar (D9).** The helper and import-map builder ship with 100% unit tests + RDoc, Apache headers, `rufo`-clean; all existing suites stay green. View/app specs that assert exact asset markup are **updated** to the versioned form, not removed. | CLAUDE.md |

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
| **LV7** | **Log tab logs every live-event class.** The chat **Log** tab gains an entry for every live collection, closing today's gaps: **plaintext** chat messages now appear in the Log (previously only encrypted did); every one of nodes/messages/positions/telemetry/neighbors/traces has a Log representation. Presentation-only, protocol-neutral; honours the hidden-protocol and PRIVATE gates already applied to the chat. | interview |
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
| **DM1** | **Provider swap to CARTO Dark Matter.** The single, de-duplicated tile-URL constant becomes `https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png` (subdomains `abcd`, `detectRetina` for the `{r}` HiDPI suffix), replacing `https://{s}.tile.openstreetmap.fr/hot/…` on **both** the dashboard map (`main.js`) and the federation map (`federation-page.js`). Keyless public CDN; returns `access-control-allow-origin: *` so the existing `crossOrigin:'anonymous'` is satisfied; natively dark-grey, so "keep the dark/grey style" holds with no filter. | interview + probe |
| **DM2** | **Native dark style; the CSS tile-filter pipeline is removed.** Dark Matter is already styled, so the per-theme `grayscale/invert` filter (which existed only to grey out the colourful HOT tiles and is the last **light-theme** remnant) is deleted end-to-end: Ruby `DEFAULT_TILE_FILTER_LIGHT`/`DEFAULT_TILE_FILTER_DARK`, `map_tile_filter_light`/`map_tile_filter_dark`, `tile_filters`, and the `tileFilters` key in `frontend_app_config` (`config_helpers.rb`); JS `TILE_FILTER_LIGHT`/`TILE_FILTER_DARK`, `resolveTileFilter` + the tile filter-application/MutationObserver machinery in `main.js`, `applyTileFilter`/`resolveTheme`/`themechange` in `federation-page.js`, `tileFilters` in `settings.js`, and the `window.applyFiltersToAllTiles` hook in `theme.js`; CSS `--map-tile-filter-light`, `--map-tiles-filter`, and the `.map-tiles { filter: … }` rules in `base.css`. The broader theme system is already dark-only (`resolve_initial_theme` returns `"dark"`). | interview |
| **DM3** | **Tolerate isolated tile errors (dashboard).** The first `tileerror` no longer flips the whole map to the offline placeholder. Isolated tile failures remain individual blank tiles (Leaflet default); `activateOfflineTiles` fires **only** when the basemap is comprehensively unavailable — **zero** successful tile loads across the initial viewport (provider unreachable/blocked). After **any** successful `tileload` the basemap is latched "alive" and subsequent isolated `tileerror`s never trigger the offline switch; recovery is automatic on later loads. The offline `GridLayer` (`main/offline-tile-layer.js`) is retained as the last-resort fallback. The federation map has no kill-basemap logic today, so it receives only DM1+DM2. | interview |
| **DM4** | **Adjacent light remnants removed.** `<meta name="color-scheme" content="dark light">` → `content="dark"` (`views/layouts/app.erb`); `background.js`'s `body.classList.contains('dark') ? '#0e1418' : '#f6f3ee'` ternary collapses to the dark colour `'#0e1418'`. (The broader dead light **CSS palette** is handled separately by DM7.) | interview |
| **DM5** | **No attribution overlay (keep the clean look).** The map keeps `attributionControl:false` as today; no `© OpenStreetMap / © CARTO` credit is rendered. Accepted trade-off: this under-attributes CARTO/OSM — the same posture already taken with the HOT tiles — and is chosen to preserve the existing clean map style. | interview |
| **DM6** | **Engineering bar & invariants (D9).** No server-side broker/dependency/egress; no `/api/*` or `/version` contract change; protocol-neutral. Every changed JS/Ruby unit ships with 100% unit tests (existing tile-filter specs are **updated or removed-as-dead**, never left dangling), JSDoc/RDoc, the exact Apache header, and `rufo`/`black`-clean formatting; all existing suites stay green. | D9 + proposed |
| **DM7** | **Dead light CSS palette collapsed (dark-only).** `base.css` carried a full light token palette in `:root`, always overridden by an always-applied `body.dark { … }` token block, plus `html { color-scheme: light }`. Since `body` is always `dark` (`resolve_initial_theme` is fixed `"dark"`), the light half never rendered. The dual palette is collapsed to a **single dark `:root`** (the former `body.dark` token values promoted up, so `html` itself resolves dark tokens too), the `body.dark` *token* block and the light/`data-theme` `color-scheme` rules are removed, and `html { color-scheme: dark }`. `body.dark` *component* rules are untouched (still apply, `body` always has the class), so the rendered dark appearance is unchanged — verified by screenshot. | interview (scope expansion, approved) |

