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
      # Build a canonical signed JSON payload: snake_case keys in deterministic
      # order (+sort_keys+), with +signature_version+ stamped inside so the format
      # cannot be silently downgraded.  Shared by the instance-announcement and
      # well-known signers (SPEC FS1/FS3/FS4, option U0).  Nil fields are omitted.
      #
      # @param fields [Hash{String,Symbol => Object}] snake_case wire fields.
      # @param signature_version [Integer] format marker baked into the payload.
      # @return [String] canonical JSON string suitable for signing/verifying.
      def canonical_signed_payload(fields, signature_version: PotatoMesh::Config.federation_signature_version)
        data = {}
        fields.each { |key, value| data[key.to_s] = value unless value.nil? }
        data["signature_version"] = signature_version
        JSON.generate(data, sort_keys: true)
      end

      # v2 (snake_case) canonical for an instance announcement.  Signs every
      # announced attribute, including all node counts (SPEC FS1/FS2) — nothing
      # in the announced payload sits outside this blob except the signature.
      #
      # @param attributes [Hash] instance attributes hash.
      # @return [String] canonical JSON string.
      def canonical_instance_payload_v2(attributes)
        canonical_signed_payload({
          "channel" => attributes[:channel],
          "contact_link" => attributes[:contact_link],
          "domain" => attributes[:domain],
          "frequency" => attributes[:frequency],
          "id" => attributes[:id],
          "is_private" => attributes[:is_private],
          "last_update" => attributes[:last_update_time],
          "latitude" => attributes[:latitude],
          "longitude" => attributes[:longitude],
          "meshcore_nodes_count" => attributes[:meshcore_nodes_count],
          "meshtastic_nodes_count" => attributes[:meshtastic_nodes_count],
          "name" => attributes[:name],
          "nodes_count" => attributes[:nodes_count],
          "public_key" => attributes[:pubkey],
          "reticulum_nodes_count" => attributes[:reticulum_nodes_count],
          "version" => attributes[:version],
        })
      end

      # v1 (legacy camelCase) canonical — retained verbatim so a pre-0.7.0 peer's
      # signature still verifies (SPEC FS4 backward-accept).  MUST reproduce the
      # exact bytes older instances signed; do not modify.
      #
      # @param attributes [Hash] instance attributes hash.
      # @return [String] canonical JSON string.
      def canonical_instance_payload_v1(attributes)
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

      # Canonical used when SIGNING our own announcement — always the current
      # (v2) form (SPEC FS4 send-snake).
      #
      # @param attributes [Hash] instance attributes hash.
      # @return [String] canonical JSON string suitable for signing.
      def canonical_instance_payload(attributes)
        canonical_instance_payload_v2(attributes)
      end

      # Verify a base64 RSA-SHA256 instance signature, accepting both the v2
      # (snake) and legacy v1 (camel) canonical forms (SPEC FS4 accept-both).
      #
      # The v1 form signs no node count, so whoever relayed or replayed a v1
      # record could have written its counts. A record that verifies only
      # under v1 has its four counts cleared in +counts_of+, and both paths
      # then read them from the record's own domain, as for a record without
      # counts ({#fill_missing_instance_counts!}, SPEC FT2).
      #
      # @param attributes [Hash] canonical instance attributes.
      # @param signature [String, nil] base64-encoded signature bytes.
      # @param public_key_pem [String, nil] PEM-encoded RSA public key.
      # @param counts_of [Hash] the attributes whose counts a v1 record
      #   clears: +attributes+, or the record a verified variant of them
      #   stands for.
      # @return [Boolean] true when the signature validates under either form.
      def verify_instance_signature(attributes, signature, public_key_pem, counts_of: attributes)
        version = instance_signature_version(attributes, signature, public_key_pem)
        INSTANCE_COUNT_KEYS.each { |key| counts_of[key] = nil } if version == 1
        !version.nil?
      end

      # The canonical form an instance signature verifies under (SPEC FS4).
      #
      # @param attributes [Hash] canonical instance attributes.
      # @param signature [String, nil] base64-encoded signature bytes.
      # @param public_key_pem [String, nil] PEM-encoded RSA public key.
      # @return [Integer, nil] 2 for the v2 snake_case canonical, 1 when only
      #   the legacy v1 camelCase canonical verifies, nil when neither does.
      def instance_signature_version(attributes, signature, public_key_pem)
        return nil unless signature && public_key_pem

        signature_bytes = Base64.strict_decode64(signature)
        key = OpenSSL::PKey::RSA.new(public_key_pem)
        return 2 if key.verify(OpenSSL::Digest::SHA256.new, signature_bytes, canonical_instance_payload_v2(attributes))
        return 1 if key.verify(OpenSSL::Digest::SHA256.new, signature_bytes, canonical_instance_payload_v1(attributes))

        nil
      rescue ArgumentError, OpenSSL::PKey::PKeyError
        nil
      end
    end
  end
end
