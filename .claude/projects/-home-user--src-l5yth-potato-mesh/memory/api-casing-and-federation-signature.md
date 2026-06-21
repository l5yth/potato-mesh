---
name: api-casing-and-federation-signature
description: API JSON casing map + the camelCase federation-signature landmine
metadata:
  type: project
---

**Federation instance signatures are computed over camelCase canonical keys.**
`web/lib/potato_mesh/application/federation/signature.rb` `canonical_instance_payload`
signs `JSON.generate({contactLink, id, domain, pubkey, name, version, channel,
frequency, latitude, longitude, lastUpdateTime, isPrivate}, sort_keys: true)`. So
the federation wire — `/.well-known/potato-mesh`, `GET /api/instances`
(`instances.rb` `normalize_instance_row`), the announcement payload
(`self_instance.rb`) — **must stay camelCase**. Renaming any signed key breaks
cross-version signature verification **bilaterally** (no "emit both keys" shim
fixes a signature). Treat this as immovable without a signature-version scheme.

**HTTP API casing map (as of 0.7.0):**
- Read collections (`/api/nodes`, `/api/messages`, `/api/positions`,
  `/api/telemetry`, `/api/traces`, `/api/neighbors`) and `/api/stats`: **snake_case**
  already (`query_nodes` selects snake columns; matrix reads `rx_time`).
- `/version`: **snake_case** since 0.7.0 (was the lone camelCase read response).
- `POST /api/nodes` **input**: Meshtastic camelCase, but `upsert_node` now also
  accepts snake via nil-aware `pick_alias` (camel preferred → ingestor unaffected).
- Federation wire: **camelCase** (signed — see above).

**Gotchas that cost time:**
- `/api/nodes` camelCase you see in the frontend is the POST input, the client
  `normalizeNodeCollection` internal model, and `?? shortName` fallbacks — NOT the
  GET response. Don't "snake-case /api/nodes"; it already is.
- The dashboard frontend reads config from the server-rendered `data-app-config`
  attribute (`views/layouts/app.erb`, helper `frontend_app_config`), **not** from
  `/version`. The matrix bridge only pings `/version` for liveness (no key reads).
  The Flutter app *does* read `/version` config keys (`app/lib/main.dart`) — the
  one consumer that breaks on a `/version` casing change.

See [[web-app-local-run]] for running the server to curl these.
