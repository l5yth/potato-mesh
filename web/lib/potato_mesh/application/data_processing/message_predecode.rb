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
      # The decode a message batch ran for one message before its write
      # transaction (SPEC BT4): the request, the port number and the base64
      # payload {#decrypted_payload_decode_request} gives, and the decoder's
      # result, nil when it failed or a bound skipped it (SPEC DB1-DB3).
      PredecodedPayload = Struct.new(:request, :decoded)

      # Decode, before a message batch takes the write lock, the payload of
      # every message that will ask for a decode (SPEC BT4, DB2).
      #
      # A decode starts a Python interpreter and may take up to the 4 s
      # deadline, so none runs while the batch's transaction holds the write
      # lock. Each message is read as {#insert_message} reads it before its
      # decode: bounded (SPEC SL3, SL5), with an id, +encrypted+ and no text,
      # its sender derived ({#message_sender_ids}, which only reads) and the
      # payload decrypted with the configured key. Every message whose
      # payload is a type the decoder reads takes one decode from +budget+,
      # in batch order, as before; a message whose reading raises gets none
      # here, and the batch skips it when the same error comes back while it
      # is written (SPEC BT3). A copy that the merge then drops (SPEC KC1)
      # was decoded all the same.
      #
      # @param db [SQLite3::Database] the request's database handle, outside
      #   any transaction.
      # @param messages [Array] the batch's records, as posted.
      # @param budget [PotatoMesh::App::Meshtastic::PayloadDecoder::Budget] the
      #   request's decodes (SPEC DB2).
      # @return [Hash{Hash=>PredecodedPayload}] the decode of each message that
      #   asked for one, keyed by the posted record itself.
      def predecode_message_payloads(db, messages, budget:)
        predecoded = {}.compare_by_identity
        messages.each do |message|
          # Held back here, a StandardError from another thread lands
          # outside the rescue below, which is for the reading's own errors.
          request = Thread.handle_interrupt(StandardError => :never) do
            message_decode_request(db, message)
          rescue StandardError
            nil
          end
          next unless request

          portnum, payload_b64, message_id = request
          decoded = PotatoMesh::App::Meshtastic::PayloadDecoder.decode(
            portnum: portnum,
            payload_b64: payload_b64,
            budget: budget,
            message_id: message_id,
          )
          predecoded[message] = PredecodedPayload.new([portnum, payload_b64], decoded)
        end
        predecoded
      end

      # The decode +message+ will ask for when it is written: its decrypted
      # payload's port number and base64 bytes, and its id, read as
      # {#insert_message} reads them (SPEC BT4).
      #
      # @param db [SQLite3::Database] open database handle, read only here.
      # @param message [Object] one posted record.
      # @return [Array(Integer, String, Integer), nil] port number, base64
      #   payload and message id; nil when the message asks for no decode.
      def message_decode_request(db, message)
        # Only a record carrying +encrypted+ can ask for a decode.
        return unless message.is_a?(Hash) && message["encrypted"]

        message = bound_message_payload(message)
        return unless message.is_a?(Hash)

        msg_id = coerce_integer(message["id"] || message["packet_id"])
        return unless msg_id

        text = message["text"]
        return unless string_or_nil(message["encrypted"]) && (text.nil? || text.to_s.strip.empty?)

        # The sender is derived on a copy, which the derivation fills in; the
        # write derives it again, inside the batch's transaction.
        message = message.dup
        _raw, _trimmed, from_id = message_sender_ids(db, message)
        channel_index = coerce_integer(message["channel"] || message["channel_index"] || message["channelIndex"])
        decrypted = decrypt_meshtastic_message(message, msg_id, from_id, message["from_num"], channel_index)
        request = decrypted && decrypted_payload_decode_request(decrypted, nil)
        request && [*request, msg_id]
      end
    end
  end
end
