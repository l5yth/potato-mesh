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

CREATE TABLE IF NOT EXISTS ingestors (
  id                TEXT PRIMARY KEY,
  api_key           TEXT NOT NULL UNIQUE,
  name              TEXT,
  node_id           TEXT,
  contact_email     TEXT,
  contact_matrix    TEXT,
  version           TEXT,
  last_request_time INTEGER,
  request_count     INTEGER DEFAULT 0,
  created_at        INTEGER NOT NULL,
  is_active         BOOLEAN NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ingestors_api_key ON ingestors(api_key);
CREATE INDEX IF NOT EXISTS idx_ingestors_node_id ON ingestors(node_id);
CREATE INDEX IF NOT EXISTS idx_ingestors_is_active ON ingestors(is_active);
