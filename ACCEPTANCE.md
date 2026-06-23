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
this is the intended, versioned break. `version_fallback` returns `"0.7.0"`, and
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
