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
        required = %w[nodes messages positions telemetry neighbors instances]
        tables =
          db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('nodes','messages','positions','telemetry','neighbors','instances')",
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
        %w[nodes messages positions telemetry neighbors instances].each do |schema|
          sql_file = File.expand_path("../../../../data/#{schema}.sql", __dir__)
          db.execute_batch(File.read(sql_file))
        end
      ensure
        db&.close
      end

      # Read the bundled schema file discarding PRAGMA statements that cannot be
      # executed inside transactions.
      #
      # @param schema_name [String] base schema file name without extension.
      # @return [String] SQL statements ready for execution.
      def schema_statements_without_pragmas(schema_name)
        sql_file = File.expand_path("../../../../data/#{schema_name}.sql", __dir__)
        File.read(sql_file)
            .lines
            .reject { |line| line.strip.upcase.start_with?("PRAGMA") }
            .join
      end

      # Rebuild a table so the lora_frequency column is stored as INTEGER while
      # preserving existing data.
      #
      # @param db [SQLite3::Database] active database handle.
      # @param table_name [String] table to rebuild.
      # @param schema_name [String] schema file used for the new table definition.
      # @return [void]
      def rebuild_table_with_frequency_column(db, table_name, schema_name)
        old_table = "#{table_name}_old"
        foreign_keys_state = db.get_first_value("PRAGMA foreign_keys")
        db.execute("PRAGMA foreign_keys = OFF")
        db.transaction do
          db.execute("ALTER TABLE #{table_name} RENAME TO #{old_table}")
          db.execute_batch(schema_statements_without_pragmas(schema_name))

          new_columns =
            db.execute("PRAGMA table_info(#{table_name})").map { |row| row[1] }
          old_columns =
            db.execute("PRAGMA table_info(#{old_table})").map { |row| row[1] }
          shared_columns = new_columns & old_columns

          select_sql = "SELECT #{shared_columns.join(", ")} FROM #{old_table}"
          rows = db.execute2(select_sql)
          header = rows.shift || []

          insert_sql = <<~SQL
            INSERT INTO #{table_name} (#{shared_columns.join(",")})
            VALUES (#{Array.new(shared_columns.length, "?").join(",")})
          SQL

          rows.each do |row|
            record = header.zip(row).to_h
            if shared_columns.include?("lora_frequency")
              record["lora_frequency"] = PotatoMesh::Sanitizer.lora_frequency_or_nil(record["lora_frequency"])
            end
            values = shared_columns.map { |column| record[column] }
            db.execute(insert_sql, values)
          end

          db.execute("DROP TABLE #{old_table}")
        end
      ensure
        db.execute("PRAGMA foreign_keys = ON") if foreign_keys_state.to_i != 0
      end

      # Apply any schema migrations required for older installations.
      #
      # @return [void]
      def ensure_schema_upgrades
        db = open_database
        node_info = db.execute("PRAGMA table_info(nodes)")
        node_columns = node_info.map { |row| row[1] }
        unless node_columns.include?("precision_bits")
          db.execute("ALTER TABLE nodes ADD COLUMN precision_bits INTEGER")
        end
        unless node_columns.include?("lora_preset")
          db.execute("ALTER TABLE nodes ADD COLUMN lora_preset TEXT")
        end
        unless node_columns.include?("lora_frequency")
          db.execute("ALTER TABLE nodes ADD COLUMN lora_frequency INTEGER")
        end

        frequency_column = node_info.find { |row| row[1] == "lora_frequency" }
        if frequency_column && frequency_column[2].to_s.casecmp("INTEGER") != 0
          rebuild_table_with_frequency_column(db, "nodes", "nodes")
        end

        message_info = db.execute("PRAGMA table_info(messages)")
        message_columns = message_info.map { |row| row[1] }
        unless message_columns.include?("lora_preset")
          db.execute("ALTER TABLE messages ADD COLUMN lora_preset TEXT")
        end
        unless message_columns.include?("lora_frequency")
          db.execute("ALTER TABLE messages ADD COLUMN lora_frequency INTEGER")
        end

        message_frequency_column = message_info.find { |row| row[1] == "lora_frequency" }
        if message_frequency_column && message_frequency_column[2].to_s.casecmp("INTEGER") != 0
          rebuild_table_with_frequency_column(db, "messages", "messages")
        end

        tables = db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='instances'").flatten
        if tables.empty?
          sql_file = File.expand_path("../../../../data/instances.sql", __dir__)
          db.execute_batch(File.read(sql_file))
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
