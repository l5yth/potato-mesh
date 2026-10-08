#!/usr/bin/env bash
# Copyright © 2025-26 l5yth & contributors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

set -euo pipefail

# Work in this script's directory, so .venv, .venv.lock, requirements.txt and
# mesh.py are those of data/ from ./mesh.sh in data/ or ./data/mesh.sh at the
# checkout root; CDPATH is cleared, so an exported one cannot redirect the cd.
CDPATH= cd -- "$(dirname -- "$0")"

# Let one start at a time build the venv or run pip.  Starts that share this
# .venv (one unit per protocol) otherwise run pip together, and one pip moving a
# package's files aside breaks the other.  The lock is flock(2) on fd 9, taken
# from Python because macOS has no flock(1).  The kernel ties it to fd 9's open
# file, so it ends when the holder closes fd 9 or dies, SIGKILL included.  No
# timeout: a dead holder's lock ends with it, and pip times out its own
# downloads.  The venv interpreter takes it, with -I -S so nothing from
# site-packages loads; when that cannot run (no venv yet, or a broken one that
# the next step rebuilds), the `python` that builds the venv takes it.  The lock
# file sits next to .venv, not inside it: `venv --clear` would delete it under
# the start that holds it.
exec 9>>.venv.lock
lock='import fcntl; fcntl.flock(9, fcntl.LOCK_EX)'
.venv/bin/python -I -S -c "$lock" 2>/dev/null || python -c "$lock"

# Recreate the venv only when its interpreter is missing or no longer reports a
# .venv prefix.  Avoid --clear on every run: it wipes installed packages before
# each start, so any restart during a PyPI outage turns a transient network
# failure into hard ingestor downtime.
#
# The guard probes .venv/bin/python — a relocatable symlink to the system
# interpreter that keeps working after the checkout is moved or copied.  The
# console scripts (.venv/bin/pip, ...) are NOT relocatable: their shebang bakes
# in the venv's absolute path at creation time, so a moved checkout leaves them
# pointing at a missing interpreter ("bad interpreter: No such file...").  Drive
# pip via `python -m pip` so installs survive a relocated checkout without a
# full rebuild.
if ! .venv/bin/python -c "import sys; exit(0 if '.venv' in sys.prefix else 1)" 2>/dev/null; then
    python -m venv --clear .venv
fi

# Install only when requirements.txt or the venv's interpreter changed since the
# last install that succeeded, so an unchanged restart runs no pip and contacts
# no package index.  The stamp holds the requirements.txt bytes and the
# interpreter's sys.version: after a Python upgrade the venv's site-packages for
# the new version is empty.  It lives in .venv, so a rebuilt venv installs
# again, and is written only after both installs succeed, so a failed install is
# retried on the next start.
stamp=.venv/.mesh-sh-installed
want="$(cat requirements.txt; .venv/bin/python -c 'import sys; print(sys.version)')"
if [ "$want" != "$(cat "$stamp" 2>/dev/null)" ]; then
    .venv/bin/python -m pip install -U pip
    .venv/bin/python -m pip install -r requirements.txt
    printf '%s\n' "$want" >"$stamp"
fi

# Release the lock: the ingestor runs on and must not keep the next start
# waiting.
exec 9>&-

# -u keeps stdout unbuffered
exec .venv/bin/python -u mesh.py
