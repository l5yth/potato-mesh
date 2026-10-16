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

require "json"
require "mustermann"
require "rack"

module PotatoMesh
  module App
    # Rack middleware that answers 415 to an ingest POST whose body is not
    # declared as JSON, and to any request whose body Rack would parse as a
    # form (SPEC IH1-IH4).
    #
    # Sinatra parses a form, multipart or untyped POST body into +params+
    # before any route or filter runs.  Such a body reached an ingest route
    # already consumed, so +read_json_body+ saw nothing and answered "invalid
    # JSON", and on any path a multipart file part was written to TMPDIR before
    # any token check.  The app takes no form anywhere.  This middleware sits
    # inside the logger, the security headers and the route collector, ahead
    # of the Prometheus exporter and Sinatra, and answers before the body is
    # parsed, so a refused body is never parsed, whoever sends it.
    class IngestContentType
      # Every POST route the application registers (+routes/ingest.rb+); the
      # app has no PUT, PATCH or DELETE route and no HTML form (SPEC IH3).
      ROUTES = %w[
        /api/nodes
        /api/messages
        /api/positions
        /api/neighbors
        /api/telemetry
        /api/waypoints
        /api/traces
        /api/ingestors
        /api/instances
      ].freeze

      # The one media type an ingest body may declare.  +Rack::MediaType+
      # drops parameters such as +charset+ and folds letter case.
      JSON_MEDIA_TYPE = "application/json"

      # Body of the 415 answer.
      REFUSAL_BODY = JSON.generate(error: "Content-Type must be application/json").freeze

      # @param app [#call] the next Rack application.
      def initialize(app)
        @app = app
        # Compiled as Sinatra compiles a route, so every spelling the routing
        # accepts (+/api/%6Eodes+) is guarded too.
        @patterns = ROUTES.map { |path| Mustermann.new(path) }
      end

      # Answer 415 to a POST on an ingest route that does not declare
      # +application/json+, and to a form body on any path by any method;
      # pass every other request on.
      #
      # @param env [Hash] Rack environment.
      # @return [Array(Integer, Hash, Array<String>)] Rack response.
      def call(env)
        return @app.call(env) unless ingest_post_without_json?(env) || form_body?(env)

        [415, { "content-type" => "application/json" }, [REFUSAL_BODY]]
      end

      private

      # Whether +env+ is a POST to an ingest route, a trailing or doubled
      # slash included, whose media type is not +application/json+ (SPEC IH1,
      # IH3).  A POST without a Content-Type counts.
      #
      # @param env [Hash] Rack environment.
      # @return [Boolean] true when the request is refused.
      def ingest_post_without_json?(env)
        return false unless env["REQUEST_METHOD"] == "POST"
        return false if Rack::MediaType.type(env["CONTENT_TYPE"]) == JSON_MEDIA_TYPE

        path = normalized_path(env["PATH_INFO"].to_s)
        @patterns.any? { |pattern| pattern.match(path) }
      end

      # Whether +env+ carries a body Rack would parse as a form, on any path
      # and by any method: a form or multipart type (every +multipart/*+), or
      # a POST without a Content-Type (SPEC IH4).  A request without a body has
      # nothing to parse.
      #
      # @param env [Hash] Rack environment.
      # @return [Boolean] true when the request is refused.
      def form_body?(env)
        return false unless body?(env)

        request = Rack::Request.new(env)
        request.form_data? || request.parseable_data? || request.media_type.to_s.start_with?("multipart/")
      end

      # Whether the request has a body.  Puma sets +CONTENT_LENGTH+ for a
      # chunked body as well, once it has read it.
      #
      # @param env [Hash] Rack environment.
      # @return [Boolean] true for a non-empty or chunked body.
      def body?(env)
        env["CONTENT_LENGTH"].to_i.positive? || env.key?("HTTP_TRANSFER_ENCODING")
      end

      # +path+ with runs of slashes collapsed and a trailing slash dropped, so
      # +/api/nodes/+ and +//api//nodes+ match +/api/nodes+.
      #
      # @param path [String] the request's +PATH_INFO+.
      # @return [String] the normalized path.
      def normalized_path(path)
        squeezed = path.squeeze("/")
        squeezed.length > 1 ? squeezed.chomp("/") : squeezed
      end
    end
  end
end
