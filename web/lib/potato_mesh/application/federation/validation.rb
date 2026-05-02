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
      # Validate a remote +/.well-known+ document, including signature checks
      # against the supplied public key.
      #
      # @param document [Hash] decoded well-known document.
      # @param domain [String] expected sanitized domain.
      # @param pubkey [String] expected canonical PEM public key.
      # @return [Array(Boolean, String, nil)] tuple containing the validation
      #   result and an optional human-readable failure reason.
      def validate_well_known_document(document, domain, pubkey)
        unless document.is_a?(Hash)
          return [false, "document is not an object"]
        end

        remote_pubkey = sanitize_public_key_pem(document["publicKey"])
        return [false, "public key missing"] unless remote_pubkey
        return [false, "public key mismatch"] unless remote_pubkey == pubkey

        remote_domain = string_or_nil(document["domain"])
        return [false, "domain missing"] unless remote_domain
        return [false, "domain mismatch"] unless remote_domain.casecmp?(domain)

        algorithm = string_or_nil(document["signatureAlgorithm"])
        unless algorithm&.casecmp?(PotatoMesh::Config.instance_signature_algorithm)
          return [false, "unsupported signature algorithm"]
        end

        signed_payload_b64 = string_or_nil(document["signedPayload"])
        signature_b64 = string_or_nil(document["signature"])
        return [false, "missing signed payload"] unless signed_payload_b64
        return [false, "missing signature"] unless signature_b64

        signed_payload = Base64.strict_decode64(signed_payload_b64)
        signature = Base64.strict_decode64(signature_b64)
        key = OpenSSL::PKey::RSA.new(remote_pubkey)
        unless key.verify(OpenSSL::Digest::SHA256.new, signature, signed_payload)
          return [false, "invalid well-known signature"]
        end

        payload = JSON.parse(signed_payload)
        unless payload.is_a?(Hash)
          return [false, "signed payload is not an object"]
        end

        payload_domain = string_or_nil(payload["domain"])
        payload_pubkey = sanitize_public_key_pem(payload["publicKey"])
        return [false, "signed payload domain mismatch"] unless payload_domain&.casecmp?(domain)
        return [false, "signed payload public key mismatch"] unless payload_pubkey == pubkey

        [true, nil]
      rescue ArgumentError, OpenSSL::PKey::PKeyError => e
        [false, e.message]
      rescue JSON::ParserError => e
        [false, "signed payload JSON error: #{e.message}"]
      end

      # Confirm a remote +/api/nodes+ payload contains a sufficient set of
      # recently active nodes.
      #
      # @param nodes [Object] decoded array of remote node entries.
      # @return [Array(Boolean, String, nil)] tuple of (is_fresh, optional reason).
      def validate_remote_nodes(nodes)
        unless nodes.is_a?(Array)
          return [false, "node response is not an array"]
        end

        if nodes.length < PotatoMesh::Config.remote_instance_min_node_count
          return [false, "insufficient nodes"]
        end

        latest = nodes.filter_map do |node|
          next unless node.is_a?(Hash)

          last_heard_values = []
          last_heard_values << coerce_integer(node["last_heard"])
          last_heard_values << coerce_integer(node["lastHeard"])
          last_heard_values.compact.max
        end.compact.max

        return [false, "missing last_heard data"] unless latest

        cutoff = Time.now.to_i - PotatoMesh::Config.remote_instance_max_node_age
        return [false, "node data is stale"] if latest < cutoff

        [true, nil]
      end
    end
  end
end
