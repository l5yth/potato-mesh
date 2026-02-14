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
    # Helper methods for maintaining and presenting instance records.
    module Instances
      # Remove duplicate instance records grouped by their canonical domain name
      # while favouring the most recent entry.
      #
      # @return [void]
      def clean_duplicate_instances!
        db = open_database
        rows = with_busy_retry do
          db.execute(
            <<~SQL
              SELECT rowid, domain, last_update_time
              FROM instances
              WHERE domain IS NOT NULL AND TRIM(domain) != ''
            SQL
          )
        end

        grouped = rows.group_by do |row|
          sanitize_instance_domain(row[1])&.downcase
        rescue StandardError
          nil
        end

        deletions = []
        updates = {}

        grouped.each do |canonical_domain, entries|
          next if canonical_domain.nil?
          next if entries.size <= 1

          sorted_entries = entries.sort_by do |entry|
            timestamp = coerce_integer(entry[2]) || -1
            [timestamp, entry[0].to_i]
          end
          keeper = sorted_entries.last
          next unless keeper

          deletions.concat(sorted_entries[0...-1].map { |entry| entry[0].to_i })

          current_domain = entries.find { |entry| entry[0] == keeper[0] }&.[](1)
          if canonical_domain && current_domain != canonical_domain
            updates[keeper[0].to_i] = canonical_domain
          end

          removed_count = sorted_entries.length - 1
          warn_log(
            "Removed duplicate instance records",
            context: "instances.cleanup",
            domain: canonical_domain,
            removed: removed_count,
          ) if removed_count.positive?
        end

        unless deletions.empty?
          placeholders = Array.new(deletions.size, "?").join(",")
          with_busy_retry do
            db.execute("DELETE FROM instances WHERE rowid IN (#{placeholders})", deletions)
          end
        end

        updates.each do |rowid, canonical_domain|
          with_busy_retry do
            db.execute("UPDATE instances SET domain = ? WHERE rowid = ?", [canonical_domain, rowid])
          end
        end
      rescue SQLite3::Exception => e
        warn_log(
          "Failed to clean duplicate instances",
          context: "instances.cleanup",
          error_class: e.class.name,
          error_message: e.message,
        )
      ensure
        db&.close
      end

      # Normalise and validate an instance database row for API presentation.
      #
      # @param row [Hash] raw database row with string keys.
      # @return [Hash, nil] cleaned hash or +nil+ when the row is discarded.
      def normalize_instance_row(row)
        unless row.is_a?(Hash)
          warn_log(
            "Discarded malformed instance row",
            context: "instances.normalize",
            reason: "row not hash",
          )
          return nil
        end

        id = string_or_nil(row["id"])
        domain = sanitize_instance_domain(row["domain"])&.downcase
        pubkey = sanitize_public_key_pem(row["pubkey"])
        signature = string_or_nil(row["signature"])
        last_update_time = coerce_integer(row["last_update_time"])
        is_private_raw = row["is_private"]
        private_flag = coerce_boolean(is_private_raw)
        if private_flag.nil?
          numeric_private = coerce_integer(is_private_raw)
          private_flag = !numeric_private.to_i.zero? if numeric_private
        end
        private_flag = false if private_flag.nil?

        if id.nil? || domain.nil? || pubkey.nil?
          warn_log(
            "Discarded malformed instance row",
            context: "instances.normalize",
            instance_id: row["id"],
            domain: row["domain"],
            reason: "missing required fields",
          )
          return nil
        end

        payload = {
          "id" => id,
          "domain" => domain,
          "pubkey" => pubkey,
          "name" => string_or_nil(row["name"]),
          "version" => string_or_nil(row["version"]),
          "channel" => string_or_nil(row["channel"]),
          "frequency" => string_or_nil(row["frequency"]),
          "latitude" => coerce_float(row["latitude"]),
          "longitude" => coerce_float(row["longitude"]),
          "lastUpdateTime" => last_update_time,
          "isPrivate" => private_flag,
          "nodesCount" => coerce_integer(row["nodes_count"]),
          "contactLink" => string_or_nil(row["contact_link"]),
          "signature" => signature,
        }

        payload.reject { |_, value| value.nil? }
      rescue StandardError => e
        warn_log(
          "Failed to normalise instance row",
          context: "instances.normalize",
          instance_id: row.respond_to?(:[]) ? row["id"] : nil,
          domain: row.respond_to?(:[]) ? row["domain"] : nil,
          error_class: e.class.name,
          error_message: e.message,
        )
        nil
      end

      # Fetch all instance rows ready to be served by the API while handling
      # malformed rows gracefully. The dataset is restricted to records updated
      # within the rolling window defined by PotatoMesh::Config.week_seconds.
      #
      # @param limit [Integer, nil] optional page size used when pagination is enabled.
      # @param cursor [String, nil] optional keyset cursor for pagination.
      # @param with_pagination [Boolean] when true, return items and next cursor metadata.
      # @return [Array<Hash>, Hash] list of cleaned instance payloads or pagination metadata hash.
      def load_instances_for_api(limit: nil, cursor: nil, with_pagination: false)
        clean_duplicate_instances!

        db = open_database(readonly: true)
        db.results_as_hash = true
        now = Time.now.to_i
        min_last_update_time = now - PotatoMesh::Config.week_seconds
        safe_limit = coerce_query_limit(limit) if with_pagination
        fetch_limit = with_pagination ? safe_limit + 1 : nil
        where_clauses = [
          "domain IS NOT NULL",
          "TRIM(domain) != ''",
          "pubkey IS NOT NULL",
          "TRIM(pubkey) != ''",
          "last_update_time IS NOT NULL",
          "last_update_time >= ?",
        ]
        params = [min_last_update_time]

        if with_pagination
          cursor_payload = decode_query_cursor(cursor)
          if cursor_payload
            cursor_domain = sanitize_instance_domain(cursor_payload["domain"])&.downcase
            cursor_id = string_or_nil(cursor_payload["id"])
            if cursor_domain && cursor_id
              where_clauses << "(LOWER(domain) > ? OR (LOWER(domain) = ? AND id > ?))"
              params.concat([cursor_domain, cursor_domain, cursor_id])
            end
          end
        end

        sql = <<~SQL
          SELECT id, domain, pubkey, name, version, channel, frequency,
                 latitude, longitude, last_update_time, is_private, nodes_count, contact_link, signature
          FROM instances
          WHERE #{where_clauses.join("\n            AND ")}
          ORDER BY LOWER(domain)
        SQL
        sql += " LIMIT ?" if with_pagination
        params << fetch_limit if with_pagination

        rows = with_busy_retry do
          db.execute(sql, params)
        end

        items = rows.each_with_object([]) do |row, memo|
          normalized = normalize_instance_row(row)
          next unless normalized

          last_update_time = normalized["lastUpdateTime"]
          next unless last_update_time.is_a?(Integer) && last_update_time >= min_last_update_time

          memo << normalized
        end
        return items unless with_pagination

        has_more = items.length > safe_limit
        paged_items = has_more ? items.first(safe_limit) : items
        next_cursor = nil
        if has_more && !paged_items.empty?
          marker = paged_items.last
          next_cursor = encode_query_cursor({
            "domain" => string_or_nil(marker["domain"]),
            "id" => string_or_nil(marker["id"]),
          })
        end

        { items: paged_items, next_cursor: next_cursor }
      rescue SQLite3::Exception => e
        warn_log(
          "Failed to load instance records",
          context: "instances.load",
          error_class: e.class.name,
          error_message: e.message,
        )
        with_pagination ? { items: [], next_cursor: nil } : []
      ensure
        db&.close
      end
    end
  end
end
