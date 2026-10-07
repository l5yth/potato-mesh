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
      # Decide whether a node-row write must be skipped because its record
      # belongs to another protocol than the stored row (SPEC NI4).
      #
      # Every node-row writer keys on the bare +node_id+, which two protocols'
      # 4-byte id mappings can share: the NodeInfo upsert, and the position,
      # telemetry and last-seen writes that ride on every other record.  Each
      # asks this first, with the record's protocol, so a colliding record of
      # another protocol leaves the stored row alone on all of them
      # ({#cross_protocol_conflict?}, including its #747 exception).
      #
      # @param db [SQLite3::Database] open database handle.
      # @param node_id [String] canonical node id the write targets.
      # @param protocol [String, nil] resolved protocol of the record; nil
      #   (a caller that names none) skips the check.
      # @param context [String] log context of the calling writer.
      # @return [Boolean] true when the write must be skipped.
      def cross_protocol_write?(db, node_id, protocol, context:)
        return false unless protocol

        stored_protocol = db.get_first_value(
          "SELECT protocol FROM nodes WHERE node_id = ? LIMIT 1",
          [node_id],
        )
        return false unless cross_protocol_conflict?(stored_protocol, protocol)

        debug_log(
          "Skipped cross-protocol node write",
          context: context,
          node_id: node_id,
          stored_protocol: stored_protocol,
          incoming_protocol: protocol,
        )
        true
      end

      # Decide whether a node record arrives under another key than the one
      # its stored row is bound to (SPEC NI2, NI3).
      #
      # A row is bound to the key of the identity that named it: the public
      # key for Meshtastic and MeshCore, the identity hash for Reticulum,
      # whose host records carry no public key.  The 4-byte node id is not
      # proof of identity: a Meshtastic NodeInfo is unsigned, and MeshCore and
      # Reticulum ids are a prefix of the full key that a second identity can
      # share.  A record carrying another key, or none, therefore leaves the
      # row's identity alone.  A public key compares as given (a Meshtastic
      # key is base64), an identity hash, which is hex, in any letter case.
      # A row with no stored key binds nothing, and a row that is positively
      # stale ({DataProcessing.positively_stale_sql}, SPEC MR2) binds nothing
      # either: its key has been silent for the evidence window, so a new key
      # takes the row over.
      #
      # @param db [SQLite3::Database] open database handle.
      # @param node_id [String] canonical node id of the record.
      # @param n [Hash] the node record.
      # @param protocol [String] resolved protocol of the record.
      # @return [Boolean] true when the row is bound to another key than the
      #   record's.
      def record_under_another_key?(db, node_id, n, protocol)
        record_key = if protocol == "reticulum"
            pick_alias(n, "identityHash", "identity_hash")
          else
            pick_alias(n["user"], "publicKey", "public_key")
          end
        bound_to_another_key?(db, node_id, record_key, protocol, context: "data_processing.upsert_node")
      end

      # Decide whether the stored row for +node_id+ is bound to another key
      # than +record_key+ ({#record_under_another_key?} for the rule).
      #
      # The node upsert asks it with the record's key, or none; a position
      # row asks it only when it carries the key of the advert it came from
      # (SPEC NI3), since a Meshtastic position names no key.
      #
      # @param db [SQLite3::Database] open database handle.
      # @param node_id [String] canonical node id of the write.
      # @param record_key [String, nil] the key the record carries: a public
      #   key, or for Reticulum an identity hash; nil when it carries none.
      # @param protocol [String] resolved protocol of the record.
      # @param context [String] log context of the calling writer.
      # @return [Boolean] true when the row is bound to another key.
      def bound_to_another_key?(db, node_id, record_key, protocol, context:)
        reticulum = protocol == "reticulum"
        column = reticulum ? "identity_hash" : "public_key"
        bound_key = string_or_nil(
          db.get_first_value(
            "SELECT #{column} FROM nodes WHERE node_id = ? " \
            "AND NOT #{DataProcessing.positively_stale_sql("nodes")} LIMIT 1",
            [node_id, DataProcessing.evidence_cutoff],
          ),
        )
        return false unless bound_key

        record_key = string_or_nil(record_key)
        if reticulum
          record_key = record_key&.downcase
          bound_key = bound_key.downcase
        end
        return false if record_key == bound_key

        debug_log(
          "Kept the identity of a node bound to another key",
          context: context,
          node_id: node_id,
          protocol: protocol,
          record_key: record_key ? "other" : "none",
        )
        true
      end

      # Decide whether +claimed+ is exactly the node +node_id+ (SPEC NI1).
      #
      # An id a NodeInfo or NeighborInfo payload claims for itself counts
      # only when it is the sender's own, written canonically: the canonical
      # id itself (+!+ and eight lowercase hex digits), or the node number
      # for a numeric field.  Another spelling of the id (+"!A1A1A1A1"+), an
      # id that names no node (+"!Decrypted"+) and any other value are no
      # claim, so a payload carrying one is not filed under its sender.
      #
      # @param claimed [Object] node id or number a payload claims.
      # @param node_id [String, nil] canonical id of the sender.
      # @return [Boolean] true when +claimed+ is +node_id+ or its number;
      #   false when +node_id+ is nil.
      def claims_node?(claimed, node_id)
        return claimed == node_id if claimed.is_a?(String)

        claimed.is_a?(Integer) && claimed.between?(0, 0xFFFFFFFF) && format("!%08x", claimed) == node_id
      end

      # Decide whether +claimed+ names another node than +sender+ (SPEC NI1).
      #
      # The lenient twin of {#claims_node?}, for a record's number against
      # its own key: both resolve through {#canonical_node_parts}, so
      # +0xa1a1a1a1+ and +"!A1A1A1A1"+ name one node, and a side that does not
      # resolve makes no claim.
      #
      # @param claimed [Object] node id or number a payload claims.
      # @param sender [Object] node id or number of the record's sender.
      # @return [Boolean] true when both resolve to node ids and the ids
      #   differ; false when they agree or either does not resolve.
      def names_another_node?(claimed, sender)
        claimed_id = canonical_node_parts(claimed)&.first
        sender_id = canonical_node_parts(sender)&.first
        return false unless claimed_id && sender_id

        claimed_id != sender_id
      end
    end
  end
end
