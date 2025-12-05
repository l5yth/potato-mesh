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
    # Database cleanup utilities for removing stale or incomplete records.
    module Cleanup
      # Remove nodes that appear incomplete and have not been updated recently.
      #
      # Nodes are considered incomplete when they retain the default Meshtastic
      # name prefix (e.g., "Meshtastic 1234") and lack hardware model data.
      # These entries typically result from brief mesh contacts that never
      # exchanged full node information.
      #
      # @param cutoff_time [Integer] Unix timestamp threshold; nodes older than
      #   this are eligible for removal.
      # @return [Integer] count of nodes deleted.
      def prune_stale_nodes(cutoff_time = nil)
        cutoff_time ||= Time.now.to_i - PotatoMesh::Config.stale_node_min_age
        db = open_database

        sql = <<~SQL
          DELETE FROM nodes
          WHERE long_name LIKE 'Meshtastic%'
            AND (hw_model IS NULL OR hw_model = '')
            AND last_heard < ?
        SQL

        deleted_count = 0
        with_busy_retry do
          db.execute(sql, [cutoff_time])
          deleted_count = db.changes
        end

        if deleted_count.positive?
          info_log(
            "Pruned stale nodes",
            context: "cleanup.nodes",
            count: deleted_count,
            cutoff: cutoff_time,
          )
        else
          debug_log(
            "No stale nodes to prune",
            context: "cleanup.nodes",
            cutoff: cutoff_time,
          )
        end

        deleted_count
      rescue SQLite3::Exception => e
        warn_log(
          "Failed to prune stale nodes",
          context: "cleanup.nodes",
          error_class: e.class.name,
          error_message: e.message,
        )
        0
      ensure
        db&.close
      end

      # Execute the stale node cleanup loop once.
      #
      # @return [Integer] number of nodes removed.
      def run_stale_node_cleanup
        prune_stale_nodes
      end

      # Launch a background thread responsible for periodic node cleanup.
      #
      # @return [Thread, nil] the thread handling cleanup, or nil when disabled.
      def start_stale_node_cleanup_thread!
        return nil unless PotatoMesh::Config.stale_node_cleanup_enabled?

        existing = settings.respond_to?(:stale_node_cleanup_thread) ? settings.stale_node_cleanup_thread : nil
        return existing if existing&.alive?

        thread = Thread.new do
          loop do
            sleep PotatoMesh::Config.stale_node_cleanup_interval
            begin
              run_stale_node_cleanup
            rescue StandardError => e
              warn_log(
                "Stale node cleanup loop error",
                context: "cleanup.nodes",
                error_class: e.class.name,
                error_message: e.message,
              )
            end
          end
        end
        thread.name = "potato-mesh-node-cleanup" if thread.respond_to?(:name=)
        set(:stale_node_cleanup_thread, thread)
        thread
      end

      # Halt the background cleanup thread if currently running.
      #
      # @return [void]
      def stop_stale_node_cleanup_thread!
        return unless settings.respond_to?(:stale_node_cleanup_thread)

        thread = settings.stale_node_cleanup_thread
        return unless thread&.alive?

        thread.kill
        thread.join(2)
        set(:stale_node_cleanup_thread, nil)
      end
    end
  end
end
