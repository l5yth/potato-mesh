#!/bin/sh
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

set -e

# Default to container-aware configuration paths unless explicitly overridden.
: "${POTATOMESH_CONTAINER:=1}"
: "${POTATOMESH_SECRETS_DIR:=/run/secrets}"

export POTATOMESH_CONTAINER
export POTATOMESH_SECRETS_DIR

# Default state file path from Config.toml unless overridden.
STATE_FILE="${STATE_FILE:-/app/bridge_state.json}"
STATE_DIR="$(dirname "$STATE_FILE")"

# Ensure state directory exists and is writable by the non-root user without
# touching the read-only config bind mount.
if [ ! -d "$STATE_DIR" ]; then
  mkdir -p "$STATE_DIR"
fi

# Best-effort ownership fix; ignore if the underlying volume is read-only.
chown potatomesh:potatomesh "$STATE_DIR" 2>/dev/null || true
touch "$STATE_FILE" 2>/dev/null || true
chown potatomesh:potatomesh "$STATE_FILE" 2>/dev/null || true

exec gosu potatomesh potatomesh-matrix-bridge "$@"
