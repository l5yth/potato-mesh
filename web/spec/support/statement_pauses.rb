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

require "sqlite3"
require "timeout"

# Stop a thread before the n-th statement its connections prepare, or before
# a connection closes, and interrupt it there (+ingest_batch_transaction_spec.rb+,
# +retention_spec.rb+, SPEC BT1, BT2, BT7). Every statement of the gem's +execute+, +get_first_value+,
# +get_first_row+ and +execute_batch+ is prepared through +prepare+, so the
# count is per statement. Only a thread that carries a {Pause} in
# +Thread.current[:statement_pause]+ is counted; every other thread runs on.
# The including group calls {#stub_statement_pauses} before it pauses.
module StatementPauses
  # One thread's pause point: before statement +target+ (1-based; the close
  # of a connection counts as one), told to +reached+ and held until
  # +release+ is pushed, at most 5 s.
  Pause = Struct.new(:target, :count, :seen, :reached, :release) do
    # @param target [Integer, nil] statement to pause before; nil only counts.
    # @return [Pause] a pause that has counted nothing.
    def self.at(target)
      new(target, 0, [], Queue.new, Queue.new)
    end

    # Count one statement and pause when it is the target.
    #
    # @param sql [String] the statement about to run, or +"(close)"+.
    # @return [void]
    def tick(sql)
      self.count += 1
      seen << sql.to_s.strip
      return unless count == target

      reached << sql.to_s.strip
      release.pop(timeout: 5)
    end
  end

  # Count, and pause, the statements and closes of every connection on a
  # thread that carries a {Pause}.
  #
  # @return [void]
  def stub_statement_pauses
    allow_any_instance_of(SQLite3::Database).to receive(:prepare).and_wrap_original do |original, sql, *args, **options, &block|
      Thread.current[:statement_pause]&.tick(sql)
      original.call(sql, *args, **options, &block)
    end
    allow_any_instance_of(SQLite3::Database).to receive(:close).and_wrap_original do |original, *args, **options|
      Thread.current[:statement_pause]&.tick("(close)") unless original.receiver.closed?
      original.call(*args, **options)
    end
  end

  # Run +action+ on a thread of its own and count its statements.
  #
  # @return [Array<String>] the statements, in order, closes as +"(close)"+.
  def statements_of(&action)
    pause = Pause.at(nil)
    Thread.new do
      Thread.current[:statement_pause] = pause
      action.call
    end.join
    pause.seen
  end

  # Run +action+ on a thread of its own, stop it before statement +target+
  # and interrupt it there: +:kill+ kills the thread, +:timeout+ lets a
  # 0.1 s +Timeout+ around +action+ fire. The thread is released and
  # reaped on every path, a pause that never comes included, so none is
  # left holding the write lock.
  #
  # @param target [Integer] statement to stop before.
  # @param kind [Symbol] +:kill+ or +:timeout+.
  # @return [String, nil] the statement it stopped before; nil when it never
  #   reached it within 5 s.
  def interrupt_at_statement(target, kind, &action)
    pause = Pause.at(target)
    worker = Thread.new do
      Thread.current[:statement_pause] = pause
      Thread.current.report_on_exception = false
      kind == :timeout ? Timeout.timeout(0.1, &action) : action.call
    rescue Timeout::Error
      nil
    end
    paused_at = pause.reached.pop(timeout: 5)
    if kind == :timeout
      # The Timeout ends the thread within the pause; one held back while a
      # frame opens or closes lands once the statement runs, after the
      # release.
      worker.join(0.25)
    else
      worker.kill
    end
    paused_at
  ensure
    if worker
      worker.kill if kind == :kill
      pause.release << true
      worker.join(5)
    end
  end

  # Whether a new connection takes the write lock at once.
  #
  # @return [Boolean] false while another connection holds it.
  def write_lock_free?
    db = SQLite3::Database.new(PotatoMesh::Config.db_path)
    db.execute("BEGIN IMMEDIATE")
    db.execute("ROLLBACK")
    true
  rescue SQLite3::BusyException
    false
  ensure
    db&.close
  end
end
