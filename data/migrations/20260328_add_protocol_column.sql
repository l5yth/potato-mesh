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

-- Add a protocol column to every entity and event table so records from
-- different mesh backends (meshtastic, meshcore, reticulum, …) can co-exist
-- in the same database and be queried independently.
--
-- Existing rows default to 'meshtastic' for backward compatibility.

BEGIN;
ALTER TABLE ingestors ADD COLUMN protocol TEXT NOT NULL DEFAULT 'meshtastic';
ALTER TABLE nodes     ADD COLUMN protocol TEXT NOT NULL DEFAULT 'meshtastic';
ALTER TABLE messages  ADD COLUMN protocol TEXT NOT NULL DEFAULT 'meshtastic';
ALTER TABLE positions ADD COLUMN protocol TEXT NOT NULL DEFAULT 'meshtastic';
ALTER TABLE telemetry ADD COLUMN protocol TEXT NOT NULL DEFAULT 'meshtastic';
ALTER TABLE traces    ADD COLUMN protocol TEXT NOT NULL DEFAULT 'meshtastic';
ALTER TABLE neighbors ADD COLUMN protocol TEXT NOT NULL DEFAULT 'meshtastic';

-- Indices to support ?protocol= filtering on every entity endpoint without
-- full table scans as multi-protocol traffic grows.
CREATE INDEX IF NOT EXISTS idx_ingestors_protocol ON ingestors(protocol);
CREATE INDEX IF NOT EXISTS idx_nodes_protocol     ON nodes(protocol);
CREATE INDEX IF NOT EXISTS idx_messages_protocol  ON messages(protocol);
CREATE INDEX IF NOT EXISTS idx_positions_protocol ON positions(protocol);
CREATE INDEX IF NOT EXISTS idx_telemetry_protocol ON telemetry(protocol);
CREATE INDEX IF NOT EXISTS idx_traces_protocol    ON traces(protocol);
CREATE INDEX IF NOT EXISTS idx_neighbors_protocol ON neighbors(protocol);
COMMIT;
