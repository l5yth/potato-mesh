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
    # Canonical window/bucket pairs of the two bucketed read endpoints,
    # +GET /api/telemetry/aggregated+ and +GET /api/stats/activity+
    # (SPEC RC1).
    #
    # Each endpoint serves only its pairs below: the route default and the
    # pairs the frontend charts request.  A request for any other pair is
    # served the nearest pair ({.nearest_pair}), so the response cache holds
    # at most two series per endpoint (and private flag) however many
    # distinct windows clients send.  A +since+ is rounded down to the start
    # of its bucket ({.bucket_floor}) and answered from the same cached
    # series ({.series_since}): a bucket that starts at or after it holds the
    # same rows in the full series as in a query bounded by it.
    module AggregateWindows
      # Pairs of +/api/telemetry/aggregated+ as +[window, bucket]+ seconds:
      # the route default, one day in 5-minute buckets, and the /charts
      # telemetry figures, seven days in 1-hour buckets (+charts-page.js+).
      TELEMETRY_PAIRS = [
        [Queries::DEFAULT_TELEMETRY_WINDOW_SECONDS, Queries::DEFAULT_TELEMETRY_BUCKET_SECONDS].freeze,
        [604_800, 3_600].freeze,
      ].freeze

      # Pairs of +/api/stats/activity+: the route default and map-card
      # sparkline, one day in 1-hour buckets (+stats.js+), and the /charts
      # activity figure, seven days in 2-hour buckets
      # (+mesh-activity-chart.js+).
      ACTIVITY_PAIRS = [
        [Queries::DEFAULT_ACTIVITY_WINDOW_SECONDS, Queries::DEFAULT_ACTIVITY_BUCKET_SECONDS].freeze,
        [604_800, 7_200].freeze,
      ].freeze

      module_function

      # The canonical pair nearest a requested window and bucket: the pair
      # whose window is closest to +window_seconds+, then, among pairs equally
      # close, the one whose bucket is closest to +bucket_seconds+; a pair
      # still tied goes to the one listed first, the shorter window.
      #
      # @param pairs [Array<Array(Integer, Integer)>] canonical
      #   +[window, bucket]+ pairs, shortest window first.
      # @param window_seconds [Integer] requested window, already clamped to
      #   the 28-day visibility floor.
      # @param bucket_seconds [Integer] requested bucket width.
      # @return [Array(Integer, Integer)] the canonical +[window, bucket]+.
      def nearest_pair(pairs, window_seconds, bucket_seconds)
        pairs.each_with_index.min_by do |(window, bucket), index|
          [(window - window_seconds).abs, (bucket - bucket_seconds).abs, index]
        end.first
      end

      # Round a timestamp down to the start of its bucket, the boundary the
      # bucketed queries group on (+(ts / bucket) * bucket+).
      #
      # @param timestamp [Integer] unix seconds.
      # @param bucket_seconds [Integer] bucket width.
      # @return [Integer] the start of the bucket holding +timestamp+.
      def bucket_floor(timestamp, bucket_seconds)
        (timestamp / bucket_seconds) * bucket_seconds
      end

      # Reduce a cached series to the buckets that start at or after +since+.
      #
      # @param json [String] serialised series, an array of buckets that each
      #   carry +bucket_start+.
      # @param since [Integer] first bucket start to keep, a bucket boundary.
      # @return [String] the reduced series as JSON.
      def series_since(json, since)
        JSON.generate(JSON.parse(json).select { |bucket| bucket["bucket_start"].to_i >= since })
      end
    end
  end
end
