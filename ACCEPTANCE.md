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
( cd web && API_TOKEN=acctest PRIVATE=1  FEDERATION=0 bundle exec rackup -p 41447 ) &  SRV=$!
# Auth / contract checks (Layer C): public mode, known token
( cd web && API_TOKEN=acctest PRIVATE=0  FEDERATION=0 bundle exec rackup -p 41447 ) &  SRV=$!
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
curl -s http://127.0.0.1:41447/version | grep -o '"privateMode":true'
```
**Expected:** prints `"privateMode":true`.

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
**Expected:** a JSON `config` block exposing `siteName`, `channel`, `frequency`,
`contactLink`, `mapCenter` (`lat`/`lon`), `maxDistanceKm`, `instanceDomain`, and
`privateMode`, reflecting the env vars set at boot (README "Web App" table).

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
