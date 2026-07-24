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

require "digest"

module PotatoMesh
  module App
    module DataProcessing
      # Synthesize and repair the placeholder node records implied by MeshCore
      # channel chat text (issue #803).
      #
      # A MeshCore channel message encodes its sender as a +"SenderName: body"+
      # text prefix and quotes/mentions peers as +@[Name]+.  The sender's
      # +from_id+ is a name-derived synthetic id.  These helpers create the
      # placeholder named from that text and marked +synthetic+, so the existing
      # issue-#755 merge machinery reconciles it with the real contact
      # advertisement — instead of the generic +"MeshCore <hex>"+ stand-in that
      # +ensure_unknown_node+ would mint (which is mis-recorded as a real
      # +synthetic=0+ node, shows the wrong name, and never reconciles).

      # Matches +@[Name]+ mention patterns in a MeshCore message body.  Mirrors
      # the ingestor's +_MENTION_RE+ and the frontend mention regex so all three
      # layers agree on what a mention is.
      MESHCORE_MENTION_RE = /@\[([^\]]+)\]/.freeze

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

      # Extract the trimmed, de-duplicated +@[Name]+ mentions from a body.
      #
      # @param text [String, nil] raw message text.
      # @return [Array<String>] mention names in first-seen order (may be empty).
      def extract_meshcore_mentions(text)
        return [] unless text.is_a?(String)

        text.scan(MESHCORE_MENTION_RE).map { |match| match[0].strip }.reject(&:empty?).uniq
      end

      # Derive the deterministic synthetic node id for a MeshCore display name.
      #
      # Uses the first four bytes of +SHA-256(UTF-8 name)+ as +"!xxxxxxxx"+.  The
      # name is trimmed first so a reference and its bracket-padded variant
      # (+@[ Name ]+) converge on one row and align with the frontend's trimmed
      # mention/sender resolution; for the unpadded names that dominate in
      # practice this equals the Python ingestor's +_derive_synthetic_node_id+
      # (the sender path does not derive at all — it reuses the message +from_id+).
      #
      # @param name [String, nil] display name.
      # @return [String, nil] canonical +"!xxxxxxxx"+ id, or nil for a blank name.
      def meshcore_synthetic_node_id(name)
        return nil unless name.is_a?(String)

        trimmed = name.strip
        return nil if trimmed.empty?

        "!" + Digest::SHA256.hexdigest(trimmed)[0, 8]
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

      # Create or repair the MeshCore chat placeholder node for a display name.
      #
      # The node is upserted as a synthetic (+synthetic=1+) COMPANION named
      # +long_name+, so the existing #755 merge reconciles it with the real
      # contact when that advertisement arrives.  A pre-existing generic
      # +"MeshCore <hex>"+ placeholder that was mis-recorded as real
      # (+synthetic=0+) is first demoted to synthetic so the parsed name can take
      # over — the real-node guard in +upsert_node+ would otherwise protect the
      # stale generic name.  A genuine real node (non-generic name, +synthetic=0+)
      # is left untouched.
      #
      # @param db [SQLite3::Database] open database handle.
      # @param node_id [String, nil] canonical node id to name.
      # @param long_name [String, nil] display name parsed from the message text.
      # @param heard_time [Integer, nil] message rx_time used as last/first heard.
      # @return [void]
      def ensure_meshcore_chat_node(db, node_id, long_name, heard_time)
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

      # Synthesize/repair sender + mention placeholder nodes for a MeshCore
      # channel message, replacing the generic +ensure_unknown_node+ placeholder
      # for the sender.
      #
      # Only broadcast (+"^all"+) MeshCore messages are channel chat; direct
      # messages carry no +"Name:"+ prefix, so a stray colon in their body must
      # not be mistaken for a sender.  Mentions are synthesized for every channel
      # message (they exist only in channel chat).
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

        extract_meshcore_mentions(text).each do |mention|
          ensure_meshcore_chat_node(db, meshcore_synthetic_node_id(mention), mention, heard_time)
        end

        sender = parse_meshcore_sender_name(text)
        return false unless sender && string_or_nil(from_id)

        ensure_meshcore_chat_node(db, from_id, sender, heard_time)
        true
      end
    end
  end
end
