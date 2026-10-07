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

require "set"

module PotatoMesh
  module App
    module Federation
      # The state of one federation crawl, passed through its recursion in
      # place of the earlier +visited+ Set (SPEC FL1, FL6).
      #
      # It holds the crawl's limits, a domain budget, a request budget and a
      # deadline, and what the crawl learned on the way: the hosts it claimed
      # in the process-wide peer fetch cooldown, the hosts whose instance list
      # it walked, the outcome of each host's visit, the well-known document
      # of each domain it fetched (failures included), the port variant of
      # each host whose well-known it fetched, and the domains and requests it
      # spent. One crawl runs on one thread, so the object is not
      # synchronized.
      class CrawlState
        # @return [String, nil] this instance's own domain key, a default port
        #   dropped, which the crawl never fetches.
        attr_reader :own_domain

        # @return [Set<String>] hosts whose +/api/instances+ list was walked.
        attr_reader :walked

        # @return [Set<String>] domains the crawl sent a request to.
        attr_reader :fetched_domains

        # @return [Integer] requests the crawl sent.
        attr_reader :requests

        # @return [String, nil] why the crawl stopped early, nil while it may
        #   go on.
        attr_reader :stop_reason

        # @param own_domain [String, nil] domain key of this instance.
        # @param max_domains [Integer] most domains the crawl may fetch.
        # @param max_requests [Integer] most requests the crawl may send.
        # @param deadline_seconds [Numeric] seconds the crawl may run.
        # @param clock [#call] monotonic clock in seconds.
        def initialize(own_domain:, max_domains:, max_requests:, deadline_seconds:,
                       clock: -> { Process.clock_gettime(Process::CLOCK_MONOTONIC) })
          @own_domain = own_domain
          @max_domains = max_domains
          @max_requests = max_requests
          @clock = clock
          @deadline = clock.call + deadline_seconds
          @walked = Set.new
          @claimed = Set.new
          @visits = {}
          @well_known = {}
          @port_variants = {}
          @fetched_domains = Set.new
          @requests = 0
          @stop_reason = nil
        end

        # Whether the crawl must stop: a budget was spent or its deadline
        # passed.
        #
        # @return [Boolean] true once the crawl has to stop.
        def stopped?
          @stop_reason ||= "deadline passed" if @clock.call >= @deadline
          !@stop_reason.nil?
        end

        # Whether +domain+ is this instance's own.
        #
        # @param domain [String, nil] domain key, a default port dropped.
        # @return [Boolean] true for the own domain.
        def own_domain?(domain)
          !@own_domain.nil? && domain == @own_domain
        end

        # Whether one more request to +domain+ fits the crawl's limits; stops
        # the crawl when one is spent.
        #
        # @param domain [String] sanitized domain the request goes to.
        # @return [Boolean] true when the request may be sent.
        def request_allowed?(domain)
          return false if stopped?

          if @requests >= @max_requests
            @stop_reason = "request budget spent"
          elsif !@fetched_domains.include?(domain) && @fetched_domains.size >= @max_domains
            @stop_reason = "domain limit reached"
          end
          @stop_reason.nil?
        end

        # Count one request to +domain+.
        #
        # @param domain [String] sanitized domain the request goes to.
        # @return [void]
        def spend_request(domain)
          @requests += 1
          @fetched_domains << domain
        end

        # @param host [String] peer host.
        # @return [Boolean] true when this crawl holds the host's cooldown.
        def claimed?(host)
          @claimed.include?(host)
        end

        # Record that this crawl holds +host+'s cooldown.
        #
        # @param host [String] peer host.
        # @return [void]
        def claim(host)
          @claimed << host
        end

        # @param host [String] peer host.
        # @return [Boolean] true when the host's instance list was walked.
        def walked?(host)
          @walked.include?(host)
        end

        # Record that +host+'s instance list is walked.
        #
        # @param host [String] peer host.
        # @return [void]
        def walk(host)
          @walked << host
        end

        # The visit of +host+, if the crawl made one.
        #
        # @param host [String] peer host.
        # @return [Hash, nil] +:domain+ and +:accepted+, plus memoized count
        #   fallbacks.
        def visit(host)
          @visits[host]
        end

        # Record the visit of +host+.
        #
        # @param host [String] peer host.
        # @param visit [Hash] +:domain+ visited and whether it was +:accepted+.
        # @return [Hash] +visit+.
        def record_visit(host, visit)
          @visits[host] = visit
        end

        # The well-known fetch result of +domain+, fetched by the block once
        # per crawl, a failure included (SPEC FL1).
        #
        # @param domain [String] domain key, a default port dropped.
        # @yieldreturn [Array(Object, Object)] the fetch result.
        # @return [Array(Object, Object)] the memoized fetch result.
        def well_known(domain)
          return @well_known[domain] if @well_known.key?(domain)

          @well_known[domain] = yield
        end

        # Whether the port variant +domain+ of +host+ may fetch its well-known
        # in this crawl: all port variants of a host share one fetch, beside
        # the bare domain's own (SPEC FL1). The first variant to ask takes it.
        #
        # @param host [String, nil] peer host.
        # @param domain [String] domain key of the port variant.
        # @return [Boolean] true for the variant that holds the host's fetch.
        def port_variant_fetch?(host, domain)
          (@port_variants[host] ||= domain) == domain
        end
      end

      # Clear the process-wide federation peer state: the fetch cooldown, the
      # backoff and the revalidation store of every peer host, and the
      # registration verifications counted in flight.
      #
      # @return [void]
      def clear_federation_crawl_state!
        federation_peer_backoff.reset!
        reset_federation_registration_slots!
      end
    end
  end
end
