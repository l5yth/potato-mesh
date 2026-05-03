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
      # Determine whether the canonical sender identifier should override the
      # sender supplied by the ingestor.  MeshCore packets that include a
      # +packet_id+ but no +id+ predate the canonical-id assignment, so we
      # prefer the canonical lookup when both are available.
      #
      # @param message [Hash] inbound message payload.
      # @return [Boolean] true when the canonical lookup wins.
      def prefer_canonical_sender?(message)
        message.is_a?(Hash) && message.key?("packet_id") && !message.key?("id")
      end

      # Attempt to decrypt an encrypted Meshtastic message payload.
      #
      # @param message [Hash] message payload supplied by the ingestor.
      # @param packet_id [Integer] message packet identifier.
      # @param from_id [String, nil] canonical node identifier when available.
      # @param from_num [Integer, nil] numeric node identifier when available.
      # @param channel_index [Integer, nil] channel hash index.
      # @return [Hash, nil] decrypted payload metadata when parsing succeeds.
      def decrypt_meshtastic_message(message, packet_id, from_id, from_num, channel_index)
        return nil unless message.is_a?(Hash)

        cipher_b64 = string_or_nil(message["encrypted"])
        return nil unless cipher_b64
        if (ENV["RACK_ENV"] == "test" || ENV["APP_ENV"] == "test" || defined?(RSpec)) &&
           ENV["MESHTASTIC_PSK_B64"].nil?
          return nil
        end

        node_num = coerce_integer(from_num)
        if node_num.nil?
          parts = canonical_node_parts(from_id)
          node_num = parts[1] if parts
        end
        return nil unless node_num

        psk_b64 = PotatoMesh::Config.meshtastic_psk_b64
        data = PotatoMesh::App::Meshtastic::Cipher.decrypt_data(
          cipher_b64: cipher_b64,
          packet_id: packet_id,
          from_id: from_id,
          from_num: node_num,
          psk_b64: psk_b64,
        )
        return nil unless data

        channel_name = nil
        if channel_index.is_a?(Integer)
          candidates = PotatoMesh::App::Meshtastic::RainbowTable.channel_names_for(
            channel_index,
            psk_b64: psk_b64,
          )
          channel_name = candidates.first if candidates.any?
        end

        {
          text: data[:text],
          portnum: data[:portnum],
          payload: data[:payload],
          channel_name: channel_name,
        }
      end

      # Persist a chat-layer message payload, performing meshcore content
      # dedup, decryption, and per-protocol bookkeeping.
      #
      # @param db [SQLite3::Database] open database handle.
      # @param message [Hash] inbound message payload.
      # @param protocol_cache [Hash, nil] optional per-batch ingestor protocol cache.
      # @return [void]
      def insert_message(db, message, protocol_cache: nil)
        return unless message.is_a?(Hash)

        msg_id = coerce_integer(message["id"] || message["packet_id"])
        return unless msg_id

        now = Time.now.to_i
        rx_time = coerce_integer(message["rx_time"])
        rx_time = now if rx_time.nil? || rx_time > now
        rx_iso = string_or_nil(message["rx_iso"])
        rx_iso ||= Time.at(rx_time).utc.iso8601

        raw_from_id = message["from_id"]
        if raw_from_id.nil? || raw_from_id.to_s.strip.empty?
          alt_from = message["from"]
          raw_from_id = alt_from unless alt_from.nil? || alt_from.to_s.strip.empty?
        end

        trimmed_from_id = string_or_nil(raw_from_id)
        canonical_from_id = string_or_nil(normalize_node_id(db, raw_from_id))
        from_id = trimmed_from_id
        if canonical_from_id
          if from_id.nil?
            from_id = canonical_from_id
          elsif prefer_canonical_sender?(message)
            from_id = canonical_from_id
          elsif from_id.start_with?("!") && from_id.casecmp(canonical_from_id) != 0
            from_id = canonical_from_id
          end
        end
        if from_id && !from_id.start_with?("^")
          canonical_parts = canonical_node_parts(from_id, message["from_num"])
          if canonical_parts && !from_id.start_with?("!")
            from_id = canonical_parts[0]
            message["from_num"] ||= canonical_parts[1]
          end
        end
        sender_present = !from_id.nil? || !coerce_integer(message["from_num"]).nil? || !trimmed_from_id.nil?

        raw_to_id = message["to_id"]
        raw_to_id = message["to"] if raw_to_id.nil? || raw_to_id.to_s.strip.empty?
        trimmed_to_id = string_or_nil(raw_to_id)
        canonical_to_id = string_or_nil(normalize_node_id(db, raw_to_id))
        to_id = trimmed_to_id
        if canonical_to_id
          if to_id.nil?
            to_id = canonical_to_id
          elsif to_id.start_with?("!") && to_id.casecmp(canonical_to_id) != 0
            to_id = canonical_to_id
          end
        end
        if to_id && !to_id.start_with?("^")
          canonical_parts = canonical_node_parts(to_id, message["to_num"])
          if canonical_parts && !to_id.start_with?("!")
            to_id = canonical_parts[0]
            message["to_num"] ||= canonical_parts[1]
          end
        end

        encrypted = string_or_nil(message["encrypted"])
        text = message["text"]
        portnum = message["portnum"]
        channel_index = coerce_integer(message["channel"] || message["channel_index"] || message["channelIndex"])

        decrypted_payload = nil
        decrypted_portnum = nil

        if encrypted && (text.nil? || text.to_s.strip.empty?)
          decrypted = decrypt_meshtastic_message(
            message,
            msg_id,
            from_id,
            message["from_num"],
            channel_index,
          )

          if decrypted
            decrypted_payload = decrypted
            decrypted_portnum = decrypted[:portnum]
          end
        end

        if encrypted && (text.nil? || text.to_s.strip.empty?)
          portnum = nil
          message.delete("portnum")
        end

        lora_freq = coerce_integer(message["lora_freq"] || message["loraFrequency"])
        modem_preset = string_or_nil(message["modem_preset"] || message["modemPreset"])
        channel_name = string_or_nil(message["channel_name"] || message["channelName"])
        reply_id = coerce_integer(message["reply_id"] || message["replyId"])
        emoji = string_or_nil(message["emoji"])
        ingestor = string_or_nil(message["ingestor"])
        protocol = resolve_protocol(db, ingestor, cache: protocol_cache)

        row = [
          msg_id,
          rx_time,
          rx_iso,
          from_id,
          to_id,
          message["channel"],
          portnum,
          text,
          encrypted,
          message["snr"],
          message["rssi"],
          message["hop_limit"],
          lora_freq,
          modem_preset,
          channel_name,
          reply_id,
          emoji,
          ingestor,
          protocol,
        ]

        with_busy_retry do
          # Meshcore-only content-level dedup (issue #756).  The deterministic
          # message id (``_derive_message_id`` in the Python ingestor) hashes
          # ``sender_timestamp`` among other fields, but the MeshCore library
          # has been observed delivering the same physical packet twice with
          # a rewritten ``sender_timestamp`` (relay/retransmit behaviour).
          # The PK path below cannot catch that — two copies compute two
          # different ids — so we add a narrow content+window pre-check here.
          #
          # Ruby integer ``0`` is truthy, so the ``channel_index`` guard
          # passes for the broadcast channel intentionally; we only skip when
          # the channel is absent/nil.  ``from_id`` + non-empty ``text`` keep
          # encrypted or anonymous traffic on the id-PK path.
          #
          # Known race: the SELECT and the downstream INSERT do not share a
          # transaction, so two Puma threads carrying the same content with
          # different ids can both pass the pre-check and both insert.  The
          # deploy-time backfill sweeps the survivors; wrapping the pair in
          # ``db.transaction(:immediate)`` is a future tightening if the race
          # is ever observed in production.
          if protocol == "meshcore" && from_id && channel_index && text && !text.to_s.empty?
            # ``channel = ?`` matches the ``channel_index`` bind cleanly
            # because the guard above rejects nil; ``to_id`` may legitimately
            # be nil (rare meshcore fallback), so it keeps ``IS ?`` for a
            # NULL-safe compare.
            duplicate_id = db.get_first_value(
              <<~SQL,
              SELECT id FROM messages
                WHERE protocol = 'meshcore'
                  AND from_id = ?
                  AND to_id IS ?
                  AND channel = ?
                  AND text = ?
                  AND rx_time BETWEEN ? AND ?
                  AND id != ?
                LIMIT 1
            SQL
              [from_id, to_id, channel_index, text,
               rx_time - MESHCORE_CONTENT_DEDUP_WINDOW_SECONDS,
               rx_time + MESHCORE_CONTENT_DEDUP_WINDOW_SECONDS, msg_id],
            )
            if duplicate_id
              debug_log(
                "Skipped meshcore message duplicate",
                context: "data_processing.insert_message",
                new_id: msg_id,
                existing_id: duplicate_id,
                from_id: from_id,
                channel: channel_index,
              )
              return
            end
          end

          existing = db.get_first_row(
            "SELECT from_id, to_id, text, encrypted, lora_freq, modem_preset, channel_name, reply_id, emoji, portnum, ingestor, protocol FROM messages WHERE id = ?",
            [msg_id],
          )
          if existing
            updates = {}
            existing_text = existing.is_a?(Hash) ? existing["text"] : existing[2]
            existing_text_str = existing_text&.to_s
            existing_has_text = existing_text_str && !existing_text_str.strip.empty?
            existing_from = existing.is_a?(Hash) ? existing["from_id"] : existing[0]
            existing_from_str = existing_from&.to_s
            return if !sender_present && (existing_from_str.nil? || existing_from_str.strip.empty?)
            existing_encrypted = existing.is_a?(Hash) ? existing["encrypted"] : existing[3]
            existing_encrypted_str = existing_encrypted&.to_s
            decrypted_precedence = text && existing_encrypted_str && !existing_encrypted_str.strip.empty?

            if from_id
              should_update = existing_from_str.nil? || existing_from_str.strip.empty?
              should_update ||= existing_from != from_id
              updates["from_id"] = from_id if should_update
            end

            if to_id
              existing_to = existing.is_a?(Hash) ? existing["to_id"] : existing[1]
              existing_to_str = existing_to&.to_s
              should_update = existing_to_str.nil? || existing_to_str.strip.empty?
              should_update ||= existing_to != to_id
              updates["to_id"] = to_id if should_update
            end

            if decrypted_precedence && existing_encrypted_str && !existing_encrypted_str.strip.empty?
              updates["encrypted"] = nil if existing_encrypted
            elsif encrypted && !existing_has_text
              should_update = existing_encrypted_str.nil? || existing_encrypted_str.strip.empty?
              should_update ||= existing_encrypted != encrypted
              updates["encrypted"] = encrypted if should_update
            end

            if text
              should_update = existing_text_str.nil? || existing_text_str.strip.empty?
              should_update ||= existing_text != text
              updates["text"] = text if should_update
            end

            if decrypted_precedence
              updates["channel"] = message["channel"] if message.key?("channel")
              updates["snr"] = message["snr"] if message.key?("snr")
              updates["rssi"] = message["rssi"] if message.key?("rssi")
              updates["hop_limit"] = message["hop_limit"] if message.key?("hop_limit")
              updates["lora_freq"] = lora_freq unless lora_freq.nil?
              updates["modem_preset"] = modem_preset if modem_preset
              updates["channel_name"] = channel_name if channel_name
              updates["rx_time"] = rx_time if rx_time
              updates["rx_iso"] = rx_iso if rx_iso
            end

            if portnum
              existing_portnum = existing.is_a?(Hash) ? existing["portnum"] : existing[9]
              existing_portnum_str = existing_portnum&.to_s
              should_update = existing_portnum_str.nil? || existing_portnum_str.strip.empty?
              should_update ||= existing_portnum != portnum
              should_update ||= decrypted_precedence
              updates["portnum"] = portnum if should_update
            end

            unless lora_freq.nil?
              existing_lora = existing.is_a?(Hash) ? existing["lora_freq"] : existing[4]
              updates["lora_freq"] = lora_freq if existing_lora != lora_freq
            end

            if modem_preset
              existing_preset = existing.is_a?(Hash) ? existing["modem_preset"] : existing[5]
              existing_preset_str = existing_preset&.to_s
              should_update = existing_preset_str.nil? || existing_preset_str.strip.empty?
              should_update ||= existing_preset != modem_preset
              updates["modem_preset"] = modem_preset if should_update
            end

            if channel_name
              existing_channel = existing.is_a?(Hash) ? existing["channel_name"] : existing[6]
              existing_channel_str = existing_channel&.to_s
              should_update = existing_channel_str.nil? || existing_channel_str.strip.empty?
              should_update ||= existing_channel != channel_name
              updates["channel_name"] = channel_name if should_update
            end

            unless reply_id.nil?
              existing_reply = existing.is_a?(Hash) ? existing["reply_id"] : existing[7]
              updates["reply_id"] = reply_id if existing_reply != reply_id
            end

            if emoji
              existing_emoji = existing.is_a?(Hash) ? existing["emoji"] : existing[8]
              existing_emoji_str = existing_emoji&.to_s
              should_update = existing_emoji_str.nil? || existing_emoji_str.strip.empty?
              should_update ||= existing_emoji != emoji
              updates["emoji"] = emoji if should_update
            end

            if ingestor
              existing_ingestor = existing.is_a?(Hash) ? existing["ingestor"] : existing[10]
              existing_ingestor = string_or_nil(existing_ingestor)
              updates["ingestor"] = ingestor if existing_ingestor.nil?
            end

            existing_protocol = existing.is_a?(Hash) ? existing["protocol"] : existing[11]
            return if existing_protocol && existing_protocol != "meshtastic" && existing_protocol != protocol
            updates["protocol"] = protocol if (existing_protocol.nil? || existing_protocol == "meshtastic") && protocol != "meshtastic"

            unless updates.empty?
              assignments = updates.keys.map { |column| "#{column} = ?" }.join(", ")
              db.execute("UPDATE messages SET #{assignments} WHERE id = ?", updates.values + [msg_id])
            end
          else
            PotatoMesh::App::Prometheus::MESSAGES_TOTAL.increment

            begin
              db.execute <<~SQL, row
                           INSERT INTO messages(id,rx_time,rx_iso,from_id,to_id,channel,portnum,text,encrypted,snr,rssi,hop_limit,lora_freq,modem_preset,channel_name,reply_id,emoji,ingestor,protocol)
                           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                         SQL
            rescue SQLite3::ConstraintException
              existing_row = db.get_first_row(
                "SELECT text, encrypted, ingestor, protocol FROM messages WHERE id = ?",
                [msg_id],
              )
              existing_text = existing_row.is_a?(Hash) ? existing_row["text"] : existing_row&.[](0)
              existing_text_str = existing_text&.to_s
              allow_encrypted_update = existing_text_str.nil? || existing_text_str.strip.empty?
              existing_encrypted = existing_row.is_a?(Hash) ? existing_row["encrypted"] : existing_row&.[](1)
              existing_encrypted_str = existing_encrypted&.to_s
              existing_ingestor = existing_row.is_a?(Hash) ? existing_row["ingestor"] : existing_row&.[](2)
              existing_ingestor = string_or_nil(existing_ingestor)
              existing_fallback_protocol = existing_row.is_a?(Hash) ? existing_row["protocol"] : existing_row&.[](3)
              # Guard against cross-protocol contamination in the constraint fallback path,
              # mirroring the same guard applied in the primary update path above.
              return if existing_fallback_protocol && existing_fallback_protocol != "meshtastic" && existing_fallback_protocol != protocol
              decrypted_precedence = text && existing_encrypted_str && !existing_encrypted_str.strip.empty?

              fallback_updates = {}
              fallback_updates["from_id"] = from_id if from_id
              fallback_updates["to_id"] = to_id if to_id
              fallback_updates["text"] = text if text
              fallback_updates["encrypted"] = encrypted if encrypted && allow_encrypted_update
              fallback_updates["portnum"] = portnum if portnum
              if decrypted_precedence
                fallback_updates["channel"] = message["channel"] if message.key?("channel")
                fallback_updates["snr"] = message["snr"] if message.key?("snr")
                fallback_updates["rssi"] = message["rssi"] if message.key?("rssi")
                fallback_updates["hop_limit"] = message["hop_limit"] if message.key?("hop_limit")
                fallback_updates["portnum"] = portnum if portnum
                fallback_updates["lora_freq"] = lora_freq unless lora_freq.nil?
                fallback_updates["modem_preset"] = modem_preset if modem_preset
                fallback_updates["channel_name"] = channel_name if channel_name
                fallback_updates["rx_time"] = rx_time if rx_time
                fallback_updates["rx_iso"] = rx_iso if rx_iso
              else
                fallback_updates["lora_freq"] = lora_freq unless lora_freq.nil?
                fallback_updates["modem_preset"] = modem_preset if modem_preset
                fallback_updates["channel_name"] = channel_name if channel_name
              end
              fallback_updates["reply_id"] = reply_id unless reply_id.nil?
              fallback_updates["emoji"] = emoji if emoji
              fallback_updates["ingestor"] = ingestor if ingestor && existing_ingestor.nil?
              fallback_updates["protocol"] = protocol if (existing_fallback_protocol.nil? || existing_fallback_protocol == "meshtastic") && protocol != "meshtastic"
              unless fallback_updates.empty?
                assignments = fallback_updates.keys.map { |column| "#{column} = ?" }.join(", ")
                db.execute("UPDATE messages SET #{assignments} WHERE id = ?", fallback_updates.values + [msg_id])
              end
            end
          end
        end

        stored_decrypted = nil
        if decrypted_payload
          stored_decrypted = store_decrypted_payload(
            db,
            message,
            msg_id,
            decrypted_payload,
            rx_time: rx_time,
            rx_iso: rx_iso,
            from_id: from_id,
            to_id: to_id,
            channel: message["channel"],
            portnum: portnum || decrypted_portnum,
            hop_limit: message["hop_limit"],
            snr: message["snr"],
            rssi: message["rssi"],
          )
        end

        if stored_decrypted && encrypted
          with_busy_retry do
            db.execute("UPDATE messages SET encrypted = NULL WHERE id = ?", [msg_id])
          end
          debug_log(
            "Cleared encrypted payload after decoding",
            context: "data_processing.insert_message",
            message_id: msg_id,
            portnum: portnum || decrypted_portnum,
          )
        end

        should_touch_message = !stored_decrypted
        if should_touch_message
          ensure_unknown_node(db, from_id || raw_from_id, message["from_num"], heard_time: rx_time, protocol: protocol)
          touch_node_last_seen(
            db,
            from_id || raw_from_id || message["from_num"],
            message["from_num"],
            rx_time: rx_time,
            source: :message,
            lora_freq: lora_freq,
            modem_preset: modem_preset,
          )

          ensure_unknown_node(db, to_id || raw_to_id, message["to_num"], heard_time: rx_time, protocol: protocol) if to_id || raw_to_id
          if to_id || raw_to_id || message.key?("to_num")
            touch_node_last_seen(
              db,
              to_id || raw_to_id || message["to_num"],
              message["to_num"],
              rx_time: rx_time,
              source: :message,
              lora_freq: lora_freq,
              modem_preset: modem_preset,
            )
          end
        end
      end
    end
  end
end
