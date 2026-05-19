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
    # Background data retention enforcement.
    #
    # The retention module deletes rows whose most recent activity timestamp
    # is older than {PotatoMesh::Config.year_seconds} (365 days).  Two
    # mechanisms compose to make this safe:
    #
    # * Each table is purged on its own timestamp column ({.RETENTION_TARGETS})
    #   so a stale row in one table never holds another table hostage.
    # * Foreign keys defined in the schema (e.g. +neighbors+ → +nodes+,
    #   +trace_hops+ → +traces+) propagate cascading deletes for dependent
    #   rows, keeping the database consistent without bespoke DELETE
    #   statements per relationship.
    #
    # The purge runs in a dedicated daemon thread spawned during the
    # Sinatra +configure+ block.  An +at_exit+ hook tears the thread down
    # cleanly on process exit, mirroring the federation announcer pattern.
    module Retention
      # Tables purged on each cycle, paired with the column whose value is
      # compared against the retention cutoff.  Each entry's column points at
      # the freshest activity timestamp for the table — when that column
      # drops below +(now - year_seconds)+ the row is unrecoverable through
      # the API anyway, so it is safe to remove from disk.
      #
      # Ordering matters: child tables that participate in +ON DELETE CASCADE+
      # relationships (notably +neighbors+, which references +nodes+) are
      # purged *before* their parents.  Otherwise the parent purge would
      # cascade-delete the same rows the explicit child DELETE was about to
      # touch, leaving +db.changes+ to under-report the work done.
      RETENTION_TARGETS = [
        ["neighbors", "rx_time"],
        ["messages", "rx_time"],
        ["positions", "rx_time"],
        ["telemetry", "rx_time"],
        ["traces", "rx_time"],
        ["ingestors", "last_seen_time"],
        ["nodes", "last_heard"],
      ].freeze

      # Run a single retention sweep, deleting rows older than +cutoff+ from
      # every {RETENTION_TARGETS} entry.  Each table is wrapped in its own
      # +with_busy_retry+ to stay resilient to short-lived SQLite locks held
      # by the ingestor.
      #
      # @param now [Integer] reference unix timestamp; defaults to the
      #   current wall-clock seconds.  Exposed for tests so they can fast
      #   forward without manipulating system time.
      # @return [Hash{String => Integer}] count of rows removed per table.
      def purge_old_data!(now: Time.now.to_i)
        cutoff = now - PotatoMesh::Config.year_seconds
        removed = Hash.new(0)

        db = open_database
        begin
          # Foreign-key cascades only fire when PRAGMA foreign_keys = ON,
          # which open_database already enforces.  Relying on the schema
          # cascades keeps the DELETE list small and avoids the need to
          # manually clean +trace_hops+ before its parent.
          #
          # The whole sweep runs inside a single transaction so a crash or
          # shutdown mid-pass either commits every table's deletions or
          # leaves the DB untouched — never half-purged.
          with_busy_retry do
            db.transaction do
              RETENTION_TARGETS.each do |table, column|
                sql = "DELETE FROM #{table} WHERE #{column} IS NOT NULL AND #{column} < ?"
                db.execute(sql, [cutoff])
                removed[table] = db.changes
              end
            end
          end
        ensure
          db&.close
        end

        debug_log(
          "Purged data outside retention window",
          context: "retention.purge",
          cutoff: cutoff,
          removed: removed,
        )
        removed
      rescue StandardError => e
        warn_log(
          "Retention purge failed",
          context: "retention.purge",
          error_class: e.class.name,
          error_message: e.message,
        )
        {}
      end

      # Whether the periodic retention worker should run for the current
      # process.  Mirrors {Helpers#federation_announcements_active?} so the
      # test suite does not spawn a long-lived sleeper that briefly holds
      # database write locks while specs are executing.
      #
      # @return [Boolean] +false+ in the +RACK_ENV=test+ environment,
      #   +true+ otherwise.
      def retention_worker_active?
        return !test_environment? if respond_to?(:test_environment?)

        ENV["RACK_ENV"] != "test"
      end

      # Spawn the long-running retention worker.  Mirrors the federation
      # announcer thread layout — short shutdown-aware sleeps so the daemon
      # exits promptly when the process is shutting down.
      #
      # @return [Thread, nil] the worker thread, or +nil+ when already running.
      def start_retention_thread!
        ensure_retention_shutdown_hook!

        existing = settings.respond_to?(:retention_thread) ? settings.retention_thread : nil
        return existing if existing&.alive?

        thread = Thread.new do
          retention_thread_loop
        end
        thread.name = "potato-mesh-retention" if thread.respond_to?(:name=)
        thread.daemon = true if thread.respond_to?(:daemon=)
        set(:retention_thread, thread) if respond_to?(:set)
        thread
      end

      # Driver loop for the retention worker.  Extracted so unit tests can
      # exercise the body in isolation without spawning a real Thread.
      #
      # @return [void]
      def retention_thread_loop
        # Wait briefly before the first sweep so schema migrations and
        # federation handshakes complete before a long DELETE acquires write
        # locks.
        delay = PotatoMesh::Config.initial_retention_delay_seconds
        return unless retention_sleep_with_shutdown(delay)

        loop do
          # purge_old_data! rescues StandardError internally and logs to the
          # "retention.purge" context, so the loop body is guaranteed not to
          # raise.  No outer rescue is needed.
          purge_old_data!
          break unless retention_sleep_with_shutdown(
            PotatoMesh::Config.retention_purge_interval_seconds,
          )
        end
      end

      # Sleep in small slices so the retention worker reacts quickly to a
      # shutdown request.  Mirrors {Federation#federation_sleep_with_shutdown}
      # so behaviour is consistent across long-lived workers.
      #
      # @param seconds [Numeric] total sleep duration.
      # @return [Boolean] +true+ when the full delay elapsed, +false+ when a
      #   shutdown was requested mid-sleep.
      def retention_sleep_with_shutdown(seconds)
        remaining = seconds.to_f
        slice_size = 0.2
        while remaining.positive?
          return false if retention_shutdown_requested?

          slice = [remaining, slice_size].min
          Kernel.sleep(slice)
          remaining -= slice
        end
        !retention_shutdown_requested?
      end

      # Whether a retention shutdown has been requested.
      #
      # @return [Boolean]
      def retention_shutdown_requested?
        return false unless respond_to?(:settings)
        return false unless settings.respond_to?(:retention_shutdown_requested)

        settings.retention_shutdown_requested == true
      end

      # Request the retention thread to exit at the next slice boundary.
      #
      # @return [void]
      def request_retention_shutdown!
        set(:retention_shutdown_requested, true) if respond_to?(:set)
      end

      # Clear any retention shutdown request.  Called at boot so a previous
      # shutdown does not stop a freshly started worker.
      #
      # @return [void]
      def clear_retention_shutdown_request!
        set(:retention_shutdown_requested, false) if respond_to?(:set)
      end

      # Tear down the retention thread, joining it within the configured
      # shutdown timeout.  Invoked from the +at_exit+ hook installed by
      # {#ensure_retention_shutdown_hook!}.
      #
      # @param timeout [Numeric] seconds to wait for clean exit.
      # @return [void]
      def shutdown_retention_thread!(timeout: PotatoMesh::Config.federation_shutdown_timeout_seconds)
        request_retention_shutdown!
        return unless respond_to?(:settings)
        return unless settings.respond_to?(:retention_thread)

        thread = settings.retention_thread
        if thread&.alive?
          begin
            thread.wakeup if thread.respond_to?(:wakeup)
          rescue ThreadError
            # Thread may not be sleeping; continue.
          end
          thread.join(timeout)
          if thread.alive?
            thread.kill
            thread.join(0.1)
          end
        end
        set(:retention_thread, nil) if respond_to?(:set)
      end

      # Install an +at_exit+ hook that tears down the retention worker on
      # process termination.  Idempotent — repeated calls are no-ops after
      # the first install.
      #
      # @return [void]
      def ensure_retention_shutdown_hook!
        application = is_a?(Class) ? self : self.class
        return application.ensure_retention_shutdown_hook! unless application.equal?(self)

        installed = if respond_to?(:settings) && settings.respond_to?(:retention_shutdown_hook_installed)
            settings.retention_shutdown_hook_installed
          else
            instance_variable_defined?(:@retention_shutdown_hook_installed) &&
              @retention_shutdown_hook_installed
          end
        return if installed

        if respond_to?(:set) && settings.respond_to?(:retention_shutdown_hook_installed=)
          set(:retention_shutdown_hook_installed, true)
        else
          @retention_shutdown_hook_installed = true
        end

        at_exit do
          begin
            application.shutdown_retention_thread!
          rescue StandardError
            # Suppress shutdown errors during interpreter teardown.
          end
        end
      end
    end
  end
end
