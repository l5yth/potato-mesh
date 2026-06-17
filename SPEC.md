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
