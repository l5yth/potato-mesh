# Repository Guidelines

Keep code as modular as possible to reduce duplication and improve reusability and readability. If a module grows large, split it into a submodule structure. Prefer composing small, single-purpose units over monolithic files.

Make sure all tests pass for Python (`pytest`), Ruby (`rspec`), and JavaScript (`npm test`).

All code must be 100% unit tested — every line, branch, and code path must have a unit test. "100%" is the floor, not the ceiling: smoke tests, integration tests, and end-to-end tests come on top of that. No new code ships without matching unit tests.

All code must be 100% documented according to the language's API-doc standard (PDoc for Python, RDoc for Ruby, JSDoc for JavaScript, rustdoc for Rust, dartdoc for Dart). Documentation must be sufficient to generate complete API docs from source. In addition to API-level docs, add inline comments wherever the logic is not immediately self-evident.

New source files should have Apache v2 license headers using the exact string `Copyright © 2025-26 l5yth & contributors`.

Run linters for Python (`black`) and Ruby (`rufo`) to ensure consistent code formatting.

## Project Structure & Module Organization
The repository splits runtime and ingestion logic. `web/` holds the Sinatra dashboard (Ruby code in `lib/potato_mesh`, views in `views/`, static bundles in `public/`).

`data/` hosts the Python Meshtastic ingestor plus migrations and CLI scripts. The ingestor is structured as the `data/mesh_ingestor/` package with the following key modules: `daemon.py` (main loop), `handlers.py` (packet processing), `interfaces.py` (interface helpers), `config.py` (env-driven config), `events.py` (TypedDict event schemas), `provider.py` (Provider protocol), `node_identity.py` (canonical node ID utilities), `decode_payload.py` (CLI protobuf decoder), and the `providers/` subpackage (currently `meshtastic.py`). API contracts for all POST ingest routes are documented in `data/mesh_ingestor/CONTRACTS.md`. API fixtures and end-to-end harnesses live in `tests/`. Dockerfiles and compose files support containerized workflows.

`matrix/` contains the Rust Matrix bridge; build with `cargo build --release` or `docker build -f matrix/Dockerfile .`, and keep bridge config under `matrix/Config.toml` when running locally.

## Build, Test, and Development Commands
Run dependency installs inside `web/`: `bundle install` for gems and `npm ci` for JavaScript tooling. Start the app with `cd web && API_TOKEN=dev ./app.sh` for local work or `bundle exec rackup -p 41447` when integrating elsewhere.

Prep ingestion with `python -m venv .venv && pip install -r data/requirements.txt`; `./data/mesh.sh` streams from live radios. `docker-compose -f docker-compose.dev.yml up` brings up the full stack.

Container images publish via `.github/workflows/docker.yml` as `potato-mesh-{service}-linux-$arch` (`web`, `ingestor`, `matrix-bridge`), using the Dockerfiles in `web/`, `data/`, and `matrix/`.

## Coding Style & Naming Conventions
Use two-space indentation for Ruby and keep `# frozen_string_literal: true` at the top of new files. Keep Ruby classes/modules in `CamelCase`, filenames in `snake_case.rb`, and feature specs in `*_spec.rb`.

JavaScript follows ES modules under `public/assets/js`; co-locate components with `__tests__` folders and use kebab-case filenames. Format Ruby via `bundle exec rufo .` and Python via `black`. Skip committing generated coverage artifacts.

## Flutter Mobile App (`app/`)
The Flutter client lives in `app/`. Keep only the mobile targets (`android/`, `ios/`) under version control unless you explicitly support other platforms. Do not commit Flutter build outputs or editor cruft (`.dart_tool/`, `.flutter-plugins-dependencies`, `.idea/`, `.metadata`, `*.iml`, `.fvmrc` if unused).

Install dependencies with `cd app && flutter pub get`; format with `dart format .` and lint via `flutter analyze`. Run tests with `cd app && flutter test` and keep widget/unit coverage high—no new code without tests. Commit `pubspec.lock` and analysis options so toolchains stay consistent.

## Testing Guidelines
Ruby specs run with `cd web && bundle exec rspec`, producing SimpleCov output in `coverage/`. Front-end behaviour is verified through Node’s test runner: `cd web && npm test` writes V8 coverage and JUnit XML under `reports/`.

The ingestion layer is tested with `pytest -q tests/`; leave fixtures in `tests/` untouched so CI can replay them. The suite includes both integration tests (`test_mesh.py`) and focused unit tests — `test_events_unit.py` (TypedDict schemas), `test_provider_unit.py` (Provider protocol conformance and `MeshtasticProvider`), `test_node_identity_unit.py` (canonical ID helpers), `test_daemon_unit.py`, `test_serialization_unit.py`, and `test_decode_payload.py`. New features should ship with matching specs and updated integration checks.

## Adding a New Ingestor Provider
The `data/mesh_ingestor/provider.py` module defines a `@runtime_checkable` `Provider` Protocol with five members: `name` (str), `subscribe()`, `connect(*, active_candidate)`, `extract_host_node_id(iface)`, and `node_snapshot_items(iface)`. To add a new backend (e.g. Reticulum, MeshCore):

1. Create `data/mesh_ingestor/providers/<name>.py` with a class satisfying the Protocol.
2. Register it in `data/mesh_ingestor/providers/__init__.py`.
3. Pass an instance via `daemon.main(provider=...)` or make it the default in `main()`.
4. Cover the provider with unit tests in `tests/test_provider_unit.py` — at minimum an `isinstance(..., Provider)` conformance check and any retry/error-handling paths.

Consult `data/mesh_ingestor/CONTRACTS.md` for the canonical event shapes all providers must emit.

## GitHub Configuration Standards
Every language used in the repository must have a Dependabot entry checking for dependency updates on a **weekly** schedule. Keep the Dependabot config up to date as new languages or package ecosystems are added.

Codecov must be configured with a **100% coverage target** and a **10% threshold** (i.e. a drop of more than 10 percentage points fails the check). The `codecov.yml` should enforce this on both patch and project coverage.

Every service/component must have at least one GitHub Actions workflow that **builds and runs tests on pull requests against `main` and on direct pushes to `main`**. Workflows should cover all relevant test suites (Python, Ruby, JS, Rust, Flutter) for the components they touch.

## Commit & Pull Request Guidelines
Commits should stay imperative and reference issues the way history does (`Add chat log entries... (#408)`). Squash noisy work-in-progress commits before pushing. Pull requests need a concise summary, screenshots or curl traces for UI/API tweaks, and links to tracked issues. Paste the command output for the test suites you ran and mention configuration toggles (`API_TOKEN`, `PRIVATE`) reviewers must set.

## Security & Configuration Tips
Never commit real API tokens or `.sqlite` dumps; use `.env.local` files ignored by Git. Confirm env defaults (`API_TOKEN`, `INSTANCE_DOMAIN`, `PRIVATE`) before deploying, and set `FEDERATION=0` when staging private nodes. Review `PROMETHEUS.md` when exposing metrics so scrape endpoints stay internal.
