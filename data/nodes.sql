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

CREATE TABLE IF NOT EXISTS nodes (
  node_id            TEXT PRIMARY KEY,
  num                INTEGER,
  short_name         TEXT,
  long_name          TEXT,
  macaddr            TEXT,
  hw_model           TEXT,
  role               TEXT,
  public_key         TEXT,
  is_unmessagable    BOOLEAN,
  is_favorite        BOOLEAN,
  hops_away          INTEGER,
  snr                REAL,
  last_heard         INTEGER,
  first_heard        INTEGER,
  battery_level      REAL,
  voltage            REAL,
  channel_utilization REAL,
  air_util_tx        REAL,
  uptime_seconds     INTEGER,
  position_time      INTEGER,
  location_source    TEXT,
  precision_bits     INTEGER,
  latitude           REAL,
  longitude          REAL,
  altitude           REAL,
  lora_freq          INTEGER,
  modem_preset       TEXT
);

CREATE INDEX IF NOT EXISTS idx_nodes_last_heard ON nodes(last_heard);
CREATE INDEX IF NOT EXISTS idx_nodes_hw_model  ON nodes(hw_model);
CREATE INDEX IF NOT EXISTS idx_nodes_latlon    ON nodes(latitude, longitude);
