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
      # Process-wide, the announce targets the last announcement cycle
      # skipped because the worker queue was full; the next cycle offers
      # them first (SPEC FB5). Sinatra serves each request on a fresh
      # instance, so the list lives on the module, like the peer store.
      @announce_backlog = { mutex: Mutex.new, domains: [] }

      # @return [Hash{Symbol => Object}] +:mutex+ and the +:domains+ skipped.
      def self.announce_backlog
        @announce_backlog
      end

      # Order this cycle's targets with the ones the last cycle's full queue
      # skipped first, in the order they were skipped, and the others after
      # them in their own order (SPEC FB5).
      #
      # @param domains [Array<String>] this cycle's targets.
      # @return [Array<String>] the same targets, reordered.
      def order_by_announce_backlog(domains)
        state = PotatoMesh::App::Federation.announce_backlog
        waiting = state[:mutex].synchronize { state[:domains].dup }
        first = waiting & domains
        first + (domains - first)
      end

      # Keep the targets this cycle's full queue skipped for the next cycle.
      #
      # @param domains [Array<String>] the skipped targets.
      # @return [void]
      def remember_announce_backlog(domains)
        state = PotatoMesh::App::Federation.announce_backlog
        state[:mutex].synchronize { state[:domains] = domains.dup }
      end

      # Forget the targets kept for the next cycle.
      #
      # @return [void]
      def reset_announce_backlog!
        remember_announce_backlog([])
      end

      # Feed one announcement's outcome to the peer backoff, as a fetch's
      # outcome is (SPEC FB5, FL4): no answer on any candidate, or a +429+
      # or a +503+, honouring its +Retry-After+, backs the host off; any
      # other answer clears it. An announcement cut short by shutdown counts
      # neither way.
      #
      # @param domain [String] the target domain.
      # @param answer [Net::HTTPResponse, nil] the last answer the target
      #   gave, nil when none came.
      # @return [void]
      def record_announce_outcome(domain, answer)
        return if federation_shutdown_requested?

        host = federation_peer_host(domain)
        backoff = federation_peer_backoff
        if answer.nil?
          backoff.record_failure(host)
        elsif [429, 503].include?(answer.code.to_i)
          backoff.record_failure(host, retry_after: federation_retry_after_seconds(answer["Retry-After"]))
        else
          backoff.record_success(host)
        end
      end
    end
  end
end
