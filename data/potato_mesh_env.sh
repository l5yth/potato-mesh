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

# Shared helpers for mesh.sh and config.sh (single copy for tooling / duplication limits).

# MODE is "mesh" (profile or default only; invalid/extra args exit) or "config" (profile, explicit PATH, or default).
# Pass script arguments after REPO: potato_mesh_resolve_env_file MODE REPO "$@"
# Sets _env_file and _potato_mesh_env_shift (how many leading args to shift from the caller).
potato_mesh_resolve_env_file() {
  local _pm_mode="$1"
  local _pm_repo="$2"
  shift 2

  if [[ $# -gt 0 ]] && [[ "${1}" =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]*$ ]]; then
    _env_file="${_pm_repo}/.env-${1}"
    _potato_mesh_env_shift=1
    return 0
  fi
  if [[ "${_pm_mode}" == "config" ]] && [[ $# -gt 0 ]] && [[ "${1}" != -* ]]; then
    _env_file="${1}"
    _potato_mesh_env_shift=1
    return 0
  fi
  if [[ "${_pm_mode}" == "mesh" ]] && [[ $# -gt 0 ]]; then
    echo "mesh.sh: invalid profile name (use letters, digits, underscores, hyphens): ${1}" >&2
    echo "Usage: mesh.sh [profile]" >&2
    exit 2
  fi
  _env_file="${_pm_repo}/.env"
  _potato_mesh_env_shift=0
}

potato_mesh_source_env_if_exists() {
  local _pm_env_path="$1"
  if [[ -f "${_pm_env_path}" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "${_pm_env_path}"
    set +a
  fi
}

potato_mesh_venv_and_requirements() {
  local _pm_req="$1"
  python -m venv .venv
  # shellcheck disable=SC1091
  source .venv/bin/activate
  pip install -U pip
  pip install -r "${_pm_req}"
}
