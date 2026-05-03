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
      # Initialize shared in-memory state used to deduplicate crawl scheduling.
      #
      # @return [void]
      def initialize_federation_crawl_state!
        @federation_crawl_init_mutex ||= Mutex.new
        return if instance_variable_defined?(:@federation_crawl_mutex) && @federation_crawl_mutex

        @federation_crawl_init_mutex.synchronize do
          return if instance_variable_defined?(:@federation_crawl_mutex) && @federation_crawl_mutex

          @federation_crawl_mutex = Mutex.new
          @federation_crawl_in_flight = Set.new
          @federation_crawl_last_completed_at = {}
        end
      end

      # Retrieve the cooldown period used for duplicate crawl suppression.
      #
      # @return [Integer] seconds a domain remains in cooldown after completion.
      def federation_crawl_cooldown_seconds
        PotatoMesh::Config.federation_crawl_cooldown_seconds
      end

      # Mark a domain crawl as claimed if no active or recent crawl exists.
      #
      # @param domain [String] canonical domain name.
      # @return [Symbol] +:claimed+, +:in_flight+, or +:cooldown+.
      def claim_federation_crawl_slot(domain)
        initialize_federation_crawl_state!
        now = Time.now.to_i
        @federation_crawl_mutex.synchronize do
          return :in_flight if @federation_crawl_in_flight.include?(domain)

          last_completed = @federation_crawl_last_completed_at[domain]
          if last_completed && now - last_completed < federation_crawl_cooldown_seconds
            return :cooldown
          end

          @federation_crawl_in_flight << domain
          :claimed
        end
      end

      # Release an in-flight crawl claim and record completion timestamp.
      #
      # @param domain [String] canonical domain name.
      # @param record_completion [Boolean] true to apply cooldown tracking.
      # @return [void]
      def release_federation_crawl_slot(domain, record_completion: true)
        return unless domain

        initialize_federation_crawl_state!
        @federation_crawl_mutex.synchronize do
          @federation_crawl_in_flight.delete(domain)
          @federation_crawl_last_completed_at[domain] = Time.now.to_i if record_completion
        end
      end

      # Clear all in-memory crawl scheduling state.
      #
      # @return [void]
      def clear_federation_crawl_state!
        initialize_federation_crawl_state!
        @federation_crawl_mutex.synchronize do
          @federation_crawl_in_flight.clear
          @federation_crawl_last_completed_at.clear
        end
      end
    end
  end
end
