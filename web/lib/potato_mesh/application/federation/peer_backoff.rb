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

require "json"
require "time"
require "uri"

module PotatoMesh
  module App
    module Federation
      # Bounded, process-wide memory of the federation fetches this instance
      # made, per +host+ key (SPEC FL3, FL4, PV1).
      #
      # A key is a peer endpoint, +federation_backoff_key+: the bare host for
      # its default port, one key for all its port variants. Per key it keeps
      # when a crawl or a registration last claimed a fetch (the peer fetch
      # cooldown), until when requests to it back off after a 429 or 503 with
      # +Retry-After+ or after consecutive failures, and what the fetches under
      # the current claim learned of each domain, its well-known document (or
      # the fetch failure) and its node-list acceptance, until the cooldown
      # ends, so a registration inside it is answered from them (SPEC FL7). The
      # revalidation store keeps, per URL under the URL's host, the +ETag+ and
      # +Last-Modified+ of its last successful answer with that body. Keys
      # beyond {MAX_HOSTS} are evicted least recently used first, a body over
      # {MAX_BODY_BYTES} or a document over {MAX_DOCUMENT_BYTES} is not kept, at
      # most {MAX_KNOWN_DOMAINS_PER_HOST} domains of one key are known at once,
      # and the kept bodies and documents never exceed {MAX_TOTAL_BODY_BYTES}
      # together. All methods are thread-safe and ignore a nil key.
      class PeerBackoff
        # Seconds of the backoff after a first failure; each further
        # consecutive failure doubles it.
        BACKOFF_BASE_SECONDS = 60

        # Ceiling of every backoff, a peer's +Retry-After+ included.
        BACKOFF_MAX_SECONDS = 86_400

        # Keys remembered at once.
        MAX_HOSTS = 1024

        # Largest response body kept for revalidation.
        MAX_BODY_BYTES = 1_048_576

        # Ceiling of all kept bodies together.
        MAX_TOTAL_BODY_BYTES = 8 * 1_048_576

        # Doublings after which the backoff stops growing; the ceiling binds
        # long before.
        MAX_BACKOFF_DOUBLINGS = 20

        # Largest well-known document kept for a key's cooldown, as JSON.
        MAX_DOCUMENT_BYTES = 65_536

        # Domains of one key whose verification results are kept at once.
        MAX_KNOWN_DOMAINS_PER_HOST = 4

        # Start knowing no key: no claim, backoff, kept body or kept result.
        #
        # @return [void]
        def initialize
          @mutex = Mutex.new
          @hosts = {}
          @body_bytes = 0
        end

        # Claim a fetch of +host+ unless it must wait: record the claim as the
        # start of the key's cooldown, which starts knowing nothing.
        #
        # @param host [String, nil] peer key (+federation_backoff_key+).
        # @param cooldown [Numeric] seconds between two claims of one key.
        # @param now [Float] current time in seconds.
        # @return [Float] 0.0 when the claim succeeded, otherwise the seconds
        #   left before the key may be fetched.
        def claim(host, cooldown:, now: Time.now.to_f)
          return 0.0 if host.nil?

          @mutex.synchronize do
            wait = wait_locked(host, cooldown, now)
            return wait if wait.positive?

            entry = entry_locked(host)
            entry[:fetched_at] = now
            drop_knowledge_locked(entry)
            0.0
          end
        end

        # Seconds before +host+ may be fetched again: the longer of what is
        # left of its cooldown and of its backoff.
        #
        # @param host [String, nil] peer key (+federation_backoff_key+).
        # @param cooldown [Numeric] seconds between two claims of one key.
        # @param now [Float] current time in seconds.
        # @return [Float] seconds, 0.0 when the key may be fetched now.
        def wait_seconds(host, cooldown:, now: Time.now.to_f)
          return 0.0 if host.nil?

          @mutex.synchronize { wait_locked(host, cooldown, now) }
        end

        # Seconds left of +host+'s fetch cooldown alone.
        #
        # @param host [String, nil] peer key (+federation_backoff_key+).
        # @param cooldown [Numeric] seconds between two claims of one key.
        # @param now [Float] current time in seconds.
        # @return [Float] seconds, 0.0 when no cooldown runs.
        def cooldown_seconds(host, cooldown:, now: Time.now.to_f)
          return 0.0 if host.nil?

          @mutex.synchronize { cooldown_left_locked(@hosts[host], cooldown, now) }
        end

        # Seconds left of +host+'s backoff.
        #
        # @param host [String, nil] peer key (+federation_backoff_key+).
        # @param now [Float] current time in seconds.
        # @return [Float] seconds, 0.0 when the key is not backing off.
        def backoff_seconds(host, now: Time.now.to_f)
          return 0.0 if host.nil?

          @mutex.synchronize { backoff_left_locked(@hosts[host], now) }
        end

        # Record a failed fetch of +host+ and back off: {BACKOFF_BASE_SECONDS}
        # doubled per consecutive failure, at least the peer's +Retry-After+,
        # at most {BACKOFF_MAX_SECONDS}.
        #
        # @param host [String, nil] peer key (+federation_backoff_key+).
        # @param retry_after [Numeric, nil] seconds the peer asked for.
        # @param now [Float] current time in seconds.
        # @return [void]
        def record_failure(host, retry_after: nil, now: Time.now.to_f)
          return if host.nil?

          @mutex.synchronize do
            entry = entry_locked(host)
            entry[:failures] += 1
            doublings = [entry[:failures] - 1, MAX_BACKOFF_DOUBLINGS].min
            delay = [BACKOFF_BASE_SECONDS * (2 ** doublings), retry_after.to_f].max
            entry[:backoff_until] = now + [delay, BACKOFF_MAX_SECONDS].min
          end
        end

        # Record that +host+ answered: clear its failures and backoff.
        #
        # @param host [String, nil] peer key (+federation_backoff_key+).
        # @return [void]
        def record_success(host)
          return if host.nil?

          @mutex.synchronize do
            entry = @hosts[host]
            next unless entry

            entry[:failures] = 0
            entry[:backoff_until] = nil
          end
        end

        # The validators and body kept for +url+.
        #
        # @param host [String, nil] peer host the URL belongs to.
        # @param url [String] full request URL.
        # @return [Hash, nil] +:etag+, +:last_modified+ and +:body+, or nil.
        def validators(host, url)
          return nil if host.nil?

          @mutex.synchronize { @hosts[host]&.dig(:validators, url)&.dup }
        end

        # Keep the validators and body of a successful answer from +url+.
        # Nothing is kept without a validator or for a body over
        # {MAX_BODY_BYTES}.
        #
        # @param host [String, nil] peer host the URL belongs to.
        # @param url [String] full request URL.
        # @param etag [String, nil] the answer's +ETag+.
        # @param last_modified [String, nil] the answer's +Last-Modified+.
        # @param body [String] the answer's body.
        # @return [void]
        def store_validators(host, url, etag:, last_modified:, body:)
          return if host.nil? || (etag.nil? && last_modified.nil?)
          return if body.bytesize > MAX_BODY_BYTES

          @mutex.synchronize do
            entry = entry_locked(host)
            drop_validator_locked(entry, url)
            entry[:validators][url] = { etag: etag, last_modified: last_modified, body: body }
            @body_bytes += body.bytesize
            trim_bodies_locked
          end
        end

        # Keep what a fetch under +host+'s current claim learned of +domain+'s
        # well-known document: the document, or the failure of its fetch. A
        # document over {MAX_DOCUMENT_BYTES} is not kept, nor anything for a
        # key without a claim.
        #
        # @param host [String, nil] peer key (+federation_backoff_key+).
        # @param domain [String] sanitized domain whose document was fetched.
        # @param document [Hash, nil] the document, nil when the fetch failed.
        # @param metadata [Object] the fetch's URI or its errors.
        # @return [void]
        def record_well_known(host, domain, document, metadata)
          return if host.nil?

          bytes = document.nil? ? 0 : JSON.generate(document).bytesize
          return if bytes > MAX_DOCUMENT_BYTES

          @mutex.synchronize do
            known = knowledge_slot_locked(host, domain)
            next unless known

            @body_bytes += bytes - known[:bytes].to_i
            known[:well_known] = [document, metadata]
            known[:bytes] = bytes
            trim_bodies_locked
          end
        end

        # Keep what a fetch under +host+'s current claim learned of +domain+'s
        # node list: whether it accepted the peer, and why not.
        #
        # @param host [String, nil] peer key (+federation_backoff_key+).
        # @param domain [String] sanitized domain whose node list was fetched.
        # @param acceptance [Hash] +:accepted+, plus +:error+, +:reason+ and
        #   +:details+ for a refusal.
        # @return [void]
        def record_acceptance(host, domain, acceptance)
          return if host.nil?

          @mutex.synchronize do
            known = knowledge_slot_locked(host, domain)
            known[:acceptance] = acceptance.dup if known
          end
        end

        # What the fetches under +host+'s current claim learned of +domain+,
        # while its cooldown runs.
        #
        # @param host [String, nil] peer key (+federation_backoff_key+).
        # @param domain [String] sanitized domain.
        # @param cooldown [Numeric] seconds between two claims of one key.
        # @param now [Float] current time in seconds.
        # @return [Hash, nil] +:well_known+ (document and metadata) and
        #   +:acceptance+, each when learned; nil once the cooldown ended or
        #   when nothing was learned of the domain.
        def knowledge(host, domain, cooldown:, now: Time.now.to_f)
          return nil if host.nil?

          @mutex.synchronize do
            entry = @hosts[host]
            next nil unless entry && entry[:fetched_at] && entry[:fetched_at] + cooldown > now

            entry[:knowledge][domain]&.slice(:well_known, :acceptance)
          end
        end

        # Forget every key.
        #
        # @return [void]
        def reset!
          @mutex.synchronize do
            @hosts.clear
            @body_bytes = 0
          end
        end

        private

        # The entry for +host+, created when missing and moved to the most
        # recently used end; the least recently used keys beyond
        # {MAX_HOSTS} are evicted. Called with the mutex held.
        #
        # @param host [String] peer key.
        # @return [Hash] the key's entry.
        def entry_locked(host)
          entry = @hosts.delete(host) || { fetched_at: nil, backoff_until: nil, failures: 0, validators: {}, knowledge: {} }
          @hosts[host] = entry
          while @hosts.size > MAX_HOSTS
            _evicted, evicted_entry = @hosts.shift
            evicted_entry[:validators].each_value { |kept| @body_bytes -= kept[:body].bytesize }
            drop_knowledge_locked(evicted_entry)
          end
          entry
        end

        # Forget the validators and body kept for +url+, releasing their
        # bytes. Called with the mutex held.
        #
        # @param entry [Hash] the key's entry.
        # @param url [String] full request URL.
        # @return [void]
        def drop_validator_locked(entry, url)
          kept = entry[:validators].delete(url)
          @body_bytes -= kept[:body].bytesize if kept
        end

        # The knowledge of +domain+ under +host+'s current claim, created when
        # missing; the oldest domain of the key goes beyond
        # {MAX_KNOWN_DOMAINS_PER_HOST}. Called with the mutex held.
        #
        # @param host [String] peer key.
        # @param domain [String] domain key under the peer key.
        # @return [Hash, nil] the domain's knowledge, nil when the key holds
        #   no claim.
        def knowledge_slot_locked(host, domain)
          entry = @hosts[host]
          return nil unless entry && entry[:fetched_at]

          knowledge = entry[:knowledge]
          unless knowledge.key?(domain)
            if knowledge.size >= MAX_KNOWN_DOMAINS_PER_HOST
              _oldest, dropped = knowledge.shift
              @body_bytes -= dropped[:bytes].to_i
            end
            knowledge[domain] = {}
          end
          knowledge[domain]
        end

        # Forget everything the key's claim kept, releasing the bytes of its
        # documents. Called with the mutex held.
        #
        # @param entry [Hash] the key's entry.
        # @return [void]
        def drop_knowledge_locked(entry)
          entry[:knowledge].each_value { |known| @body_bytes -= known[:bytes].to_i }
          entry[:knowledge].clear
        end

        # Drop kept bodies and documents, least recently used key first,
        # until they fit {MAX_TOTAL_BODY_BYTES}. Called with the mutex held.
        #
        # @return [void]
        def trim_bodies_locked
          @hosts.each_value do |entry|
            break if @body_bytes <= MAX_TOTAL_BODY_BYTES

            entry[:validators].keys.each { |url| drop_validator_locked(entry, url) }
            drop_knowledge_locked(entry)
          end
        end

        # Seconds before +host+ may be fetched again, the longer of what is
        # left of its cooldown and of its backoff. Called with the mutex held.
        #
        # @param host [String] peer key.
        # @param cooldown [Numeric] seconds between two claims of one key.
        # @param now [Float] current time in seconds.
        # @return [Float] seconds, 0.0 when the key may be fetched now.
        def wait_locked(host, cooldown, now)
          entry = @hosts[host]
          [cooldown_left_locked(entry, cooldown, now), backoff_left_locked(entry, now)].max.to_f
        end

        # Seconds left of a key's cooldown. Called with the mutex held.
        #
        # @param entry [Hash, nil] the key's entry, nil for an unknown key.
        # @param cooldown [Numeric] seconds between two claims of one key.
        # @param now [Float] current time in seconds.
        # @return [Float] seconds, 0.0 when no cooldown runs.
        def cooldown_left_locked(entry, cooldown, now)
          return 0.0 unless entry && entry[:fetched_at]

          [entry[:fetched_at] + cooldown - now, 0.0].max
        end

        # Seconds left of a key's backoff. Called with the mutex held.
        #
        # @param entry [Hash, nil] the key's entry, nil for an unknown key.
        # @param now [Float] current time in seconds.
        # @return [Float] seconds, 0.0 when the key is not backing off.
        def backoff_left_locked(entry, now)
          return 0.0 unless entry && entry[:backoff_until]

          [entry[:backoff_until] - now, 0.0].max
        end
      end

      # The process-wide {PeerBackoff}, shared by every crawl and registration.
      @peer_backoff = PeerBackoff.new

      # @return [PeerBackoff] the process-wide peer store.
      def self.peer_backoff
        @peer_backoff
      end

      # The process-wide {PeerBackoff}, reachable from the application class
      # and its request instances alike.
      #
      # @return [PeerBackoff] the process-wide peer store.
      def federation_peer_backoff
        PotatoMesh::App::Federation.peer_backoff
      end

      # The host part of a federation domain, without its port: the key of a
      # crawl's per-host state (SPEC FL1). The peer store's cooldown, backoff
      # and kept knowledge use {#federation_backoff_key} instead (SPEC PV1).
      #
      # @param domain [String, nil] sanitized domain, optionally with a port.
      # @return [String, nil] lowercase host, or nil when the domain does not
      #   parse as one.
      def federation_peer_host(domain)
        host = URI.parse("https://#{domain}").host
        host.nil? || host.empty? ? nil : host.downcase
      rescue URI::InvalidURIError
        nil
      end

      # A sanitized domain as federation compares domains: a default port
      # dropped (SPEC FL1). +host:443+ is +host+ over https, and +host:80+ is
      # +host+'s http fallback, so the three name one instance endpoint and
      # compare equal: for the crawl's well-known memo and its port-variant
      # limit, the own-domain check, the well-known document's domain and what
      # a cooldown kept. The domain a record signs and is stored under stays as
      # given.
      #
      # @param domain [String, nil] sanitized domain, optionally with a port.
      # @return [String] the domain without a +:443+ or +:80+ suffix.
      def federation_domain_key(domain)
        domain.to_s.sub(/:(?:443|80)\z/, "")
      end

      # Whether +domain+ names its host with an explicit, non-default port: a
      # port variant of the host (SPEC FL1).
      #
      # @param domain [String] sanitized domain.
      # @return [Boolean] true for a domain such as +host:8443+.
      def federation_port_variant?(domain)
        key = federation_domain_key(domain)
        key != federation_peer_host(key)
      end

      # Suffix of the peer-store key of a host's non-default port variants
      # (SPEC PV1). A +#+ begins a URI fragment and never survives into a
      # host, so {#federation_peer_host} never returns one: the suffixed key
      # cannot collide with any bare host.
      PORT_VARIANT_BACKOFF_SUFFIX = "#port-variant"

      # The {PeerBackoff} key of a federation domain: its fetch cooldown,
      # backoff and kept-knowledge bucket (SPEC FL3, FL4, FL7, PV1).
      #
      # A default port reads as the bare host (SPEC FL1), so +host+,
      # +host:443+ and +host:80+ share the host's bucket. Every non-default
      # port variant of the host shares one *separate* bucket, keyed by the
      # host with {PORT_VARIANT_BACKOFF_SUFFIX}. So a closed port any caller
      # can name (PV1) writes no cooldown, backoff or fetch failure onto the
      # host's default-port endpoint and never occupies its kept-knowledge
      # slot, while all of the host's port variants together still cost at
      # most one fetch per cooldown, preserving the amplification bound
      # (SPEC FL1, FL6). The key is lower case whatever the domain's letter
      # case. A nil host yields a nil key, which every store method ignores.
      #
      # @param domain [String, nil] sanitized domain, optionally with a port.
      # @return [String, nil] the bucket key, or nil when the domain has no
      #   host.
      def federation_backoff_key(domain)
        host = federation_peer_host(domain)
        return host if host.nil?

        federation_port_variant?(domain.to_s.downcase) ? "#{host}#{PORT_VARIANT_BACKOFF_SUFFIX}" : host
      end

      # Parse an HTTP +Retry-After+ value: delay seconds or an HTTP date.
      #
      # @param value [String, nil] header value.
      # @param now [Time] current time.
      # @return [Float, nil] seconds from now (0.0 for a past date), or nil
      #   when the header is absent or does not parse.
      def federation_retry_after_seconds(value, now: Time.now)
        text = value.to_s.strip
        return nil if text.empty?
        return text.to_f if text.match?(/\A\d+\z/)

        [Time.httpdate(text) - now, 0.0].max
      rescue ArgumentError
        nil
      end
    end
  end
end
