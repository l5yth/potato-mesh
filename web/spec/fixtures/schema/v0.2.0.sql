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

-- Schema fixture (SPEC SU6): the database a fresh v0.2.0 install created.
-- The DDL is that release's init_db file list, each file verbatim from git
-- without its license header:
-- nodes, messages.
-- The sample rows at the end must survive the boot-time schema upgrade
-- unchanged.

-- data/nodes.sql at v0.2.0

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
  latitude           REAL,
  longitude          REAL,
  altitude           REAL
);

CREATE INDEX IF NOT EXISTS idx_nodes_last_heard ON nodes(last_heard);
CREATE INDEX IF NOT EXISTS idx_nodes_hw_model  ON nodes(hw_model);
CREATE INDEX IF NOT EXISTS idx_nodes_latlon    ON nodes(latitude, longitude);

-- data/messages.sql at v0.2.0

CREATE TABLE IF NOT EXISTS messages (
    id        INTEGER PRIMARY KEY,
    rx_time   INTEGER NOT NULL,
    rx_iso    TEXT NOT NULL,
    from_id   TEXT,
    to_id     TEXT,
    channel   INTEGER,
    portnum   TEXT,
    text      TEXT,
    snr       REAL,
    rssi      INTEGER,
    hop_limit INTEGER,
    raw_json  TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_rx_time   ON messages(rx_time);
CREATE INDEX IF NOT EXISTS idx_messages_from_id   ON messages(from_id);
CREATE INDEX IF NOT EXISTS idx_messages_to_id     ON messages(to_id);
CREATE INDEX IF NOT EXISTS idx_messages_channel   ON messages(channel);
CREATE INDEX IF NOT EXISTS idx_messages_portnum   ON messages(portnum);

-- Sample rows.

INSERT INTO nodes(node_id, num, short_name, long_name, hw_model, role, snr, last_heard, first_heard, latitude, longitude, altitude)
  VALUES ('!a1b2c3d4', 2712847316, 'A1B2', 'Legacy Alpha', 'TBEAM', 'CLIENT', 6.5, 1735689600, 1735600000, 52.52, 13.405, 34.0);
INSERT INTO nodes(node_id, num, short_name, long_name, hw_model, role, snr, last_heard, first_heard)
  VALUES ('!0badc0de', 195936478, 'BADC', 'Legacy Bravo', 'HELTEC_V3', 'ROUTER', -3.25, 1735689000, 1735500000);
INSERT INTO messages(id, rx_time, rx_iso, from_id, to_id, channel, portnum, text, snr, rssi, hop_limit, raw_json)
  VALUES (1001, 1735689600, '2025-01-01T00:00:00Z', '!a1b2c3d4', '^all', 0, 'TEXT_MESSAGE_APP', 'hello from v0.2.0', -7.5, -92, 3, '{"id":1001}');
INSERT INTO messages(id, rx_time, rx_iso, from_id, to_id, channel, portnum, text, snr, rssi, hop_limit)
  VALUES (1002, 1735689660, '2025-01-01T00:01:00Z', '!0badc0de', '!a1b2c3d4', 0, 'TEXT_MESSAGE_APP', 'direct reply', 5.25, -80, 2);
