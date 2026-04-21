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

RSpec.describe PotatoMesh::App::Database do
  let(:harness_class) do
    Class.new do
      extend PotatoMesh::App::Database
      extend PotatoMesh::App::Helpers

      class << self
        attr_reader :warnings

        # Capture warning log entries generated during migrations for
        # inspection within the unit tests.
        #
        # @param message [String] warning message text.
        # @param context [String] logical source of the log entry.
        # @param metadata [Hash] structured metadata supplied by the caller.
        # @return [void]
        def warn_log(message, context:, **metadata)
          @warnings ||= []
          @warnings << { message: message, context: context, metadata: metadata }
        end

        # Capture debug log entries generated during migrations for
        # completeness of the helper interface.
        #
        # @param message [String] debug message text.
        # @param context [String] logical source of the log entry.
        # @param metadata [Hash] structured metadata supplied by the caller.
        # @return [void]
        def debug_log(message, context:, **metadata)
          @debug_entries ||= []
          @debug_entries << { message: message, context: context, metadata: metadata }
        end

        # Reset captured log entries between test examples.
        #
        # @return [void]
        def reset_logs!
          @warnings = []
          @debug_entries = []
        end
      end
    end
  end

  around do |example|
    harness_class.reset_logs!

    Dir.mktmpdir("db-upgrade-spec-") do |dir|
      db_path = File.join(dir, "mesh.db")

      RSpec::Mocks.with_temporary_scope do
        allow(PotatoMesh::Config).to receive(:db_path).and_return(db_path)
        allow(PotatoMesh::Config).to receive(:default_db_path).and_return(db_path)
        allow(PotatoMesh::Config).to receive(:legacy_db_path).and_return(db_path)

        example.run
      end
    end
  ensure
    harness_class.reset_logs!
  end

  # Retrieve column names for the requested table within the temporary
  # database used for upgrade tests.
  #
  # @param table [String] table name whose columns should be returned.
  # @return [Array<String>] names of the columns defined on +table+.
  def column_names_for(table)
    db = SQLite3::Database.new(PotatoMesh::Config.db_path, readonly: true)
    db.execute("PRAGMA table_info(#{table})").map { |row| row[1] }
  ensure
    db&.close
  end

  it "adds missing telemetry columns when upgrading an existing schema" do
    SQLite3::Database.new(PotatoMesh::Config.db_path) do |db|
      db.execute("CREATE TABLE nodes(node_id TEXT)")
      db.execute("CREATE TABLE messages(id INTEGER PRIMARY KEY)")
      db.execute <<~SQL
                   CREATE TABLE telemetry (
                     id INTEGER PRIMARY KEY,
                     node_id TEXT,
                     node_num INTEGER,
                     from_id TEXT,
                     to_id TEXT,
                     rx_time INTEGER NOT NULL,
                     rx_iso TEXT NOT NULL,
                     telemetry_time INTEGER,
                     channel INTEGER,
                     portnum TEXT,
                     hop_limit INTEGER,
                     snr REAL,
                     rssi INTEGER,
                     bitfield INTEGER,
                     payload_b64 TEXT,
                     battery_level REAL,
                     voltage REAL,
                     channel_utilization REAL,
                     air_util_tx REAL,
                     uptime_seconds INTEGER,
                     temperature REAL,
                     relative_humidity REAL,
                     barometric_pressure REAL
                   )
                 SQL
    end

    harness_class.ensure_schema_upgrades

    telemetry_columns = column_names_for("telemetry")
    expect(telemetry_columns).to include(
      "gas_resistance",
      "current",
      "iaq",
      "distance",
      "lux",
      "white_lux",
      "ir_lux",
      "uv_lux",
      "wind_direction",
      "wind_speed",
      "weight",
      "wind_gust",
      "wind_lull",
      "radiation",
      "rainfall_1h",
      "rainfall_24h",
      "soil_moisture",
      "soil_temperature",
    )

    expect { harness_class.ensure_schema_upgrades }.not_to raise_error
  end

  it "initialises the telemetry table when it is missing" do
    SQLite3::Database.new(PotatoMesh::Config.db_path) do |db|
      db.execute("CREATE TABLE nodes(node_id TEXT)")
      db.execute("CREATE TABLE messages(id INTEGER PRIMARY KEY)")
    end

    expect(column_names_for("telemetry")).to be_empty

    harness_class.ensure_schema_upgrades

    telemetry_columns = column_names_for("telemetry")
    expect(telemetry_columns).to include("soil_temperature", "lux", "iaq")
    expect(telemetry_columns).to include("rx_time", "battery_level")
  end

  it "creates trace tables when absent" do
    SQLite3::Database.new(PotatoMesh::Config.db_path) do |db|
      db.execute("CREATE TABLE nodes(node_id TEXT)")
      db.execute("CREATE TABLE messages(id INTEGER PRIMARY KEY)")
    end

    expect(column_names_for("traces")).to be_empty
    expect(column_names_for("trace_hops")).to be_empty

    harness_class.ensure_schema_upgrades

    traces_columns = column_names_for("traces")
    expect(traces_columns).to include("request_id", "src", "dest", "rx_time", "rx_iso", "elapsed_ms")

    hop_columns = column_names_for("trace_hops")
    expect(hop_columns).to include("trace_id", "hop_index", "node_id")
  end

  it "creates positions and neighbors tables when absent" do
    SQLite3::Database.new(PotatoMesh::Config.db_path) do |db|
      db.execute("CREATE TABLE nodes(node_id TEXT)")
      db.execute("CREATE TABLE messages(id INTEGER PRIMARY KEY)")
      db.execute("CREATE TABLE telemetry(id INTEGER PRIMARY KEY, rx_time INTEGER, rx_iso TEXT)")
    end

    expect(column_names_for("positions")).to be_empty
    expect(column_names_for("neighbors")).to be_empty

    harness_class.ensure_schema_upgrades

    positions_columns = column_names_for("positions")
    expect(positions_columns).to include("id", "node_id", "rx_time", "ingestor")

    neighbors_columns = column_names_for("neighbors")
    expect(neighbors_columns).to include("node_id", "neighbor_id", "rx_time", "ingestor")
  end

  it "adds ingestor columns to legacy positions neighbors and traces tables" do
    SQLite3::Database.new(PotatoMesh::Config.db_path) do |db|
      db.execute("CREATE TABLE nodes(node_id TEXT)")
      db.execute("CREATE TABLE messages(id INTEGER PRIMARY KEY)")
      db.execute("CREATE TABLE telemetry(id INTEGER PRIMARY KEY, rx_time INTEGER, rx_iso TEXT)")
      db.execute <<~SQL
                   CREATE TABLE positions (
                     id INTEGER PRIMARY KEY,
                     rx_time INTEGER,
                     rx_iso TEXT,
                     node_id TEXT
                   )
                 SQL
      db.execute <<~SQL
                   CREATE TABLE neighbors (
                     node_id TEXT,
                     neighbor_id TEXT,
                     rx_time INTEGER
                   )
                 SQL
      db.execute <<~SQL
                   CREATE TABLE traces (
                     id INTEGER PRIMARY KEY,
                     request_id INTEGER,
                     src TEXT,
                     dest TEXT,
                     rx_time INTEGER,
                     rx_iso TEXT
                   )
                 SQL
      db.execute("CREATE TABLE trace_hops(trace_id INTEGER, hop_index INTEGER, node_id TEXT)")
    end

    harness_class.ensure_schema_upgrades

    expect(column_names_for("positions")).to include("ingestor")
    expect(column_names_for("neighbors")).to include("ingestor")
    expect(column_names_for("traces")).to include("ingestor")
  end

  it "adds the contact_link column to existing instances tables" do
    SQLite3::Database.new(PotatoMesh::Config.db_path) do |db|
      db.execute("CREATE TABLE nodes(node_id TEXT)")
      db.execute("CREATE TABLE messages(id INTEGER PRIMARY KEY)")
      db.execute(
        "CREATE TABLE instances(id TEXT PRIMARY KEY, domain TEXT, pubkey TEXT, last_update_time INTEGER, is_private INTEGER)",
      )
    end

    expect(column_names_for("instances")).not_to include("contact_link")

    harness_class.ensure_schema_upgrades

    expect(column_names_for("instances")).to include("contact_link")
  end

  it "backfills misclassified meshcore placeholder nodes" do
    SQLite3::Database.new(PotatoMesh::Config.db_path) do |db|
      db.execute(<<~SQL)
        CREATE TABLE nodes(
          node_id TEXT PRIMARY KEY, num INTEGER, short_name TEXT, long_name TEXT,
          role TEXT, last_heard INTEGER, first_heard INTEGER,
          protocol TEXT NOT NULL DEFAULT 'meshtastic', synthetic BOOLEAN NOT NULL DEFAULT 0
        )
      SQL
      db.execute("CREATE TABLE messages(id INTEGER PRIMARY KEY)")

      # Misclassified meshcore placeholder (bug #747)
      db.execute(
        "INSERT INTO nodes(node_id, short_name, long_name, role, protocol) VALUES (?, ?, ?, ?, ?)",
        ["!aabb0001", "0001", "Meshcore 0001", "CLIENT_HIDDEN", "meshtastic"],
      )

      # Meshcore node where protocol self-healed but role did not
      db.execute(
        "INSERT INTO nodes(node_id, short_name, long_name, role, protocol) VALUES (?, ?, ?, ?, ?)",
        ["!aabb0002", "0002", "SomeNode", "CLIENT_HIDDEN", "meshcore"],
      )

      # Meshtastic node that should remain untouched
      db.execute(
        "INSERT INTO nodes(node_id, short_name, long_name, role, protocol) VALUES (?, ?, ?, ?, ?)",
        ["!aabb0003", "0003", "Meshtastic 0003", "CLIENT_HIDDEN", "meshtastic"],
      )
    end

    harness_class.ensure_schema_upgrades

    SQLite3::Database.new(PotatoMesh::Config.db_path, readonly: true) do |db|
      db.results_as_hash = true

      fixed_proto = db.get_first_row("SELECT protocol, role FROM nodes WHERE node_id = '!aabb0001'")
      expect(fixed_proto["protocol"]).to eq("meshcore")
      expect(fixed_proto["role"]).to eq("COMPANION")

      fixed_role = db.get_first_row("SELECT protocol, role FROM nodes WHERE node_id = '!aabb0002'")
      expect(fixed_role["protocol"]).to eq("meshcore")
      expect(fixed_role["role"]).to eq("COMPANION")

      untouched = db.get_first_row("SELECT protocol, role FROM nodes WHERE node_id = '!aabb0003'")
      expect(untouched["protocol"]).to eq("meshtastic")
      expect(untouched["role"]).to eq("CLIENT_HIDDEN")
    end
  end

  it "backfills meshcore synthetic/real duplicates and redirects their messages" do
    # Covers issue #755: before the reverse-merge fix shipped, a synthetic
    # placeholder created from a chat message could coexist with the real
    # pubkey-derived node if the real node was upserted first (typical when a
    # co-operating ingestor saw the contact advertisement before this one).
    SQLite3::Database.new(PotatoMesh::Config.db_path) do |db|
      db.execute(<<~SQL)
        CREATE TABLE nodes(
          node_id TEXT PRIMARY KEY, num INTEGER, short_name TEXT, long_name TEXT,
          role TEXT, last_heard INTEGER, first_heard INTEGER,
          protocol TEXT NOT NULL DEFAULT 'meshtastic', synthetic BOOLEAN NOT NULL DEFAULT 0
        )
      SQL
      db.execute(<<~SQL)
        CREATE TABLE messages(
          id INTEGER PRIMARY KEY, rx_time INTEGER, rx_iso TEXT,
          from_id TEXT, to_id TEXT, protocol TEXT NOT NULL DEFAULT 'meshtastic'
        )
      SQL

      # Duplicate pair sharing a long_name — the classic issue #755 shape.
      db.execute(
        "INSERT INTO nodes(node_id, long_name, role, protocol, synthetic) VALUES (?, ?, ?, ?, ?)",
        ["!realdup1", "Peggy", "COMPANION", "meshcore", 0],
      )
      db.execute(
        "INSERT INTO nodes(node_id, long_name, role, protocol, synthetic) VALUES (?, ?, ?, ?, ?)",
        ["!synthdp1", "Peggy", "COMPANION", "meshcore", 1],
      )
      db.execute(
        "INSERT INTO messages(id, rx_time, rx_iso, from_id, to_id, protocol) VALUES (?, ?, ?, ?, ?, ?)",
        [901, 1, "2025-01-01T00:00:00Z", "!synthdp1", "^all", "meshcore"],
      )

      # Orphaned synthetic with no real counterpart — must be preserved.
      db.execute(
        "INSERT INTO nodes(node_id, long_name, role, protocol, synthetic) VALUES (?, ?, ?, ?, ?)",
        ["!synthorp", "Trent", "COMPANION", "meshcore", 1],
      )

      # Cross-protocol namesake — must NOT be merged.
      db.execute(
        "INSERT INTO nodes(node_id, long_name, role, protocol, synthetic) VALUES (?, ?, ?, ?, ?)",
        ["!realmtX1", "Victor", "CLIENT", "meshtastic", 0],
      )
      db.execute(
        "INSERT INTO nodes(node_id, long_name, role, protocol, synthetic) VALUES (?, ?, ?, ?, ?)",
        ["!synthmcX", "Victor", "COMPANION", "meshcore", 1],
      )
    end

    harness_class.ensure_schema_upgrades

    SQLite3::Database.new(PotatoMesh::Config.db_path, readonly: true) do |db|
      db.results_as_hash = true

      # Synthetic duplicate collapsed, real node survived.
      expect(db.get_first_row("SELECT node_id FROM nodes WHERE node_id = '!synthdp1'")).to be_nil
      expect(db.get_first_row("SELECT node_id FROM nodes WHERE node_id = '!realdup1'")).not_to be_nil
      # Message redirected to the real node id.
      msg = db.get_first_row("SELECT from_id FROM messages WHERE id = 901")
      expect(msg["from_id"]).to eq("!realdup1")

      # Orphaned synthetic left alone.
      expect(db.get_first_row("SELECT node_id FROM nodes WHERE node_id = '!synthorp'")).not_to be_nil

      # Cross-protocol namesake pair untouched — meshtastic real must not
      # absorb a meshcore synthetic.
      expect(db.get_first_row("SELECT node_id FROM nodes WHERE node_id = '!synthmcX'")).not_to be_nil
      expect(db.get_first_row("SELECT node_id FROM nodes WHERE node_id = '!realmtX1'")).not_to be_nil
    end
  end
end
