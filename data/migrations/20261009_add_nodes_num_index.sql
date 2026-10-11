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

-- Index the numeric node id (SPEC SU1): additive index only.
--
-- nodes.num: the Meshtastic node number. A per-id read resolves a numeric
--   reference through it, ingest resolves a decimal sender or recipient
--   through it, and the batch resolver looks up many at once; without the
--   index each lookup scans every node row.
--
-- The web app applies this conditionally at boot (database.rb); this file is
-- the standalone mirror for CLI/manual migration of older installations.

CREATE INDEX IF NOT EXISTS idx_nodes_num ON nodes(num);
