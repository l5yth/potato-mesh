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

require "base64"
require "openssl"

require_relative "channel_hash"
require_relative "protobuf"

module PotatoMesh
  module App
    module Meshtastic
      # Decrypt Meshtastic payloads with AES-CTR using Meshtastic nonce rules.
      module Cipher
        module_function

        DEFAULT_PSK_B64 = "AQ=="
        TEXT_MESSAGE_PORTNUM = 1
        # Number of characters required for full confidence scoring.
        CONFIDENCE_LENGTH_TARGET = 8.0

        # Decrypt an encrypted Meshtastic payload into UTF-8 text.
        #
        # @param cipher_b64 [String] base64-encoded encrypted payload.
        # @param packet_id [Integer] packet identifier used for the nonce.
        # @param from_id [String, nil] Meshtastic node identifier (e.g. "!9e95cf60").
        # @param from_num [Integer, nil] numeric node identifier override.
        # @param psk_b64 [String, nil] base64 PSK or alias.
        # @return [String, nil] decrypted text or nil when decryption fails.
        def decrypt_text(cipher_b64:, packet_id:, from_id: nil, from_num: nil, psk_b64: DEFAULT_PSK_B64)
          data = decrypt_data(
            cipher_b64: cipher_b64,
            packet_id: packet_id,
            from_id: from_id,
            from_num: from_num,
            psk_b64: psk_b64,
          )

          data && data[:text]
        end

        # Decrypt the Meshtastic data protobuf payload.
        #
        # @param cipher_b64 [String] base64-encoded encrypted payload.
        # @param packet_id [Integer] packet identifier used for the nonce.
        # @param from_id [String, nil] Meshtastic node identifier.
        # @param from_num [Integer, nil] numeric node identifier override.
        # @param psk_b64 [String, nil] base64 PSK or alias.
        # @return [Hash, nil] decrypted data payload details or nil when decryption fails.
        def decrypt_data(cipher_b64:, packet_id:, from_id: nil, from_num: nil, psk_b64: DEFAULT_PSK_B64)
          ciphertext = Base64.strict_decode64(cipher_b64)
          key = ChannelHash.expanded_key(psk_b64)
          return nil unless key
          return nil unless [16, 32].include?(key.bytesize)

          packet_value = normalize_packet_id(packet_id)
          return nil unless packet_value

          from_value = normalize_node_num(from_id, from_num)
          return nil unless from_value

          nonce = build_nonce(packet_value, from_value)
          plaintext = decrypt_aes_ctr(ciphertext, key, nonce)
          return nil unless plaintext

          data = Protobuf.parse_data(plaintext)
          return nil unless data

          text = nil
          decryption_confidence = nil
          if data[:portnum] == TEXT_MESSAGE_PORTNUM
            candidate = data[:payload].dup.force_encoding("UTF-8")
            if candidate.valid_encoding? && !candidate.empty?
              text = candidate
              decryption_confidence = text_confidence(text)
            end
          end

          {
            portnum: data[:portnum],
            payload: data[:payload],
            text: text,
            decryption_confidence: decryption_confidence,
          }
        rescue ArgumentError, OpenSSL::Cipher::CipherError
          nil
        end

        # Decrypt the Meshtastic data protobuf payload bytes.
        #
        # @param cipher_b64 [String] base64-encoded encrypted payload.
        # @param packet_id [Integer] packet identifier used for the nonce.
        # @param from_id [String, nil] Meshtastic node identifier.
        # @param from_num [Integer, nil] numeric node identifier override.
        # @param psk_b64 [String, nil] base64 PSK or alias.
        # @return [String, nil] payload bytes or nil when decryption fails.
        def decrypt_payload_bytes(cipher_b64:, packet_id:, from_id: nil, from_num: nil, psk_b64: DEFAULT_PSK_B64)
          data = decrypt_data(
            cipher_b64: cipher_b64,
            packet_id: packet_id,
            from_id: from_id,
            from_num: from_num,
            psk_b64: psk_b64,
          )

          data && data[:payload]
        end

        # Build the Meshtastic AES nonce from packet and node identifiers.
        #
        # @param packet_id [Integer] packet identifier.
        # @param from_num [Integer] numeric node identifier.
        # @return [String] 16-byte nonce.
        def build_nonce(packet_id, from_num)
          [packet_id].pack("Q<") + [from_num].pack("L<") + ("\x00" * 4)
        end

        # Decrypt data using AES-CTR with the derived nonce.
        #
        # @param ciphertext [String] encrypted payload bytes.
        # @param key [String] expanded AES key bytes.
        # @param nonce [String] 16-byte nonce.
        # @return [String] decrypted plaintext bytes.
        def decrypt_aes_ctr(ciphertext, key, nonce)
          cipher_name = key.bytesize == 16 ? "aes-128-ctr" : "aes-256-ctr"
          cipher = OpenSSL::Cipher.new(cipher_name)
          cipher.decrypt
          cipher.key = key
          cipher.iv = nonce
          cipher.update(ciphertext) + cipher.final
        end

        # Normalise the packet identifier into an integer.
        #
        # @param packet_id [Integer, nil] packet identifier.
        # @return [Integer, nil] validated packet id or nil when invalid.
        def normalize_packet_id(packet_id)
          return packet_id if packet_id.is_a?(Integer) && packet_id >= 0
          return nil if packet_id.nil?

          if packet_id.is_a?(Numeric)
            return nil if packet_id.negative?
            return packet_id.to_i
          end

          return nil unless packet_id.respond_to?(:to_s)

          trimmed = packet_id.to_s.strip
          return nil if trimmed.empty?
          return trimmed.to_i(10) if trimmed.match?(/\A\d+\z/)

          nil
        end

        # Score the plausibility of decrypted text content.
        #
        # @param text [String] decrypted text candidate.
        # @return [Float] confidence score between 0.0 and 1.0.
        def text_confidence(text)
          return 0.0 unless text.is_a?(String)
          return 0.0 if text.empty?

          total = text.length.to_f
          length_score = [total / CONFIDENCE_LENGTH_TARGET, 1.0].min
          control_count = text.scan(/[\p{Cc}\p{Cs}]/).length
          control_ratio = control_count / total
          acceptable_count = text.scan(/[\p{L}\p{N}\p{P}\p{S}\p{Zs}\t\n\r]/).length
          acceptable_ratio = acceptable_count / total

          score = length_score * acceptable_ratio * (1.0 - control_ratio)
          score.clamp(0.0, 1.0)
        end

        # Resolve the node number from any of the supported identifiers.
        #
        # @param from_id [String, nil] Meshtastic node identifier.
        # @param from_num [Integer, nil] numeric node identifier override.
        # @return [Integer, nil] node number or nil when invalid.
        def normalize_node_num(from_id, from_num)
          if from_num.is_a?(Integer)
            return from_num & 0xFFFFFFFF
          elsif from_num.is_a?(Numeric)
            return from_num.to_i & 0xFFFFFFFF
          end

          return nil unless from_id

          trimmed = from_id.to_s.strip
          return nil if trimmed.empty?

          hex = trimmed.delete_prefix("!")
          hex = hex[2..] if hex.start_with?("0x", "0X")
          return nil unless hex.match?(/\A[0-9A-Fa-f]+\z/)

          hex.to_i(16) & 0xFFFFFFFF
        end
      end
    end
  end
end
