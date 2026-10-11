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
require "fileutils"

# Boot-time schema upgrades on release databases: the nodes.num index, a
# failing step that stops the boot, the parity check and the indexes the
# upgrade recreates, the steps upgraded databases lacked, and boots racing
# on one database (SPEC SU1-SU6).
RSpec.describe "schema upgrades" do
  # The database methods the configure block calls, outside any app.
  let(:boot) do
    Class.new do
      extend PotatoMesh::App::Database

      # No upgrade step logs since SU2; an older tree logged a swallowed
      # failure here, which these examples judge by the schema it left.
      #
      # @return [void]
      def self.warn_log(*, **); end
    end
  end

  let(:fixture_dir) { File.expand_path("fixtures/schema", __dir__) }
  let(:plan_on_num) { "SEARCH nodes USING INDEX idx_nodes_num (num=?)" }

  around do |example|
    Dir.mktmpdir("schema-upgrades-spec-") do |dir|
      RSpec::Mocks.with_temporary_scope do
        allow(PotatoMesh::Config).to receive(:db_path).and_return(File.join(dir, "mesh.db"))
        example.run
      end
    end
  end

  # Build the example's database from a release fixture.
  #
  # @param tag [String] release tag naming +spec/fixtures/schema/<tag>.sql+.
  # @return [void]
  def load_fixture(tag)
    db = SQLite3::Database.new(PotatoMesh::Config.db_path)
    db.execute_batch(File.read(File.join(fixture_dir, "#{tag}.sql")))
  ensure
    db&.close
  end

  # Run +block+ on a fresh handle on the example's database.
  #
  # @yieldparam db [SQLite3::Database] open handle, closed afterwards.
  # @return [Object] the block's result.
  def with_db
    db = SQLite3::Database.new(PotatoMesh::Config.db_path)
    db.busy_timeout = 5000
    yield db
  ensure
    db&.close
  end

  # @param table [String] table name.
  # @return [Array<String>] the table's column names.
  def columns(table)
    with_db { |db| db.execute("PRAGMA table_info(#{table})").map { |row| row[1] } }
  end

  # @return [Array<String>] every index name in the example's database.
  def indexes
    with_db { |db| db.execute("SELECT name FROM sqlite_master WHERE type='index'").flatten }
  end

  # @return [Integer] the database's +PRAGMA user_version+.
  def user_version
    with_db { |db| db.get_first_value("PRAGMA user_version").to_i }
  end

  # The configure block's first two steps: upgrade, then create the fresh
  # schema when a required table is still absent.
  #
  # @return [void]
  def upgrade!
    boot.ensure_schema_upgrades
    boot.init_db unless boot.db_schema_present?
  end

  # What +data/*.sql+ defines and the example's database lacks, worked out
  # here without the app's own check: +<table>.<column>+, +table <name>+ and
  # +index <name>+ entries.
  #
  # @return [Array<String>] the gaps, sorted.
  def schema_gaps
    fresh = SQLite3::Database.new(":memory:")
    Dir[File.expand_path("../../data/*.sql", __dir__)].each { |file| fresh.execute_batch(File.read(file)) }
    tables = fresh.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").flatten
    gaps = tables.flat_map do |table|
      have = columns(table)
      next ["table #{table}"] if have.empty?

      (fresh.execute("PRAGMA table_info(#{table})").map { |row| row[1] } - have).map { |column| "#{table}.#{column}" }
    end
    wanted = fresh.execute("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'").flatten
    (gaps + (wanted - indexes).map { |name| "index #{name}" }).sort
  ensure
    fresh&.close
  end

  # Every row of each table, holding only the given columns.
  #
  # @param columns_by_table [Hash{String => Array<String>}] columns to read.
  # @return [Hash{String => Array<Hash>}] rows in rowid order, per table.
  def snapshot(columns_by_table)
    with_db do |db|
      db.results_as_hash = true
      columns_by_table.to_h do |table, cols|
        [table, db.execute("SELECT #{cols.map { |col| %("#{col}") }.join(", ")} FROM #{table} ORDER BY rowid")]
      end
    end
  end

  # Hold the write lock in a second process, as a boot racing this one does:
  # BEGIN IMMEDIATE, run +sql+, report the lock held, wait +hold+ seconds,
  # then COMMIT. Returns once the lock is held.
  #
  # @param sql [String] statement the racing boot applies.
  # @param hold [Float] seconds the lock is held after +sql+.
  # @return [Integer] the child's pid, for +expect_clean_exit+.
  def racing_boot(sql, hold:)
    reader, writer = IO.pipe
    pid = fork do
      reader.close
      db = SQLite3::Database.new(PotatoMesh::Config.db_path)
      db.execute("BEGIN IMMEDIATE")
      db.execute(sql)
      writer.puts("locked")
      writer.flush
      sleep hold
      db.execute("COMMIT")
      db.close
      exit!(0)
    rescue StandardError
      exit!(1)
    end
    writer.close
    expect(reader.gets).to eq("locked\n")
    reader.close
    pid
  end

  # @param pid [Integer] a +racing_boot+ child.
  # @return [void]
  def expect_clean_exit(pid)
    _, status = Process.wait2(pid)
    expect(status.exitstatus).to eq(0)
  end

  # Make the upgrade's connection raise +error+ when it prepares the first
  # statement that starts with +prefix+, where SQLite reports a failure.
  # The module goes on before +ensure_schema_upgrades+ adds its own, so the
  # step is recorded first.
  #
  # @param prefix [String] start of the statement that fails.
  # @param error [SQLite3::Exception] exception to raise.
  # @return [void]
  def fail_step(prefix, error)
    failing = Module.new do
      define_method(:prepare) do |sql, &block|
        raise error if sql.lstrip.start_with?(prefix)

        super(sql, &block)
      end
    end
    allow(boot).to receive(:open_database).and_wrap_original do |original, *args, **kwargs|
      original.call(*args, **kwargs).extend(failing)
    end
  end

  # Point the fresh schema at a copy of +data/*.sql+ in which +file+ ends
  # with +sql+, as a schema change made without its upgrade step would.
  #
  # @param file [String] schema file name, such as +nodes.sql+.
  # @param sql [String] statements appended to the copy.
  # @return [void]
  def schema_files_with(file, sql)
    dir = File.join(File.dirname(PotatoMesh::Config.db_path), "schema-files")
    FileUtils.mkdir_p(dir)
    FileUtils.cp(Dir[File.expand_path("../../data/*.sql", __dir__)], dir)
    File.write(File.join(dir, file), "\n#{sql}\n", mode: "a")
    stub_const("PotatoMesh::App::Database::SCHEMA_DIRECTORY", dir)
  end

  # Make +db+ record each statement that reads +nodes+ through +execute+
  # or +get_first_value+, with its bind values, into +log+.
  #
  # @param db [SQLite3::Database] handle to record on.
  # @param log [Array<Array(String, Array)>] receives +[sql, binds]+ pairs.
  # @return [SQLite3::Database] +db+.
  def record_node_reads(db, log)
    %i[execute get_first_value].each do |name|
      original = db.method(name)
      db.define_singleton_method(name) do |sql, *binds, &blk|
        log << [sql, binds.flatten] if sql.include?("FROM nodes")
        original.call(sql, *binds, &blk)
      end
    end
    db
  end

  # @param db [SQLite3::Database] open handle.
  # @param sql [String] statement text.
  # @param binds [Array] bind values.
  # @return [Array<String>] the EXPLAIN QUERY PLAN detail lines.
  def plan(db, sql, binds)
    db.execute("EXPLAIN QUERY PLAN #{sql}", binds).map { |row| row[3] }
  end

  describe "the nodes.num index (SPEC SU1)" do
    # The three numeric lookups, as their call sites issue them, run on the
    # example's database, which holds the fixture's two Meshtastic nodes.
    #
    # @return [Array<Array(String, Array)>] the num lookups, with binds.
    def num_lookups
      reads = []
      handle = record_node_reads(SQLite3::Database.new(PotatoMesh::Config.db_path), reads)
      app = PotatoMesh::Application
      expect(app.node_lookup_clause("!a1b2c3d4", string_columns: ["node_id"], numeric_columns: ["num"], db: handle)).not_to be_nil
      expect(app.normalize_node_id(handle, "2712847316")).to eq("!a1b2c3d4")
      expect(app.batch_resolve_node_ids(handle, ["2712847316", "195936478"])).to include("195936478" => "!0badc0de")
      reads.select { |sql, _binds| sql.match?(/WHERE num (=|IN)/) }
    ensure
      handle&.close
    end

    it "searches idx_nodes_num for every numeric lookup on a fresh database" do
      boot.init_db
      with_db { |db| db.execute("INSERT INTO nodes(node_id, num) VALUES ('!a1b2c3d4', 2712847316), ('!0badc0de', 195936478)") }

      lookups = num_lookups

      expect(lookups.length).to eq(3)
      with_db { |db| lookups.each { |sql, binds| expect(plan(db, sql, binds)).to eq([plan_on_num]) } }
    end

    it "searches idx_nodes_num for every numeric lookup on an upgraded v0.7.0 database" do
      load_fixture("v0.7.0")
      upgrade!

      lookups = num_lookups

      expect(lookups.length).to eq(3)
      with_db { |db| lookups.each { |sql, binds| expect(plan(db, sql, binds)).to eq([plan_on_num]) } }
    end

    it "leaves the plans of the numeric opt-out subqueries unchanged" do
      boot.init_db
      now = Time.now.to_i
      with_db do |db|
        db.execute("INSERT INTO nodes(node_id, num) VALUES ('!a1b2c3d4', 2712847316), ('!0badc0de', 195936478)")
        db.execute("INSERT INTO traces(id, src, dest, rx_time, rx_iso) VALUES (1, 2712847316, 195936478, ?, 'now')", [now])
        db.execute("INSERT INTO trace_hops(trace_id, hop_index, node_id) VALUES (1, 0, 195936478)")
      end
      app = PotatoMesh::Application
      statements = []
      allow(app).to receive(:open_database).and_wrap_original do |original, *args, **kwargs|
        record_node_reads(original.call(*args, **kwargs), statements)
      end
      cutoffs = %w[hour day week month].to_h { |window| [window, now - 86_400] }

      # Public and private reads: the opt-out filters, then the
      # CLIENT_HIDDEN filters beside them.
      [false, true].each do |private_mode|
        allow(app).to receive(:private_mode?).and_return(private_mode)
        expect(app.query_traces(10, node_ref: "!a1b2c3d4").length).to eq(1)
        with_db do |db|
          db.results_as_hash = true
          expect(app.telemetry_activity_counts(record_node_reads(db, statements), cutoffs)).to include("total")
        end
      end

      subqueries = statements.select { |sql, _binds| sql.include?("SELECT num FROM nodes") }
      expect(subqueries.length).to eq(6)
      expect(subqueries.map(&:first).join).to include("role = 'CLIENT_HIDDEN'").and include("LIKE")
      with_db do |db|
        indexed = subqueries.map { |sql, binds| plan(db, sql, binds) }
        db.execute("DROP INDEX idx_nodes_num")
        expect(subqueries.map { |sql, binds| plan(db, sql, binds) }).to eq(indexed)
      end
    end

    it "ships a reference migration that creates the index" do
      load_fixture("v0.7.0")
      migration = File.expand_path("../../data/migrations/20261009_add_nodes_num_index.sql", __dir__)

      with_db { |db| db.execute_batch(File.read(migration)) }

      expect(indexes).to include("idx_nodes_num")
    end
  end

  describe "a failing upgrade step (SPEC SU2)" do
    it "fails the boot naming the step and leaves the schema as it was" do
      load_fixture("v0.7.0")
      fail_step("ALTER TABLE telemetry ADD COLUMN ch1_voltage", SQLite3::IOException.new("disk I/O error"))

      expect { boot.ensure_schema_upgrades }.to raise_error(
        StandardError,
        "Schema upgrade step failed: ALTER TABLE telemetry ADD COLUMN ch1_voltage REAL " \
        "(SQLite3::IOException: disk I/O error)",
      ) { |error| expect(error.class.name).to eq("PotatoMesh::App::SchemaUpgradeError") }
      # The steps before it rolled back with it.
      expect(columns("nodes")).not_to include("rssi", "identity_hash")
      expect(columns("messages")).not_to include("scope")
      expect(user_version).to eq(0)
    end

    it "names the database open when the connection cannot be made" do
      allow(boot).to receive(:open_database).and_raise(SQLite3::CantOpenException, "unable to open database file")

      expect { boot.ensure_schema_upgrades }.to raise_error(
        PotatoMesh::App::SchemaUpgradeError,
        "Schema upgrade step failed: opening the database (SQLite3::CantOpenException: unable to open database file)",
      )
    end

    it "names the BEGIN when a racing boot keeps the write lock past every retry" do
      load_fixture("v0.7.0")
      allow(PotatoMesh::Config).to receive(:db_busy_timeout_ms).and_return(20)
      allow(PotatoMesh::Config).to receive(:db_busy_max_retries).and_return(1)
      pid = racing_boot("SELECT 1", hold: 1.0)

      expect { boot.ensure_schema_upgrades }.to raise_error(
        PotatoMesh::App::SchemaUpgradeError,
        "Schema upgrade step failed: BEGIN IMMEDIATE (SQLite3::BusyException: database is locked)",
      )
      expect_clean_exit(pid)
    end
  end

  describe "the schema parity check (SPEC SU3)" do
    it "passes on a fresh database" do
      upgrade!

      expect { boot.ensure_schema_parity! }.not_to raise_error
    end

    it "fails naming every table, column and index the database lacks" do
      upgrade!
      with_db do |db|
        db.execute("DROP TABLE waypoints")
        db.execute("ALTER TABLE messages DROP COLUMN scope")
        db.execute("DROP INDEX idx_nodes_num")
      end

      expect { boot.ensure_schema_parity! }.to raise_error(PotatoMesh::App::SchemaUpgradeError) do |error|
        expect(error.message).to eq(
          "Database schema lacks what data/*.sql defines after the upgrade: messages.scope, table waypoints, " \
          "index idx_nodes_num, index idx_waypoints_rx_time, index idx_waypoints_node_id",
        )
      end
    end

    it "allows objects the fresh schema does not define and matches names in any case" do
      upgrade!
      with_db do |db|
        db.execute("ALTER TABLE messages ADD COLUMN raw_json TEXT")
        db.execute("CREATE INDEX idx_messages_raw_json ON messages(raw_json)")
        db.execute("ALTER TABLE messages RENAME COLUMN encrypted TO ENCRYPTED")
      end

      expect { boot.ensure_schema_parity! }.not_to raise_error
    end

    it "recreates on the next boot every index the operator dropped" do
      load_fixture("v0.7.0")
      upgrade!
      dropped = %w[idx_messages_rx_time idx_nodes_num idx_instances_domain]
      with_db { |db| dropped.each { |name| db.execute("DROP INDEX #{name}") } }

      upgrade!

      expect { boot.ensure_schema_parity! }.not_to raise_error
      expect(indexes).to include(*dropped)
    end

    it "leaves the indexes of a table lacking a column the upgrade cannot add to the check, which names them" do
      load_fixture("v0.7.0")
      # A schema change made without its upgrade step: a column and an index.
      schema_files_with(
        "nodes.sql",
        "ALTER TABLE nodes ADD COLUMN shoe_size INTEGER;\nCREATE INDEX IF NOT EXISTS idx_nodes_shoe_size ON nodes(shoe_size);",
      )

      expect { upgrade! }.not_to raise_error
      expect { boot.ensure_schema_parity! }.to raise_error(
        PotatoMesh::App::SchemaUpgradeError,
        "Database schema lacks what data/*.sql defines after the upgrade: nodes.shoe_size, " \
        "index idx_nodes_identity_hash, index idx_nodes_num, index idx_nodes_shoe_size",
      )
    end

    it "skips the indexes of a table the upgrade did not create" do
      upgrade!
      with_db do |db|
        db.execute("DROP TABLE waypoints")
        boot.create_missing_schema_indexes(db)
      end

      expect(indexes).not_to include("idx_waypoints_rx_time", "idx_waypoints_node_id")
    end

    it "lets a failed open stop the boot as it is" do
      allow(boot).to receive(:open_database).and_raise(SQLite3::CantOpenException, "unable to open database file")

      expect { boot.ensure_schema_parity! }.to raise_error(SQLite3::CantOpenException, "unable to open database file")
    end

    it "reads the fresh schema from every data/*.sql file" do
      shape = boot.fresh_schema_shape

      expect(shape[:tables].keys).to contain_exactly(
        "destinations", "ingestor_activity", "ingestors", "instances", "messages", "neighbors",
        "nodes", "positions", "telemetry", "traces", "trace_hops", "waypoints",
      )
      expect(shape[:tables]["nodes"]).to include("num", "identity_hash")
      expect(shape[:indexes].keys).to include("idx_nodes_num", "idx_nodes_identity_hash", "idx_messages_meshcore_text")
      expect(shape[:indexes].keys.grep(/\Asqlite_/)).to be_empty
      expect(shape[:indexes]["idx_nodes_num"]).to eq(table: "nodes", sql: "CREATE INDEX idx_nodes_num       ON nodes(num)")
    end
  end

  describe "steps upgraded databases lacked (SPEC SU4)" do
    let(:app) { Sinatra::Application }

    around do |example|
      token = ENV["API_TOKEN"]
      ENV["API_TOKEN"] = "schema-spec-token"
      example.run
    ensure
      ENV["API_TOKEN"] = token
    end

    it "adds messages.encrypted to a v0.2.0 database, so a message POST succeeds" do
      load_fixture("v0.2.0")

      upgrade!

      expect(columns("messages")).to include("encrypted")
      post "/api/messages",
           { "id" => 1003, "rx_time" => Time.now.to_i, "from_id" => "!a1b2c3d4", "to_id" => "^all", "channel" => 0,
             "portnum" => "TEXT_MESSAGE_APP", "text" => "after the upgrade", "ingestor" => "!0000beef",
             "protocol" => "meshtastic" }.to_json,
           { "CONTENT_TYPE" => "application/json", "HTTP_AUTHORIZATION" => "Bearer schema-spec-token" }
      expect(last_response.status).to eq(201)
      expect(with_db { |db| db.get_first_value("SELECT text FROM messages WHERE id = 1003") }).to eq("after the upgrade")
    end

    it "creates idx_nodes_identity_hash on an upgraded v0.7.0 database" do
      load_fixture("v0.7.0")

      upgrade!

      expect(indexes).to include("idx_nodes_identity_hash")
    end

    it "matches column names in any case, so a renamed column is not added again" do
      load_fixture("v0.7.0")
      upgrade!
      with_db do |db|
        db.execute("ALTER TABLE nodes RENAME COLUMN rssi TO RSSI")
        db.execute("ALTER TABLE messages RENAME COLUMN encrypted TO ENCRYPTED")
        db.execute("ALTER TABLE telemetry RENAME COLUMN ch1_voltage TO CH1_VOLTAGE")
      end

      expect { upgrade! }.not_to raise_error
      expect { boot.ensure_schema_parity! }.not_to raise_error
      expect(columns("nodes")).to include("RSSI")
      expect(columns("messages")).to include("ENCRYPTED")
      expect(columns("telemetry")).to include("CH1_VOLTAGE")
    end

    it "builds the MX6 index and runs the #756 purge on the boot that adds messages.protocol" do
      load_fixture("v0.4.0")
      expect(columns("messages")).not_to include("protocol")

      boot.ensure_schema_upgrades

      expect(indexes).to include("idx_messages_meshcore_text")
      expect(user_version).to eq(PotatoMesh::App::Database::MESHCORE_CONTENT_DEDUP_BACKFILL_VERSION)
    end
  end

  describe "boots racing on one database (SPEC SU5)" do
    it "waits for a racing boot's upgrade, then adds nothing twice" do
      load_fixture("v0.7.0")
      # The racing boot holds the lock with the first step this boot needs.
      pid = racing_boot("ALTER TABLE nodes ADD COLUMN rssi INTEGER", hold: 0.4)

      expect { boot.ensure_schema_upgrades }.not_to raise_error
      expect_clean_exit(pid)
      expect(columns("nodes").count("rssi")).to eq(1)
      expect(columns("telemetry")).to include("ch1_voltage", "one_wire_temperature")
      expect(indexes).to include("idx_nodes_num", "idx_nodes_identity_hash")
    end

    it "retries the write lock while a racing boot holds it past the busy timeout" do
      load_fixture("v0.7.0")
      allow(PotatoMesh::Config).to receive(:db_busy_timeout_ms).and_return(50)
      pid = racing_boot("ALTER TABLE nodes ADD COLUMN rssi INTEGER", hold: 0.3)

      expect { boot.ensure_schema_upgrades }.not_to raise_error
      expect_clean_exit(pid)
      expect(columns("telemetry")).to include("ch1_voltage")
    end

    it "retries the WAL switch while a racing boot holds a new database's write lock" do
      # A new file is in rollback-journal mode. Switching it to WAL takes the
      # write lock, and SQLite reports BUSY at once, without the busy timeout.
      pid = racing_boot("SELECT 1", hold: 0.2)

      expect { boot.ensure_schema_upgrades }.not_to raise_error
      expect_clean_exit(pid)
      expect(with_db { |db| db.get_first_value("PRAGMA journal_mode") }).to eq("wal")
      expect(with_db { |db| boot.missing_schema_objects(db) }).to be_empty
    end

    it "creates a new database's whole schema in its one transaction" do
      boot.ensure_schema_upgrades

      expect(boot.db_schema_present?).to be(true)
      expect(with_db { |db| boot.missing_schema_objects(db) }).to be_empty
      # The upgrade blocks still skip a new database's tables, as before.
      expect(user_version).to eq(0)
    end
  end

  describe "the upgrade connection (SPEC SU2, SU5)" do
    # @return [SQLite3::Database] a handle with the upgrade behaviour.
    def upgrade_connection
      SQLite3::Database.new(PotatoMesh::Config.db_path).extend(PotatoMesh::App::Database::UpgradeConnection)
    end

    it "labels the step by its first statement, without comments, on one line" do
      db = upgrade_connection
      db.execute_batch("-- a comment\nCREATE TABLE t(\n  a INTEGER  -- inline\n);\nCREATE TABLE u(b);")
      expect(db.upgrade_step_label).to eq("CREATE TABLE u(b)")

      db.prepare("-- a comment\nCREATE TABLE IF NOT EXISTS t(\n  a INTEGER  -- inline\n);").close
      expect(db.upgrade_step_label).to eq("CREATE TABLE IF NOT EXISTS t( a INTEGER )")
      db.prepare("-- header\n-- more\nSELECT a,\n       1\n  FROM t;\nSELECT 2").close
      expect(db.upgrade_step_label).to eq("SELECT a, 1 FROM t")
      db.prepare("SELECT '#{"x" * 300}'").close
      expect(db.upgrade_step_label).to eq("SELECT '#{"x" * 189}...")
      expect(db.upgrade_step_label.length).to eq(PotatoMesh::App::Database::UPGRADE_STEP_LABEL_LIMIT)
    ensure
      db&.close
    end

    it "has an empty label before the first statement" do
      db = SQLite3::Database.new(":memory:").extend(PotatoMesh::App::Database::UpgradeConnection)

      expect(db.upgrade_step_label).to eq("")
    ensure
      db&.close
    end

    it "runs a nested transaction block inside the upgrade's transaction" do
      db = upgrade_connection
      db.execute("CREATE TABLE t(a)")
      db.execute("BEGIN IMMEDIATE")

      expect(db.transaction { |handle| handle.execute("INSERT INTO t VALUES (1)") && :joined }).to eq(:joined)
      expect(db.transaction_active?).to be(true)
      db.execute("ROLLBACK")
      expect(db.get_first_value("SELECT COUNT(*) FROM t")).to eq(0)
    ensure
      db&.close
    end

    it "keeps the stock transaction outside a transaction" do
      db = upgrade_connection
      db.execute("CREATE TABLE t(a)")

      db.transaction { |handle| handle.execute("INSERT INTO t VALUES (1)") }
      expect(db.transaction_active?).to be(false)
      expect(db.transaction).to be(true)
      expect(db.transaction_active?).to be(true)
      db.rollback
      expect(db.get_first_value("SELECT COUNT(*) FROM t")).to eq(1)
    ensure
      db&.close
    end
  end

  describe "release databases (SPEC SU6)" do
    %w[v0.2.0 v0.4.0 v0.7.0].each do |tag|
      it "upgrades a #{tag} database to parity and keeps its rows" do
        load_fixture(tag)
        tables = with_db { |db| db.execute("SELECT name FROM sqlite_master WHERE type='table'").flatten }
        legacy_columns = tables.to_h { |table| [table, columns(table)] }
        before = snapshot(legacy_columns)
        expect(before.values.sum(&:length)).to be >= 4

        upgrade!

        expect(schema_gaps).to eq([])
        expect { boot.ensure_schema_parity! }.not_to raise_error
        expect(snapshot(legacy_columns)).to eq(before)
      end
    end
  end
end
