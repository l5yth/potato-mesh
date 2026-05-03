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
      # Process-wide memo for the most recently emitted self-registration
      # decision.  Sinatra spins up a fresh app instance per request so a
      # plain instance variable would not survive across calls; storing the
      # state on the module itself keeps the dedupe stable for the lifetime
      # of the worker process.
      @self_registration_log_state = { mutex: Mutex.new, last: nil }

      # Accessor for the dedupe state used by {#ensure_self_instance_record!}.
      #
      # @return [Hash{Symbol => Object}] mutable state hash holding +:mutex+ and +:last+.
      def self.self_registration_log_state
        @self_registration_log_state
      end

      # Reset the dedupe memo.  Intended for tests; production code never
      # needs to clear the state because each process starts fresh.
      #
      # @return [void]
      def self.reset_self_registration_log_state!
        state = @self_registration_log_state
        state[:mutex].synchronize { state[:last] = nil }
      end

      # Resolve the canonical domain for the running instance.
      #
      # @return [String, nil] sanitized instance domain or nil outside production.
      # @raise [RuntimeError] when the domain cannot be determined in production.
      def self_instance_domain
        sanitized = sanitize_instance_domain(app_constant(:INSTANCE_DOMAIN))
        return sanitized if sanitized

        unless production_environment?
          debug_log(
            "INSTANCE_DOMAIN unavailable; skipping self instance domain",
            context: "federation.instances",
            app_env: string_or_nil(ENV["APP_ENV"]),
            rack_env: string_or_nil(ENV["RACK_ENV"]),
            source: app_constant(:INSTANCE_DOMAIN_SOURCE),
          )
          return nil
        end

        raise "INSTANCE_DOMAIN could not be determined"
      end

      # Determine whether the local instance should persist its own record.
      #
      # @param domain [String, nil] candidate domain for the running instance.
      # @return [Array(Boolean, String, nil)] tuple containing a decision flag and an optional reason.
      def self_instance_registration_decision(domain)
        source = app_constant(:INSTANCE_DOMAIN_SOURCE)
        return [false, "INSTANCE_DOMAIN source is #{source}"] unless source == :environment

        sanitized = sanitize_instance_domain(domain)
        return [false, "INSTANCE_DOMAIN missing or invalid"] unless sanitized

        ip = ip_from_domain(sanitized)
        if ip && restricted_ip_address?(ip)
          return [false, "INSTANCE_DOMAIN resolves to restricted IP"]
        end

        [true, nil]
      end

      # Build the canonical attribute hash describing the local instance.
      #
      # @return [Hash] populated instance attribute hash.
      def self_instance_attributes
        domain = self_instance_domain
        last_update = latest_node_update_timestamp || Time.now.to_i
        cutoff = Time.now.to_i - PotatoMesh::Config.remote_instance_max_node_age
        db = open_database(readonly: true)
        nodes_count = active_node_count_since(cutoff, db: db)
        mc_count = active_node_count_since_for_protocol(cutoff, "meshcore", db: db)
        mt_count = active_node_count_since_for_protocol(cutoff, "meshtastic", db: db)
        {
          id: app_constant(:SELF_INSTANCE_ID),
          domain: domain,
          pubkey: app_constant(:INSTANCE_PUBLIC_KEY_PEM),
          name: sanitized_site_name,
          version: app_constant(:APP_VERSION),
          channel: sanitized_channel,
          frequency: sanitized_frequency,
          latitude: PotatoMesh::Config.map_center_lat,
          longitude: PotatoMesh::Config.map_center_lon,
          last_update_time: last_update,
          is_private: private_mode?,
          contact_link: sanitized_contact_link,
          nodes_count: nodes_count,
          meshcore_nodes_count: mc_count,
          meshtastic_nodes_count: mt_count,
        }
      ensure
        db&.close
      end

      # Sign a canonical instance attribute set with the local private key.
      #
      # @param attributes [Hash] canonical instance attributes.
      # @return [String] base64-encoded RSA-SHA256 signature.
      def sign_instance_attributes(attributes)
        payload = canonical_instance_payload(attributes)
        Base64.strict_encode64(
          app_constant(:INSTANCE_PRIVATE_KEY).sign(OpenSSL::Digest::SHA256.new, payload),
        )
      end

      # Compose the JSON-friendly announcement payload sent to peers.
      #
      # @param attributes [Hash] canonical instance attributes.
      # @param signature [String] base64-encoded signature.
      # @return [Hash] payload with nil entries removed.
      def instance_announcement_payload(attributes, signature)
        payload = {
          "id" => attributes[:id],
          "domain" => attributes[:domain],
          "pubkey" => attributes[:pubkey],
          "name" => attributes[:name],
          "version" => attributes[:version],
          "channel" => attributes[:channel],
          "frequency" => attributes[:frequency],
          "latitude" => attributes[:latitude],
          "longitude" => attributes[:longitude],
          "lastUpdateTime" => attributes[:last_update_time],
          "isPrivate" => attributes[:is_private],
          "contactLink" => attributes[:contact_link],
          "nodesCount" => attributes[:nodes_count],
          "meshcoreNodesCount" => attributes[:meshcore_nodes_count],
          "meshtasticNodesCount" => attributes[:meshtastic_nodes_count],
          "signature" => signature,
        }
        payload.reject { |_, value| value.nil? }
      end

      # Persist the local instance record when registration is allowed.
      #
      # @return [Array(Hash, String)] tuple of (attributes, signature) suitable
      #   for direct reuse by the announcer thread.
      def ensure_self_instance_record!
        attributes = self_instance_attributes
        signature = sign_instance_attributes(attributes)
        db = nil
        allowed, reason = self_instance_registration_decision(attributes[:domain])
        # Decisions are stable per process while INSTANCE_DOMAIN_SOURCE
        # remains the same — without dedupe, the federation banner on every
        # page navigation produced one log line apiece.  Only emit when the
        # tuple changes so operators still see the first decision (and any
        # later flip) without the spam.
        sentinel = [allowed, reason, attributes[:domain]]
        state = PotatoMesh::App::Federation.self_registration_log_state
        should_log = state[:mutex].synchronize do
          changed = state[:last] != sentinel
          state[:last] = sentinel if changed
          changed
        end
        if allowed
          db = open_database
          upsert_instance_record(db, attributes, signature)
          if should_log
            debug_log(
              "Registered self instance record",
              context: "federation.instances",
              domain: attributes[:domain],
              instance_id: attributes[:id],
            )
          end
        elsif should_log
          debug_log(
            "Skipped self instance registration",
            context: "federation.instances",
            domain: attributes[:domain],
            reason: reason,
          )
        end
        [attributes, signature]
      ensure
        db&.close
      end
    end
  end
end
