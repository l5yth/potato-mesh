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

require_relative "database/schema_guard"

module PotatoMesh
  module App
    module Database
      # Schema-version marker that gates the one-shot #756 meshcore message
      # content-dedup backfill.  Stored in SQLite's ``PRAGMA user_version``;
      # bump this constant when a new one-shot migration is appended and
      # check the previous value below to decide whether to skip.
      # Bumped 1→2: the purge now keys on the stable +channel_name+ (not the
      # per-receiver +channel+ slot index) and inherits the widened
      # +MESHCORE_CONTENT_DEDUP_WINDOW_SECONDS+ (30→300 s), so it must re-run
      # once to clear the cross-slot, clock-skewed duplicates that accumulated
      # under the old window/key.
      # Bumped 2→3 (#880): a MeshCore channel broadcast with a "Name:" prefix
      # no longer keys on +from_id+, which each ingestor resolves against its
      # own roster (pubkey id or name-derived synthetic id), so the purge
      # re-runs once to clear the cross-slot copies that the old guard let
      # through when the two ingestors resolved the sender differently.
      MESHCORE_CONTENT_DEDUP_BACKFILL_VERSION = 3

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
        %w[nodes messages positions telemetry neighbors instances traces ingestors ingestor_activity waypoints].each do |schema|
          sql_file = File.expand_path("../../../../data/#{schema}.sql", __dir__)
          db.execute_batch(File.read(sql_file))
        end
      ensure
        db&.close
      end

      # Apply any schema migrations required for older installations.
      #
      # Every step runs in one IMMEDIATE transaction (SPEC SU2, SU5). A boot
      # that races another boot on the same database waits for the write
      # lock, then reads the upgraded schema and changes nothing. A failing
      # step rolls the whole upgrade back and fails the boot with an error
      # naming the step; the +dest_hash+ DROP is the one step allowed to
      # fail. A new database gets its full schema here too, in the same
      # transaction. Column guards match names in any case, as SQLite does
      # (SPEC SU4), and every index +data/*.sql+ defines that the database
      # lacks is created last (SPEC SU3).
      #
      # @return [void]
      # @raise [SchemaUpgradeError] when a step fails.
      def ensure_schema_upgrades
        FileUtils.mkdir_p(File.dirname(PotatoMesh::Config.db_path))
        db = open_database
        db.extend(UpgradeConnection)
        # Some data/*.sql files set WAL, and journal_mode cannot change
        # inside a transaction, so the switch comes before the one they run
        # in. A new file is still in rollback-journal mode: there the switch
        # takes the write lock, and SQLite reports BUSY at once, without the
        # busy timeout, while a racing boot holds it. So it retries like the
        # BEGIN (SPEC SU5).
        with_busy_retry { db.execute("PRAGMA journal_mode=WAL") }
        with_busy_retry { db.execute("BEGIN IMMEDIATE") }

        node_table_exists = db.get_first_value(
          "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='nodes'",
        ).to_i > 0
        if node_table_exists
          node_columns = schema_column_names(db, "nodes")
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

          # RF metrics (SPEC RF3/RF6): per-advert reception RSSI. NULL for
          # Meshtastic nodes, which report no per-node RSSI.
          unless node_columns.include?("rssi")
            db.execute("ALTER TABLE nodes ADD COLUMN rssi INTEGER")
          end

          # Keyed-evidence tracking (SPEC MR1): newest time the node was heard
          # via a key-authenticated record.  Deliberately not backfilled — NULL
          # means "no keyed evidence recorded since the column shipped", so a
          # live device re-arms its evidence on its next advert / roster
          # snapshot while a retired identity stays permanently stale.
          unless node_columns.include?("last_advert_heard")
            db.execute("ALTER TABLE nodes ADD COLUMN last_advert_heard INTEGER")
            node_columns << "last_advert_heard"
          end

          # Identity back-reference (SPEC RE2/RE7).  A Reticulum row is keyed on
          # its identity: +node_id+ is the first four bytes of the identity
          # hash, and this column keeps the full hash, as each of the node's
          # +destinations+ rows does.  Supersedes the short-lived +dest_hash+
          # JSON column, which modelled the destinations from the node side and
          # is dropped below.  NULL for protocols with no such identity.
          unless node_columns.include?("identity_hash")
            db.execute("ALTER TABLE nodes ADD COLUMN identity_hash TEXT")
            node_columns << "identity_hash"
          end

          # +dest_hash+ shipped in #893 and is superseded by the +destinations+
          # table.  A column and a table modelling the same relationship would
          # drift, so the column goes.  Guarded because ALTER TABLE DROP COLUMN
          # needs SQLite 3.35+; on anything older the column simply lingers
          # unused rather than failing the boot.
          if node_columns.include?("dest_hash")
            begin
              db.execute("ALTER TABLE nodes DROP COLUMN dest_hash")
              node_columns.delete("dest_hash")
            rescue SQLite3::SQLException
              nil
            end
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
            # Only collapse synthetics whose long_name resolves to an
            # unambiguous real meshcore node: either *exactly one* real of
            # that name exists, or — when several do — exactly one of them is
            # not positively known to be a retired identity (SPEC MR2).  A
            # retired keypair that only message touches keep "alive" therefore
            # no longer deadlocks the collapse, while two genuinely active
            # same-name devices — and any pair we know nothing about — still
            # refuse (merging would risk mis-attributing historical chat).
            # Wrapped in a single transaction so that a crash between the
            # UPDATE and DELETE cannot leave messages redirected without the
            # corresponding synthetic row cleared.
            evidence_cutoff = PotatoMesh::App::DataProcessing.evidence_cutoff
            # Confine the staleness predicate to evidence columns this schema
            # actually has.  +last_advert_heard+ was guaranteed present by the
            # ALTER above (so it is always in the list even though +node_columns+
            # is the pre-migration snapshot), while +position_time+ belongs to
            # the base schema and may be absent on the minimal tables the
            # migration is exercised against.
            evidence_columns = ["last_advert_heard"]
            evidence_columns << "position_time" if node_columns.include?("position_time")
            live_real_sql = "NOT #{PotatoMesh::App::DataProcessing.positively_stale_sql("real", columns: evidence_columns)}"
            db.transaction do
              db.execute(<<~SQL, [evidence_cutoff, evidence_cutoff])
                UPDATE messages
                   SET from_id = (
                     SELECT real.node_id FROM nodes real
                     JOIN nodes synth ON synth.long_name = real.long_name
                     WHERE synth.node_id = messages.from_id
                       AND synth.synthetic = 1 AND synth.protocol = 'meshcore'
                       AND real.synthetic = 0 AND real.protocol = 'meshcore'
                       AND (
                         (
                           SELECT COUNT(*) FROM nodes r2
                           WHERE r2.long_name = synth.long_name
                             AND r2.synthetic = 0 AND r2.protocol = 'meshcore'
                         ) = 1
                         OR #{live_real_sql}
                       )
                     LIMIT 1
                   )
                 WHERE from_id IN (
                   SELECT synth.node_id FROM nodes synth
                   WHERE synth.synthetic = 1 AND synth.protocol = 'meshcore'
                     AND (
                       (
                         SELECT COUNT(*) FROM nodes real
                         WHERE real.long_name = synth.long_name
                           AND real.synthetic = 0 AND real.protocol = 'meshcore'
                       ) = 1
                       OR (
                         SELECT COUNT(*) FROM nodes real
                         WHERE real.long_name = synth.long_name
                           AND real.synthetic = 0 AND real.protocol = 'meshcore'
                           AND #{live_real_sql}
                       ) = 1
                     )
                 )
              SQL
              db.execute(<<~SQL, [evidence_cutoff])
                DELETE FROM nodes
                 WHERE synthetic = 1 AND protocol = 'meshcore'
                   AND (
                     (
                       SELECT COUNT(*) FROM nodes real
                       WHERE real.long_name = nodes.long_name
                         AND real.synthetic = 0 AND real.protocol = 'meshcore'
                         AND real.node_id != nodes.node_id
                     ) = 1
                     OR (
                       SELECT COUNT(*) FROM nodes real
                       WHERE real.long_name = nodes.long_name
                         AND real.synthetic = 0 AND real.protocol = 'meshcore'
                         AND real.node_id != nodes.node_id
                         AND #{live_real_sql}
                     ) = 1
                   )
              SQL
            end
          end
        end

        message_table_exists = db.get_first_value(
          "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='messages'",
        ).to_i > 0
        message_columns = message_table_exists ? schema_column_names(db, "messages") : []

        if message_table_exists
          # v0.2.0 created messages without this column, and no later boot
          # added it, so every message insert there failed (SPEC SU4).
          unless message_columns.include?("encrypted")
            db.execute("ALTER TABLE messages ADD COLUMN encrypted TEXT")
          end

          unless message_columns.include?("lora_freq")
            db.execute("ALTER TABLE messages ADD COLUMN lora_freq INTEGER")
          end

          unless message_columns.include?("modem_preset")
            db.execute("ALTER TABLE messages ADD COLUMN modem_preset TEXT")
          end

          unless message_columns.include?("channel_name")
            db.execute("ALTER TABLE messages ADD COLUMN channel_name TEXT")
            # Keep the cached column list current so the meshcore content-dedup
            # purge below (which keys on +channel_name+) runs on this same boot
            # rather than waiting for the next restart.
            message_columns << "channel_name"
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
            # The MX6 index and the #756 purge below key on protocol; keep
            # the list current so they run on this boot, not the next one
            # (SPEC SU4).
            message_columns << "protocol"
          end

          # RF metrics (SPEC RF1/RF2/RF6): hops actually travelled (distinct
          # from hop_limit's remaining-budget semantic) and the MeshCore
          # hop-hash route. Both additive, NULL for legacy rows.
          unless message_columns.include?("hops")
            db.execute("ALTER TABLE messages ADD COLUMN hops INTEGER")
          end

          unless message_columns.include?("path")
            db.execute("ALTER TABLE messages ADD COLUMN path TEXT")
          end

          # MeshCore flood scope (SPEC SC4/SC5): region name, "*" or "?";
          # additive, NULL for legacy rows and other protocols.
          unless message_columns.include?("scope")
            db.execute("ALTER TABLE messages ADD COLUMN scope TEXT")
          end

          reply_index_exists =
            db.get_first_value(
              "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_messages_reply_id'",
            ).to_i > 0
          unless reply_index_exists
            db.execute("CREATE INDEX IF NOT EXISTS idx_messages_reply_id ON messages(reply_id)")
          end

          # #756 — meshcore-scoped partial indexes, small even on
          # meshtastic-heavy deployments.  +idx_messages_meshcore_content+
          # (from_id, channel, rx_time) is the original #756 index; since #880
          # the content-dedup lookups in insert_message and both purge
          # statements below search +idx_messages_meshcore_text+ (text,
          # rx_time) instead (SPEC MX6), which +data/messages.sql+ also
          # creates for a fresh database.  ``CREATE … IF NOT EXISTS`` is
          # cheap enough to run on every boot; the one-shot backfill below
          # is gated separately via ``PRAGMA user_version`` so it does not
          # repeat after the first successful pass.
          # +channel_name+ is required because the purge keys on it (the stable
          # cross-ingestor discriminator) rather than the per-receiver +channel+
          # slot index; a table lacking the column degrades to no purge.
          meshcore_dedup_columns = %w[from_id to_id channel_name text rx_time protocol]
          if meshcore_dedup_columns.all? { |column| message_columns.include?(column) }
            db.execute(<<~SQL)
              CREATE INDEX IF NOT EXISTS idx_messages_meshcore_content
                ON messages(from_id, channel, rx_time)
                WHERE protocol = 'meshcore'
            SQL
            db.execute(<<~SQL)
              CREATE INDEX IF NOT EXISTS idx_messages_meshcore_text
                ON messages(text, rx_time)
                WHERE protocol = 'meshcore'
            SQL

            # #756 backfill — collapse pre-existing meshcore duplicate groups.
            # Delete any row that has an EARLIER same-content row
            # (from_id, to_id, channel_name, text) within
            # #{PotatoMesh::App::DataProcessing::MESHCORE_CONTENT_DEDUP_WINDOW_SECONDS} s,
            # keeping the earliest (min rx_time, min id) copy; a channel
            # broadcast whose text carries a "Name:" prefix drops the +from_id+
            # leg (#880), so the sweep runs as two statements, one per key.
            # The keys + window match the runtime guard (+insert_message+): the
            # per-receiver +channel+ index differs across ingestors for one
            # logical channel, so the stable +channel_name+ is what clusters
            # cross-ingestor copies.  Each lookup of an earlier copy searches
            # +idx_messages_meshcore_text+ on ``text = … AND rx_time BETWEEN``,
            # so the sweep stays near-linear in the number of meshcore rows.
            #
            # NOTE — this EXISTS predicate is TRANSITIVE and so does NOT behave
            # identically to the runtime guard: a chain of identical-content rows
            # each within the window of the previous collapses to a single row
            # even if the chain spans MORE than the window, whereas the runtime
            # guard (which only compares a new row against already-persisted rows)
            # keeps roughly one row per window gap.  This is intentionally more
            # aggressive for the one-shot historical sweep — it also clears
            # repeated-identical-text backlogs (e.g. a beacon/bot re-posting the
            # same string on a cadence ≤ the window) on top of the cross-ingestor
            # duplicates — and is a one-time effect; the gentler runtime guard
            # governs every new row.  See #756 and ``CONTRACTS.md``.
            #
            # Gated via ``PRAGMA user_version`` so this expensive self-join
            # runs once per backfill version, not on every boot.  The runtime
            # guard alone governs rows inserted later and does not stop every
            # duplicate: until #880 it let through cross-slot copies whose
            # sender two ingestors resolved differently, and copies further
            # apart than the window or caught in the check-then-insert race
            # still pass (``CONTRACTS.md``).  A guard change that should also
            # clear history bumps +MESHCORE_CONTENT_DEDUP_BACKFILL_VERSION+.
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
                #
                # The broadcast test mirrors +parse_meshcore_sender_name+: a
                # colon with a non-blank name before it.  The +trim+ set (tab,
                # LF, VT, FF, CR, space) is what +String#strip+ removes, less
                # NUL, which SQLite would read as the end of the set.  The
                # second statement takes every other row (``to_id IS`` keeps a
                # NULL recipient in it) and keeps the +from_id+ leg.
                sender_prefix = <<~SQL.strip
                  instr(messages.text, ':') > 1
                    AND trim(substr(messages.text, 1, instr(messages.text, ':') - 1),
                             char(9, 10, 11, 12, 13, 32)) != ''
                SQL
                db.execute(<<~SQL, [window])
                  DELETE FROM messages
                   WHERE protocol = 'meshcore'
                     AND to_id = '^all'
                     AND text IS NOT NULL AND text != ''
                     AND from_id IS NOT NULL
                     AND #{sender_prefix}
                     AND EXISTS (
                       SELECT 1 FROM messages AS earlier
                        WHERE earlier.protocol = 'meshcore'
                          AND earlier.text = messages.text
                          AND earlier.rx_time BETWEEN messages.rx_time - ? AND messages.rx_time
                          AND earlier.to_id = '^all'
                          AND earlier.from_id IS NOT NULL
                          AND earlier.channel_name IS messages.channel_name
                          AND (earlier.rx_time < messages.rx_time
                               OR earlier.id < messages.id)
                     )
                SQL
                db.execute(<<~SQL, [window])
                  DELETE FROM messages
                   WHERE protocol = 'meshcore'
                     AND text IS NOT NULL AND text != ''
                     AND from_id IS NOT NULL
                     AND NOT (to_id IS '^all' AND #{sender_prefix})
                     AND EXISTS (
                       SELECT 1 FROM messages AS earlier
                        WHERE earlier.protocol = 'meshcore'
                          AND earlier.text = messages.text
                          AND earlier.rx_time BETWEEN messages.rx_time - ? AND messages.rx_time
                          AND earlier.from_id = messages.from_id
                          AND earlier.to_id IS messages.to_id
                          AND earlier.channel_name IS messages.channel_name
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

        instance_columns = schema_column_names(db, "instances")
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

        unless instance_columns.include?("reticulum_nodes_count")
          db.execute("ALTER TABLE instances ADD COLUMN reticulum_nodes_count INTEGER")
          instance_columns << "reticulum_nodes_count"
        end

        telemetry_tables =
          db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='telemetry'").flatten
        if telemetry_tables.empty?
          telemetry_schema = File.expand_path("../../../../data/telemetry.sql", __dir__)
          db.execute_batch(File.read(telemetry_schema))
        end

        telemetry_columns = schema_column_names(db, "telemetry")
        # The environment expansion plus the extended metric families (TI-A2:
        # power / air-quality / health / local / host / traffic stats and the
        # one-wire probe list) share one idempotent backfill loop; the extended
        # pairs derive from the same definitions insert_telemetry writes with.
        (TELEMETRY_COLUMN_DEFINITIONS + DataProcessing::EXTENDED_TELEMETRY_COLUMN_TYPES).each do |name, type|
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
        position_columns = schema_column_names(db, "positions")
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
        neighbor_columns = schema_column_names(db, "neighbors")
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
        trace_columns = schema_column_names(db, "traces")
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
          ingestor_columns = schema_column_names(db, "ingestors")
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

        # The per-heartbeat activity time-series (SPEC MA3) is a standalone,
        # append-only table; older installations gain it here without any data
        # backfill (the moving average simply starts populating from the next
        # heartbeat that carries a `packets` count).
        activity_tables =
          db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='ingestor_activity'").flatten
        if activity_tables.empty?
          activity_schema = File.expand_path("../../../../data/ingestor_activity.sql", __dir__)
          db.execute_batch(File.read(activity_schema))
        end

        # Waypoints (SPEC W1) are a standalone additive table; older
        # installations gain it here with no data backfill (POIs simply start
        # accumulating from the first WAYPOINT_APP broadcast heard).
        waypoint_tables =
          db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='waypoints'").flatten
        if waypoint_tables.empty?
          waypoints_schema = File.expand_path("../../../../data/waypoints.sql", __dir__)
          db.execute_batch(File.read(waypoints_schema))
        end

        destination_tables =
          db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='destinations'").flatten
        if destination_tables.empty?
          destinations_schema = File.expand_path("../../../../data/destinations.sql", __dir__)
          db.execute_batch(File.read(destinations_schema))
        end

        # A new database has no nodes or messages table. They come last, after
        # the blocks above skipped them as before, so a fresh schema commits
        # whole in this transaction and a racing boot never reads it half
        # built (SPEC SU5); init_db then finds the schema present.
        %w[nodes messages].each do |schema|
          table_exists = db.get_first_value(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?", [schema],
          ).to_i > 0
          db.execute_batch(File.read(File.join(SCHEMA_DIRECTORY, "#{schema}.sql"))) unless table_exists
        end

        # An index an operator dropped comes back here, after every other
        # step (SPEC SU3).
        create_missing_schema_indexes(db)

        db.execute("COMMIT")
      rescue SQLite3::Exception => e
        step = db.respond_to?(:upgrade_step_label) ? db.upgrade_step_label : "opening the database"
        raise SchemaUpgradeError,
              "Schema upgrade step failed: #{step} (#{e.class}: #{e.message.lines.first.to_s.chomp.chomp(":")})"
      ensure
        # Closing rolls back the transaction a failed step left open, so the
        # database keeps its pre-boot schema.
        db&.close
      end
    end
  end
end
