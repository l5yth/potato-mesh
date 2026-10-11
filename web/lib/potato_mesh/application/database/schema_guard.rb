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
    # Raised at boot when a schema upgrade step fails, or when the upgraded
    # database still lacks a table, column or index that +data/*.sql+
    # defines (SPEC SU2, SU3). The message names the failed step or every
    # missing object, and the boot stops.
    class SchemaUpgradeError < StandardError; end

    module Database
      # Directory holding the fresh-install schema files, +data/*.sql+.
      SCHEMA_DIRECTORY = File.expand_path("../../../../../data", __dir__)

      # Longest statement text a failed-step message quotes.
      UPGRADE_STEP_LABEL_LIMIT = 200

      # Behaviour +ensure_schema_upgrades+ gives the one connection it runs
      # its single IMMEDIATE transaction on (SPEC SU2, SU5). Mixed into that
      # connection with +extend+, so every other handle keeps the stock
      # +SQLite3::Database+ behaviour.
      module UpgradeConnection
        # @return [String, nil] the SQL prepared last: the step running when
        #   a statement fails.
        attr_reader :upgrade_step

        # Record +sql+ as the current step, then prepare it.
        #
        # +execute+, +get_first_value+ and every statement of +execute_batch+
        # prepare through here, so the record is the statement SQLite
        # rejected, not a call site.
        #
        # @param sql [String] statement text; inside +execute_batch+ the
        #   remaining batch, whose first statement is the one prepared.
        # @return [SQLite3::Statement, Object] the statement, or the block's
        #   result when a block is given.
        def prepare(sql, &block)
          @upgrade_step = sql
          super
        end

        # Run a nested +transaction+ block inside the upgrade's transaction.
        #
        # The upgrade already holds an IMMEDIATE transaction, which a BEGIN
        # cannot nest in. A nested block's statements commit or roll back
        # with the rest of the upgrade, so the block keeps the all-or-nothing
        # guarantee it asked for. Outside a transaction this is the stock
        # +SQLite3::Database#transaction+.
        #
        # @param mode [Symbol, nil] transaction mode, used outside a transaction.
        # @yieldparam db [SQLite3::Database] this connection.
        # @return [Object] the block's result, or the stock method's.
        def transaction(mode = nil, &block)
          return super unless block && transaction_active?

          yield self
        end

        # The current step as one line: its first statement without SQL
        # comments, cut at {UPGRADE_STEP_LABEL_LIMIT} characters.
        #
        # @return [String] the statement text, or an empty string before the
        #   first statement.
        def upgrade_step_label
          statement = upgrade_step.to_s.gsub(/--[^\n]*/, "")
          statement = statement.split(";").first.to_s.split.join(" ")
          return statement if statement.length <= UPGRADE_STEP_LABEL_LIMIT

          "#{statement[0, UPGRADE_STEP_LABEL_LIMIT - 3]}..."
        end
      end

      # Fail the boot unless the database holds every table, column and
      # index the fresh schema defines (SPEC SU3).
      #
      # Runs after +ensure_schema_upgrades+ and +init_db+, so an upgraded
      # database reaches here with every step applied and every index
      # created. Objects the fresh schema does not define (a legacy column,
      # a hand-made index) are allowed; only absences fail.
      #
      # @return [void]
      # @raise [SchemaUpgradeError] naming every missing object.
      def ensure_schema_parity!
        db = open_database(readonly: true)
        missing = missing_schema_objects(db)
        return if missing.empty?

        raise SchemaUpgradeError,
              "Database schema lacks what data/*.sql defines after the upgrade: #{missing.join(", ")}"
      ensure
        db&.close
      end

      # List what the fresh schema defines and +db+ lacks.
      #
      # SQLite compares identifiers case-insensitively, and so does this.
      #
      # @param db [SQLite3::Database] open database handle.
      # @param expected [Hash] schema shape to hold +db+ against; defaults to
      #   {#fresh_schema_shape}.
      # @return [Array<String>] +table <name>+, +<table>.<column>+ and
      #   +index <name>+ entries, in schema order.
      def missing_schema_objects(db, expected = fresh_schema_shape)
        missing = []
        expected.fetch(:tables).each do |table, columns|
          present = schema_column_names(db, table)
          if present.empty?
            missing << "table #{table}"
          else
            missing.concat(columns.reject { |column| present.include?(column.downcase) }.map { |column| "#{table}.#{column}" })
          end
        end
        indexes = schema_index_names(db).map(&:downcase)
        missing.concat(expected.fetch(:indexes).keys.reject { |name| indexes.include?(name.downcase) }.map { |name| "index #{name}" })
      end

      # Create each index +data/*.sql+ defines that +db+ lacks, with the
      # statement the fresh schema holds for it (SPEC SU3). An index is safe
      # to build again, so one an operator dropped comes back on the next
      # boot instead of failing it.
      #
      # The upgrade runs this last, in its transaction. An index whose table
      # is missing or lacks a column of the fresh schema is skipped: the
      # parity check then names that table or column, and the index.
      #
      # @param db [SQLite3::Database] the upgrade's connection.
      # @return [void]
      def create_missing_schema_indexes(db)
        shape = fresh_schema_shape
        present = schema_index_names(db).map(&:downcase)
        shape.fetch(:indexes).each do |name, index|
          next if present.include?(name.downcase)

          columns = schema_column_names(db, index[:table])
          next if columns.empty?
          next unless shape.fetch(:tables).fetch(index[:table]).all? { |column| columns.include?(column.downcase) }

          db.execute(index[:sql])
        end
      end

      # Tables, columns and named indexes +data/*.sql+ defines, read from an
      # in-memory database built from every file in {SCHEMA_DIRECTORY}.
      #
      # @return [Hash] +:tables+ maps each table to its column names in
      #   definition order; +:indexes+ maps each index name to its +:table+
      #   and the +:sql+ that creates it, as SQLite stores it (without
      #   +IF NOT EXISTS+).
      def fresh_schema_shape
        SQLite3::Database.open(":memory:") do |db|
          Dir.glob(File.join(SCHEMA_DIRECTORY, "*.sql")).sort.each { |file| db.execute_batch(File.read(file)) }
          tables = db.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid").flatten
          # SQLite's own autoindexes carry no statement.
          indexes = db.execute("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY rowid")
          {
            tables: tables.to_h { |table| [table, schema_table_columns(db, table)] },
            indexes: indexes.to_h { |name, table, sql| [name, { table: table, sql: sql }] },
          }
        end
      end

      private

      # Column names of +table+ in +db+, in lower case. SQLite matches
      # identifiers in any case, so the upgrade's column guards and the
      # parity check do too (SPEC SU3, SU4).
      #
      # @param db [SQLite3::Database] open database handle.
      # @param table [String] table name.
      # @return [Array<String>] lower-case column names; empty when the table
      #   is absent.
      def schema_column_names(db, table)
        schema_table_columns(db, table).map(&:downcase)
      end

      # Column names of +table+ in +db+.
      #
      # @param db [SQLite3::Database] open database handle.
      # @param table [String] table name, quoted for the pragma.
      # @return [Array<String>] column names; empty when the table is absent.
      def schema_table_columns(db, table)
        db.execute(%(PRAGMA table_info("#{table.gsub('"', '""')}"))).map { |row| row[1] }
      end

      # Named indexes in +db+. SQLite's own +sqlite_autoindex_*+ entries
      # belong to a table's key constraints, not to the schema files, and
      # are left out.
      #
      # @param db [SQLite3::Database] open database handle.
      # @return [Array<String>] index names in creation order.
      def schema_index_names(db)
        db.execute("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY rowid").flatten
      end
    end
  end
end
