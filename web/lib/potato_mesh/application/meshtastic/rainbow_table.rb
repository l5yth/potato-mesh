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

require_relative "channel_hash"
require_relative "channel_names"

module PotatoMesh
  module App
    module Meshtastic
      # Resolve candidate channel names for a hashed channel index.
      module RainbowTable
        module_function

        @tables = {}

        # Lookup candidate channel names for a hashed channel index.
        #
        # @param index [Integer, nil] channel hash byte.
        # @param psk_b64 [String, nil] base64 PSK or alias.
        # @return [Array<String>] list of candidate names.
        def channel_names_for(index, psk_b64:)
          return [] unless index.is_a?(Integer)

          table_for(psk_b64)[index] || []
        end

        # Build or retrieve the cached rainbow table for the given PSK.
        #
        # @param psk_b64 [String, nil] base64 PSK or alias.
        # @return [Hash{Integer=>Array<String>}] mapping of hash bytes to names.
        def table_for(psk_b64)
          key = psk_b64.to_s
          @tables[key] ||= build_table(psk_b64)
        end

        # Build a hash-to-name mapping for the provided PSK.
        #
        # @param psk_b64 [String, nil] base64 PSK or alias.
        # @return [Hash{Integer=>Array<String>}] mapping of hash bytes to names.
        def build_table(psk_b64)
          mapping = Hash.new { |hash, key| hash[key] = [] }

          ChannelNames::CHANNEL_NAME_CANDIDATES.each do |name|
            hash = ChannelHash.channel_hash(name, psk_b64)
            next unless hash

            mapping[hash] << name
          end

          mapping
        end
      end
    end
  end
end
