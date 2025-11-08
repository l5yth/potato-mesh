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
    payload_b64    TEXT
);

CREATE INDEX IF NOT EXISTS idx_positions_rx_time ON positions(rx_time);
CREATE INDEX IF NOT EXISTS idx_positions_node_id ON positions(node_id);
