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
    module Federation
      # The key and signed +last_update+ of the row stored for +domain+.
      #
      # @param db [SQLite3::Database] open database handle.
      # @param domain [String] domain, normalized as {#upsert_instance_record}
      #   stores it.
      # @return [Array(String, Integer)] public key and last update, both nil
      #   without a row.
      def stored_instance_key_and_update(db, domain)
        with_busy_retry do
          db.get_first_row(
            "SELECT pubkey, last_update_time FROM instances WHERE domain = ?",
            sanitize_instance_domain(domain),
          )
        end || [nil, nil]
      end

      # The key and signed +last_update+ of the row stored under a copy's
      # instance id, which FS9 binds to its key: the copy's own row, under
      # whichever domain form it was stored (SPEC FL1).
      #
      # @param db [SQLite3::Database] open database handle.
      # @param attributes [Hash] the copy's attributes.
      # @return [Array(String, Integer)] public key and last update, both nil
      #   without a row.
      def stored_instance_copy(db, attributes)
        with_busy_retry do
          db.get_first_row("SELECT pubkey, last_update_time FROM instances WHERE id = ?", attributes[:id])
        end || [nil, nil]
      end

      # Whether a copy of a record is outdated by its stored row: the row
      # holds the same key at a signed +last_update+ at least as new, so
      # storing the copy would change nothing or roll the row back. The crawl
      # and +POST /api/instances+ skip such a copy (SPEC FL1, FL7). The keys
      # are compared in Ruby: a key bound as a blob never equals the same PEM
      # bound as text in SQL.
      #
      # @param stored [Array(String, Integer)] {#stored_instance_copy} or
      #   {#stored_instance_key_and_update}.
      # @param attributes [Hash] the copy's attributes.
      # @return [Boolean] true when the copy must not be stored.
      def instance_copy_outdated?(stored, attributes)
        stored_pubkey, stored_update = stored
        stored_pubkey == attributes[:pubkey] && !stored_update.nil? &&
          stored_update.to_i >= attributes[:last_update_time].to_i
      end

      # Persist or refresh a remote instance row, evicting any conflicting
      # entry that already claimed the same domain.
      #
      # @param db [SQLite3::Database] open database handle.
      # @param attributes [Hash] sanitized instance attributes.
      # @param signature [String] base64-encoded signature.
      # @return [void]
      # @raise [ArgumentError] when the domain is invalid or restricted.
      def upsert_instance_record(db, attributes, signature)
        sanitized_domain = sanitize_instance_domain(attributes[:domain])
        raise ArgumentError, "invalid domain" unless sanitized_domain

        ip = ip_from_domain(sanitized_domain)
        if ip && restricted_ip_address?(ip)
          raise ArgumentError, "restricted domain"
        end

        normalized_domain = sanitized_domain
        existing_id = with_busy_retry do
          db.get_first_value(
            "SELECT id FROM instances WHERE domain = ?",
            normalized_domain,
          )
        end
        if existing_id && existing_id != attributes[:id]
          with_busy_retry do
            db.execute("DELETE FROM instances WHERE id = ?", existing_id)
          end
          debug_log(
            "Removed conflicting instance by domain",
            context: "federation.instances",
            domain: normalized_domain,
            replaced_id: existing_id,
            incoming_id: attributes[:id],
          )
        end

        sql = <<~SQL
          INSERT INTO instances (
            id, domain, pubkey, name, version, channel, frequency,
            latitude, longitude, last_update_time, is_private, nodes_count,
            meshcore_nodes_count, meshtastic_nodes_count, reticulum_nodes_count,
            contact_link, signature
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            domain=excluded.domain,
            pubkey=excluded.pubkey,
            name=excluded.name,
            version=excluded.version,
            channel=excluded.channel,
            frequency=excluded.frequency,
            latitude=excluded.latitude,
            longitude=excluded.longitude,
            last_update_time=excluded.last_update_time,
            is_private=excluded.is_private,
            nodes_count=COALESCE(excluded.nodes_count, instances.nodes_count),
            meshcore_nodes_count=COALESCE(excluded.meshcore_nodes_count, instances.meshcore_nodes_count),
            meshtastic_nodes_count=COALESCE(excluded.meshtastic_nodes_count, instances.meshtastic_nodes_count),
            reticulum_nodes_count=COALESCE(excluded.reticulum_nodes_count, instances.reticulum_nodes_count),
            contact_link=excluded.contact_link,
            signature=excluded.signature
        SQL

        nodes_count = coerce_integer(attributes[:nodes_count])
        params = [
          attributes[:id],
          normalized_domain,
          attributes[:pubkey],
          attributes[:name],
          attributes[:version],
          attributes[:channel],
          attributes[:frequency],
          attributes[:latitude],
          attributes[:longitude],
          attributes[:last_update_time],
          attributes[:is_private] ? 1 : 0,
          nodes_count,
          coerce_integer(attributes[:meshcore_nodes_count]),
          coerce_integer(attributes[:meshtastic_nodes_count]),
          coerce_integer(attributes[:reticulum_nodes_count]),
          attributes[:contact_link],
          signature,
        ]

        with_busy_retry do
          db.execute(sql, params)
        end
      end
    end
  end
end
