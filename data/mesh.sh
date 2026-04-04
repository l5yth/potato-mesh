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
# shellcheck source=potato_mesh_env.sh
source "${_script_dir}/potato_mesh_env.sh"

potato_mesh_resolve_env_file mesh "${_repo_root}" "$@"
shift "${_potato_mesh_env_shift}"
if [[ $# -gt 0 ]]; then
  echo "mesh.sh: unexpected arguments (only optional profile name is supported): $*" >&2
  exit 2
fi

potato_mesh_source_env_if_exists "${_env_file}"
potato_mesh_venv_and_requirements "${_script_dir}/requirements.txt"
exec python mesh.py
