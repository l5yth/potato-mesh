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

# Usage: mesh.sh [profile]
# Loads repo-root .env, or .env-<profile> when profile is given (letters, digits, _, -).

_script_dir="$(cd "$(dirname "$0")" && pwd)"
_repo_root="$(cd "${_script_dir}/.." && pwd)"

if [[ $# -gt 0 ]]; then
  if [[ "${1}" =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]*$ ]]; then
    _profile="${1}"
    shift
    _env_file="${_repo_root}/.env-${_profile}"
  else
    echo "mesh.sh: invalid profile name (use letters, digits, underscores, hyphens): ${1}" >&2
    echo "Usage: mesh.sh [profile]" >&2
    exit 2
  fi
else
  _env_file="${_repo_root}/.env"
fi

if [[ -f "${_env_file}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${_env_file}"
  set +a
fi

python -m venv .venv
source .venv/bin/activate
pip install -U pip
pip install -r "$(dirname "$0")/requirements.txt"
exec python mesh.py
