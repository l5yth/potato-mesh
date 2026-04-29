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
    module DataProcessing
      # Halt the current request with HTTP 403 unless the request carries a
      # bearer token that securely matches +API_TOKEN+.
      #
      # @return [void]
      def require_token!
        token = ENV["API_TOKEN"]
        provided = request.env["HTTP_AUTHORIZATION"].to_s.sub(/^Bearer\s+/i, "")
        halt 403, { error: "Forbidden" }.to_json unless token && !token.empty? && secure_token_match?(token, provided)
      end

      # Constant-time comparison of two API tokens to mitigate timing attacks.
      #
      # @param expected [String] expected token from configuration.
      # @param provided [String] token supplied by the client.
      # @return [Boolean] true when the tokens match in constant time.
      def secure_token_match?(expected, provided)
        return false unless expected.is_a?(String) && provided.is_a?(String)

        expected_bytes = expected.b
        provided_bytes = provided.b
        return false unless expected_bytes.bytesize == provided_bytes.bytesize
        Rack::Utils.secure_compare(expected_bytes, provided_bytes)
      rescue Rack::Utils::SecurityError
        false
      end

      # Read the request body up to a configured byte ceiling and halt with HTTP
      # 413 when the payload exceeds the limit.
      #
      # @param limit [Integer, nil] optional override; falls back to
      #   +PotatoMesh::Config.max_json_body_bytes+ when nil or non-positive.
      # @return [String] raw request body.
      def read_json_body(limit: nil)
        max_bytes = limit || PotatoMesh::Config.max_json_body_bytes
        max_bytes = max_bytes.to_i
        if max_bytes <= 0
          max_bytes = PotatoMesh::Config.max_json_body_bytes
        end

        body = request.body.read(max_bytes + 1)
        body = "" if body.nil?
        halt 413, { error: "payload too large" }.to_json if body.bytesize > max_bytes

        body
      ensure
        request.body.rewind if request.body.respond_to?(:rewind)
      end
    end
  end
end
