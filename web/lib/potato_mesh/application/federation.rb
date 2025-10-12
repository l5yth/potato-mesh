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
      def self_instance_domain
        sanitized = sanitize_instance_domain(app_constant(:INSTANCE_DOMAIN))
        return sanitized if sanitized

        raise "INSTANCE_DOMAIN could not be determined"
      end

      def self_instance_attributes
        domain = self_instance_domain
        last_update = latest_node_update_timestamp || Time.now.to_i
        {
          id: app_constant(:SELF_INSTANCE_ID),
          domain: domain,
          pubkey: app_constant(:INSTANCE_PUBLIC_KEY_PEM),
          name: sanitized_site_name,
          version: app_constant(:APP_VERSION),
          channel: sanitized_default_channel,
          frequency: sanitized_default_frequency,
          latitude: PotatoMesh::Config.map_center_lat,
          longitude: PotatoMesh::Config.map_center_lon,
          last_update_time: last_update,
          is_private: private_mode?,
        }
      end

      def sign_instance_attributes(attributes)
        payload = canonical_instance_payload(attributes)
        Base64.strict_encode64(
          app_constant(:INSTANCE_PRIVATE_KEY).sign(OpenSSL::Digest::SHA256.new, payload),
        )
      end

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
          "signature" => signature,
        }
        payload.reject { |_, value| value.nil? }
      end

      def ensure_self_instance_record!
        attributes = self_instance_attributes
        signature = sign_instance_attributes(attributes)
        db = open_database
        upsert_instance_record(db, attributes, signature)
        debug_log(
          "Registered self instance record",
          context: "federation.instances",
          domain: attributes[:domain],
          instance_id: attributes[:id],
        )
        [attributes, signature]
      ensure
        db&.close
      end

      def federation_target_domains(self_domain)
        domains = Set.new
        PotatoMesh::Config.federation_seed_domains.each do |seed|
          sanitized = sanitize_instance_domain(seed)
          domains << sanitized.downcase if sanitized
        end

        db = open_database(readonly: true)
        db.results_as_hash = false
        rows = with_busy_retry { db.execute("SELECT domain FROM instances WHERE domain IS NOT NULL AND TRIM(domain) != ''") }
        rows.flatten.compact.each do |raw_domain|
          sanitized = sanitize_instance_domain(raw_domain)
          domains << sanitized.downcase if sanitized
        end
        if self_domain
          domains.delete(self_domain.downcase)
        end
        domains.to_a
      rescue SQLite3::Exception
        domains =
          PotatoMesh::Config.federation_seed_domains.map do |seed|
            sanitize_instance_domain(seed)&.downcase
          end.compact
        self_domain ? domains.reject { |domain| domain == self_domain.downcase } : domains
      ensure
        db&.close
      end

      def announce_instance_to_domain(domain, payload_json)
        return false unless domain && !domain.empty?

        instance_uri_candidates(domain, "/api/instances").each do |uri|
          begin
            http = build_remote_http_client(uri)
            response = http.start do |connection|
              request = Net::HTTP::Post.new(uri)
              request["Content-Type"] = "application/json"
              request.body = payload_json
              connection.request(request)
            end
            if response.is_a?(Net::HTTPSuccess)
              debug_log(
                "Published federation announcement",
                context: "federation.announce",
                target: uri.to_s,
                status: response.code,
              )
              return true
            end
            debug_log(
              "Federation announcement failed",
              context: "federation.announce",
              target: uri.to_s,
              status: response.code,
            )
          rescue StandardError => e
            warn_log(
              "Federation announcement raised exception",
              context: "federation.announce",
              target: uri.to_s,
              error_class: e.class.name,
              error_message: e.message,
            )
          end
        end

        false
      end

      def announce_instance_to_all_domains
        return unless federation_enabled?

        attributes, signature = ensure_self_instance_record!
        payload_json = JSON.generate(instance_announcement_payload(attributes, signature))
        domains = federation_target_domains(attributes[:domain])
        domains.each do |domain|
          announce_instance_to_domain(domain, payload_json)
        end
        unless domains.empty?
          debug_log(
            "Federation announcement cycle complete",
            context: "federation.announce",
            targets: domains,
          )
        end
      end

      def start_federation_announcer!
        existing = settings.federation_thread
        return existing if existing&.alive?

        thread = Thread.new do
          loop do
            sleep PotatoMesh::Config.federation_announcement_interval
            begin
              announce_instance_to_all_domains
            rescue StandardError => e
              warn_log(
                "Federation announcement loop error",
                context: "federation.announce",
                error_class: e.class.name,
                error_message: e.message,
              )
            end
          end
        end
        thread.name = "potato-mesh-federation" if thread.respond_to?(:name=)
        set(:federation_thread, thread)
        thread
      end

      def start_initial_federation_announcement!
        existing = settings.respond_to?(:initial_federation_thread) ? settings.initial_federation_thread : nil
        return existing if existing&.alive?

        thread = Thread.new do
          begin
            announce_instance_to_all_domains
          rescue StandardError => e
            warn_log(
              "Initial federation announcement failed",
              context: "federation.announce",
              error_class: e.class.name,
              error_message: e.message,
            )
          ensure
            set(:initial_federation_thread, nil)
          end
        end
        thread.name = "potato-mesh-federation-initial" if thread.respond_to?(:name=)
        thread.report_on_exception = false if thread.respond_to?(:report_on_exception=)
        set(:initial_federation_thread, thread)
        thread
      end

      def canonical_instance_payload(attributes)
        data = {}
        data["id"] = attributes[:id] if attributes[:id]
        data["domain"] = attributes[:domain] if attributes[:domain]
        data["pubkey"] = attributes[:pubkey] if attributes[:pubkey]
        data["name"] = attributes[:name] if attributes[:name]
        data["version"] = attributes[:version] if attributes[:version]
        data["channel"] = attributes[:channel] if attributes[:channel]
        data["frequency"] = attributes[:frequency] if attributes[:frequency]
        data["latitude"] = attributes[:latitude] unless attributes[:latitude].nil?
        data["longitude"] = attributes[:longitude] unless attributes[:longitude].nil?
        data["lastUpdateTime"] = attributes[:last_update_time] unless attributes[:last_update_time].nil?
        data["isPrivate"] = attributes[:is_private] unless attributes[:is_private].nil?

        JSON.generate(data, sort_keys: true)
      end

      def verify_instance_signature(attributes, signature, public_key_pem)
        return false unless signature && public_key_pem

        canonical = canonical_instance_payload(attributes)
        signature_bytes = Base64.strict_decode64(signature)
        key = OpenSSL::PKey::RSA.new(public_key_pem)
        key.verify(OpenSSL::Digest::SHA256.new, signature_bytes, canonical)
      rescue ArgumentError, OpenSSL::PKey::PKeyError
        false
      end

      def instance_uri_candidates(domain, path)
        base = domain
        [
          URI.parse("https://#{base}#{path}"),
          URI.parse("http://#{base}#{path}"),
        ]
      rescue URI::InvalidURIError
        []
      end

      def perform_instance_http_request(uri)
        http = build_remote_http_client(uri)
        http.start do |connection|
          response = connection.request(Net::HTTP::Get.new(uri))
          case response
          when Net::HTTPSuccess
            response.body
          else
            raise InstanceFetchError, "unexpected response #{response.code}"
          end
        end
      rescue StandardError => e
        raise InstanceFetchError, e.message
      end

      def fetch_instance_json(domain, path)
        errors = []
        instance_uri_candidates(domain, path).each do |uri|
          begin
            body = perform_instance_http_request(uri)
            return [JSON.parse(body), uri] if body
          rescue JSON::ParserError => e
            errors << "#{uri}: invalid JSON (#{e.message})"
          rescue InstanceFetchError => e
            errors << "#{uri}: #{e.message}"
          end
        end
        [nil, errors]
      end

      # Build an HTTP client configured for communication with a remote instance.
      #
      # @param uri [URI::Generic] target URI describing the remote endpoint.
      # @return [Net::HTTP] HTTP client ready to execute the request.
      def build_remote_http_client(uri)
        http = Net::HTTP.new(uri.host, uri.port)
        http.open_timeout = PotatoMesh::Config.remote_instance_http_timeout
        http.read_timeout = PotatoMesh::Config.remote_instance_http_timeout
        http.use_ssl = uri.scheme == "https"
        return http unless http.use_ssl?

        http.verify_mode = OpenSSL::SSL::VERIFY_PEER
        http.min_version = :TLS1_2 if http.respond_to?(:min_version=)
        store = remote_instance_cert_store
        http.cert_store = store if store
        http
      end

      # Construct a certificate store that disables strict CRL enforcement.
      #
      # OpenSSL may fail remote requests when certificate revocation lists are
      # unavailable from the issuing authority. The returned store mirrors the
      # default system trust store while clearing CRL-related flags so that
      # federation announcements gracefully succeed when CRLs cannot be fetched.
      #
      # @return [OpenSSL::X509::Store, nil] configured store or nil when setup fails.
      def remote_instance_cert_store
        return @remote_instance_cert_store if defined?(@remote_instance_cert_store) && @remote_instance_cert_store

        store = OpenSSL::X509::Store.new
        store.set_default_paths
        store.flags = 0 if store.respond_to?(:flags=)
        @remote_instance_cert_store = store
      rescue OpenSSL::X509::StoreError => e
        debug_log(
          "Failed to initialize certificate store for federation HTTP: #{e.message}",
        )
        @remote_instance_cert_store = nil
      end

      def validate_well_known_document(document, domain, pubkey)
        unless document.is_a?(Hash)
          return [false, "document is not an object"]
        end

        remote_pubkey = sanitize_public_key_pem(document["publicKey"])
        return [false, "public key missing"] unless remote_pubkey
        return [false, "public key mismatch"] unless remote_pubkey == pubkey

        remote_domain = string_or_nil(document["domain"])
        return [false, "domain missing"] unless remote_domain
        return [false, "domain mismatch"] unless remote_domain.casecmp?(domain)

        algorithm = string_or_nil(document["signatureAlgorithm"])
        unless algorithm&.casecmp?(PotatoMesh::Config.instance_signature_algorithm)
          return [false, "unsupported signature algorithm"]
        end

        signed_payload_b64 = string_or_nil(document["signedPayload"])
        signature_b64 = string_or_nil(document["signature"])
        return [false, "missing signed payload"] unless signed_payload_b64
        return [false, "missing signature"] unless signature_b64

        signed_payload = Base64.strict_decode64(signed_payload_b64)
        signature = Base64.strict_decode64(signature_b64)
        key = OpenSSL::PKey::RSA.new(remote_pubkey)
        unless key.verify(OpenSSL::Digest::SHA256.new, signature, signed_payload)
          return [false, "invalid well-known signature"]
        end

        payload = JSON.parse(signed_payload)
        unless payload.is_a?(Hash)
          return [false, "signed payload is not an object"]
        end

        payload_domain = string_or_nil(payload["domain"])
        payload_pubkey = sanitize_public_key_pem(payload["publicKey"])
        return [false, "signed payload domain mismatch"] unless payload_domain&.casecmp?(domain)
        return [false, "signed payload public key mismatch"] unless payload_pubkey == pubkey

        [true, nil]
      rescue ArgumentError, OpenSSL::PKey::PKeyError => e
        [false, e.message]
      rescue JSON::ParserError => e
        [false, "signed payload JSON error: #{e.message}"]
      end

      def validate_remote_nodes(nodes)
        unless nodes.is_a?(Array)
          return [false, "node response is not an array"]
        end

        if nodes.length < PotatoMesh::Config.remote_instance_min_node_count
          return [false, "insufficient nodes"]
        end

        latest = nodes.filter_map do |node|
          next unless node.is_a?(Hash)

          timestamps = []
          timestamps << coerce_integer(node["last_heard"])
          timestamps << coerce_integer(node["position_time"])
          timestamps << coerce_integer(node["first_heard"])
          timestamps.compact.max
        end.compact.max

        return [false, "missing recent node updates"] unless latest

        cutoff = Time.now.to_i - PotatoMesh::Config.remote_instance_max_node_age
        return [false, "node data is stale"] if latest < cutoff

        [true, nil]
      end

      def upsert_instance_record(db, attributes, signature)
        sql = <<~SQL
          INSERT INTO instances (
            id, domain, pubkey, name, version, channel, frequency,
            latitude, longitude, last_update_time, is_private, signature
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            domain=excluded.domain,
            pubkey=excluded.pubkey,
            name=excluded.name,
            version=excluded.version,
            channel=excluded.channel,
            frequency=excluded.frequency,
            latitude=excluded.latitude,
            longitude=excluded.longitude,
            last_update_time=excluded.last_update_time,
            is_private=excluded.is_private,
            signature=excluded.signature
        SQL

        params = [
          attributes[:id],
          attributes[:domain],
          attributes[:pubkey],
          attributes[:name],
          attributes[:version],
          attributes[:channel],
          attributes[:frequency],
          attributes[:latitude],
          attributes[:longitude],
          attributes[:last_update_time],
          attributes[:is_private] ? 1 : 0,
          signature,
        ]

        with_busy_retry do
          db.execute(sql, params)
        end
      end
    end
  end
end
