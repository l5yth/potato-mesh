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
      # Synthesize and repair the placeholder node records implied by MeshCore
      # channel chat text (issue #803).
      #
      # A MeshCore channel message encodes its sender as a +"SenderName: body"+
      # text prefix.  An unrostered sender's +from_id+ is a name-derived
      # synthetic id.  These helpers create the placeholder named from that text
      # and marked +synthetic+, so the existing issue-#755 merge machinery
      # reconciles it with the real contact advertisement — instead of the
      # generic +"MeshCore <hex>"+ stand-in that +ensure_unknown_node+ would mint
      # (which is mis-recorded as a real +synthetic=0+ node, shows the wrong
      # name, and never reconciles).
      #
      # Only the sender is a reception.  An +@[Name]+ mention or reply prefix
      # names a peer that was not heard, so it never creates, refreshes, or
      # merges a node (SPEC GN1, issue #883); the frontend renders unresolved
      # mentions with its own stand-in badge.

      # Parse the sender long name from a MeshCore +"SenderName: body"+ prefix.
      #
      # Only the first colon is the separator; colons inside the body are
      # preserved.
      #
      # @param text [String, nil] raw message text.
      # @return [String, nil] trimmed sender name, or nil when there is no colon
      #   or the portion before it is blank.
      def parse_meshcore_sender_name(text)
        return nil unless text.is_a?(String)

        idx = text.index(":")
        return nil unless idx

        name = text[0...idx].strip
        name.empty? ? nil : name
      end

      # Whether a stored message row's sender was attributed by name only, so
      # the API serves it with +sender_verified: false+ (SPEC SV1/SV2).
      #
      # A MeshCore channel message (+to_id+ +"^all"+) carries no sender key,
      # only the typed +"Name:"+ prefix of its text.  Its +from_id+ is
      # therefore always a name match: the ingestor's roster lookup or the
      # name-derived id, which {#resolve_meshcore_channel_sender} and the
      # placeholder merges may re-map by name again.  Every other sender comes
      # from an id the packet carries: a MeshCore direct message names its
      # sender by key (and the ingestor drops it before posting), and
      # Meshtastic and Reticulum senders are set by the sending node.  A row
      # without a +from_id+ attributes no sender, so it is not flagged.
      #
      # @param row [Hash] message row with the stored +"protocol"+, +"to_id"+
      #   and +"from_id"+ columns.
      # @return [Boolean] true for a MeshCore channel row with a sender.
      def meshcore_sender_name_attributed?(row)
        row["protocol"] == "meshcore" && row["to_id"].to_s == "^all" && !string_or_nil(row["from_id"]).nil?
      end

      # Rank a candidate MeshCore sender id by the strength of its identity
      # evidence (SPEC MR3).
      #
      # Co-operating ingestors post the same physical message with divergent
      # +from_id+ values, because each resolves the sender against its own
      # roster: the live public key, a *retired* key some roster still holds,
      # or — with no roster hit at all — a name-derived synthetic. Ranking lets
      # the id-PK collapse keep the best-evidenced attribution instead of
      # last-writer-wins, and keeps a retired identity from being handed
      # liveness it no longer earns.
      #
      # @param db [SQLite3::Database] open database handle.
      # @param node_id [String, nil] candidate sender id.
      # @return [Integer] 2 for a real node that is live or unproven (absence of
      #   evidence never demotes — see
      #   {DataProcessing.positively_stale_sql}), 1 for a real node positively
      #   known to be retired, 0 for a synthetic placeholder or an id with no
      #   node row at all.
      def meshcore_sender_rank(db, node_id)
        node_id = string_or_nil(node_id)
        return 0 unless node_id

        stale = db.get_first_value(
          "SELECT #{DataProcessing.positively_stale_sql("nodes")} FROM nodes " \
          "WHERE node_id = ? AND synthetic = 0 LIMIT 1",
          [DataProcessing.evidence_cutoff, node_id],
        )
        return 0 if stale.nil?

        stale.to_i.zero? ? 2 : 1
      end

      # Resolve which of two competing sender ids a MeshCore message keeps.
      #
      # The incoming id wins only on a *strictly* higher rank, so equal-evidence
      # rivals never flip the attribution back and forth as duplicate copies
      # arrive (SPEC MR3).
      #
      # @param db [SQLite3::Database] open database handle.
      # @param existing_from_id [String, nil] id already stored on the row.
      # @param incoming_from_id [String] id carried by the copy being applied.
      # @return [Boolean] true when the incoming id should replace the stored one.
      def meshcore_sender_supersedes?(db, existing_from_id, incoming_from_id)
        meshcore_sender_rank(db, incoming_from_id) > meshcore_sender_rank(db, existing_from_id)
      end

      # Resolve the sender of a MeshCore channel message that the ingestor
      # name-matched to a retired identity (SPEC GN3, extends MR3).
      #
      # A channel message carries no sender key: the ingestor maps the
      # +"Name:"+ prefix onto its own contact roster, and a roster that still
      # holds a retired keypair under that name hands back the retired id.  MR3
      # only ranks *competing* copies, so a sole copy would keep the retired
      # node alive.  The same ranks decide here: a positively-stale sender
      # (rank 1) is replaced by the one same-name real node that is live or
      # unproven (rank 2).  No such node, or more than one, keeps the
      # ingestor's id.
      #
      # @param db [SQLite3::Database] open database handle.
      # @param from_id [String, nil] sender id carried by the message.
      # @param to_id [String, nil] resolved recipient (+"^all"+ for channel chat).
      # @param text [String, nil] raw message text.
      # @return [String, nil] the sender id to store, +from_id+ when unchanged.
      def resolve_meshcore_channel_sender(db, from_id, to_id, text)
        return from_id unless to_id.to_s == "^all"

        sender_name = parse_meshcore_sender_name(text)
        return from_id unless sender_name && meshcore_sender_rank(db, from_id) == 1

        # NULL unless exactly one candidate qualifies, so ambiguity keeps the
        # ingestor's attribution rather than guessing between two live nodes.
        live_id = db.get_first_value(
          "SELECT CASE WHEN COUNT(*) = 1 THEN MAX(node_id) END FROM nodes " \
          "WHERE long_name = ? AND synthetic = 0 AND protocol = 'meshcore' AND node_id != ? " \
          "AND NOT #{DataProcessing.positively_stale_sql("nodes")}",
          [sender_name, from_id, DataProcessing.evidence_cutoff],
        )
        live_id || from_id
      end

      # Create or repair the MeshCore chat placeholder node for a display name.
      #
      # The node is upserted as a synthetic (+synthetic=1+) COMPANION named
      # +long_name+, so the existing #755 merge reconciles it with the real
      # contact when that advertisement arrives.  A pre-existing generic
      # +"MeshCore <hex>"+ placeholder that was mis-recorded as real
      # (+synthetic=0+) is first demoted to synthetic so the parsed name can take
      # over — the real-node guard in +upsert_node+ would otherwise protect the
      # stale generic name.  A genuine real node (non-generic name, +synthetic=0+)
      # is left untouched: it is the key-resolved sender itself, not a
      # placeholder (SPEC GN2).
      #
      # @param db [SQLite3::Database] open database handle.
      # @param node_id [String, nil] canonical node id to name.
      # @param long_name [String, nil] display name parsed from the message text.
      # @param heard_time [Integer, nil] message rx_time used as last/first heard.
      # @return [void]
      def ensure_meshcore_chat_node(db, node_id, long_name, heard_time)
        long_name = PotatoMesh::Sanitizer.bounded_text(long_name, FieldLimits::LONG_NAME_BYTES) # SPEC SL3: the rename below skips upsert_node
        node_id = string_or_nil(node_id)
        long_name = string_or_nil(long_name)
        return unless node_id && long_name

        existing = db.execute(
          "SELECT long_name FROM nodes WHERE node_id = ? AND synthetic = 0 LIMIT 1",
          [node_id],
        ).first
        if existing
          existing_name = existing.is_a?(Hash) ? existing["long_name"] : existing[0]
          if generic_fallback_name?(existing_name, node_id, "meshcore")
            # Atomically rename + demote the generic placeholder, then reconcile.
            # The generic name carries no information, so it is replaced
            # unconditionally — routing this through +upsert_node+ would gate the
            # rename behind its +excluded.last_heard >= nodes.last_heard+ guard
            # and, on an out-of-order (older) chat message, leave the row demoted
            # to synthetic but still generically named.
            with_busy_retry do
              db.transaction do
                db.execute(
                  "UPDATE nodes SET long_name = ?, synthetic = 1 WHERE node_id = ?",
                  [long_name, node_id],
                )
                merge_into_real_node(db, node_id, long_name)
              end
            end
            return
          end
          # A genuine real node: nothing to name, and the synthetic upsert below
          # would hand the reverse merge a real id, moving this sender's
          # messages and last_heard onto a same-name sibling (issue #883).
          return
        end

        upsert_node(
          db,
          node_id,
          {
            "lastHeard" => heard_time,
            "protocol" => "meshcore",
            "user" => {
              "longName" => long_name,
              "shortName" => "",
              "role" => "COMPANION",
              "synthetic" => true,
            },
          },
          protocol: "meshcore",
        )
      end

      # Synthesize/repair the sender placeholder node for a MeshCore channel
      # message, replacing the generic +ensure_unknown_node+ placeholder.
      #
      # Only broadcast (+"^all"+) MeshCore messages are channel chat; direct
      # messages carry no +"Name:"+ prefix, so a stray colon in their body must
      # not be mistaken for a sender.  +@[Name]+ mentions are deliberately not
      # synthesized: a mention is not a reception (SPEC GN1).
      #
      # @param db [SQLite3::Database] open database handle.
      # @param from_id [String, nil] sender node id from the message.
      # @param to_id [String, nil] resolved recipient (+"^all"+ for channel chat).
      # @param text [String, nil] raw message text.
      # @param heard_time [Integer, nil] message rx_time.
      # @return [Boolean] true when the sender placeholder was named here (so the
      #   caller skips the generic +ensure_unknown_node+), false otherwise.
      def process_meshcore_chat_nodes(db, from_id, to_id, text, heard_time)
        return false unless to_id.to_s == "^all"
        return false unless string_or_nil(text)

        sender = parse_meshcore_sender_name(text)
        return false unless sender && string_or_nil(from_id)

        ensure_meshcore_chat_node(db, from_id, sender, heard_time)
        true
      end
    end
  end
end
