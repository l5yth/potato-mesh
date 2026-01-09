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
    module Meshtastic
      # Minimal protobuf helpers for extracting payload bytes from Meshtastic data.
      module Protobuf
        module_function

        WIRE_TYPE_VARINT = 0
        WIRE_TYPE_64BIT = 1
        WIRE_TYPE_LENGTH_DELIMITED = 2
        WIRE_TYPE_32BIT = 5

        # Extract a length-delimited field from a protobuf message.
        #
        # @param payload [String] raw protobuf-encoded bytes.
        # @param field_number [Integer] field to extract.
        # @return [String, nil] field bytes or nil when absent/invalid.
        def extract_field_bytes(payload, field_number)
          return nil unless payload && field_number

          bytes = payload.bytes
          index = 0

          while index < bytes.length
            tag, index = read_varint(bytes, index)
            return nil unless tag

            field = tag >> 3
            wire = tag & 0x7

            case wire
            when WIRE_TYPE_VARINT
              _, index = read_varint(bytes, index)
              return nil unless index
            when WIRE_TYPE_64BIT
              index += 8
            when WIRE_TYPE_LENGTH_DELIMITED
              length, index = read_varint(bytes, index)
              return nil unless length
              return nil if index + length > bytes.length
              value = bytes[index, length].pack("C*")
              index += length
              return value if field == field_number
            when WIRE_TYPE_32BIT
              index += 4
            else
              return nil
            end
          end

          nil
        end

        # Read a protobuf varint from a byte array.
        #
        # @param bytes [Array<Integer>] byte stream.
        # @param index [Integer] read offset.
        # @return [Array(Integer, Integer), nil] value and new index or nil when invalid.
        def read_varint(bytes, index)
          shift = 0
          value = 0

          while index < bytes.length
            byte = bytes[index]
            index += 1
            value |= (byte & 0x7F) << shift
            return [value, index] if (byte & 0x80).zero?
            shift += 7
            return nil if shift > 63
          end

          nil
        end
      end
    end
  end
end
