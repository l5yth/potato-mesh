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

# Recreate the venv only when its embedded Python is missing or points to the
# wrong prefix (e.g. a stale shebang from a sibling project's venv).  Avoid
# --clear on every run: it wipes installed packages before each start, so any
# restart during a PyPI outage turns a transient network failure into hard
# ingestor downtime.
if ! .venv/bin/python -c "import sys; exit(0 if '.venv' in sys.prefix else 1)" 2>/dev/null; then
    python -m venv --clear .venv
fi
.venv/bin/pip install -U pip
.venv/bin/pip install -r "$(dirname "$0")/requirements.txt"
exec .venv/bin/python mesh.py
