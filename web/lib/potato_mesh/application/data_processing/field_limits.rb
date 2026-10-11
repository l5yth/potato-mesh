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
    module DataProcessing
      # Byte caps on the strings the ingest routes store, and the number check
      # on the numeric fields they store as read (SPEC SL1-SL10).
      #
      # A cap counts UTF-8 bytes, the unit of the radio protocols, of SQLite
      # and of a response's size: a grapheme count bounds nothing, since one
      # cluster of 500,000 combining marks is a megabyte.  Each capped field
      # follows one policy:
      #
      # - T, free text: cut to its longest prefix of whole grapheme clusters
      #   within the cap ({PotatoMesh::Sanitizer.bounded_text}).
      # - N, token: an id, key, enum label or encoded payload over the cap is
      #   stored as NULL, because a cut token is a different token
      #   ({PotatoMesh::Sanitizer.bounded_token}).  The same policy holds for a
      #   numeric field: a value that is not a number stores NULL, never text,
      #   and a numeric string is converted ({DataProcessing#bounded_number}).
      # - C, node id: an id that is not in a legitimate form skips the entry
      #   that carries it ({.node_id?}, {.node_ref?}, {.destination_ref?},
      #   {.stored_id?}).
      # - W, protocol: only {DataProcessing::KNOWN_PROTOCOLS} values are kept.
      # - R, signed instance field: a value over its cap rejects the record,
      #   because a cut value no longer matches its signature
      #   ({.instance_field_violation}).
      #
      # The caps sit well above the longest legitimate value of each field, so
      # real traffic is never cut.  Rows stored before the caps existed are not
      # rewritten; they age out under retention.  The ingestor trims the same
      # fields loosely before posting (+data/mesh_ingestor/field_limits.py+),
      # and this module makes the final cut.
      module FieldLimits
        # +nodes.long_name+ and +destinations.name+ (T).  Meshtastic names end
        # at 39 bytes and MeshCore names at 31; a Reticulum display name
        # reaches about 329 bytes.
        LONG_NAME_BYTES = 512

        # +nodes.short_name+ (T).  Meshtastic allows 4 bytes.
        SHORT_NAME_BYTES = 16

        # +nodes.hw_model+ (N).  The longest Meshtastic model name is 28 bytes.
        HW_MODEL_BYTES = 64

        # +nodes.role+ and +destinations.role+ (N).  The longest role is 14
        # bytes.
        ROLE_BYTES = 32

        # +nodes.macaddr+ (N).  Base64 of six bytes is 8 bytes.
        MACADDR_BYTES = 32

        # +nodes.public_key+ (N).  A Reticulum key in hex is 128 bytes.  A key
        # over the cap stores NULL, so a cut key never counts as keyed
        # evidence (SPEC SL4, amending MR1).
        PUBLIC_KEY_BYTES = 512

        # +nodes.identity_hash+ and +destinations.id+ (N).  A Reticulum hash in
        # hex is 32 bytes.
        HASH_BYTES = 64

        # +destinations.aspect+ (N).  +nomadnetwork.node+ is 17 bytes.
        ASPECT_BYTES = 64

        # +destinations.interface+ (T), the label of the interface an announce
        # was heard on.
        INTERFACE_BYTES = 256

        # Enum labels (N): +location_source+, +modem_preset+, +portnum+ and
        # +telemetry_type+.  The longest is 27 bytes.
        LABEL_BYTES = 32

        # +messages.text+ (T).  A Meshtastic text ends at 233 bytes.
        MESSAGE_TEXT_BYTES = 1024

        # Encoded payloads (N): +messages.encrypted+ and the +payload_b64+
        # columns.  Base64 of a 237-byte LoRa payload is 316 bytes.
        PAYLOAD_BYTES = 512

        # +messages.channel_name+ (T).  MeshCore channel names end at 31 bytes.
        CHANNEL_NAME_BYTES = 64

        # +messages.emoji+ (N).
        EMOJI_BYTES = 64

        # +messages.path+ (N).  64 three-byte hop hashes in hex are 384 bytes.
        PATH_BYTES = 512

        # The +rx_iso+ columns (N).  A UTC second in ISO 8601 is 20 bytes; the
        # write functions derive a NULL one from +rx_time+.
        RX_ISO_BYTES = 32

        # +telemetry.user_string+ (T).  Meshtastic allows 199 bytes.
        USER_STRING_BYTES = 256

        # Entries kept of +telemetry.one_wire_temperature+.  Meshtastic
        # carries 8 probes.
        ONE_WIRE_TEMPERATURE_ENTRIES = 8

        # Neighbours one snapshot stores, and lookups by node number it makes
        # (SPEC IB3).  Each may mint a placeholder node.  Meshtastic's
        # NeighborInfo carries at most 10.
        NEIGHBOR_ENTRIES = 16

        # Hops kept of a trace's +hops+ or +path+ list (SPEC IB3).  Each hop
        # may mint a placeholder node.  Meshtastic's RouteDiscovery carries at
        # most 8.
        TRACE_HOP_ENTRIES = 16

        # +waypoints.name+ (T).  Meshtastic allows 29 bytes.
        WAYPOINT_NAME_BYTES = 128

        # +waypoints.description+ (T).  Meshtastic allows 99 bytes.
        WAYPOINT_DESCRIPTION_BYTES = 512

        # +ingestors.version+ (T).
        INGESTOR_VERSION_BYTES = 64

        # Signed instance fields (R): +name+, +version+, +channel+,
        # +frequency+ and +contact_link+.
        INSTANCE_FIELD_BYTES = 256

        # The instance +signature+ (R).  Base64 of an RSA-4096 signature is
        # 684 bytes and of an RSA-6144 one 1024, so a key over 6144 bits
        # cannot sign within the cap.
        INSTANCE_SIGNATURE_BYTES = 1024

        # The instance +public_key+ PEM (R).  An instance generates an
        # RSA-2048 key, 451 bytes as PEM.  An RSA-6144 key, the largest the
        # signature cap admits, is 1145 bytes.
        INSTANCE_PUBLIC_KEY_BYTES = 2048

        # Signed instance attributes {.instance_field_violation} checks, in
        # the order it reports them.
        INSTANCE_FIELDS = %i[name version channel frequency contact_link].freeze

        # Canonical node id: +!+ and eight lowercase hex digits (SPEC 3.4/D8).
        CANONICAL_NODE_ID = /\A![0-9a-f]{8}\z/

        # A node number as a decimal string, at most ten digits.
        DECIMAL_NODE_NUM = /\A\d{1,10}\z/

        # Largest node number: node ids are 32 bits.
        MAX_NODE_NUM = 0xFFFF_FFFF

        # The broadcast destination of a message, position or telemetry
        # packet.
        BROADCAST_ID = "^all"

        # Capped fields of a +destination+ mapping, as +[path, policy, cap]+
        # (SPEC SL3).
        DESTINATION_FIELDS = [
          [%w[id], :token, HASH_BYTES],
          [%w[aspect], :token, ASPECT_BYTES],
          [%w[role], :token, ROLE_BYTES],
        ].freeze

        # Capped fields of a +POST /api/nodes+ entry, every alias
        # +upsert_node+ reads included (SPEC SL3).
        NODE_FIELDS = ([
          [%w[user longName], :text, LONG_NAME_BYTES],
          [%w[user long_name], :text, LONG_NAME_BYTES],
          [%w[user shortName], :text, SHORT_NAME_BYTES],
          [%w[user short_name], :text, SHORT_NAME_BYTES],
          [%w[user hwModel], :token, HW_MODEL_BYTES],
          [%w[user hw_model], :token, HW_MODEL_BYTES],
          [%w[hwModel], :token, HW_MODEL_BYTES],
          [%w[hw_model], :token, HW_MODEL_BYTES],
          [%w[user role], :token, ROLE_BYTES],
          [%w[user macaddr], :token, MACADDR_BYTES],
          [%w[user publicKey], :token, PUBLIC_KEY_BYTES],
          [%w[user public_key], :token, PUBLIC_KEY_BYTES],
          [%w[identityHash], :token, HASH_BYTES],
          [%w[identity_hash], :token, HASH_BYTES],
          [%w[interface], :text, INTERFACE_BYTES],
          [%w[modem_preset], :token, LABEL_BYTES],
          [%w[modemPreset], :token, LABEL_BYTES],
          [%w[position locationSource], :token, LABEL_BYTES],
          [%w[position location_source], :token, LABEL_BYTES],
        ] + DESTINATION_FIELDS.map { |path, policy, cap| [["destination", *path], policy, cap] }).freeze

        # Capped fields of a +POST /api/messages+ record (SPEC SL3).
        MESSAGE_FIELDS = [
          [%w[text], :text, MESSAGE_TEXT_BYTES],
          [%w[encrypted], :token, PAYLOAD_BYTES],
          [%w[channel_name], :text, CHANNEL_NAME_BYTES],
          [%w[channelName], :text, CHANNEL_NAME_BYTES],
          [%w[emoji], :token, EMOJI_BYTES],
          [%w[path], :token, PATH_BYTES],
          [%w[rx_iso], :token, RX_ISO_BYTES],
          [%w[portnum], :token, LABEL_BYTES],
          [%w[modem_preset], :token, LABEL_BYTES],
          [%w[modemPreset], :token, LABEL_BYTES],
        ].freeze

        # Capped fields of a +POST /api/positions+ record (SPEC SL3).
        POSITION_FIELDS = [
          [%w[rx_iso], :token, RX_ISO_BYTES],
          [%w[location_source], :token, LABEL_BYTES],
          [%w[locationSource], :token, LABEL_BYTES],
          [%w[position location_source], :token, LABEL_BYTES],
          [%w[position locationSource], :token, LABEL_BYTES],
          [%w[position raw location_source], :token, LABEL_BYTES],
          [%w[payload_b64], :token, PAYLOAD_BYTES],
          [%w[payload], :token, PAYLOAD_BYTES],
          [%w[position payload __bytes_b64__], :token, PAYLOAD_BYTES],
          [%w[modem_preset], :token, LABEL_BYTES],
          [%w[modemPreset], :token, LABEL_BYTES],
        ].freeze

        # Capped flat fields of a +POST /api/telemetry+ record (SPEC SL3).
        # Metric values may arrive nested, or as JSON strings, so
        # +user_string+ and +one_wire_temperature+ are capped where every
        # source meets, in the metric coercion of +insert_telemetry+.
        TELEMETRY_FIELDS = [
          [%w[rx_iso], :token, RX_ISO_BYTES],
          [%w[portnum], :token, LABEL_BYTES],
          [%w[payload_b64], :token, PAYLOAD_BYTES],
          [%w[payload], :token, PAYLOAD_BYTES],
          [%w[modem_preset], :token, LABEL_BYTES],
          [%w[modemPreset], :token, LABEL_BYTES],
          [%w[telemetry_type], :token, LABEL_BYTES],
        ].freeze

        # Capped fields of a +POST /api/traces+ record (SPEC SL3).
        TRACE_FIELDS = [
          [%w[rx_iso], :token, RX_ISO_BYTES],
        ].freeze

        # Capped fields of a +POST /api/waypoints+ record (SPEC SL3).
        WAYPOINT_FIELDS = [
          [%w[rx_iso], :token, RX_ISO_BYTES],
          [%w[name], :text, WAYPOINT_NAME_BYTES],
          [%w[description], :text, WAYPOINT_DESCRIPTION_BYTES],
          [%w[payload_b64], :token, PAYLOAD_BYTES],
          [%w[payload], :token, PAYLOAD_BYTES],
        ].freeze

        # Capped fields of a +POST /api/ingestors+ heartbeat (SPEC SL3).
        INGESTOR_FIELDS = [
          [%w[version], :text, INGESTOR_VERSION_BYTES],
          [%w[ingestorVersion], :text, INGESTOR_VERSION_BYTES],
          [%w[modem_preset], :token, LABEL_BYTES],
        ].freeze

        # Device metric keys of a node entry, as +[key, kind]+, read under
        # +deviceMetrics+ or +device_metrics+ (SPEC SL10).
        DEVICE_METRIC_FIELDS = [
          ["batteryLevel", :float],
          ["battery_level", :float],
          ["voltage", :float],
          ["channelUtilization", :float],
          ["channel_utilization", :float],
          ["airUtilTx", :float],
          ["air_util_tx", :float],
          ["uptimeSeconds", :integer],
          ["uptime_seconds", :integer],
        ].freeze

        # Numeric fields of a node entry that +upsert_node+ stores, or hands
        # to the node gauges, as read (SPEC SL10), as +[path, kind]+, every
        # alias included.  +:integer+ and +:float+ follow the column type;
        # +:boolean+ is a flag column, which also takes +true+ and +false+.
        NODE_NUMBER_FIELDS = ([
          [%w[hopsAway], :integer],
          [%w[hops_away], :integer],
          [%w[snr], :float],
          [%w[rssi], :integer],
          [%w[isFavorite], :boolean],
          [%w[is_favorite], :boolean],
          [%w[user isUnmessagable], :boolean],
          [%w[user is_unmessagable], :boolean],
          [%w[position latitude], :float],
          [%w[position longitude], :float],
          [%w[position altitude], :float],
        ] + %w[deviceMetrics device_metrics].product(DEVICE_METRIC_FIELDS).map { |container, (key, kind)| [[container, key], kind] }).freeze

        # Nested mappings of a node entry that +upsert_node+ reads fields
        # from (SPEC SL10).  A value at one of these paths that is not a
        # mapping is dropped, as if absent: a string would answer each field
        # lookup with a substring of itself, past every bound.
        NODE_MAPS = [
          %w[user],
          %w[deviceMetrics],
          %w[device_metrics],
          %w[position],
          %w[position raw],
          %w[destination],
        ].freeze

        # Nested mappings of a +POST /api/positions+ record that
        # +insert_position+ reads fields from (SPEC IB1).  As in
        # {NODE_MAPS}, a value at one of these paths that is not a mapping
        # is dropped, so the record is stored without it.
        POSITION_MAPS = [
          %w[position],
          %w[position raw],
          %w[position payload],
        ].freeze

        # Numeric fields of a +POST /api/messages+ record that
        # +insert_message+ stores as read (SPEC SL10), as +[path, kind]+.
        MESSAGE_NUMBER_FIELDS = [
          [%w[channel], :integer],
          [%w[snr], :float],
          [%w[rssi], :integer],
          [%w[hop_limit], :integer],
        ].freeze

        # Largest +packets+ count of a +POST /api/ingestors+ heartbeat that
        # records an activity row (SPEC IB4, beside SL10).  The count is the
        # frames one ingestor handled since its previous heartbeat, an hour
        # by default: the cap is about 278,000 frames a second for an hour,
        # far beyond a LoRa channel.  The stats queries read each stored row
        # at most at the cap, an older row included, so their sums overflow
        # only past 9.2e9 rows of one ingestor inside one window.
        MAX_HEARTBEAT_PACKETS = 1_000_000_000

        module_function

        # Whether +value+ is a canonical node id as stored (SPEC SL5).
        #
        # @param value [Object] candidate id.
        # @return [Boolean] true for +!+ and eight lowercase hex digits.
        def node_id?(value)
          value.is_a?(String) && CANONICAL_NODE_ID.match?(value)
        end

        # Whether +value+ is a node reference in a form ingest accepts and
        # the write functions turn into a canonical id (SPEC SL5).
        #
        # The forms are the ones +CONTRACTS.md+ names: the canonical id, a
        # node number (a JSON integer, or its decimal string), and an absent
        # value.  Anything else, such as a non-hex string or an id longer
        # than eight hex digits, is not a node.
        #
        # @param value [Object] candidate reference.
        # @return [Boolean] true for nil, a blank string, a canonical id, or a
        #   node number from 0 to {MAX_NODE_NUM}.
        def node_ref?(value)
          case value
          when nil
            true
          when Integer
            value.between?(0, MAX_NODE_NUM)
          when String
            ref = value.strip
            ref.empty? || node_id?(ref) || (DECIMAL_NODE_NUM.match?(ref) && ref.to_i <= MAX_NODE_NUM)
          else
            false
          end
        end

        # Whether +value+ is a destination: a node reference or the broadcast
        # id +^all+ (SPEC SL5).
        #
        # @param value [Object] candidate destination.
        # @return [Boolean] true when {.node_ref?} holds or +value+ is +^all+.
        def destination_ref?(value)
          node_ref?(value) || (value.is_a?(String) && value.strip == BROADCAST_ID)
        end

        # Whether +value+ can fill a column that keeps the id as posted, such
        # as +ingestor+ (SPEC SL5): absent, or canonical.
        #
        # @param value [Object] candidate id.
        # @return [Boolean] true for nil, a blank string, or a canonical id.
        def stored_id?(value)
          return true if value.nil?
          return false unless value.is_a?(String)

          ref = value.strip
          ref.empty? || node_id?(ref)
        end

        # Whether every id field of +record+ is in a legitimate form (SPEC
        # SL5).  A field the record does not carry passes.
        #
        # @param record [Hash] inbound record.
        # @param node [Array<String>] keys holding node references.
        # @param destination [Array<String>] keys holding destinations.
        # @param stored [Array<String>] keys stored as posted.
        # @return [Boolean] true when the record may be stored.
        def ids_valid?(record, node: [], destination: [], stored: [])
          node.all? { |key| node_ref?(record[key]) } &&
            destination.all? { |key| destination_ref?(record[key]) } &&
            stored.all? { |key| stored_id?(record[key]) }
        end

        # Apply the T and N caps of +fields+ to +record+ (SPEC SL2, SL3).
        #
        # Copy on write: a record whose capped fields all fit comes back as
        # the same object, so the write functions keep their existing
        # behaviour for every value within its cap.
        #
        # @param record [Object] inbound record; a non-Hash passes through.
        # @param fields [Array<Array(Array<String>, Symbol, Integer)>] field
        #   paths with their policy (+:text+ or +:token+) and cap in bytes.
        # @return [Object] +record+, or a copy with the over-cap values cut or
        #   nulled.
        def bound_fields(record, fields)
          map_fields(record, fields) do |value, policy, cap|
            policy == :text ? PotatoMesh::Sanitizer.bounded_text(value, cap) : PotatoMesh::Sanitizer.bounded_token(value, cap)
          end
        end

        # Replace the value at each nested path of +fields+ in +record+ with
        # the block's result, copying each level that changes (SPEC SL3,
        # SL10).  A path the record does not hold is left alone.
        #
        # @param record [Object] inbound record; a non-Hash passes through.
        # @param fields [Array<Array>] +[path, *rule]+ entries; the block gets
        #   the value at +path+ and then +rule+ (a policy and cap, or a kind).
        # @yieldparam value [Object] the value at the end of the path.
        # @yieldreturn [Object] the value to keep; the same object leaves the
        #   level uncopied.
        # @return [Object] +record+, or a copy holding the changed values.
        def map_fields(record, fields, &transform)
          return record unless record.is_a?(Hash)

          fields.reduce(record) do |mapped, (path, *rule)|
            map_path(mapped, path) { |value| transform.call(value, *rule) }
          end
        end

        # Drop each value at the nested +paths+ of +record+ that is present
        # but not a mapping (SPEC SL10), copying each level that changes.
        #
        # @param record [Object] inbound record; a non-Hash passes through.
        # @param paths [Array<Array<String>>] paths of nested mappings,
        #   outermost key first.
        # @return [Object] +record+, or a copy without the values that are no
        #   mapping.
        def drop_non_maps(record, paths)
          paths.reduce(record) { |kept, path| drop_non_map(kept, path) }
        end

        # Drop the value at a nested +path+ of +hash+ when it is present but
        # not a mapping, copying each level that changes.
        #
        # @param hash [Object] mapping at the current level.
        # @param path [Array<String>] remaining keys, outermost first.
        # @return [Object] +hash+, or a copy without that value.
        def drop_non_map(hash, path)
          key, *rest = path
          return hash unless hash.is_a?(Hash) && hash.key?(key)

          value = hash[key]
          if rest.empty?
            return hash if value.nil? || value.is_a?(Hash)

            return hash.except(key)
          end

          kept = drop_non_map(value, rest)
          kept.equal?(value) ? hash : hash.merge(key => kept)
        end

        # Replace the value at a nested +path+ of +hash+ with the block's
        # result, copying each level that changes.
        #
        # @param hash [Object] mapping at the current level.
        # @param path [Array<String>] remaining keys, outermost first.
        # @yieldparam value [Object] the value at the end of the path.
        # @return [Object] +hash+, or a copy holding the new value.
        def map_path(hash, path, &transform)
          key, *rest = path
          return hash unless hash.is_a?(Hash) && hash.key?(key)

          value = hash[key]
          mapped = rest.empty? ? transform.call(value) : map_path(value, rest, &transform)
          mapped.equal?(value) ? hash : hash.merge(key => mapped)
        end

        # The first signed instance field over its cap, as a rejection reason
        # (SPEC SL6).
        #
        # A signed field is never cut: the signature covers the value as sent,
        # so a cut value would be stored and relayed under a signature it no
        # longer matches.  The public key counts too: a PEM followed by junk
        # still parses and verifies.
        #
        # @param fields [Hash{Symbol=>Object}] instance attributes, keyed by
        #   {INSTANCE_FIELDS}.
        # @param signature [Object] the announcement's signature.
        # @param pubkey [Object] the announced public key PEM.
        # @return [String, nil] e.g. +"name exceeds 256 bytes"+, or nil when
        #   every field fits.
        def instance_field_violation(fields, signature, pubkey:)
          INSTANCE_FIELDS.each do |field|
            next if fields[field].to_s.bytesize <= INSTANCE_FIELD_BYTES

            return "#{field} exceeds #{INSTANCE_FIELD_BYTES} bytes"
          end
          return "public_key exceeds #{INSTANCE_PUBLIC_KEY_BYTES} bytes" if pubkey.to_s.bytesize > INSTANCE_PUBLIC_KEY_BYTES
          return nil if signature.to_s.bytesize <= INSTANCE_SIGNATURE_BYTES

          "signature exceeds #{INSTANCE_SIGNATURE_BYTES} bytes"
        end
      end

      # Bound a node entry before +upsert_node+ stores it (SPEC SL3, SL10).
      #
      # A nested map that is not a mapping ({FieldLimits::NODE_MAPS}) is
      # dropped first, so the caps and number checks see every field
      # +upsert_node+ reads.  The id the entry is stored under is checked
      # where it is read: the +POST /api/nodes+ key loop and the decrypted
      # NodeInfo path (SPEC SL5).
      #
      # @param node [Object] the node entry.
      # @return [Object] the entry, bounded; a non-Hash unchanged.
      def bound_node_payload(node)
        node = FieldLimits.drop_non_maps(node, FieldLimits::NODE_MAPS)
        bound_numbers(FieldLimits.bound_fields(node, FieldLimits::NODE_FIELDS), FieldLimits::NODE_NUMBER_FIELDS)
      end

      # Bound the numeric fields of +record+ with {#bounded_number} (SPEC
      # SL10), copying only what changes.
      #
      # @param record [Object] inbound record; a non-Hash passes through.
      # @param fields [Array<Array(Array<String>, Symbol)>] numeric field
      #   paths with their kind.
      # @return [Object] +record+, or a copy holding the bounded numbers.
      def bound_numbers(record, fields)
        FieldLimits.map_fields(record, fields) { |value, kind| bounded_number(value, kind) }
      end

      # Bound one numeric field stored as read (SPEC SL10, policy N for
      # numbers): it stores a number or NULL, never text.
      #
      # A float is kept when finite and an integer when it fits the range an
      # SQLite +INTEGER+ holds; a numeric string is converted by +coerce_float+
      # or +coerce_integer+, after the column type, so +"5.5"+ stores 5.5.
      # Anything else stores NULL: text that is no number, a mapping or a
      # list, an integer outside the signed 64-bit range (SQLite would keep it
      # as an approximate +REAL+, or as infinity) and a float that is not
      # finite.  A +:boolean+ flag also keeps +true+ and +false+.
      #
      # @param value [Object, nil] value of the field.
      # @param kind [Symbol] +:integer+, +:float+ or +:boolean+.
      # @return [Numeric, Boolean, nil] the value to store.
      def bounded_number(value, kind)
        return value if value.nil? || (kind == :boolean && (value == true || value == false))
        return coerce_float(value) if value.is_a?(Float) || (kind == :float && !value.is_a?(Integer))

        coerce_integer(value)
      end

      # Bound the arguments of +upsert_destination+ (SPEC SL3).
      #
      # @param destination [Object] +destination+ mapping of a node entry.
      # @param identity_hash [Object] identity the destination belongs to.
      # @param name [Object] display name announced on the destination.
      # @param interface [Object] interface the announce was heard on.
      # @return [Array(Object, Object, Object, Object)] the four values,
      #   bounded, in the order given.
      def bound_destination_fields(destination, identity_hash, name, interface)
        [
          FieldLimits.bound_fields(destination, FieldLimits::DESTINATION_FIELDS),
          PotatoMesh::Sanitizer.bounded_token(identity_hash, FieldLimits::HASH_BYTES),
          PotatoMesh::Sanitizer.bounded_text(name, FieldLimits::LONG_NAME_BYTES),
          PotatoMesh::Sanitizer.bounded_text(interface, FieldLimits::INTERFACE_BYTES),
        ]
      end

      # Bound a +POST /api/messages+ record (SPEC SL3, SL5, SL10).
      #
      # @param message [Object] inbound message.
      # @return [Object, nil] the message, bounded; a non-Hash unchanged; nil
      #   when an id field is not a legitimate id and the message is skipped.
      def bound_message_payload(message)
        return message unless message.is_a?(Hash)
        return nil unless FieldLimits.ids_valid?(message, node: %w[from_id from], destination: %w[to_id to], stored: %w[ingestor])

        bound_numbers(FieldLimits.bound_fields(message, FieldLimits::MESSAGE_FIELDS), FieldLimits::MESSAGE_NUMBER_FIELDS)
      end

      # Bound a +POST /api/positions+ record (SPEC SL3, SL5, IB1).
      #
      # A nested section that is not a mapping ({FieldLimits::POSITION_MAPS})
      # is dropped first, so the record is stored without it instead of
      # failing its batch.
      #
      # @param payload [Object] inbound position.
      # @return [Object, nil] the position, bounded; a non-Hash unchanged; nil
      #   when an id field is not a legitimate id and the position is skipped.
      def bound_position_payload(payload)
        return payload unless payload.is_a?(Hash)
        return nil unless FieldLimits.ids_valid?(payload, node: %w[node_id from_id from], destination: %w[to_id to], stored: %w[ingestor])

        payload = FieldLimits.drop_non_maps(payload, FieldLimits::POSITION_MAPS)
        FieldLimits.bound_fields(payload, FieldLimits::POSITION_FIELDS)
      end

      # Bound a +POST /api/telemetry+ record (SPEC SL3, SL5).
      #
      # @param payload [Object] inbound telemetry packet.
      # @return [Object, nil] the packet, bounded; a non-Hash unchanged; nil
      #   when an id field is not a legitimate id and the packet is skipped.
      def bound_telemetry_payload(payload)
        return payload unless payload.is_a?(Hash)
        return nil unless FieldLimits.ids_valid?(payload, node: %w[node_id from_id from], destination: %w[to_id to], stored: %w[ingestor])

        FieldLimits.bound_fields(payload, FieldLimits::TELEMETRY_FIELDS)
      end

      # Bound a +POST /api/neighbors+ snapshot (SPEC SL5).
      #
      # A neighbour entry whose id is not a node reference is dropped from
      # the snapshot, so the reporting node keeps its other neighbours.
      #
      # @param payload [Object] inbound neighbour snapshot.
      # @return [Object, nil] the snapshot without the dropped entries; a
      #   non-Hash unchanged; nil when the reporting node's id or the
      #   +ingestor+ is not a legitimate id and the snapshot is skipped.
      def bound_neighbor_payload(payload)
        return payload unless payload.is_a?(Hash)
        return nil unless FieldLimits.ids_valid?(payload, node: %w[node_id node from_id], stored: %w[ingestor])

        entries = payload["neighbors"]
        return payload unless entries.is_a?(Array)

        kept = entries.select do |entry|
          !entry.is_a?(Hash) || FieldLimits.ids_valid?(entry, node: %w[neighbor_id node_id nodeId id])
        end
        kept.length == entries.length ? payload : payload.merge("neighbors" => kept)
      end

      # Bound a +POST /api/traces+ record (SPEC SL3, SL5).
      #
      # @param payload [Object] inbound trace.
      # @return [Object, nil] the trace, bounded; a non-Hash unchanged; nil
      #   when its +ingestor+ is not a legitimate id and the trace is skipped.
      def bound_trace_payload(payload)
        return payload unless payload.is_a?(Hash)
        return nil unless FieldLimits.ids_valid?(payload, stored: %w[ingestor])

        FieldLimits.bound_fields(payload, FieldLimits::TRACE_FIELDS)
      end

      # Bound a +POST /api/waypoints+ record (SPEC SL3, SL5).
      #
      # @param payload [Object] inbound waypoint.
      # @return [Object, nil] the waypoint, bounded; a non-Hash unchanged; nil
      #   when an id field is not a legitimate id and the waypoint is skipped.
      def bound_waypoint_payload(payload)
        return payload unless payload.is_a?(Hash)
        return nil unless FieldLimits.ids_valid?(payload, node: %w[node_id from_id from], stored: %w[ingestor])

        FieldLimits.bound_fields(payload, FieldLimits::WAYPOINT_FIELDS)
      end

      # Bound a +POST /api/ingestors+ heartbeat (SPEC SL3, SL5, SL7).
      #
      # The declared +protocol+ is kept only as one of {KNOWN_PROTOCOLS}; any
      # other value is dropped, so the heartbeat registers the documented
      # +meshtastic+ default and records inheriting the ingestor's protocol
      # carry a known one.
      #
      # @param payload [Object] inbound heartbeat.
      # @return [Object, nil] the heartbeat, bounded; a non-Hash unchanged;
      #   nil when its node id is not a node reference.
      def bound_ingestor_payload(payload)
        return payload unless payload.is_a?(Hash)
        return nil unless FieldLimits.ids_valid?(payload, node: %w[node_id id])

        bounded = FieldLimits.bound_fields(payload, FieldLimits::INGESTOR_FIELDS)
        protocol = normalize_protocol_value(bounded["protocol"])
        protocol == bounded["protocol"] ? bounded : bounded.merge("protocol" => protocol)
      end
    end
  end
end
