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
    module Helpers
      # Emit a structured debug log entry tagged with the calling context.
      #
      # @param message [String] text to emit.
      # @param context [String] logical source of the message.
      # @param metadata [Hash] additional structured key/value data.
      # @return [void]
      def debug_log(message, context: "app", **metadata)
        logger = PotatoMesh::Logging.logger_for(self)
        PotatoMesh::Logging.log(logger, :debug, message, context: context, **metadata)
      end

      # Emit a structured warning log entry tagged with the calling context.
      #
      # @param message [String] text to emit.
      # @param context [String] logical source of the message.
      # @param metadata [Hash] additional structured key/value data.
      # @return [void]
      def warn_log(message, context: "app", **metadata)
        logger = PotatoMesh::Logging.logger_for(self)
        PotatoMesh::Logging.log(logger, :warn, message, context: context, **metadata)
      end
    end
  end
end
