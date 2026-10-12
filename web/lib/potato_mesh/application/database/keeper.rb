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

# Loaded first, so the gem's own fork hook sits below KeeperForkHook and
# discards inherited connections before the keeper opens its new one.
require "sqlite3"

module PotatoMesh
  module App
    module Database
      # One idle, long-lived connection to the application database per
      # process (SPEC SK1).
      #
      # SQLite checkpoints the WAL and deletes it when the last connection
      # to the database closes. Each request opens and closes a connection
      # of its own, so without another one open every request's close was
      # the last, and a single-record POST paid a checkpoint and four
      # fsyncs. While the keeper is open no request's connection is the
      # last: the WAL stays in place, SQLite's automatic checkpoint (1000
      # WAL pages) moves it into the database file, and +journal_size_limit+
      # trims it afterwards (SPEC SK3).
      #
      # The keeper runs one statement as it opens. That puts it in WAL mode,
      # in which a connection holds a shared lock on the database file for
      # as long as it is open. The statement ends at once, so the keeper
      # holds no read transaction and never stops a checkpoint. It is
      # read-write so that, closed last at exit, it checkpoints the WAL into
      # the database file and deletes it, as the last request connection did
      # before. While it holds its lock, SQLite keeps the descriptor of each
      # closed connection for the next one opened with the same flags, so a
      # process holds about as many descriptors on the database as it ever
      # had connections open at once.
      #
      # No connection crosses a fork: the keeper closes before every fork
      # and opens again after it, in the parent and in the child, so each
      # forked worker holds its own (SPEC SK2).
      class Keeper
        # The statement the keeper runs once as it opens.
        OPEN_STATEMENT = "PRAGMA journal_mode"

        # @return [String, nil] database file the keeper holds open; nil
        #   before {#start} and after {#stop}.
        attr_reader :path

        # @return [SQLite3::Database, nil] the connection, nil while closed.
        attr_reader :connection

        # A stopped keeper: nothing is open until {#start}.
        def initialize
          @mutex = Mutex.new
          @path = nil
          @connection = nil
          @owner_pid = nil
        end

        # Open the keeper on +path+, closing a connection it already holds.
        #
        # @param path [String] database file.
        # @return [void]
        # @raise [SQLite3::Exception] when the database cannot be opened;
        #   the keeper stays closed.
        def start(path)
          @mutex.synchronize do
            close_connection
            @path = path
            open_connection
          end
        end

        # Close the connection and forget the path, so a later fork opens
        # nothing.
        #
        # @return [void]
        def stop
          @mutex.synchronize do
            @path = nil
            close_connection
          end
        end

        # @return [Boolean] whether this process holds a connection it opened.
        def open?
          @mutex.synchronize { open_here? }
        end

        # Close the connection before a fork and keep the path for
        # {#after_fork}, so the child inherits no open connection.
        #
        # @return [void]
        def before_fork
          @mutex.synchronize { close_connection }
        end

        # Open a new connection after a fork, in the parent and in the
        # child, unless the keeper is stopped. The fork has happened by then
        # and must not raise in either process, so a failure logs a warning
        # and leaves the keeper closed.
        #
        # @return [void]
        def after_fork
          @mutex.synchronize { open_connection if @path && !open_here? }
        rescue SQLite3::Exception => e
          PotatoMesh::Logging.log(
            PotatoMesh::Logging.logger_for,
            :warn,
            "Database keeper did not reopen after fork",
            context: "database.keeper",
            error_class: e.class.name,
            error_message: e.message,
          )
        end

        private

        # @return [Boolean] whether a connection opened by this process is
        #   held; one opened before a fork belongs to the parent.
        def open_here?
          !@connection.nil? && @owner_pid == Process.pid
        end

        # Open the connection on the keeper's path and run
        # {OPEN_STATEMENT} on it. The statement can wait for a lock, so
        # whatever ends it early, an error, a +Timeout+ or a killed thread,
        # closes the connection again, on this thread, before it propagates.
        #
        # @return [void]
        # @raise [Exception] what opening or the statement raised.
        def open_connection
          connection = SQLite3::Database.new(@path)
          opened = false
          begin
            connection.busy_handler_timeout = PotatoMesh::Config.db_busy_timeout_ms
            connection.execute(OPEN_STATEMENT)
            opened = true
          ensure
            connection.close unless opened
          end
          @connection = connection
          @owner_pid = Process.pid
        end

        # Close the connection, if one is held.
        #
        # @return [void]
        def close_connection
          connection = @connection
          @connection = nil
          @owner_pid = nil
          connection&.close
        end
      end

      # Prepended to the singleton class of +Process+, whose +_fork+ Ruby
      # calls for +Kernel#fork+, +Process.fork+ and +IO.popen("-")+, so a
      # forked Puma worker opens a keeper of its own (SPEC SK2).
      module KeeperForkHook
        # Close the keeper, fork, then open it again in the parent and in the
        # child.
        #
        # @return [Integer] the child's pid in the parent, 0 in the child.
        def _fork
          Database.keeper.before_fork
          super
        ensure
          Database.keeper.after_fork
        end
      end

      @keeper = Keeper.new

      class << self
        # @return [Keeper] this process's keeper.
        attr_reader :keeper
      end

      Process.singleton_class.prepend(KeeperForkHook)

      # Registered as the file loads, before the boot installs the
      # federation and retention hooks, so the keeper closes after them.
      at_exit { Database.keeper.stop }

      # Open this process's keeper on the application database (SPEC SK1).
      # The configure block calls this right after +ensure_schema_parity!+,
      # so the keeper first opens on the upgraded and checked schema.
      #
      # @return [void]
      # @raise [SQLite3::Exception] when the database cannot be opened.
      def start_database_keeper!
        Database.keeper.start(PotatoMesh::Config.db_path)
      end
    end
  end
end
