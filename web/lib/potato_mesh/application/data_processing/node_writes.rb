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

require "json"

module PotatoMesh
  module App
    module DataProcessing
      # Oldest +last_advert_heard+ that still counts as keyed evidence of a
      # live identity (SPEC MR1/MR2).  Bounded by the same four-week window the
      # per-id node API uses, so "still ambiguous" never outlives the horizon a
      # caller can even observe.  A node with no keyed evidence at all
      # (+NULL+ → 0) is always stale by this measure.
      #
      # Single definition shared by the merge helpers here and the #755 startup
      # backfill in +application/database.rb+.
      #
      # @param now [Integer] reference timestamp (injectable for tests).
      # @return [Integer] unix cutoff; evidence at or after it is fresh.
      def self.evidence_cutoff(now: Time.now.to_i)
        now - PotatoMesh::Config.four_weeks_seconds
      end

      # SQL predicate: is this node row *positively known* to be a retired
      # identity (SPEC MR2)?
      #
      # Absence of evidence is not evidence of absence — a +NULL+ here means
      # "nothing observed yet" (a row predating the column, or a node that has
      # not re-advertised since), never "dead". Only a timestamp that exists
      # *and* is older than the evidence window demotes a row. Treating unknown
      # as stale would let the merge fire on a genuinely ambiguous pair, which
      # is exactly the mis-attribution the ambiguity guard exists to prevent.
      #
      # +position_time+ is the fallback signal for rows written before
      # +last_advert_heard+ existed: a MeshCore position is only ever stored
      # from a key-authenticated record (roster contact, advert, self-info) and
      # never from chat text, so it is historical keyed evidence. A node with
      # neither signal stays "unknown" and keeps blocking.
      #
      # +columns+ names the evidence columns actually present on the table under
      # test.  The runtime +nodes+ table always carries both; the one-shot #755
      # startup backfill runs against schemas that may predate +position_time+,
      # so it narrows the list to what the migration has confirmed exists —
      # dropping a column can only make a row *more* likely to stay "unknown"
      # (block), never spuriously stale, so the safe direction is preserved.
      #
      # @param table_alias [String] alias of the +nodes+ row being tested.
      # @param columns [Array<String>] evidence columns to coalesce, newest
      #   authority first; must be non-empty.
      # @return [String] SQL fragment with one +?+ placeholder (the cutoff).
      def self.positively_stale_sql(table_alias, columns: %w[last_advert_heard position_time])
        qualified = columns.map { |column| "#{table_alias}.#{column}" }
        evidence = qualified.length == 1 ? qualified.first : "COALESCE(#{qualified.join(", ")})"
        "(#{evidence} IS NOT NULL AND #{evidence} < ?)"
      end

      # Insert a hidden placeholder node when an unknown reference is encountered.
      #
      # @param db [SQLite3::Database] open database handle.
      # @param node_ref [Object] raw node reference from the inbound payload.
      # @param fallback_num [Integer, nil] numeric fallback when +node_ref+ is nil.
      # @param heard_time [Integer, nil] timestamp to record as +last_heard+/+first_heard+.
      # @param protocol [String] protocol identifier for placeholder generation.
      # @return [Boolean, nil] true when a row was inserted, false/nil otherwise.
      def ensure_unknown_node(db, node_ref, fallback_num = nil, heard_time: nil, protocol: "meshtastic")
        parts = canonical_node_parts(node_ref, fallback_num)
        return unless parts

        node_id, node_num, short_id = parts
        return if broadcast_node_ref?(node_id, node_num)

        existing = db.get_first_value(
          "SELECT 1 FROM nodes WHERE node_id = ? LIMIT 1",
          [node_id],
        )
        return if existing

        # Protocol-scoped so the placeholder matches the badge and the guard
        # that recognises it (see +placeholder_short_id+).
        long_name = "#{protocol_display_label(protocol)} #{placeholder_short_id(node_id, protocol)}"
        # Each protocol falls back to its own base role: CLIENT is a Meshtastic
        # role, so using it everywhere labelled a Meshcore or Reticulum node as
        # something its protocol has no concept of. Meshtastic keeps
        # CLIENT_HIDDEN for synthetic placeholders so they stay off the map
        # until the node is actually heard from.
        default_role = case protocol
          when "meshcore" then "COMPANION"
          when "reticulum" then "PEER"
          else "CLIENT_HIDDEN"
          end
        heard_time = coerce_integer(heard_time)
        inserted = false

        with_busy_retry do
          db.execute(
            <<~SQL,
            INSERT OR IGNORE INTO nodes(node_id,num,short_name,long_name,role,last_heard,first_heard,protocol)
            VALUES (?,?,?,?,?,?,?,?)
          SQL
            [node_id, node_num, short_id, long_name, default_role, heard_time, heard_time, protocol],
          )
          inserted = db.changes.positive?
        end

        if inserted
          debug_log(
            "Created hidden placeholder node",
            context: "data_processing.ensure_unknown_node",
            node_id: node_id,
            reference: node_ref,
            fallback: fallback_num,
            heard_time: heard_time,
          )
        end

        inserted
      end

      # Refresh a node's +last_heard+, +first_heard+, +lora_freq+, and
      # +modem_preset+ columns from a freshly received packet.
      #
      # @param db [SQLite3::Database] open database handle.
      # @param node_ref [Object] raw node reference.
      # @param fallback_num [Integer, nil] numeric fallback when +node_ref+ is nil.
      # @param rx_time [Integer, nil] receive timestamp; the method exits early when nil.
      # @param source [Symbol, nil] originating subsystem (used for debug logs).
      # @param lora_freq [Integer, nil] LoRa frequency; only updated when non-nil.
      # @param modem_preset [String, nil] modem preset name; only updated when non-nil.
      # @param protocol [String, nil] resolved protocol of the record; a row
      #   of another protocol is left alone ({#cross_protocol_write?}), and nil
      #   skips that check.
      # @return [Boolean, nil] true when at least one row was updated; nil
      #   when the write was skipped.
      def touch_node_last_seen(
        db,
        node_ref,
        fallback_num = nil,
        rx_time: nil,
        source: nil,
        lora_freq: nil,
        modem_preset: nil,
        protocol: nil
      )
        timestamp = coerce_integer(rx_time)
        return unless timestamp

        node_id = nil

        parts = canonical_node_parts(node_ref, fallback_num)
        if parts
          node_id, node_num = parts
          return if broadcast_node_ref?(node_id, node_num)
        end

        unless node_id
          trimmed = string_or_nil(node_ref)
          if trimmed
            node_id = normalize_node_id(db, trimmed) || trimmed
          elsif fallback_num
            fallback_parts = canonical_node_parts(fallback_num, nil)
            node_id, = fallback_parts if fallback_parts
          end
        end

        return if broadcast_node_ref?(node_id, fallback_num)
        return unless node_id
        return if cross_protocol_write?(db, node_id, protocol, context: "data_processing.touch_node_last_seen")

        lora_freq = coerce_integer(lora_freq)
        modem_preset = string_or_nil(modem_preset)
        updated = false
        with_busy_retry do
          db.execute <<~SQL, [timestamp, timestamp, timestamp, lora_freq, modem_preset, node_id]
                       UPDATE nodes
                          SET last_heard = CASE
                            WHEN COALESCE(last_heard, 0) >= ? THEN last_heard
                            ELSE ?
                          END,
                              first_heard = COALESCE(first_heard, ?),
                              lora_freq = COALESCE(?, lora_freq),
                              modem_preset = COALESCE(?, modem_preset)
                        WHERE node_id = ?
                     SQL
          updated ||= db.changes.positive?
        end

        if updated
          debug_log(
            "Updated node last seen timestamp",
            context: "data_processing.touch_node_last_seen",
            node_id: node_id,
            timestamp: timestamp,
            source: source || :unknown,
            lora_freq: lora_freq,
            modem_preset: modem_preset,
          )
        end

        updated
      end

      # Read +hash[primary]+, falling back to the first present alias key. Lets the
      # node ingest contract accept snake_case fields in addition to the Meshtastic
      # camelCase the collector emits today; nil-aware so a boolean +false+ from the
      # primary key is never discarded in favour of an alias.
      #
      # @param hash [Object] candidate mapping (ignored unless a Hash).
      # @param primary [String] preferred key.
      # @param aliases [Array<String>] fallback keys, tried in order.
      # @return [Object, nil] first non-nil value, or nil.
      def pick_alias(hash, primary, *aliases)
        return nil unless hash.is_a?(Hash)
        return hash[primary] unless hash[primary].nil?
        aliases.each { |key| return hash[key] unless hash[key].nil? }
        nil
      end

      # Decide whether an incoming node record collides with a stored row of a
      # different protocol and must therefore be skipped (the cross-protocol
      # node-row hijack guard every node-row writer applies through
      # {#cross_protocol_write?}).
      #
      # A stored +"meshtastic"+ value doubles as the schema default stamped on
      # rows ingested before their protocol was known, so a +"meshcore"+
      # record may still reclaim such a row — the established bug #747
      # self-heal that the upsert's +NULLIF(nodes.protocol,'meshtastic')+
      # conflict clause implements, for a row not bound to another key
      # ({#record_under_another_key?}).  Every other differing pairing between
      # two known protocols is a genuine 4-byte id collision across protocols
      # and is rejected.
      #
      # @param stored_protocol [String, nil] protocol currently on the row, or
      #   nil when no row exists yet.
      # @param incoming_protocol [String] resolved protocol of the incoming
      #   record.
      # @return [Boolean] true when the record must be skipped.
      def cross_protocol_conflict?(stored_protocol, incoming_protocol)
        return false unless KNOWN_PROTOCOLS.include?(stored_protocol)
        return false if stored_protocol == incoming_protocol
        return false if stored_protocol == "meshtastic" && incoming_protocol == "meshcore"
        true
      end

      # Record the destination an announce arrived for (SPEC RE2).
      #
      # A Reticulum identity is one +nodes+ row (SPEC RE7) that announces on
      # several destinations -- one per aspect -- each with its own display name
      # and implied role. Each destination is its own +destinations+ row, linked
      # to the node by +node_id+ and to the identity by +identity_hash+;
      # {#refresh_node_identity_from_destinations} derives the node's headline
      # name and role from these rows (SPEC RE10).
      #
      # Supersedes the +nodes.dest_hash+ JSON column: that modelled the same
      # relationship from the node side and could not carry a per-destination
      # name, aspect or role.
      #
      # @param db [SQLite3::Database] open database handle.
      # @param node_id [String] canonical id of the node that owns this destination.
      # @param destination [Object] +destination+ block from the payload.
      # @param identity_hash [String, nil] identity the destination belongs to.
      # @param name [String, nil] display name announced on this destination;
      #   a generic +Reticulum <SHORT>+ placeholder, built from this
      #   destination's own hash or, by an older ingestor, from the node id, is
      #   stored on a first sighting but never replaces a stored name and never
      #   names the node; with no announced name the node keeps a stored name
      #   that is not a placeholder, else reads its own placeholder
      #   ({#reticulum_placeholder_name?}, {#reticulum_headline_name}).
      # @param interface [String, nil] interface the announce was heard on.
      # @param heard [Integer] unix seconds of receipt.
      # @return [void]
      def upsert_destination(db, node_id, destination, identity_hash:, name:, interface:, heard:)
        destination, identity_hash, name, interface = bound_destination_fields(destination, identity_hash, name, interface) # SPEC SL3
        return unless destination.is_a?(Hash)

        id = string_or_nil(destination["id"])&.downcase
        return unless id

        # A generic "Reticulum <SHORT>" placeholder is still worth storing on a
        # first sighting -- it is what the reader sees until a real name turns
        # up -- but it must never *replace* one a real announce supplied. Every
        # nameless destination falls back to one, the host's own whenever the
        # stack remembers no app_data, and letting that land on top of a real
        # name would erase it; if RE10 had picked that name and another aspect
        # announced one, the headline would move to that one. Both placeholder
        # forms count (SPEC RA10).
        stored_name = string_or_nil(name)
        update_name = reticulum_placeholder_name?(stored_name, node_id, id) ? nil : stored_name

        params = [
          id,
          node_id,
          identity_hash,
          stored_name,
          string_or_nil(destination["aspect"]),
          string_or_nil(destination["role"]),
          interface,
          heard,
          heard,
          update_name,
        ]
        with_busy_retry do
          db.execute(<<~SQL, params)
            INSERT INTO destinations(id, node_id, identity_hash, name, aspect, role, interface,
                                     first_heard, last_heard)
            VALUES (?,?,?,?,?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET
              node_id=excluded.node_id,
              identity_hash=COALESCE(excluded.identity_hash, destinations.identity_hash),
              -- ?10 is update_name: NULL when the incoming name is a generic
              -- placeholder, so an existing real name survives it.
              name=COALESCE(?, destinations.name),
              aspect=COALESCE(excluded.aspect, destinations.aspect),
              role=COALESCE(excluded.role, destinations.role),
              interface=COALESCE(excluded.interface, destinations.interface),
              -- first_heard is the earliest sighting; last_heard never regresses.
              first_heard=MIN(COALESCE(destinations.first_heard, excluded.first_heard), excluded.first_heard),
              last_heard=MAX(COALESCE(destinations.last_heard, 0), excluded.last_heard)
          SQL
        end
      end

      # Aspect preference for a Reticulum node's headline name and role.
      #
      # A peer announcing several aspects posts one record per destination, each
      # with its own display name and role, so whichever arrived last would
      # otherwise name the node -- alternating the headline on every announce
      # and churning the row (SPEC RE10). Lower rank wins.
      #
      # Deliberately *not* the RD5 colour ramp order, which sequences a violet
      # gradient; this ranks how well an aspect identifies the peer. A node
      # address names the operator's node, a delivery address names its owner,
      # a propagation store is infrastructure, and the transport instance is an
      # implementation detail of the stack.
      DESTINATION_ROLE_RANK_SQL = <<~SQL.freeze
        CASE role
          WHEN 'NODE' THEN 1
          WHEN 'PEER' THEN 2
          WHEN 'PROPAGATION' THEN 3
          WHEN 'TRANSPORT' THEN 4
          ELSE 5
        END
      SQL

      # Re-derive a Reticulum node's headline name and role from its aspects.
      #
      # Durable by construction: the answer is recomputed from the
      # +destinations+ rows every time one changes, so it survives a restart and
      # agrees across ingestors -- unlike an in-memory rank accumulator, which
      # a restart or a second ingestor hearing only a lower aspect could demote
      # (the follow-up SPEC RD4 recorded as a known limitation).
      #
      # +name+ and +role+ are resolved independently: an aspect can carry a role
      # while announcing no display name, and taking both from one row would let
      # a nameless top-ranked aspect blank the headline. A placeholder is not a
      # name either (SPEC RE10 as amended): the name is the best-ranked
      # *announced* one, else a stored name that is not a placeholder, else the
      # node's own placeholder ({#reticulum_headline_name}). Ties break on the
      # more recently heard destination.
      #
      # Only destinations of the identity the row is bound to count (SPEC
      # NI3): after a new identity takes a stale row over, the earlier
      # identity's destination rows stay under the same node id until they age
      # out, and must not name the node.  A row with no identity hash reads
      # all of its destinations.
      #
      # @param db [SQLite3::Database] open database handle.
      # @param node_id [String] canonical id of the node to refresh.
      # @return [void]
      def refresh_node_identity_from_destinations(db, node_id)
        rank = DESTINATION_ROLE_RANK_SQL
        own_destinations = "node_id = ? AND (? IS NULL OR identity_hash = ?)"
        with_busy_retry do
          identity = db.get_first_value("SELECT identity_hash FROM nodes WHERE node_id = ?", [node_id])
          scope = [node_id, identity, identity]
          destinations = db.execute(<<~SQL, scope).map { |row| row.is_a?(Hash) ? row.values_at("id", "name") : row }
            SELECT id, name FROM destinations WHERE #{own_destinations}
            ORDER BY #{rank}, COALESCE(last_heard, 0) DESC
          SQL
          stored = db.get_first_value("SELECT long_name FROM nodes WHERE node_id = ?", [node_id])
          headline = reticulum_headline_name(node_id, destinations, stored)
          db.execute(<<~SQL, [headline, *scope, node_id])
            UPDATE nodes SET
              long_name = COALESCE(?, long_name),
              role = COALESCE((
                SELECT role FROM destinations
                WHERE #{own_destinations} AND role IS NOT NULL
                ORDER BY #{rank}, COALESCE(last_heard, 0) DESC LIMIT 1
              ), role)
            WHERE node_id = ? AND protocol = 'reticulum'
          SQL
        end
      end

      # Insert or update a node row from an inbound NodeInfo-style payload.
      #
      # Two-phase write. Phase one is the freshness-guarded upsert: a record
      # whose +lastHeard+ is older than the stored row cannot change
      # timestamps, telemetry, or position. Phase two fills identity columns
      # (+num+, +short_name+, +long_name+, +macaddr+, +hw_model+, +role+,
      # +public_key+, +is_unmessagable+) that are still NULL, regardless of the
      # record's staleness — a stale-but-richer record (e.g. a MeshCore roster
      # contact stamped with the sender-side +last_advert+, which is always
      # older than the wall-clock +lastHeard+ of the bare-advert placeholder
      # that created the row) still names the node instead of being discarded
      # wholesale, which produced permanently unnamed "ghost" nodes
      # (ACCEPTANCE GH-A1). Synthetic chat placeholders never touch real rows
      # in either phase.
      #
      # A stored row is bound to its key (SPEC NI2, NI3,
      # {#record_under_another_key?}).  A record under another key, or under
      # none, changes neither phase's identity columns, nor the position,
      # protocol, destinations, keyed evidence or synthetic merges, so it can
      # neither rename the node nor add or remove its opt-out marker; it still
      # refreshes +last_heard+, telemetry and signal fields like any record.
      #
      # @param db [SQLite3::Database] open database handle.
      # @param node_id [String] canonical node identifier.
      # @param n [Hash] node payload extracted from the ingestor.
      # @param protocol [String] protocol identifier (default +meshtastic+).
      # @return [void]
      def upsert_node(db, node_id, n, protocol: "meshtastic")
        n = bound_node_payload(n) # SPEC SL3/SL10: bounded, Prometheus labels and gauges included
        user = n["user"] || {}
        met = pick_alias(n, "deviceMetrics", "device_metrics") || {}
        pos = n["position"] || {}
        # nil when user info absent; COALESCE in the conflict clause preserves
        # the stored role rather than overwriting with a default.
        role = user["role"]
        # Proto3 omits an enum field at its zero value, and Meshtastic's
        # CLIENT role is 0, so a Meshtastic record that carries a user but no
        # role names a CLIENT.  It replaces the CLIENT_HIDDEN placeholder
        # +ensure_unknown_node+ gives a node first heard through other packets
        # (SPEC NI5, RA9).  The meshtastic library's stand-in for a node whose
        # NodeInfo it never received is no such user: it writes
        # +hwModel: "UNSET"+, a zero enum the protobuf JSON mapping omits, and
        # says nothing about the role, so the stored role stays.
        if role.nil? && protocol == "meshtastic" && n["user"].is_a?(Hash) &&
           pick_alias(user, "hwModel", "hw_model") != "UNSET"
          role = "CLIENT"
        end
        lh = coerce_integer(pick_alias(n, "lastHeard", "last_heard"))
        now = Time.now.to_i
        # Issue #782: drop Meshtastic "no GPS lock" sentinels at the write
        # boundary so neither the nodes row nor downstream readers ever see
        # a `position_time = 0` epoch leak.  +normalize_position_time+ also
        # absorbs future-dated clock-skew values.
        pt = normalize_position_time(pos["time"], now: now)
        lh = now if lh && lh > now
        # 0 is truthy in Ruby — `lh ||= now` won't replace it, leaving the
        # 7-day list filter to evaluate `0 >= now-7days` → false (node hidden).
        lh = nil if lh && lh <= 0
        # position.time = 0 means no GPS fix; skip it as a last_heard anchor
        # (would re-introduce the same zero-timestamp exclusion bug for lh).
        lh = pt if pt && pt > 0 && (!lh || lh < pt)
        lh ||= now
        # Issue #782: paired `(lat=0, lon=0)` is the firmware Null Island
        # sentinel; collapse to NULL on both axes (and drop altitude /
        # locationSource which would otherwise be meaningless).  Single-axis
        # zero on the equator / prime meridian is preserved.
        lat, lon = normalize_lat_lon(pos["latitude"], pos["longitude"])
        if lat.nil? && lon.nil?
          alt = nil
          loc_source = nil
        else
          alt = pos["altitude"]
          loc_source = pick_alias(pos, "locationSource", "location_source")
        end
        node_num = resolve_node_num(node_id, n)
        # A record's number is its own node's (SPEC NI1): a NodeInfo-format
        # payload can carry any +num+, and one naming another node would give
        # two rows that number for the numeric lookups and opt-out filters.
        node_num = resolve_node_num(node_id, {}) if names_another_node?(node_num, node_id)

        # Cross-protocol node-row hijack guard.  +nodes.node_id+ is a global
        # TEXT primary key shared by every protocol's id mapping, and both the
        # MeshCore and Reticulum mappings truncate a native identifier to its
        # first 4 bytes — so two nodes on *different* protocols can collide on
        # one +node_id+.  Without this guard the colliding record would pass
        # the freshness guard below (Reticulum announces stamp a wall-clock
        # +lastHeard+) and overwrite the stored row's fields wholesale, with
        # the row's protocol either flipped or silently mismatched.  Skip such
        # records entirely; neither row's data may corrupt the other's.  A
        # stored default-'meshtastic' row may still be reclaimed by a meshcore
        # record (the #747 self-heal preserved by +cross_protocol_conflict?+),
        # unless the row is bound to a key (below).
        return if cross_protocol_write?(db, node_id, protocol, context: "data_processing.upsert_node")

        # Same-protocol prefix collisions, and a NodeInfo naming a node it did
        # not come from, are held off by the key binding (SPEC NI2, NI3): a
        # record under another key leaves the row's identity as stored.
        key_mismatch = record_under_another_key?(db, node_id, n, protocol)

        # The prometheus helper still receives the raw `pos` so that gauges
        # not affected by sentinel handling (e.g. precision_bits) keep
        # updating; the latitude/longitude guards inside +update_prometheus_metrics+
        # are responsible for skipping sentinel coordinates.  A record under
        # another key reaches only the telemetry gauges.
        update_prometheus_metrics(node_id, key_mismatch ? nil : user, role, met, key_mismatch ? nil : pos)

        lora_freq = coerce_integer(n["lora_freq"] || n["loraFrequency"])
        modem_preset = string_or_nil(n["modem_preset"] || n["modemPreset"])
        # Synthetic flag: true for placeholder nodes created from channel message
        # sender names before the real contact advertisement is received.
        synthetic = user["synthetic"] ? 1 : 0
        long_name = pick_alias(user, "longName", "long_name")
        short_name = pick_alias(user, "shortName", "short_name")
        macaddr = user["macaddr"]
        hw_model = pick_alias(user, "hwModel", "hw_model") || pick_alias(n, "hwModel", "hw_model")
        public_key = pick_alias(user, "publicKey", "public_key")
        is_unmessagable = coerce_bool(pick_alias(user, "isUnmessagable", "is_unmessagable"))
        # Keyed evidence (SPEC MR1): this record proves the node was heard via
        # its public key, as opposed to being inferred from a chat display
        # name.  Only such records may stamp +last_advert_heard+, which is what
        # lets the merge guards tell a live node from a retired identity that
        # name-inferred message touches keep superficially "fresh".  A record
        # under another key is no evidence for this row's identity.
        keyed_evidence_time = (synthetic.zero? && !key_mismatch && string_or_nil(public_key)) ? lh : nil

        # If the incoming long name is a generic placeholder, prefer any real
        # name already on record so we never stomp known data with fallback
        # text.  For new nodes there is nothing to preserve, so the generic
        # name is still written via the INSERT VALUES path.  A Reticulum
        # record's name lands on its destination, so its placeholder may be
        # built from the destination's own hash rather than the node id
        # (SPEC RA10); both forms yield.
        destination = n["destination"]
        generic_long_name = if protocol == "reticulum"
            reticulum_placeholder_name?(long_name, node_id, destination.is_a?(Hash) ? destination["id"] : nil)
          else
            generic_fallback_name?(long_name, node_id, protocol)
          end
        long_name_conflict_sql = if generic_long_name
            # Generic placeholder: keep any real name already on record.
            # COALESCE returns nodes.long_name when non-null, otherwise falls
            # back to the incoming generic — so brand-new nodes still get it.
            "COALESCE(nodes.long_name, excluded.long_name)"
          else
            # Real name (or nil): use the incoming value, preserving the
            # existing name only when the incoming value is nil.  A nil
            # long_name in the packet carries no information, so falling back
            # to what we already have is better than overwriting with NULL.
            "COALESCE(excluded.long_name, nodes.long_name)"
          end

        identity_hash = string_or_nil(pick_alias(n, "identityHash", "identity_hash"))&.downcase

        # The identity and position columns, and the protocol, follow the
        # record only when it is under the row's key (SPEC NI2).  On a
        # mismatch the conflict clause leaves them out, and SQLite's DO UPDATE
        # keeps every column it does not assign.
        identity_sql = if key_mismatch
            ""
          else
            <<~SQL
              num=COALESCE(excluded.num, nodes.num),
              short_name=COALESCE(excluded.short_name, nodes.short_name),
              long_name=#{long_name_conflict_sql},
              macaddr=COALESCE(excluded.macaddr, nodes.macaddr),
              hw_model=COALESCE(excluded.hw_model, nodes.hw_model),
              role=COALESCE(excluded.role, nodes.role),
              public_key=COALESCE(excluded.public_key, nodes.public_key),
              identity_hash=COALESCE(excluded.identity_hash, nodes.identity_hash),
              is_unmessagable=COALESCE(excluded.is_unmessagable, nodes.is_unmessagable),
              position_time=COALESCE(excluded.position_time, nodes.position_time),
              location_source=COALESCE(excluded.location_source, nodes.location_source),
              precision_bits=COALESCE(excluded.precision_bits, nodes.precision_bits),
              latitude=COALESCE(excluded.latitude, nodes.latitude),
              longitude=COALESCE(excluded.longitude, nodes.longitude),
              altitude=COALESCE(excluded.altitude, nodes.altitude),
              protocol=COALESCE(NULLIF(nodes.protocol,'meshtastic'), excluded.protocol),
            SQL
          end

        row = [
          node_id,
          node_num,
          short_name,
          long_name,
          macaddr,
          hw_model,
          role,
          public_key,
          is_unmessagable,
          coerce_bool(pick_alias(n, "isFavorite", "is_favorite")),
          pick_alias(n, "hopsAway", "hops_away"),
          n["snr"],
          n["rssi"],
          lh,
          lh,
          pick_alias(met, "batteryLevel", "battery_level"),
          met["voltage"],
          pick_alias(met, "channelUtilization", "channel_utilization"),
          pick_alias(met, "airUtilTx", "air_util_tx"),
          pick_alias(met, "uptimeSeconds", "uptime_seconds"),
          pt,
          loc_source,
          coerce_integer(
            pos["precisionBits"] ||
              pos["precision_bits"] ||
              pos.dig("raw", "precision_bits"),
          ),
          lat,
          lon,
          alt,
          lora_freq,
          modem_preset,
          protocol,
          synthetic,
          identity_hash,
        ]
        with_busy_retry do
          db.transaction do
            db.execute(<<~SQL, row)
              INSERT INTO nodes(node_id,num,short_name,long_name,macaddr,hw_model,role,public_key,is_unmessagable,is_favorite,
                                hops_away,snr,rssi,last_heard,first_heard,battery_level,voltage,channel_utilization,air_util_tx,uptime_seconds,
                                position_time,location_source,precision_bits,latitude,longitude,altitude,lora_freq,modem_preset,protocol,synthetic,identity_hash)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(node_id) DO UPDATE SET
                #{identity_sql}is_favorite=excluded.is_favorite, hops_away=excluded.hops_away, snr=excluded.snr, last_heard=excluded.last_heard,
                rssi=COALESCE(excluded.rssi, nodes.rssi),
                first_heard=COALESCE(nodes.first_heard, excluded.first_heard, excluded.last_heard),
                battery_level=excluded.battery_level, voltage=excluded.voltage, channel_utilization=excluded.channel_utilization,
                air_util_tx=excluded.air_util_tx, uptime_seconds=excluded.uptime_seconds,
                lora_freq=excluded.lora_freq, modem_preset=excluded.modem_preset,
                synthetic=MIN(COALESCE(excluded.synthetic,1), COALESCE(nodes.synthetic,1))
              WHERE COALESCE(excluded.last_heard,0) >= COALESCE(nodes.last_heard,0)
                AND NOT (COALESCE(nodes.synthetic,0) = 0 AND excluded.synthetic = 1)
            SQL

            # Ghost-node repair (GH-A1): the guard above skips records whose
            # last_heard is older than the stored row — correct for timestamps,
            # telemetry, and position, but it also starved identity data. A
            # MeshCore roster contact is stamped with the sender-side
            # last_advert, which is always older than the wall-clock lastHeard
            # of the bare-advert placeholder that created the row, so the
            # name/role/public key never landed and the node stayed a
            # permanently unnamed ghost. Fill identity columns that are still
            # NULL from any non-synthetic record regardless of staleness: gaps
            # get filled, fresher values are never regressed, and synthetic
            # chat placeholders remain barred from real rows. NULLIF keeps
            # empty strings — a MeshCore contact may carry an empty adv_name,
            # and shortName is guarded the same way — from filling
            # long_name/short_name with blank text.  A record under another
            # key fills nothing: the gaps belong to the row's own identity.
            if synthetic.zero? && !key_mismatch
              db.execute(<<~SQL, [node_num, short_name, long_name, macaddr, hw_model, role, public_key, is_unmessagable, node_id])
                UPDATE nodes SET
                  num=COALESCE(num, ?),
                  short_name=COALESCE(short_name, NULLIF(?, '')),
                  long_name=COALESCE(long_name, NULLIF(?, '')),
                  macaddr=COALESCE(macaddr, ?),
                  hw_model=COALESCE(hw_model, ?),
                  role=COALESCE(role, ?),
                  public_key=COALESCE(public_key, ?),
                  is_unmessagable=COALESCE(is_unmessagable, ?)
                WHERE node_id = ?
              SQL
            end

            # Destination row (SPEC RE-A5).  Deliberately outside the upsert's
            # freshness guard, like the keyed-evidence stamp below: a second
            # ingestor posting an older announce still carries a destination the
            # first never heard, and dropping it would lose the relationship the
            # table exists to record.  A record under another identity adds no
            # destination to this node and leaves its headline alone (SPEC NI3).
            if synthetic.zero? && !key_mismatch
              upsert_destination(
                db, node_id, n["destination"],
                identity_hash: identity_hash,
                name: long_name,
                interface: string_or_nil(n["interface"]),
                heard: lh,
              )
              # The headline fields follow the ranked aspect, not the announce
              # that happened to arrive last (SPEC RE10). Only a Reticulum node
              # has destinations, so no other protocol pays for the lookups.
              refresh_node_identity_from_destinations(db, node_id) if protocol == "reticulum"
            end

            # Keyed-evidence stamp (SPEC MR1).  Deliberately a separate,
            # forward-only statement rather than a column in the upsert above:
            # that statement's freshness guard skips any record older than the
            # stored +last_heard+, and a node whose +last_heard+ was pushed to
            # "now" by message touches would therefore never record evidence
            # from its own (sender-side-stamped, hence older) adverts — the
            # very situation the evidence column exists to resolve.  It stamps
            # only a row that holds the record's key once the writes above
            # ran: a takeover record older than the row's +last_heard+ writes
            # no identity, and its evidence would keep the earlier key's row
            # looking live, so the new key could never take over (SPEC NI2).
            if keyed_evidence_time
              db.execute(
                "UPDATE nodes SET last_advert_heard = ? " \
                "WHERE node_id = ? AND COALESCE(last_advert_heard, 0) < ? AND public_key = ?",
                [keyed_evidence_time, node_id, keyed_evidence_time, public_key],
              )
            end

            # Reconcile synthetic placeholder rows with their real counterparts
            # whenever a MeshCore node is upserted.  Both directions must fire —
            # the arrival order of chat messages vs contact advertisements is
            # not guaranteed and may differ across co-operating ingestors that
            # share this database.  See issue #755.  A record under another
            # key merges nothing: its name is not this row's (SPEC NI3).
            if !key_mismatch && protocol == "meshcore" && long_name && !long_name.empty?
              if synthetic == 0
                merge_synthetic_nodes(db, node_id, long_name)
              else
                merge_into_real_node(db, node_id, long_name)
              end
            end
          end
        end
      end

      # Migrate messages from synthetic placeholder nodes to a newly confirmed
      # real node, then remove the placeholders.
      #
      # Called inside a transaction from +upsert_node+ when a real (non-synthetic)
      # MeshCore node with the same +long_name+ is upserted.
      #
      # Only +messages.from_id+ is migrated.  Synthetic nodes are placeholders
      # created solely from parsed channel message sender names, so they cannot
      # have associated positions, telemetry, neighbors, or traces — those tables
      # are intentionally left untouched.
      #
      # @param db [SQLite3::Database] open database connection.
      # @param real_node_id [String] canonical node ID for the real contact.
      # @param long_name [String] long name to match against synthetic rows.
      # @return [void]
      def merge_synthetic_nodes(db, real_node_id, long_name)
        # long_name is user-editable and not unique across pubkeys — two real
        # meshcore devices can legitimately share the same display name.  When
        # that happens we cannot tell which real node a given chat-derived
        # synthetic was acting as placeholder for, so any merge would risk
        # mis-attributing messages.  Bail out and leave the synthetic intact.
        #
        # The ambiguity is bounded by keyed evidence (SPEC MR2): a rival stops
        # blocking only once it is *positively known* to be retired — an old
        # keypair some roster still name-resolves, kept superficially "fresh"
        # by message touches, which is what left one physical node showing up
        # as three rows.  A rival with no evidence either way still blocks.
        other_real = db.execute(
          "SELECT 1 FROM nodes WHERE long_name = ? AND synthetic = 0 AND protocol = 'meshcore' AND node_id != ? " \
          "AND NOT #{DataProcessing.positively_stale_sql("nodes")} LIMIT 1",
          [long_name, real_node_id, DataProcessing.evidence_cutoff],
        ).first
        return if other_real

        synthetic_ids = db.execute(
          "SELECT node_id FROM nodes WHERE long_name = ? AND synthetic = 1 AND protocol = 'meshcore' AND node_id != ?",
          [long_name, real_node_id],
        ).map { |row| row.is_a?(Hash) ? row["node_id"] : row[0] }

        synthetic_ids.each do |synthetic_id|
          db.execute(
            "UPDATE messages SET from_id = ? WHERE from_id = ?",
            [real_node_id, synthetic_id],
          )
          carry_last_heard_to_real_node(db, synthetic_id, real_node_id)
          db.execute(
            "DELETE FROM nodes WHERE node_id = ? AND synthetic = 1",
            [synthetic_id],
          )
        end
      end

      # Reverse of +merge_synthetic_nodes+: when a synthetic placeholder is
      # upserted for a MeshCore sender whose real contact advertisement has
      # already been stored (e.g. by a co-operating ingestor that saw the
      # advertisement first), migrate any messages from the synthetic id to the
      # real id and drop the synthetic row.
      #
      # Fixes duplication bug #755 where a chat-derived synthetic node and a
      # pubkey-derived real node coexisted because the forward merge only fired
      # on real-node upserts and never back-filled late-arriving synthetics.
      #
      # Only a stored placeholder is folded (SPEC GN2).  A synthetic-flagged
      # record for an id whose row is real is blocked by the +upsert_node+
      # guard, and merging it would move that real node's messages and
      # +last_heard+ onto a same-name sibling (issue #883), so it is a no-op.
      #
      # @param db [SQLite3::Database] open database connection.
      # @param synthetic_node_id [String] canonical node ID of the synthetic placeholder being upserted.
      # @param long_name [String] long name to match against existing real rows.
      # @return [void]
      def merge_into_real_node(db, synthetic_node_id, long_name)
        return unless db.get_first_value(
          "SELECT 1 FROM nodes WHERE node_id = ? AND synthetic = 1 LIMIT 1",
          [synthetic_node_id],
        )

        # Read the single node_id column shape-robustly (see the +row.is_a?(Hash)+
        # guard below): a +results_as_hash = true+ handle yields plain Hash rows
        # with string keys only under sqlite3 2.x, where integer indexing (+row[0]+)
        # returns nil — sqlite3 1.x uniquely allowed both integer and string keys.
        real_rows = db.execute(
          "SELECT node_id FROM nodes WHERE long_name = ? AND synthetic = 0 AND protocol = 'meshcore' AND node_id != ? LIMIT 2",
          [long_name, synthetic_node_id],
        )
        # Ambiguous name: two distinct real meshcore devices share this
        # long_name.  The synthetic placeholder could legitimately represent
        # either, so we cannot pick one without risking mis-attribution.
        #
        # Keyed evidence disambiguates the common case (SPEC MR2): when every
        # rival but one is *positively known* to be retired, the survivor is
        # the merge target.  Anything else — two live candidates, or candidates
        # we simply know nothing about — stays genuinely ambiguous, so the
        # synthetic is left in place for an operator to resolve.
        if real_rows.length > 1
          live_rows = db.execute(
            "SELECT node_id FROM nodes WHERE long_name = ? AND synthetic = 0 AND protocol = 'meshcore' AND node_id != ? " \
            "AND NOT #{DataProcessing.positively_stale_sql("nodes")} LIMIT 2",
            [long_name, synthetic_node_id, DataProcessing.evidence_cutoff],
          )
          return unless live_rows.length == 1

          real_rows = live_rows
        end

        row = real_rows.first
        return unless row

        real_node_id = row.is_a?(Hash) ? row["node_id"] : row[0]
        return unless real_node_id

        db.execute(
          "UPDATE messages SET from_id = ? WHERE from_id = ?",
          [real_node_id, synthetic_node_id],
        )
        carry_last_heard_to_real_node(db, synthetic_node_id, real_node_id)
        db.execute(
          "DELETE FROM nodes WHERE node_id = ? AND synthetic = 1",
          [synthetic_node_id],
        )
      end

      # Advance a real node's +last_heard+ to a merged synthetic placeholder's
      # value when the placeholder was heard more recently, so a node heard only
      # via MeshCore channel chat keeps a fresh "last seen" after its contact
      # advertisement reconciles the placeholder (issues #803 / #755).  +MAX+
      # makes the carry forward-only — the merge can never move +last_heard+
      # backward — and a missing/already-deleted synthetic row (subquery yields
      # NULL → 0) leaves the real node untouched.  Must run *before* the synthetic
      # row is deleted so the subquery can still read it.
      #
      # @param db [SQLite3::Database] open database connection.
      # @param synthetic_node_id [String] node id of the synthetic being merged away.
      # @param real_node_id [String] node id of the surviving real contact.
      # @return [void]
      def carry_last_heard_to_real_node(db, synthetic_node_id, real_node_id)
        db.execute(
          "UPDATE nodes SET last_heard = MAX(COALESCE(last_heard, 0), " \
          "COALESCE((SELECT last_heard FROM nodes WHERE node_id = ?), 0)) " \
          "WHERE node_id = ?",
          [synthetic_node_id, real_node_id],
        )
      end

      # Update node row columns from a freshly observed position record.
      #
      # @param db [SQLite3::Database] open database handle.
      # @param node_id [String, nil] canonical node identifier.
      # @param node_num [Integer, nil] numeric node identifier.
      # @param rx_time [Integer, nil] receive time.
      # @param position_time [Integer, nil] timestamp from the position payload.
      # @param location_source [String, nil] +location_source+ enum value.
      # @param precision_bits [Integer, nil] horizontal precision bits.
      # @param latitude [Float, nil] decoded latitude.
      # @param longitude [Float, nil] decoded longitude.
      # @param altitude [Float, nil] decoded altitude.
      # @param snr [Float, nil] signal-to-noise ratio.
      # @param protocol [String, nil] resolved protocol of the record; a row
      #   of another protocol is left alone ({#cross_protocol_write?}), and nil
      #   skips that check.
      # @return [void]
      def update_node_from_position(db, node_id, node_num, rx_time, position_time, location_source, precision_bits, latitude, longitude, altitude, snr, protocol: nil)
        num = coerce_integer(node_num)
        id = string_or_nil(node_id)
        if id&.start_with?("!")
          id = "!#{id.delete_prefix("!").downcase}"
        end
        id ||= format("!%08x", num & 0xFFFFFFFF) if num
        return unless id
        return if cross_protocol_write?(db, id, protocol, context: "data_processing.update_node_from_position")

        now = Time.now.to_i
        rx = coerce_integer(rx_time) || now
        rx = now if rx && rx > now
        # Issue #782: drop Meshtastic "no GPS lock" sentinels at the write
        # boundary so a sentinel position update can never overwrite a real
        # fix via the position-time tie-break below.
        pos_time = normalize_position_time(position_time, now: now)
        last_heard = [rx, pos_time].compact.max || rx
        last_heard = now if last_heard && last_heard > now

        loc = string_or_nil(location_source)
        lat, lon = normalize_lat_lon(latitude, longitude)
        # Drop altitude when the coordinate pair collapsed; altitude alone
        # without coordinates is meaningless and would otherwise carry a
        # sentinel `0.0` past this gate.
        alt = (lat.nil? && lon.nil?) ? nil : coerce_float(altitude)
        # Likewise, an upsert with no coordinates should not refresh the
        # location source — keep whatever the row already had.
        loc = nil if lat.nil? && lon.nil?
        precision = coerce_integer(precision_bits)
        snr_val = coerce_float(snr)

        update_prometheus_metrics(node_id, nil, nil, nil, {
          "latitude" => lat,
          "longitude" => lon,
          "altitude" => alt,
        })

        # When a position packet carries real coordinates but no usable
        # `position_time` (either omitted or collapsed by the sentinel guard
        # above), the `excluded.position_time IS NOT NULL` clauses below would
        # otherwise reject the entire update.  Mirror the MeshCore handler
        # (`protocols/meshcore/position.py:65`) and substitute the receive
        # time so the new fix still wins the freshness tie-break.  We only
        # do this when there *are* coordinates to write — otherwise the
        # bound timestamp would persist a synthetic anchor on a no-op row.
        bound_pos_time = pos_time
        bound_pos_time = rx if pos_time.nil? && (!lat.nil? || !lon.nil?)

        row = [
          id,
          num,
          last_heard,
          last_heard,
          bound_pos_time,
          loc,
          precision,
          lat,
          lon,
          alt,
          snr_val,
        ]
        # The CASE guards below previously read
        # `COALESCE(excluded.position_time,0) >= COALESCE(nodes.position_time,0)`,
        # which let a sentinel `0` excluded value win the comparison whenever
        # the stored value was also `NULL` (coalesces to `0`).  After
        # normalisation, sentinel inputs collapse to `NULL`, so we require an
        # explicit `IS NOT NULL` to authorise the overwrite — a normalised-nil
        # excluded value is never preferred over real stored data.  See #782.
        with_busy_retry do
          db.execute <<~SQL, row
                       INSERT INTO nodes(node_id,num,last_heard,first_heard,position_time,location_source,precision_bits,latitude,longitude,altitude,snr)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?)
                       ON CONFLICT(node_id) DO UPDATE SET
                         num=COALESCE(excluded.num,nodes.num),
                         snr=COALESCE(excluded.snr,nodes.snr),
                         last_heard=MAX(COALESCE(nodes.last_heard,0),COALESCE(excluded.last_heard,0)),
                         first_heard=COALESCE(nodes.first_heard, excluded.first_heard, excluded.last_heard),
                         position_time=CASE
                           WHEN excluded.position_time IS NOT NULL
                                AND excluded.position_time >= COALESCE(nodes.position_time,0)
                             THEN excluded.position_time
                           ELSE nodes.position_time
                         END,
                         location_source=CASE
                           WHEN excluded.position_time IS NOT NULL
                                AND excluded.position_time >= COALESCE(nodes.position_time,0)
                                AND excluded.location_source IS NOT NULL
                             THEN excluded.location_source
                           ELSE nodes.location_source
                         END,
                         precision_bits=CASE
                           WHEN excluded.position_time IS NOT NULL
                                AND excluded.position_time >= COALESCE(nodes.position_time,0)
                                AND excluded.precision_bits IS NOT NULL
                             THEN excluded.precision_bits
                           ELSE nodes.precision_bits
                         END,
                         latitude=CASE
                           WHEN excluded.position_time IS NOT NULL
                                AND excluded.position_time >= COALESCE(nodes.position_time,0)
                                AND excluded.latitude IS NOT NULL
                             THEN excluded.latitude
                           ELSE nodes.latitude
                         END,
                         longitude=CASE
                           WHEN excluded.position_time IS NOT NULL
                                AND excluded.position_time >= COALESCE(nodes.position_time,0)
                                AND excluded.longitude IS NOT NULL
                             THEN excluded.longitude
                           ELSE nodes.longitude
                         END,
                         altitude=CASE
                           WHEN excluded.position_time IS NOT NULL
                                AND excluded.position_time >= COALESCE(nodes.position_time,0)
                                AND excluded.altitude IS NOT NULL
                             THEN excluded.altitude
                           ELSE nodes.altitude
                         END
                     SQL
        end
      end

      # Update node columns based on metrics included in a telemetry packet.
      #
      # @param db [SQLite3::Database] open database handle.
      # @param node_id [String, nil] canonical node identifier.
      # @param node_num [Integer, nil] numeric node identifier.
      # @param rx_time [Integer, nil] receive time used as +last_heard+.
      # @param metrics [Hash] decoded telemetry metric map.
      # @param lora_freq [Integer, nil] optional LoRa frequency.
      # @param modem_preset [String, nil] optional modem preset.
      # @param protocol [String] protocol identifier (default +meshtastic+);
      #   a row of another protocol is left alone ({#cross_protocol_write?}).
      # @return [void]
      def update_node_from_telemetry(
        db,
        node_id,
        node_num,
        rx_time,
        metrics = {},
        lora_freq: nil,
        modem_preset: nil,
        protocol: "meshtastic"
      )
        num = coerce_integer(node_num)
        id = string_or_nil(node_id)
        if id&.start_with?("!")
          id = "!#{id.delete_prefix("!").downcase}"
        end
        id ||= format("!%08x", num & 0xFFFFFFFF) if num
        return unless id
        return if cross_protocol_write?(db, id, protocol, context: "data_processing.update_node_from_telemetry")

        ensure_unknown_node(db, id, num, heard_time: rx_time, protocol: protocol)
        touch_node_last_seen(
          db,
          id,
          num,
          rx_time: rx_time,
          source: :telemetry,
          lora_freq: lora_freq,
          modem_preset: modem_preset,
        )

        battery = coerce_float(metrics[:battery_level] || metrics["battery_level"])
        voltage = coerce_float(metrics[:voltage] || metrics["voltage"])
        channel_util = coerce_float(metrics[:channel_utilization] || metrics["channel_utilization"])
        air_util_tx = coerce_float(metrics[:air_util_tx] || metrics["air_util_tx"])
        uptime = coerce_integer(metrics[:uptime_seconds] || metrics["uptime_seconds"])

        update_prometheus_metrics(node_id, nil, nil, {
          "batteryLevel" => battery,
          "voltage" => voltage,
          "uptimeSeconds" => uptime,
          "channelUtilization" => channel_util,
          "airUtilTx" => air_util_tx,
        }, nil)

        assignments = []
        params = []

        if num
          assignments << "num = ?"
          params << num
        end

        metric_updates = {
          "battery_level" => battery,
          "voltage" => voltage,
          "channel_utilization" => channel_util,
          "air_util_tx" => air_util_tx,
          "uptime_seconds" => uptime,
        }

        metric_updates.each do |column, value|
          next if value.nil?

          assignments << "#{column} = ?"
          params << value
        end

        return if assignments.empty?

        assignments_sql = assignments.join(", ")
        params << id

        with_busy_retry do
          db.execute("UPDATE nodes SET #{assignments_sql} WHERE node_id = ?", params)
        end
      end
    end
  end
end
