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
    # Rack middleware that stamps a long-lived +Cache-Control+ header on
    # version-busted static **JS/CSS** so returning/staying visitors serve them
    # from the browser cache instead of revalidating every asset on every
    # navigation.
    #
    # Only +/assets/**+ **JS/CSS** whose URL carries the +?v=<version>+ cache-buster
    # (the assets templates emit via +asset_url+, SPEC AV2/AV4) are stamped;
    # unversioned assets and non-JS/CSS types (images, favicons, SVG icons — AV4)
    # are left untouched so they keep +Last-Modified+/+ETag+ revalidation.
    #
    # The header is +immutable+ (a year, never revalidated) **only for a pinned
    # build** — one whose version is unique per build: baked into the image via
    # +ENV["APP_VERSION"]+ or git-derived (+APP_VERSION_PINNED+). When the app runs
    # on the constant fallback version (e.g. a Docker image built without +.git+
    # and no baked version), the +?v=+ buster does not change between commits, so a
    # year-long +immutable+ pin could serve stale JS unrecoverably; those
    # deployments instead get a short, **revalidatable** +max-age+ that still
    # spares the per-navigation 304 waterfall while bounding staleness. The mode is
    # chosen at boot via the +immutable:+ flag.
    #
    # Complementary to serving +/assets/+ immutable from nginx off disk (those
    # requests never reach Ruby); an existing +Cache-Control+ is never overwritten.
    class AssetCacheControl
      # One year in seconds — the immutable cache lifetime for a pinned build's
      # uniquely-versioned (baked-ENV or git-derived) assets.
      IMMUTABLE_MAX_AGE_SECONDS = 31_536_000

      # Bounded lifetime (seconds) used when the version buster is not unique per
      # build, so a stale asset self-heals within the window instead of being
      # pinned for a year.
      REVALIDATABLE_MAX_AGE_SECONDS = 300

      # Header for uniquely-versioned (git-derived) deployments.
      IMMUTABLE_CACHE_CONTROL = "public, max-age=#{IMMUTABLE_MAX_AGE_SECONDS}, immutable"

      # Header for constant-fallback-version deployments (bounded, revalidatable).
      REVALIDATABLE_CACHE_CONTROL = "public, max-age=#{REVALIDATABLE_MAX_AGE_SECONDS}"

      # Extensions eligible for long caching — JS + CSS only (SPEC AV4).
      CACHEABLE_EXTENSIONS = %w[.js .mjs .css].freeze

      # Unversioned site icons served from the app root (favicon + logo). They
      # bypass the +/assets/**+ pipeline entirely — Sinatra's static-file handler
      # serves them straight off +public/+ (and the fallback routes use
      # +send_file+), neither of which sets a +Cache-Control+, so the browser
      # revalidates them on every page load. They carry no +?v=+ buster, so a
      # bounded lifetime (not +immutable+) is used: a changed icon self-heals
      # within the window rather than being pinned.
      ICON_PATHS = %w[/potatomesh-logo.svg /favicon.ico /favicon.png].freeze

      # Bounded lifetime (seconds) for the unversioned site icons — one day, long
      # enough to spare the per-navigation revalidation, short enough that a
      # cosmetic icon change recovers on its own.
      ICON_MAX_AGE_SECONDS = 86_400

      # Header for the unversioned site icons (bounded/revalidatable).
      ICON_CACHE_CONTROL = "public, max-age=#{ICON_MAX_AGE_SECONDS}"

      # @param app [#call] the downstream Rack application.
      # @param immutable [Boolean] when true the running version is unique per
      #   build (git-derived), so versioned assets may be pinned +immutable+; when
      #   false a bounded, revalidatable lifetime is used instead.
      def initialize(app, immutable: true)
        @app = app
        @cache_control = immutable ? IMMUTABLE_CACHE_CONTROL : REVALIDATABLE_CACHE_CONTROL
      end

      # Rack entry point: delegate downstream, then stamp a +Cache-Control+ when
      # the request is a cacheable target (a versioned +/assets/**+ JS/CSS file, or
      # an unversioned site icon) whose successful response does not already carry
      # one.
      #
      # @param env [Hash] the Rack environment.
      # @return [Array(Integer, Hash, #each)] the (possibly header-augmented) Rack
      #   response triple.
      def call(env)
        status, headers, body = @app.call(env)
        cache_control = cache_control_for(env)
        if cache_control && cacheable_status?(status) && cache_control_absent?(headers)
          headers["cache-control"] = cache_control
        end
        [status, headers, body]
      end

      private

      # The +Cache-Control+ value this request's target should carry, or +nil+
      # when it is neither a versioned asset nor a site icon. Resolved from the
      # cheap request/path checks first so the header scan in {call} runs only when
      # a value would actually apply.
      #
      # @param env [Hash] the Rack environment.
      # @return [String, nil]
      def cache_control_for(env)
        return @cache_control if versioned_asset_request?(env)
        return ICON_CACHE_CONTROL if icon_request?(env)

        nil
      end

      # True when the request is a readable (+GET+/+HEAD+) hit for a versioned
      # (+?v=+) +/assets/**+ **JS or CSS** file. Non-JS/CSS types (images,
      # favicons, SVG) are excluded so they keep revalidation (SPEC AV4), even if
      # a caller appends a +?v=+.
      #
      # @param env [Hash] the Rack environment.
      # @return [Boolean]
      def versioned_asset_request?(env)
        return false unless %w[GET HEAD].include?(env["REQUEST_METHOD"])

        path = env["PATH_INFO"].to_s
        return false unless path.start_with?("/assets/")
        return false unless CACHEABLE_EXTENSIONS.include?(File.extname(path).downcase)

        version = Rack::Utils.parse_query(env["QUERY_STRING"].to_s)["v"]
        version.is_a?(String) && !version.empty?
      end

      # True when the request is a readable (+GET+/+HEAD+) hit for one of the
      # unversioned site icons ({ICON_PATHS}). These are served outside the
      # +/assets/**+ pipeline, so nothing else stamps a +Cache-Control+.
      #
      # @param env [Hash] the Rack environment.
      # @return [Boolean]
      def icon_request?(env)
        return false unless %w[GET HEAD].include?(env["REQUEST_METHOD"])

        ICON_PATHS.include?(env["PATH_INFO"].to_s)
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
