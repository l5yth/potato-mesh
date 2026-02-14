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
      FEDERATION_SLEEP_SLICE_SECONDS = 0.2

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

      def self_instance_attributes
        domain = self_instance_domain
        last_update = latest_node_update_timestamp || Time.now.to_i
        nodes_count = active_node_count_since(Time.now.to_i - PotatoMesh::Config.remote_instance_max_node_age)
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
        }
      end

      # Count the number of nodes active since the supplied timestamp.
      #
      # @param cutoff [Integer] unix timestamp in seconds.
      # @param db [SQLite3::Database, nil] optional open handle to reuse.
      # @return [Integer, nil] node count or nil when unavailable.
      def active_node_count_since(cutoff, db: nil)
        return nil unless cutoff

        handle = db || open_database(readonly: true)
        count =
          with_busy_retry do
            handle.get_first_value("SELECT COUNT(*) FROM nodes WHERE last_heard >= ?", cutoff.to_i)
          end
        Integer(count)
      rescue SQLite3::Exception, ArgumentError => e
        warn_log(
          "Failed to count active nodes",
          context: "instances.nodes_count",
          error_class: e.class.name,
          error_message: e.message,
        )
        nil
      ensure
        handle&.close unless db
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
          "contactLink" => attributes[:contact_link],
          "signature" => signature,
        }
        payload.reject { |_, value| value.nil? }
      end

      def ensure_self_instance_record!
        attributes = self_instance_attributes
        signature = sign_instance_attributes(attributes)
        db = nil
        allowed, reason = self_instance_registration_decision(attributes[:domain])
        if allowed
          db = open_database
          upsert_instance_record(db, attributes, signature)
          debug_log(
            "Registered self instance record",
            context: "federation.instances",
            domain: attributes[:domain],
            instance_id: attributes[:id],
          )
        else
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

      # Retrieve or initialize the worker pool servicing federation jobs.
      #
      # @return [PotatoMesh::App::WorkerPool, nil] active worker pool or nil when disabled.
      def federation_worker_pool
        ensure_federation_worker_pool!
      end

      # Ensure the federation worker pool exists when federation remains enabled.
      #
      # @return [PotatoMesh::App::WorkerPool, nil] active worker pool if created.
      def ensure_federation_worker_pool!
        return nil unless federation_enabled?
        clear_federation_shutdown_request!
        ensure_federation_shutdown_hook!

        existing = settings.respond_to?(:federation_worker_pool) ? settings.federation_worker_pool : nil
        return existing if existing&.alive?

        pool = PotatoMesh::App::WorkerPool.new(
          size: PotatoMesh::Config.federation_worker_pool_size,
          max_queue: PotatoMesh::Config.federation_worker_queue_capacity,
          task_timeout: PotatoMesh::Config.federation_task_timeout_seconds,
          name: "potato-mesh-fed",
        )

        set(:federation_worker_pool, pool) if respond_to?(:set)
        pool
      end

      # Ensure federation background workers are torn down during process exit.
      #
      # @return [void]
      def ensure_federation_shutdown_hook!
        return if instance_variable_defined?(:@federation_shutdown_hook_installed) && @federation_shutdown_hook_installed

        @federation_shutdown_hook_installed = true
        at_exit do
          begin
            shutdown_federation_background_work!(timeout: PotatoMesh::Config.federation_shutdown_timeout_seconds)
          rescue StandardError
            # Suppress shutdown errors during interpreter teardown.
          end
        end
      end

      # Check whether federation workers have received a shutdown request.
      #
      # @return [Boolean] true when stop has been requested.
      def federation_shutdown_requested?
        return false unless respond_to?(:settings)
        return false unless settings.respond_to?(:federation_shutdown_requested)

        settings.federation_shutdown_requested == true
      end

      # Mark federation background work as shutting down.
      #
      # @return [void]
      def request_federation_shutdown!
        set(:federation_shutdown_requested, true) if respond_to?(:set)
      end

      # Clear any previously requested federation shutdown marker.
      #
      # @return [void]
      def clear_federation_shutdown_request!
        set(:federation_shutdown_requested, false) if respond_to?(:set)
      end

      # Sleep in short intervals so federation loops can react to shutdown.
      #
      # @param seconds [Numeric] target sleep duration.
      # @return [Boolean] true when the full delay elapsed without shutdown.
      def federation_sleep_with_shutdown(seconds)
        remaining = seconds.to_f
        while remaining.positive?
          return false if federation_shutdown_requested?

          slice = [remaining, FEDERATION_SLEEP_SLICE_SECONDS].min
          Kernel.sleep(slice)
          remaining -= slice
        end
        !federation_shutdown_requested?
      end

      # Shutdown and clear the federation worker pool if present.
      #
      # @return [void]
      def shutdown_federation_worker_pool!
        existing = settings.respond_to?(:federation_worker_pool) ? settings.federation_worker_pool : nil
        return unless existing

        begin
          existing.shutdown(timeout: PotatoMesh::Config.federation_task_timeout_seconds)
        rescue StandardError => e
          warn_log(
            "Failed to shut down federation worker pool",
            context: "federation",
            error_class: e.class.name,
            error_message: e.message,
          )
        ensure
          set(:federation_worker_pool, nil) if respond_to?(:set)
        end
      end

      # Gracefully terminate federation background loops and worker pool tasks.
      #
      # @param timeout [Numeric, nil] maximum join time applied per thread.
      # @return [void]
      def shutdown_federation_background_work!(timeout: nil)
        request_federation_shutdown!
        timeout_value = timeout || PotatoMesh::Config.federation_shutdown_timeout_seconds
        stop_federation_thread!(:initial_federation_thread, timeout: timeout_value)
        stop_federation_thread!(:federation_thread, timeout: timeout_value)
        shutdown_federation_worker_pool!
        clear_federation_crawl_state!
      end

      # Stop a specific federation thread setting and clear its reference.
      #
      # @param setting_name [Symbol] settings key storing the thread object.
      # @param timeout [Numeric] seconds to wait for clean thread exit.
      # @return [void]
      def stop_federation_thread!(setting_name, timeout:)
        return unless respond_to?(:settings)
        return unless settings.respond_to?(setting_name)

        thread = settings.public_send(setting_name)
        if thread&.alive?
          begin
            thread.wakeup if thread.respond_to?(:wakeup)
          rescue ThreadError
            # The thread may not currently be sleeping; continue shutdown.
          end
          thread.join(timeout)
          if thread.alive?
            thread.kill
            thread.join(0.1)
          end
        end
        set(setting_name, nil) if respond_to?(:set)
      end

      def federation_target_domains(self_domain)
        normalized_self = sanitize_instance_domain(self_domain)&.downcase
        ordered = []
        seen = Set.new

        PotatoMesh::Config.federation_seed_domains.each do |seed|
          sanitized = sanitize_instance_domain(seed)&.downcase
          next unless sanitized
          next if normalized_self && sanitized == normalized_self
          next if seen.include?(sanitized)

          ordered << sanitized
          seen << sanitized
        end

        db = open_database(readonly: true)
        db.results_as_hash = false
        cutoff = Time.now.to_i - PotatoMesh::Config.week_seconds
        rows = with_busy_retry do
          db.execute(
            "SELECT domain, last_update_time FROM instances WHERE domain IS NOT NULL AND TRIM(domain) != ''",
          )
        end
        rows.each do |row|
          raw_domain = row[0]
          last_update_time = coerce_integer(row[1])
          next unless last_update_time && last_update_time >= cutoff

          sanitized = sanitize_instance_domain(raw_domain)&.downcase
          next unless sanitized
          next if normalized_self && sanitized == normalized_self
          next if seen.include?(sanitized)

          ordered << sanitized
          seen << sanitized
        end
        ordered
      rescue SQLite3::Exception
        fallback = PotatoMesh::Config.federation_seed_domains.filter_map do |seed|
          candidate = sanitize_instance_domain(seed)&.downcase
          next if normalized_self && candidate == normalized_self

          candidate
        end
        fallback.uniq
      ensure
        db&.close
      end

      def announce_instance_to_domain(domain, payload_json)
        return false unless domain && !domain.empty?
        return false if federation_shutdown_requested?

        https_failures = []

        instance_uri_candidates(domain, "/api/instances").each do |uri|
          return false if federation_shutdown_requested?

          begin
            http = build_remote_http_client(uri)
            response = Timeout.timeout(PotatoMesh::Config.remote_instance_request_timeout) do
              http.start do |connection|
                request = build_federation_http_request(Net::HTTP::Post, uri)
                request.body = payload_json
                connection.request(request)
              end
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
            metadata = {
              context: "federation.announce",
              target: uri.to_s,
              error_class: e.class.name,
              error_message: e.message,
            }

            if uri.scheme == "https" && https_connection_refused?(e)
              debug_log(
                "HTTPS federation announcement failed, retrying with HTTP",
                **metadata,
              )
              https_failures << metadata
              next
            end

            warn_log(
              "Federation announcement raised exception",
              **metadata,
            )
          end
        end

        https_failures.each do |metadata|
          warn_log(
            "Federation announcement raised exception",
            **metadata,
          )
        end

        false
      end

      # Determine whether an HTTPS announcement failure should fall back to HTTP.
      #
      # @param error [StandardError] failure raised while attempting HTTPS.
      # @return [Boolean] true when the error corresponds to a refused TCP connection.
      def https_connection_refused?(error)
        current = error
        while current
          return true if current.is_a?(Errno::ECONNREFUSED)

          current = current.respond_to?(:cause) ? current.cause : nil
        end

        false
      end

      def announce_instance_to_all_domains
        return unless federation_enabled?
        return if federation_shutdown_requested?

        attributes, signature = ensure_self_instance_record!
        payload_json = JSON.generate(instance_announcement_payload(attributes, signature))
        domains = federation_target_domains(attributes[:domain])
        pool = federation_worker_pool
        scheduled = []

        domains.each do |domain|
          break if federation_shutdown_requested?

          if pool
            begin
              task = pool.schedule do
                announce_instance_to_domain(domain, payload_json)
              end
              scheduled << [domain, task]
              next
            rescue PotatoMesh::App::WorkerPool::QueueFullError
              warn_log(
                "Skipped asynchronous federation announcement",
                context: "federation.announce",
                domain: domain,
                reason: "worker queue saturated",
              )
            rescue PotatoMesh::App::WorkerPool::ShutdownError
              warn_log(
                "Worker pool unavailable, falling back to synchronous announcement",
                context: "federation.announce",
                domain: domain,
              )
              pool = nil
            end
          end

          announce_instance_to_domain(domain, payload_json)
        end

        wait_for_federation_tasks(scheduled)

        unless domains.empty?
          debug_log(
            "Federation announcement cycle complete",
            context: "federation.announce",
            targets: domains,
          )
        end
      end

      # Wait for scheduled federation tasks to complete while logging failures.
      #
      # @param scheduled [Array<(String, PotatoMesh::App::WorkerPool::Task)>] pairs of domains and tasks.
      # @return [void]
      def wait_for_federation_tasks(scheduled)
        return if scheduled.empty?

        timeout = PotatoMesh::Config.federation_task_timeout_seconds
        scheduled.each do |domain, task|
          break if federation_shutdown_requested?

          begin
            task.wait(timeout: timeout)
          rescue PotatoMesh::App::WorkerPool::TaskTimeoutError => e
            warn_log(
              "Federation announcement task timed out",
              context: "federation.announce",
              domain: domain,
              timeout: timeout,
              error_class: e.class.name,
              error_message: e.message,
            )
          rescue StandardError => e
            warn_log(
              "Federation announcement task failed",
              context: "federation.announce",
              domain: domain,
              error_class: e.class.name,
              error_message: e.message,
            )
          end
        end
      end

      def start_federation_announcer!
        # Federation broadcasts must not execute when federation support is disabled.
        return nil unless federation_enabled?
        clear_federation_shutdown_request!
        ensure_federation_shutdown_hook!

        existing = settings.federation_thread
        return existing if existing&.alive?

        thread = Thread.new do
          loop do
            break unless federation_sleep_with_shutdown(PotatoMesh::Config.federation_announcement_interval)

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
        # Allow shutdown even if the announcement loop is still sleeping.
        thread.daemon = true if thread.respond_to?(:daemon=)
        set(:federation_thread, thread)
        thread
      end

      # Launch a background thread responsible for the first federation broadcast.
      #
      # @return [Thread, nil] the thread handling the initial announcement.
      def start_initial_federation_announcement!
        # Skip the initial broadcast entirely when federation is disabled.
        return nil unless federation_enabled?
        clear_federation_shutdown_request!
        ensure_federation_shutdown_hook!

        existing = settings.respond_to?(:initial_federation_thread) ? settings.initial_federation_thread : nil
        return existing if existing&.alive?

        thread = Thread.new do
          begin
            delay = PotatoMesh::Config.initial_federation_delay_seconds
            if delay.positive?
              completed = federation_sleep_with_shutdown(delay)
              next unless completed
            end
            next if federation_shutdown_requested?

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
        # Avoid blocking process shutdown during delayed startup announcements.
        thread.daemon = true if thread.respond_to?(:daemon=)
        set(:initial_federation_thread, thread)
        thread
      end

      def canonical_instance_payload(attributes)
        data = {}
        data["contactLink"] = attributes[:contact_link] if attributes[:contact_link]
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
        raise InstanceFetchError, "federation shutdown requested" if federation_shutdown_requested?

        http = build_remote_http_client(uri)
        Timeout.timeout(PotatoMesh::Config.remote_instance_request_timeout) do
          http.start do |connection|
            request = build_federation_http_request(Net::HTTP::Get, uri)
            response = connection.request(request)
            case response
            when Net::HTTPSuccess
              response.body
            else
              raise InstanceFetchError, "unexpected response #{response.code}"
            end
          end
        end
      rescue StandardError => e
        raise_instance_fetch_error(e)
      end

      # Build an HTTP request decorated with the headers required for federation peers.
      #
      # @param request_class [Class<Net::HTTPRequest>] HTTP request class such as {Net::HTTP::Get}.
      # @param uri [URI::Generic] target URI describing the remote endpoint.
      # @return [Net::HTTPRequest] configured HTTP request including standard headers.
      def build_federation_http_request(request_class, uri)
        request = request_class.new(uri)
        request["User-Agent"] = federation_user_agent_header
        request["Accept"] = "application/json"
        request["Content-Type"] = "application/json" if request.request_body_permitted?
        request
      end

      # Compose the User-Agent string used when communicating with federation peers.
      #
      # @return [String] descriptive identifier for PotatoMesh federation requests.
      def federation_user_agent_header
        version = app_constant(:APP_VERSION).to_s
        version = "unknown" if version.empty?
        sanitized_domain = sanitize_instance_domain(app_constant(:INSTANCE_DOMAIN), downcase: true)
        base = "PotatoMesh/#{version}"
        return base unless sanitized_domain && !sanitized_domain.empty?

        "#{base} (+https://#{sanitized_domain})"
      end

      # Build a human readable error message for a failed instance request.
      #
      # @param error [StandardError] failure raised while performing the request.
      # @return [String] description including the error class when necessary.
      def instance_fetch_error_message(error)
        message = error.message.to_s.strip
        class_name = error.class.name || error.class.to_s
        return class_name if message.empty?

        message.include?(class_name) ? message : "#{class_name}: #{message}"
      end

      # Raise an InstanceFetchError that preserves the original context.
      #
      # @param error [StandardError] failure raised while performing the request.
      # @return [void]
      def raise_instance_fetch_error(error)
        message = instance_fetch_error_message(error)
        wrapped = InstanceFetchError.new(message)
        wrapped.set_backtrace(error.backtrace)
        raise wrapped
      end

      def fetch_instance_json(domain, path)
        return [nil, ["federation shutdown requested"]] if federation_shutdown_requested?

        errors = []
        instance_uri_candidates(domain, path).each do |uri|
          break if federation_shutdown_requested?

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

      # Parse a remote federation instance payload into canonical attributes.
      #
      # @param payload [Hash] JSON object describing a remote instance.
      # @return [Array<(Hash, String), String>] tuple containing the attribute
      #   hash and signature when valid or a failure reason when invalid.
      def remote_instance_attributes_from_payload(payload)
        unless payload.is_a?(Hash)
          return [nil, nil, "instance payload is not an object"]
        end

        id = string_or_nil(payload["id"])
        return [nil, nil, "missing instance id"] unless id

        domain = sanitize_instance_domain(payload["domain"])
        return [nil, nil, "missing instance domain"] unless domain

        pubkey = sanitize_public_key_pem(payload["pubkey"])
        return [nil, nil, "missing instance public key"] unless pubkey

        signature = string_or_nil(payload["signature"])
        return [nil, nil, "missing instance signature"] unless signature

        private_value = if payload.key?("isPrivate")
            payload["isPrivate"]
          else
            payload["is_private"]
          end
        private_flag = coerce_boolean(private_value)
        if private_flag.nil?
          numeric_flag = coerce_integer(private_value)
          private_flag = !numeric_flag.to_i.zero? if numeric_flag
        end

        attributes = {
          id: id,
          domain: domain,
          pubkey: pubkey,
          name: string_or_nil(payload["name"]),
          version: string_or_nil(payload["version"]),
          channel: string_or_nil(payload["channel"]),
          frequency: string_or_nil(payload["frequency"]),
          latitude: coerce_float(payload["latitude"]),
          longitude: coerce_float(payload["longitude"]),
          last_update_time: coerce_integer(payload["lastUpdateTime"]),
          is_private: private_flag,
          contact_link: string_or_nil(payload["contactLink"]),
        }

        [attributes, signature, nil]
      rescue StandardError => e
        [nil, nil, e.message]
      end

      # Enqueue a federation crawl for the supplied domain using the worker pool.
      #
      # @param domain [String] sanitized remote domain to crawl.
      # @param per_response_limit [Integer, nil] maximum entries processed per response.
      # @param overall_limit [Integer, nil] maximum unique domains visited.
      # @return [Boolean] true when the crawl was scheduled successfully.
      def enqueue_federation_crawl(domain, per_response_limit:, overall_limit:)
        sanitized_domain = sanitize_instance_domain(domain)
        unless sanitized_domain
          warn_log(
            "Skipped remote instance crawl",
            context: "federation.instances",
            domain: domain,
            reason: "invalid domain",
          )
          return false
        end
        return false if federation_shutdown_requested?

        pool = federation_worker_pool
        unless pool
          debug_log(
            "Skipped remote instance crawl",
            context: "federation.instances",
            domain: sanitized_domain,
            reason: "federation disabled",
          )
          return false
        end

        claim_result = claim_federation_crawl_slot(sanitized_domain)
        unless claim_result == :claimed
          debug_log(
            "Skipped remote instance crawl",
            context: "federation.instances",
            domain: sanitized_domain,
            reason: claim_result == :in_flight ? "crawl already in flight" : "recent crawl completed",
          )
          return false
        end

        application = is_a?(Class) ? self : self.class
        pool.schedule do
          db = nil
          begin
            db = application.open_database
            application.ingest_known_instances_from!(
              db,
              sanitized_domain,
              per_response_limit: per_response_limit,
              overall_limit: overall_limit,
            )
          ensure
            db&.close
            application.release_federation_crawl_slot(sanitized_domain)
          end
        end

        true
      rescue PotatoMesh::App::WorkerPool::QueueFullError
        handle_failed_federation_crawl_schedule(sanitized_domain, "worker queue saturated")
      rescue PotatoMesh::App::WorkerPool::ShutdownError
        handle_failed_federation_crawl_schedule(sanitized_domain, "worker pool shut down")
      end

      # Handle a failed crawl schedule attempt without applying cooldown.
      #
      # @param domain [String] canonical domain that failed to schedule.
      # @param reason [String] human-readable failure reason.
      # @return [Boolean] always false because scheduling did not succeed.
      def handle_failed_federation_crawl_schedule(domain, reason)
        release_federation_crawl_slot(domain, record_completion: false)
        warn_log(
          "Skipped remote instance crawl",
          context: "federation.instances",
          domain: domain,
          reason: reason,
        )
        false
      end

      # Initialize shared in-memory state used to deduplicate crawl scheduling.
      #
      # @return [void]
      def initialize_federation_crawl_state!
        return if instance_variable_defined?(:@federation_crawl_mutex) && @federation_crawl_mutex

        @federation_crawl_mutex = Mutex.new
        @federation_crawl_in_flight = Set.new
        @federation_crawl_last_completed_at = {}
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

      # Recursively ingest federation records exposed by the supplied domain.
      #
      # @param db [SQLite3::Database] open database connection used for writes.
      # @param domain [String] remote domain to crawl for federation records.
      # @param visited [Set<String>] domains processed during this crawl.
      # @param per_response_limit [Integer, nil] maximum entries processed per response.
      # @param overall_limit [Integer, nil] maximum unique domains visited.
      # @return [Set<String>] updated set of visited domains.
      def ingest_known_instances_from!(
        db,
        domain,
        visited: nil,
        per_response_limit: nil,
        overall_limit: nil
      )
        sanitized = sanitize_instance_domain(domain)
        return visited || Set.new unless sanitized
        return visited || Set.new if federation_shutdown_requested?

        visited ||= Set.new

        overall_limit ||= PotatoMesh::Config.federation_max_domains_per_crawl
        per_response_limit ||= PotatoMesh::Config.federation_max_instances_per_response

        if overall_limit && overall_limit.positive? && visited.size >= overall_limit
          debug_log(
            "Skipped remote instance crawl due to crawl limit",
            context: "federation.instances",
            domain: sanitized,
            limit: overall_limit,
          )
          return visited
        end

        return visited if visited.include?(sanitized)

        visited << sanitized

        payload, metadata = fetch_instance_json(sanitized, "/api/instances")
        unless payload.is_a?(Array)
          warn_log(
            "Failed to load remote federation instances",
            context: "federation.instances",
            domain: sanitized,
            reason: Array(metadata).map(&:to_s).join("; "),
          )
          return visited
        end

        processed_entries = 0
        recent_cutoff = Time.now.to_i - PotatoMesh::Config.remote_instance_max_node_age
        payload.each do |entry|
          break if federation_shutdown_requested?

          if per_response_limit && per_response_limit.positive? && processed_entries >= per_response_limit
            debug_log(
              "Skipped remote instance entry due to response limit",
              context: "federation.instances",
              domain: sanitized,
              limit: per_response_limit,
            )
            break
          end

          if overall_limit && overall_limit.positive? && visited.size >= overall_limit
            debug_log(
              "Skipped remote instance entry due to crawl limit",
              context: "federation.instances",
              domain: sanitized,
              limit: overall_limit,
            )
            break
          end

          processed_entries += 1
          attributes, signature, reason = remote_instance_attributes_from_payload(entry)
          unless attributes && signature
            warn_log(
              "Discarded remote instance entry",
              context: "federation.instances",
              domain: sanitized,
              reason: reason || "invalid payload",
            )
            next
          end

          if attributes[:is_private]
            debug_log(
              "Skipped private remote instance",
              context: "federation.instances",
              domain: attributes[:domain],
            )
            next
          end

          unless verify_instance_signature(attributes, signature, attributes[:pubkey])
            warn_log(
              "Discarded remote instance entry",
              context: "federation.instances",
              domain: attributes[:domain],
              reason: "invalid signature",
            )
            next
          end

          attributes[:is_private] = false if attributes[:is_private].nil?

          nodes_since_path = "/api/nodes?since=#{recent_cutoff}&limit=1000"
          nodes_since_window, nodes_since_metadata = fetch_instance_json(attributes[:domain], nodes_since_path)
          if nodes_since_window.is_a?(Array)
            attributes[:nodes_count] = nodes_since_window.length
          elsif nodes_since_metadata
            warn_log(
              "Failed to load remote node window",
              context: "federation.instances",
              domain: attributes[:domain],
              reason: Array(nodes_since_metadata).map(&:to_s).join("; "),
            )
          end

          remote_nodes = nil
          node_metadata = nil
          if nodes_since_window.is_a?(Array)
            remote_nodes = nodes_since_window
          else
            remote_nodes, node_metadata = fetch_instance_json(attributes[:domain], "/api/nodes")
          end
          unless remote_nodes
            warn_log(
              "Failed to load remote node data",
              context: "federation.instances",
              domain: attributes[:domain],
              reason: Array(node_metadata || nodes_since_metadata).map(&:to_s).join("; "),
            )
            next
          end

          fresh, freshness_reason = validate_remote_nodes(remote_nodes)
          unless fresh
            warn_log(
              "Discarded remote instance entry",
              context: "federation.instances",
              domain: attributes[:domain],
              reason: freshness_reason || "stale node data",
            )
            next
          end

          begin
            upsert_instance_record(db, attributes, signature)
            ingest_known_instances_from!(
              db,
              attributes[:domain],
              visited: visited,
              per_response_limit: per_response_limit,
              overall_limit: overall_limit,
            )
          rescue ArgumentError => e
            warn_log(
              "Failed to persist remote instance",
              context: "federation.instances",
              domain: attributes[:domain],
              error_class: e.class.name,
              error_message: e.message,
            )
          end
        end

        visited
      end

      # Resolve the host component of a remote URI and ensure the destination is
      # safe for federation HTTP requests.
      #
      # The method performs a DNS lookup using Addrinfo to capture every
      # available address for the supplied URI host. The resulting addresses are
      # converted to {IPAddr} objects for consistent inspection via
      # {restricted_ip_address?}. When all resolved addresses fall within
      # restricted ranges, the method raises an ArgumentError so callers can
      # abort the federation request before contacting the remote endpoint.
      #
      # @param uri [URI::Generic] remote endpoint candidate.
      # @return [Array<IPAddr>] list of resolved, unrestricted IP addresses.
      # @raise [ArgumentError] when +uri.host+ is blank or resolves solely to
      #   restricted addresses.
      def resolve_remote_ip_addresses(uri)
        host = uri&.host
        raise ArgumentError, "URI missing host" unless host

        addrinfo_records = Addrinfo.getaddrinfo(host, nil, Socket::AF_UNSPEC, Socket::SOCK_STREAM)
        addresses = addrinfo_records.filter_map do |addr|
          begin
            IPAddr.new(addr.ip_address)
          rescue IPAddr::InvalidAddressError
            nil
          end
        end
        unique_addresses = addresses.uniq { |ip| [ip.family, ip.to_s] }
        unrestricted_addresses = unique_addresses.reject { |ip| restricted_ip_address?(ip) }

        if unique_addresses.any? && unrestricted_addresses.empty?
          raise ArgumentError, "restricted domain"
        end

        unrestricted_addresses
      end

      # Build an HTTP client configured for communication with a remote instance.
      #
      # @param uri [URI::Generic] target URI describing the remote endpoint.
      # @return [Net::HTTP] HTTP client ready to execute the request.
      def build_remote_http_client(uri)
        remote_addresses = resolve_remote_ip_addresses(uri)
        http = Net::HTTP.new(uri.host, uri.port)
        if http.respond_to?(:ipaddr=) && remote_addresses.any?
          http.ipaddr = remote_addresses.first.to_s
        end
        http.open_timeout = PotatoMesh::Config.remote_instance_http_timeout
        http.read_timeout = PotatoMesh::Config.remote_instance_read_timeout
        http.use_ssl = uri.scheme == "https"
        return http unless http.use_ssl?

        http.verify_mode = OpenSSL::SSL::VERIFY_PEER
        http.min_version = :TLS1_2 if http.respond_to?(:min_version=)
        store = remote_instance_cert_store
        http.cert_store = store if store
        callback = remote_instance_verify_callback
        http.verify_callback = callback if callback
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

      # Build a TLS verification callback that tolerates CRL availability failures.
      #
      # Some certificate authorities publish CRL endpoints that may occasionally be
      # unreachable. When OpenSSL cannot download the CRL it raises the
      # V_ERR_UNABLE_TO_GET_CRL error which would otherwise cause HTTPS federation
      # announcements to abort. The generated callback accepts those specific
      # failures while preserving strict verification for all other errors.
      #
      # @return [Proc, nil] verification callback or nil when creation fails.
      def remote_instance_verify_callback
        if defined?(@remote_instance_verify_callback) && @remote_instance_verify_callback
          return @remote_instance_verify_callback
        end

        callback = lambda do |preverify_ok, store_context|
          return true if preverify_ok

          if store_context && crl_unavailable_error?(store_context.error)
            debug_log(
              "Ignoring TLS CRL retrieval failure during federation request",
              context: "federation.announce",
            )
            true
          else
            false
          end
        end

        @remote_instance_verify_callback = callback
      rescue StandardError => e
        debug_log(
          "Failed to initialize federation TLS verify callback: #{e.message}",
          context: "federation.announce",
        )
        @remote_instance_verify_callback = nil
      end

      # Determine whether the supplied OpenSSL verification error corresponds to a
      # missing certificate revocation list.
      #
      # @param error_code [Integer, nil] OpenSSL verification error value.
      # @return [Boolean] true when the error should be ignored.
      def crl_unavailable_error?(error_code)
        allowed_errors = [OpenSSL::X509::V_ERR_UNABLE_TO_GET_CRL]
        if defined?(OpenSSL::X509::V_ERR_UNABLE_TO_GET_CRL_ISSUER)
          allowed_errors << OpenSSL::X509::V_ERR_UNABLE_TO_GET_CRL_ISSUER
        end
        allowed_errors.include?(error_code)
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

          last_heard_values = []
          last_heard_values << coerce_integer(node["last_heard"])
          last_heard_values << coerce_integer(node["lastHeard"])
          last_heard_values.compact.max
        end.compact.max

        return [false, "missing last_heard data"] unless latest

        cutoff = Time.now.to_i - PotatoMesh::Config.remote_instance_max_node_age
        return [false, "node data is stale"] if latest < cutoff

        [true, nil]
      end

      def upsert_instance_record(db, attributes, signature)
        sanitized_domain = sanitize_instance_domain(attributes[:domain])
        raise ArgumentError, "invalid domain" unless sanitized_domain

        ip = ip_from_domain(sanitized_domain)
        if ip && restricted_ip_address?(ip)
          raise ArgumentError, "restricted domain"
        end

        normalized_domain = sanitized_domain
        existing_id = with_busy_retry do
          db.get_first_value(
            "SELECT id FROM instances WHERE domain = ?",
            normalized_domain,
          )
        end
        if existing_id && existing_id != attributes[:id]
          with_busy_retry do
            db.execute("DELETE FROM instances WHERE id = ?", existing_id)
          end
          debug_log(
            "Removed conflicting instance by domain",
            context: "federation.instances",
            domain: normalized_domain,
            replaced_id: existing_id,
            incoming_id: attributes[:id],
          )
        end

        sql = <<~SQL
          INSERT INTO instances (
            id, domain, pubkey, name, version, channel, frequency,
            latitude, longitude, last_update_time, is_private, nodes_count, contact_link, signature
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            nodes_count=excluded.nodes_count,
            contact_link=excluded.contact_link,
            signature=excluded.signature
        SQL

        nodes_count = coerce_integer(attributes[:nodes_count])
        params = [
          attributes[:id],
          normalized_domain,
          attributes[:pubkey],
          attributes[:name],
          attributes[:version],
          attributes[:channel],
          attributes[:frequency],
          attributes[:latitude],
          attributes[:longitude],
          attributes[:last_update_time],
          attributes[:is_private] ? 1 : 0,
          nodes_count,
          attributes[:contact_link],
          signature,
        ]

        with_busy_retry do
          db.execute(sql, params)
        end
      end
    end
  end
end
