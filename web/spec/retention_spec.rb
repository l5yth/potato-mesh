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

# Specs covering the 365-day data retention purge implemented in
# +PotatoMesh::App::Retention+.  The module is wired into the running
# Sinatra application; the tests below mix it into a bare host class so
# the retention behaviour can be exercised without spinning up the full
# web stack.
RSpec.describe PotatoMesh::App::Retention do
  let(:harness_class) do
    Class.new do
      extend PotatoMesh::App::Retention
      extend PotatoMesh::App::Database
      extend PotatoMesh::App::Helpers

      class << self
        # Provide read-write database connections so the retention purge can
        # execute its DELETE statements.
        def open_database(readonly: false)
          db = SQLite3::Database.new(PotatoMesh::Config.db_path, readonly: readonly)
          db.busy_timeout = PotatoMesh::Config.db_busy_timeout_ms
          db.execute("PRAGMA foreign_keys = ON")
          db
        end

        # Capture debug/warn log entries so tests can inspect what the
        # retention worker reported.
        attr_reader :log_events

        def warn_log(message, context:, **metadata)
          (@log_events ||= []) << {
            level: :warn, message: message, context: context, metadata: metadata,
          }
        end

        def info_log(message, context:, **metadata)
          (@log_events ||= []) << {
            level: :info, message: message, context: context, metadata: metadata,
          }
        end

        def debug_log(message, context:, **metadata)
          (@log_events ||= []) << {
            level: :debug, message: message, context: context, metadata: metadata,
          }
        end

        def reset_logs!
          @log_events = []
        end
      end
    end
  end

  let(:now) { Time.now.to_i }

  around do |example|
    Dir.mktmpdir("retention-spec-") do |dir|
      db_path = File.join(dir, "mesh.db")

      RSpec::Mocks.with_temporary_scope do
        allow(PotatoMesh::Config).to receive(:db_path).and_return(db_path)
        allow(PotatoMesh::Config).to receive(:db_busy_timeout_ms).and_return(5000)

        harness_class.init_db
        harness_class.ensure_schema_upgrades
        harness_class.reset_logs!

        example.run
      end
    end
  end

  # Helper to insert a fresh row plus a stale row into each retention target.
  # +ages+ map column → seconds-old-relative-to-+now+.
  def seed_retention_dataset(now_ts)
    db = SQLite3::Database.new(PotatoMesh::Config.db_path)
    db.execute("PRAGMA foreign_keys = ON")

    fresh = now_ts - 100
    stale = now_ts - PotatoMesh::Config.year_seconds - 86_400 # 1 day past the cutoff

    db.execute(
      "INSERT INTO nodes(node_id, num, short_name, long_name, last_heard, first_heard, role) VALUES (?,?,?,?,?,?,?)",
      ["!fffff001", 0xfffff001, "FR", "Fresh Node", fresh, fresh, "CLIENT"],
    )
    db.execute(
      "INSERT INTO nodes(node_id, num, short_name, long_name, last_heard, first_heard, role) VALUES (?,?,?,?,?,?,?)",
      ["!aaaaa001", 0xaaaaa001, "ST", "Stale Node", stale, stale, "CLIENT"],
    )

    db.execute(
      "INSERT INTO messages(id, rx_time, rx_iso, from_id, to_id, text) VALUES (?,?,?,?,?,?)",
      [1, fresh, Time.at(fresh).utc.iso8601, "!fffff001", "!ffffffff", "fresh"],
    )
    db.execute(
      "INSERT INTO messages(id, rx_time, rx_iso, from_id, to_id, text) VALUES (?,?,?,?,?,?)",
      [2, stale, Time.at(stale).utc.iso8601, "!fffff001", "!ffffffff", "stale"],
    )

    db.execute(
      "INSERT INTO positions(id, rx_time, rx_iso, node_id, latitude, longitude) VALUES (?,?,?,?,?,?)",
      [1, fresh, Time.at(fresh).utc.iso8601, "!fffff001", 52.0, 13.0],
    )
    db.execute(
      "INSERT INTO positions(id, rx_time, rx_iso, node_id, latitude, longitude) VALUES (?,?,?,?,?,?)",
      [2, stale, Time.at(stale).utc.iso8601, "!fffff001", 53.0, 14.0],
    )

    db.execute(
      "INSERT INTO telemetry(id, rx_time, rx_iso, node_id, telemetry_type) VALUES (?,?,?,?,?)",
      [1, fresh, Time.at(fresh).utc.iso8601, "!fffff001", "device"],
    )
    db.execute(
      "INSERT INTO telemetry(id, rx_time, rx_iso, node_id, telemetry_type) VALUES (?,?,?,?,?)",
      [2, stale, Time.at(stale).utc.iso8601, "!fffff001", "device"],
    )

    db.execute(
      "INSERT INTO neighbors(node_id, neighbor_id, snr, rx_time) VALUES (?,?,?,?)",
      ["!fffff001", "!aaaaa001", 4.0, fresh],
    )

    db.execute(
      "INSERT INTO traces(id, rx_time, rx_iso, src, dest) VALUES (?,?,?,?,?)",
      [1, fresh, Time.at(fresh).utc.iso8601, 0xaaaaaaaa, 0xbbbbbbbb],
    )
    db.execute(
      "INSERT INTO traces(id, rx_time, rx_iso, src, dest) VALUES (?,?,?,?,?)",
      [2, stale, Time.at(stale).utc.iso8601, 0xaaaaaaaa, 0xbbbbbbbb],
    )
    db.execute(
      "INSERT INTO trace_hops(trace_id, hop_index, node_id) VALUES (?,?,?)",
      [2, 0, 0xcccccccc],
    )

    db.execute(
      "INSERT INTO ingestors(node_id, start_time, last_seen_time, version) VALUES (?,?,?,?)",
      ["!fffff001", fresh, fresh, "1.0"],
    )
    db.execute(
      "INSERT INTO ingestors(node_id, start_time, last_seen_time, version) VALUES (?,?,?,?)",
      ["!aaaaa001", stale, stale, "1.0"],
    )
  ensure
    db&.close
  end

  describe ".purge_old_data!" do
    it "removes rows older than 365 days from every retention target" do
      seed_retention_dataset(now)
      removed = harness_class.purge_old_data!(now: now)

      db = SQLite3::Database.new(PotatoMesh::Config.db_path)
      begin
        node_ids = db.execute("SELECT node_id FROM nodes ORDER BY node_id").flatten
        expect(node_ids).to include("!fffff001")
        expect(node_ids).not_to include("!aaaaa001")

        msg_ids = db.execute("SELECT id FROM messages ORDER BY id").flatten
        expect(msg_ids).to eq([1])

        pos_ids = db.execute("SELECT id FROM positions ORDER BY id").flatten
        expect(pos_ids).to eq([1])

        tel_ids = db.execute("SELECT id FROM telemetry ORDER BY id").flatten
        expect(tel_ids).to eq([1])

        trace_ids = db.execute("SELECT id FROM traces ORDER BY id").flatten
        expect(trace_ids).to eq([1])

        # Cascading DELETE on traces removes the dependent trace_hops row.
        hop_count = db.get_first_value("SELECT COUNT(*) FROM trace_hops")
        expect(hop_count).to eq(0)

        ingestor_ids = db.execute("SELECT node_id FROM ingestors ORDER BY node_id").flatten
        expect(ingestor_ids).to eq(["!fffff001"])

        # Cascading DELETE on nodes removes the neighbour relationship that
        # referenced the deleted stale node.
        neighbor_count = db.get_first_value("SELECT COUNT(*) FROM neighbors")
        expect(neighbor_count).to eq(0)
      ensure
        db&.close
      end

      expect(removed["nodes"]).to eq(1)
      expect(removed["messages"]).to eq(1)
      expect(removed["positions"]).to eq(1)
      expect(removed["telemetry"]).to eq(1)
      expect(removed["traces"]).to eq(1)
      expect(removed["ingestors"]).to eq(1)
    end

    it "keeps every row when the database is empty" do
      removed = harness_class.purge_old_data!(now: now)
      expect(removed.values.uniq).to eq([0])
    end

    it "logs the successful purge at info level" do
      # Promoted from debug so retention activity is visible at the default
      # log verbosity; specs lock the level in so a future refactor cannot
      # silently demote it.
      harness_class.purge_old_data!(now: now)
      entry = harness_class.log_events.find do |e|
        e[:context] == "retention.purge" && e[:level] == :info
      end
      expect(entry).not_to be_nil
    end

    it "logs and recovers from unexpected SQLite errors" do
      # Force a transient SQLite error by closing the database file mid-call.
      allow(harness_class).to receive(:open_database).and_raise(SQLite3::Exception, "boom")

      expect(harness_class.purge_old_data!(now: now)).to eq({})

      failure = harness_class.log_events.find { |e| e[:level] == :warn }
      expect(failure).not_to be_nil
      expect(failure[:context]).to eq("retention.purge")
    end

    it "leaves rows with NULL retention timestamps untouched" do
      # A node whose last_heard is NULL has no activity timestamp at all,
      # so the purge cannot prove it is older than the cutoff and must
      # leave it alone.  The +IS NOT NULL+ guard in the DELETE protects
      # against accidentally wiping every such row.
      db = SQLite3::Database.new(PotatoMesh::Config.db_path)
      begin
        db.execute(
          "INSERT INTO nodes(node_id, num, short_name, long_name, first_heard, role) VALUES (?,?,?,?,?,?)",
          ["!nullnode", 0xdeadbeef, "NN", "Null Node", now - 100, "CLIENT"],
        )
      ensure
        db.close
      end

      harness_class.purge_old_data!(now: now)

      db = SQLite3::Database.new(PotatoMesh::Config.db_path, readonly: true)
      begin
        expect(db.execute("SELECT node_id FROM nodes").flatten).to include("!nullnode")
      ensure
        db.close
      end
    end
  end

  describe ".retention_sleep_with_shutdown" do
    it "returns true after slicing through the requested duration" do
      slept = []
      allow(Kernel).to receive(:sleep) { |seconds| slept << seconds }

      # 0.5 s with 0.2 s slices means three iterations: 0.2, 0.2, 0.1.
      result = harness_class.retention_sleep_with_shutdown(0.5)

      expect(result).to be(true)
      expect(slept.sum).to be_within(1e-9).of(0.5)
      expect(slept).to all(be <= 0.2 + 1e-9)
      expect(slept.length).to be >= 2
    end

    it "returns true immediately when the duration is non-positive" do
      expect(Kernel).not_to receive(:sleep)
      expect(harness_class.retention_sleep_with_shutdown(0.0)).to be(true)
    end

    it "returns false immediately when shutdown is already requested" do
      allow(harness_class).to receive(:retention_shutdown_requested?).and_return(true)
      result = harness_class.retention_sleep_with_shutdown(5.0)
      expect(result).to be(false)
    end

    it "bails out mid-sleep when shutdown is requested between slices" do
      slept = []
      allow(Kernel).to receive(:sleep) { |seconds| slept << seconds }
      call_count = 0
      allow(harness_class).to receive(:retention_shutdown_requested?) do
        call_count += 1
        call_count > 2 # first two checks: keep sleeping; then shutdown.
      end

      result = harness_class.retention_sleep_with_shutdown(5.0)

      expect(result).to be(false)
      # Should not have slept the entire 5 s — the loop terminates early.
      expect(slept.sum).to be < 1.0
    end
  end

  describe ".retention_shutdown_requested?" do
    it "returns false when settings are not available" do
      expect(harness_class.retention_shutdown_requested?).to be(false)
    end
  end

  describe ".retention_thread_loop" do
    it "exits without purging when shutdown is requested during the initial delay" do
      allow(harness_class).to receive(:retention_sleep_with_shutdown).and_return(false)
      expect(harness_class).not_to receive(:purge_old_data!)

      harness_class.retention_thread_loop
    end

    it "purges once and exits when the post-iteration sleep is interrupted" do
      call_count = 0
      allow(harness_class).to receive(:retention_sleep_with_shutdown) do |_seconds|
        call_count += 1
        call_count == 1 # only the initial delay returns true; the next sleep
                        # signals shutdown and the loop must terminate.
      end
      expect(harness_class).to receive(:purge_old_data!).once.and_return({})

      harness_class.retention_thread_loop
    end

    it "tolerates purge_old_data! returning an empty hash on error" do
      # purge_old_data! handles its own errors and returns {} — the loop
      # should treat that as a normal outcome and proceed to the sleep step.
      call_count = 0
      allow(harness_class).to receive(:retention_sleep_with_shutdown) do |_seconds|
        call_count += 1
        call_count == 1
      end
      expect(harness_class).to receive(:purge_old_data!).once.and_return({})

      expect { harness_class.retention_thread_loop }.not_to raise_error
    end
  end

  describe ".purge_old_data! return shape" do
    it "produces an integer entry for every retention target" do
      removed = harness_class.purge_old_data!(now: now)
      described_class::RETENTION_TARGETS.each do |(table, _column)|
        expect(removed).to have_key(table)
        expect(removed[table]).to be_a(Integer)
      end
    end
  end

  # ---------------------------------------------------------------------------
  # Shutdown plumbing — exercised with a Sinatra-shaped settings double so the
  # respond_to? branches inside the retention module are followed end-to-end.
  # ---------------------------------------------------------------------------
  describe "shutdown lifecycle helpers" do
    # A Sinatra-shaped settings double exposing every attribute the retention
    # module's respond_to? checks look up.
    settings_struct = Struct.new(
      :retention_thread,
      :retention_shutdown_requested,
      :retention_shutdown_hook_installed,
    )

    let(:host_class) do
      stx = settings_struct
      klass = Class.new do
        extend PotatoMesh::App::Retention
      end
      klass.define_singleton_method(:settings) do
        @settings ||= stx.new
      end
      klass.define_singleton_method(:set) do |key, value|
        writer = "#{key}="
        raise ArgumentError, "unsupported setting #{key}" unless settings.respond_to?(writer)
        settings.public_send(writer, value)
      end
      klass.define_singleton_method(:debug_log) { |*| }
      klass.define_singleton_method(:warn_log) { |*| }
      klass
    end

    describe ".start_retention_thread!" do
      it "spawns a worker, stores it on settings, and returns the thread" do
        # Replace the loop body with a brief sleep so the thread exits quickly
        # rather than entering the real production loop.
        allow(host_class).to receive(:retention_thread_loop) { sleep(0.01) }
        allow(host_class).to receive(:ensure_retention_shutdown_hook!)

        thread = host_class.start_retention_thread!

        expect(thread).to be_a(Thread)
        expect(host_class.settings.retention_thread).to be(thread)
        thread.join(1)
      end

      it "returns the existing thread when one is still alive" do
        allow(host_class).to receive(:ensure_retention_shutdown_hook!)
        # An infinite sleep stands in for a long-lived worker.
        existing = Thread.new { sleep }
        host_class.settings.retention_shutdown_requested = false
        host_class.set(:retention_thread, existing)

        result = host_class.start_retention_thread!

        expect(result).to be(existing)
      ensure
        existing&.kill
        existing&.join(0.1)
      end
    end

    describe ".retention_shutdown_requested?" do
      it "is false when no shutdown has been requested" do
        host_class.settings.retention_shutdown_requested = nil
        expect(host_class.retention_shutdown_requested?).to be(false)
      end

      it "is true once a shutdown has been requested" do
        host_class.settings.retention_shutdown_requested = true
        expect(host_class.retention_shutdown_requested?).to be(true)
      end

      it "is false when settings lack the shutdown attribute" do
        bare = Class.new { extend PotatoMesh::App::Retention }
        bare_struct = Struct.new(:other)
        bare.define_singleton_method(:settings) { @settings ||= bare_struct.new }
        expect(bare.retention_shutdown_requested?).to be(false)
      end
    end

    describe ".request_retention_shutdown! / .clear_retention_shutdown_request!" do
      it "flips the settings flag on and off" do
        host_class.request_retention_shutdown!
        expect(host_class.settings.retention_shutdown_requested).to be(true)
        host_class.clear_retention_shutdown_request!
        expect(host_class.settings.retention_shutdown_requested).to be(false)
      end
    end

    describe ".shutdown_retention_thread!" do
      it "is a no-op when no thread has been registered" do
        host_class.set(:retention_thread, nil)
        expect { host_class.shutdown_retention_thread!(timeout: 0.05) }.not_to raise_error
      end

      it "wakes and joins a sleeping worker thread" do
        thread = Thread.new { sleep }
        host_class.set(:retention_thread, thread)

        host_class.shutdown_retention_thread!(timeout: 0.5)

        expect(thread).not_to be_alive
        expect(host_class.settings.retention_thread).to be_nil
      end

      it "swallows ThreadError when wakeup raises" do
        thread = Thread.new { sleep }
        # Force wakeup to raise — the rescue inside shutdown_retention_thread!
        # must swallow it and still join the thread.
        allow(thread).to receive(:wakeup).and_raise(ThreadError, "dead"); allow(thread).to receive(:respond_to?).and_call_original
        host_class.set(:retention_thread, thread)

        expect { host_class.shutdown_retention_thread!(timeout: 0.5) }.not_to raise_error
      ensure
        thread&.kill
        thread&.join(0.1)
      end

      it "force-kills the worker when join times out" do
        # A purely CPU-bound thread won't respond to wakeup, so join(timeout)
        # will time out and the kill branch must take over.
        thread = Thread.new { loop { } }
        host_class.set(:retention_thread, thread)

        host_class.shutdown_retention_thread!(timeout: 0.05)

        expect(thread).not_to be_alive
      end
    end

    describe ".ensure_retention_shutdown_hook!" do
      it "installs the hook exactly once when settings carry the flag" do
        # First call flips the flag; second call returns early.
        expect(host_class).to receive(:at_exit).once
        host_class.ensure_retention_shutdown_hook!
        host_class.ensure_retention_shutdown_hook!
        expect(host_class.settings.retention_shutdown_hook_installed).to be(true)
      end

      it "delegates instance invocations to the host class" do
        allow(host_class).to receive(:at_exit)
        host_class.ensure_retention_shutdown_hook!
        instance = host_class.new
        # No raise — the instance entry-point should redirect to the class.
        expect { instance.ensure_retention_shutdown_hook! }.not_to raise_error
      end

      it "falls back to an instance variable when settings lack the flag" do
        # Build a class whose settings double has no
        # retention_shutdown_hook_installed accessor, exercising the ivar
        # branch in ensure_retention_shutdown_hook!.
        bare_settings = Struct.new(:retention_thread)
        bare = Class.new { extend PotatoMesh::App::Retention }
        bare.define_singleton_method(:settings) { @settings ||= bare_settings.new }
        bare.define_singleton_method(:set) { |*| }
        bare.define_singleton_method(:shutdown_retention_thread!) { |*| }
        allow(bare).to receive(:at_exit)

        bare.ensure_retention_shutdown_hook!
        bare.ensure_retention_shutdown_hook!

        expect(bare.instance_variable_get(:@retention_shutdown_hook_installed)).to be(true)
      end

      it "registers an at_exit hook that calls shutdown_retention_thread!" do
        captured = nil
        allow(host_class).to receive(:at_exit) { |&block| captured = block }
        host_class.ensure_retention_shutdown_hook!
        expect(captured).not_to be_nil

        expect(host_class).to receive(:shutdown_retention_thread!)
        captured.call
      end

      it "swallows errors raised by shutdown_retention_thread! in the at_exit hook" do
        captured = nil
        allow(host_class).to receive(:at_exit) { |&block| captured = block }
        host_class.ensure_retention_shutdown_hook!

        allow(host_class).to receive(:shutdown_retention_thread!).and_raise(StandardError, "boom")
        expect { captured.call }.not_to raise_error
      end
    end
  end

  # ---------------------------------------------------------------------------
  # retention_worker_active? also has a host-class branch that prefers the
  # local +test_environment?+ helper.  Exercise it to lock in that fallback.
  # ---------------------------------------------------------------------------
  describe ".start_retention_worker_if_active!" do
    it "spawns the worker when retention_worker_active? is true" do
      klass = Class.new { extend PotatoMesh::App::Retention }
      klass.define_singleton_method(:retention_worker_active?) { true }
      klass.define_singleton_method(:clear_retention_shutdown_request!) { }
      klass.define_singleton_method(:debug_log) { |*| }
      sentinel = Object.new
      allow(klass).to receive(:start_retention_thread!).and_return(sentinel)

      expect(klass.start_retention_worker_if_active!).to be(sentinel)
    end

    it "skips the worker and logs a debug message when inactive" do
      klass = Class.new { extend PotatoMesh::App::Retention }
      klass.define_singleton_method(:retention_worker_active?) { false }
      klass.define_singleton_method(:clear_retention_shutdown_request!) { }
      captured = []
      klass.define_singleton_method(:debug_log) do |message, **metadata|
        captured << [message, metadata]
      end
      expect(klass).not_to receive(:start_retention_thread!)

      expect(klass.start_retention_worker_if_active!).to be_nil
      expect(captured.first.first).to eq("Retention worker disabled")
    end
  end

  describe ".retention_worker_active?" do
    # The retention module relies on the Helpers#test_environment? predicate,
    # which is included into Object at boot time.  Both branches are
    # exercised by toggling RACK_ENV.
    let(:host) { Class.new { extend PotatoMesh::App::Retention } }

    around do |example|
      original = ENV["RACK_ENV"]
      example.run
    ensure
      ENV["RACK_ENV"] = original
    end

    it "returns false when RACK_ENV is test" do
      ENV["RACK_ENV"] = "test"
      expect(host.retention_worker_active?).to be(false)
    end

    it "returns true when RACK_ENV is anything else" do
      ENV["RACK_ENV"] = "production"
      expect(host.retention_worker_active?).to be(true)
    end
  end
end
