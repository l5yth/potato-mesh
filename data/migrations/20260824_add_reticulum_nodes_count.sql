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

-- Add the signed Reticulum node count to the federation instances table.
--
-- The v2 announcement canonical form already carried `reticulum_nodes_count`
-- as a signed constant 0, so no signature shape changes here: the column is
-- what lets an instance store and relay a peer's live figure once a Reticulum
-- ingestor is attached (SPEC FS2, S6 as amended by #888).
--
-- Applied automatically at boot by `Database.ensure_schema_upgrades`; this file is the
-- standalone form for operators who migrate out of band.

BEGIN;
ALTER TABLE instances ADD COLUMN reticulum_nodes_count INTEGER;
COMMIT;
