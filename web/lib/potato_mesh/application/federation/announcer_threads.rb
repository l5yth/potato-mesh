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
      # Spawn the long-running announcer thread that drives periodic federation
      # broadcasts.
      #
      # @return [Thread, nil] the announcer thread, or nil when federation is disabled.
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
    end
  end
end
