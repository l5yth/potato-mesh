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

require "rack"

module PotatoMesh
  module App
    # Rack middleware that stamps a long-lived, immutable +Cache-Control+ header on
    # version-busted static assets so returning/staying visitors serve them from
    # the browser cache instead of revalidating every asset on every navigation.
    #
    # Only assets whose URL carries the +?v=<release>+ cache-buster (the JS and
    # CSS the templates emit via +asset_url+, SPEC AV2/AV4) are marked immutable —
    # their URL changes on every release, so a year-long cache can never serve a
    # stale build. **Unversioned** assets (images, favicons, SVG icons — AV4) are
    # left untouched so they keep their +Last-Modified+/+ETag+ revalidation; a
    # stale logo is cosmetic, not behavioral.
    #
    # This is the app-side counterpart to serving +/assets/+ from nginx with an
    # immutable header; when nginx serves them from disk it sets the header first
    # and these requests never reach Ruby, so the two are complementary, not
    # conflicting (an existing +Cache-Control+ is never overwritten).
    class AssetCacheControl
      # One year in seconds — the immutable cache lifetime for versioned assets.
      IMMUTABLE_MAX_AGE_SECONDS = 31_536_000

      # The header value applied to versioned assets.
      IMMUTABLE_CACHE_CONTROL = "public, max-age=#{IMMUTABLE_MAX_AGE_SECONDS}, immutable"

      # @param app [#call] the downstream Rack application.
      def initialize(app)
        @app = app
      end

      # Rack entry point: delegate downstream, then add the immutable header when
      # the request is a versioned static asset that does not already carry a
      # +Cache-Control+.
      #
      # @param env [Hash] the Rack environment.
      # @return [Array(Integer, Hash, #each)] the (possibly header-augmented) Rack
      #   response triple.
      def call(env)
        status, headers, body = @app.call(env)
        if versioned_asset_request?(env) && cacheable_status?(status) && cache_control_absent?(headers)
          headers["cache-control"] = IMMUTABLE_CACHE_CONTROL
        end
        [status, headers, body]
      end

      private

      # True when the request is a readable (+GET+/+HEAD+) hit for a +/assets/+
      # path carrying a non-empty +?v=+ cache-buster.
      #
      # @param env [Hash] the Rack environment.
      # @return [Boolean]
      def versioned_asset_request?(env)
        return false unless %w[GET HEAD].include?(env["REQUEST_METHOD"])
        return false unless env["PATH_INFO"].to_s.start_with?("/assets/")

        version = Rack::Utils.parse_query(env["QUERY_STRING"].to_s)["v"]
        version.is_a?(String) && !version.empty?
      end

      # Only successful asset responses are cached immutably; an error/redirect
      # keeps default handling.
      #
      # @param status [Integer]
      # @return [Boolean]
      def cacheable_status?(status)
        status.to_i == 200
      end

      # True when the response has no +Cache-Control+ yet (case-insensitive), so
      # an upstream/nginx-set value is never overwritten.
      #
      # @param headers [Hash]
      # @return [Boolean]
      def cache_control_absent?(headers)
        headers.none? { |key, _| key.to_s.casecmp("cache-control").zero? }
      end
    end
  end
end
