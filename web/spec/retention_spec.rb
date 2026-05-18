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

    it "logs and recovers from unexpected SQLite errors" do
      # Force a transient SQLite error by closing the database file mid-call.
      allow(harness_class).to receive(:open_database).and_raise(SQLite3::Exception, "boom")

      expect(harness_class.purge_old_data!(now: now)).to eq({})

      failure = harness_class.log_events.find { |e| e[:level] == :warn }
      expect(failure).not_to be_nil
      expect(failure[:context]).to eq("retention.purge")
    end
  end

  describe ".retention_sleep_with_shutdown" do
    it "returns true when the full duration elapses" do
      result = harness_class.retention_sleep_with_shutdown(0.0)
      expect(result).to be(true)
    end

    it "returns false immediately when shutdown is already requested" do
      allow(harness_class).to receive(:retention_shutdown_requested?).and_return(true)
      result = harness_class.retention_sleep_with_shutdown(5.0)
      expect(result).to be(false)
    end
  end

  describe ".retention_shutdown_requested?" do
    it "returns false when settings are not available" do
      expect(harness_class.retention_shutdown_requested?).to be(false)
    end
  end

  describe ".retention_worker_active?" do
    it "is false in the RACK_ENV=test environment" do
      original = ENV["RACK_ENV"]
      ENV["RACK_ENV"] = "test"
      begin
        expect(harness_class.retention_worker_active?).to be(false)
      ensure
        ENV["RACK_ENV"] = original
      end
    end

    it "is true outside the test environment" do
      original = ENV["RACK_ENV"]
      ENV["RACK_ENV"] = "production"
      begin
        expect(harness_class.retention_worker_active?).to be(true)
      ensure
        ENV["RACK_ENV"] = original
      end
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

    it "continues iterating when purge_old_data! raises" do
      call_count = 0
      allow(harness_class).to receive(:retention_sleep_with_shutdown) do |_seconds|
        call_count += 1
        call_count == 1
      end
      allow(harness_class).to receive(:purge_old_data!).and_raise(StandardError, "boom")

      # Should not propagate the exception to the caller — the worker
      # captures it and continues to the sleep step (which signals exit).
      expect { harness_class.retention_thread_loop }.not_to raise_error

      warning = harness_class.log_events.find do |entry|
        entry[:level] == :warn && entry[:context] == "retention.worker"
      end
      expect(warning).not_to be_nil
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
end
