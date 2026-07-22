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

-- MeshCore RF metrics (SPEC RF1-RF3, RF6): additive columns only.
--
-- messages.hops: repeater relays actually travelled (MeshCore path_len with
--   the 255-direct sentinel normalized to 0; Meshtastic hopStart - hopLimit).
--   Distinct from hop_limit, which keeps its remaining-budget semantic.
-- messages.path: MeshCore hop-hash route (lowercase hex, path_hash_size-byte
--   hashes in travel order; last hash = repeater heard directly).
-- nodes.rssi: per-advert reception RSSI (MeshCore RX-log adverts; NULL for
--   Meshtastic, which reports no per-node RSSI).
--
-- The web app applies these conditionally at boot (database.rb); this file is
-- the standalone mirror for CLI/manual migration of older installations.

ALTER TABLE messages ADD COLUMN hops INTEGER;
ALTER TABLE messages ADD COLUMN path TEXT;
ALTER TABLE nodes ADD COLUMN rssi INTEGER;
