<!-- Copyright © 2025-26 l5yth & contributors -->
<!-- Licensed under the Apache License, Version 2.0 (see LICENSE) -->

# PotatoMesh — Acceptance Criteria

> **Purpose.** Precise, command-backed pass/fail criteria for the invariants and
> decisions in [`SPEC.md`](./SPEC.md). A reviewer with **zero context from the
> design session** can judge a result against this file alone: run the command,
> compare to the expected result, record PASS/FAIL.
>
> **Format sources (cited per the kickoff protocol).** The engineering-bar
> criteria (Layer B) restate [`CLAUDE.md`](./CLAUDE.md); the API/event-contract
> criteria (Layer C) restate
> [`data/mesh_ingestor/CONTRACTS.md`](./data/mesh_ingestor/CONTRACTS.md). Those
> two files are authoritative if any wording here drifts.

## How to use this document

1. Do the one-time **Setup** below.
2. Run each check in Layers **A–D**. Each check states a **command** and an
   **Expected** result. Commands are written for a POSIX shell at the **repo
   root** unless noted.
3. Record **PASS/FAIL** per check, pasting the command output.
4. Apply the **Verdict rule**. Pre-existing, tracked deviations are listed under
   [§ Known gaps](#known-gaps); they remain FAIL until fixed.

### Setup (one-time)

```bash
# Web (Ruby + JS)
( cd web && bundle install && npm ci )
# Python ingestor
python -m venv .venv && . .venv/bin/activate \
  && pip install -r data/requirements.txt black pytest pytest-cov
# Rust bridge: stable toolchain + cargo (rustup)            # for Layer B/D
# Flutter app: flutter SDK on PATH                          # for Layer B/D
```

### Test server helpers

Some checks need a running web app. Start it with the env the check specifies,
then `kill` it afterward. Examples:

```bash
# Privacy checks (Layer A2): private mode, federation off
( cd web && API_TOKEN=acctest PRIVATE=1  FEDERATION=0 bundle exec ruby app.rb ) &  SRV=$!
# Auth / contract checks (Layer C): public mode, known token
( cd web && API_TOKEN=acctest PRIVATE=0  FEDERATION=0 bundle exec ruby app.rb ) &  SRV=$!
# ... run curl checks ...
kill "$SRV"
```

### Verdict rule

A result **PASSES** acceptance only when **every** check in Layers A, B, and C
passes and **every** Layer-D check matches documented behavior. Any FAIL not
already listed in [§ Known gaps](#known-gaps) blocks acceptance. The apex check
**A1** is a hard gate: a FAIL there fails the whole review regardless of anything
else (SPEC §1).

---

## Layer A — Invariant conformance

Maps to SPEC §1–§2 and decisions **D2, D3, D4**.

### A1 — Apex: no MQTT / cloud data path *(hard gate)*  — SPEC Invariant I

**A1a. No broker/cloud-bus dependency in any manifest.**
```bash
git grep -niE 'mqtt|mosquitto|paho|amqp|kafka|broker' -- \
  web/Gemfile web/Gemfile.lock data/requirements.txt \
  matrix/Cargo.toml matrix/Cargo.lock app/pubspec.yaml app/pubspec.lock
```
**Expected:** no output.

**A1b. No broker connection in code (provenance flag excepted).**
```bash
git grep -niE 'mqtt|mosquitto|paho|amqp|kafka|broker' -- \
  '*.rb' '*.py' '*.rs' '*.dart' '*.js' | grep -viE 'via_?mqtt'
```
**Expected:** no output. The only legitimate matches are Meshtastic's
`via_mqtt` / `viaMqtt` **provenance flag** (`data/mesh_ingestor/handlers/nodeinfo.py`),
which is filtered out here and is explicitly permitted by SPEC §1 (it is metadata
about a *foreign* node, not PotatoMesh acting as an MQTT client).

### A2 — Privacy & consent first — SPEC Invariant II

*Run the server with `PRIVATE=1`.*

**A2a. Message API is disabled in private mode.**
```bash
curl -s -o /dev/null -w 'GET  %{http_code}\n' http://127.0.0.1:41447/api/messages
curl -s -o /dev/null -w 'POST %{http_code}\n' -X POST \
  -H 'Authorization: Bearer acctest' http://127.0.0.1:41447/api/messages -d '[]'
```
**Expected:** both `404` (the `before "/api/messages*"` filter halts 404 in
private mode — `web/lib/potato_mesh/application/routes/api.rb:49`).

**A2b. Private flag is advertised (the client uses it to hide chat).**
```bash
curl -s http://127.0.0.1:41447/version | grep -o '"private_mode":true'
```
**Expected:** prints `"private_mode":true` (snake_case as of 0.7.0 — see
[§ Bugfix: API casing consistency](#bugfix-api-casing-consistency)).

**A2c. Node opt-out marker is honored wherever data is listed/exported.**
```bash
git grep -lE 'opt_out_self_filter|opt_out_node_id_filter|NODE_OPT_OUT_MARKER' -- web/lib | sort
```
**Expected:** the opt-out filter appears in the read/export paths — at minimum
`application/queries/chat_queries.rb`, `application/identity.rb`, and
`application/federation/instance_metrics.rb`. Behavior is covered by the Ruby
suite (Layer B1).

### A3 — Decentralized, opt-in federation; `PRIVATE` > `FEDERATION` — SPEC Invariant III, D4

**A3a. `federation_enabled?` is opt-in and overridden by privacy.** Open both
definitions and confirm the predicate is true only when `FEDERATION` is on **and**
the instance is **not** private:
```bash
git grep -nA12 'def federation_enabled\?' -- \
  web/lib/potato_mesh/config.rb web/lib/potato_mesh/application/helpers/config_helpers.rb
```
**Expected:** the logic requires federation enabled **and** `!private_mode?`
(concrete form of Privacy > Federation, SPEC §3.1).

**A3b. No central authority / hardcoded directory host.** Peers are discovered by
crawl, not from a baked-in registry:
```bash
git grep -nhoE 'https?://[A-Za-z0-9.-]+' -- web/lib/potato_mesh/application/federation \
  | grep -viE 'apache\.org|w3\.org|schema|example|localhost|127\.0\.0\.1' | sort -u
```
**Expected:** no hardcoded third-party "central" host (matches are only standards
URLs in comments, if any).

**A3c. Federation behavior is covered by tests.**
```bash
( cd web && bundle exec rspec spec -e federation )
```
**Expected:** federation specs pass (opt-in, isolation when `FEDERATION=0`,
privacy override, staleness eviction).

### A4 — Protocol parity & pluggability — SPEC Invariant IV

**A4a. Both protocols are first-class, neither privileged.**
```bash
git grep -n 'KNOWN_PROTOCOLS' -- web/lib/potato_mesh/application/routes/api.rb
```
**Expected:** the whitelist is exactly `meshcore` + `meshtastic`
(`KNOWN_PROTOCOLS = Set.new(%w[meshcore meshtastic])`); classification is
data-driven, not a per-protocol control-flow fork.

**A4b. A protocol plugs in behind `MeshProtocol` without touching the read-side.**
```bash
. .venv/bin/activate && pytest -q tests/test_provider_unit.py
```
**Expected:** pass (includes an `isinstance(..., MeshProtocol)` conformance check
and error/retry paths). The contract that new protocols must preserve — and the
fact that the Ruby/DB/UI read-side stays unchanged — is documented in
`CONTRACTS.md` and the *"Adding a New Ingestor Protocol"* section of `CLAUDE.md`.

### A4c — Chat name resolution honors protocol (no cross-protocol quoting)
```bash
( cd web && node --test public/assets/js/app/__tests__/meshcore-chat-helpers.test.js \
                       public/assets/js/app/__tests__/chat-entry-renderer.test.js )
```
**Expected:** pass. In the chat UI a MeshCore message resolves a sender/quote/
mention name **only** to a MeshCore node — never to a same-named Meshtastic node
(names collide across protocols, so the lookup must filter by the message's
protocol instead of taking the first match). When no same-protocol node matches,
a synthetic node carrying the message's protocol is rendered rather than
borrowing a node from another protocol (`findNodeByLongName(longName, nodesById,
protocol)` + `chat-entry-renderer.js`). Concrete UI form of SPEC Invariant IV
(protocol parity; neither protocol privileged in the data model or UI).

### A4d — Custom radio-config label is protocol-neutral (regression: c8668a7)
```bash
( . .venv/bin/activate && pytest -q tests/test_interfaces_unit.py::TestCustomPresetLabelParity )
```
**Expected:** pass. A Meshtastic custom LoRa config (`use_preset=False`) renders
the **same** compact `SF/BW/CR` label as MeshCore's `_derive_modem_preset` for
identical SF/BW/CR — no protocol-specific `"Custom "` prefix — and returns `None`
(not a bare `"Custom"`) when the parameters are unreported, so one radio config
never displays as two different strings depending on protocol (SPEC Invariant IV).

### A4e — MeshCore captures adverts from other nodes (regression: adverts gap)
```bash
( . .venv/bin/activate && pytest -q tests/test_provider_unit.py \
    -k "advert or is_known_contact or auto_update" )
```
**Expected:** pass. The MeshCore provider does not depend on the radio's auto-add
setting to learn about other nodes. `_run_meshcore` sets
`mc.auto_update_contacts = True` (so the library re-fetches changed contacts on
every `ADVERTISEMENT` / `PATH_UPDATE` push — a re-advert from a known node
refreshes its position / `last_advert` without a reconnect) **and** subscribes an
`ADVERTISEMENT` handler that, for a public key **not** in the contact roster,
upserts a minimal "heard now" node (`_advert_to_node_dict`: `lastHeard` +
`protocol` + `user.shortName`/`publicKey`, no name/type/position) while skipping
keys already tracked (`_MeshcoreInterface.is_known_contact`). This surfaces nodes
the radio will not auto-add (manual-add / observer mode) without clobbering richer
records. Local-LoRa RX only — no broker, no new ingest path (SPEC Invariants I/IV).
Documented under *"MeshCore advert sourcing"* in `CONTRACTS.md`.

---

## Layer B — Engineering bar (restated from `CLAUDE.md`)

Maps to decision **D9**. Commands mirror the CI workflows so local results match CI.

### B1 — All test suites green
```bash
( cd web && bundle exec rspec )                          # Ruby
( cd web && npm test )                                    # JavaScript
( . .venv/bin/activate && pytest -q tests/ )              # Python
( cd matrix && cargo test --all --all-features )          # Rust
( cd app && flutter test )                                # Flutter
```
**Expected:** every suite exits 0.

### B2 — Coverage: 100% target, 10% threshold, on project **and** patch
```bash
grep -A14 '^coverage:' .codecov.yml
```
**Expected:** `status.project.default` **and** `status.patch.default` each set
`target: 100%` and `threshold: 10%`. Per-language coverage is produced by the
suites in B1 (SimpleCov for Ruby, `pytest-cov`, `cargo llvm-cov`, `flutter
--coverage`, V8 for JS) and enforced server-side by Codecov.
> See [§ Known gaps](#known-gaps): the `patch` block is currently missing.

### B3 — 100% API documentation (language standard)
```bash
( cd matrix && RUSTDOCFLAGS='-D warnings' cargo doc --no-deps )   # Rust: no doc warnings
```
**Expected:** `cargo doc` builds with no warnings. For Ruby (RDoc), Python
(PDoc), JS (JSDoc), and Dart (dartdoc) there is no single gating command, so the
criterion is: **every public module/class/method/function carries a doc comment
in the language standard** (plus inline comments where logic is non-obvious).
A reviewer confirms by opening each file changed in the diff; existing files such
as `web/lib/potato_mesh/application/data_processing/request_helpers.rb` show the
expected `@param`/`@return` RDoc density.

### B4 — Apache v2 notice on every file (exact string)

**B4a. Source files carry the full header.**
```bash
git ls-files '*.rb' '*.py' '*.js' '*.rs' '*.dart' \
  | grep -vE '(^|/)(vendor|node_modules|build|\.dart_tool)/' \
  | xargs grep -L 'Copyright © 2025-26 l5yth & contributors'
```
**Expected:** no output (every source file contains the exact notice
`Copyright © 2025-26 l5yth & contributors`).

**B4b. Non-source text files carry the 2-line notice** (where the format allows
comments):
```bash
git ls-files '*.yml' '*.yaml' '*.toml' 'Dockerfile' '*/Dockerfile' '*.md' '*.sh' '*.nix' \
  | xargs grep -L 'Copyright © 2025-26 l5yth & contributors'
```
**Expected:** no output, except the documented exemptions in
[§ Known gaps / exemptions](#known-gaps) (formats without comment syntax — e.g.
JSON fixtures, `*.lock` files — are exempt).

### B5 — Formatters & linters clean
```bash
( . .venv/bin/activate && black --check ./ )                                   # Python
( cd web && bundle exec rufo --check . )                                        # Ruby
( cd matrix && cargo fmt --all -- --check \
            && cargo clippy --all-targets --all-features -- -D warnings )       # Rust
( cd app && dart format --set-exit-if-changed . && flutter analyze )            # Flutter
```
**Expected:** every command exits 0.

### B6 — CI runs on PRs to `main` and pushes to `main`
```bash
for w in python ruby rust mobile javascript; do
  echo "== $w =="; grep -A8 '^on:' ".github/workflows/$w.yml"
done
```
**Expected:** each workflow triggers on `pull_request` and on `push` to `main`,
and covers the relevant suite(s) for the component(s) it touches.

### B7 — Weekly Dependabot for every ecosystem
```bash
grep -E 'package-ecosystem|directory|interval' .github/dependabot.yml
```
**Expected:** entries for `ruby` (`/web`), `npm` (`/web`), `python` (`/data`),
`cargo` (`/matrix`), `pub` (`/app`), and `github-actions` (`/`) — **every
language in the repo present**, each with `interval: "weekly"`.

---

## Layer C — API & event contracts (restated from `CONTRACTS.md`)

Maps to decision **D8**. *Run the server with `PRIVATE=0` and `API_TOKEN=acctest`.*

### C1 — POST routes require a valid bearer token
```bash
curl -s -o /dev/null -w 'no-token   %{http_code}\n' \
  -X POST http://127.0.0.1:41447/api/nodes -d '{}'
curl -s -o /dev/null -w 'wrong-token %{http_code}\n' \
  -X POST -H 'Authorization: Bearer wrong' http://127.0.0.1:41447/api/nodes -d '{}'
curl -s -o /dev/null -w 'good-token  %{http_code}\n' \
  -X POST -H 'Authorization: Bearer acctest' http://127.0.0.1:41447/api/nodes -d '{}'
```
**Expected:** `403` for missing and wrong tokens (constant-time compare in
`require_token!`); the valid-token request is **not** `403` (it is accepted, or
`400` only if the body is malformed).

### C2 — Canonical payload shapes validated by the integration suite
```bash
. .venv/bin/activate && pytest -q tests/test_mesh.py
```
**Expected:** pass. `CONTRACTS.md` states the `POST` shapes
(`nodes`/`messages`/`positions`/`telemetry`/`neighbors`/`traces`/`ingestors`),
sentinel normalization (issue #782), protocol stamping/propagation, and dedup are
"validated by existing tests (notably `tests/test_mesh.py`)."

### C3 — Canonical node id is `!%08x` on both sides
```bash
git grep -nE '_canonical_node_id' -- data/mesh_ingestor/serialization.py
git grep -nE 'canonical_node_parts' -- web/lib/potato_mesh/application/data_processing.rb
. .venv/bin/activate && pytest -q tests/test_node_identity_unit.py tests/test_serialization_unit.py
```
**Expected:** both normalizers exist; the id unit tests pass (lowercase 8-hex
`!abcdef01` form; dual numeric/canonical addressing).

### C4 — GET window floors cannot be widened by the caller
```bash
git grep -nE 'week_seconds|four_weeks_seconds' -- web/lib/potato_mesh/config.rb
```
**Expected:** the 7-day / 28-day window constants exist. Per `CONTRACTS.md`
("GET endpoint time windows"), `?since=<n>` is clamped to `MAX(since, floor)`;
this clamp is exercised by the Ruby suite (B1).

### C5 — Cross-ingestor dedup by id
```bash
git grep -nE 'MESHCORE_CONTENT_DEDUP_WINDOW_SECONDS' -- web/lib
```
**Expected:** the content-dedup window constant exists. `messages.id` PRIMARY-KEY
collapse and the MeshCore content-dedup (issue #756) are covered by
`tests/test_mesh.py` (C2). Ids must fit in 53 bits (JS-safe).

### C6 — Per-record protocol stamp precedence
**Expected (covered by C2 + A4):** an explicit per-record `protocol` (in the
`{meshtastic, meshcore}` whitelist) wins over the ingestor-heartbeat default,
which wins over `meshtastic` as the final fallback — exactly as `CONTRACTS.md`
("Protocol propagation") specifies. Values outside the whitelist fall through.

### C7 — Chat feed is fully paginable within the window (issue #796 regression)
```bash
( cd web && bundle exec rspec spec/app_spec.rb -e "backward pagination" )
```
**Expected:** pass. `GET /api/messages` accepts a `before=<rx_time>` upper-bound
cursor that only *narrows* the result set (the 7-day floor and the per-request
`MAX_QUERY_LIMIT` cap are unchanged, so C4 still holds). With more than
`MAX_QUERY_LIMIT` messages inside the seven-day window, paging backward by
`before` recovers **every** in-window message instead of stalling at the newest
1000 — the landing page and `/chat` subpage page until the window is exhausted.

---

## Layer D — Operator-facing behavior

Maps to decisions **D10, D11** and the README. *Server env per check.*

### D1 — Documented config surfaces through `/version`
```bash
curl -s http://127.0.0.1:41447/version
```
**Expected:** a JSON `config` block exposing `site_name`, `channel`, `frequency`,
`contact_link`, `map_center` (`lat`/`lon`), `max_distance_km`, `instance_domain`,
and `private_mode`, reflecting the env vars set at boot (README "Web App" table).
Keys are snake_case as of 0.7.0 (see
[§ Bugfix: API casing consistency](#bugfix-api-casing-consistency)).

### D2 — `ALLOWED_CHANNELS` / `HIDDEN_CHANNELS` enforced (ingestor)
```bash
. .venv/bin/activate && pytest -q tests/test_channels_unit.py
```
**Expected:** pass. The allow-list discards all other channels *before* the
hidden filter; hidden channels are dropped (`data/mesh_ingestor/channels.py`).

### D3 — Opt-out marker excludes nodes from public listings
```bash
git grep -lE 'opt_out_self_filter|NODE_OPT_OUT_MARKER' -- web/lib | sort
```
**Expected:** the opt-out filter is applied across listing/export/federation
queries (same artifact as A2c); behavior covered by the Ruby suite (B1).

### D4 — Retention & staleness windows are wired in
```bash
git grep -nE 'start_retention_worker|retention_thread|def .*retention' -- \
  web/lib/potato_mesh/application/retention.rb web/lib/potato_mesh/application.rb
```
**Expected:** a retention worker is started by the app. Combined with the GET
floors (C4) and the README's federation windows (8 h peer refresh, 72 h staleness
eviction), stale data is bounded. Federation freshness lives in
`application/federation/validation.rb`.

### D5 — WIP components are read-only (no radio, no new ingest path) — D10

**D5a. Matrix bridge touches no radio and posts to no ingest route.**
```bash
git grep -niE 'serial|bluetooth|/dev/tty|meshtastic|meshcore' -- matrix/src
git grep -niE '/api/(nodes|messages|positions|telemetry|neighbors|traces|ingestors)' -- matrix/src
```
**Expected:** first command: no output (no radio). Second: only **read** usage of
the public API (the bridge consumes messages); **no POST to ingest routes.**

**D5b. Mobile app is a GET-only reader.**
```bash
git grep -niE '\.post\(|/dev/tty|serial|bluetooth' -- app/lib
```
**Expected:** no ingest `POST`, no radio interface — the app only `GET`s from the
public API.

### D6 — Stack frozen per component (SPEC §3.2) — D7
```bash
grep -E 'gem "sinatra"'        web/Gemfile          # Ruby + Sinatra ~> 4
grep -E 'meshtastic|meshcore'  data/requirements.txt # Python: both libs
grep -E 'axum|reqwest|tokio'   matrix/Cargo.toml     # Rust bridge
grep -E '^\s*flutter:'         app/pubspec.yaml      # Flutter app
```
**Expected:** each manifest matches the locked stack; no language/framework swap.

---

## Known gaps (pre-existing, tracked — not introduced by work under review)

These deviate from the bar above and are surfaced by the Phase 2 environment
audit. They are **FAIL** until fixed, but a reviewer should attribute them to the
existing codebase, not to the change under review.

- **B2 — `.codecov.yml` has no `patch` block.** It defines only
  `coverage.status.project.default` (target 100% / threshold 10%); `CLAUDE.md`
  requires the same on **patch**. Fix tracked in the Phase 2 audit.
- **B4 — header-check exemptions are conventional, not codified.** Formats
  without comment syntax (JSON fixtures under `tests/`, `*.lock` files, binary
  assets) cannot carry the notice; there is no committed allow-list or CI check
  asserting headers. The B4 commands above are the interim verification.

---

## Feature: Chat channel test-deprioritization

Maps to SPEC decisions **F1–F4**. The ordering logic lives in
`web/public/assets/js/app/chat-log-tabs.js` (`buildChatTabModel`); behavior is
verified by the JS unit suite.

### F-A1 — Three-tier channel ordering (default → custom → test) — F1
```bash
( cd web && node --test public/assets/js/app/__tests__/chat-log-tabs.test.js )
```
**Expected:** pass. Given a default/primary channel (index 0, e.g. "Public"), a
custom channel (index > 0, e.g. "#BerlinMesh"), and a test channel (index > 0,
e.g. "#test"), `buildChatTabModel(...).channels` returns them in the order
**[default, custom, test]** — every test channel sorts after every non-test
channel regardless of 7-day activity. Within each tier the prior ordering
(message-count descending, then label alphabetical) is unchanged.

### F-A2 — Word-boundary test detection (ping/test/bot), no false positives — F2
```bash
( cd web && node --test public/assets/js/app/__tests__/chat-log-tabs.test.js )
```
**Expected:** pass. A channel label is classified **test** iff it contains the
standalone word `ping`, `test`, or `bot` (case-insensitive, matched at word
boundaries). So "#test", "Ping", "my bot", "test channel" are test; **"Camping",
"Robotics", "Contest", "Botswana" are NOT** and keep their custom-tier position.

### F-A3 — Primary/default channel is never demoted — F3
**Expected (covered by the F-A1 suite):** an index-0 channel whose label matches a
keyword (e.g. a primary literally named "test") still sorts in the default tier
(first), never the test tier — the main community feed always leads.

### F-A4 — Presentation-only, protocol-neutral — F4
**Expected (covered by the F-A1 suite + A4c):** reordering changes only tab
order — each channel's `messageCount`, `entries`, and `id` are unchanged, and the
default-active tab stays the primary. Detection is by channel name, so a MeshCore
"#test" and a Meshtastic "#test" are demoted identically (no protocol privileged).

### F-R1 — Regression: prior acceptance still holds
```bash
( cd web && npm test ) && ( cd web && bundle exec rspec )
```
**Expected:** every prior check still passes. At risk and explicitly required to
remain green: **A4c** (chat name resolution honors protocol — same render path)
and **B1** (all suites). The existing two-tier ordering assertions in
`chat-log-tabs.test.js` are **updated** to the three-tier order, not removed.

---

## Feature: /api/stats activity counts (messages & telemetry)

Maps to SPEC decisions **S1–S7**. The counts are produced by
`query_active_node_stats` (`web/lib/potato_mesh/application/queries/node_queries.rb`),
serialized by the `GET /api/stats` route (`application/routes/api.rb`), and
consumed for federation by `application/federation/crawl.rb`. Unless a check says
otherwise, start the server in **public** mode
(`API_TOKEN=acctest PRIVATE=0 FEDERATION=0 bundle exec ruby app.rb`).

### S-A1 — Breaking, versioned response shape (scope × metric tree) — S1, S2, S3
```bash
curl -s http://127.0.0.1:41447/api/stats \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); \
SC=("total","meshcore","meshtastic","reticulum"); ME=("nodes","messages","telemetry"); WI=("hour","day","week","month"); \
print(all(isinstance(d[s][m][w],int) for s in SC for m in ME for w in WI) and d["sampled"] is False and "active_nodes" not in d)'
git grep -nA2 'def version_fallback' -- web/lib/potato_mesh/config.rb
. .venv/bin/activate && pytest -q tests/test_version_sync.py
```
**Expected:** the Python check prints `True` — the payload is the tree
`{ total, meshcore, meshtastic, reticulum }`, each scope carrying
`{ nodes, messages, telemetry }`, each metric carrying integer
`{ hour, day, week, month }`, with `sampled` still present and `false`. The old
flat keys (`active_nodes`, integer-valued `meshcore`/`meshtastic`) are **gone** —
this is the intended, versioned break. `version_fallback` returns `"0.7.1"`, and
`test_version_sync.py` **passes** — the bump is applied in lockstep across all
five language manifests (`data.VERSION`, `Config.version_fallback`,
`web/package.json`, `app/pubspec.yaml`, `matrix/Cargo.toml`; `matrix/Cargo.lock`
is updated to match). The matching `git tag v0.7.0` is the maintainer release
step. `data/mesh_ingestor/CONTRACTS.md` documents the new `GET /api/stats` shape
and notes the 0.7.0 break. Full shape is asserted by the Ruby suite (S-A2/S-A3).

### S-A2 — `total` is unfiltered; protocol scopes are subsets; node counts preserved — S2
```bash
( cd web && bundle exec rspec spec/queries_spec.rb -e "active_node_stats" )
```
**Expected:** pass. With nodes seeded across protocols, `query_active_node_stats`
returns `total.<metric>` = counts over **all** rows and
`meshcore`/`meshtastic`/`reticulum` = `protocol = ?` subsets (so
`total ≥ Σ named protocols`). `total.nodes.{hour,day,week,month}` equals the
counts the prior `active_nodes` returned, and `meshcore.nodes`/`meshtastic.nodes`
equal the prior flat per-protocol counts (relocation, identical values). Every
metric honors the node opt-out marker using the filter appropriate to its table —
`opt_out_self_filter` for `nodes`, and `opt_out_node_id_filter` /
`opt_out_node_num_filter` for the message and telemetry-umbrella tables —
consistent with the existing list endpoints.

### S-A3 — `telemetry` umbrella + unchanged windows — S3, S4
```bash
( cd web && bundle exec rspec spec/queries_spec.rb -e "telemetry umbrella" )
```
**Expected:** pass. With one row inside the window in **each** of `positions`,
`telemetry`, `neighbors`, and `traces`, the `telemetry` metric counts **all four**
(positions + telemetry + neighbors + traces, by each table's `rx_time`); the
`messages` metric counts the `messages` table by `rx_time`; `nodes` counts
`nodes` by `last_heard`. Window cutoffs are unchanged — `hour` 3600s, `day`
86 400s, `week` `week_seconds`, `month` `four_weeks_seconds` — so a row older than
`four_weeks_seconds` is excluded from `month` (28-day floor, preserves C4).

### S-A4 — Privacy: messages zeroed in private mode — S5
*Run the server with `PRIVATE=1`.*
```bash
curl -s http://127.0.0.1:41447/api/stats \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); \
SC=("total","meshcore","meshtastic","reticulum"); WI=("hour","day","week","month"); \
print(all(d[s]["messages"][w]==0 for s in SC for w in WI))'
```
**Expected:** prints `True` — every `messages` count (in `total` and all protocol
scopes) is `0` under `PRIVATE=1`, mirroring the message-API 404 (A2a). `nodes` and
`telemetry` counts are unaffected by privacy mode (only `/api/messages*` is
gated). Behavior is also covered by a Ruby example
(`bundle exec rspec spec/app_spec.rb -e "/api/stats"` exercising private mode).

### S-A5 — `reticulum` forward-looking zero stub — S6
```bash
curl -s http://127.0.0.1:41447/api/stats \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); r=d["reticulum"]; \
ME=("nodes","messages","telemetry"); WI=("hour","day","week","month"); \
print(all(r[m][w]==0 for m in ME for w in WI))'
git grep -niE 'reticulum' -- web/lib/potato_mesh/application/queries/node_queries.rb
```
**Expected:** the Python check prints `True` — `reticulum` is present with every
count `0`. The grep shows the `reticulum` block carries an in-code comment marking
it a **stub** (always-zero until a Reticulum ingestor exists). `reticulum` is
**not** added to `KNOWN_PROTOCOLS` (still `meshcore` + `meshtastic`; verified by
A4a).

### S-A6 — One-way federation compatibility (new reads old) — S7
```bash
( cd web && bundle exec rspec spec/federation_spec.rb -e "stats" )
```
**Expected:** pass. The consumer resolves remote activity counts by trying the
**new** shape first (`total.nodes[window]`, `meshcore.nodes.day`,
`meshtastic.nodes.day`) and falling back to the **old** shape
(`active_nodes[window]`, `meshcore.day`, `meshtastic.day`), then to the existing
node-list fallback. The pre-existing federation specs that feed the **old** flat
shape continue to pass unchanged — they are the regression proof that a new
instance still reads an old peer. New unit coverage asserts
`remote_active_node_count_from_stats` handles both shapes (and prefers new).

### S-R1 — Regression: prior acceptance still holds
```bash
( cd web && npm test ) && ( cd web && bundle exec rspec )
( . .venv/bin/activate && pytest -q tests/ )
```
**Expected:** every prior check still passes. At risk and explicitly required to
remain green: **A3c** (federation specs — the old-shape stats specs must stay
green, proving one-way new-reads-old); **A2 / A2a** (privacy — `/api/messages`
still 404s in private mode **and** message counts are now zeroed, S-A4); and
**B1** (all suites). The JS stats assertions in `stats.test.js` /
`main-stats.test.js` (`normaliseActiveNodeStatsPayload`, `fetchActiveNodeStats`)
and the dashboard consumer (`stats.js`) are **updated** to read `total.nodes` from
the new shape, not removed. No POST/event contract changes, so **C2** and the
Python suite are unaffected.

---

## Bugfix: API casing consistency

Two casing inconsistencies on the HTTP API, fixed as a versioned breaking change
(0.7.0). The `/version` JSON response moves to snake_case (matching every other
read response and `/api/stats`); `POST /api/nodes` **additionally** accepts
snake_case node fields so the ingest contract is no longer Meshtastic-camelCase
only. The **signed federation wire** (`/.well-known`, `/api/instances`) is
deliberately **unchanged** (camelCase — its keys are part of the instance
signature, `federation/signature.rb`).

*Run the server in public mode (`API_TOKEN=acctest PRIVATE=0 FEDERATION=0 bundle exec ruby app.rb`).*

### BF-A1 — `/version` response is snake_case
```bash
( cd web && bundle exec rspec spec/app_spec.rb -e "exposes the /version config block in snake_case" )
```
**Expected:** pass. `GET /version` returns a `config` block keyed in snake_case
(`site_name`, `map_center` `{lat,lon}`, `private_mode`, `instance_domain`,
`contact_link`, `contact_link_url`, `max_distance_km`, `refresh_interval_seconds`)
plus a top-level `last_node_update`. The pre-0.7.0 camelCase keys (`siteName`,
`mapCenter`, `privateMode`, …, `lastNodeUpdate`) are **gone**. The federation wire
(`/.well-known`, `/api/instances`) stays camelCase (signed).

### BF-A2 — `POST /api/nodes` accepts snake_case node fields
```bash
( cd web && bundle exec rspec spec/app_spec.rb -e "accepts snake_case node fields on POST /api/nodes" )
```
**Expected:** pass. A node POSTed with snake_case fields (`last_heard`,
`user.short_name`/`long_name`/`hw_model`, `device_metrics.battery_level`,
`position.latitude`/`longitude`) is stored and surfaces on `GET /api/nodes`.
camelCase Meshtastic input (`lastHeard`, `user.shortName`, …) continues to work
unchanged — acceptance is **additive**, so the existing Python ingestor is
unaffected.

### BF-R1 — Regression: prior acceptance still holds
```bash
( cd web && npm test ) && ( cd web && bundle exec rspec )
( . .venv/bin/activate && pytest -q tests/ )
```
**Expected:** every prior check still passes. Updated for the `/version` break:
**A2b** now asserts `"private_mode":true` (was `"privateMode":true`) and **D1**
lists the snake_case config keys. The deployed Flutter app reads the new
`/version` keys (`app/lib/main.dart`); older app builds break until updated (the
accepted one-way cost of the clean break). `data-app-config` (the server→frontend
DOM channel) is intentionally **out of scope** and stays camelCase.

---

## Bugfix: API consistency cleanups (I2/I3/I5/I6)

Four small API consistency fixes shipped in 0.7.0 alongside the casing change
above. The signed federation wire (`/.well-known`, `/api/instances` output, the
canonical signed payload) stays untouched throughout.

### IC-A1 — `POST /api/instances` accepts both key casings (I6)
```bash
( cd web && bundle exec rspec spec/app_spec.rb -e "accepts snake_case optional fields on POST /api/instances" )
```
**Expected:** pass. Optional fields (`contact_link`, `nodes_count`, …) accept
snake_case in addition to camelCase; the camelCase keys and the camelCase signed
canonical payload are unchanged.

### IC-A2 — Only `position_time`, no ISO twin (I2)
```bash
( cd web && bundle exec rspec spec/app_spec.rb -e "/api/nodes" -e "/api/positions" )
```
**Expected:** pass. `GET /api/nodes` and `/api/positions` emit `position_time`
(unix int) and **no** `pos_time_iso` / `position_time_iso`.

### IC-A3 — POST ingest routes return 201 (I3)
```bash
( cd web && bundle exec rspec spec/app_spec.rb -e "POST ingest status codes" )
```
**Expected:** pass. Every `POST /api/*` ingest route returns `201 Created`
(matching `/api/instances`). The ingestor treats any 2xx as success.

### IC-A4 — List POST routes reject malformed payloads (I5)
```bash
( cd web && bundle exec rspec spec/app_spec.rb -e "POST payload validation" )
```
**Expected:** pass. `/api/messages|positions|telemetry|neighbors|traces` return
`400 {"error":"invalid payload"}` for a non-array/non-object body, matching the
`/api/nodes` Hash check.

### IC-R1 — Regression
```bash
( cd web && npm test ) && ( cd web && bundle exec rspec )
( . .venv/bin/activate && pytest -q tests/ ) && ( cd matrix && cargo test --all --all-features )
```
**Expected:** all green. POST `be_ok` assertions were updated to `201` (not
removed); the ingestor is unaffected (2xx success); the matrix bridge is GET-only.

---

## Bugfix/Migration: Federation signature v2

Maps to SPEC **FS1–FS6** — federation wire migrated to snake_case with signed
counts and v1-backward-compatible verification.

### FS-A1 — v2 sign/verify round-trip + v1 backward-accept
```bash
( cd web && bundle exec rspec spec/federation_spec.rb -e "signature" )
```
**Expected:** pass. A v2 (snake) instance signature verifies; a legacy v1
(camelCase, no `signature_version`) signature still verifies via fallback.
`verify_instance_signature` accepts both; instances sign/send v2.

### FS-A2 — all announced counts are signed (tamper-evident)
```bash
( cd web && bundle exec rspec spec/federation_spec.rb -e "signed counts" )
```
**Expected:** pass. The announcement canonical covers `nodes_count`,
`meshcore_nodes_count`, `meshtastic_nodes_count`, `reticulum_nodes_count`;
altering any count invalidates the v2 signature. Nothing in the announced payload
sits outside the signed canonical except `signature` / `signature_version`.

### FS-A3 — well-known v2 snake + version marker, accepts v1+v2
```bash
( cd web && bundle exec rspec spec/app_spec.rb -e "well-known" )
```
**Expected:** pass. `/.well-known/potato-mesh` emits snake_case (`public_key`,
`last_update`, `signature_algorithm`, `signed_payload`, `signature_version`); the
validator accepts both v2 and legacy v1 documents.

### FS-A4 — wire surfaces are snake_case
```bash
( cd web && bundle exec rspec spec/app_spec.rb -e "/api/instances" )
```
**Expected:** pass. `GET /api/instances` and the announce payload use
`public_key`, `last_update`, `is_private`, `contact_link`, `*_nodes_count` — no
camelCase keys.

### FS-A5 — activity gate is intended behavior (not a regression)
**Expected (covered by `federation_spec`):** an instance with **0 nodes active in
7 days** is **not** federated — `validate_remote_nodes` rejects it ("node data is
stale" / below `remote_instance_min_node_count`). By design.

### FS-R1 — Regression
```bash
( cd web && bundle exec rspec ) && ( cd web && npm test )
( . .venv/bin/activate && pytest -q tests/ ) && ( cd matrix && cargo test --all --all-features )
```
**Expected:** all green. The pre-existing camelCase federation specs are
retargeted to v2 or kept as the v1-backward-accept proof, not removed.

---

## Bugfix: Chat first-paint latency (progressive load, issue #802)

PR #800 (issue #796) made the initial chat load page the **entire** seven-day
window *before* rendering anything — on a busy instance up to ~10k messages
across several sequential `/api/messages` pages, leaving the chat blank for
10-20s. The fix renders the newest page immediately and **streams** the older
history in the background (deduplicated by id), so the chat fills progressively
while staying responsive. The change is to *when* rows render, not *which* rows
are reachable: the background pager keeps the **same backward `before`-cursor
semantics** as the pre-fix #796 walk, so it reaches the same rows C7 does.
Frontend-only: no API/DB change, so the C4/C7 window floors, `MAX_QUERY_LIMIT`,
and privacy are untouched.

### PL-A1 — Newest page renders without blocking on the full window
```bash
( cd web && node --test public/assets/js/app/__tests__/main-progressive-load.test.js )
```
**Expected:** pass. On first load the newest `MESSAGE_LIMIT` messages are
committed and rendered **even while an older page is still in flight** (the chat
does not wait for the whole backward pagination); once the background page
resolves it is merged in by id, extending the loaded set backward through the
window with the same reachability as the C7 walk. A failed background page is
swallowed (logged, not rethrown) and leaves the rendered newest page intact.

### PL-A2 — Backward pager yields progressively and de-duplicates by id
```bash
( cd web && node --test public/assets/js/app/main/__tests__/data-fetchers.test.js )
```
**Expected:** pass. `paginateMessages()` yields one batch per page
(newest → oldest), seeds its cursor from an optional `before`, de-duplicates by
id across pages, and stops on a short page / no-progress / missing cursor /
`maxPages`. Its eager wrapper `fetchAllMessages()` preserves its existing
semantics (concatenation of the generator's batches).

### PL-R1 — Regression: prior acceptance still holds
```bash
( cd web && npm test )
( cd web && bundle exec rspec spec/app_spec.rb -e "backward pagination" )
```
**Expected:** all green. **C7** (issue #796 backward pagination) is unchanged —
the server still clamps `before`/`since` to the seven-day floor and
`MAX_QUERY_LIMIT`, and the client reaches the same in-window messages C7 covers
(identical backward-cursor semantics), now progressively rather than in one
blocking burst.

---

## Bugfix: MeshCore synthetic chat-node naming & reconciliation (issue #803)

A MeshCore channel message carries its sender as a `"SenderName: body"` text
prefix (and quotes/mentions as `@[Name]`); the sender's `from_id` is a
name-derived synthetic id. The web app's generic `ensure_unknown_node` minted a
`"MeshCore <hex>"` placeholder marked **`synthetic=0`** (real) for that id, which
(a) showed the wrong name, (b) blocked the correctly-named `synthetic=1` upsert
via the real-node guard, and (c) was invisible to the long-name merge with the
real contact — so messages were permanently mis-attributed. Mention-only names
got no node at all. Fixed web-side (Ruby): MeshCore **channel** messages now
synthesize/repair placeholder nodes named from the message text and marked
`synthetic=1`, so the existing `#755` merge machinery reconciles them with real
contacts. No ingestor/API/DB-schema change; the apex (I) and privacy (II)
invariants are untouched.

### MC-A1 — Sender & mention placeholders are named from the chat text, reconcile, and self-heal
```bash
( cd web && bundle exec rspec spec/data_processing_spec.rb -e "meshcore synthetic chat nodes" )
```
**Expected:** pass. For a MeshCore channel message (`protocol=meshcore`,
`to_id="^all"`): the sender's `from_id` node is named from the `"Name:"` prefix
with `synthetic=1` (never `"MeshCore <hex>"`); when a real node of that
`long_name` already exists the placeholder is **merged away** and the message
redirected to it; a pre-existing generic `"MeshCore <hex>"` `synthetic=0`
placeholder is **repaired** (renamed + demoted to synthetic) when a naming
message arrives; and each `@[Name]` mention gets its own `synthetic=1`
placeholder (`derive(name) = "!" + sha256(name)[0,8]`, matching the ingestor and
frontend) even when that name never sent a message.

### MC-A2 — Text-parsing & id-derivation helpers
```bash
( cd web && bundle exec rspec spec/data_processing_spec.rb -e "meshcore chat text parsing" )
```
**Expected:** pass. `parse_meshcore_sender_name` returns the trimmed name before
the first `:` (nil when absent/blank); `extract_meshcore_mentions` returns the
trimmed, de-duplicated `@[Name]` list; `meshcore_synthetic_node_id` reproduces
the ingestor/frontend derivation (`derive("DWeb 0229") == "!0f6de6b3"`).

### MC-R1 — Regression: prior acceptance still holds
```bash
( cd web && bundle exec rspec )
( . .venv/bin/activate && pytest -q tests/ )
```
**Expected:** all green. The pre-existing synthetic-merge specs (issues **#755**
/ **#756** in `database_spec.rb` / `data_processing_spec.rb`) still pass — the
fix only changes how the **placeholder is named/flagged** at message-ingest time;
`merge_synthetic_nodes` / `merge_into_real_node` are unchanged. The Python
ingestor is untouched (it still emits the same name-derived synthetic upsert,
now redundant-but-harmless with the web-side path).

---

## Bugfix: Federation peer DNS failure must not 500

A peer registering via `POST /api/instances` (and the periodic crawl) is verified
by fetching its `/.well-known/potato-mesh` and `/api/nodes`. The fetch path
(`federation/instance_fetcher.rb#perform_instance_http_request`) resolves the
peer's domain via `resolve_remote_ip_addresses` → `Addrinfo.getaddrinfo` **before**
the wrapped HTTP attempt, but its method-level rescue caught only `ArgumentError`.
A peer whose domain fails DNS raises `Socket::ResolutionError` (a `SocketError`),
which escaped past `fetch_instance_json` (rescues only `JSON::ParserError` /
`InstanceFetchError`) to the route as an unhandled **HTTP 500**. The intended
behavior — documented in-code at the registration pre-check ("DNS lookups that
fail to resolve are handled later") and already realized on the announce path —
is a graceful rejection. Fix: `perform_instance_http_request` wraps `SocketError`
(alongside `ArgumentError`) as `InstanceFetchError`. Frontend/API-shape unaffected;
the apex (I) and privacy (II) invariants are untouched.

### FD-A1 — DNS resolution failures are wrapped, not leaked
```bash
( cd web && bundle exec rspec spec/federation_spec.rb -e "wraps DNS resolution failures" -e "fails DNS resolution" )
```
**Expected:** pass. `perform_instance_http_request` raises `InstanceFetchError`
(not a raw `Socket::ResolutionError`) when `Addrinfo.getaddrinfo` fails, and
`fetch_instance_json` returns `[nil, errors]` (recording the failure) instead of
raising — so a peer with an unresolvable domain is rejected with a 4xx rather
than crashing the request with a 500.

### FD-R1 — Regression: prior acceptance still holds
```bash
( cd web && bundle exec rspec spec/federation_spec.rb )
( cd web && bundle exec rspec )
```
**Expected:** all green, including **A3c** (federation specs: opt-in, isolation,
privacy override, staleness eviction). The change only converts a previously
**uncaught** resolution error into the `InstanceFetchError` every
`fetch_instance_json` caller already handles; the restricted-address
`ArgumentError` path, connection-error retry/fallback, and announce path are
unchanged.

---

## Bugfix: Federation hygiene (HTTP fallback, observability, shutdown)

Three small federation defects discovered while investigating a same-key
collision between two `v0.7.0-rc2` peers. The fixes are independent of one
another; each ships its own regression line below.

### FH-A1 — HTTPS responses don't trigger an HTTP fallback
```bash
( cd web && bundle exec rspec spec/federation_spec.rb \
    -e "does not fall back to HTTP after HTTPS returned an HTTP response" \
    -e "still falls back to HTTP when HTTPS connection itself fails" )
```
**Expected:** pass. When an HTTPS request to `/api/instances` returns any HTTP
status (success or error — e.g. `400` from an older v0.6.x peer rejecting the
v2 signature, SPEC **FS5**), the `http://…:80` candidate is **not** attempted
and no `warn_log` is emitted. The HTTP fallback only fires when HTTPS failed at
the transport layer (`Errno::ECONNREFUSED` / `EHOSTUNREACH` / `ENETUNREACH`
etc.), preserving the dev-instance fallback. Implemented via
`PotatoMesh::App::InstanceHttpResponseError < InstanceFetchError`
(`application/errors.rb`), raised by `perform_single_http_request` for non-2xx
responses and matched ahead of the generic `InstanceFetchError` in
`fetch_instance_json`; `announce_instance_to_domain` breaks the URI loop
explicitly on a non-success HTTP response.

### FH-A2 — Federation is observable at default log level
```bash
( cd web && bundle exec rspec spec/app_spec.rb -e "defaults to INFO" \
                            spec/federation_spec.rb -e "logs cycle start and end at info level" )
```
**Expected:** pass. With `DEBUG=0` the structured logger defaults to `INFO`
(not `WARN`), restoring visibility for operational milestones that are already
authored as `info_log` (notably `application/retention.rb` purges and the new
federation cycle entries). On every announcement cycle, federation emits one
`info` line at start carrying `target_count` and one at end carrying
`success_count` + `failure_count`. The boot path emits a one-shot
`"Federation enabled"` info line with `seed_count`,
`announcement_interval_seconds`, and `worker_pool_size` when federation is
active. Per-peer announce success/failure stays at `debug` to keep cycle logs
to ~3 lines/8h on a busy fleet. Inbound peer registrations
(`routes/ingest.rb` "Registered remote instance") are also promoted to `info`
since they are bounded by `federation_max_domains_per_crawl`.

### FH-A3 — Federation workers shut down in bounded time
```bash
( cd web && bundle exec rspec spec/worker_pool_spec.rb \
    -e "reaps workers that ignore STOP_SIGNAL within force_kill_after" \
    -e "rejects pending tasks that have not started yet"
  cd web && bundle exec rspec spec/federation_spec.rb \
    -e "uses federation_shutdown_timeout_seconds (not the task timeout)" )
```
**Expected:** pass. `shutdown_federation_worker_pool!` budgets the pool
shutdown by `federation_shutdown_timeout_seconds` (default 3s — env-tunable
via `FEDERATION_SHUTDOWN_TIMEOUT`) and arms a matching `force_kill_after`, so
a worker mid-task that ignores STOP_SIGNAL is hard-killed within that window
rather than waiting out the 120s task timeout per thread serially. Pending
queued tasks that have not yet started are rejected with `ShutdownError`
during shutdown rather than executed. `Thread#kill` runs Ruby `ensure`
blocks, so SQLite handles opened inside crawl/announce tasks (guarded by
`ensure db&.close`) still close cleanly. Net effect: CTRL+C on a running
instance reaps `potato-mesh-fed-N` workers in seconds, not minutes.

---

## Bugfix: Chat-log incremental render & per-node hydration storm

The dashboard rebuilt the **entire** chat log from HTML strings on every refresh
tick (`element.innerHTML = …` per entry — ~77% of a refresh's main-thread time in
the deployed profile) and the message-node hydrator backfilled each unknown
sender with a separate `GET /api/nodes/:id` (hundreds of round trips, many `404`
for RF-only nodes, on every cold load). The render now memoises each entry's DOM
node and reuses it while its rendered HTML is unchanged, so an idle tick parses
nothing; the hydrator resolves senders from the already-loaded bulk node map and
renders an `!id` placeholder on a miss, issuing zero per-node requests.
Frontend-only (vanilla JS, existing stack); no API/DB/ingestor change, so the
apex (I) and privacy (II) invariants are untouched.

### CR-A1 — Idle re-render materialises no entries; content preserved; no per-node fetch
```bash
( cd web && node --test public/assets/js/app/__tests__/main-chat-render-incremental.test.js )
```
**Expected:** pass. After the initial render fills the entry cache, calling
`rerenderChatLog` again with unchanged state materialises **0** entries
(`getChatRenderStats().materialized` stays `0` — the brief's "idle page renders
~0 entries per cycle" gate) and the rendered chat still contains every message.
A refresh whose sender is absent from the bulk `/api/nodes` payload issues **no**
`GET /api/nodes/!…` request (the hydration storm is gone).

### CR-A2 — Entry-node cache memoises, namespaces, prunes, and releases tabs
```bash
( cd web && node --test public/assets/js/app/main/__tests__/chat-entry-cache.test.js \
                       public/assets/js/app/main/__tests__/chat-entry-keys.test.js )
```
**Expected:** pass. `createChatEntryCache` reuses a node while its HTML is
unchanged, rebuilds it when the HTML changes (e.g. a renamed sender), keeps a
distinct node per tab namespace for the same key (a message renders in both the
Log and its channel tab), prunes entries that aged out of a tab's window, and
releases caches for tabs no longer present. The stable per-entry keys cover
messages (by `id`, with a timestamp/sender/text fallback) and every log-entry
type (including encrypted).

### CR-A3 — Hydration is map-only by default; per-node fetch is opt-in
```bash
( cd web && node --test public/assets/js/app/__tests__/message-node-hydrator.test.js )
```
**Expected:** pass. With no `fetchNodeById` injected (the dashboard default) the
hydrator binds senders from `nodesById` and emits a protocol-stamped `!id`
placeholder on a miss, performing **zero** network lookups. `applyNodeFallback`
remains mandatory; `fetchNodeById` is now optional, and supplying it re-enables
the bounded per-node backfill (worker-pool + negative cache) for a deliberate,
opt-in batched refresh path.

### CR-R1 — Regression: prior acceptance still holds
```bash
( cd web && npm test ) && ( cd web && bundle exec rspec )
( . .venv/bin/activate && pytest -q tests/ )
```
**Expected:** all green. The public `createMessageChatEntry` /
`createAnnouncementEntry` test surface is unchanged (now thin wrappers over the
pure parts builders), so **A4c** (chat name resolution honours protocol) and the
chat-entry / progressive-load suites (**PL-A1**, **PL-A2**) stay green. No
POST/GET contract change, so the Ruby and Python suites are unaffected.

---

## Feature: Frontend persistent data cache

Maps to SPEC decisions **FC1–FC7**. The dashboard persists its read-side data in
the browser (IndexedDB) keyed by canonical id, paints from cache on load, and
fetches only misses (absent or stale rows) and incremental deltas. Frontend-only
(vanilla JS); no API/DB/ingestor change. New modules live under
`web/public/assets/js/app/main/` (e.g. `data-cache.js` for the store and a
lifetime/TTL helper) with co-located `__tests__`.

### FC-A1 — Persistent, id-keyed store round-trips every collection — FC1
```bash
( cd web && node --test public/assets/js/app/main/__tests__/data-cache.test.js )
```
**Expected:** pass. The store reads/writes `nodes`, `messages` (incl.
`encrypted`), `positions`, `telemetry`, `neighbors`, and `traces` keyed by the
canonical record id (`neighbors` by the composite `(node_id, neighbor_id)` key),
backed by IndexedDB; values written in one session are retrievable from a fresh
store instance over the same backing database (the reload/revisit path). Reads of
an absent id return a miss.

### FC-A2 — Seed-from-cache, fetch only the delta — FC2
```bash
( cd web && node --test public/assets/js/app/__tests__/main-cache-refresh.test.js )
```
**Expected:** pass. On a **warm** start (cache populated) the app paints from
cache and each collection's first refresh requests only rows newer than the
newest cached row (`since=<newest cached ts>`); rows already present and fresh in
the cache are **not** re-requested. On a **cold** start (empty cache) it fetches
the full window as today. New rows returned by the delta are merged by id and
written back to the cache. The auto-refresh cadence is unchanged.

### FC-A3 — Two-tier lifetime: staleness refetches, eviction deletes — FC3, FC5
```bash
( cd web && node --test public/assets/js/app/main/__tests__/cache-lifetime.test.js )
```
**Expected:** pass. Given the per-collection windows — **nodes** stale 24 h /
evict 7 d; **traces & neighbors** stale + evict 28 d; **messages, positions,
telemetry** stale + evict 7 d — the helper reports an entry **stale** past its
staleness TTL (so it is a fetch candidate) but **retains** it until its (longer
or equal) eviction window. A node last updated 26 h ago is **stale yet not
evicted** (still served); a node 8 d old is evicted; **no entry younger than 7
days is ever evicted**; a trace 20 d old is retained, a trace 29 d old is
evicted. No staleness/eviction window exceeds the server's visibility floor
(7-day bulk; 28-day per-id/trace), preserving C4.

### FC-A4 — Privacy: PRIVATE disables + wipes the cache; clear control empties it — FC4
```bash
( cd web && node --test public/assets/js/app/__tests__/main-cache-privacy.test.js )
```
**Expected:** pass. When the instance reports **PRIVATE** mode the cache performs
**no writes** and any existing cached data is **wiped** on init; only data the
API actually returns is ever stored (opt-out / `CLIENT_HIDDEN` rows are excluded
server-side, so they never reach the cache; a node opt-out propagates to clients
within the 24 h node staleness window). The **clear-cache operation**
(`clearDataCache` — the action a "clear cached data" control invokes) empties the
store on demand; the **visible UI control is a deferred follow-up**, but the
capability ships and is covered here. This is the client-side realisation of the
**FC4** amendment to Invariant II; combined with **A2a** (message API still 404s
in private mode) no message content is cached or served when private.

### FC-A5 — Versioned schema & graceful degradation — FC6, FC7
```bash
( cd web && node --test public/assets/js/app/main/__tests__/data-cache.test.js )
```
**Expected:** pass. A cache carrying a different schema version — or a different
instance identity (`instance_domain`) — is discarded on open rather than served,
so a data-shape change can never surface mis-shaped entries. When the storage
backend is unavailable, throws, or exceeds quota, every store operation degrades
silently to a no-op and the app falls back to today's network-only behavior (the
cache is never load-bearing). The cache feeds **no** POST/ingest path and alters
**no** API response (read-side only).

### FC-R1 — Regression: prior acceptance still holds
```bash
( cd web && npm test ) && ( cd web && bundle exec rspec )
( . .venv/bin/activate && pytest -q tests/ )
```
**Expected:** all green. At risk and explicitly required to remain green:
**A2 / A2a / A2b** (privacy — no cached messages surface in private mode);
**C4 / C7** (7-day GET floor and #796 backward pagination — the cache never
serves beyond-window rows); **PL-A1 / PL-A2** (#802 progressive load + backward
pager — caching seeds, it does not replace, the pager); **CR-A1 … CR-R1** (#813
incremental render + map-only hydration — the cache seeds `nodesById` and feeds
the same render path, so idle re-renders still materialise 0 entries and no
per-node `/api/nodes/:id` request is issued); **A4c** (protocol parity — cache
keyed by canonical id, never mixing protocols); and **B1** (all suites). No
POST/GET contract change, so the Ruby and Python suites are unaffected.

---

## Feature: Asset cache-busting (versioned static assets)

Maps to SPEC decisions **AV1–AV5**. The helper + import-map builder live under
`web/lib/potato_mesh/application/helpers/`; asset references live in
`views/layouts/app.erb`, `views/charts.erb`, `views/federation.erb`,
`views/node_detail.erb`. *Unless noted, run the server in public mode and
leave it running for the curl checks:*

```bash
( cd web && API_TOKEN=acctest PRIVATE=0 FEDERATION=0 \
    bundle exec ruby app.rb -p 41447 -o 127.0.0.1 ) &  SRV=$!
# ... run the AV-A* curl checks below, then: kill "$SRV"
```

*(This repo has no `config.ru`; it is launched via `app.rb` — see `app.sh` —
not `rackup`.)*

### AV-A1 — Template-written JS & CSS carry `?v=<version>` — AV1, AV2
```bash
curl -s http://127.0.0.1:41447/ \
  | grep -oE "/assets/(js|styles)/[A-Za-z0-9/_.-]+\?v=[^\"']+" | sort -u
```
**Expected:** every template-written JS `<script src>` and the `base.css`
`<link href>` carry a `?v=<APP_VERSION>` query — at minimum
`/assets/js/theme.js?v=…`, `/assets/js/background.js?v=…`,
`/assets/js/app/index.js?v=…`, and `/assets/styles/base.css?v=…`. None of those
four is emitted without the query.

### AV-A2 — Exactly one import map, covering the deep module graph — AV3
```bash
curl -s http://127.0.0.1:41447/ | grep -c '<script type="importmap">'
curl -s http://127.0.0.1:41447/ \
  | grep -oE '"/assets/js/app/main\.js": *"/assets/js/app/main\.js\?v=[^"]+"'
```
**Expected:** the first command prints `1` (a single import map, emitted in
`<head>` before any module loads); the second matches. `main.js` is imported
**only** through a relative specifier inside `index.js` and is never written in
any template, so its presence in the map with a `?v=` URL proves the *transitive*
module graph is busted — not just the entry points.

### AV-A3 — Inline-import page versions its entry specifier — AV2
```bash
curl -s http://127.0.0.1:41447/charts \
  | grep -oE "from '/assets/js/app/charts-page\.js\?v=[^']+'"
```
**Expected:** the inline `<script type="module">` import specifier carries
`?v=<APP_VERSION>`. `federation.erb` and `node_detail.erb` use the identical
pattern (reachable directly only with `FEDERATION=1` / a known node id; both are
covered by the view/app specs in AV-A6).

### AV-A4 — Scope boundary: images & favicons are NOT versioned — AV4
```bash
curl -s http://127.0.0.1:41447/ \
  | grep -oE "(potatomesh-logo\.svg|favicon\.[a-z]+|/assets/img/[A-Za-z0-9._-]+)\?v=" \
  && echo "UNEXPECTED: image carries ?v=" || echo "OK: no image versioned"
```
**Expected:** prints `OK: no image versioned`. Image / favicon / SVG-icon URLs
carry **no** `?v=` query — they keep today's `Last-Modified`/`ETag` revalidation,
pinning the JS+CSS-only scope of AV4.

### AV-A5 — No asset-pipeline dependency; native import map — AV4, D7
```bash
git grep -niE 'importmap-rails|sprockets|propshaft|webpacker|shakapacker' -- \
  web/Gemfile web/Gemfile.lock web/package.json
```
**Expected:** no output. The import map is emitted directly from Ruby using the
native browser feature; no asset-pipeline gem or npm package is introduced (the
locked stack, D7, is unchanged).

### AV-A6 — Helper + builder unit-tested; web suites green — AV5
```bash
( cd web && bundle exec rspec ) && ( cd web && npm test )
```
**Expected:** pass. Includes new specs covering `asset_url` (appends
`?v=<APP_VERSION>`) and the import-map builder (enumerates served `.js`, excludes
`__tests__`, stamps the version, emits valid JSON). RDoc + the full Apache header
are present on every new/edited source file (Layer B3/B4 still hold).

### AV-R1 — Regression: prior acceptance still holds
```bash
( cd web && bundle exec rspec ) && ( cd web && npm test )
```
**Expected:** every prior check still passes. **At risk and explicitly required to
remain green:** **B1** (all suites); **B4a** (no new *unheadered* source file — any
new helper file must carry the full Apache block); **D1** (`/version` config block —
the shared layout's behavior is unchanged). Any existing view/app spec that
asserted an exact *unversioned* asset string (e.g. `src="/assets/js/app/index.js"`)
is **updated** to the `?v=` form, **not** removed.

---

## Bugfix: Initial-load module-graph waterfall (slow first data paint)

The dashboard's first `/api/*` fetch is gated behind the **entire** 89-module
ES-module graph loading, and that graph was discovered one import-tier at a time
(`index.js` → `{config,main,settings}` → main's 33 imports → … ≈ 5 serial round
trips) because nothing told the browser the deeper modules up-front. On a real
connection each tier costs a full RTT, so data did not paint for **2–3 s**
(measured: ~3.7 s to the first `/api/nodes` request at 150 ms RTT / 4× CPU; the
server itself answers every endpoint in <250 ms). The fix emits one
`<link rel="modulepreload">` per served app ES module in `<head>` — the **same
set the AV3 import map versions** — so the whole graph downloads in parallel
(one round trip over HTTP/2) instead of tier-by-tier. Native browser feature, no
build step or dependency (D7/AV4); read-side only (apex/privacy/parity untouched);
a module absent from the preloads still loads normally (AV3's degradation
property). Built by `PotatoMesh::App::AssetImportMap.preload_html`
(`web/lib/potato_mesh/application/helpers/asset_helpers.rb`), rendered after the
import map in `views/layouts/app.erb`.

*Run the server in public mode (as in AV-A1) and leave it running for the curl check.*

### MP-A1 — The head preloads the whole app ES-module graph (busted URLs)
```bash
curl -s http://127.0.0.1:41447/ \
  | grep -oE '<link rel="modulepreload" href="/assets/js/app/[A-Za-z0-9/_.-]+\?v=[^"]+">' \
  | grep -E 'app/(index|main)\.js'
```
**Expected:** matches a `<link rel="modulepreload">` for both the entry point
`index.js` and the transitively-imported `main.js`, each carrying the
`?v=<APP_VERSION>` query — i.e. the preloaded URL equals the import-map **target**,
so the preload and the eventual `import` resolve to the same cache entry. Every
served `/assets/js/app/**` module is preloaded; the classic non-module scripts
(`/assets/js/theme.js`, `/assets/js/background.js`) and `__tests__` files are
**not** preloaded.

### MP-A2 — Preloads sit after the import map, before the module entry; unit-tested
```bash
( cd web && bundle exec rspec spec/asset_versioning_spec.rb -e "modulepreload" \
                            spec/asset_import_map_spec.rb -e "preload" )
```
**Expected:** pass. The rendering spec asserts the modulepreload block is emitted
**after** the `<script type="importmap">` and **before** the
`<script type="module" src="…index.js">` entry (so resolution order is correct),
that classic scripts and `__tests__` are excluded, and the unit specs cover
`AssetImportMap.preload_paths` (app modules only) and `.preload_html` (one
version-stamped link per module, memoized).

### MP-R1 — Regression: prior acceptance still holds
```bash
( cd web && bundle exec rspec ) && ( cd web && npm test )
```
**Expected:** every prior check still passes. **At risk and explicitly required to
remain green:** **AV-A2** (still exactly one import map, still busting the deep
graph — the preloads are additive, not a replacement); **AV-A1/AV-A4** (asset
versioning + image-scope boundary unchanged); **D1** (the shared layout's
`/version`-fed config behavior is unchanged); **B1** (all suites). The preloads
are purely additive head markup — no existing asset URL, the import map, or any
`/api/*`/`/version` shape changes.

---

## Bugfix: Initial-load data prefetch (cold-load early fetch)

Second phase of the initial-load fix (after the module-graph preload above).
Even with the graph preloaded, the first `/api/*` fetch still waits for the
~806 KB bundle to download, parse, and boot. An early `<script type="module"
async>` boot module (`web/public/assets/js/app/main/boot-prefetch.js`) now fires
the first-load (`since=0`) API requests **in parallel with** the module graph
(at `priority:'high'`, so they out-prioritise the parallel module preloads) and
stashes the in-flight `Response` promises on `window.__PM_BOOT__`; the app's
first `refresh()` consumes them via a new `responsePromise` option on the
data-fetchers instead of issuing its own requests. It runs **only on cold loads**
— a synchronous `localStorage` marker (`pm:cache-present`, maintained by the
cache write-back / clear / disable paths) suppresses it on warm revisits, leaving
the FC2 seed-then-delta path untouched. Message endpoints are skipped in private
mode (`data-pm-chat="false"`), mirroring the `/api/messages` 404 (Invariant II /
PS6). Pure pre-warm: an absent or rejected prefetch re-fetches (a captured error
response surfaces and the next auto-refresh recovers), so it is never
load-bearing (FC7). Read-side only; no API/DB/ingestor change, no new dependency (D7).

*Run the server in public mode (as in AV-A1) for the curl check.*

### EF-A1 — The head emits the cold-load boot-prefetch module (gated by privacy)
```bash
curl -s http://127.0.0.1:41447/ \
  | grep -oE '<script type="module" async[^>]*boot-prefetch\.js[^>]*' | head
```
**Expected:** matches an async ES-module `<script>` whose `src` is the versioned
`/assets/js/app/main/boot-prefetch.js?v=<APP_VERSION>`, carrying `data-pm-prefetch`
and `data-pm-chat="true"` in public mode. Under `PRIVATE=1` the same tag carries
`data-pm-chat="false"` (no message prefetch) — covered by the Ruby suite
(`bundle exec rspec spec/app_spec.rb -e "cold-load boot prefetch"`).

### EF-A2 — Cold load consumes the prefetch; warm load keeps the FC2 delta path
```bash
( cd web && node --test \
    public/assets/js/app/main/__tests__/boot-prefetch.test.js \
    public/assets/js/app/__tests__/main-boot-prefetch.test.js \
    public/assets/js/app/main/__tests__/data-fetchers.test.js )
```
**Expected:** pass. On a cold load (no `pm:cache-present` marker) the boot module
issues the seven first-load requests and the app consumes the stashed responses
on its first refresh — **no duplicate cold `/api/nodes`/`/api/messages` fetch** is
issued (the `__PM_BOOT__` global is one-shot, cleared on read). A successful cache
write-back sets the marker; `clearDataCache` and a disabled cache (PRIVATE /
no-IndexedDB) clear it. The data-fetchers accept a `responsePromise` and fall back
to a fresh fetch if it is absent or rejected (so a failed prefetch never loses
data). `coldLoadUrls` mirrors the data-fetchers' first-load URLs (no drift).

### EF-R1 — Regression: prior acceptance still holds
```bash
( cd web && bundle exec rspec ) && ( cd web && npm test )
```
**Expected:** every prior check still passes. **At risk and explicitly required to
remain green:** **MP-A1/MP-A2** (the module-graph preload is unchanged; the boot
module is itself one of the preloaded app modules); the **FC-A2** warm seed-delta
behaviour (`main-cache-refresh.test.js` — a warm load still seeds from cache and
delta-fetches, because the marker suppresses the cold prefetch); **A2/PS6**
(privacy — no message prefetch under `PRIVATE`); **B1** (all suites). No
`/api/*`/`/version` shape changes; the prefetch only changes *when* the first
requests fire, not *which* rows are reachable.

---

## Feature: Uniform backward pagination (`?before=`) for bulk collection APIs

Maps to SPEC decisions **BP1–BP9**. `?before=<unix_seconds>` is added as an
inclusive upper-bound keyset cursor to the six bulk collection GETs — `/api/nodes`,
`/api/positions`, `/api/telemetry`, `/api/neighbors`, `/api/traces`,
`/api/ingestors` — mirroring the existing `/api/messages` cursor (**C7**). The
logic lives in `web/lib/potato_mesh/application/routes/api.rb` and the `query_*`
helpers under `web/lib/potato_mesh/application/queries/`; the cursor is documented
in `data/mesh_ingestor/CONTRACTS.md`. Unless a check says otherwise, start the
server in public mode
(`API_TOKEN=acctest PRIVATE=0 FEDERATION=0 bundle exec ruby app.rb`).

### BP-A1 — Every bulk collection pages backward through the full window — BP1, BP2, BP3
```bash
( cd web && bundle exec rspec spec/app_spec.rb -e "before pagination" )
```
**Expected:** pass. For **each** of `/api/nodes`, `/api/positions`,
`/api/telemetry`, `/api/neighbors`, `/api/traces`, and `/api/ingestors`, seeding
more than `MAX_QUERY_LIMIT` (1000) rows inside the route's window and walking
newest → oldest — each page `limit=MAX_QUERY_LIMIT`, then `before=<oldest
primary-sort value seen>`, de-duplicating by id — recovers **every** in-window row
(the walk does not stall at the newest 1000). No single response exceeds
`MAX_QUERY_LIMIT`. The cursor bounds the route's primary sort column inclusively:
`rx_time` for positions/telemetry/neighbors/traces, `last_heard` for nodes,
`last_seen_time` for ingestors.

### BP-A2 — `before` only narrows; the floor still bounds the window — BP2
```bash
( cd web && bundle exec rspec spec/app_spec.rb -e "before cannot widen the window" )
```
**Expected:** pass. A `before` newer than `now` returns the same rows as no
`before` (a no-op upper bound). A `before` older than the route's floor, combined
with the floor-clamped lower bound, returns **nothing beyond the floor** — a row
older than the 7-day / 28-day floor stays excluded, so `before` cannot reach past
it (preserves **C4**). A non-positive or non-integer `before` (`0`, `-5`, `abc`)
is ignored as absent (parity with the messages `coerce_positive_or_nil`), so the
unfiltered newest page is returned.

### BP-A3 — Inclusive boundary, protocol-neutral cursor — BP3, BP5
```bash
( cd web && bundle exec rspec spec/app_spec.rb -e "before pagination boundary" )
```
**Expected:** pass. Two rows sharing the exact boundary second are **both**
returned when that second is passed as `before` (the inclusive `<=` ceiling never
skips a boundary row — client dedup collapses the one-row overlap between pages).
`?before=` composes with `?protocol=`: a backward walk filtered by
`protocol=meshcore` returns only MeshCore rows and still recovers all of them,
with neither protocol privileged.

### BP-A4 — History pages bypass the response cache — BP7
```bash
( cd web && bundle exec rspec spec/app_spec.rb -e "before bypasses the response cache" )
```
**Expected:** pass. A request carrying `before` is served from a fresh query, not
the short-lived `ApiCache` newest-page entry, and issuing it does **not** overwrite
or evict that hot entry — a subsequent no-`before` request still returns the cached
newest page. Matches the established `/api/messages` behavior (a `since > 0` or
`before` request skips the cache; the cache key for the default path is unchanged).

### BP-A5 — Privacy, opt-out, and apex are untouched — BP6
```bash
( cd web && bundle exec rspec spec/app_spec.rb -e "before pagination honors privacy" )
git grep -niE 'mqtt|mosquitto|paho|amqp|kafka|broker' -- web/Gemfile web/Gemfile.lock | grep -viE 'via_?mqtt'
```
**Expected:** the rspec passes and the grep prints nothing. A backward walk over
`/api/nodes` still excludes opted-out nodes (`NODE_OPT_OUT_MARKER`) and, in private
mode, `CLIENT_HIDDEN` nodes — `before` only narrows, so it can never surface a row
the route would otherwise hide (**A2c**, Invariant II). No manifest gains a broker
dependency (Invariant I / **A1a**): the change is a read-side query param only.

### BP-A6 — Cursor documented; deferred scope recorded — BP1, BP8, BP9
```bash
git grep -n 'before' -- data/mesh_ingestor/CONTRACTS.md
```
**Expected:** the `CONTRACTS.md` "GET endpoint time windows" section documents the
`?before=` inclusive upper-bound cursor and names the six collections that accept
it. The deferred items in **BP9** are out of scope and must **not** appear in this
change: `/api/instances` still lacks `limit`/`since`/`protocol`, and
`/api/telemetry/aggregated` still uses camelCase `windowSeconds`/`bucketSeconds`
(no snake_case alias) — these stay tracked follow-ups, not regressions.

### BP-R1 — Regression: prior acceptance still holds
```bash
( cd web && bundle exec rspec ) && ( cd web && npm test )
( . .venv/bin/activate && pytest -q tests/ )
```
**Expected:** every prior check still passes. At risk and explicitly required to
remain green: **C7** (messages backward pagination — its keyset mechanism is now
shared by six more routes, but `/api/messages` behavior is unchanged); **C4**
(window floors — `before` only narrows, never widens); **A2 / A2a / A2c** (privacy
& opt-out — a narrowing upper bound exposes no hidden row, and `/api/messages`
still 404s in private mode); **A4a** (`KNOWN_PROTOCOLS` unchanged); **PL-A1 /
PL-A2** and **FC-A2** (the frontend message pager and cache seed-then-delta are
untouched — frontend `before` adoption is deferred per **BP9**); and **B1** (all
suites). No POST/event contract changes, so **C2** and the Python suite are
unaffected (the only `data/` touch is the `CONTRACTS.md` GET-window documentation).
---

## Feature: Live updates (SSE change pub/sub)

Maps to SPEC decisions **PS1–PS8**. An in-process, in-memory pub/sub registry
(`web/lib/potato_mesh/application/pubsub.rb`) emits a thin per-collection change
event when an ingest `POST` writes; the new **`GET /api/events`** route streams
those events as Server-Sent Events; the frontend SSE client (a new module under
`web/public/assets/js/app/main/`, e.g. `event-stream.js`, with co-located
`__tests__`) reacts by running its existing delta fetch and merging by id. The
event shape is documented in `data/mesh_ingestor/CONTRACTS.md`. *Unless a check
says otherwise, run the server in public mode and leave it running for the curl
checks:*

```bash
( cd web && API_TOKEN=acctest PRIVATE=0 FEDERATION=0 \
    bundle exec ruby app.rb -p 41447 -o 127.0.0.1 ) &  SRV=$!
# ... run the PS-A* curl checks below, then: kill "$SRV"
```

### PS-A1 — Apex: the pub/sub adds no broker and no external client — PS1
```bash
# (1) No broker dependency anywhere (re-runs the A1a/A1b hard-gate greps).
git grep -niE 'mqtt|mosquitto|paho|amqp|kafka|rabbitmq|broker' -- \
  web/Gemfile web/Gemfile.lock data/requirements.txt \
  matrix/Cargo.toml matrix/Cargo.lock app/pubspec.yaml app/pubspec.lock
# (2) The pub/sub registry pulls in NO networking/broker client library.
git grep -nE '^\s*require\b.*\b(socket|net/http|net/|faraday|httparty|excon|redis|bunny|kafka|mqtt|amqp|stomp)\b' -- \
  web/lib/potato_mesh/application/pubsub.rb
```
**Expected:** (1) no output (apex hard gate **A1** still holds — no broker added).
(2) no output: `pubsub.rb` `require`s no networking or broker client — it uses
only in-process Ruby concurrency primitives (`Mutex` / `ConditionVariable`, which
need no `require`) and opens **no** socket or external connection. The fan-out is
a local, single-process registry (PS1). A FAIL here is an apex FAIL (SPEC §1).

### PS-A2 — `GET /api/events` is a read-only SSE stream, never an ingest path — PS2
```bash
# It streams text/event-stream (cut the long-lived connection after 2s).
curl -s -N --max-time 2 -D - -o /dev/null http://127.0.0.1:41447/api/events \
  | grep -i '^content-type:'
# It is read-only: POST is not accepted as an ingest path.
curl -s -o /dev/null -w 'POST %{http_code}\n' -X POST \
  -H 'Authorization: Bearer acctest' http://127.0.0.1:41447/api/events -d '{}'
```
**Expected:** the first command prints `Content-Type: text/event-stream` (the
subscribe surface is SSE). The second prints `404` or `405` — `/api/events`
accepts **no** body and is **not** an ingest route (§3.3); it writes nothing and
SQLite stays the system of record. The endpoint is additive — no existing
`/api/*` response shape changes (D8), confirmed by the unchanged Layer C checks.

### PS-A3 — Thin per-collection event on ingest; client delta-fetches — PS3
```bash
( cd web && bundle exec rspec spec/pubsub_spec.rb -e "publishes a thin per-collection event" )
( cd web && node --test public/assets/js/app/main/__tests__/event-stream.test.js )
```
**Expected:** pass. Server side: a subscriber to the registry, after a successful
ingest `POST`, receives an event whose payload names **only** the changed
collection (one of `nodes`/`messages`/`positions`/`telemetry`/`neighbors`/
`traces`), optionally with a newest-`rx_time`/`last_heard` skip-hint, and carries
**no row fields** (no body text, sender, position, etc.). Client side: on an SSE
event for collection *X* the SSE client invokes the **existing** delta fetch for
*X* with `since=<cached high-water>` and merges by id through the FC2 cache — it
issues no broadcast re-fetch of unrelated collections and adds no new privacy or
window logic of its own. Protocol-neutral: the event names the collection, never
the protocol (Invariant IV).

### PS-A4 — Publish-on-change at all six ingest routes, coalesced — PS4
```bash
( cd web && bundle exec rspec spec/pubsub_spec.rb -e "publishes on every ingest route" -e "coalesces bursts" )
```
**Expected:** pass. Each of the six dashboard ingest routes — `POST /api/nodes`,
`/messages`, `/positions`, `/telemetry`, `/neighbors`, `/traces` — publishes its
collection's change event after a successful write, co-located with the existing
`ApiCache.invalidate_prefix` calls in `routes/ingest.rb`. A burst of writes to one
collection within the debounce window is **coalesced** into a bounded number of
emitted events (not one event per row), so a message flood cannot stampede
subscribers.

### PS-A5 — Push replaces the 60 s poll; reconnect-resync + slow safety poll — PS5
```bash
( cd web && node --test public/assets/js/app/__tests__/main-sse-refresh.test.js )
```
**Expected:** pass. The frontend no longer drives refreshes from a fixed 60 s
timer: (a) an SSE event triggers the matching collection's delta fetch
**immediately**; (b) on every SSE (re)connect the client runs a full delta
**resync** across collections to recover anything missed during the gap; (c) a
**slow safety poll** (default 5 min, configurable; surfaced via
`refresh_interval_seconds`/settings) still runs as a fallback and is the *only*
timer-driven path. The fast 60 s cadence is gone (no `setInterval` at 60 000 ms as
the primary driver).

### PS-A6 — Privacy: no `messages` events when PRIVATE — PS6
*Run the server with `PRIVATE=1`.*
```bash
# The event stream must never carry a messages event in private mode.
curl -s -N --max-time 3 http://127.0.0.1:41447/api/events | grep -i 'messages' \
  && echo "UNEXPECTED: messages event in private mode" || echo "OK: no messages event"
( cd web && bundle exec rspec spec/pubsub_spec.rb -e "suppresses messages events in private mode" )
```
**Expected:** the curl prints `OK: no messages event` (within the 3 s sample the
stream emits no `messages` event under `PRIVATE=1`), and the rspec example passes:
the registry/route suppress `messages` change events in private mode, mirroring
the `/api/messages` 404 (A2a). Non-message collections (`nodes`, `positions`,
`telemetry`, `neighbors`, `traces`) still emit. Because events are thin and the
client re-fetches through the already-filtered `/api`, opt-out / `CLIENT_HIDDEN`
rows never traverse the push (Invariant II).

### PS-A7 — Cache mechanism intact under the event-driven trigger — PS7
```bash
( cd web && node --test public/assets/js/app/__tests__/main-cache-refresh.test.js )
```
**Expected:** pass. The seed-then-delta cache contract (FC-A2) is **unchanged**:
on a warm start the first fetch still requests only `since=<newest cached ts>`,
fresh cached rows are not re-requested, and new rows merge by id and write back.
Only the **trigger** differs (SSE ping / reconnect resync / safety poll instead of
the 60 s timer) — the delta/merge/cache logic is the same path. This is the
realisation of the **PS7** amendment to FC-A2/FC-R1's "cadence unchanged" wording.

### PS-A8 — Graceful degradation; engineering bar — PS8
```bash
( cd web && node --test public/assets/js/app/main/__tests__/event-stream.test.js )
( cd web && bundle exec rspec ) && ( cd web && npm test )
git ls-files 'web/lib/potato_mesh/application/pubsub.rb' \
  'web/public/assets/js/app/main/event-stream.js' \
  | xargs grep -L 'Copyright © 2025-26 l5yth & contributors'
```
**Expected:** pass / no output. When `EventSource` is unavailable, the stream
errors, or the feature is disabled by config, the client silently falls back to
the safety poll and behaves exactly as today's network-only path — the push is
**never load-bearing** (no thrown error reaches the app, no blank UI). The Ruby
and JS suites are green with new unit coverage for `pubsub.rb`, the `/api/events`
route, and the SSE client (100% lines/branches). The `grep -L` prints **no**
output: every new source file carries the exact Apache header (B4a) and is
RDoc/JSDoc-documented (B3).

### PS-R1 — Regression: prior acceptance still holds
```bash
( cd web && npm test ) && ( cd web && bundle exec rspec )
( . .venv/bin/activate && pytest -q tests/ )
```
**Expected:** every prior check still passes. **At risk and explicitly required to
remain green:**
- **A1 / A1a / A1b** (apex) — no broker dependency or external client is
  introduced by the pub/sub (also asserted by PS-A1); a FAIL is a hard-gate FAIL.
- **A2 / A2a / A2b** (privacy) — `/api/messages` still 404s under `PRIVATE`, and
  the stream now additionally carries no `messages` event (PS-A6).
- **FC-A2 / FC-R1** (frontend cache) — the seed-then-delta delta/merge/cache
  contract is unchanged; only their "auto-refresh cadence is unchanged" wording is
  amended per **PS7** (PS-A7). Cache tests are **updated** to the event-driven
  trigger, **not** removed.
- **PL-A1 / PL-A2** (progressive load) and **CR-A1 / CR-A2 / CR-A3** (incremental
  render + map-only hydration) — an SSE-triggered delta flows through the same
  render/merge/hydration path, so idle re-renders still materialise **0** entries
  and no per-node `/api/nodes/:id` request is issued.
- **D1** (`/version`) — still exposes `refresh_interval_seconds` (now the
  safety-poll cadence); the config block is otherwise unchanged.
- **B1** (all suites). No existing POST/GET contract changes (only the additive
  `GET /api/events` and the new event-shape docs in `CONTRACTS.md`), so **C2** and
  the Python suite are unaffected.

---

## Bugfix: MeshCore chat messages must advance node `last_heard` through the synthetic→real merge

A MeshCore channel chat message names its sender via a synthetic, name-derived
placeholder node. Once the real contact advertisement reconciles that placeholder
(issues #803 / #755), the `merge_into_real_node` / `merge_synthetic_nodes` helpers
migrated the message rows but **dropped the placeholder's `last_heard`**, and the
subsequent `touch_node_last_seen` in `insert_message` then targeted the just-deleted
synthetic id — so a node heard only via channel chat showed a stale "last seen". The
merge now carries the synthetic's `last_heard` onto the real node, advancing it but
never moving it backward. Web-side only (Ruby
`web/lib/potato_mesh/application/data_processing/node_writes.rb`); no ingestor / API /
DB-schema change. Meshtastic messages and MeshCore **direct** messages were already
correct (their `from_id` is the real node id, so no synthetic merge intervenes).

### LH-A1 — A reconciled MeshCore chat message advances the real node's `last_heard`
```bash
( cd web && bundle exec rspec spec/data_processing_spec.rb \
    -e "advances the reconciled real node's last_heard when a chat message arrives" )
```
**Expected:** pass. With a real MeshCore contact already on record
(`last_heard = T0`), ingesting a channel message (`to_id="^all"`,
`protocol="meshcore"`, sender named in the text) whose synthetic placeholder
reconciles to that contact advances the real node's `last_heard` to the message
`rx_time` (`> T0`), instead of leaving it pinned at the advertisement time.

### LH-A2 — Both merge directions carry the synthetic's `last_heard`, never backward
```bash
( cd web && bundle exec rspec spec/data_processing_spec.rb \
    -e "carries a merged synthetic's newer last_heard onto the real node" \
    -e "carries the synthetic's newer last_heard onto the real node" \
    -e "never moves the real node's last_heard backward when the synthetic is older" )
```
**Expected:** pass. `merge_synthetic_nodes` (a real advertisement absorbing a
chattier synthetic) and `merge_into_real_node` (a synthetic placeholder folding into
an existing real contact) both advance the real node's `last_heard` to
`MAX(real, synthetic)`; when the synthetic is older the real node's `last_heard` is
left unchanged — the merge never moves "last seen" backward.

### LH-R1 — Regression: prior acceptance still holds
```bash
( cd web && bundle exec rspec )
( . .venv/bin/activate && pytest -q tests/ )
```
**Expected:** all green. At risk and explicitly required to remain green: **MC-A1 /
MC-A2** (#803 synthetic chat-node naming, merge, and redirect — unchanged; the fix
only adds a `last_heard` carry to the same merge helpers), the #755 / #756
synthetic-merge specs in `database_spec.rb` / `data_processing_spec.rb`, and **B1**
(all suites). No POST/GET/event contract change, so the Python ingestor and
`CONTRACTS.md` are unaffected.

---

## Feature: Live-update visual feedback (flash + control cleanup)

Maps to SPEC decisions **VF1–VF7**. Live SSE updates now flash the affected
element white (<100 ms); the poll-era Refresh button and "last updated" field are
removed (play/pause stays). The flash-trigger logic + a flash helper live under
`web/public/assets/js/app/main/` (with co-located `__tests__`); the highlight
keyframe lives in `web/public/assets/styles/base.css`; the only server change is an
additive `nodes` publish on `POST /api/messages`
(`web/lib/potato_mesh/application/routes/ingest.rb`). *Run the server in public
mode for the curl checks; run JS suites from `web/`.*

### VF-A1 — Poll-era controls removed; play/pause kept — VF1
```bash
git grep -nE 'id="refreshBtn"|id="status"' -- web/views
git grep -nE 'id="autorefreshToggle"' -- web/views/layouts/app.erb
( cd web && bundle exec rspec spec/app_spec.rb -e "does not render the Refresh button or last-updated field" )
```
**Expected:** the first grep prints **no output** — the `#refreshBtn` button and the
`#status` "last updated" field are gone from the views. The second prints the
`#autorefreshToggle` line — the play/pause control remains. The rspec example
passes: the rendered dashboard contains no `id="refreshBtn"` and no `id="status"`
refresh-timestamp element, and still contains `id="autorefreshToggle"`. `main.js`
no longer writes `refreshing…` / `updated <time>` status text (it has no `#status`
element to write to).

### VF-A2 — Flash fires only on SSE-ping deltas, never on load/resync/poll — VF2
```bash
( cd web && node --test public/assets/js/app/__tests__/main-flash.test.js )
```
**Expected:** pass. With a fake `EventSource` + stub fetch: the **initial load**
applies **no** flash (no strobe on paint); a subsequent SSE `change` ping for a
collection flashes the affected element; a reconnect (`open` → resync) and a
safety-poll refresh apply **no** flash. The flash is driven only from the
SSE-ping-driven targeted refresh (`runLiveRefresh`), confirmed by asserting a
resync/poll-shaped refresh leaves the flash count unchanged.

### VF-A3 — Correct element flashes per collection (incl. message⇒node) — VF3
```bash
( cd web && node --test public/assets/js/app/__tests__/main-flash.test.js )
( cd web && bundle exec rspec spec/pubsub_spec.rb -e "publishes nodes on a message ingest" )
```
**Expected:** pass. A `nodes`/`positions`/`telemetry` ping flashes the affected
node's **node-table row** (`[data-node-id]`) and **map marker**. A `messages` ping
flashes the **message row** and the **channel tab header**; and because
`POST /api/messages` **also publishes `nodes`** (extends PS4 — verified by the rspec
example: a single message POST publishes both `messages` and `nodes`), the author
node's row + marker flash too. `neighbors` / `traces` pings flash **nothing** (the
documented out-of-scope boundary). Detection is by id/collection and identical for
both protocols (Invariant IV).

### VF-A4 — Flash is applied after render, never to an unrendered element — VF4
```bash
( cd web && node --test public/assets/js/app/__tests__/main-flash.test.js )
```
**Expected:** pass. The flash is applied in a post-render step: a ping for a node
not yet present in the DOM first renders/positions the row + marker (and a message
renders its row + tab), and only then is the highlight applied — asserted by
checking the flashed element exists and is the final rendered node at flash time
(the render call precedes the flash call within the tick).

### VF-A5 — White, reduced-motion-aware highlight (now ~1.2 s; see LV-A1) — VF5
```bash
( cd web && node --test public/assets/js/app/main/__tests__/flash.test.js )
grep -nE '@media \(prefers-reduced-motion: reduce\)' web/public/assets/styles/base.css
grep -nE '(animation|transition)[^;]*(1\.2s|120[0-9]ms)' web/public/assets/styles/base.css  # amended by LV-A1
```
**Expected:** pass / non-empty. The flash helper applies a one-shot highlight class
and clears it (or relies on a self-completing CSS animation) with **no layout
shift**. `base.css` carries the highlight keyframe/rule with a duration **~1.2 s**
(amended from the original <100 ms by **LV-A1** below) and a
`@media (prefers-reduced-motion: reduce)` guard that suppresses the animation
(data still updates; only the visual is withheld). The white onset and the fade
duration are confirmed by reading the rule.

### VF-A6 — Render & cache invariants preserved; #822 holds — VF6
```bash
( cd web && node --test public/assets/js/app/__tests__/main-chat-render-incremental.test.js )
( cd web && bundle exec rspec spec/app_spec.rb -e "updates node last_heard for plaintext messages" )
```
**Expected:** pass. With the flash code present, an **idle** re-render still
materialises **0** entries and issues **0** per-node `/api/nodes/:id` requests
(**CR-A1** unchanged — the flash touches only already-rendered/cached DOM and never
re-materialises). The existing #822 example confirms a message ingest still bumps
the author node's `last_heard` (also covered at the unit level by
`data_processing_spec.rb` "advances the reconciled real node's last_heard when a
chat message arrives"), which is what makes the message⇒node flash reflect real
data. The seed-then-delta cache (FC-A2) is untouched.

### VF-A7 — Engineering bar — VF7
```bash
( cd web && bundle exec rspec ) && ( cd web && npm test )
git ls-files 'web/public/assets/js/app/main/flash.js' \
  'web/public/assets/js/app/__tests__/main-flash.test.js' \
  | xargs grep -L 'Copyright © 2025-26 l5yth & contributors'
```
**Expected:** pass / no output. The Ruby and JS suites are green with new coverage
for the flash trigger (changed-id selection, after-render ordering, ping-only
gating, message⇒node fan-out), the flash helper, and the `nodes`-on-message publish.
Every new source file carries the exact Apache header (B4a) and JSDoc (B3).

### VF-R1 — Regression: prior acceptance still holds
```bash
( cd web && npm test ) && ( cd web && bundle exec rspec )
( . .venv/bin/activate && pytest -q tests/ )
```
**Expected:** every prior check still passes. **At risk and explicitly required to
remain green:**
- **CR-A1 / CR-A2 / CR-A3** (incremental render + map-only hydration — the flash
  never re-materialises or fetches per node).
- **PS-A5 / PS-A7** (SSE targeted fetch + cache delta) and **FC-A2** (seed-then-delta
  — flashing is gated to SSE-ping deltas, so warm-start/resync/poll never flash).
- **PS-A6 / A2 / A2a** (privacy — `/api/messages` still 404s in `PRIVATE`, so the new
  `nodes`-on-message publish is moot there; node events are not privacy-gated).
- **PL-A1 / PL-A2** (progressive load), **A4c** (chat parity — same render path), and
  the **autorefresh/pause** specs (the toggle still pauses live + poll after the
  Refresh/status controls are removed).
- **B1** (all suites). The only contract change is the additive `nodes` publish on
  message ingest (a new SSE event, documented in `CONTRACTS.md`); no POST/GET shape
  changes, so **C2** and the Python suite are unaffected.

---

## Bugfix: MeshCore cross-ingestor dedup keys on the stable channel name

A single physical MeshCore channel message heard by two ingestors that store the
same logical channel at **different local channel-slot indices** was stored twice.
The per-receiver `channel` index is not stable across ingestors (e.g. `#bot` sits
at slot 4 on one device and slot 6 on another), yet it fed both the ingestor
fingerprint discriminator (`c<N>` → two different `messages.id` values) and the
#756 web content-dedup SELECT (`AND channel = ?` → no match), so neither dedup
layer collapsed the duplicate. Fix (web-only, no wire change): the content-dedup
matches on the sender-stable `channel_name` (NULL-safe) instead of the local
`channel` index, so the safety net collapses the duplicate at the system of record
regardless of differing ids/slots. Strengthens **C5**.

### MD-A1 — Same message on different local channel slots collapses to one row
```bash
( cd web && bundle exec rspec spec/data_processing_spec.rb -e "meshcore content dedup" )
```
**Expected:** pass, including "collapses the same meshcore channel message heard on
different local channel indices": two meshcore messages with identical `from_id` /
`to_id` / `text` / in-window `rx_time` and the **same `channel_name`** ("#bot") but
**different `channel` indices** (4 vs 6) and different ids collapse to a **single**
stored row. Companion examples still hold: messages with a **different
`channel_name`** are kept separate (the legitimate distinct-channel case), and
different `text` / `to_id` / beyond-window `rx_time` stay separate.

### MD-R1 — Regression: prior acceptance still holds
```bash
( cd web && bundle exec rspec ) && ( cd web && npm test )
( . .venv/bin/activate && pytest -q tests/ )
```
**Expected:** all green. At risk and required to remain green: **C5** (cross-ingestor
dedup by id — now strengthened), the other #756 content-dedup examples (window
inclusivity, different text/recipient), and **B1**. The pre-existing "does not
collapse two meshcore messages on different channels" example is **updated** to use
different channel *names* (the stable identifier) rather than different local
indices — it is updated, not removed. No POST/GET/event contract change and no
ingestor change, so **C2**, `CONTRACTS.md`, and the Python suite are unaffected.

---

## Bugfix: Live-update DOM handling (map overlay, chat-tab scroll, last_heard fan-out)

Three defects in how a live SSE update touches the DOM, fixed independently of
the (separately specced) flash visual redesign:
(1) a `positions` / `telemetry` ingest advances the affected node's `last_heard`
server-side (`touch_node_last_seen`) but published only its own collection, so
the live dashboard never re-pulled the node row and the node table's "last seen"
stayed stale until the safety poll;
(2) the channel-tab list's horizontal scroll reset to the first tab on every
refresh because `renderChatTabs` rebuilds the whole subtree (`replaceChildren`)
and force-scrolled the active tab into view;
(3) an open map-marker short-info overlay closed on every refresh because
`renderMap` clears and rebuilds all markers (`clearLayers`), orphaning the
overlay's anchor so `cleanupOrphans` closed it.
Web-side only (Ruby publish fan-out + frontend JS); no POST/GET shape change, so
the apex (I) and privacy (II) invariants are untouched (the new `nodes` publish
is moot under `PRIVATE`, mirroring #822 / PS6).

### LD-A1 -- positions/telemetry ingest also publishes `nodes` (live last_heard refresh)
```bash
( cd web && bundle exec rspec spec/pubsub_spec.rb \
    -e "publishes nodes on a positions ingest" \
    -e "publishes nodes on a telemetry ingest" \
    -e "does not publish nodes on a neighbors or traces ingest" )
```
**Expected:** pass. `POST /api/positions` and `POST /api/telemetry` each publish
both their own collection **and** `nodes` (the telemetry route also now
invalidates `api:nodes:`), so the dashboard re-fetches `/api/nodes` and the
node-table "last seen" refreshes and flashes live -- mirroring the #822
messages-to-nodes fan-out. `POST /api/neighbors` and `/api/traces` deliberately
do **not** publish `nodes`, honoring the VF3 boundary that neighbors/traces flash
nothing (their `last_heard` refresh is surfaced silently by the safety poll).

### LD-A2 -- channel-tab horizontal scroll is preserved across a refresh
```bash
( cd web && node --test public/assets/js/app/__tests__/chat-tabs.test.js )
```
**Expected:** pass. `renderChatTabs` captures the channel-tab list's `scrollLeft`
before rebuilding the subtree and restores it afterward, and scrolls the active
tab into view **only** on an explicit user tab switch (not on a passive refresh)
-- so a live update no longer yanks the user back to the first tab while they
scroll the channel list. A re-render yields a fresh tab-list element whose
`scrollLeft` equals the pre-render value, and a passive render performs **zero**
`scrollIntoView` calls.

### LD-A3 -- an open map-marker overlay survives a live re-render
```bash
( cd web && node --test public/assets/js/app/__tests__/short-info-overlay-manager.test.js \
                       public/assets/js/app/main/__tests__/marker-overlay-preservation.test.js )
```
**Expected:** pass. The overlay stack gains `reanchor(oldAnchor, newAnchor)`,
which carries an open overlay onto a replacement anchor so a subsequent
`cleanupOrphans` keeps it open (it closed it before). `renderMap` snapshots the
node ids whose marker hosts an open overlay before `clearLayers()` and re-anchors
each onto the rebuilt marker (`captureOpenMarkerOverlays` /
`restoreMarkerOverlays`), so an overlay opened on the map stays open while live
updates fire instead of snapping shut on every refresh.

### LD-R1 -- Regression: prior acceptance still holds
```bash
( cd web && npm test ) && ( cd web && bundle exec rspec )
( . .venv/bin/activate && pytest -q tests/ )
```
**Expected:** all green. At risk and explicitly required to remain green:
**PS-A3 / PS-A4** (per-collection publish + coalescing -- the PS3 "thin event"
and burst-coalescing examples are **updated** to a single-collection route
(`neighbors`) since positions now also publishes `nodes`, not removed);
**VF-A2 / VF-A3** (flash gating + message-to-node fan-out -- the new
positions/telemetry-to-node fan-out reuses the same flash path, and neighbors/
traces still flash nothing); **CR-A1** (an idle re-render still materialises 0
entries -- the scroll/overlay preservation touches only already-built DOM);
**A2 / A2a / PS-A6** (privacy -- the new `nodes` publish is moot under `PRIVATE`);
and **B1** (all suites).

---

## Feature: Live-update feedback v2 (fade, stacking, map wave, dedup, full log)

Maps to SPEC decisions **LV1-LV9**, which deliberately amend VF2/VF3/VF5. The
<100 ms white strobe becomes a ~1.2 s white->role-colour fade with per-element
stacked timers; a node highlight also emits a map-marker wave; the message
highlight blinks only the message's own channel tab; the pub/sub gains a 1 s
per-collection publish cooldown; the Log tab logs every live-event class; and a
channel-tab dropdown selector is added. *Run JS suites from `web/`; run the
server in public mode for the curl/rspec checks.*

### LV-A1 -- ~1.2 s white->role-colour fade replaces the <100 ms strobe -- LV1, LV3
```bash
( cd web && node --test public/assets/js/app/main/__tests__/flash.test.js )
grep -nE '@media \(prefers-reduced-motion: reduce\)' web/public/assets/styles/base.css
grep -nE '(animation|transition)[^;]*(1\.2s|120[0-9]ms)' web/public/assets/styles/base.css
grep -nE -- '--flash-role-color' web/public/assets/styles/base.css
```
**Expected:** pass / non-empty. The highlight keyframe runs **~1.2 s** (not
<100 ms), starts white and fades through the element's role colour
(`var(--flash-role-color, ...)`) with increasing transparency to nothing, with
**no layout shift** and a `prefers-reduced-motion: reduce` guard that suppresses
it. The flash helper's `FLASH_DURATION_MS` is ~1200 and only toggles a class.

### LV-A2 -- per-element stacked timers; a re-flash restarts cleanly -- LV2
```bash
( cd web && node --test public/assets/js/app/main/__tests__/flash.test.js )
```
**Expected:** pass. `flashElement` runs each element on its own timer and, when
re-flashed mid-fade, **cancels the prior removal timer** before re-arming so the
class is never cleared early; two distinct elements flashed in the same tick each
keep an independent timer (no shared/global clock).

### LV-A3 -- role colour is stamped on the element at render -- LV3
```bash
( cd web && node --test public/assets/js/app/__tests__/node-rendering.test.js \
                       public/assets/js/app/__tests__/main-flash.test.js )
```
**Expected:** pass. A rendered node-table row and chat message row carry
`--flash-role-color` set from `getRoleColor(role, protocol)` (so the fade lands on
the correct role colour for both protocols); the flash helper performs no colour
lookup of its own.

### LV-A4 -- a message fades its row and ONLY its own channel tab -- LV4
```bash
( cd web && node --test public/assets/js/app/main/__tests__/flash.test.js \
                       public/assets/js/app/__tests__/main-flash.test.js )
```
**Expected:** pass. A `messages` ping fades the message row(s) and highlights the
header of **only the message's own channel tab** (resolved via the message->tab
map), never merely the active tab; the author node's row + marker fade via the
existing message->nodes publish.

### LV-A5 -- a node highlight emits a map-marker wave -- LV5
```bash
( cd web && node --test public/assets/js/app/main/__tests__/flash.test.js )
grep -nE 'live-flash-wave|@keyframes .*wave' web/public/assets/styles/base.css
```
**Expected:** pass / non-empty. Flashing a marker creates a transient expanding
wave overlay (from ~12 px, growing and fading toward the role colour over ~1.2 s)
added to the map and removed after the animation; `neighbors`/`traces` emit no
wave (VF3 boundary). The wave is non-interactive and causes no layout shift.

### LV-A6 -- per-collection 1 s publish cooldown dedups duplicate events -- LV6
```bash
( cd web && bundle exec rspec spec/pubsub_spec.rb -e "cooldown" )
```
**Expected:** pass. A burst of `publish(...)` calls is coalesced by the
**settle window** in `Subscriber#drain` (default 1 s, env-tunable
`SSE_PUBLISH_COOLDOWN`): once a change is pending the drain waits out the window,
then returns each changed collection **once** (the structural pending-map
coalescing), so N ingestors hearing a single packet produce one client
refresh/flash. Collections that change during the same window each emit once (not
suppressed). In-process only (no broker; apex-safe); `settle: 0` disables it.

### LV-A7 -- the Log tab is node-centric; message bodies never reach it -- LV7 (amended)
```bash
( cd web && node --test public/assets/js/app/__tests__/chat-log-tabs.test.js \
                       public/assets/js/app/__tests__/main-log-render.test.js \
                       public/assets/js/app/main/__tests__/chat-entry-keys.test.js )
```
**Expected:** pass. `buildChatTabModel(...).logEntries` carries **no** plaintext
`message` entry: a decrypted message is recorded as a **node-info update** (reason
`message`) for its sender, so the body lives **only** in its channel tab. Every
live collection still has a Log representation -- new node, advert / node-info
update ("Updated node info (advert)"), decrypted message ("Updated node info
(message)"), position ("Broadcasted position info: ..." with a colon), neighbour,
telemetry, trace, and encrypted message. The generic "updated node info
(<reason>)" is emitted **only when no more-specific event already claims that
heard** (a position/telemetry/neighbour/trace/message suppresses a redundant
advert line). **Amends the prior LV-A7**, which required a plaintext message entry
in the Log -- the oversight corrected here. Hidden-protocol and PRIVATE gates
already applied to the chat are unchanged.

### LV-A8 -- channel-tab dropdown selector -- LV8
```bash
( cd web && node --test public/assets/js/app/__tests__/chat-tabs.test.js )
```
**Expected:** pass. `renderChatTabs` renders a compact selector listing every tab
that, when a channel is chosen, activates that tab - independent of the preserved
horizontal scroll (LD-A2). Tab order, the default-active tab, and all data
surfaces are unchanged.

### LV-A9 -- engineering bar; invariants untouched -- LV9
```bash
( cd web && bundle exec rspec ) && ( cd web && npm test )
```
**Expected:** pass. New code carries the exact Apache header + JSDoc/RDoc and is
100% unit-tested; `prefers-reduced-motion` suppresses both the fade and the wave.
Apex (I), privacy (II - messages still 404 under PRIVATE, so message fades/log are
moot there; the LV6 cooldown is in-process with no broker), and parity (IV - role
colours via `getRoleColor` for both protocols) are untouched.

### LV-R1 -- Regression: prior acceptance still holds
```bash
( cd web && npm test ) && ( cd web && bundle exec rspec )
( . .venv/bin/activate && pytest -q tests/ )
```
**Expected:** all green. **VF-A5 is amended** (the duration grep now matches
~1.2 s, not <100 ms) - updated, not removed. At risk and required to remain green:
**VF-A2** (flash still fires only on SSE-ping deltas), **VF-A4** (render before
flash), **VF-A6 / CR-A1** (idle re-render still materialises 0 entries), **LD-A1**
(positions/telemetry->nodes fan-out feeds the fade), **LD-A2** (tab scroll
preserved - the LV8 dropdown composes with it), **A2 / A2a / PS-A6** (privacy),
and **B1** (all suites).

---

## Bugfix: SSE stream must not block graceful shutdown

On Ctrl+C the dashboard hung ~30-45s before exiting: an open `GET /api/events`
SSE stream held a Puma worker thread in its `pump` loop (which exited only on
socket close or the 600s lifetime deadline), so Puma's graceful shutdown waited
for it -- which in turn gated the `at_exit` federation/retention teardown
(FH-A3). The federation announce (`remote_instance_request_timeout`, 30s) and the
retention thread kept logging because the process could not exit. Pre-existing
since the SSE pub/sub feature (#821), not the LV6 settle window. Fix (web-only):
(1) the SSE `pump` exits when its subscriber is closed; (2) INT/TERM handlers
close the live-update subscribers on shutdown (chained ahead of Sinatra's trap,
since Puma `Server#stop` is async), so the streams end and Puma drains promptly;
(3) a Puma `force_shutdown_after` backstop (default 3s, env `PUMA_FORCE_SHUTDOWN`)
force-terminates anything still in flight. The apex (I) and privacy (II)
invariants are untouched.

### SD-A1 -- the SSE pump stops when its subscriber is closed (shutdown)
```bash
( cd web && bundle exec rspec spec/routes_events_spec.rb -e "stops pumping once the subscriber is closed" )
```
**Expected:** pass. `Events.pump` returns as soon as its subscriber is closed --
without writing further keepalives -- even while the stream is still open and the
lifetime deadline is far off, so closing subscribers on shutdown ends every
`/api/events` request instead of busy-looping or blocking for a heartbeat.

### SD-A2 -- shutdown closes SSE subscribers and Puma is bounded
```bash
( cd web && bundle exec rspec spec/app_spec.rb -e "live-update shutdown handling" )
( cd web && bundle exec rspec spec/config_spec.rb -e "puma_force_shutdown_seconds" )
```
**Expected:** pass. `close_live_update_subscribers!` closes every open subscriber;
`install_pubsub_shutdown_signal_handlers!` traps INT and TERM and its handler
closes the subscribers; `server_settings` carries `force_shutdown_after`
(= `puma_force_shutdown_seconds`; default 3s, env `PUMA_FORCE_SHUTDOWN`). Together
these make Ctrl+C reap the SSE stream so Puma's graceful shutdown finishes and the
at_exit federation/retention teardown (FH-A3) runs in seconds, not tens of them.

### SD-R1 -- Regression: prior acceptance still holds
```bash
( cd web && bundle exec rspec ) && ( cd web && npm test )
( . .venv/bin/activate && pytest -q tests/ )
```
**Expected:** all green. At risk and required to remain green: **PS-A2 / PS-A5**
(the `/api/events` SSE stream + reconnect-resync still work -- the pump only gains
a subscriber-closed exit), **PS-A4 / LV-A6** (publish + 1s settle window are
unchanged), **FH-A3** (federation reaps in seconds -- now actually reachable on
Ctrl+C because the SSE no longer blocks Puma), and **B1** (all suites). No
POST/GET/event contract change.

## Bugfix: SSE streams must not starve the request-thread pool

The live production instance went unresponsive: every request 502'd, including the
instance's own federation self-fetch of `/api/nodes`, and at shutdown exactly five
`/api/events` connections closed (durations 45-160s). Root cause: a `GET
/api/events` SSE stream pins one Puma worker thread for its whole lifetime (the
`pump` loop runs synchronously on the request thread; SD-A1), but the subscriber
cap (`MAX_SUBSCRIBERS` = 64) sat far above Puma's pool. With no thread config the
app ran on Puma's MRI default of **5** threads, so ~5 dashboard clients holding an
`EventSource` occupied every worker thread and no other request -- API read,
ingest POST, or federation self-fetch -- could be served. The cap never tripped
before the pool starved; live updates became load-bearing, violating **PS8**.
Pre-existing since the SSE pub/sub feature (#821). Fix (web-only): (1) size Puma's
thread pool in code via `server_settings[:Threads]` (`Config.puma_threads_setting`,
default `16:96`, env `MIN_THREADS`/`MAX_THREADS`); (2) clamp the SSE subscriber cap
to `puma_max_threads - sse_thread_reserve` (env `SSE_THREAD_RESERVE`, default 32) so
at least the reserve always remains for non-SSE traffic -- the defaults reconcile to
the original 64 (`96 - 32`). New decision **PS9** names the budget invariant
(`max_threads > MAX_SUBSCRIBERS + reserve`). The apex (I), privacy (II), and parity
(IV) invariants are untouched; no POST/GET/event contract changes.

### TS-A1 -- SSE can never consume the whole request-thread pool
```bash
( cd web && bundle exec rspec spec/sse_thread_budget_spec.rb )
```
**Expected:** pass. Boots a real Puma with a small fixed pool (`Threads "6:6"`,
`SSE_THREAD_RESERVE=4`) and opens `pool`-many `/api/events` connections: at most
`pool - reserve` are accepted (the rest get `503` and fall back to the safety poll,
PS8), and a plain `GET /version` is still served promptly while SSE clients are
connected. Against the unfixed code all six connections are accepted and the
ordinary request times out (the outage).

### TS-A2 -- thread budget exceeds the SSE subscriber cap by the reserve
```bash
( cd web && bundle exec rspec spec/config_spec.rb -e "puma thread budget" )
( cd web && bundle exec rspec spec/pubsub_spec.rb -e "effective subscriber cap" )
( cd web && bundle exec rspec spec/app_spec.rb -e "request-thread budget" )
```
**Expected:** pass. `Config.puma_max_threads` (default 96, env `MAX_THREADS`),
`Config.puma_min_threads` (default 16, env `MIN_THREADS`), and
`Config.sse_thread_reserve` (default 32, env `SSE_THREAD_RESERVE`) resolve and
clamp sanely (`min <= max`); `Config.puma_threads_setting` returns `"min:max"`;
`PubSub.effective_max_subscribers` equals `min(MAX_SUBSCRIBERS, max_threads -
reserve)` (= 64 at defaults) and shrinks when the pool shrinks; and the application
`server_settings[:Threads]` is present with `max > MAX_SUBSCRIBERS` (the invariant
that was silently false before, when no `:Threads` was set at all).

### TS-R1 -- Regression: prior acceptance still holds
```bash
( cd web && bundle exec rspec ) && ( cd web && npm test )
( . .venv/bin/activate && pytest -q tests/ )
```
**Expected:** all green. At risk and required to remain green: **PS-A2 / PS-A5**
(the `/api/events` SSE stream + reconnect-resync still work), **PS-A3** (the
subscriber cap still returns `503` at capacity -- now at the clamped value),
**SD-A1 / SD-A2** (shutdown still reaps SSE; `server_settings` still carries
`force_shutdown_after` alongside the new `Threads`), and **B1** (all suites). No
POST/GET/event contract change.

---

## Feature: Reliable dark basemap (CARTO Dark Matter) + tolerant tile loading

Maps to SPEC decisions **DM1–DM6**. The basemap URL + tolerant-load policy live in
`web/public/assets/js/app/main.js` (dashboard) and
`web/public/assets/js/app/federation-page.js` (federation); the offline fallback in
`web/public/assets/js/app/main/offline-tile-layer.js`; the now-removed tile filter
in `web/lib/potato_mesh/config.rb`,
`web/lib/potato_mesh/application/helpers/config_helpers.rb`, and
`web/public/assets/styles/base.css`. Unless noted, run JS checks from `web/` and
shell checks from the repo root.

### DM-A1 — Both maps use CARTO Dark Matter; HOT is gone — DM1
```bash
git grep -nE "basemaps\.cartocdn\.com/dark_all" -- web/public/assets/js
git grep -niE "openstreetmap\.fr|/hot/" -- web/public/assets/js web/lib web/views
```
**Expected:** the first prints the CARTO Dark Matter URL
(`{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png`) from **one** shared
constant referenced by both the dashboard and federation maps; the second prints
**nothing** — no `openstreetmap.fr` / `/hot/` reference remains anywhere. The
layer options (subdomains `abcd`, `detectRetina`, `crossOrigin:'anonymous'`,
`maxZoom`) are asserted by the JS map-init / DM-A3 suite.

### DM-A2 — Tile-filter pipeline fully removed (native dark) — DM2
```bash
git grep -niE "tile_filters|DEFAULT_TILE_FILTER|map_tile_filter|tileFilters|map-tile-filter|map-tiles-filter|resolveTileFilter|applyTileFilter|applyFiltersToAllTiles|applyFilterToTile|ensureTileHasCurrentFilter" -- web/lib web/public/assets web/views
git grep -n -A2 "def resolve_initial_theme" -- web/lib/potato_mesh/application/routes/root.rb
```
**Expected:** the first prints **no output** — every artifact of the per-theme
grayscale/invert filter is gone from Ruby, JS (incl. `settings.js` and the
`theme.js` `applyFiltersToAllTiles` hook), and CSS. The `.map-tiles` **class** may
remain (it tags the tile layer) but carries no `filter:` rule and no
`--map-tile*-filter` custom property. The second shows `resolve_initial_theme`
still returns `"dark"` (the theme system was already dark-only; unchanged).

### DM-A3 — Dashboard tolerates isolated tile errors — DM3
```bash
( cd web && node --test public/assets/js/app/main/__tests__/tile-failure-policy.test.js )
```
**Expected:** pass. The extracted, Leaflet-free basemap-liveness policy
(`main/tile-failure-policy.js`) decides: (a) a `tileerror` — one or many — that
arrives **after** at least one successful `tileload` does **not** request the
offline fallback; (b) when the initial viewport yields **zero** successful loads
and the layer signals load-complete (or the no-success error count crosses the
threshold), the offline fallback **is** requested exactly once; (c) once latched
"alive," later errors never re-request the fallback. The dashboard wires this
policy to `tiles.on('tileload'|'tileerror'|'load')` so an isolated failed tile no
longer flips the whole map to the offline placeholder.

### DM-A4 — Adjacent light remnants removed — DM4
```bash
git grep -nE 'content="dark light"' -- web/views
git grep -nE "f6f3ee" -- web/public/assets
```
**Expected:** **no output** for either — the `color-scheme` meta is `content="dark"`
and `background.js` resolves the dark background colour unconditionally
(`'#0e1418'`), with no light-mode branch.

### DM-A5 — Clean map: no attribution overlay — DM5
```bash
git grep -nE "attributionControl:\s*false" -- web/public/assets/js
git grep -nE "\battribution:" -- web/public/assets/js/app/main.js web/public/assets/js/app/federation-page.js
```
**Expected:** the first prints `attributionControl: false` on **both** the
dashboard and federation maps (unchanged from today); the second prints
**nothing** — no `attribution:` credit string was added.

### DM-A6 — Apex/contract untouched — DM6
```bash
git grep -niE 'mqtt|mosquitto|paho|amqp|kafka|broker' -- web/public/assets/js/app/main.js web/public/assets/js/app/federation-page.js
git grep -nE "tileFilters" -- web/lib/potato_mesh/application/helpers/config_helpers.rb
```
**Expected:** **no output** for either. The basemap host is not a broker, so the
apex check **A1** stays green; and `frontend_app_config` no longer emits
`tileFilters`, confirming nothing leaked into the `data-app-config` /
`/version` surface (the `/version` config block — **D1 / BF1** keys — is
unchanged, so no `/api/*` or `/version` contract moves).

### DM-A7 — Dead light CSS palette collapsed (dark-only) — DM7
```bash
git grep -niE "color-scheme:\s*light|f6f3ee|#0c0f12|#2b6cb0|fff4d6|#7a3f00|f0c05b" -- web/public/assets/styles/base.css
git grep -nE "^html \{|color-scheme: dark|^body\.dark \{" -- web/public/assets/styles/base.css
```
**Expected:** the first prints **nothing** — no light-palette hex values and no
`color-scheme: light` remain (the dead light `:root` tokens, the always-overridden
`body.dark` token block, and the light `color-scheme` are all gone). The second
shows `html { color-scheme: dark }` and **no** `body.dark { … }` *token-definition*
block — the `:root` block now carries the dark palette directly, so `html` itself
resolves dark tokens; `body.dark` survives only as a prefix on component rules,
which still apply because `body` always carries the class. The rendered dark UI is
unchanged (confirmed by screenshot).

### DM-R1 — Regression: prior acceptance still holds
```bash
( cd web && npm test ) && ( cd web && bundle exec rspec )
```
**Expected:** every prior check still passes. At risk and explicitly required to
stay green: **B1** (all suites — the JS map/tile tests and the Ruby config/app
specs), **B4** (the exact Apache header on the new `main/tile-failure-policy.js`
and its test), **A1** (apex — the basemap CDN is not a broker), and **D1 / BF1**
(the `/version` config block is unchanged). The existing tile-filter assertions
are **updated or removed as dead**, never left dangling: `__tests__/config.test.js`
(drops the `tileFilters` expectation), `__tests__/federation-page.test.js` (drops
`tileFilters` / `themechange`), the `theme.js` test (drops the
`applyFiltersToAllTiles` hook), and the Ruby config/app specs that asserted
`data-app-config` `tileFilters`. `main/__tests__/offline-tile-layer.test.js` stays
green — the fallback layer is retained, now reached only per DM-A3.

---

## Bugfix: Progressive backfill for every bulk collection (issue #832)

The server pages **every** bulk collection backward via `?before=` (SPEC
BP1-BP8), but only the message feed wired it on the client (the deferred
follow-up **BP9a**). So the node table — and positions, telemetry, neighbors,
traces — stalled at the newest `MAX_QUERY_LIMIT` (1000) rows the server returns
in one page (the reported symptom: "the node table only lists 1000 items").
The fix mirrors the proven chat backfill (issue #802) across all five
collections: the newest page paints first, then a one-shot background pager
walks each collection's inclusive `before` cursor newest → oldest, de-duplicating
by id and committing+rendering each page, until the visibility window is
exhausted. The client row-caps on positions/telemetry/traces are lifted from a
fixed count to the server's own window bound (so a backfilled page is not trimmed
straight back out on the next refresh). Frontend-only: no API/DB/ingestor change,
so the C4/C7 window floors, `MAX_QUERY_LIMIT`, and privacy are untouched.

### CB-A1 — Every bulk collection pages backward past the first 1000-row page
```bash
( cd web && node --test public/assets/js/app/__tests__/main-collection-backfill.test.js )
```
**Expected:** pass. On a cold load whose newest page is **full** (=== the
per-collection cap), each of `nodes`, `positions`, `telemetry`, `neighbors`, and
`traces` issues at least one `GET /api/<collection>?…&before=<cursor>` request and
merges the older rows in — so the loaded node set grows **past** `NODE_LIMIT`
(1000) instead of stalling at it. The newest page is rendered **before** any
backward paging starts (the page is never blank/blocking), matching the #802
progressive-load contract. A short newest page (window already exhausted) records
no frontier and fires **no** backward request.

### CB-A2 — Generic backward pager + `before` cursor on every fetcher
```bash
( cd web && node --test public/assets/js/app/main/__tests__/data-fetchers.test.js )
```
**Expected:** pass. `paginateCollection(fetchPage, {limit, before, idOf, cursorOf})`
generalises the message walk (`paginateMessages` now delegates to it): it pages
newest → oldest, de-duplicates by `idOf`, advances an inclusive `before` cursor to
the oldest `cursorOf` value of each page, and stops on a short page / no-progress /
missing cursor / `maxPages`. `fetchNodes`/`fetchPositions`/`fetchTelemetry`/
`fetchNeighbors`/`fetchTraces` each forward a positive `before` and omit a
non-positive one (mirroring the existing `fetchMessages` `before` contract, C7);
`fetchTraces` accepts `applyAgeFilter:false` so the pager sees the server's raw
page length and terminates correctly.

### CB-R1 — Regression: prior acceptance still holds
```bash
( cd web && npm test ) && ( cd web && bundle exec rspec )
```
**Expected:** every prior check still passes. At risk and explicitly required to
stay green: **C7 / PL-A1 / PL-A2** (the message pager is unchanged — `paginateMessages`
delegates to the new generic pager with identical observable behavior), **B1**
(all suites), and **B4** (the exact Apache header on the new test). The cursor
columns match the server's `ORDER BY` per collection (`last_heard` for nodes,
`rx_time` for the rest), so no widening of the C4 window floor is possible; the
backfill only ever *narrows* (BP2).

---

## Bugfix: MeshCore dedup window vs inter-ingestor clock skew; warm-cache chat gap

Two chat defects found on production `potatomesh.net` (v0.7.1-rc0) with two
live MeshCore ingestors. **(2) Duplicates:** 28% of MeshCore rows were
distinct-id copies of the same transmission from two ingestors whose host
clocks differ by a consistent ~126 s (median 126 s, p90 133 s). The content
dedup (`data_processing/messages.rb`) keys correctly on `channel_name` (#825,
MD-A1) but bounded the match to `rx_time ± 30 s`, so 89.6% of dup pairs fell
outside the window and persisted; the one-shot #756 purge additionally keyed on
the per-receiver `channel` **index** (not `channel_name`), so it could not
collapse the cross-slot copies even when it ran. Fix: widen
`MESHCORE_CONTENT_DEDUP_WINDOW_SECONDS` 30→300 (covers ~99.5% of the observed
skew; **accepted tradeoff:** a sender's *identical* text repeated within 300 s
collapses — chosen over a 28% dup rate; the one-shot purge applies this
**transitively**, so a chain of such repeats spanning longer than 300 s also
collapses — a deliberately aggressive one-time cleanup, gentler per-insert guard
governs new rows), key the purge on `channel_name`, and bump
`MESHCORE_CONTENT_DEDUP_BACKFILL_VERSION` so the purge re-runs once to clear the
accumulated duplicates. **(1) Missing messages:** on a warm revisit
the cache (FC2) seeds an older contiguous block, but the delta `since`-fetch is
capped at `MESSAGE_LIMIT` and returns the **newest** page (`ORDER BY rx_time
DESC LIMIT`), which need not reach the cache — orphaning the window between the
cache's newest row and the newest page's oldest row. `backfillChatHistory`
anchored at the **global-oldest** loaded row and paged further into the past, so
it never bridged the gap. Fix: anchor the backfill at the **live frontier** (the
oldest row of the newest delta page). The duplicate inflation (defect 2) widened
the gap, so the two interact, but each has a distinct root cause. Web-only; no
wire/contract change; apex (I)/privacy (II) untouched.

### MW-A1 — Dedup spans the observed inter-ingestor clock skew (runtime + purge)
```bash
( cd web && bundle exec rspec spec/data_processing_spec.rb -e "meshcore content dedup" \
                            spec/database_spec.rb -e "cross-ingestor meshcore pair" )
```
**Expected:** pass. Runtime: two MeshCore copies with identical `from_id` /
`to_id` / `text` / `channel_name` ("#ping") but different `channel` slots
(10 vs 18) and `rx_time` **126 s apart** collapse to one row (was two — the
30 s window). The one-shot purge collapses the same cross-slot, clock-skewed
pair to a single row by keying on `channel_name` and spanning the widened
window. `MESHCORE_CONTENT_DEDUP_WINDOW_SECONDS == 300` and
`MESHCORE_CONTENT_DEDUP_BACKFILL_VERSION` is bumped so the purge re-runs once.
Companion #756/#825 examples still hold (different `channel_name` / `text` /
`to_id` stay separate; beyond-window — now `> 300 s` — stays separate).

### MW-A2 — Warm-cache load bridges the orphaned middle gap
```bash
( cd web && node --test public/assets/js/app/__tests__/main-cache-refresh.test.js )
```
**Expected:** pass, including "warm cache + capped since-page bridges the
orphaned middle gap": with a seeded cache whose newest row predates the newest
`since`-page by more than one page, the background backfill fetches the
in-between rows (anchored at the live frontier) so **every** in-window message
loads — no orphaned hole. The cold-load path is unchanged (live frontier ==
global-oldest when there is no cache), so the existing seed-then-delta examples
(FC-A2) and the progressive-load walk (PL-A1/PL-A2) stay green.

### MW-R1 — Regression: prior acceptance still holds
```bash
( cd web && bundle exec rspec ) && ( cd web && npm test )
( . .venv/bin/activate && pytest -q tests/ )
```
**Expected:** all green. At risk and required to remain green: **C5 / MD-A1**
(cross-ingestor dedup — strengthened, not weakened), the #756 backfill examples
(within-window collapse, beyond-window preserve — now measured against 300 s,
idempotent, `user_version`-gated), **FC-A2** (seed-then-delta — the warm delta
contract is unchanged; only the backfill anchor moved), **PL-A1/PL-A2**
(progressive load), and **B1**. No POST/GET/event contract change and no
ingestor change, so **C2**, `CONTRACTS.md`, and the Python suite are unaffected.

---

## Bugfix: Chat-log entry retention, advert suppression, and chat vertical scroll

Three independent chat-panel defects, all frontend-only (no API/DB/ingestor
change, so the apex (I) and privacy (II) invariants are untouched):

**(A1)** `rebuildNodeDerivedState` stored the *aggregated* snapshot arrays back
into the raw accumulators (`allTelemetryEntries` / `allPositionEntries` /
`allNeighbors`), which are also the merge targets for every refresh + backfill
page. Re-aggregating an already-aggregated array is lossy (`aggregateSnapshots`
clones with `{...snapshot}`, dropping the non-enumerable `snapshots` history, and
merges oldest-last so the stalest reading's `rx_time`/`id` win), collapsing each
node's history to `{stale-first, newest}` — so a telemetry/position Log entry
appeared for one refresh tick and vanished on the next (no scrolling involved).
The accumulators now stay **raw**; the aggregated forms are locals used only to
enrich node records, so every packet keeps a stable, id-keyed Log entry.

**(A2)** The advert-suppression claim key folded in `node_num` and required BOTH
`node_id` and `node_num` to match. Specific events (telemetry/positions/
neighbors) frequently carry only `node_id` (`node_num` is int|nil per CONTRACTS,
commonly nil for MeshCore) while the node record carries a `node_num`, so the
combined key failed to match and a redundant "Updated node info (advert)" line
leaked alongside the specific entry (violating LV7/LV-A7). Suppression now keys on
the canonical `!%08x` id alone (which `normaliseNodeId` derives from `node_num`
when needed), so the id identifies a node across every event shape.

**(B)** Every chat render force-scrolled the active panel to the bottom (in
`setActiveTab`, plus a second `scrollActiveChatPanelToBottom` call), so a live
update (40-80/hr in production) yanked the reader back to the bottom and made
upward scrolling impossible. The prior LD-A2 fix preserved only the *horizontal*
tab-list scroll. `renderChatTabs` now captures the active panel's vertical
`scrollTop` before the subtree rebuild and restores it.

### CL-A1 -- telemetry/position Log entries survive successive refreshes
```bash
( cd web && node --test public/assets/js/app/__tests__/main-log-snapshot-retention.test.js )
```
**Expected:** pass. After one node emits three telemetry packets across three
refreshes, all three stay loaded (`getLoadedTelemetryCount() === 3`) and the
rendered Log shows all three "Broadcasted telemetry" entries — the raw
accumulator is no longer collapsed to a single per-node aggregate by the next
tick's re-aggregation.

### CL-A2 -- the advert is suppressed when a specific event omits `node_num`
```bash
( cd web && node --test public/assets/js/app/__tests__/chat-log-tabs.test.js )
```
**Expected:** pass. When the node record carries a `node_num` but the telemetry/
position rows carry only `node_id`, `buildChatTabModel(...).logEntries` still
emits the telemetry and position entries and **no** redundant node-info (advert)
entry. An id-less heard (no `node_id`, no derivable `node_num`) claims nothing and
is never suppressed. Realises LV-A7 ("a position/telemetry/... suppresses a
redundant advert line") across the `node_num`-nil shapes that previously slipped
through.

### CL-A3 -- a passive chat re-render preserves the reader's vertical scroll
```bash
( cd web && node --test public/assets/js/app/__tests__/chat-tabs.test.js )
```
**Expected:** pass. `renderChatTabs` captures the active panel's `scrollTop`
before the `replaceChildren` rebuild and restores it on the fresh panel: a reader
scrolled up keeps their exact offset across a passive refresh, a bottom-pinned
reader stays pinned to the new bottom (tail-follow), and an initial render (no
prior panel) pins to the bottom. The per-render force-scroll (and the redundant
`scrollActiveChatPanelToBottom`) are gone; panel scroll-to-bottom now fires only
on an explicit tab switch (click/dropdown). Composes with the LD-A2 horizontal
scroll preservation and the LV8 dropdown.

### CL-R1 -- Regression: prior acceptance still holds
```bash
( cd web && npm test ) && ( cd web && bundle exec rspec )
( . .venv/bin/activate && pytest -q tests/ )
```
**Expected:** all green. At risk and explicitly required to stay green: **LV-A7**
(node-centric Log; the advert-suppression rule is strengthened, not weakened),
**LD-A2** (horizontal tab scroll still preserved -- the new vertical-scroll
preservation composes with it), **LV-A8** (the channel dropdown still jumps tabs),
**VF-A6 / CR-A1** (an idle re-render still materialises 0 entries -- the scroll
capture touches only already-built DOM), **CB-A1** (every bulk collection still
backfills; the accumulators it merges into are raw, which is the shape the model
already expects), and **B1** (all suites). Frontend-only: no POST/GET/event
contract change, so `CONTRACTS.md` and the Python suite are unaffected.
