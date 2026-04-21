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
      # Schema-version marker that gates the one-shot #756 meshcore message
      # content-dedup backfill.  Stored in SQLite's ``PRAGMA user_version``;
      # bump this constant when a new one-shot migration is appended and
      # check the previous value below to decide whether to skip.
      MESHCORE_CONTENT_DEDUP_BACKFILL_VERSION = 1

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
        required = %w[nodes messages positions telemetry neighbors instances traces trace_hops ingestors]
        tables =
          db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('nodes','messages','positions','telemetry','neighbors','instances','traces','trace_hops','ingestors')",
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
        %w[nodes messages positions telemetry neighbors instances traces ingestors].each do |schema|
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
        FileUtils.mkdir_p(File.dirname(PotatoMesh::Config.db_path))
        db = open_database

        node_table_exists = db.get_first_value(
          "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='nodes'",
        ).to_i > 0
        if node_table_exists
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

          unless node_columns.include?("protocol")
            db.execute("ALTER TABLE nodes ADD COLUMN protocol TEXT NOT NULL DEFAULT 'meshtastic'")
            db.execute("UPDATE nodes SET protocol = 'meshtastic' WHERE protocol IS NULL OR TRIM(protocol) = ''")
          end

          unless node_columns.include?("synthetic")
            db.execute("ALTER TABLE nodes ADD COLUMN synthetic BOOLEAN NOT NULL DEFAULT 0")
          end

          if node_columns.include?("long_name")
            existing_indexes = db.execute("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='nodes'").flatten
            unless existing_indexes.include?("idx_nodes_long_name")
              db.execute("CREATE INDEX IF NOT EXISTS idx_nodes_long_name ON nodes(long_name)")
            end
          end

          # Backfill #747: ensure_unknown_node previously omitted the protocol
          # column and hardcoded role=CLIENT_HIDDEN, causing meshcore placeholder
          # nodes to be stored as meshtastic/CLIENT_HIDDEN.  Fix both in one pass.
          if node_columns.include?("protocol")
            db.execute("UPDATE nodes SET protocol = 'meshcore' WHERE long_name LIKE 'Meshcore %' AND protocol = 'meshtastic'")
            db.execute("UPDATE nodes SET role = 'COMPANION' WHERE protocol = 'meshcore' AND role = 'CLIENT_HIDDEN'")
          end

          # Backfill #755: reconcile meshcore synthetic placeholder rows that
          # share a long_name with a real (pubkey-derived) meshcore node.
          # Earlier releases only merged synthetics at real-node upsert time;
          # if a synthetic arrived after the real was already stored (common
          # with co-operating ingestors that share this DB), the duplicate
          # persisted.  Migrate messages to the real id, then drop the stray
          # synthetic rows.  Idempotent — the EXISTS guards make repeated runs
          # a no-op.
          if node_columns.include?("protocol") && node_columns.include?("synthetic")
            # Only collapse synthetics whose long_name resolves to *exactly*
            # one real meshcore node.  When two real devices share a
            # long_name, the placeholder is ambiguous — merging would risk
            # mis-attributing historical chat messages to the wrong radio.
            # Wrapped in a single transaction so that a crash between the
            # UPDATE and DELETE cannot leave messages redirected without the
            # corresponding synthetic row cleared.
            db.transaction do
              db.execute(<<~SQL)
                UPDATE messages
                   SET from_id = (
                     SELECT real.node_id FROM nodes real
                     JOIN nodes synth ON synth.long_name = real.long_name
                     WHERE synth.node_id = messages.from_id
                       AND synth.synthetic = 1 AND synth.protocol = 'meshcore'
                       AND real.synthetic = 0 AND real.protocol = 'meshcore'
                     LIMIT 1
                   )
                 WHERE from_id IN (
                   SELECT synth.node_id FROM nodes synth
                   WHERE synth.synthetic = 1 AND synth.protocol = 'meshcore'
                     AND (
                       SELECT COUNT(*) FROM nodes real
                       WHERE real.long_name = synth.long_name
                         AND real.synthetic = 0 AND real.protocol = 'meshcore'
                     ) = 1
                 )
              SQL
              db.execute(<<~SQL)
                DELETE FROM nodes
                 WHERE synthetic = 1 AND protocol = 'meshcore'
                   AND (
                     SELECT COUNT(*) FROM nodes real
                     WHERE real.long_name = nodes.long_name
                       AND real.synthetic = 0 AND real.protocol = 'meshcore'
                       AND real.node_id != nodes.node_id
                   ) = 1
              SQL
            end
          end
        end

        message_table_exists = db.get_first_value(
          "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='messages'",
        ).to_i > 0
        message_columns = message_table_exists ? db.execute("PRAGMA table_info(messages)").map { |row| row[1] } : []

        if message_table_exists
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

          unless message_columns.include?("ingestor")
            db.execute("ALTER TABLE messages ADD COLUMN ingestor TEXT")
          end

          unless message_columns.include?("protocol")
            db.execute("ALTER TABLE messages ADD COLUMN protocol TEXT NOT NULL DEFAULT 'meshtastic'")
            db.execute("UPDATE messages SET protocol = 'meshtastic' WHERE protocol IS NULL OR TRIM(protocol) = ''")
          end

          reply_index_exists =
            db.get_first_value(
              "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_messages_reply_id'",
            ).to_i > 0
          unless reply_index_exists
            db.execute("CREATE INDEX IF NOT EXISTS idx_messages_reply_id ON messages(reply_id)")
          end

          # #756 — partial index backing the meshcore content-dedup lookup in
          # insert_message.  Scoped to meshcore so the index stays small even
          # on meshtastic-heavy deployments.  ``CREATE … IF NOT EXISTS`` is
          # cheap enough to run on every boot; the one-shot backfill below
          # is gated separately via ``PRAGMA user_version`` so it does not
          # repeat after the first successful pass.
          meshcore_dedup_columns = %w[from_id to_id channel text rx_time protocol]
          if meshcore_dedup_columns.all? { |column| message_columns.include?(column) }
            db.execute(<<~SQL)
              CREATE INDEX IF NOT EXISTS idx_messages_meshcore_content
                ON messages(from_id, channel, rx_time)
                WHERE protocol = 'meshcore'
            SQL

            # #756 backfill — collapse pre-existing meshcore duplicate groups.
            # Keep the earliest (min rx_time, min id) copy in each
            # (from_id, to_id, channel, text) cluster where any two rows are
            # within #{PotatoMesh::App::DataProcessing::MESHCORE_CONTENT_DEDUP_WINDOW_SECONDS} s
            # of each other.  Window matches the runtime guard so runtime and
            # backfill behave identically.
            #
            # Gated via ``PRAGMA user_version`` so this expensive self-join
            # runs exactly once after deploy.  Post-fix the runtime guard
            # prevents new duplicates from accumulating, so re-running on
            # every boot would scan ``messages`` for no reason.
            current_version = db.get_first_value("PRAGMA user_version").to_i
            if current_version < MESHCORE_CONTENT_DEDUP_BACKFILL_VERSION
              window = PotatoMesh::App::DataProcessing::MESHCORE_CONTENT_DEDUP_WINDOW_SECONDS
              db.transaction do
                # Window bound via ``?`` to match the rest of the codebase's
                # parameter-binding style; the value is a Ruby integer constant
                # so SQL-injection was never at risk here — the switch is
                # purely for consistency.  ``PRAGMA user_version`` cannot
                # accept bind params, so it keeps literal interpolation of
                # an internal constant.
                db.execute(<<~SQL, [window])
                  DELETE FROM messages
                   WHERE protocol = 'meshcore'
                     AND text IS NOT NULL AND text != ''
                     AND from_id IS NOT NULL
                     AND EXISTS (
                       SELECT 1 FROM messages AS earlier
                        WHERE earlier.protocol = 'meshcore'
                          AND earlier.from_id = messages.from_id
                          AND earlier.to_id IS messages.to_id
                          AND earlier.channel IS messages.channel
                          AND earlier.text = messages.text
                          AND messages.rx_time - earlier.rx_time >= 0
                          AND messages.rx_time - earlier.rx_time <= ?
                          AND (earlier.rx_time < messages.rx_time
                               OR earlier.id < messages.id)
                     )
                SQL
                db.execute("PRAGMA user_version = #{MESHCORE_CONTENT_DEDUP_BACKFILL_VERSION}")
              end
            end
          end
        end

        tables = db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='instances'").flatten
        if tables.empty?
          sql_file = File.expand_path("../../../../data/instances.sql", __dir__)
          db.execute_batch(File.read(sql_file))
        end

        instance_columns = db.execute("PRAGMA table_info(instances)").map { |row| row[1] }
        unless instance_columns.include?("contact_link")
          db.execute("ALTER TABLE instances ADD COLUMN contact_link TEXT")
          instance_columns << "contact_link"
        end

        unless instance_columns.include?("nodes_count")
          db.execute("ALTER TABLE instances ADD COLUMN nodes_count INTEGER")
          instance_columns << "nodes_count"
        end

        unless instance_columns.include?("meshcore_nodes_count")
          db.execute("ALTER TABLE instances ADD COLUMN meshcore_nodes_count INTEGER")
          instance_columns << "meshcore_nodes_count"
        end

        unless instance_columns.include?("meshtastic_nodes_count")
          db.execute("ALTER TABLE instances ADD COLUMN meshtastic_nodes_count INTEGER")
          instance_columns << "meshtastic_nodes_count"
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
        unless telemetry_columns.include?("ingestor")
          db.execute("ALTER TABLE telemetry ADD COLUMN ingestor TEXT")
        end
        unless telemetry_columns.include?("telemetry_type")
          db.execute("ALTER TABLE telemetry ADD COLUMN telemetry_type TEXT")
        end

        unless telemetry_columns.include?("protocol")
          db.execute("ALTER TABLE telemetry ADD COLUMN protocol TEXT NOT NULL DEFAULT 'meshtastic'")
          db.execute("UPDATE telemetry SET protocol = 'meshtastic' WHERE protocol IS NULL OR TRIM(protocol) = ''")
        end

        position_tables =
          db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='positions'").flatten
        if position_tables.empty?
          positions_schema = File.expand_path("../../../../data/positions.sql", __dir__)
          db.execute_batch(File.read(positions_schema))
        end
        position_columns = db.execute("PRAGMA table_info(positions)").map { |row| row[1] }
        unless position_columns.include?("ingestor")
          db.execute("ALTER TABLE positions ADD COLUMN ingestor TEXT")
        end

        unless position_columns.include?("protocol")
          db.execute("ALTER TABLE positions ADD COLUMN protocol TEXT NOT NULL DEFAULT 'meshtastic'")
          db.execute("UPDATE positions SET protocol = 'meshtastic' WHERE protocol IS NULL OR TRIM(protocol) = ''")
        end

        neighbor_tables =
          db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='neighbors'").flatten
        if neighbor_tables.empty?
          neighbors_schema = File.expand_path("../../../../data/neighbors.sql", __dir__)
          db.execute_batch(File.read(neighbors_schema))
        end
        neighbor_columns = db.execute("PRAGMA table_info(neighbors)").map { |row| row[1] }
        unless neighbor_columns.include?("ingestor")
          db.execute("ALTER TABLE neighbors ADD COLUMN ingestor TEXT")
        end

        unless neighbor_columns.include?("protocol")
          db.execute("ALTER TABLE neighbors ADD COLUMN protocol TEXT NOT NULL DEFAULT 'meshtastic'")
          db.execute("UPDATE neighbors SET protocol = 'meshtastic' WHERE protocol IS NULL OR TRIM(protocol) = ''")
        end

        trace_tables =
          db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('traces','trace_hops')",
          ).flatten
        unless trace_tables.include?("traces") && trace_tables.include?("trace_hops")
          traces_schema = File.expand_path("../../../../data/traces.sql", __dir__)
          db.execute_batch(File.read(traces_schema))
        end
        trace_columns = db.execute("PRAGMA table_info(traces)").map { |row| row[1] }
        unless trace_columns.include?("ingestor")
          db.execute("ALTER TABLE traces ADD COLUMN ingestor TEXT")
        end

        unless trace_columns.include?("protocol")
          db.execute("ALTER TABLE traces ADD COLUMN protocol TEXT NOT NULL DEFAULT 'meshtastic'")
          db.execute("UPDATE traces SET protocol = 'meshtastic' WHERE protocol IS NULL OR TRIM(protocol) = ''")
        end

        ingestor_tables =
          db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='ingestors'").flatten
        if ingestor_tables.empty?
          ingestors_schema = File.expand_path("../../../../data/ingestors.sql", __dir__)
          db.execute_batch(File.read(ingestors_schema))
        else
          ingestor_columns = db.execute("PRAGMA table_info(ingestors)").map { |row| row[1] }
          unless ingestor_columns.include?("version")
            db.execute("ALTER TABLE ingestors ADD COLUMN version TEXT")
          end
          unless ingestor_columns.include?("lora_freq")
            db.execute("ALTER TABLE ingestors ADD COLUMN lora_freq INTEGER")
          end
          unless ingestor_columns.include?("modem_preset")
            db.execute("ALTER TABLE ingestors ADD COLUMN modem_preset TEXT")
          end

          unless ingestor_columns.include?("protocol")
            db.execute("ALTER TABLE ingestors ADD COLUMN protocol TEXT NOT NULL DEFAULT 'meshtastic'")
            db.execute("UPDATE ingestors SET protocol = 'meshtastic' WHERE protocol IS NULL OR TRIM(protocol) = ''")
          end
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
