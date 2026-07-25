-- Copyright © 2025-26 l5yth & contributors
--
-- Licensed under the Apache License, Version 2.0 (the "License");
-- you may not use this file except in compliance with the License.
-- You may obtain a copy of the License at
--
--     http://www.apache.org/licenses/LICENSE-2.0
--
-- Unless required by applicable law or agreed to in writing, software
-- distributed under the License is distributed on an "AS IS" BASIS,
-- WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
-- See the License for the specific language governing permissions and
-- limitations under the License.

PRAGMA journal_mode=WAL;

-- Per-heartbeat mesh-activity time-series (SPEC MA3).
--
-- Append-only: one row per ingestor heartbeat that carries a `packets` count
-- (the merged RX+TX frames observed since the previous heartbeat, MA1/MA2).
-- Each ingestor's contribution is kept as its own rows rather than pre-summed,
-- so a packets/hour moving average can be computed across time, protocol, and
-- multiple ingestors per protocol (the read-side MAX aggregation, MA4). Rows
-- are pruned by the retention worker on `at`.
CREATE TABLE IF NOT EXISTS ingestor_activity (
  id           INTEGER PRIMARY KEY,
  ingestor_id  TEXT NOT NULL,
  at           INTEGER NOT NULL,
  packets      INTEGER NOT NULL,
  protocol     TEXT NOT NULL DEFAULT 'meshtastic'
);

CREATE INDEX IF NOT EXISTS idx_ingestor_activity_at ON ingestor_activity(at);
CREATE INDEX IF NOT EXISTS idx_ingestor_activity_protocol_at
  ON ingestor_activity(protocol, at);
