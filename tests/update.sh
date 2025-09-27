#!/usr/bin/env bash

# Copyright (C) 2025 l5yth
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

sqlite3 ../data/mesh.db ".backup './mesh.db'"
curl http://127.0.0.1:41447/api/nodes |jq > ./nodes.json
curl http://127.0.0.1:41447/api/positions |jq > ./positions.json
curl http://127.0.0.1:41447/api/messages |jq > ./messages.json
