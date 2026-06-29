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
      # Allowed values for the +telemetry_type+ discriminator column.
      VALID_TELEMETRY_TYPES = %w[device environment power air_quality].freeze

      # Half-window (seconds) for the meshcore content-level message dedup
      # in +insert_message+ and the matching one-shot backfill.  Two
      # co-operating ingestors timestamp the same physical packet with their
      # own host clock, and those clocks drift: on potatomesh.net a fleet of
      # two live ingestors showed a consistent ~126 s offset (median 126 s,
      # p90 133 s, p99 221 s), so a 30 s window missed 89.6% of the duplicate
      # pairs and 28% of all meshcore rows were duplicates.  300 s covers
      # ~99.5% of the observed skew.  **Accepted tradeoff:** a sender repeating
      # the *identical* text to the same channel within 300 s collapses to one
      # row — chosen over the 28% duplicate rate.  (The one-shot purge in
      # +PotatoMesh::App::Database+ applies this transitively, so a chain of such
      # repeats spanning longer than 300 s also collapses — a deliberately
      # aggressive one-time cleanup; see that file's note.)  See issues
      # #756 / #825 and ``CONTRACTS.md`` for rationale.
      #
      # IMPORTANT: widening this value only takes effect at runtime — the
      # one-shot backfill in +PotatoMesh::App::Database+ is frozen at
      # +MESHCORE_CONTENT_DEDUP_BACKFILL_VERSION+.  To re-sweep pre-existing
      # rows that newly fall within an expanded window, bump the backfill
      # version so the migration re-runs on the next deploy.
      MESHCORE_CONTENT_DEDUP_WINDOW_SECONDS = 300

      # Coerce a Ruby boolean into a SQLite integer (1/0) while passing through
      # any other value unchanged. Used when writing boolean node fields.
      #
      # @param value [Boolean, Object] value to coerce.
      # @return [Integer, Object] 1, 0, or the original value.
      def coerce_bool(value)
        case value
        when true then 1
        when false then 0
        else value
        end
      end

      # Pair-zero tolerance used when classifying a +(lat, lon)+ tuple as the
      # Meshtastic "no GPS lock" sentinel.  See +normalize_lat_lon+ and
      # issue #782 for rationale.
      NULL_ISLAND_EPSILON = 1e-9

      # Collapse a Meshtastic +position.time+ candidate to +nil+ whenever it
      # represents the firmware "no GPS lock" sentinel.  Meshtastic emits
      # +time = 0+ until a fresh GPS fix is acquired, and SQLite happily stores
      # the zero — but downstream readers and the map renderer treat that as
      # a real epoch timestamp.  Routing every +position.time+ through this
      # helper at the write boundary ensures we persist +NULL+ instead.
      #
      # Future-dated values (e.g. clock-skew from misconfigured radios) are
      # also dropped so they cannot anchor the 7-day freshness filter beyond
      # the present moment.
      #
      # @param value [Object] raw +position.time+ value.
      # @param now [Integer] reference upper bound (seconds since the epoch).
      # @return [Integer, nil] positive coerced integer, or +nil+ when the
      #   value is missing, non-positive, non-integer-coercible, or future.
      def normalize_position_time(value, now:)
        coerced = coerce_integer(value)
        return nil if coerced.nil? || coerced <= 0
        return nil if now && coerced > now

        coerced
      end

      # Collapse a +(lat, lon)+ pair to +[nil, nil]+ when it represents the
      # Meshtastic "no GPS lock" sentinel — i.e. *both* axes are within
      # +NULL_ISLAND_EPSILON+ of zero.  Single-axis zeros are preserved so a
      # node legitimately at the equator (+lat = 0+) or the prime meridian
      # (+lon = 0+) survives.
      #
      # Non-finite or non-numeric axes are returned as +nil+ on their own
      # axis; the caller can then decide whether the surviving axis is enough
      # to keep the row.
      #
      # @param lat [Object] raw latitude candidate.
      # @param lon [Object] raw longitude candidate.
      # @return [Array(Float, Float)] +[lat_f, lon_f]+ as floats, with +nil+
      #   substituted on either axis when sentinel/invalid.
      def normalize_lat_lon(lat, lon)
        lat_f = coerce_float(lat)
        lon_f = coerce_float(lon)
        return [lat_f, lon_f] if lat_f.nil? || lon_f.nil?
        if lat_f.abs < NULL_ISLAND_EPSILON && lon_f.abs < NULL_ISLAND_EPSILON
          return [nil, nil]
        end

        [lat_f, lon_f]
      end
    end
  end
end
