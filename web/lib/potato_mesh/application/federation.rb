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

require_relative "federation/lifecycle"
require_relative "federation/instance_metrics"
require_relative "federation/signature"
require_relative "federation/peers"
require_relative "federation/http_client"
require_relative "federation/http_client_get"
require_relative "federation/validation"
require_relative "federation/instance_records"
require_relative "federation/self_instance"
require_relative "federation/announce"
require_relative "federation/announcer_threads"
require_relative "federation/crawl_state"
require_relative "federation/crawl"
