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
      # Fetch a domain's own +/.well-known/potato-mesh+ document and confirm
      # that it names the supplied public key and domain.
      #
      # The well-known document is the federation identity anchor: the domain
      # serves it itself, so only whoever controls the domain can make it name
      # a key. The fetch runs through {fetch_instance_json} and keeps its
      # safeguards (restricted addresses, pinned connections, no redirects,
      # response size cap, timeouts). The registration route and the crawl's
      # relayed-record check share this one check. Within a crawl the
      # document is fetched once per domain and every record is judged
      # against it, so a forged record costs one fetch and cannot spoil the
      # genuine record's check (SPEC FL1). A registration inside the host's
      # fetch cooldown is judged against the document, or the fetch failure,
      # that the fetch which started the cooldown kept (SPEC FL7).
      #
      # @param domain [String] sanitized domain whose document is fetched.
      # @param pubkey [String] canonical PEM public key the document must name.
      # @param crawl [CrawlState, nil] the crawl the check runs in, nil for a
      #   registration.
      # @param cached [Array(Hash, Object), nil] a kept fetch result to judge
      #   instead of fetching.
      # @return [Array(Boolean, Symbol, String)] +[true, nil, nil]+ when the
      #   document matches. Otherwise +false+, the failure kind and a
      #   human-readable detail: +:fetch_failed+ when no document could be
      #   loaded (the detail lists the fetch errors, or "no response"), and
      #   +:invalid+ when the document does not match (the detail is the
      #   validation reason).
      def verify_well_known_identity(domain, pubkey, crawl: nil, cached: nil)
        document, metadata = cached || federation_well_known_document(domain, crawl) do
          fetch_instance_json(domain, "/.well-known/potato-mesh")
        end
        unless document
          details = Array(metadata).map(&:to_s)
          return [false, :fetch_failed, details.empty? ? "no response" : details.join("; ")]
        end

        valid, reason = validate_well_known_document(document, domain, pubkey)
        return [true, nil, nil] if valid

        [false, :invalid, reason || "invalid well-known document"]
      end

      # Load a domain's well-known document with the block, once per crawl
      # and through the crawl's limits, or directly outside a crawl. What a
      # fetch learned, the document or the failure, is kept for the host's
      # fetch cooldown (SPEC FL7). In one crawl the bare domain of a host and
      # all its port variants together fetch once each; a further variant is
      # refused unfetched and so stays unconfirmed (SPEC FL1).
      #
      # @param domain [String] sanitized domain.
      # @param crawl [CrawlState, nil] the crawl, nil outside one.
      # @yieldreturn [Array(Object, Object)] the +fetch_instance_json+ result.
      # @return [Array(Object, Object)] the document and its metadata.
      def federation_well_known_document(domain, crawl, &fetch)
        host = federation_peer_host(domain)
        key = federation_domain_key(domain)
        learn = lambda do
          fetch.call.tap { |result| federation_peer_backoff.record_well_known(host, key, *result) }
        end
        return learn.call unless crawl

        crawl.well_known(key) do
          if federation_port_variant?(domain) && !crawl.port_variant_fetch?(host, key)
            next [nil, ["#{domain}: #{host} fetched another port variant's well-known in this crawl"]]
          end

          federation_crawl_request(crawl, domain, &learn)
        end
      end

      # Whether +id+ is the instance id that +pubkey+ derives: the SHA-256 hex
      # digest of the PEM string the record carries, with CRLF and CR line
      # endings read as LF, as every instance computes its own
      # (+SELF_INSTANCE_ID+). Binding the id to the key means
      # no record can claim, squat or move another instance's row through its
      # id: rows are upserted by id, and only the key holder can sign a record
      # carrying that key (SPEC FS9).
      #
      # @param id [String, nil] the record's instance id.
      # @param pubkey [String, nil] the record's PEM public key.
      # @return [Boolean] true when +id+ equals the hex SHA-256 of +pubkey+.
      def instance_id_matches_key?(id, pubkey)
        id.to_s == Digest::SHA256.hexdigest(pubkey.to_s)
      end

      # Decide whether a record relayed by another peer may be stored (SPEC
      # FS8, FS9).
      #
      # A crawled record only proves that it was signed by the key it
      # carries, so any peer can relay a record it signed itself for a domain
      # it does not control, or under another instance's id. The record is
      # skipped, before any request, when its id is not the one its key
      # derives (FS9). A record under the key already stored for its domain
      # is a refresh and needs no confirmation. Any other record, one that
      # re-keys a stored domain or names a domain with no stored row, is
      # accepted only when that domain's own well-known document names the
      # record's key and domain (FS8), as it does after a genuine key rotation
      # or for a genuine new instance.
      #
      # @param db [SQLite3::Database] open database handle.
      # @param attributes [Hash] attributes of a relayed record whose
      #   signature already verified against +attributes[:pubkey]+.
      # @param crawl [CrawlState, nil] the crawl reading the record.
      # @return [Array(Boolean, String)] +[true, nil]+ when the record may be
      #   stored, otherwise +[false, reason]+.
      def confirm_relayed_instance_key(db, attributes, crawl: nil)
        pubkey = attributes[:pubkey]
        return [false, "id does not match key"] unless instance_id_matches_key?(attributes[:id], pubkey)

        # Same normalization as upsert_instance_record, so the lookup finds the
        # row an upsert of this record would delete or overwrite.
        domain = sanitize_instance_domain(attributes[:domain])
        domain_pubkey = with_busy_retry do
          db.get_first_value("SELECT pubkey FROM instances WHERE domain = ?", domain)
        end
        return [true, nil] if domain_pubkey && domain_pubkey == pubkey

        confirmed, _kind, detail = verify_well_known_identity(domain, pubkey, crawl: crawl)
        return [true, nil] if confirmed

        unconfirmed = domain_pubkey ? "unconfirmed key change" : "unconfirmed new domain"
        [false, "#{unconfirmed}: #{detail}"]
      end
    end
  end
end
