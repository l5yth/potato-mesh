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
      # Process-wide count of the +POST /api/instances+ verifications in
      # flight. Sinatra serves each request on a fresh instance, so the count
      # lives on the module, like the peer store.
      @registration_slots = { mutex: Mutex.new, in_flight: 0 }

      # @return [Hash{Symbol => Object}] +:mutex+ and the +:in_flight+ count.
      def self.registration_slots
        @registration_slots
      end

      # Take one of the {PotatoMesh::Config.federation_max_registrations_in_flight}
      # verification slots (SPEC FL7).
      #
      # @return [Boolean] true when a slot was free and is now held; the
      #   caller must then release it.
      def claim_federation_registration_slot
        slots = PotatoMesh::App::Federation.registration_slots
        slots[:mutex].synchronize do
          return false if slots[:in_flight] >= PotatoMesh::Config.federation_max_registrations_in_flight

          slots[:in_flight] += 1
          true
        end
      end

      # Give back a slot taken with {#claim_federation_registration_slot}.
      #
      # @return [void]
      def release_federation_registration_slot
        slots = PotatoMesh::App::Federation.registration_slots
        slots[:mutex].synchronize { slots[:in_flight] = [slots[:in_flight] - 1, 0].max }
      end

      # Forget every slot held.
      #
      # @return [void]
      def reset_federation_registration_slots!
        slots = PotatoMesh::App::Federation.registration_slots
        slots[:mutex].synchronize { slots[:in_flight] = 0 }
      end

      # Answer a registration whose host is inside its fetch cooldown or
      # backoff from what the fetch that started the cooldown learned of the
      # domain, without a new fetch (SPEC FL7). Request context only; always
      # halts.
      #
      # An announcement under a key other than the stored one is judged
      # against the kept well-known document, or refused on the kept fetch
      # failure; an announcement under the stored key needs no document, as
      # in the crawl (SPEC FS8). Either is then judged on the kept node-list
      # result. Whatever cannot be checked is deferred with 503: no document
      # kept for a new key, or no node list kept, which is also the case once
      # the cooldown ended while the host still backs off. A copy that passes
      # is stored, newest copy winning, and answered 201.
      #
      # @param db [SQLite3::Database] open database handle.
      # @param attributes [Hash] the verified announcement's attributes.
      # @param signature [String] its signature.
      # @param same_key [Boolean] whether the stored row holds the same key.
      # @param wait [Numeric] seconds left of the host's cooldown or backoff.
      # @return [void]
      def answer_instance_registration_from_cooldown!(db, attributes, signature, same_key:, wait:)
        domain = attributes[:domain]
        host = federation_peer_host(domain)
        cooldown = PotatoMesh::Config.federation_peer_fetch_cooldown_seconds
        known = federation_peer_backoff.knowledge(host, federation_domain_key(domain), cooldown: cooldown) || {}
        # Once the cooldown ended only the backoff holds the host.
        reason = federation_peer_backoff.cooldown_seconds(host, cooldown: cooldown).positive? ? "peer fetch cooldown" : "peer backoff"
        unless same_key
          defer_instance_registration!(domain, wait, reason) unless known[:well_known]
          check = verify_well_known_identity(domain, attributes[:pubkey], cached: known[:well_known])
          reject_instance_registration_unless_vouched!(domain, check, cached: true)
        end
        defer_instance_registration!(domain, wait, reason) unless known[:acceptance]
        reject_instance_registration_unless_accepted!(domain, known[:acceptance], cached: true)
        register_verified_instance!(db, attributes, signature)
      end

      # Halt a registration with 400 unless its well-known check vouched for
      # it, logging the rejection as the route always has. Request context
      # only.
      #
      # @param domain [String] announced domain.
      # @param check [Array(Boolean, Symbol, String)] the result of
      #   {#verify_well_known_identity}.
      # @param cached [Boolean] whether the check judged a kept document.
      # @return [void]
      def reject_instance_registration_unless_vouched!(domain, check, cached: false)
        valid, failure, detail = check
        return if valid

        kept = cached ? { cached: true } : {}
        if failure == :fetch_failed
          warn_log(
            "Instance registration rejected",
            context: "ingest.register",
            domain: domain,
            reason: "failed to fetch well-known document",
            details: detail,
            **kept,
          )
          halt 400, { error: "failed to verify well-known document" }.to_json
        end

        warn_log("Instance registration rejected", context: "ingest.register", domain: domain, reason: detail, **kept)
        halt 400, { error: detail }.to_json
      end

      # Judge an announcing peer on its one node list (SPEC FL2) and keep the
      # result for the cooldown the fetch belongs to (SPEC FL7).
      #
      # @param domain [String] announced domain.
      # @return [Hash] see {#remote_instance_acceptance}.
      def judge_registering_instance(domain)
        nodes, metadata = fetch_instance_json(domain, remote_instance_acceptance_path)
        remote_instance_acceptance(nodes, metadata).tap do |acceptance|
          federation_peer_backoff.record_acceptance(federation_peer_host(domain), federation_domain_key(domain), acceptance)
        end
      end

      # Halt a registration with 400 when its node list refused the peer,
      # logging the rejection as the route always has. Request context only.
      #
      # @param domain [String] announced domain.
      # @param acceptance [Hash] see {#remote_instance_acceptance}.
      # @param cached [Boolean] whether the result was kept from an earlier
      #   fetch.
      # @return [void]
      def reject_instance_registration_unless_accepted!(domain, acceptance, cached: false)
        return if acceptance[:accepted]

        extra = acceptance.key?(:details) ? { details: acceptance[:details] } : {}
        extra[:cached] = true if cached
        warn_log(
          "Instance registration rejected",
          context: "ingest.register",
          domain: domain,
          reason: acceptance[:reason],
          **extra,
        )
        halt 400, { error: acceptance[:error] }.to_json
      end

      # Store a verified announcement and answer 201, unless the row stored
      # under its key meanwhile holds a +last_update+ at least as new: the
      # newest copy wins (SPEC FL1, FL7). Request context only; always halts.
      #
      # @param db [SQLite3::Database] open database handle.
      # @param attributes [Hash] the verified announcement's attributes.
      # @param signature [String] its signature.
      # @return [void]
      def register_verified_instance!(db, attributes, signature)
        stored = !instance_copy_outdated?(stored_instance_copy(db, attributes), attributes)
        if stored
          upsert_instance_record(db, attributes, signature)
          # Drop the cached /api/instances payload so the new peer becomes
          # visible on the next dashboard refresh instead of after the TTL
          # naturally expires.
          PotatoMesh::App::ApiCache.invalidate_prefix("api:instances:")
        end
        info_log(
          "Registered remote instance",
          context: "ingest.register",
          domain: attributes[:domain],
          instance_id: attributes[:id],
          stored: stored,
        )
        halt 201, { status: "registered" }.to_json
      end

      # End a registration this instance will not verify now with 503 and a
      # +Retry-After+ header (SPEC FL7). Request context only.
      #
      # @param domain [String] announced domain.
      # @param seconds [Numeric] seconds the announcer should wait.
      # @param reason [String] error the response carries.
      # @return [void] never returns; halts the request.
      def defer_instance_registration!(domain, seconds, reason)
        retry_after = [seconds.to_f.ceil, 1].max
        warn_log(
          "Instance registration deferred",
          context: "ingest.register",
          domain: domain,
          reason: reason,
          retry_after: retry_after,
        )
        headers "Retry-After" => retry_after.to_s
        halt 503, { error: reason }.to_json
      end
    end
  end
end
