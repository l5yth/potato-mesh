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
      # Maximum slice (seconds) used by +federation_sleep_with_shutdown+ when
      # decomposing a target sleep into shutdown-aware increments.
      FEDERATION_SLEEP_SLICE_SECONDS = 0.2

      # Retrieve or initialize the worker pool servicing federation jobs.
      #
      # @return [PotatoMesh::App::WorkerPool, nil] active worker pool or nil when disabled.
      def federation_worker_pool
        ensure_federation_worker_pool!
      end

      # Ensure the federation worker pool exists when federation remains enabled.
      #
      # Threading model: the pool is a fixed-size thread pool backed by a bounded
      # queue.  A single long-lived announcer thread (started by
      # {#start_federation_announcer!}) drives periodic crawl and announcement
      # cycles by submitting tasks onto the pool; individual crawl and announce
      # jobs then run concurrently on pool threads.  The pool is lazily
      # instantiated on first use and is memoized on the Sinatra settings object so
      # that all requests share the same instance.  An +at_exit+ hook
      # ({#ensure_federation_shutdown_hook!}) guarantees the pool drains cleanly on
      # process termination even when the announcer thread is still alive.
      #
      # @return [PotatoMesh::App::WorkerPool, nil] active worker pool if created.
      def ensure_federation_worker_pool!
        return nil unless federation_enabled?
        return nil if federation_shutdown_requested?

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
        application = is_a?(Class) ? self : self.class
        return application.ensure_federation_shutdown_hook! unless application.equal?(self)

        installed = if respond_to?(:settings) && settings.respond_to?(:federation_shutdown_hook_installed)
            settings.federation_shutdown_hook_installed
          else
            instance_variable_defined?(:@federation_shutdown_hook_installed) && @federation_shutdown_hook_installed
          end
        return if installed

        if respond_to?(:set) && settings.respond_to?(:federation_shutdown_hook_installed=)
          set(:federation_shutdown_hook_installed, true)
        else
          @federation_shutdown_hook_installed = true
        end

        at_exit do
          begin
            application.shutdown_federation_background_work!(timeout: PotatoMesh::Config.federation_shutdown_timeout_seconds)
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
        # Drain the worker pool first so federation threads blocked in
        # wait_for_federation_tasks unblock promptly instead of waiting
        # for each task's individual timeout to expire.
        shutdown_federation_worker_pool!
        stop_federation_thread!(:initial_federation_thread, timeout: timeout_value)
        stop_federation_thread!(:federation_thread, timeout: timeout_value)
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
    end
  end
end
