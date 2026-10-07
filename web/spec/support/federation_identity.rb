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
require "json"
require "openssl"

# Signed federation identity documents that specs serve in place of a peer's
# own +/.well-known/potato-mesh+ (+federation_relayed_records_spec.rb+,
# +app_spec.rb+), and signed instance announcements
# (+field_limits_spec.rb+).
module FederationIdentitySupport
  # Build a signed v2 well-known document in which +domain+ names +key+,
  # shaped like the one +build_well_known_document+ serves.
  #
  # @param key [OpenSSL::PKey::RSA] the key the document names and signs with.
  # @param domain [String] the domain the document describes.
  # @param name [String] site name the document carries.
  # @param pem [String] the public key PEM the document names.
  # @return [Hash] the decoded well-known document.
  def self.well_known_document(key, domain, name: "Remote Mesh", pem: key.public_key.to_pem)
    fields = {
      "public_key" => pem,
      "name" => name,
      "version" => "v0.8.0",
      "domain" => domain,
      "last_update" => Time.now.to_i,
    }
    signed = PotatoMesh::Application.canonical_signed_payload(fields)
    fields.merge(
      "signature_version" => PotatoMesh::Config.federation_signature_version,
      "signature" => Base64.strict_encode64(key.sign(OpenSSL::Digest::SHA256.new, signed)),
      "signature_algorithm" => PotatoMesh::Config.instance_signature_algorithm,
      "signed_payload" => Base64.strict_encode64(signed),
    )
  end

  # An instance announcement of +attributes+, signed with +key+ over the v2
  # instance canonical and decoded from its wire form, as +POST
  # /api/instances+ receives it and a peer's +/api/instances+ lists it.
  #
  # @param key [OpenSSL::PKey::RSA] the instance key.
  # @param attributes [Hash] instance attributes, keyed by symbol.
  # @return [Hash] the decoded announcement.
  def self.signed_announcement(key, attributes)
    canonical = PotatoMesh::Application.canonical_instance_payload(attributes)
    signature = Base64.strict_encode64(key.sign(OpenSSL::Digest::SHA256.new, canonical))
    payload = PotatoMesh::Application.instance_announcement_payload(attributes, signature)
    JSON.parse(JSON.generate(payload))
  end
end
