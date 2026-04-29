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

require_relative "config"
require_relative "sanitizer"

module PotatoMesh
  # Helper functions used to generate SEO metadata and formatted values.
  module Meta
    module_function

    # Format a distance in kilometres without trailing decimal precision when unnecessary.
    #
    # @param distance [Numeric] distance in kilometres.
    # @return [String] formatted kilometre value.
    def formatted_distance_km(distance)
      format("%.1f", distance).sub(/\.0\z/, "")
    end

    # Construct the meta description string displayed to search engines and social previews.
    #
    # @param private_mode [Boolean] whether private mode is enabled.
    # @return [String] generated description text.
    def description(private_mode:)
      site = Sanitizer.sanitized_site_name
      channel = Sanitizer.sanitized_channel
      frequency = Sanitizer.sanitized_frequency
      contact = Sanitizer.sanitized_contact_link

      summary = "Live Meshtastic mesh map for #{site}"
      if channel.empty? && frequency.empty?
        summary += "."
      elsif channel.empty?
        summary += " tuned to #{frequency}."
      elsif frequency.empty?
        summary += " on #{channel}."
      else
        summary += " on #{channel} (#{frequency})."
      end

      activity_sentence = if private_mode
          "Track nodes and coverage in real time."
        else
          "Track nodes, messages, and coverage in real time."
        end

      sentences = [summary, activity_sentence]
      if (distance = Sanitizer.sanitized_max_distance_km)
        sentences << "Shows nodes within roughly #{formatted_distance_km(distance)} km of the map center."
      end
      sentences << "Join the community in #{contact} via chat." if contact

      sentences.join(" ")
    end

    # Return the human-readable label associated with a logical view name.
    #
    # The label appears as the first segment of {.view_title} (e.g. the
    # +"Map"+ portion of +"Map · PotatoMesh"+) and is omitted for views that
    # should reuse the bare site name (such as the dashboard or detail pages
    # whose title is built from per-record data).
    #
    # @param view [Symbol, String, nil] logical view identifier.
    # @return [String, nil] navigation label or +nil+ when no label applies.
    def view_label(view)
      return nil if view.nil?

      symbol = view.respond_to?(:to_sym) ? view.to_sym : view
      {
        map: "Map",
        chat: "Chat",
        charts: "Charts",
        nodes: "Nodes",
        federation: "Federation",
      }[symbol]
    end

    # Compose the per-view document title using the +"Label · Site"+ pattern.
    #
    # @param view [Symbol, String, nil] logical view identifier.
    # @param site [String] sanitized site name suffix.
    # @return [String, nil] composed title or +nil+ when no view-specific
    #   label exists for the supplied identifier.
    def view_title(view, site)
      label = view_label(view)
      return nil unless label
      return label if site.nil? || site.empty?

      "#{label} · #{site}"
    end

    # Build the per-view description string used for the +<meta name="description">+
    # and Open Graph descriptions.
    #
    # @param view [Symbol, String, nil] logical view identifier.
    # @param private_mode [Boolean] whether private mode is enabled. Drives
    #   suppression of chat-specific copy and other federation-aware text.
    # @return [String, nil] description text or +nil+ when the view should
    #   inherit the global description.
    def view_description(view, private_mode:)
      return nil if view.nil?

      symbol = view.respond_to?(:to_sym) ? view.to_sym : view
      site = Sanitizer.sanitized_site_name
      channel = Sanitizer.sanitized_channel
      frequency = Sanitizer.sanitized_frequency

      case symbol
      when :map
        map_view_description(site, channel, frequency)
      when :chat
        chat_view_description(site, channel, private_mode: private_mode)
      when :charts
        "Network activity charts for #{site}: nodes online, traffic, and signal quality."
      when :nodes
        "All Meshtastic and MeshCore nodes seen on #{site}, with last-heard time and metadata."
      when :federation
        "Federated PotatoMesh instances sharing node and message data with #{site}."
      end
    end

    # Compose the description sentence used by the +/map+ view.
    #
    # @param site [String] sanitized site name.
    # @param channel [String] sanitized channel label.
    # @param frequency [String] sanitized frequency identifier.
    # @return [String] descriptive sentence with the available channel and
    #   frequency suffixes.
    def map_view_description(site, channel, frequency)
      lead = "Live coverage map of #{site}"
      lead += if !channel.empty? && !frequency.empty?
          " on #{channel} (#{frequency})"
        elsif !channel.empty?
          " on #{channel}"
        elsif !frequency.empty?
          " tuned to #{frequency}"
        else
          ""
        end
      "#{lead} — see node positions in real time."
    end

    # Compose the description sentence used by the +/chat+ view.
    #
    # @param site [String] sanitized site name.
    # @param channel [String] sanitized channel label.
    # @param private_mode [Boolean] whether the instance is running in
    #   private mode; chat is hidden for private deployments.
    # @return [String, nil] description copy or +nil+ when chat is disabled.
    def chat_view_description(site, channel, private_mode:)
      return nil if private_mode

      if channel.empty?
        "Recent mesh chat traffic on #{site}."
      else
        "Recent mesh chat traffic on #{channel} for #{site}."
      end
    end

    # Build a hash of meta configuration values used by templating layers.
    #
    # @param private_mode [Boolean] whether private mode is enabled.
    # @param view [Symbol, String, nil] logical view identifier used to derive
    #   per-page title and description copy. When +nil+, the dashboard
    #   defaults are returned.
    # @param overrides [Hash, nil] explicit values that take precedence over
    #   both view-specific and global defaults. Recognised keys: +:title+,
    #   +:description+, +:image+, +:noindex+.
    # @return [Hash] structured metadata for templates.
    def configuration(private_mode:, view: nil, overrides: nil)
      site = Sanitizer.sanitized_site_name
      base_description = description(private_mode: private_mode)
      override_hash = overrides.is_a?(Hash) ? overrides : {}

      override_title = string_or_nil(override_hash[:title])
      override_description = string_or_nil(override_hash[:description])
      override_image = string_or_nil(override_hash[:image])
      override_noindex = override_hash[:noindex] == true

      resolved_title = override_title || view_title(view, site) || site
      resolved_description = override_description ||
                             view_description(view, private_mode: private_mode) ||
                             base_description

      {
        title: resolved_title,
        name: site,
        description: resolved_description,
        image: override_image,
        noindex: override_noindex,
      }.freeze
    end

    # Coerce arbitrary input into a trimmed non-empty string or +nil+.
    #
    # @param value [Object, nil] candidate value.
    # @return [String, nil] non-empty string or +nil+ when the input is
    #   blank, missing, or coerces to an empty value.
    def string_or_nil(value)
      return nil if value.nil?

      str = value.is_a?(String) ? value : value.to_s
      trimmed = str.strip
      trimmed.empty? ? nil : trimmed
    end
  end
end
