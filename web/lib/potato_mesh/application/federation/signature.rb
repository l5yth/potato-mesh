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
    module Federation
      # Build the canonical JSON payload that gets signed for instance
      # announcements.  Keys are emitted in deterministic order and only
      # populated when the corresponding attribute is non-nil.
      #
      # @param attributes [Hash] instance attributes hash.
      # @return [String] canonical JSON string suitable for signing.
      def canonical_instance_payload(attributes)
        data = {}
        data["contactLink"] = attributes[:contact_link] if attributes[:contact_link]
        data["id"] = attributes[:id] if attributes[:id]
        data["domain"] = attributes[:domain] if attributes[:domain]
        data["pubkey"] = attributes[:pubkey] if attributes[:pubkey]
        data["name"] = attributes[:name] if attributes[:name]
        data["version"] = attributes[:version] if attributes[:version]
        data["channel"] = attributes[:channel] if attributes[:channel]
        data["frequency"] = attributes[:frequency] if attributes[:frequency]
        data["latitude"] = attributes[:latitude] unless attributes[:latitude].nil?
        data["longitude"] = attributes[:longitude] unless attributes[:longitude].nil?
        data["lastUpdateTime"] = attributes[:last_update_time] unless attributes[:last_update_time].nil?
        data["isPrivate"] = attributes[:is_private] unless attributes[:is_private].nil?

        JSON.generate(data, sort_keys: true)
      end

      # Verify a base64 RSA-SHA256 signature for an instance attribute set.
      #
      # @param attributes [Hash] canonical instance attributes.
      # @param signature [String, nil] base64-encoded signature bytes.
      # @param public_key_pem [String, nil] PEM-encoded RSA public key.
      # @return [Boolean] true when the signature validates against the public key.
      def verify_instance_signature(attributes, signature, public_key_pem)
        return false unless signature && public_key_pem

        canonical = canonical_instance_payload(attributes)
        signature_bytes = Base64.strict_decode64(signature)
        key = OpenSSL::PKey::RSA.new(public_key_pem)
        key.verify(OpenSSL::Digest::SHA256.new, signature_bytes, canonical)
      rescue ArgumentError, OpenSSL::PKey::PKeyError
        false
      end
    end
  end
end
