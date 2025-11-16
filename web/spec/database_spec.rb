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
end
