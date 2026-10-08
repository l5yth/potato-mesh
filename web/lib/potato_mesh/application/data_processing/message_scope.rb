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
      # Longest accepted +messages.scope+ value in bytes.  MeshCore stores a
      # region name in a 31-byte, NUL-terminated slot, so a real name never
      # exceeds 30 bytes (SPEC SC5).
      MESSAGE_SCOPE_MAX_BYTES = 30

      # +messages.scope+ of a plain, unscoped MeshCore flood (SPEC SC4).
      MESSAGE_SCOPE_UNSCOPED = "*"

      # Reserved +messages.scope+ of a scoped flood whose region the ingestor
      # could not name (SPEC SC4).
      MESSAGE_SCOPE_UNKNOWN = "?"

      # Validate the flood +scope+ of an inbound message (SPEC SC4/SC5).
      #
      # A MeshCore ingestor posts the region name without its +#+, +*+ for a
      # plain unscoped flood, or the reserved +?+ for a scoped flood whose
      # region it cannot name; both tokens are single printable bytes, so one
      # rule covers all three.  Anything else - a non-string, invalid UTF-8,
      # an empty string, more than {MESSAGE_SCOPE_MAX_BYTES} bytes, or a
      # control character - is dropped to +nil+ so the message itself is still
      # stored (the route answers 201 either way).
      #
      # @param value [Object] raw +scope+ field of the message payload.
      # @return [String, nil] the scope to store, or +nil+.
      def normalize_message_scope(value)
        return nil unless value.is_a?(String) && value.valid_encoding?
        return nil unless value.bytesize.between?(1, MESSAGE_SCOPE_MAX_BYTES)
        return nil unless value.match?(/\A[[:print:]]+\z/)

        value
      end

      # Decide whether a later copy's scope replaces the stored one (SPEC SC6).
      #
      # A NULL scope takes any value. A stored {MESSAGE_SCOPE_UNKNOWN} takes a
      # resolved region name: a scoped packet's transport code is reproduced by
      # its true region and by another candidate name only by chance (SPEC SC3
      # gives the rate), so an ingestor that names the region knows more than
      # one that could not.
      # {MESSAGE_SCOPE_UNSCOPED} and a stored name are never replaced, and a
      # later {MESSAGE_SCOPE_UNKNOWN} replaces nothing.
      #
      # @param stored [String, nil] scope already on the row.
      # @param incoming [String, nil] validated scope of the later copy.
      # @return [Boolean] true when +incoming+ should be written.
      def message_scope_supersedes?(stored, incoming)
        return false if incoming.nil?
        return true if stored.nil?

        stored == MESSAGE_SCOPE_UNKNOWN && ![MESSAGE_SCOPE_UNKNOWN, MESSAGE_SCOPE_UNSCOPED].include?(incoming)
      end
    end
  end
end
