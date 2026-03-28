# Repository Guidelines

Keep code well structured, modular, and not monolithic. If modules get to big, consider submodules structure.

Make sure all tests pass for Python (`pytest`), Ruby (`rspec`), and JavaScript (`npm test`).

Make sure all code is properly inline documented (PDoc, RDoc, JSDoc, et.c). We do not want any undocumented code.

Make sure all code is 100% unit tested. We want all lines, units, and branches to be thouroughly covered by tests.

New source files should have Apache v2 license headers using the exact string `Copyright © 2025-26 l5yth & contributors`.

Run linters for Python (`black`) and Ruby (`rufo`) to ensure consistent code formatting.

## Project Structure & Module Organization
The repository splits runtime and ingestion logic. `web/` holds the Sinatra dashboard (Ruby code in `lib/potato_mesh`, views in `views/`, static bundles in `public/`).

`data/` hosts the Python Meshtastic ingestor plus migrations and CLI scripts. API fixtures and end-to-end harnesses live in `tests/`. Dockerfiles and compose files support containerized workflows.

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

The ingestion layer is guarded by `pytest -q tests/test_mesh.py`; leave fixtures in `tests/` untouched so CI can replay them. New features should ship with matching specs and updated integration checks.

## Commit & Pull Request Guidelines
Commits should stay imperative and reference issues the way history does (`Add chat log entries... (#408)`). Squash noisy work-in-progress commits before pushing. Pull requests need a concise summary, screenshots or curl traces for UI/API tweaks, and links to tracked issues. Paste the command output for the test suites you ran and mention configuration toggles (`API_TOKEN`, `PRIVATE`) reviewers must set.

## Security & Configuration Tips
Never commit real API tokens or `.sqlite` dumps; use `.env.local` files ignored by Git. Confirm env defaults (`API_TOKEN`, `INSTANCE_DOMAIN`, `PRIVATE`) before deploying, and set `FEDERATION=0` when staging private nodes. Review `PROMETHEUS.md` when exposing metrics so scrape endpoints stay internal.
