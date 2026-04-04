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

# Usage: config.sh [profile | PATH] [args for mesh_env...]
# Default env file: repo-root .env. With profile: .env-<profile> (letters, digits, _, -).
# Or pass a path to any .env file as the first argument (not a bare profile token).

_script_dir="$(cd "$(dirname "$0")" && pwd)"
cd "${_script_dir}"

_repo_root="$(cd "${_script_dir}/.." && pwd)"

if [[ $# -gt 0 ]] && [[ "${1}" =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]*$ ]]; then
  _env_file="${_repo_root}/.env-${1}"
  shift
elif [[ $# -gt 0 ]] && [[ "${1}" != -* ]]; then
  _env_file="${1}"
  shift
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
pip install -r "${_script_dir}/requirements.txt"

export PYTHONPATH="${_script_dir}"
exec python -m mesh_env "${_env_file}" "$@"
