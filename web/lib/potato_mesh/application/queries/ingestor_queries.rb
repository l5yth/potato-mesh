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

      # Decimals the served packets/hour rate keeps (SPEC IR1). One packet in
      # the 24 h window reads 0.042, so a protocol with any counted packet never
      # reads 0, and 0.0 means no packet in the window.
      PACKETS_PER_HOUR_DECIMALS = 3

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
      # +MAX(ingestor's 24 h packet total) ÷ 24+, rounded to
      # {PACKETS_PER_HOUR_DECIMALS} decimals (SPEC IR1). +total+ is the **SUM**
      # of the per-protocol rates: different protocols ride different
      # frequencies/channels, so their frames never overlap in the air and add
      # rather than dedup (a same-protocol frame heard by two radios is still
      # deduped by the per-protocol MAX). +reticulum+ went live with the
      # Reticulum ingestor (#888); it was a zero stub before that.
      #
      # Each stored row counts at most
      # {DataProcessing::FieldLimits::MAX_HEARTBEAT_PACKETS} (SPEC IB4), the
      # cap ingest applies, so a row stored before that cap cannot make the
      # sum overflow SQLite's signed 64-bit range.
      #
      # @param now [Integer] reference unix timestamp in seconds.
      # @param db [SQLite3::Database, nil] optional open database handle to reuse.
      # @return [Hash{String => Float}] +{ "total", "meshcore", "meshtastic",
      #   "reticulum" }+ => packets/hour to {PACKETS_PER_HOUR_DECIMALS}
      #   decimals; a protocol with no activity row reads 0.0.
      def query_packets_per_hour(now: Time.now.to_i, db: nil)
        handle = db || open_database(readonly: true)
        handle.results_as_hash = true
        reference_now = coerce_integer(now) || Time.now.to_i
        cutoff = reference_now - PACKETS_PER_HOUR_WINDOW_SECONDS

        rows = with_busy_retry do
          handle.execute(
            "SELECT ingestor_id, protocol AS p, SUM(MIN(packets, ?)) AS total " \
            "FROM ingestor_activity WHERE at >= ? GROUP BY ingestor_id, protocol",
            [DataProcessing::FieldLimits::MAX_HEARTBEAT_PACKETS, cutoff],
          )
        end

        per_protocol_max = Hash.new(0)
        rows.each do |row|
          protocol = row["p"]
          next unless protocol
          per_protocol_max[protocol] = [per_protocol_max[protocol], row["total"].to_i].max
        end

        # +total+ sums the per-protocol MAX vantages: distinct protocols ride
        # distinct frequencies/channels, so their frames never overlap in the air
        # and add rather than dedup (a same-protocol frame heard by two radios is
        # still deduped by the per-protocol MAX above). The sum is over the
        # *rounded* per-protocol rates, so +total+ equals the sum of the exposed
        # +<protocol>.packets.hour+ values (SPEC MA4, matching
        # +query_activity_buckets+); rounding after the raw sum could differ in
        # the last decimal. The sum is rounded again only to drop the binary
        # noise of float addition (0.1 + 0.2 is 0.30000000000000004).
        rates = per_protocol_max.transform_values { |packets| packets_per_hour_rate(packets) }
        {
          "total" => rates.values.sum(0.0).round(PACKETS_PER_HOUR_DECIMALS),
          "meshcore" => rates["meshcore"] || 0.0,
          "meshtastic" => rates["meshtastic"] || 0.0,
          "reticulum" => rates["reticulum"] || 0.0,
        }
      ensure
        handle&.close unless db
      end

      # Convert a 24-hour packet total into a packets/hour rate rounded to
      # {PACKETS_PER_HOUR_DECIMALS} decimals (MA4, SPEC IR1).
      #
      # @param total_packets [Integer] packets observed over the 24 h window.
      # @return [Float] hourly rate; above 0 for any positive total.
      def packets_per_hour_rate(total_packets)
        (total_packets / PACKETS_PER_HOUR_DIVISOR).round(PACKETS_PER_HOUR_DECIMALS)
      end

      # Aggregate mesh-wide packets/hour into ascending time buckets (SPEC F2).
      #
      # Each bucket carries the packets/hour rate per protocol, computed the
      # same way as the live {#query_packets_per_hour} (SPEC MA4): per protocol,
      # +MAX+ over that protocol's ingestors of their summed packets in the
      # bucket; +total+ is the +SUM+ across protocols; each is divided by the
      # bucket's hour-span to a rate. Unlike the live rate, a bucket's rate is
      # rounded to a whole number: a canonical bucket spans one or two hours
      # (SPEC RC1), so a bucket holding a packet reads at least 1 (SPEC IR1).
      # Every known protocol
      # (+meshcore+/+meshtastic+/+reticulum+) is emitted as a key, mirroring
      # {#query_packets_per_hour}. The window is clamped to the
      # 28-day visibility floor (C4); the route serves canonical pairs only,
      # at most 85 buckets (SPEC RC1), and this query caps the row count at
      # +MAX_QUERY_LIMIT+ too. Each stored row counts at most
      # {DataProcessing::FieldLimits::MAX_HEARTBEAT_PACKETS}, as in
      # {#query_packets_per_hour} (SPEC IB4).
      #
      # @param window_seconds [Integer] span to include, in seconds.
      # @param bucket_seconds [Integer] bucket width, in seconds.
      # @param since [Integer] extra lower-bound timestamp (unix seconds).
      # @param now [Integer] reference unix timestamp (exposed for tests).
      # @param db [SQLite3::Database, nil] optional open handle to reuse.
      # @return [Array<Hash>] ascending buckets, each +{ "bucket_start",
      #   "bucket_end", "total", "meshcore", "meshtastic", "reticulum" }+ with
      #   integer packets/hour rates.
      def query_activity_buckets(window_seconds:, bucket_seconds:, since: 0, now: Time.now.to_i, db: nil)
        window = coerce_integer(window_seconds) || DEFAULT_ACTIVITY_WINDOW_SECONDS
        window = DEFAULT_ACTIVITY_WINDOW_SECONDS if window <= 0
        window = clamp_window_seconds(window) || DEFAULT_ACTIVITY_WINDOW_SECONDS
        bucket = coerce_integer(bucket_seconds) || DEFAULT_ACTIVITY_BUCKET_SECONDS
        bucket = DEFAULT_ACTIVITY_BUCKET_SECONDS if bucket <= 0

        handle = db || open_database(readonly: true)
        handle.results_as_hash = true
        reference_now = coerce_integer(now) || Time.now.to_i
        since_threshold = normalize_since_threshold(since, floor: reference_now - window)

        rows = with_busy_retry do
          handle.execute(<<~SQL, [bucket, bucket, DataProcessing::FieldLimits::MAX_HEARTBEAT_PACKETS, since_threshold, MAX_QUERY_LIMIT])
            SELECT bucket_start, p, MAX(ingestor_total) AS protocol_max
            FROM (
              SELECT ((at / ?) * ?) AS bucket_start, protocol AS p, ingestor_id,
                     SUM(MIN(packets, ?)) AS ingestor_total
              FROM ingestor_activity
              WHERE at >= ?
              GROUP BY bucket_start, p, ingestor_id
            )
            GROUP BY bucket_start, p
            ORDER BY bucket_start ASC
            LIMIT ?
          SQL
        end

        hours = bucket / 3600.0
        buckets = {}
        order = []
        rows.each do |row|
          bucket_start = coerce_integer(row["bucket_start"])
          next unless bucket_start
          entry = buckets[bucket_start]
          unless entry
            entry = {
              "bucket_start" => bucket_start,
              "bucket_end" => bucket_start + bucket,
              "total" => 0,
              "meshcore" => 0,
              "meshtastic" => 0,
              "reticulum" => 0,
            }
            buckets[bucket_start] = entry
            order << bucket_start
          end
          rate = ((coerce_integer(row["protocol_max"]) || 0) / hours).round
          entry["total"] += rate
          protocol = row["p"]
          entry[protocol] = rate if entry.key?(protocol)
        end
        order.map { |key| buckets[key] }
      ensure
        handle&.close unless db
      end
    end
  end
end
