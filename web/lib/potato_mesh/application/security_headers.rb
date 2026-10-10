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

require "digest"

require_relative "leaflet_assets"

module PotatoMesh
  module App
    # Rack middleware that sends the +Content-Security-Policy+ on HTML
    # responses and the +Referrer-Policy+ on every response (SPEC HD1, HD2).
    #
    # The policy is one string, built at boot by {.content_security_policy}.
    # Scripts load from this origin and from the Leaflet release the layout
    # loads ({LeafletAssets.sources}, the package path on unpkg.com, never the
    # whole host), plus the inline scripts whose text the boot hashed: the
    # layout's import map, the pages' one inline script (SPEC HD3, AV3).
    # Stylesheets come from the same two places. Style attributes stay allowed,
    # because the frontend writes +style=+ attributes; inline style elements do
    # not. Images may come from this origin, +data:+ URIs and any https host,
    # which covers the basemap tiles and the images of custom pages. Fetches,
    # the live-update stream and fonts stay on this origin; plugins, a foreign
    # +<base>+, foreign form targets and foreign framing are refused.
    #
    # Only +text/html+ carries the policy: another document type, such as an
    # SVG opened directly or a browser's JSON viewer, would apply it to its
    # own rendering. The Referrer-Policy is harmless on any response. A header
    # a layer further in already set is never overwritten.
    class SecurityHeaders
      # The +Referrer-Policy+: the full URL to this origin, the origin alone to
      # another origin, nothing when a link leaves https for http.
      REFERRER_POLICY = "strict-origin-when-cross-origin"

      # The Leaflet release the layout loads, as CSP sources, derived from its
      # pinned asset URLs (SPEC HD1).
      LEAFLET_SOURCES = LeafletAssets.sources.join(" ").freeze

      # Sources of +script-src+ before the inline-script hashes.
      SCRIPT_ORIGINS = ["'self'", LEAFLET_SOURCES].freeze

      # The directives after +script-src+, in policy order (SPEC HD1).
      DIRECTIVES_AFTER_SCRIPTS = [
        "style-src 'self' #{LEAFLET_SOURCES} 'unsafe-inline'",
        "style-src-elem 'self' #{LEAFLET_SOURCES}",
        "style-src-attr 'unsafe-inline'",
        "img-src 'self' data: https:",
        "connect-src 'self'",
        "font-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'self'",
      ].freeze

      # Build the policy that allows each of +inline_scripts+ by its SHA-256.
      #
      # @param inline_scripts [Array<String>] the exact text of every inline
      #   script the pages serve; a repeated text is listed once.
      # @return [String] the +Content-Security-Policy+ header value.
      def self.content_security_policy(inline_scripts)
        hashes = inline_scripts.map { |body| script_hash_source(body) }.uniq
        script_src = (["script-src"] + SCRIPT_ORIGINS + hashes).join(" ")
        (["default-src 'self'", script_src] + DIRECTIVES_AFTER_SCRIPTS).join("; ")
      end

      # The hash source of one inline script, as a browser computes it: the
      # base64 SHA-256 of the element's text, byte for byte.
      #
      # @param body [String] the script element's text.
      # @return [String] the quoted +'sha256-<base64>'+ source.
      def self.script_hash_source(body)
        "'sha256-#{Digest::SHA256.base64digest(body.to_s)}'"
      end

      # @param app [#call] the downstream Rack application.
      # @param content_security_policy [String] the header value HTML
      #   responses carry, built once at boot by {.content_security_policy}.
      def initialize(app, content_security_policy:)
        @app = app
        @content_security_policy = content_security_policy
      end

      # Rack entry point: delegate downstream, then add the Referrer-Policy and,
      # to an HTML response, the Content-Security-Policy, each unless present.
      #
      # @param env [Hash] the Rack environment.
      # @return [Array(Integer, Hash, #each)] the Rack response triple.
      def call(env)
        status, headers, body = @app.call(env)
        add_absent(headers, "referrer-policy", REFERRER_POLICY)
        add_absent(headers, "content-security-policy", @content_security_policy) if html?(headers)
        [status, headers, body]
      end

      private

      # True when the response's media type is +text/html+, whatever the
      # parameters and the case of the header name and value.
      #
      # @param headers [Hash] the response headers.
      # @return [Boolean]
      def html?(headers)
        type = headers.find { |key, _| key.to_s.casecmp?("content-type") }&.last
        type.to_s.split(";").first.to_s.strip.casecmp?("text/html")
      end

      # Set +name+ to +value+ unless the response already has that header in
      # any case.
      #
      # @param headers [Hash] the response headers, changed in place.
      # @param name [String] the lower-case header name.
      # @param value [String] the header value.
      # @return [void]
      def add_absent(headers, name, value)
        return if headers.any? { |key, _| key.to_s.casecmp?(name) }

        headers[name] = value
      end
    end
  end
end
