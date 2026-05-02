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

# frozen_string_literal: true

# The submodules below all reopen +PotatoMesh::App::DataProcessing+ to
# contribute methods.  They are required in dependency order rather than
# alphabetically: +coercions+ and +identity+ define the canonical-id helpers
# that every higher-level submodule (messages, neighbors, telemetry, etc.)
# calls into, so they must load first.  Reordering the requires
# alphabetically would still load — Ruby resolves module method lookups at
# call time — but the explicit dependency order documents what each layer
# depends on without grepping.
require_relative "data_processing/coercions"
require_relative "data_processing/identity"
require_relative "data_processing/request_helpers"
require_relative "data_processing/protocol_resolution"
require_relative "data_processing/ingestors"
require_relative "data_processing/node_writes"
require_relative "data_processing/positions"
require_relative "data_processing/neighbors"
require_relative "data_processing/traces"
require_relative "data_processing/telemetry"
require_relative "data_processing/decrypted_payloads"
require_relative "data_processing/messages"
