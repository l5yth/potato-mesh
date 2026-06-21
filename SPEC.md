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
