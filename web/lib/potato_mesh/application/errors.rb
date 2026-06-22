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

module PotatoMesh
  module App
    # Raised when a remote instance fails to provide valid federation data.
    class InstanceFetchError < StandardError; end

    # Raised when a federation request received an HTTP response that did not
    # indicate success (e.g. 4xx/5xx).  Distinguished from {InstanceFetchError}
    # so callers can stop probing alternative transports (HTTP after HTTPS)
    # once a remote peer has already responded at the HTTP layer.
    class InstanceHttpResponseError < InstanceFetchError; end
  end
end
