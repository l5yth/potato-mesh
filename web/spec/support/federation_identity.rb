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

# Signed federation identity documents that specs serve in place of a peer's
# own +/.well-known/potato-mesh+ (+federation_relayed_records_spec.rb+,
# +app_spec.rb+).
module FederationIdentitySupport
  # Build a signed v2 well-known document in which +domain+ names +key+,
  # shaped like the one +build_well_known_document+ serves.
  #
  # @param key [OpenSSL::PKey::RSA] the key the document names and signs with.
  # @param domain [String] the domain the document describes.
  # @param name [String] site name the document carries.
  # @return [Hash] the decoded well-known document.
  def self.well_known_document(key, domain, name: "Remote Mesh")
    fields = {
      "public_key" => key.public_key.to_pem,
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
end
