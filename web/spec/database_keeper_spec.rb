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

require "spec_helper"
require "sqlite3"
require "json"
require "rbconfig"
require "stringio"
require "timeout"
require "tmpdir"

# The keeper connection that holds the database open between requests and
# never crosses a fork, the WAL size limit, and the busy handler that sleeps
# without the GVL (SPEC SK1-SK4).
RSpec.describe "database keeper" do
  # The database methods the app calls, outside any app.
  let(:harness) { Class.new { extend PotatoMesh::App::Database } }
  let(:four_mib) { 4 * 1024 * 1024 }

  # @return [Float] seconds on the monotonic clock.
  def monotonic_now
    Process.clock_gettime(Process::CLOCK_MONOTONIC)
  end

  # @param path [String] database path.
  # @return [Integer, nil] size of the database's WAL file, nil when absent
  #   or empty.
  def wal_size(path)
    File.size?("#{path}-wal")
  end

  # Run the block in a temporary directory whose +mesh.db+ the app opens,
  # with +table t(v)+ created in WAL mode.
  #
  # @yieldparam path [String] the database path.
  # @return [void]
  def with_scratch_database
    Dir.mktmpdir("database-keeper-spec-", "/var/tmp") do |dir|
      path = File.join(dir, "mesh.db")
      SQLite3::Database.new(path) do |db|
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("CREATE TABLE t(v BLOB)")
      end
      RSpec::Mocks.with_temporary_scope do
        allow(PotatoMesh::Config).to receive(:db_path).and_return(path)
        yield path
      end
    end
  end

  # Insert one row through a connection +open_database+ opens, then close it.
  #
  # @param value [Object] value stored in +t.v+.
  # @return [void]
  def write_row(value = 1)
    db = harness.open_database
    db.execute("INSERT INTO t(v) VALUES (?)", [value])
  ensure
    db&.close
  end

  # @param path [String] database path.
  # @return [Integer] rows of +t+, read through a new connection.
  def row_count(path)
    SQLite3::Database.open(path, readonly: true) { |db| db.get_first_value("SELECT COUNT(*) FROM t") }
  end

  describe "the boot's keeper" do
    let(:app) { Sinatra::Application }
    let(:api_token) { "database-keeper-token" }
    let(:keeper) { PotatoMesh::App::Database.keeper }

    around do |example|
      original = ENV["API_TOKEN"]
      ENV["API_TOKEN"] = api_token
      example.run
    ensure
      original.nil? ? ENV.delete("API_TOKEN") : ENV["API_TOKEN"] = original
    end

    it "holds the application database open after the boot (SK1)" do
      expect(keeper.open?).to be(true)
      expect(keeper.path).to eq(PotatoMesh::Config.db_path)
    end

    it "keeps the WAL in place when a single-record POST closes its connection (SK1)" do
      message = { "id" => 7_310_001, "rx_time" => Time.now.to_i, "from_id" => "!7310a001", "to_id" => "^all",
                  "channel" => 0, "portnum" => "TEXT_MESSAGE_APP", "text" => "keeper" }
      post "/api/messages", message.to_json, { "CONTENT_TYPE" => "application/json", "HTTP_AUTHORIZATION" => "Bearer #{api_token}" }

      expect(last_response.status).to eq(201)
      # The request's connection was not the last one, so SQLite neither
      # checkpointed nor deleted the WAL as it closed.
      expect(wal_size(PotatoMesh::Config.db_path)).to be > 0
    end

    it "holds no read transaction: a TRUNCATE checkpoint beside it completes (SK1)" do
      expect(keeper.open?).to be(true)
      SQLite3::Database.new(PotatoMesh::Config.db_path) do |db|
        db.busy_timeout = 1_000
        expect(db.execute("PRAGMA wal_checkpoint(TRUNCATE)")).to eq([[0, 0, 0]])
      end
      expect(wal_size(PotatoMesh::Config.db_path)).to be_nil
    end

    it "opens after the schema parity check, and closed last at exit leaves no WAL (SK1)" do
      Dir.mktmpdir("database-keeper-boot-", "/var/tmp") do |dir|
        result = File.join(dir, "result.json")
        script = <<~RUBY
          require "json"
          web, out = ARGV
          require File.join(web, "lib/potato_mesh/application/database")
          order = []
          PotatoMesh::App::Database.prepend(Module.new do
            define_method(:ensure_schema_parity!) { |*args| super(*args).tap { order << "ensure_schema_parity!" } }
            define_method(:start_database_keeper!) { |*args| order << "start_database_keeper!"; super(*args) }
          end)
          require File.join(web, "lib/potato_mesh/application")
          keeper = PotatoMesh::App::Database.respond_to?(:keeper) ? PotatoMesh::App::Database.keeper : nil
          db = PotatoMesh::Application.open_database
          db.execute("INSERT INTO messages(id, rx_time, rx_iso, text) VALUES (1, 0, '1970-01-01T00:00:00Z', 'kept')")
          db.close
          File.write(out, JSON.generate(order: order, keeper_open: keeper&.open? || false,
                                        wal_after_write: File.size?(PotatoMesh::Config.db_path + "-wal").to_i,
                                        db_path: PotatoMesh::Config.db_path))
        RUBY
        env = { "XDG_DATA_HOME" => File.join(dir, "data"), "XDG_CONFIG_HOME" => File.join(dir, "config"),
                "RACK_ENV" => "test", "FEDERATION" => "0", "INSTANCE_DOMAIN" => "keeper.mesh.test" }
        web_root = File.expand_path("..", __dir__)
        status = system(env, RbConfig.ruby, "-e", script, web_root, result, out: File::NULL, err: File.join(dir, "boot.err"))
        expect(status).to be(true), File.read(File.join(dir, "boot.err"))

        child = JSON.parse(File.read(result))
        expect(child["order"]).to eq(%w[ensure_schema_parity! start_database_keeper!])
        expect(child["keeper_open"]).to be(true)
        expect(child["wal_after_write"]).to be > 0
        # The keeper closed last, at exit: it checkpointed the WAL into the
        # database file and deleted it.
        expect(File.exist?("#{child["db_path"]}-wal")).to be(false)
        SQLite3::Database.new(child["db_path"], readonly: true) do |db|
          expect(db.get_first_value("SELECT text FROM messages WHERE id = 1")).to eq("kept")
        end
      end
    end

    it "closes before a fork and opens a connection of its own in the child and again in the parent (SK2)" do
      before_fork = keeper.connection
      reader, writer = IO.pipe
      pid = fork do
        reader.close
        writer.write(JSON.generate(open: keeper.open?, own: !keeper.connection.equal?(before_fork),
                                   inherited_closed: before_fork.closed?))
        writer.close
        exit!(0)
      end
      writer.close
      child = JSON.parse(reader.read)
      reader.close
      Process.wait(pid)

      expect(child).to eq("open" => true, "own" => true, "inherited_closed" => true)
      expect(before_fork.closed?).to be(true)
      expect(keeper.open?).to be(true)
      expect(keeper.connection).not_to equal(before_fork)
    end
  end

  # Referenced lazily, so each example names a missing class on its own.
  describe "PotatoMesh::App::Database::Keeper" do
    subject(:keeper) { PotatoMesh::App::Database::Keeper.new }

    after { keeper.stop }

    it "holds the database open: the WAL outlives the connection that wrote it (SK1)" do
      with_scratch_database do |path|
        keeper.start(path)
        write_row
        expect(wal_size(path)).to be > 0
        expect(keeper.connection.readonly?).to be(false)
      end
    end

    it "closed last, checkpoints the WAL into the database file and deletes it (SK1)" do
      with_scratch_database do |path|
        keeper.start(path)
        write_row
        keeper.stop

        expect(File.exist?("#{path}-wal")).to be(false)
        expect(File.exist?("#{path}-shm")).to be(false)
        expect(row_count(path)).to eq(1)
        expect(keeper.open?).to be(false)
        expect(keeper.path).to be_nil
      end
    end

    it "holds no read transaction: a TRUNCATE checkpoint beside it completes (SK1)" do
      with_scratch_database do |path|
        keeper.start(path)
        write_row
        SQLite3::Database.new(path) do |db|
          expect(db.execute("PRAGMA wal_checkpoint(TRUNCATE)")).to eq([[0, 0, 0]])
        end
        expect(wal_size(path)).to be_nil
      end
    end

    it "keeps the descriptors of closed connections at their peak, reused by the next ones (SK1)" do
      skip "needs /proc/self/fd" unless File.directory?("/proc/self/fd")

      with_scratch_database do |path|
        descriptors = lambda do
          Dir.glob("/proc/self/fd/*").count { |fd| (File.readlink(fd) rescue nil) == path }
        end
        keeper.start(path)
        # While the keeper holds its lock, SQLite cannot close a closed
        # connection's descriptor without dropping that lock, so it keeps it
        # for the next connection opened with the same flags.
        Array.new(4) { harness.open_database }.each(&:close)
        100.times { write_row }

        expect(descriptors.call).to eq(5)
        keeper.stop
        expect(descriptors.call).to eq(0)
      end
    end

    it "starting again on another path closes the first connection (SK1)" do
      with_scratch_database do |path|
        keeper.start(path)
        first = keeper.connection
        other = File.join(File.dirname(path), "other.db")
        keeper.start(other)

        expect(first.closed?).to be(true)
        expect(keeper.path).to eq(other)
        expect(keeper.open?).to be(true)
      end
    end

    it "raises when the database cannot be opened and stays closed (SK1)" do
      expect { keeper.start("/nonexistent-potato-mesh-dir/mesh.db") }.to raise_error(SQLite3::CantOpenException)
      expect(keeper.open?).to be(false)
    end

    # Make every connection +SQLite3::Database.new+ opens run +statement+
    # instead of its first statement, and collect the connections.
    #
    # @param statement [Proc] stands in for +execute+.
    # @return [Array<SQLite3::Database>] the connections opened so far.
    def stub_first_statement(&statement)
      opened = []
      allow(SQLite3::Database).to receive(:new).and_wrap_original do |original, *args, **kwargs|
        original.call(*args, **kwargs).tap do |db|
          opened << db
          allow(db).to receive(:execute, &statement)
        end
      end
      opened
    end

    it "closes its connection when its first statement raises, whatever it raises (SK1)" do
      with_scratch_database do |path|
        [SQLite3::IOException.new("disk I/O error"), Timeout::Error.new("execution expired"), Interrupt.new].each do |error|
          opened = stub_first_statement { raise error }

          expect { keeper.start(path) }.to raise_error(error.class)
          expect(opened.map(&:closed?)).to eq([true])
          expect(keeper.open?).to be(false)
        end
      end
    end

    it "closes its connection when its thread is killed during the first statement (SK1)" do
      with_scratch_database do |path|
        reached = Queue.new
        opened = stub_first_statement do
          reached.push(true)
          sleep
        end
        starting = keeper
        starter = Thread.new { starting.start(path) }
        expect(reached.pop(timeout: 5)).to be(true)
        starter.kill
        starter.join

        expect(opened.map(&:closed?)).to eq([true])
        expect(keeper.open?).to be(false)
      ensure
        starter&.kill
        starter&.join
      end
    end

    it "reopens after a fork, and a stopped keeper stays closed (SK2)" do
      with_scratch_database do |path|
        keeper.start(path)
        first = keeper.connection
        keeper.before_fork
        expect(keeper.open?).to be(false)
        expect(first.closed?).to be(true)
        keeper.after_fork
        expect(keeper.open?).to be(true)
        expect(keeper.connection).not_to equal(first)

        keeper.stop
        keeper.before_fork
        keeper.after_fork
        expect(keeper.open?).to be(false)
      end
    end

    it "logs a reopen that fails after a fork and leaves the keeper closed (SK2)" do
      with_scratch_database do |path|
        keeper.start(path)
        keeper.before_fork
        allow(SQLite3::Database).to receive(:new).and_raise(SQLite3::CantOpenException, "unable to open database file")
        log = StringIO.new
        allow(PotatoMesh::Logging).to receive(:logger_for).and_return(PotatoMesh::Logging.build_logger(log))

        expect { keeper.after_fork }.not_to raise_error
        expect(keeper.open?).to be(false)
        expect(log.string).to include("context=database.keeper")
        expect(log.string).to include('error_class="SQLite3::CantOpenException"')
        expect(log.string).to include("Database keeper did not reopen after fork")
      end
    end

    it "reports a connection another process opened as not open (SK2)" do
      with_scratch_database do |path|
        keeper.start(path)
        allow(Process).to receive(:pid).and_return(Process.pid + 1)
        expect(keeper.open?).to be(false)
      end
    end
  end

  describe "the WAL size limit" do
    it "is 4 MiB (SK3)" do
      expect(PotatoMesh::Config.db_journal_size_limit_bytes).to eq(four_mib)
    end

    it "is set on every connection open_database opens (SK3)" do
      with_scratch_database do
        [false, true].each do |readonly|
          db = harness.open_database(readonly: readonly)
          expect(db.get_first_value("PRAGMA journal_size_limit")).to eq(four_mib)
        ensure
          db&.close
        end
      end
    end

    it "trims a WAL that grew past it back to it after the next checkpoint (SK3)" do
      with_scratch_database do |path|
        # A second connection keeps the database open, as the keeper does,
        # so no close deletes the WAL.
        holder = SQLite3::Database.new(path)
        holder.execute("PRAGMA journal_mode")
        # A reader inside a read transaction stops each checkpoint from
        # restarting the WAL, so the writes below grow it past the limit.
        reader = SQLite3::Database.new(path)
        statement = reader.prepare("SELECT COUNT(*) FROM t")
        statement.step
        80.times { write_row(SQLite3::Blob.new("w" * 100_000)) }
        expect(wal_size(path)).to be > 2 * four_mib
        statement.close
        reader.close

        # The first write checkpoints the whole WAL; the next restarts it and
        # trims the file to the limit.
        2.times { write_row }
        expect(wal_size(path)).to eq(four_mib)
      ensure
        statement&.close unless statement&.closed?
        reader&.close
        holder&.close
      end
    end
  end

  describe "the busy handler" do
    # Hold the write lock on a connection +open_database+ opens, in another
    # thread, and commit once +release+ is pushed or +hold+ seconds pass.
    #
    # @param hold [Float] longest time the lock is held, in seconds.
    # @param release [Queue] pushed to commit at once.
    # @return [Thread] the holding thread.
    def hold_write_lock(hold:, release: Queue.new)
      holder = harness.open_database
      holder.execute("BEGIN IMMEDIATE")
      holder.execute("INSERT INTO t(v) VALUES (0)")
      Thread.new do
        release.pop(timeout: hold)
        holder.execute("COMMIT")
      ensure
        holder.close
      end
    end

    it "lets the thread that holds the write lock commit while another waits for it (SK4)" do
      with_scratch_database do |path|
        holding = hold_write_lock(hold: 0.1)
        waiter = harness.open_database
        started = monotonic_now
        # The waiter sleeps between attempts without the GVL, so the holding
        # thread runs its COMMIT; busy_timeout= slept inside SQLite holding
        # it, and the waiter gave up after the whole 5 s timeout.
        waiter.execute("INSERT INTO t(v) VALUES (1)")
        waited = monotonic_now - started
        holding.join

        expect(waited).to be < 2.5
        expect(row_count(path)).to eq(2)
      ensure
        waiter&.close
        holding&.join
      end
    end

    it "gives up after db_busy_timeout_ms (SK4)" do
      with_scratch_database do
        allow(PotatoMesh::Config).to receive(:db_busy_timeout_ms).and_return(100)
        release = Queue.new
        holding = hold_write_lock(hold: 10, release: release)
        waiter = harness.open_database
        started = monotonic_now

        expect { waiter.execute("INSERT INTO t(v) VALUES (1)") }.to raise_error(SQLite3::BusyException)
        expect(monotonic_now - started).to be_between(0.1, 2.5)
      ensure
        release&.push(true)
        waiter&.close
        holding&.join
      end
    end

    it "lets an interrupt land during the wait, and the waiting thread keeps its connection (SK4)" do
      with_scratch_database do |path|
        release = Queue.new
        holding = hold_write_lock(hold: 10, release: release)
        waiter = harness.open_database
        started = monotonic_now

        # Inside the 5 s wait, not after it.
        expect { Timeout.timeout(0.2) { waiter.execute("INSERT INTO t(v) VALUES (1)") } }.to raise_error(Timeout::Error)
        expect(monotonic_now - started).to be < 2.5
        release.push(true)
        holding.join
        waiter.execute("INSERT INTO t(v) VALUES (2)")
        expect(row_count(path)).to eq(2)
      ensure
        release&.push(true)
        waiter&.close
        holding&.join
      end
    end

    it "is installed on read-only connections too, never busy_timeout= (SK4)" do
      with_scratch_database do
        calls = []
        allow_any_instance_of(SQLite3::Database).to receive(:busy_handler_timeout=).and_wrap_original do |original, ms|
          calls << [:busy_handler_timeout=, ms]
          original.call(ms)
        end
        allow_any_instance_of(SQLite3::Database).to receive(:busy_timeout=).and_wrap_original do |original, ms|
          calls << [:busy_timeout=, ms]
          original.call(ms)
        end

        harness.open_database(readonly: true).close
        harness.open_database.close
        expect(calls).to eq([[:busy_handler_timeout=, 5_000], [:busy_handler_timeout=, 5_000]])
      end
    end
  end
end
