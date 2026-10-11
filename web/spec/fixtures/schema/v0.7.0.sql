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

-- Schema fixture (SPEC SU6): the database a fresh v0.7.0 install created.
-- The DDL is that release's init_db file list, each file verbatim from git
-- without its license header:
-- nodes, messages, positions, telemetry, neighbors, instances, traces, ingestors.
-- The sample rows at the end must survive the boot-time schema upgrade
-- unchanged.

-- data/nodes.sql at v0.7.0

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
  modem_preset       TEXT,
  protocol           TEXT NOT NULL DEFAULT 'meshtastic',
  synthetic          BOOLEAN NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_nodes_last_heard ON nodes(last_heard);
CREATE INDEX IF NOT EXISTS idx_nodes_hw_model  ON nodes(hw_model);
CREATE INDEX IF NOT EXISTS idx_nodes_latlon    ON nodes(latitude, longitude);
CREATE INDEX IF NOT EXISTS idx_nodes_long_name ON nodes(long_name);

-- data/messages.sql at v0.7.0

CREATE TABLE IF NOT EXISTS messages (
    id        INTEGER PRIMARY KEY,
    rx_time   INTEGER NOT NULL,
    rx_iso    TEXT NOT NULL,
    from_id   TEXT,
    to_id     TEXT,
    channel   INTEGER,
    portnum   TEXT,
    text      TEXT,
    encrypted TEXT,
    snr       REAL,
    rssi      INTEGER,
    hop_limit INTEGER,
    lora_freq INTEGER,
    modem_preset TEXT,
    channel_name TEXT,
    reply_id INTEGER,
    emoji TEXT,
    ingestor TEXT,
    protocol TEXT NOT NULL DEFAULT 'meshtastic'
);

CREATE INDEX IF NOT EXISTS idx_messages_rx_time   ON messages(rx_time);
CREATE INDEX IF NOT EXISTS idx_messages_from_id   ON messages(from_id);
CREATE INDEX IF NOT EXISTS idx_messages_to_id     ON messages(to_id);
CREATE INDEX IF NOT EXISTS idx_messages_channel   ON messages(channel);
CREATE INDEX IF NOT EXISTS idx_messages_portnum   ON messages(portnum);
CREATE INDEX IF NOT EXISTS idx_messages_reply_id  ON messages(reply_id);

-- data/positions.sql at v0.7.0

CREATE TABLE IF NOT EXISTS positions (
    id             INTEGER PRIMARY KEY,
    node_id        TEXT,
    node_num       INTEGER,
    rx_time        INTEGER NOT NULL,
    rx_iso         TEXT NOT NULL,
    position_time  INTEGER,
    to_id          TEXT,
    latitude       REAL,
    longitude      REAL,
    altitude       REAL,
    location_source TEXT,
    precision_bits INTEGER,
    sats_in_view   INTEGER,
    pdop           REAL,
    ground_speed   REAL,
    ground_track   REAL,
    snr            REAL,
    rssi           INTEGER,
    hop_limit      INTEGER,
    bitfield       INTEGER,
    payload_b64    TEXT,
    ingestor       TEXT,
    protocol       TEXT NOT NULL DEFAULT 'meshtastic'
);

CREATE INDEX IF NOT EXISTS idx_positions_rx_time ON positions(rx_time);
CREATE INDEX IF NOT EXISTS idx_positions_node_id ON positions(node_id);

-- data/telemetry.sql at v0.7.0

CREATE TABLE IF NOT EXISTS telemetry (
    id                      INTEGER PRIMARY KEY,
    node_id                 TEXT,
    node_num                INTEGER,
    from_id                 TEXT,
    to_id                   TEXT,
    rx_time                 INTEGER NOT NULL,
    rx_iso                  TEXT NOT NULL,
    telemetry_time          INTEGER,
    channel                 INTEGER,
    portnum                 TEXT,
    hop_limit               INTEGER,
    snr                     REAL,
    rssi                    INTEGER,
    bitfield                INTEGER,
    payload_b64             TEXT,
    battery_level           REAL,
    voltage                 REAL,
    channel_utilization     REAL,
    air_util_tx             REAL,
    uptime_seconds          INTEGER,
    temperature             REAL,
    relative_humidity       REAL,
    barometric_pressure     REAL,
    gas_resistance          REAL,
    current                 REAL,
    iaq                     INTEGER,
    distance                REAL,
    lux                     REAL,
    white_lux               REAL,
    ir_lux                  REAL,
    uv_lux                  REAL,
    wind_direction          INTEGER,
    wind_speed              REAL,
    weight                  REAL,
    wind_gust               REAL,
    wind_lull               REAL,
    radiation               REAL,
    rainfall_1h             REAL,
    rainfall_24h            REAL,
    soil_moisture           INTEGER,
    soil_temperature        REAL,
    ingestor                TEXT,
    protocol                TEXT NOT NULL DEFAULT 'meshtastic',
    telemetry_type          TEXT
);

CREATE INDEX IF NOT EXISTS idx_telemetry_rx_time ON telemetry(rx_time);
CREATE INDEX IF NOT EXISTS idx_telemetry_node_id ON telemetry(node_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_time ON telemetry(telemetry_time);

-- data/neighbors.sql at v0.7.0

CREATE TABLE IF NOT EXISTS neighbors (
    node_id     TEXT NOT NULL,
    neighbor_id TEXT NOT NULL,
    snr         REAL,
    rx_time     INTEGER NOT NULL,
    ingestor    TEXT,
    protocol    TEXT NOT NULL DEFAULT 'meshtastic',
    PRIMARY KEY (node_id, neighbor_id),
    FOREIGN KEY (node_id) REFERENCES nodes(node_id) ON DELETE CASCADE,
    FOREIGN KEY (neighbor_id) REFERENCES nodes(node_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_neighbors_rx_time ON neighbors(rx_time);
CREATE INDEX IF NOT EXISTS idx_neighbors_neighbor_id ON neighbors(neighbor_id);

-- data/instances.sql at v0.7.0

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
  nodes_count       INTEGER,
  meshcore_nodes_count   INTEGER,
  meshtastic_nodes_count INTEGER,
  contact_link      TEXT,
  signature         TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_instances_domain ON instances(domain);

-- data/traces.sql at v0.7.0

CREATE TABLE IF NOT EXISTS traces (
    id          INTEGER PRIMARY KEY,
    request_id  INTEGER,
    src         INTEGER,
    dest        INTEGER,
    rx_time     INTEGER NOT NULL,
    rx_iso      TEXT NOT NULL,
    rssi        INTEGER,
    snr         REAL,
    elapsed_ms  INTEGER,
    ingestor    TEXT,
    protocol    TEXT NOT NULL DEFAULT 'meshtastic'
);

CREATE TABLE IF NOT EXISTS trace_hops (
    id         INTEGER PRIMARY KEY,
    trace_id   INTEGER NOT NULL,
    hop_index  INTEGER NOT NULL,
    node_id    INTEGER NOT NULL,
    FOREIGN KEY(trace_id) REFERENCES traces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_traces_rx_time ON traces(rx_time);
CREATE INDEX IF NOT EXISTS idx_traces_request ON traces(request_id);
CREATE INDEX IF NOT EXISTS idx_trace_hops_trace ON trace_hops(trace_id);
CREATE INDEX IF NOT EXISTS idx_trace_hops_node ON trace_hops(node_id);

-- data/ingestors.sql at v0.7.0

PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS ingestors (
  node_id        TEXT PRIMARY KEY,
  start_time     INTEGER NOT NULL,
  last_seen_time INTEGER NOT NULL,
  version        TEXT,
  lora_freq      INTEGER,
  modem_preset   TEXT,
  protocol       TEXT NOT NULL DEFAULT 'meshtastic'
);

CREATE INDEX IF NOT EXISTS idx_ingestors_last_seen ON ingestors(last_seen_time);

-- Sample rows.

INSERT INTO nodes(node_id, num, short_name, long_name, hw_model, role, snr, last_heard, first_heard, precision_bits, latitude, longitude, altitude, lora_freq, modem_preset, protocol, synthetic)
  VALUES ('!a1b2c3d4', 2712847316, 'A1B2', 'Legacy Alpha', 'TBEAM', 'CLIENT', 6.5, 1735689600, 1735600000, 13, 52.52, 13.405, 34.0, 868, 'LongFast', 'meshtastic', 0);
INSERT INTO nodes(node_id, num, short_name, long_name, hw_model, role, snr, last_heard, first_heard, protocol, synthetic)
  VALUES ('!0badc0de', 195936478, 'BADC', 'Legacy Bravo', 'HELTEC_V3', 'ROUTER', -3.25, 1735689000, 1735500000, 'meshtastic', 0);
INSERT INTO nodes(node_id, num, short_name, long_name, role, last_heard, first_heard, protocol, synthetic)
  VALUES ('!5e7c0a11', 1585187345, '5E7C', 'Harbour Repeater', 'REPEATER', 1735689500, 1735400000, 'meshcore', 0);
INSERT INTO messages(id, rx_time, rx_iso, from_id, to_id, channel, portnum, text, snr, rssi, hop_limit, lora_freq, modem_preset, channel_name, reply_id, emoji, ingestor, protocol)
  VALUES (1001, 1735689600, '2025-01-01T00:00:00Z', '!a1b2c3d4', '^all', 0, 'TEXT_MESSAGE_APP', 'hello from v0.7.0', -7.5, -92, 3, 868, 'LongFast', 'LongFast', NULL, NULL, '!0000beef', 'meshtastic');
INSERT INTO messages(id, rx_time, rx_iso, from_id, to_id, channel, portnum, text, snr, rssi, hop_limit, reply_id, emoji, ingestor, protocol)
  VALUES (1002, 1735689660, '2025-01-01T00:01:00Z', '!0badc0de', '^all', 0, 'TEXT_MESSAGE_APP', NULL, 5.25, -80, 2, 1001, '👍', '!0000beef', 'meshtastic');
INSERT INTO messages(id, rx_time, rx_iso, from_id, to_id, channel, text, channel_name, ingestor, protocol)
  VALUES (1003, 1735689700, '2025-01-01T00:01:40Z', '!5e7c0a11', '^all', 0, 'Harbour Repeater: tide is high', '#public', '!0000cafe', 'meshcore');
INSERT INTO positions(id, node_id, node_num, rx_time, rx_iso, position_time, to_id, latitude, longitude, altitude, location_source, precision_bits, sats_in_view, snr, rssi, hop_limit, ingestor, protocol)
  VALUES (2001, '!a1b2c3d4', 2712847316, 1735689700, '2025-01-01T00:01:40Z', 1735689690, '^all', 52.52, 13.405, 34.0, 'LOC_INTERNAL', 13, 7, 6.5, -91, 3, '!0000beef', 'meshtastic');
INSERT INTO telemetry(id, node_id, node_num, from_id, to_id, rx_time, rx_iso, telemetry_time, channel, portnum, hop_limit, snr, rssi, battery_level, voltage, channel_utilization, air_util_tx, uptime_seconds, temperature, lux, ingestor, protocol, telemetry_type)
  VALUES (3001, '!a1b2c3d4', 2712847316, '!a1b2c3d4', '^all', 1735689800, '2025-01-01T00:03:20Z', 1735689795, 0, 'TELEMETRY_APP', 3, 6.0, -90, 87.0, 4.05, 12.5, 1.25, 86400, NULL, NULL, '!0000beef', 'meshtastic', 'device');
INSERT INTO neighbors(node_id, neighbor_id, snr, rx_time, ingestor, protocol)
  VALUES ('!a1b2c3d4', '!0badc0de', 4.5, 1735689900, '!0000beef', 'meshtastic');
INSERT INTO instances(id, domain, pubkey, name, version, channel, frequency, latitude, longitude, last_update_time, is_private, nodes_count, meshcore_nodes_count, meshtastic_nodes_count, contact_link, signature)
  VALUES ('3f6c2a', 'peer.example.test', 'PUBKEY-PEM', 'Peer Mesh', 'v0.7.0', 'LongFast', '868', 50.0, 8.0, 1735689600, 0, 12, 2, 10, NULL, 'c2lnbmF0dXJl');
INSERT INTO traces(id, request_id, src, dest, rx_time, rx_iso, rssi, snr, elapsed_ms, ingestor, protocol)
  VALUES (4001, 77, 2712847316, 195936478, 1735690000, '2025-01-01T00:06:40Z', -95, 3.5, 1200, '!0000beef', 'meshtastic');
INSERT INTO trace_hops(id, trace_id, hop_index, node_id) VALUES (1, 4001, 0, 2712847316);
INSERT INTO trace_hops(id, trace_id, hop_index, node_id) VALUES (2, 4001, 1, 195936478);
INSERT INTO ingestors(node_id, start_time, last_seen_time, version, lora_freq, modem_preset, protocol)
  VALUES ('!0000beef', 1735600000, 1735690000, 'v0.7.0', 868, 'LongFast', 'meshtastic');
