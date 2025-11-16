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
    module Database
      # Column definitions required for environment telemetry support. Each
      # entry pairs the column name with the SQL type used when backfilling
      # legacy databases that pre-date the extended telemetry schema.
      TELEMETRY_COLUMN_DEFINITIONS = [
        ["gas_resistance", "REAL"],
        ["current", "REAL"],
        ["iaq", "INTEGER"],
        ["distance", "REAL"],
        ["lux", "REAL"],
        ["white_lux", "REAL"],
        ["ir_lux", "REAL"],
        ["uv_lux", "REAL"],
        ["wind_direction", "INTEGER"],
        ["wind_speed", "REAL"],
        ["weight", "REAL"],
        ["wind_gust", "REAL"],
        ["wind_lull", "REAL"],
        ["radiation", "REAL"],
        ["rainfall_1h", "REAL"],
        ["rainfall_24h", "REAL"],
        ["soil_moisture", "INTEGER"],
        ["soil_temperature", "REAL"],
      ].freeze

      # Open a connection to the application database applying common pragmas.
      #
      # @param readonly [Boolean] whether to open the database in read-only mode.
      # @return [SQLite3::Database] configured database handle.
      def open_database(readonly: false)
        SQLite3::Database.new(PotatoMesh::Config.db_path, readonly: readonly).tap do |db|
          db.busy_timeout = PotatoMesh::Config.db_busy_timeout_ms
          db.execute("PRAGMA foreign_keys = ON")
        end
      end

      # Execute the provided block and retry when SQLite reports a busy error.
      #
      # @param max_retries [Integer] maximum number of retries when locked.
      # @param base_delay [Float] incremental back-off delay between retries.
      # @yield Executes the database operation.
      # @return [Object] result of the block.
      def with_busy_retry(
        max_retries: PotatoMesh::Config.db_busy_max_retries,
        base_delay: PotatoMesh::Config.db_busy_retry_delay
      )
        attempts = 0
        begin
          yield
        rescue SQLite3::BusyException
          attempts += 1
          raise if attempts > max_retries

          sleep(base_delay * attempts)
          retry
        end
      end

      # Determine whether the database schema has already been provisioned.
      #
      # @return [Boolean] true when all required tables exist.
      def db_schema_present?
        return false unless File.exist?(PotatoMesh::Config.db_path)

        db = open_database(readonly: true)
        required = %w[nodes messages positions telemetry neighbors instances traces trace_hops]
        tables =
          db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('nodes','messages','positions','telemetry','neighbors','instances','traces','trace_hops')",
          ).flatten
        (required - tables).empty?
      rescue SQLite3::Exception
        false
      ensure
        db&.close
      end

      # Create the database schema using the bundled SQL files.
      #
      # @return [void]
      def init_db
        FileUtils.mkdir_p(File.dirname(PotatoMesh::Config.db_path))
        db = open_database
        %w[nodes messages positions telemetry neighbors instances traces].each do |schema|
          sql_file = File.expand_path("../../../../data/#{schema}.sql", __dir__)
          db.execute_batch(File.read(sql_file))
        end
      ensure
        db&.close
      end

      # Apply any schema migrations required for older installations.
      #
      # @return [void]
      def ensure_schema_upgrades
        db = open_database
        node_columns = db.execute("PRAGMA table_info(nodes)").map { |row| row[1] }
        unless node_columns.include?("precision_bits")
          db.execute("ALTER TABLE nodes ADD COLUMN precision_bits INTEGER")
          node_columns << "precision_bits"
        end

        unless node_columns.include?("lora_freq")
          db.execute("ALTER TABLE nodes ADD COLUMN lora_freq INTEGER")
        end

        unless node_columns.include?("modem_preset")
          db.execute("ALTER TABLE nodes ADD COLUMN modem_preset TEXT")
        end

        message_columns = db.execute("PRAGMA table_info(messages)").map { |row| row[1] }

        unless message_columns.include?("lora_freq")
          db.execute("ALTER TABLE messages ADD COLUMN lora_freq INTEGER")
        end

        unless message_columns.include?("modem_preset")
          db.execute("ALTER TABLE messages ADD COLUMN modem_preset TEXT")
        end

        unless message_columns.include?("channel_name")
          db.execute("ALTER TABLE messages ADD COLUMN channel_name TEXT")
        end

        unless message_columns.include?("reply_id")
          db.execute("ALTER TABLE messages ADD COLUMN reply_id INTEGER")
          message_columns << "reply_id"
        end

        unless message_columns.include?("emoji")
          db.execute("ALTER TABLE messages ADD COLUMN emoji TEXT")
          message_columns << "emoji"
        end

        reply_index_exists =
          db.get_first_value(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_messages_reply_id'",
          ).to_i > 0
        unless reply_index_exists
          db.execute("CREATE INDEX IF NOT EXISTS idx_messages_reply_id ON messages(reply_id)")
        end

        tables = db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='instances'").flatten
        if tables.empty?
          sql_file = File.expand_path("../../../../data/instances.sql", __dir__)
          db.execute_batch(File.read(sql_file))
        end

        telemetry_tables =
          db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='telemetry'").flatten
        if telemetry_tables.empty?
          telemetry_schema = File.expand_path("../../../../data/telemetry.sql", __dir__)
          db.execute_batch(File.read(telemetry_schema))
        end

        telemetry_columns = db.execute("PRAGMA table_info(telemetry)").map { |row| row[1] }
        TELEMETRY_COLUMN_DEFINITIONS.each do |name, type|
          next if telemetry_columns.include?(name)

          db.execute("ALTER TABLE telemetry ADD COLUMN #{name} #{type}")
          telemetry_columns << name
        end

        trace_tables =
          db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('traces','trace_hops')",
          ).flatten
        unless trace_tables.include?("traces") && trace_tables.include?("trace_hops")
          traces_schema = File.expand_path("../../../../data/traces.sql", __dir__)
          db.execute_batch(File.read(traces_schema))
        end
      rescue SQLite3::SQLException, Errno::ENOENT => e
        warn_log(
          "Failed to apply schema upgrade",
          context: "database.schema",
          error_class: e.class.name,
          error_message: e.message,
        )
      ensure
        db&.close
      end
    end
  end
end
