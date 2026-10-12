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
      # Most instance rows this instance keeps, its own row included (SPEC
      # FB4).
      INSTANCE_ROW_LIMIT = 512

      # Most instance rows kept per registrable domain (SPEC FB3).
      REGISTRABLE_DOMAIN_ROW_LIMIT = 3

      # Most domains without a stored row that the lists of one relayer's
      # registrable domain bring into one round of a crawl (SPEC FB6, FB9).
      RELAYER_NEW_DOMAIN_QUOTA = 8

      # Seconds a signed +last_update+ may run ahead of this instance's clock
      # (SPEC FB1).
      LAST_UPDATE_MAX_AHEAD_SECONDS = 3600

      # Statement batches stay well under SQLite's bound-parameter limit.
      EVICTION_BATCH_SIZE = 500

      # Sort value of an unset first verification time: after every set one.
      UNSET_TIME = 9_223_372_036_854_775_807

      # Whether a record's signed +last_update+ runs more than
      # {LAST_UPDATE_MAX_AHEAD_SECONDS} ahead of this instance's clock: the
      # crawl and +POST /api/instances+ refuse such a record (SPEC FB1).
      #
      # @param last_update [Integer, nil] the record's signed update time.
      # @param now [Integer] this instance's clock.
      # @return [Boolean] true when the record must be refused.
      def instance_last_update_ahead?(last_update, now: Time.now.to_i)
        last_update.is_a?(Integer) && last_update > now + LAST_UPDATE_MAX_AHEAD_SECONDS
      end

      # SQL that holds for a row this instance verified within
      # {PotatoMesh::Config.week_seconds}; it binds one cutoff.
      FRESH_ROW_SQL = "(typeof(last_verified_time) = 'integer' AND last_verified_time >= ?)"

      # SQL sort value of a row's first verification time, unset last.
      FIRST_VERIFIED_SQL = "(CASE WHEN typeof(first_verified_time) = 'integer' THEN first_verified_time ELSE #{UNSET_TIME} END)"

      # The keep order as an SQL +ORDER BY+ clause with its parameters (SPEC
      # FB4, FB9): this instance's own row; the rows of the seeds, in the
      # configured order; then every other fresh row (FB2), the
      # longest-standing first, by when this instance first verified it,
      # whether the peer announced itself or was crawled, so a new row never
      # outranks or evicts one known longer; then the rows that are not
      # fresh, by when they were last verified, newest first, a row never
      # verified last. How a row was verified decides only whether it is
      # fresh. The id breaks ties. Times are this instance's clock, and a
      # time that is not an integer counts as unset.
      #
      # @param now [Integer] this instance's clock.
      # @return [Array(String, Array)] the clause and its parameters, in the
      #   order the clause binds them.
      def instance_keep_order(now: Time.now.to_i)
        cutoff = now - PotatoMesh::Config.week_seconds
        seeds = federation_seed_keys
        tiers = ["WHEN id = ? THEN 0"]
        tiers << "WHEN domain IN (#{Array.new(seeds.size, "?").join(", ")}) THEN 1" unless seeds.empty?
        tiers << "WHEN #{FRESH_ROW_SQL} THEN 2"
        clauses = ["CASE #{tiers.join(" ")} ELSE 3 END"]
        clauses << "CASE domain #{seeds.each_index.map { |index| "WHEN ? THEN #{index}" }.join(" ")} END" unless seeds.empty?
        clauses << "CASE WHEN #{FRESH_ROW_SQL} THEN #{FIRST_VERIFIED_SQL} END"
        clauses << "CASE WHEN typeof(last_verified_time) = 'integer' THEN last_verified_time END DESC"
        clauses << "id"
        params = [app_constant(:SELF_INSTANCE_ID), *seeds, cutoff, *seeds, cutoff]
        [clauses.join(", "), params]
      end

      # The order of the fresh rows among the announce targets and the crawl
      # roots (SPEC FB9): longest-standing first, by when this instance first
      # verified each, a row never so recorded last; the id breaks ties.
      ROOT_ORDER_SQL = "#{FIRST_VERIFIED_SQL}, id"

      # The configured seed domains in canonical form (SPEC FB3).
      #
      # @return [Array<String>] canonical, unique seed domains.
      def federation_seed_keys
        PotatoMesh::Config.federation_seed_domains.filter_map { |seed| federation_canonical_domain(seed) }.uniq
      end

      # Delete the rows past the caps on +db+, inside the caller's write
      # (SPEC FB3, FB4, FB10).
      #
      # First every row gets its stored group: a row without one (written by
      # an older version, or inserted directly) is read now, and with +domain+
      # nil every row is read again, as the list may have changed; a row
      # whose domain federation refuses (FB10) is deleted. Then, walking the
      # rows in {#instance_keep_order}, a row is kept while fewer than
      # {REGISTRABLE_DOMAIN_ROW_LIMIT} rows of its registrable domain and
      # fewer than {INSTANCE_ROW_LIMIT} rows in all were kept; every other
      # row is deleted. With +domain+, after a write of that domain's row,
      # only its group is judged against the per-domain limit: the write
      # added no row to any other group.
      #
      # @param db [SQLite3::Database] open handle inside a write transaction.
      # @param domain [String, nil] domain just written, nil to judge every
      #   group.
      # @param now [Integer] this instance's clock.
      # @return [Array<Hash>] the evicted rows: +:id+, +:domain+ and the
      #   +:limit+ that evicted them, +:domain+, +:registrable_domain+ or
      #   +:total+.
      def evict_instances_beyond_caps(db, domain: nil, now: Time.now.to_i)
        order, order_params = instance_keep_order(now: now)
        evicted = settle_instance_groups(db, every: domain.nil?)
        evicted += registrable_domain_overflow(db, domain && federation_registrable_domain(domain), order, order_params)
        if db.get_first_value("SELECT COUNT(*) FROM instances").to_i > INSTANCE_ROW_LIMIT
          over = db.execute("SELECT id, domain FROM instances ORDER BY #{order} LIMIT -1 OFFSET ?", [*order_params, INSTANCE_ROW_LIMIT])
          over = over.map { |id, row_domain| { id: id, domain: row_domain, limit: :total } }
          delete_instance_rows(db, over)
          evicted += over
        end
        evicted
      end

      # Store each row's registrable domain, and delete the rows that have
      # none (SPEC FB3, FB10).
      #
      # @param db [SQLite3::Database] open handle inside a write transaction.
      # @param every [Boolean] true to read every row again, false for the
      #   rows without a stored group only.
      # @return [Array<Hash>] the deleted rows, +:limit+ +:domain+.
      def settle_instance_groups(db, every:)
        sql = "SELECT id, domain, registrable_domain FROM instances"
        sql += " WHERE registrable_domain IS NULL" unless every
        refused = []
        db.execute(sql).each do |id, row_domain, stored|
          group = federation_registrable_domain(row_domain)
          if group.nil?
            refused << { id: id, domain: row_domain, limit: :domain }
          elsif group != stored
            db.execute("UPDATE instances SET registrable_domain = ? WHERE id = ?", [group, id])
          end
        end
        delete_instance_rows(db, refused)
        refused
      end

      # Delete the rows past {REGISTRABLE_DOMAIN_ROW_LIMIT} in their
      # registrable domain, in the keep order (SPEC FB3).
      #
      # @param db [SQLite3::Database] open handle inside a write transaction.
      # @param group [String, nil] the group to judge, nil for every group.
      # @param order [String] the {#instance_keep_order} clause.
      # @param order_params [Array] its parameters.
      # @return [Array<Hash>] the deleted rows: +:id+, +:domain+, +:limit+.
      def registrable_domain_overflow(db, group, order, order_params)
        rows = if group
            db.execute(
              "SELECT id, domain FROM instances WHERE registrable_domain = ? ORDER BY #{order} LIMIT -1 OFFSET ?",
              [group, *order_params, REGISTRABLE_DOMAIN_ROW_LIMIT],
            )
          else
            db.execute(
              "SELECT id, domain FROM (SELECT id, domain, ROW_NUMBER() OVER " \
              "(PARTITION BY registrable_domain ORDER BY #{order}) AS position FROM instances) WHERE position > ?",
              [*order_params, REGISTRABLE_DOMAIN_ROW_LIMIT],
            )
          end
        over = rows.map { |id, row_domain| { id: id, domain: row_domain, limit: :registrable_domain } }
        delete_instance_rows(db, over)
        over
      end

      # Delete +rows+ by id, in batches of {EVICTION_BATCH_SIZE}.
      #
      # @param db [SQLite3::Database] open database handle.
      # @param rows [Array<Hash>] rows carrying an +:id+.
      # @return [void]
      def delete_instance_rows(db, rows)
        rows.each_slice(EVICTION_BATCH_SIZE) do |batch|
          db.execute("DELETE FROM instances WHERE id IN (#{Array.new(batch.size, "?").join(", ")})", batch.map { |row| row[:id] })
        end
      end

      # Log, after the write committed, each row a write evicted.
      #
      # @param evicted [Array<Hash>] the rows {#evict_instances_beyond_caps}
      #   returned.
      # @return [void]
      def log_evicted_instances(evicted)
        evicted.each do |row|
          debug_log(
            "Evicted instance record beyond the caps",
            context: "federation.instances",
            domain: row[:domain],
            instance_id: row[:id],
            limit: row[:limit].to_s,
          )
        end
      end

      # Hold the stored rows to the caps, the rows an older version stored
      # included (SPEC FB3, FB4, FB10). The boot and each announcement cycle
      # run it, so +GET /api/instances+ only reads (SPEC RC4); every write
      # keeps the caps on its own.
      #
      # @return [void]
      def enforce_instance_caps!
        db = open_database
        evicted = instance_record_transaction(db) { evict_instances_beyond_caps(db) }
        return if evicted.empty?

        limits = evicted.map { |row| row[:limit] }.tally
        info_log(
          "Evicted instance records beyond the caps",
          context: "federation.instances",
          evicted: evicted.size,
          unfederated_domain: limits.fetch(:domain, 0),
          registrable_domain_limit: limits.fetch(:registrable_domain, 0),
          total_limit: limits.fetch(:total, 0),
        )
      rescue SQLite3::Exception => e
        warn_log(
          "Failed to evict instance records beyond the caps",
          context: "federation.instances",
          error_class: e.class.name,
          error_message: e.message,
        )
      ensure
        db&.close
      end

      # Record that this instance verified a stored row again with a copy it
      # did not store, the stored copy being at least as new (SPEC FB2): the
      # row's verification time, and for a verified announcement its
      # announcement time, become now.
      #
      # @param db [SQLite3::Database] open database handle.
      # @param attributes [Hash] the verified copy's attributes; the row is
      #   the one stored under its instance id.
      # @param announced [Boolean] whether the copy came by
      #   +POST /api/instances+.
      # @param now [Integer] this instance's clock.
      # @return [void]
      def touch_instance_verification(db, attributes, announced: false, now: Time.now.to_i)
        assignments = announced ? "last_verified_time = ?, last_announced_time = ?" : "last_verified_time = ?"
        params = announced ? [now, now, attributes[:id]] : [now, attributes[:id]]
        with_busy_retry { db.execute("UPDATE instances SET #{assignments} WHERE id = ?", params) }
      end

      # Whether +group+ already holds {REGISTRABLE_DOMAIN_ROW_LIMIT} rows that
      # a new crawled row cannot outrank (SPEC FB9): our own row, the seeds'
      # rows and the fresh rows (FB2), each known longer than a row first
      # verified now.
      #
      # @param db [SQLite3::Database] open database handle.
      # @param group [String] a registrable domain.
      # @param now [Integer] this instance's clock.
      # @return [Boolean] true when a new row of the group would be evicted.
      def registrable_domain_full?(db, group, now: Time.now.to_i)
        seeds = federation_seed_keys
        seeded = seeds.empty? ? "" : " OR domain IN (#{Array.new(seeds.size, "?").join(", ")})"
        count = with_busy_retry do
          db.get_first_value(
            "SELECT COUNT(*) FROM instances WHERE registrable_domain = ? AND (id = ?#{seeded} OR #{FRESH_ROW_SQL})",
            [group, app_constant(:SELF_INSTANCE_ID), *seeds, now - PotatoMesh::Config.week_seconds],
          )
        end
        count.to_i >= REGISTRABLE_DOMAIN_ROW_LIMIT
      end

      # How a crawled record of a domain with no stored row joins the crawl
      # (SPEC FB6, FB9). Its group full (#registrable_domain_full?), it is
      # skipped at once and spends no slot. Otherwise it takes one of the
      # {RELAYER_NEW_DOMAIN_QUOTA} slots that the registrable domain of its
      # relayer holds in the crawl's current round; with none left it waits
      # for the next round. A record for a stored domain needs no slot, a
      # domain listed again keeps its slot, and a record whose id its key
      # does not derive passes to FS9's refusal, which sends nothing.
      #
      # @param db [SQLite3::Database] open database handle.
      # @param crawl [CrawlState] the crawl.
      # @param attributes [Hash] the record's attributes.
      # @param relayed_by [String] domain whose list holds the record.
      # @return [Symbol] +:admit+ to go on with the record's checks,
      #   +:skip+ to drop it, +:defer+ to take it up in the next round.
      def relayer_admission(db, crawl, attributes, relayed_by)
        return :admit unless instance_id_matches_key?(attributes[:id], attributes[:pubkey])
        return :admit if stored_instance_key_and_update(db, attributes[:domain]).first

        domain = attributes[:domain]
        group = federation_registrable_domain(domain)
        if registrable_domain_full?(db, group)
          debug_log(
            "Skipped remote instance entry",
            context: "federation.instances",
            domain: domain,
            reason: "registrable domain #{group} full",
            relayed_by: relayed_by,
          )
          return :skip
        end
        relayer = federation_registrable_domain(relayed_by) || federation_peer_host(relayed_by)
        return :admit if crawl.admit_new_domain(relayer, federation_domain_key(domain))

        debug_log(
          "Deferred remote instance entry",
          context: "federation.instances",
          domain: domain,
          reason: "new-domain quota of #{relayer} spent",
          relayed_by: relayed_by,
        )
        :defer
      end
    end
  end
end
