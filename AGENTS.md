# Repository Guidelines

Keep code well structured, modular, and not monolithic; if modules grow too large, split them into submodules.

Make sure all tests pass for Python (`pytest`), Ruby (`rspec`), and JavaScript (`npm test`).

Make sure all code is properly inline documented (PDoc, RDoc, JSDoc, et.c). We do not want any undocumented code.

Make sure all code is 100% unit tested. We want every line, unit, and branch thoroughly covered—treat this as a hard gate, and add matching test lines for every new line of code you author.

New source files should have Apache v2 license headers using the exact string `Copyright © 2025-26 l5yth & contributors`.

Run linters for Python (`black`) and Ruby (`rufo`) to ensure consistent code formatting; default commands are `black .` and `rufo .`.

## Project Structure & Module Organization
The repository splits runtime and ingestion logic. `web/` holds the Sinatra dashboard (Ruby code in `lib/potato_mesh`, views in `views/`, static bundles in `public/`).

`data/` hosts the Python Meshtastic ingestor plus migrations and CLI scripts. API fixtures and end-to-end harnesses live in `tests/`. Dockerfiles and compose files support containerized workflows.

## Build, Test, and Development Commands
Run dependency installs inside `web/`: `bundle install` for gems and `npm ci` for JavaScript tooling. Start the app with `cd web && API_TOKEN=dev ./app.sh` for local work or `bundle exec rackup -p 41447` when integrating elsewhere.

Prep ingestion with `python -m venv .venv && pip install -r data/requirements.txt`; `./data/mesh.sh` streams from live radios. `docker-compose -f docker-compose.dev.yml up` brings up the full stack.

## Coding Style & Naming Conventions
Use two-space indentation for Ruby and keep `# frozen_string_literal: true` at the top of new files. Keep Ruby classes/modules in `CamelCase`, filenames in `snake_case.rb`, and feature specs in `*_spec.rb`.

JavaScript follows ES modules under `public/assets/js`; co-locate components with `__tests__` folders and use kebab-case filenames. Format Ruby via `bundle exec rufo .` and Python via `black`. Skip committing generated coverage artifacts.

## Testing Guidelines
Ruby specs run with `cd web && bundle exec rspec`, producing SimpleCov output in `coverage/`. Front-end behaviour is verified through Node’s test runner: `cd web && npm test` writes V8 coverage and JUnit XML under `reports/`.

The ingestion layer is guarded by `pytest -q tests/test_mesh.py`; leave fixtures in `tests/` untouched so CI can replay them. New features should ship with matching specs and updated integration checks.

## Commit & Pull Request Guidelines
Commits should stay imperative and reference issues the way history does (`Add chat log entries... (#408)`). Squash noisy work-in-progress commits before pushing. Pull requests need a concise summary, screenshots or curl traces for UI/API tweaks, and links to tracked issues. Paste the command output for the test suites you ran and mention configuration toggles (`API_TOKEN`, `PRIVATE`) reviewers must set.

## Security & Configuration Tips
Never commit real API tokens or `.sqlite` dumps; use `.env.local` files ignored by Git. Confirm env defaults (`API_TOKEN`, `INSTANCE_DOMAIN`, `PRIVATE`) before deploying, and set `FEDERATION=0` when staging private nodes. Review `PROMETHEUS.md` when exposing metrics so scrape endpoints stay internal.
