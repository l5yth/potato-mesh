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

module PotatoMesh
  module App
    module Meshtastic
      # Compute Meshtastic channel hashes from a name and pre-shared key.
      module ChannelHash
        module_function

        DEFAULT_PSK_ALIAS_KEYS = {
          1 => [
            0xD4, 0xF1, 0xBB, 0x3A, 0x20, 0x29, 0x07, 0x59,
            0xF0, 0xBC, 0xFF, 0xAB, 0xCF, 0x4E, 0x69, 0x01,
          ].pack("C*"),
          2 => [
            0x38, 0x4B, 0xBC, 0xC0, 0x1D, 0xC0, 0x22, 0xD1,
            0x81, 0xBF, 0x36, 0xB8, 0x61, 0x21, 0xE1, 0xFB,
            0x96, 0xB7, 0x2E, 0x55, 0xBF, 0x74, 0x22, 0x7E,
            0x9D, 0x6A, 0xFB, 0x48, 0xD6, 0x4C, 0xB1, 0xA1,
          ].pack("C*"),
        }.freeze

        # Calculate the Meshtastic channel hash for the given name and PSK.
        #
        # @param name [String] channel name candidate.
        # @param psk_b64 [String, nil] base64-encoded PSK or PSK alias.
        # @return [Integer, nil] channel hash byte or nil when inputs are invalid.
        def channel_hash(name, psk_b64)
          return nil unless name

          key = expanded_key(psk_b64)
          return nil unless key

          h_name = xor_bytes(name.b)
          h_key = xor_bytes(key)

          (h_name ^ h_key) & 0xFF
        end

        # Expand the provided PSK into a valid AES key length.
        #
        # @param psk_b64 [String, nil] base64 PSK value.
        # @return [String, nil] expanded key bytes or nil when invalid.
        def expanded_key(psk_b64)
          raw = Base64.decode64(psk_b64.to_s)

          case raw.bytesize
          when 0
            "".b
          when 1
            default_key_for_alias(raw.bytes.first)
          when 2..15
            (raw.bytes + [0] * (16 - raw.bytesize)).pack("C*")
          when 16
            raw
          when 17..31
            (raw.bytes + [0] * (32 - raw.bytesize)).pack("C*")
          when 32
            raw
          else
            nil
          end
        end

        # Map PSK alias bytes to their default key material.
        #
        # @param alias_index [Integer, nil] alias identifier for the PSK.
        # @return [String, nil] key bytes or nil when unknown.
        def default_key_for_alias(alias_index)
          return nil unless alias_index

          DEFAULT_PSK_ALIAS_KEYS[alias_index]&.dup
        end

        # XOR all bytes in the given string or byte array.
        #
        # @param value [String, Array<Integer>] input byte sequence.
        # @return [Integer] XOR of all bytes.
        def xor_bytes(value)
          bytes = value.is_a?(String) ? value.bytes : value
          bytes.reduce(0) { |acc, byte| (acc ^ byte) & 0xFF }
        end
      end
    end
  end
end
