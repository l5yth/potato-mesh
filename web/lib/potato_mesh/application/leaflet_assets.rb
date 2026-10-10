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

require "uri"

module PotatoMesh
  module App
    # The Leaflet build the layout loads from unpkg.com: the two pinned asset
    # URLs with their Subresource Integrity hashes, and the source the
    # Content-Security-Policy admits for them, derived from those URLs
    # (SPEC HD1). The layout and the policy read the same constants, so a
    # Leaflet upgrade moves both.
    module LeafletAssets
      module_function

      # The Leaflet stylesheet, pinned to one release.
      CSS_URL = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"

      # Subresource Integrity hash of {CSS_URL}.
      CSS_INTEGRITY = "sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY="

      # The Leaflet script, pinned to the same release.
      JS_URL = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"

      # Subresource Integrity hash of {JS_URL}.
      JS_INTEGRITY = "sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo="

      # The CSP source of an asset URL on a package CDN: its origin and its
      # first path segment, the versioned package (+leaflet@1.9.4+), with a
      # trailing slash, so a policy admits that package release and no other
      # package on the host.
      #
      # @param url [String] an absolute URL of the form
      #   +https://host/<package>@<version>/<file path>+.
      # @return [String] the source, e.g. +"https://unpkg.com/leaflet@1.9.4/"+.
      def package_source(url)
        uri = URI.parse(url)
        package = uri.path.split("/").reject(&:empty?).first
        "#{uri.scheme}://#{uri.host}/#{package}/"
      end

      # The CSP sources of the stylesheet and the script, one per package
      # release they come from.
      #
      # @return [Array<String>] the distinct {package_source} values.
      def sources
        [CSS_URL, JS_URL].map { |url| package_source(url) }.uniq
      end
    end
  end
end
