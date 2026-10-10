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
      # Rate limit of the warnings that dropped message copies and records
      # log (SPEC KC5).
      #
      # A token holder or a compromised ingestor can post a whole batch under
      # ids other nodes hold, and each record would log one warning.  Per
      # logging context the limiter lets {LIMIT} warnings through in a window
      # of {WINDOW_SECONDS} that opens with the first, and counts the rest.
      # The context's first warning after the window ends opens the next
      # window and carries that count, so a flood costs one line more.  No
      # timer runs: a count waits for the context's next warning.  All
      # methods are thread-safe.
      class CollisionWarningLimiter
        # Warnings logged per context in one window.
        LIMIT = 10

        # Length of a window, in seconds.
        WINDOW_SECONDS = 60

        # @return [Integer] warnings logged per context in one window.
        attr_reader :limit

        # @return [Numeric] length of a window, in seconds.
        attr_reader :window_seconds

        # Start with no window open.
        #
        # @param limit [Integer] warnings logged per context in one window.
        # @param window_seconds [Numeric] length of a window, in seconds.
        # @param clock [#call] returns the current time in seconds; the
        #   monotonic clock unless a test injects its own.
        # @return [void]
        def initialize(limit: LIMIT, window_seconds: WINDOW_SECONDS, clock: -> { Process.clock_gettime(Process::CLOCK_MONOTONIC) })
          @limit = limit
          @window_seconds = window_seconds
          @clock = clock
          @mutex = Mutex.new
          @windows = {}
        end

        # Count one warning of +context+.
        #
        # @param context [String] logging context of the warning.
        # @return [Array(Boolean, Integer)] whether to log the warning, and
        #   the count the context's previous window suppressed when this
        #   warning opens a new window (0 otherwise).
        def admit(context)
          @mutex.synchronize do
            now = @clock.call
            window = @windows[context]
            reported = 0
            unless window && now - window[:opened] < @window_seconds
              reported = window ? window[:suppressed] : 0
              window = @windows[context] = { opened: now, logged: 0, suppressed: 0 }
            end
            if window[:logged] < @limit
              window[:logged] += 1
              [true, reported]
            else
              window[:suppressed] += 1
              [false, 0]
            end
          end
        end

        # Forget every window, as a new process starts with none.
        #
        # @return [void]
        def reset!
          @mutex.synchronize { @windows.clear }
        end
      end

      # Sinatra builds an app instance per request, so the limiter lives on
      # the module for the lifetime of the process.
      @collision_warning_limiter = CollisionWarningLimiter.new

      # @return [CollisionWarningLimiter] the limiter every collision warning
      #   of this process passes (SPEC KC5).
      def self.collision_warning_limiter
        @collision_warning_limiter
      end

      # The process-wide {CollisionWarningLimiter}.
      #
      # @return [CollisionWarningLimiter] the shared limiter.
      def collision_warning_limiter
        PotatoMesh::App::DataProcessing.collision_warning_limiter
      end

      # Log the warning of a dropped message copy or record unless its
      # context logged {CollisionWarningLimiter::LIMIT} in the current window
      # (SPEC KC5).  A warning that opens a new window is preceded by one
      # +Suppressed collision warnings+ line carrying the count the previous
      # window suppressed, when it suppressed any.
      #
      # @param text [String] warning text.
      # @param context [String] logging context, the unit of the limit.
      # @param fields [Hash] structured fields of the warning.
      # @return [void]
      def warn_collision(text, context:, **fields)
        limiter = collision_warning_limiter
        logged, suppressed = limiter.admit(context)
        if suppressed.positive?
          warn_log(
            "Suppressed collision warnings",
            context: context,
            suppressed: suppressed,
            window_seconds: limiter.window_seconds,
          )
        end
        warn_log(text, context: context, **fields) if logged
      end

      # Log a position, telemetry reading or trace that left the stored row
      # alone because its id is stored for another node (SPEC KC4, limited
      # by SPEC KC5).
      #
      # Each of the three upserts updates a stored row only when the row
      # names no node or the record's own (+src+ for traces), so an upsert
      # that changed no row met another node's record under the same id.  A
      # trace's +src+ is a node number and is logged as the id it names.
      #
      # @param db [SQLite3::Database] open database handle.
      # @param table [String] +positions+, +telemetry+ or +traces+.
      # @param column [String] the column naming the node: +node_id+, or
      #   +src+ for traces.
      # @param id [Integer] id the dropped record shares with the stored row.
      # @param incoming [String, Integer, nil] the node the dropped record names.
      # @param context [String] logging context of the writer.
      # @return [void]
      def warn_dropped_record(db, table, column, id, incoming, context:)
        stored = db.get_first_value("SELECT #{column} FROM #{table} WHERE id = ?", [id])
        warn_collision(
          "Dropped a record whose id another node holds",
          context: context,
          table: table,
          id: id,
          "stored_#{column}": collision_node_label(stored),
          column.to_sym => collision_node_label(incoming),
        )
      end

      # How a collision warning names a node: a node number as the
      # canonical +!xxxxxxxx+ id it names (a negative one names none and
      # stays a number), a node id as stored.
      #
      # @param node_ref [String, Integer, nil] node id, node number or nil.
      # @return [String, Integer, nil] the id a node number names, otherwise
      #   +node_ref+.
      def collision_node_label(node_ref)
        return node_ref unless node_ref.is_a?(Integer)

        canonical_node_parts(node_ref)&.first || node_ref
      end
    end
  end
end
