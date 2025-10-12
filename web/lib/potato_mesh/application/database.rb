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
      def open_database(readonly: false)
        SQLite3::Database.new(PotatoMesh::Config.db_path, readonly: readonly).tap do |db|
          db.busy_timeout = PotatoMesh::Config.db_busy_timeout_ms
          db.execute("PRAGMA foreign_keys = ON")
        end
      end

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

      def ensure_schema_upgrades
        db = open_database
        node_columns = db.execute("PRAGMA table_info(nodes)").map { |row| row[1] }
        unless node_columns.include?("precision_bits")
          db.execute("ALTER TABLE nodes ADD COLUMN precision_bits INTEGER")
        end

        tables = db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='instances'").flatten
        if tables.empty?
          sql_file = File.expand_path("../../../../data/instances.sql", __dir__)
          db.execute_batch(File.read(sql_file))
        end
      rescue SQLite3::SQLException, Errno::ENOENT => e
        warn "[warn] failed to apply schema upgrade: #{e.message}"
      ensure
        db&.close
      end
    end
  end
end
