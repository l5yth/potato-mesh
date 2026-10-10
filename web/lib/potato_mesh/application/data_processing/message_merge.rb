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
      # Columns of a stored message that a later copy is merged against, in
      # the order {#stored_message_for_merge} selects them.
      MESSAGE_MERGE_COLUMNS = %w[
        from_id to_id text encrypted lora_freq modem_preset channel_name
        reply_id emoji portnum ingestor protocol scope
      ].freeze

      # Read the stored message that a later copy merges into.
      #
      # The id hit, the MeshCore content-dedup hit and the INSERT-race
      # recovery all read the row through this one lookup (SPEC KC3).
      #
      # @param db [SQLite3::Database] open database handle.
      # @param id [Integer] message id.
      # @return [Hash{String=>Object}, nil] the {MESSAGE_MERGE_COLUMNS} keyed by
      #   name, whether the handle returns rows as hashes or as arrays; nil
      #   when no row holds +id+.
      def stored_message_for_merge(db, id)
        row = db.get_first_row(
          "SELECT #{MESSAGE_MERGE_COLUMNS.join(", ")} FROM messages WHERE id = ?",
          [id],
        )
        return row if row.nil? || row.is_a?(Hash)

        MESSAGE_MERGE_COLUMNS.zip(row).to_h
      end

      # Merge a later copy of a message into the row stored under its id.
      #
      # One rule for the id hit, the MeshCore content-dedup hit and the
      # INSERT-race recovery (SPEC KC3).  The copy is dropped, and the row
      # left as it is, when neither names a sender, when the row belongs to
      # another protocol than the copy (a +meshtastic+ row, the default, takes
      # any), and when a copy of any protocol but MeshCore names another
      # sender than the row: its packet names its own sender, so the id was
      # reused, by chance or on purpose, and the message stored first stays
      # (SPEC KC1, logged at warn as SPEC KC5 limits).  A copy naming its
      # sender only by number reaches here with the id that number names.
      # MeshCore copies name the sender each ingestor's roster resolved, so
      # a strictly better-evidenced id replaces the stored one instead (SPEC
      # MR3).
      #
      # Otherwise the copy fills a sender, recipient, text, reply, emoji and
      # portnum the row lacks and never replaces one (SPEC KC2).  A copy with
      # text for an encrypted row is its decrypted form: it clears the
      # ciphertext and its signal fields and receive time replace the
      # stored ones.  +lora_freq+, +modem_preset+ and +channel_name+ follow
      # the copy, the first ingestor stays, and +scope+ follows SPEC SC6.
      #
      # @param db [SQLite3::Database] open database handle.
      # @param id [Integer] id of the stored row.
      # @param stored [Hash{String=>Object}] the row as
      #   {#stored_message_for_merge} reads it.
      # @param copy [Hash{Symbol=>Object}] the copy's normalised fields:
      #   +:from_id+, +:to_id+, +:text+, +:encrypted+, +:portnum+,
      #   +:lora_freq+, +:modem_preset+, +:channel_name+, +:reply_id+,
      #   +:emoji+, +:ingestor+, +:protocol+, +:scope+, +:hops+, +:path+,
      #   +:rx_time+, +:rx_iso+, +:sender_present+ (any sender reference,
      #   numeric included) and +:message+ (the raw payload, read for its
      #   +channel+, +snr+, +rssi+ and +hop_limit+ keys).
      # @return [Array(Boolean, String)] whether the copy merged, and the
      #   sender the reception is credited to (nil when the copy names none).
      def merge_message_copy(db, id, stored, copy)
        stored_from = string_or_nil(stored["from_id"])
        protocol = copy[:protocol]
        stored_protocol = stored["protocol"]
        # Nothing ties a copy without a sender to a row without one.
        return [false, nil] if !copy[:sender_present] && stored_from.nil?
        # Never merge across protocols (the cross-protocol guard).
        return [false, nil] if stored_protocol && stored_protocol != "meshtastic" && stored_protocol != protocol

        updates = {}
        from_id = copy[:from_id]
        resolved_from_id = from_id
        if from_id
          fill = stored_from.nil?
          if !fill && stored["from_id"] != from_id
            if protocol == "meshcore"
              fill = meshcore_sender_supersedes?(db, stored["from_id"], from_id)
            else
              warn_collision(
                "Dropped a message copy naming another sender",
                context: "data_processing.insert_message",
                message_id: id,
                stored_from_id: stored_from,
                from_id: from_id,
              )
              return [false, nil]
            end
          end
          updates["from_id"] = from_id if fill
          # Placeholder synthesis and the last-heard touch follow the id that
          # survived, so a losing copy grants no liveness to the one it names.
          resolved_from_id = fill ? from_id : stored_from
        end

        updates["to_id"] = copy[:to_id] if copy[:to_id] && string_or_nil(stored["to_id"]).nil?

        text = copy[:text]
        stored_has_text = !string_or_nil(stored["text"]).nil?
        # A copy with text for an encrypted row is that packet decrypted.
        decrypted = text && !string_or_nil(stored["encrypted"]).nil?
        if decrypted
          updates["encrypted"] = nil
        elsif copy[:encrypted] && !stored_has_text && stored["encrypted"] != copy[:encrypted]
          updates["encrypted"] = copy[:encrypted]
        end
        updates["text"] = text if text && !stored_has_text

        if decrypted
          message = copy[:message]
          %w[channel snr rssi hop_limit].each { |column| updates[column] = message[column] if message.key?(column) }
          updates["hops"] = copy[:hops] unless copy[:hops].nil?
          updates["path"] = copy[:path] if copy[:path]
          updates["rx_time"] = copy[:rx_time]
          updates["rx_iso"] = copy[:rx_iso]
        end

        updates["portnum"] = copy[:portnum] if copy[:portnum] && string_or_nil(stored["portnum"]).nil?
        %i[lora_freq modem_preset channel_name].each do |column|
          value = copy[column]
          updates[column.to_s] = value if !value.nil? && stored[column.to_s] != value
        end
        updates["reply_id"] = copy[:reply_id] if !copy[:reply_id].nil? && stored["reply_id"].nil?
        updates["emoji"] = copy[:emoji] if copy[:emoji] && string_or_nil(stored["emoji"]).nil?
        updates["ingestor"] = copy[:ingestor] if copy[:ingestor] && string_or_nil(stored["ingestor"]).nil?
        updates["scope"] = copy[:scope] if message_scope_supersedes?(stored["scope"], copy[:scope])
        updates["protocol"] = protocol if (stored_protocol.nil? || stored_protocol == "meshtastic") && protocol != "meshtastic"

        unless updates.empty?
          assignments = updates.keys.map { |column| "#{column} = ?" }.join(", ")
          db.execute("UPDATE messages SET #{assignments} WHERE id = ?", updates.values + [id])
        end
        [true, resolved_from_id]
      end
    end
  end
end
