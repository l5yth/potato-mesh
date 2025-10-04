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
    device_metrics_json     TEXT,
    environment_metrics_json TEXT,
    local_stats_json        TEXT,
    raw_json                TEXT,
    telemetry_json          TEXT
);

CREATE INDEX IF NOT EXISTS idx_telemetry_rx_time ON telemetry(rx_time);
CREATE INDEX IF NOT EXISTS idx_telemetry_node_id ON telemetry(node_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_time ON telemetry(telemetry_time);
