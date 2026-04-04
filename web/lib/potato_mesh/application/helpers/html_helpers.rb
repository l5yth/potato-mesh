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
    module Helpers
      # Matches any http:// or https:// URL in announcement copy.  The pattern
      # uses a word boundary (\b) to avoid matching URLs that appear mid-word,
      # captures everything up to the first whitespace or HTML-significant <
      # character so that adjacent punctuation does not get swallowed into the
      # link href, and the +i+ flag makes the scheme match case-insensitive.
      ANNOUNCEMENT_URL_PATTERN = %r{\bhttps?://[^\s<]+}i.freeze

      # Render the announcement copy with safe outbound links.
      #
      # @return [String, nil] escaped HTML snippet or nil when unset.
      def announcement_html
        announcement = sanitized_announcement
        return nil unless announcement

        fragments = []
        last_index = 0

        announcement.to_enum(:scan, ANNOUNCEMENT_URL_PATTERN).each do
          match = Regexp.last_match
          next unless match

          start_index = match.begin(0)
          end_index = match.end(0)

          if start_index > last_index
            fragments << Rack::Utils.escape_html(announcement[last_index...start_index])
          end

          url = match[0]
          escaped_url = Rack::Utils.escape_html(url)
          fragments << %(<a href="#{escaped_url}" target="_blank" rel="noopener noreferrer">#{escaped_url}</a>)
          last_index = end_index
        end

        if last_index < announcement.length
          fragments << Rack::Utils.escape_html(announcement[last_index..])
        end

        fragments.join
      end

      # Present a version string with a leading ``v`` when missing to keep
      # UI labels consistent across tagged and fallback builds.
      #
      # @param version [String, nil] raw application version string.
      # @return [String, nil] version string prefixed with ``v`` when needed.
      def display_version(version)
        return nil if version.nil? || version.to_s.strip.empty?

        text = version.to_s.strip
        text.start_with?("v") ? text : "v#{text}"
      end

      # Proxy for {PotatoMesh::Sanitizer.string_or_nil}.
      #
      # @param value [Object] value to sanitise.
      # @return [String, nil] cleaned string or nil.
      def string_or_nil(value)
        PotatoMesh::Sanitizer.string_or_nil(value)
      end

      # Proxy for {PotatoMesh::Sanitizer.sanitize_instance_domain}.
      #
      # @param value [Object] candidate domain string.
      # @param downcase [Boolean] whether to force lowercase normalisation.
      # @return [String, nil] canonical domain or nil.
      def sanitize_instance_domain(value, downcase: true)
        PotatoMesh::Sanitizer.sanitize_instance_domain(value, downcase: downcase)
      end

      # Proxy for {PotatoMesh::Sanitizer.instance_domain_host}.
      #
      # @param domain [String] domain literal.
      # @return [String, nil] host portion of the domain.
      def instance_domain_host(domain)
        PotatoMesh::Sanitizer.instance_domain_host(domain)
      end

      # Proxy for {PotatoMesh::Sanitizer.ip_from_domain}.
      #
      # @param domain [String] domain literal.
      # @return [IPAddr, nil] parsed address object.
      def ip_from_domain(domain)
        PotatoMesh::Sanitizer.ip_from_domain(domain)
      end

      # Proxy for {PotatoMesh::Sanitizer.sanitized_string}.
      #
      # @param value [Object] arbitrary input.
      # @return [String] trimmed string representation.
      def sanitized_string(value)
        PotatoMesh::Sanitizer.sanitized_string(value)
      end

      # Retrieve the site name presented to users.
      #
      # @return [String] sanitised site label.
      def sanitized_site_name
        PotatoMesh::Sanitizer.sanitized_site_name
      end

      # Retrieve the configured announcement banner copy.
      #
      # @return [String, nil] sanitised announcement or nil when unset.
      def sanitized_announcement
        PotatoMesh::Sanitizer.sanitized_announcement
      end

      # Retrieve the configured channel.
      #
      # @return [String] sanitised channel identifier.
      def sanitized_channel
        PotatoMesh::Sanitizer.sanitized_channel
      end

      # Retrieve the configured frequency descriptor.
      #
      # @return [String] sanitised frequency text.
      def sanitized_frequency
        PotatoMesh::Sanitizer.sanitized_frequency
      end

      # Retrieve the configured contact link or nil when unset.
      #
      # @return [String, nil] contact link identifier.
      def sanitized_contact_link
        PotatoMesh::Sanitizer.sanitized_contact_link
      end

      # Retrieve the hyperlink derived from the configured contact link.
      #
      # @return [String, nil] hyperlink pointing to the community chat.
      def sanitized_contact_link_url
        PotatoMesh::Sanitizer.sanitized_contact_link_url
      end

      # Retrieve the configured maximum node distance in kilometres.
      #
      # @return [Numeric, nil] maximum distance or nil if disabled.
      def sanitized_max_distance_km
        PotatoMesh::Sanitizer.sanitized_max_distance_km
      end
    end
  end
end
