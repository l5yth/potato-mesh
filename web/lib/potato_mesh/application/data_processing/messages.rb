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
      # dedup, decryption, and per-protocol bookkeeping.  A copy of a stored
      # message merges into it through {#merge_message_copy}, which drops a
      # copy that names another sender (SPEC KC1-KC3).
      #
      # @param db [SQLite3::Database] open database handle.
      # @param message [Hash] inbound message payload.
      # @param protocol_cache [Hash, nil] optional per-batch ingestor protocol cache.
      # @param decode_budget [PotatoMesh::App::Meshtastic::PayloadDecoder::Budget, nil]
      #   the ingest request's payload decodes (SPEC DB2); nil sets no
      #   per-request cap.
      # @return [void]
      def insert_message(db, message, protocol_cache: nil, decode_budget: nil)
        message = bound_message_payload(message) # SPEC SL3/SL5/SL10: nil skips the message
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
        # A copy naming its sender only by number names the node that number
        # canonicalises to, the node the writes below touch, so the row and
        # the merge into a stored copy hold it to that sender (SPEC KC1).
        from_id ||= canonical_node_parts(nil, message["from_num"])&.first
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
        protocol = resolve_record_protocol(db, message, ingestor, cache: protocol_cache)
        # RF metrics (SPEC RF1/RF2): hops actually travelled and the MeshCore
        # hop-hash route; both additive and absent for legacy senders.
        hops = coerce_integer(message["hops"])
        path = string_or_nil(message["path"])
        # MeshCore flood scope (SPEC SC4/SC5): an invalid value stores NULL.
        scope = normalize_message_scope(message["scope"])
        # A MeshCore channel sender is only name-matched by the ingestor, so a
        # stale roster can hand back a retired key; re-rank it before anything
        # is stored, deduplicated, or touched (SPEC GN3).
        from_id = resolve_meshcore_channel_sender(db, from_id, to_id, text) if protocol == "meshcore"

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
          hops,
          path,
          scope,
          lora_freq,
          modem_preset,
          channel_name,
          reply_id,
          emoji,
          ingestor,
          protocol,
        ]

        # This copy's fields as the merge into a stored copy reads them.
        copy = {
          from_id: from_id, to_id: to_id, text: text, encrypted: encrypted, portnum: portnum,
          lora_freq: lora_freq, modem_preset: modem_preset, channel_name: channel_name,
          reply_id: reply_id, emoji: emoji, ingestor: ingestor, protocol: protocol, scope: scope,
          hops: hops, path: path, rx_time: rx_time, rx_iso: rx_iso,
          sender_present: sender_present, message: message,
        }

        # Sender id that survives collapse with any copy already stored (SPEC
        # MR3).  Starts as this copy's own sender and is narrowed below when an
        # existing row turns out to carry a better-evidenced identity.
        resolved_from_id = from_id

        with_busy_retry do
          # Each attempt starts from this copy's own id and sender, so a retry
          # after SQLite3::BusyException re-derives the survivor instead of
          # inheriting the previous attempt's choice.
          target_id = msg_id
          resolved_from_id = from_id

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
          # survivors are not cleaned up retroactively, since the backfill in
          # +Database#ensure_schema_upgrades+ is one-shot (``CONTRACTS.md``);
          # wrapping the pair in ``db.transaction(:immediate)`` is a future
          # tightening if the race is ever observed in production.
          if protocol == "meshcore" && from_id && channel_index && text && !text.to_s.empty?
            # Match on the sender-stable ``channel_name`` (NULL-safe ``IS ?``)
            # rather than the per-receiver ``channel`` slot index.  Two
            # ingestors store the same logical channel at different local
            # indices (e.g. ``#bot`` at slot 4 on one device, 6 on another), so
            # keying the dedup on the index lets the same physical transmission
            # through twice — the reported duplication.  The channel *name* is
            # carried in the message text/contact roster identically across
            # receivers, so it is the stable discriminator.  ``to_id`` is also
            # ``IS ?`` (rare meshcore nil fallback).
            #
            # A channel broadcast names its sender in the text ("Name: body"),
            # so ``text =`` already pins the claimed sender.  ``from_id`` is
            # each ingestor's own roster resolution of that name (the pubkey id,
            # or the name-derived synthetic id when the roster lacks the
            # sender; SPEC MR3), so it differs between copies of one
            # transmission and must not split them (#880).  Direct messages
            # carry no sender prefix and keep the ``from_id`` leg.
            #
            # Both forms constrain ``text = ?`` and an ``rx_time`` window, so
            # they search +idx_messages_meshcore_text+ (SPEC MX6) and come back
            # in ``rx_time, id`` order without a sort, however many channel
            # rows the table holds.
            rx_window = [rx_time - MESHCORE_CONTENT_DEDUP_WINDOW_SECONDS, rx_time + MESHCORE_CONTENT_DEDUP_WINDOW_SECONDS]
            duplicate_id = if to_id == "^all" && parse_meshcore_sender_name(text)
                db.get_first_value(<<~SQL, [channel_name, text, *rx_window, msg_id])
                  SELECT id FROM messages
                    WHERE protocol = 'meshcore'
                      AND to_id = '^all'
                      AND from_id IS NOT NULL
                      AND channel_name IS ?
                      AND text = ?
                      AND rx_time BETWEEN ? AND ?
                      AND id != ?
                    ORDER BY rx_time, id
                    LIMIT 1
                SQL
              else
                db.get_first_value(<<~SQL, [from_id, to_id, channel_name, text, *rx_window, msg_id])
                  SELECT id FROM messages
                    WHERE protocol = 'meshcore'
                      AND from_id = ?
                      AND to_id IS ?
                      AND channel_name IS ?
                      AND text = ?
                      AND rx_time BETWEEN ? AND ?
                      AND id != ?
                    ORDER BY rx_time, id
                    LIMIT 1
                SQL
              end
            if duplicate_id
              debug_log(
                "Collapsed meshcore message duplicate onto the stored copy",
                context: "data_processing.insert_message",
                new_id: msg_id,
                existing_id: duplicate_id,
                from_id: from_id,
                channel: channel_index,
              )
              # Apply this copy to the earliest matching row exactly as an id
              # hit: the update path below ranks the two senders (SPEC MR3),
              # fills columns the stored copy lacks, and credits the reception
              # to the resolved winner, as if both ingestors had derived one id.
              target_id = duplicate_id
            end
          end

          existing = stored_message_for_merge(db, target_id)
          unless existing
            PotatoMesh::App::Prometheus::MESSAGES_TOTAL.increment

            begin
              db.execute <<~SQL, row
                           INSERT INTO messages(id,rx_time,rx_iso,from_id,to_id,channel,portnum,text,encrypted,snr,rssi,hop_limit,hops,path,scope,lora_freq,modem_preset,channel_name,reply_id,emoji,ingestor,protocol)
                           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                         SQL
            rescue SQLite3::ConstraintException
              # Another ingestor's copy landed between the lookup and the
              # INSERT, precisely where two ingestors' copies meet (SPEC MR3):
              # merge into it as an id hit does (SPEC KC3).
              target_id = msg_id
              existing = stored_message_for_merge(db, target_id)
            end
          end

          if existing
            merged, resolved_from_id = merge_message_copy(db, target_id, existing, copy)
            return unless merged
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
            decode_budget: decode_budget,
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
          # MeshCore channel messages name their sender in the text; synthesize/
          # repair that placeholder node (issue #803) named from the text and
          # flagged synthetic, so it reconciles with the real contact — instead
          # of the generic "MeshCore <hex>" placeholder ensure_unknown_node would
          # mint.  Mentioned peers were not heard and get no node (SPEC GN1).
          # Falls through to ensure_unknown_node for non-MeshCore messages or
          # when no sender prefix is present.
          meshcore_sender_named =
            protocol == "meshcore" &&
            process_meshcore_chat_nodes(db, resolved_from_id || raw_from_id, to_id || raw_to_id, text, rx_time)
          unless meshcore_sender_named
            ensure_unknown_node(db, resolved_from_id || raw_from_id, message["from_num"], heard_time: rx_time, protocol: protocol)
          end
          touch_node_last_seen(
            db,
            resolved_from_id || raw_from_id || message["from_num"],
            message["from_num"],
            rx_time: rx_time,
            source: :message,
            lora_freq: lora_freq,
            modem_preset: modem_preset,
            protocol: protocol,
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
              protocol: protocol,
            )
          end
        end
      end
    end
  end
end
