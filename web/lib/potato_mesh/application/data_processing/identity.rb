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
      # Resolve the numeric representation of a node identifier from a packet payload.
      #
      # The +payload["num"]+ field may arrive as an Integer, a decimal string, or
      # a hexadecimal string (with or without an +0x+ prefix).  When the field is
      # absent or ambiguous the method falls back to decoding the hex portion of
      # +node_id+.
      #
      # @param node_id [String, nil] canonical node identifier in +!xxxxxxxx+ form.
      # @param payload [Hash] inbound message payload that may carry a +num+ field.
      # @return [Integer, nil] resolved 32-bit node number or +nil+ when undecidable.
      def resolve_node_num(node_id, payload)
        raw = payload["num"]

        case raw
        when Integer
          return raw
        when Numeric
          return raw.to_i
        when String
          trimmed = raw.strip
          return nil if trimmed.empty?
          return Integer(trimmed, 10) if trimmed.match?(/\A[0-9]+\z/)
          return Integer(trimmed.delete_prefix("0x").delete_prefix("0X"), 16) if trimmed.match?(/\A0[xX][0-9A-Fa-f]+\z/)
          if trimmed.match?(/\A[0-9A-Fa-f]+\z/)
            canonical = node_id.is_a?(String) ? node_id.strip : ""
            return Integer(trimmed, 16) if canonical.match?(/\A!?[0-9A-Fa-f]+\z/)
          end
        end

        return nil unless node_id.is_a?(String)

        hex = node_id.strip
        return nil if hex.empty?
        hex = hex.delete_prefix("!")
        return nil unless hex.match?(/\A[0-9A-Fa-f]+\z/)

        Integer(hex, 16)
      end

      # Derive the canonical triplet for a node reference.
      #
      # Accepts an Integer node number, a hex string with or without the +!+
      # sigil, a decimal numeric string, or a +0x+-prefixed hex string.  A
      # +fallback_num+ may be provided when +node_ref+ is nil.
      #
      # @param node_ref [Integer, String, nil] raw node identifier from a packet.
      # @param fallback_num [Integer, nil] numeric fallback when +node_ref+ is nil.
      # @return [Array(String, Integer, String), nil] tuple of
      #   +[canonical_id, node_num, short_id]+ or +nil+ when the reference cannot
      #   be resolved.  +canonical_id+ is prefixed with +!+ and zero-padded to
      #   eight lowercase hex digits.  +short_id+ is the upper-case last four
      #   hex digits used for display.
      def canonical_node_parts(node_ref, fallback_num = nil)
        fallback = coerce_integer(fallback_num)

        hex = nil
        num = nil

        case node_ref
        when Integer
          num = node_ref
        when Numeric
          num = node_ref.to_i
        when String
          trimmed = node_ref.strip
          return nil if trimmed.empty?

          if trimmed.start_with?("!")
            hex = trimmed.delete_prefix("!")
          elsif trimmed.match?(/\A0[xX][0-9A-Fa-f]+\z/)
            hex = trimmed[2..].to_s
          elsif trimmed.match?(/\A-?\d+\z/)
            num = trimmed.to_i
          elsif trimmed.match?(/\A[0-9A-Fa-f]+\z/)
            hex = trimmed
          else
            return nil
          end
        when nil
          num = fallback if fallback
        else
          return nil
        end

        num ||= fallback if fallback

        if hex
          begin
            num ||= Integer(hex, 16)
          rescue ArgumentError
            return nil
          end
        elsif num
          return nil if num.negative?
          hex = format("%08x", num & 0xFFFFFFFF)
        else
          return nil
        end

        return nil if hex.nil? || hex.empty?

        begin
          parsed = Integer(hex, 16)
        rescue ArgumentError
          return nil
        end

        parsed &= 0xFFFFFFFF
        canonical_hex = format("%08x", parsed)
        short_id = canonical_hex[-4, 4].upcase

        ["!#{canonical_hex}", parsed, short_id]
      end

      # Detect whether a node reference resolves to the broadcast address.
      #
      # @param node_ref [Integer, String, nil] raw node reference.
      # @param fallback_num [Integer, nil] optional numeric fallback.
      # @return [Boolean] true when the reference matches the broadcast address.
      def broadcast_node_ref?(node_ref, fallback_num = nil)
        return true if fallback_num == 0xFFFFFFFF
        trimmed = string_or_nil(node_ref)
        return false unless trimmed
        normalized = trimmed.delete_prefix("!").strip.downcase
        normalized == "ffffffff"
      end

      # Converts a protocol identifier such as +meshtastic+ or +mesh-core+ into
      # the display label used in generated node names: capitalised parts joined
      # without a separator (e.g. +Meshtastic+, +MeshCore+).
      #
      # @param protocol [String] protocol identifier.
      # @return [String] formatted display label.
      def protocol_display_label(protocol)
        protocol.split(/[-_]/).map(&:capitalize).join
      end

      # Returns true if +long_name+ is the synthetic placeholder generated by
      # +ensure_unknown_node+ for the given +node_id+ and +protocol+.  Such
      # names carry no real information and must not overwrite a known name
      # already on record.
      #
      # @param long_name [String, nil] candidate long name.
      # @param node_id [String, nil] canonical node identifier.
      # @param protocol [String] protocol identifier the placeholder was generated for.
      # @return [Boolean] true when the long name is a generic placeholder.
      def generic_fallback_name?(long_name, node_id, protocol)
        return false unless long_name && !long_name.empty?

        parts = canonical_node_parts(node_id)
        return false unless parts

        short_id = parts[2]
        long_name == "#{protocol_display_label(protocol)} #{short_id}"
      end

      # Resolve a raw node reference to its canonical row in the +nodes+ table.
      #
      # @param db [SQLite3::Database] open database handle.
      # @param node_ref [Object] raw reference (string, integer, or hex string).
      # @return [String, nil] canonical +node_id+ or nil when no match exists.
      def normalize_node_id(db, node_ref)
        return nil if node_ref.nil?
        ref_str = node_ref.to_s.strip
        return nil if ref_str.empty?

        node_id = db.get_first_value("SELECT node_id FROM nodes WHERE node_id = ?", [ref_str])
        return node_id if node_id

        begin
          ref_num = Integer(ref_str, 10)
        rescue ArgumentError
          return nil
        end

        db.get_first_value("SELECT node_id FROM nodes WHERE num = ?", [ref_num])
      end
    end
  end
end
