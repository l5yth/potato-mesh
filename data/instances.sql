-- Copyright (C) 2025 l5yth
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

CREATE TABLE IF NOT EXISTS instances (
  id                TEXT PRIMARY KEY,
  domain            TEXT NOT NULL,
  pubkey            TEXT NOT NULL,
  name              TEXT,
  version           TEXT,
  channel           TEXT,
  frequency         TEXT,
  latitude          REAL,
  longitude         REAL,
  last_update_time  INTEGER,
  is_private        BOOLEAN NOT NULL DEFAULT 0,
  signature         TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_instances_domain ON instances(domain);
