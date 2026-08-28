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


-- Destinations a node announces on.
--
-- Reticulum identifies a peer by an identity, and that identity announces on
-- several destinations -- one per aspect (lxmf.delivery, nomadnetwork.node,
-- lxmf.propagation) -- each with its own display name and implied role. Those
-- are distinct things, so each gets its own row here and its own `nodes` row
-- (SPEC RE-A5); `nodes.identity_hash` is what groups them back into one peer.
--
-- Protocols whose nodes have exactly one destination simply never populate it.

PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS destinations (
  id             TEXT PRIMARY KEY,
  node_id        TEXT NOT NULL,
  identity_hash  TEXT,
  name           TEXT,
  aspect         TEXT,
  role           TEXT,
  interface      TEXT,
  first_heard    INTEGER,
  last_heard     INTEGER,
  protocol       TEXT NOT NULL DEFAULT 'reticulum'
);

CREATE INDEX IF NOT EXISTS idx_destinations_node_id ON destinations(node_id);
CREATE INDEX IF NOT EXISTS idx_destinations_identity ON destinations(identity_hash);
CREATE INDEX IF NOT EXISTS idx_destinations_last_heard ON destinations(last_heard);
