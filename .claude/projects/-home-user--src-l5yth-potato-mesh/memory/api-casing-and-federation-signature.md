---
name: api-casing-and-federation-signature
description: API JSON casing map + the federation signature v2 (snake) migration
metadata:
  type: project
---

**Federation wire is snake_case "signature v2" since the 0.7.0 line (FS1–FS6 in
SPEC.md).** It used to be camelCase-and-immovable (BF3, now superseded). The whole
federation surface — `/.well-known/potato-mesh`, `GET /api/instances`
(`instances.rb` `normalize_instance_row`), and the announcement payload
(`self_instance.rb` `instance_announcement_payload`) — now emits snake_case:
`public_key` (was `publicKey`/`pubkey`), `last_update` (was
`lastUpdate`/`lastUpdateTime`), `is_private`, `contact_link`, `nodes_count`,
`meshcore_nodes_count`, `meshtastic_nodes_count`, `reticulum_nodes_count`
(forward-compat stub, always 0), plus `signature_algorithm`, `signed_payload`,
`signature_version`. Single-token keys (`id`, `domain`, `name`, `version`,
`channel`, `frequency`, `latitude`, `longitude`, `signature`) unchanged. DB
columns (`pubkey`, `last_update_time`) stay internal, mapped at the wire boundary.

**How the migration works (`federation/signature.rb`):**
- One shared `canonical_signed_payload(fields)` builds the snake canonical and
  stamps `signature_version` *inside the signed bytes* (anti-downgrade). Used by
  both signers (instance announcement + well-known) — option U0.
- `canonical_instance_payload` signs the **v2** (snake) form, now including ALL
  node counts (FS2 — no unsigned attribute remains).
- `verify_instance_signature` tries **v2 (snake) then v1 (camel)** canonical →
  accept-both. `canonical_instance_payload_v1` is kept verbatim for the v1 path.
- The break is **one-way** (FS5): old peers can't verify our v2 signature (stop
  accepting us until they upgrade); we still accept their v1 → mixed fleet
  converges. `config.federation_signature_version` = 2.
- Parsers read both casings: `crawl.rb` `remote_instance_attributes_from_payload`
  + `routes/ingest.rb` POST `/api/instances` + `federation/validation.rb`
  `validate_well_known_document` (e.g. `payload["public_key"] || payload["publicKey"]`).

**Signed counts are stored/served/relayed verbatim (decision (a)).** Because the
crawl re-verifies relayed `/api/instances` entries' signatures over their counts
(`crawl.rb`), the old recompute-on-store would break relay re-verification when
the recomputed value diverged from the signed snapshot. So the recompute in
`ingest.rb` and `crawl.rb` is now a **count-absent fallback only** — present
(signed) counts are kept so the canonical re-builds identically downstream.

**HTTP API casing map (0.7.0 line):**
- Read collections (`/api/nodes`, `/api/messages`, `/api/positions`,
  `/api/telemetry`, `/api/traces`, `/api/neighbors`) and `/api/stats`,
  `/version`: **snake_case**.
- `POST /api/nodes` / `POST /api/instances` **input**: accept camelCase AND
  snake (nil-aware `pick_alias` / `a || b`).
- Federation wire: **snake_case v2** (signed — see above).

**Gotchas:**
- Frontend `federation-page.js` reads `/api/instances` dual (`x.snake ?? x.camel`)
  so it survives either casing; `federation-instance-display.js` only reads
  `name`/`domain` (casing-safe).
- RSpec `stub_const(name, value)` does **NOT** take a block — `stub_const(...) do
  … end` silently skips the block body (vacuous test). `app_spec.rb` had several
  such blocks (`build_well_known_document` + the `.self_instance_domain` /
  `.self_instance_registration_decision` / `.ensure_self_instance_record!`
  describes); **all now converted to inline `stub_const`** and genuinely run — no
  block-form `stub_const` remains in the specs. Use the value form
  `stub_const("X", Class.new do … end)` only when the block belongs to `Class.new`.
- The Flutter app reads `/version` config keys (one consumer that breaks on a
  `/version` casing change); it does NOT consume the federation wire.

See [[web-app-local-run]] for running the server to curl these.
