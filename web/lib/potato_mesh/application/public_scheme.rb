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
    # The scheme of the public URLs the app prints: the canonical link,
    # +og:image+, +robots.txt+, +sitemap.xml+ and the URL the OG capture opens
    # (SPEC HD4).
    #
    # A scheme +INSTANCE_DOMAIN+ names wins ({.from_instance_domain}, resolved
    # once at boot). Without one, {.from_request} reads the forwarded headers
    # in the order Rack ranks them but accepts only +http+ and +https+, where
    # Rack also accepts +ws+ and +wss+: a client could otherwise put a
    # WebSocket scheme into cached URLs with a +Forwarded+ header that a proxy
    # passes through, and make the capture fail.
    module PublicScheme
      module_function

      # The schemes a public URL may carry.
      WEB_SCHEMES = %w[https http].freeze

      # Rack env keys of the +X-Forwarded-Proto+ and +X-Forwarded-Scheme+
      # headers, keyed as +Rack::Request.x_forwarded_proto_priority+ names them.
      X_FORWARDED_SCHEME_HEADERS = {
        proto: "HTTP_X_FORWARDED_PROTO",
        scheme: "HTTP_X_FORWARDED_SCHEME",
      }.freeze

      # The scheme a configured +INSTANCE_DOMAIN+ URL names.
      #
      # @param raw [String, nil] the raw +INSTANCE_DOMAIN+ value.
      # @return [String, nil] +"http"+ or +"https"+ when +raw+ starts with
      #   that scheme (in any case), +nil+ for a bare host, another scheme or
      #   no value.
      def from_instance_domain(raw)
        scheme = raw.to_s.strip[%r{\A([a-z][a-z0-9+.-]*)://}i, 1]&.downcase
        web_scheme(scheme)
      end

      # The scheme of the request in +env+, as Rack ranks its sources, with
      # only +http+ and +https+ accepted from the forwarded headers: +https+
      # for +HTTPS=on+ or +X-Forwarded-Ssl: on+, else the first web scheme
      # the +Forwarded+ and +X-Forwarded-*+ headers give in
      # +Rack::Request.forwarded_priority+ order, else the request's own.
      #
      # @param env [Hash] the Rack environment.
      # @return [String] +"http"+ or +"https"+.
      def from_request(env)
        return "https" if env["HTTPS"] == "on" || env["HTTP_X_FORWARDED_SSL"] == "on"

        forwarded_scheme(env) || web_scheme(env[Rack::RACK_URL_SCHEME]) || "https"
      end

      # The first web scheme the forwarded headers give, by Rack's priority.
      #
      # @param env [Hash] the Rack environment.
      # @return [String, nil] +"http"+, +"https"+ or +nil+.
      def forwarded_scheme(env)
        Rack::Request.forwarded_priority.each do |type|
          scheme = case type
            when :forwarded then forwarded_header_scheme(env)
            when :x_forwarded then x_forwarded_scheme(env)
            end
          return scheme if scheme
        end
        nil
      end

      # The scheme of the RFC 7239 +Forwarded+ header: its last +proto+, as
      # Rack reads it, when that is a web scheme.
      #
      # @param env [Hash] the Rack environment.
      # @return [String, nil] +"http"+, +"https"+ or +nil+.
      def forwarded_header_scheme(env)
        protos = Rack::Utils.forwarded_values(env["HTTP_FORWARDED"])&.fetch(:proto, nil)
        web_scheme(protos&.last)
      end

      # The scheme of the +X-Forwarded-Proto+ and +X-Forwarded-Scheme+
      # headers, in +Rack::Request.x_forwarded_proto_priority+ order: the
      # last web scheme each lists, as Rack walks them.
      #
      # @param env [Hash] the Rack environment.
      # @return [String, nil] +"http"+, +"https"+ or +nil+.
      def x_forwarded_scheme(env)
        Rack::Request.x_forwarded_proto_priority.each do |key|
          header = X_FORWARDED_SCHEME_HEADERS[key]
          next unless header

          env[header].to_s.strip.split(/[, \t]+/).reverse_each do |value|
            scheme = web_scheme(value)
            return scheme if scheme
          end
        end
        nil
      end

      # @param value [String, nil] a candidate scheme, compared exactly as
      #   Rack compares it.
      # @return [String, nil] +value+ when it is +http+ or +https+.
      def web_scheme(value)
        WEB_SCHEMES.include?(value) ? value : nil
      end
    end
  end
end
