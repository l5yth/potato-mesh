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

      # Count the number of nodes for a specific protocol active since the
      # supplied timestamp.
      #
      # @param cutoff [Integer] unix timestamp in seconds.
      # @param protocol [String] protocol name (e.g. "meshcore", "meshtastic").
      # @param db [SQLite3::Database, nil] optional open handle to reuse.
      # @return [Integer, nil] node count or nil when unavailable.
      def active_node_count_since_for_protocol(cutoff, protocol, db: nil)
        return nil unless cutoff && protocol

        handle = db || open_database(readonly: true)
        count =
          with_busy_retry do
            handle.get_first_value(
              "SELECT COUNT(*) FROM nodes WHERE last_heard >= ? AND protocol = ?",
              cutoff.to_i,
              protocol,
            )
          end
        Integer(count)
      rescue SQLite3::Exception, ArgumentError => e
        warn_log(
          "Failed to count active nodes for protocol",
          context: "instances.protocol_nodes_count",
          protocol: protocol,
          error_class: e.class.name,
          error_message: e.message,
        )
        nil
      ensure
        handle&.close unless db
      end
    end
  end
end
