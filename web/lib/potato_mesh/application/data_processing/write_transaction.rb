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
      # Statements that open, close and undo a {#write_transaction} of its
      # own: +BEGIN IMMEDIATE+ takes the write lock before the first read
      # (SPEC BT1).
      WRITE_TRANSACTION_FRAME = {
        open: "BEGIN IMMEDIATE TRANSACTION",
        close: ["COMMIT TRANSACTION"].freeze,
        undo: ["ROLLBACK TRANSACTION"].freeze,
      }.freeze

      # Statements of a {#write_transaction} inside the caller's transaction,
      # one savepoint per name. Rolling back to a savepoint keeps it open, so
      # it is released after (SPEC BT2).
      WRITE_SAVEPOINT_FRAMES = %i[
        ingest_batch ingest_record upsert_node insert_neighbors meshcore_chat_node retention_sweep
      ].to_h do |name|
        frame = {
          open: "SAVEPOINT #{name}",
          close: ["RELEASE SAVEPOINT #{name}"].freeze,
          undo: ["ROLLBACK TO SAVEPOINT #{name}", "RELEASE SAVEPOINT #{name}"].freeze,
        }
        [name, frame.freeze]
      end.freeze

      # Interrupts from other threads while a frame opens, closes or is
      # undone: held back (SPEC BT1, FK1).
      WRITE_FRAME_EDGE_MASK = { Object => :never }.freeze

      # Interrupts while the block of a transaction of its own runs: every
      # one lands at once, and the frame's +ensure+ rolls the block back.
      WRITE_TRANSACTION_BLOCK_MASK = { Object => :immediate }.freeze

      # Interrupts while the block of a savepoint runs. A +StandardError+
      # raised from another thread, such as Puma's +ForceShutdown+, waits
      # until the savepoint has closed or been undone, so code around it
      # that rescues +StandardError+, as {#ingest_batch} does to skip a bad
      # record, never takes it for an error of the block; +Thread#kill+ and
      # +Timeout+ still land at once (SPEC BT3).
      WRITE_SAVEPOINT_BLOCK_MASK = { StandardError => :never, Object => :immediate }.freeze

      # SQLite errors a record's own values raise: an SQL or binding error, a
      # constraint, a type or size mismatch, a bind index out of range. The
      # gem raises the bare +SQLite3::Exception+ for a value it cannot bind.
      # Every other +SQLite3::Exception+ is an error of the database, such as
      # busy, locked, full, I/O, corrupt or read-only (SPEC BT3).
      RECORD_SQLITE_ERRORS = [
        SQLite3::SQLException,
        SQLite3::ConstraintException,
        SQLite3::MismatchException,
        SQLite3::TooBigException,
        SQLite3::RangeException,
      ].freeze

      # Run +block+ as one atomic write on +db+ (SPEC BT1, BT2).
      #
      # Without an open transaction on +db+ the block runs in a
      # +BEGIN IMMEDIATE+ transaction, which takes the write lock before the
      # block's first read, so no other connection writes between that read
      # and the block's last write; the busy handler waits for the lock
      # (SPEC SK4), and the caller's {#with_busy_retry} runs the frame again
      # while SQLite reports busy. When +db+ already holds a transaction, a
      # nested +BEGIN+ raises, so the block runs in the savepoint +name+
      # inside it and the caller's transaction keeps its own locking and
      # retries. Unless the block returns, every write it made is rolled
      # back: on a raise, and also on a +throw+, a killed thread or a
      # +Timeout+, on which the gem's +Database#transaction+ block commits.
      # The pattern is FK1's ({#instance_record_transaction}). An interrupt
      # that lands while +BEGIN+ waits for the write lock is held back until
      # the wait ends, the lock taken or the busy timeout spent (SPEC BT1).
      # Also a module function, so code outside the data-processing hosts,
      # such as the retention sweep (SPEC BT7), runs it as
      # +DataProcessing.write_transaction+.
      #
      # @param db [SQLite3::Database] open database handle.
      # @param name [Symbol] savepoint name, a key of {WRITE_SAVEPOINT_FRAMES}.
      # @param after_close [#call, nil] run once the frame has closed, with
      #   interrupts still held back, so an interrupt held back at +COMMIT+
      #   lands only after it (SPEC BT5).
      # @yieldreturn [Object] the block's result.
      # @return [Object] the block's result.
      # @raise [KeyError] when +name+ names no savepoint.
      def write_transaction(db, name, after_close: nil, &block)
        if db.transaction_active?
          run_write_frame(db, WRITE_SAVEPOINT_FRAMES.fetch(name), WRITE_SAVEPOINT_BLOCK_MASK, after_close, &block)
        else
          run_write_frame(db, WRITE_TRANSACTION_FRAME, WRITE_TRANSACTION_BLOCK_MASK, after_close, &block)
        end
      end

      # Open +frame+ on +db+, run +block+ in it and close it, or undo it
      # unless the block returned (SPEC BT1).
      #
      # Interrupts from other threads wait while the frame opens, closes or
      # is undone ({WRITE_FRAME_EDGE_MASK}) and land, as +block_mask+ lets
      # them, only while the block runs, inside the +ensure+ that undoes it,
      # so no interrupt leaves a transaction or a savepoint open on the
      # handle. The undo is skipped when SQLite has already ended the
      # transaction (+SQLITE_FULL+, +SQLITE_IOERR+): it would raise and
      # replace the error.
      #
      # @param db [SQLite3::Database] open database handle.
      # @param frame [Hash] {WRITE_TRANSACTION_FRAME} or one of
      #   {WRITE_SAVEPOINT_FRAMES}.
      # @param block_mask [Hash] interrupt mask while the block runs.
      # @param after_close [#call, nil] run once the frame has closed, before
      #   any interrupt held back lands.
      # @yieldreturn [Object] the block's result.
      # @return [Object] the block's result.
      def run_write_frame(db, frame, block_mask, after_close = nil, &block)
        Thread.handle_interrupt(WRITE_FRAME_EDGE_MASK) do
          opened = false
          closed = false
          begin
            db.execute(frame[:open])
            opened = true
            result = Thread.handle_interrupt(block_mask, &block)
            frame[:close].each { |sql| db.execute(sql) }
            closed = true
            after_close&.call
            result
          ensure
            frame[:undo].each { |sql| db.execute(sql) } if opened && !closed && db.transaction_active?
          end
        end
      end

      module_function :write_transaction, :run_write_frame

      # Write every record of one ingest batch in one transaction (SPEC BT1,
      # BT3).
      #
      # The records are written in one {#write_transaction}, so the batch
      # commits once, or not at all, and a concurrent batch waits for the
      # write lock instead of interleaving. Each record is yielded inside a
      # savepoint of its own. A record whose write raises an error of the
      # record ({#ingest_record_error?}) is rolled back to its savepoint
      # alone and skipped, and the rest of the batch is stored, as SL5 skips
      # a record with an id in no legitimate form; the route still answers
      # 201. An error of the database, or one after which SQLite has ended
      # the transaction, rolls the whole batch back and is raised, as is an
      # interrupt from another thread: nothing of the batch is stored. One
      # warn line after the commit names the records skipped, and one debug
      # line each. {#with_busy_retry} runs the batch again while SQLite
      # reports busy, from its first record.
      #
      # Once +COMMIT+ has succeeded, the log lines and +after_commit+ (the
      # route's cache invalidation and live-update publish) run before any
      # interrupt held back at +COMMIT+ lands, so a committed batch is
      # always announced (SPEC BT5). An error +after_commit+ raises is raised
      # once the frame has closed, so the committed batch is not written
      # again by a retry. When +db+ already holds a transaction, the batch
      # runs in a savepoint ({#write_transaction}) and they run at its
      # +RELEASE+, before the caller's transaction commits; no route calls
      # it inside a transaction.
      #
      # @param db [SQLite3::Database] the request's database handle.
      # @param records [Enumerable] the batch; a Hash yields its pairs.
      # @param context [String] log context, such as +ingest.messages+.
      # @param after_commit [#call, nil] the route's work once the batch has
      #   committed, or once its savepoint is released inside a caller's
      #   transaction.
      # @yieldparam record [Object] one record of the batch.
      # @return [Integer] records skipped.
      def ingest_batch(db, records, context:, after_commit: nil)
        skipped = []
        hook_error = nil
        committed = lambda do
          log_skipped_ingest_records(context, records.size, skipped)
          after_commit&.call
        rescue StandardError => e
          hook_error = e
        end
        with_busy_retry do
          skipped = []
          write_transaction(db, :ingest_batch, after_close: committed) do
            records.each_with_index do |record, index|
              error = ingest_batch_record(db) { yield record }
              skipped << [index, error] if error
            end
          end
        end
        raise hook_error if hook_error

        skipped.size
      end

      # Write one record in its savepoint, rolling it back alone on an error
      # of the record (SPEC BT3).
      #
      # A +StandardError+ another thread raises while the record is written
      # waits until the record's savepoint has closed ({WRITE_SAVEPOINT_BLOCK_MASK}
      # and the mask here), and then lands outside this +rescue+, between
      # records, so it fails the batch instead of skipping the record.
      #
      # @param db [SQLite3::Database] the batch's database handle.
      # @yield writes the record.
      # @return [StandardError, nil] the record's error when it was skipped,
      #   nil when it was written.
      # @raise [StandardError] an error of the database, or any error once
      #   SQLite has ended the batch's transaction.
      def ingest_batch_record(db)
        Thread.handle_interrupt(StandardError => :never) do
          write_transaction(db, :ingest_record) { yield }
          nil
        rescue StandardError => e
          raise unless ingest_record_error?(e) && db.transaction_active?

          e
        end
      end

      # Whether +error+ comes from a record's own values, not from the
      # database (SPEC BT3).
      #
      # @param error [StandardError] what writing a record raised.
      # @return [Boolean] true for every error but an +SQLite3::Exception+
      #   outside {RECORD_SQLITE_ERRORS} and the gem's bare one.
      def ingest_record_error?(error)
        return true unless error.is_a?(SQLite3::Exception)

        error.instance_of?(SQLite3::Exception) || RECORD_SQLITE_ERRORS.any? { |klass| error.is_a?(klass) }
      end

      # Log the records a committed batch skipped: one debug line each, then
      # one warn line for the batch (SPEC BT3).
      #
      # @param context [String] log context of the route.
      # @param total [Integer] records in the batch.
      # @param skipped [Array<Array(Integer, StandardError)>] index and error
      #   of each record skipped.
      # @return [void]
      def log_skipped_ingest_records(context, total, skipped)
        return if skipped.empty?

        skipped.each do |index, error|
          debug_log(
            "Skipped an ingest record that failed to store",
            context: context,
            index: index,
            error_class: error.class.name,
            error_message: ingest_error_line(error),
            location: Array(error.backtrace).first,
          )
        end
        index, error = skipped.first
        warn_log(
          "Skipped ingest records that failed to store",
          context: context,
          records: total,
          skipped: skipped.size,
          index: index,
          error_class: error.class.name,
          error_message: ingest_error_line(error),
        )
      end

      # The first line of an error's message; the gem appends the statement
      # on the lines after it.
      #
      # @param error [StandardError] the error.
      # @return [String] the line, without a trailing colon.
      def ingest_error_line(error)
        error.message.lines.first.to_s.chomp.chomp(":")
      end
    end
  end
end
