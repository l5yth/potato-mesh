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
      # while favouring the most recent entry. The canonical form is the one
      # the federation caps read (SPEC FB3).
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
          federation_canonical_domain(row[1])
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
          "public_key" => pubkey,
          "name" => string_or_nil(row["name"]),
          "version" => string_or_nil(row["version"]),
          "channel" => string_or_nil(row["channel"]),
          "frequency" => string_or_nil(row["frequency"]),
          "latitude" => coerce_float(row["latitude"]),
          "longitude" => coerce_float(row["longitude"]),
          "last_update" => last_update_time,
          "is_private" => private_flag,
          "nodes_count" => coerce_integer(row["nodes_count"]),
          "meshcore_nodes_count" => coerce_integer(row["meshcore_nodes_count"]),
          "meshtastic_nodes_count" => coerce_integer(row["meshtastic_nodes_count"]),
          # NULL column (rows predating the reticulum count column and peers that announced no count)
          # serves 0 so a crawler re-verifying a relayed v2 record rebuilds the
          # same canonical those senders signed.
          "reticulum_nodes_count" => coerce_integer(row["reticulum_nodes_count"]) || 0,
          "contact_link" => string_or_nil(row["contact_link"]),
          "signature" => signature,
          "signature_version" => PotatoMesh::Config.federation_signature_version,
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

      # Fetch the instance rows ready to be served by the API while handling
      # malformed rows gracefully. The dataset is restricted to the rows this
      # instance verified within the rolling window defined by
      # PotatoMesh::Config.week_seconds, by its own clock, and served in the
      # keep order, at most {Federation::INSTANCE_ROW_LIMIT} of them (SPEC
      # FB2, FB4). Each listed peer row carries its signed +last_update+.
      # Reads only: {#clean_duplicate_instances!} and
      # {Federation#enforce_instance_caps!} run at boot and on each
      # announcement cycle instead (SPEC RC4).
      #
      # @return [Array<Hash>] list of cleaned instance payloads.
      def load_instances_for_api
        now = Time.now.to_i
        min_verified_time = now - PotatoMesh::Config.week_seconds
        self_id = app_constant(:SELF_INSTANCE_ID)
        # Our own row is stored at boot and on each announcement cycle only, so
        # its time can trail a node heard since: it is listed by its newest
        # node, read now, as when every GET refreshed it first (SPEC RC4).
        self_listed = (latest_node_update_timestamp || now) >= min_verified_time
        order, order_params = instance_keep_order(now: now)
        db = open_database(readonly: true)
        db.results_as_hash = true
        sql = <<~SQL
          SELECT id, domain, pubkey, name, version, channel, frequency,
                 latitude, longitude, last_update_time, is_private, nodes_count,
                 meshcore_nodes_count, meshtastic_nodes_count, reticulum_nodes_count,
                 contact_link, signature
          FROM instances
          WHERE domain IS NOT NULL AND TRIM(domain) != ''
            AND pubkey IS NOT NULL AND TRIM(pubkey) != ''
            AND (id = ? OR (typeof(last_verified_time) = 'integer' AND last_verified_time >= ?))
          ORDER BY #{order}
          LIMIT ?
        SQL

        rows = with_busy_retry do
          db.execute(sql, [self_id, min_verified_time, *order_params, PotatoMesh::App::Federation::INSTANCE_ROW_LIMIT])
        end

        rows.each_with_object([]) do |row, memo|
          normalized = normalize_instance_row(row)
          next unless normalized

          if normalized["id"] == self_id
            next unless self_listed
          else
            next unless normalized["last_update"].is_a?(Integer)
          end

          memo << normalized
        end
      rescue SQLite3::Exception => e
        warn_log(
          "Failed to load instance records",
          context: "instances.load",
          error_class: e.class.name,
          error_message: e.message,
        )
        []
      ensure
        db&.close
      end
    end
  end
end
