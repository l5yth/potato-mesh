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
      # Matches a Markdown-style +[label](url)+ link in announcement copy
      # (SPEC SH4). The label is any text up to the first +]+; the target must
      # be an absolute http:// or https:// URL and ends at the first
      # whitespace, +)+ or HTML-significant < character. A link to any other
      # scheme, such as +javascript:+, does not match and stays text. The +i+
      # flag makes the scheme match case-insensitive.
      ANNOUNCEMENT_LINK_PATTERN = %r{\[([^\]]+)\]\((https?://[^\s)<]+)\)}i.freeze

      # Matches a bare http:// or https:// URL in announcement copy. The word
      # boundary (\b) skips a scheme that starts mid-word, the match ends at
      # the first whitespace or HTML-significant < character, and the +i+ flag
      # makes the scheme match case-insensitive. Trailing +.+ and +)+ are
      # trimmed afterwards ({ANNOUNCEMENT_URL_TRAILER}), so a sentence's period
      # or a closing parenthesis stays outside the link href.
      ANNOUNCEMENT_URL_PATTERN = %r{\bhttps?://[^\s<]+}i.freeze

      # Trailing characters a bare URL returns to the surrounding text.
      ANNOUNCEMENT_URL_TRAILER = /[.)]+\z/.freeze

      # One link in announcement copy. The alternation tries the +[label](url)+
      # form first at each position, so its target is never linked twice.
      ANNOUNCEMENT_TOKEN_PATTERN = Regexp.union(ANNOUNCEMENT_LINK_PATTERN, ANNOUNCEMENT_URL_PATTERN).freeze

      # Render the announcement copy with safe outbound links.
      #
      # A +[label](url)+ link renders its label, and a bare URL renders itself
      # without trailing +.+ or +)+. Both open in a new tab with
      # +rel="noopener noreferrer"+; the text between them, every label and
      # every URL are HTML-escaped.
      #
      # @return [String, nil] escaped HTML snippet or nil when unset.
      def announcement_html
        announcement = sanitized_announcement
        return nil unless announcement

        fragments = []
        last_index = 0

        announcement.to_enum(:scan, ANNOUNCEMENT_TOKEN_PATTERN).each do
          match = Regexp.last_match
          start_index = match.begin(0)

          if match[2]
            label = match[1]
            url = match[2]
            end_index = match.end(0)
          else
            # The trimmed characters start the next text fragment.
            url = match[0].sub(ANNOUNCEMENT_URL_TRAILER, "")
            label = url
            end_index = start_index + url.length
          end

          if start_index > last_index
            fragments << Rack::Utils.escape_html(announcement[last_index...start_index])
          end

          fragments << %(<a href="#{Rack::Utils.escape_html(url)}" target="_blank" rel="noopener noreferrer">#{Rack::Utils.escape_html(label)}</a>)
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

      # Retrieve the configured MeshCore preset for the join strip.
      #
      # @return [String, nil] sanitised MeshCore preset or nil when unset (SPEC UX12).
      def sanitized_meshcore_preset
        PotatoMesh::Sanitizer.sanitized_meshcore_preset
      end

      # Retrieve the configured MeshCore frequency for the join strip.
      #
      # @return [String, nil] sanitised MeshCore frequency or nil when unset (SPEC UX12).
      def sanitized_meshcore_freq
        PotatoMesh::Sanitizer.sanitized_meshcore_freq
      end

      # Retrieve the configured Reticulum preset for the join strip.
      #
      # @return [String, nil] sanitised Reticulum preset or nil when unset (SPEC UX12).
      def sanitized_reticulum_preset
        PotatoMesh::Sanitizer.sanitized_reticulum_preset
      end

      # Retrieve the configured Reticulum frequency for the join strip.
      #
      # @return [String, nil] sanitised Reticulum frequency or nil when unset (SPEC UX12).
      def sanitized_reticulum_freq
        PotatoMesh::Sanitizer.sanitized_reticulum_freq
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
