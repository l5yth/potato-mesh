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
    module DataProcessing
      # Allowed values for the +telemetry_type+ discriminator column.
      VALID_TELEMETRY_TYPES = %w[device environment power air_quality].freeze

      # Half-window (seconds) for the meshcore content-level message dedup
      # in +insert_message+ and the matching one-shot backfill.  Set to
      # roughly 3× the observed relay-retransmit delta (~10 s) so genuine
      # clock skew across co-operating ingestors still collapses, while
      # rapid legitimate re-sends ("ack", "ok", "test") ≥30 s apart remain
      # distinct rows.  See issue #756 and ``CONTRACTS.md`` for rationale.
      #
      # IMPORTANT: widening this value only takes effect at runtime — the
      # one-shot backfill in +PotatoMesh::App::Database+ is frozen at
      # +MESHCORE_CONTENT_DEDUP_BACKFILL_VERSION+.  To re-sweep pre-existing
      # rows that newly fall within an expanded window, bump the backfill
      # version so the migration re-runs on the next deploy.
      MESHCORE_CONTENT_DEDUP_WINDOW_SECONDS = 30

      # Coerce a Ruby boolean into a SQLite integer (1/0) while passing through
      # any other value unchanged. Used when writing boolean node fields.
      #
      # @param value [Boolean, Object] value to coerce.
      # @return [Integer, Object] 1, 0, or the original value.
      def coerce_bool(value)
        case value
        when true then 1
        when false then 0
        else value
        end
      end
    end
  end
end
