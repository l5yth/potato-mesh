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
    module Queries
      # Rolling window used for the packets/hour moving average (SPEC MA4): each
      # ingestor's packet total over the last 24 hours.
      PACKETS_PER_HOUR_WINDOW_SECONDS = 86_400

      # Fixed denominator that turns a window total into an hourly rate. Derived
      # from the window (24 h) rather than the *elapsed* span so the rate stays
      # stable and never spikes for a freshly-started ingestor with only a few
      # hours of data (SPEC MA4). The announcement only fires ≥ 24 h after start
      # (MA7), so by then a live ingestor has a full window anyway.
      PACKETS_PER_HOUR_DIVISOR = PACKETS_PER_HOUR_WINDOW_SECONDS / 3600.0

      # Compute the mesh-wide packets/hour moving average per protocol scope
      # (SPEC MA4/MA5), aggregated **MAX-per-protocol** across ingestors. The
      # +GET /api/stats+ route folds each rate into its scope as the additive
      # +<scope>.packets.hour+ metric; this method returns the flat per-scope
      # rate map that assembly consumes.
      #
      # A single radio can only hear ≤ what is actually transmitted, so the
      # busiest single vantage is the best dedup-free estimate of unique air
      # traffic and can never double-count a frame heard by two radios (true
      # per-frame dedup is impossible — ignored/errored frames carry no id).
      # For each protocol the rate is
      # +MAX(ingestor's 24 h packet total) ÷ 24+, rounded; +total+ is the same
      # MAX taken over **every** ingestor regardless of protocol (so an ingestor
      # reporting several protocols contributes its combined total). +reticulum+
      # is a forward-looking always-zero stub (SPEC S6/MA5).
      #
      # @param now [Integer] reference unix timestamp in seconds.
      # @param db [SQLite3::Database, nil] optional open database handle to reuse.
      # @return [Hash{String => Integer}] +{ "total", "meshcore", "meshtastic",
      #   "reticulum" }+ => rounded packets/hour.
      def query_packets_per_hour(now: Time.now.to_i, db: nil)
        handle = db || open_database(readonly: true)
        handle.results_as_hash = true
        reference_now = coerce_integer(now) || Time.now.to_i
        cutoff = reference_now - PACKETS_PER_HOUR_WINDOW_SECONDS

        rows = with_busy_retry do
          handle.execute(
            "SELECT ingestor_id, protocol AS p, SUM(packets) AS total " \
            "FROM ingestor_activity WHERE at >= ? GROUP BY ingestor_id, protocol",
            [cutoff],
          )
        end

        per_protocol_max = Hash.new(0)
        per_ingestor_total = Hash.new(0)
        rows.each do |row|
          protocol = row["p"]
          total = row["total"].to_i
          per_protocol_max[protocol] = [per_protocol_max[protocol], total].max if protocol
          per_ingestor_total[row["ingestor_id"]] += total
        end

        {
          "total" => packets_per_hour_rate(per_ingestor_total.values.max || 0),
          "meshcore" => packets_per_hour_rate(per_protocol_max["meshcore"]),
          "meshtastic" => packets_per_hour_rate(per_protocol_max["meshtastic"]),
          "reticulum" => 0,
        }
      ensure
        handle&.close unless db
      end

      # Convert a 24-hour packet total into a rounded packets/hour rate (MA4).
      #
      # @param total_packets [Integer] packets observed over the 24 h window.
      # @return [Integer] rounded hourly rate.
      def packets_per_hour_rate(total_packets)
        (total_packets / PACKETS_PER_HOUR_DIVISOR).round
      end
    end
  end
end
