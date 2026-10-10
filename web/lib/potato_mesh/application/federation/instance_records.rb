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

      # Statements that open, close and undo an {#instance_record_transaction}:
      # a transaction of its own, or a savepoint inside the caller's. Rolling
      # back to a savepoint keeps it open, so it is released after.
      INSTANCE_RECORD_FRAMES = {
        transaction: {
          open: "BEGIN IMMEDIATE TRANSACTION",
          close: ["COMMIT TRANSACTION"].freeze,
          undo: ["ROLLBACK TRANSACTION"].freeze,
        }.freeze,
        savepoint: {
          open: "SAVEPOINT instance_record",
          close: ["RELEASE SAVEPOINT instance_record"].freeze,
          undo: ["ROLLBACK TO SAVEPOINT instance_record", "RELEASE SAVEPOINT instance_record"].freeze,
        }.freeze,
      }.freeze

      # Run +block+ as one atomic write on +db+ (SPEC FK1).
      #
      # Without an open transaction on +db+ the block runs in a
      # +BEGIN IMMEDIATE+ transaction, which takes the write lock before the
      # block's first read, so no other connection writes between that read
      # and the block's last write; {#with_busy_retry} runs the whole
      # transaction again while SQLite reports busy. When +db+ already holds
      # a transaction, a nested +BEGIN+ raises, so the block runs in a
      # savepoint inside it and the caller's transaction keeps its own
      # locking and retries. Unless the block returns, every write it made
      # is rolled back: on a raise, and also on a +throw+, a killed thread or
      # a +Timeout+, on which the gem's +Database#transaction+ block commits
      # (its rescue sees none of them). See {#run_instance_record_frame}.
      #
      # @param db [SQLite3::Database] open database handle.
      # @yieldreturn [Object] the block's result.
      # @return [Object] the block's result.
      def instance_record_transaction(db, &block)
        return run_instance_record_frame(db, INSTANCE_RECORD_FRAMES[:savepoint], &block) if db.transaction_active?

        with_busy_retry { run_instance_record_frame(db, INSTANCE_RECORD_FRAMES[:transaction], &block) }
      end

      # Open +frame+ on +db+, run +block+ in it and close it, or undo it
      # unless the block returned (SPEC FK1).
      #
      # Interrupts from other threads (+Thread#kill+, +Thread#raise+,
      # +Timeout+) wait while the frame opens, closes or is undone, and land
      # only while the block runs, inside the +ensure+ that undoes it, so no
      # interrupt leaves a transaction or a savepoint open on the handle.
      # The undo is skipped when SQLite has already ended the transaction
      # (+SQLITE_FULL+, +SQLITE_IOERR+): it would raise and replace the
      # error.
      #
      # @param db [SQLite3::Database] open database handle.
      # @param frame [Hash] one of {INSTANCE_RECORD_FRAMES}.
      # @yieldreturn [Object] the block's result.
      # @return [Object] the block's result.
      def run_instance_record_frame(db, frame, &block)
        Thread.handle_interrupt(Object => :never) do
          opened = false
          closed = false
          begin
            db.execute(frame[:open])
            opened = true
            result = Thread.handle_interrupt(Object => :immediate, &block)
            frame[:close].each { |sql| db.execute(sql) }
            closed = true
            result
          ensure
            frame[:undo].each { |sql| db.execute(sql) } if opened && !closed && db.transaction_active?
          end
        end
      end

      # Persist or refresh a remote instance row, evicting any conflicting
      # entry that already claimed the same domain.
      #
      # The read of the row stored for the domain, its eviction and the
      # insert by id run in one {#instance_record_transaction}, so a failed
      # insert keeps the evicted row, and a concurrent write for the domain
      # waits for the write lock instead of failing on
      # +idx_instances_domain+ (SPEC FK1).
      #
      # @param db [SQLite3::Database] open database handle.
      # @param attributes [Hash] sanitized instance attributes.
      # @param signature [String] base64-encoded signature.
      # @return [void]
      # @raise [ArgumentError] when the domain is invalid or restricted.
      # @raise [SQLite3::Exception] when the write fails; nothing is written.
      def upsert_instance_record(db, attributes, signature)
        sanitized_domain = sanitize_instance_domain(attributes[:domain])
        raise ArgumentError, "invalid domain" unless sanitized_domain

        ip = ip_from_domain(sanitized_domain)
        if ip && restricted_ip_address?(ip)
          raise ArgumentError, "restricted domain"
        end

        normalized_domain = sanitized_domain

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

        replaced_id = instance_record_transaction(db) do
          existing_id = db.get_first_value("SELECT id FROM instances WHERE domain = ?", normalized_domain)
          evict = existing_id && existing_id != attributes[:id]
          db.execute("DELETE FROM instances WHERE id = ?", existing_id) if evict
          db.execute(sql, params)
          existing_id if evict
        end
        return unless replaced_id

        # Logged after the write: a rolled-back eviction removed nothing.
        debug_log(
          "Removed conflicting instance by domain",
          context: "federation.instances",
          domain: normalized_domain,
          replaced_id: replaced_id,
          incoming_id: attributes[:id],
        )
      end
    end
  end
end
