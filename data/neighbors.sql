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

CREATE TABLE IF NOT EXISTS neighbors (
    id                               INTEGER PRIMARY KEY,
    rx_time                          INTEGER NOT NULL,
    rx_iso                           TEXT NOT NULL,
    from_id                          TEXT,
    to_id                            TEXT,
    node_id                          TEXT,
    last_sent_by_id                  TEXT,
    node_broadcast_interval_secs     INTEGER,
    hop_limit                        INTEGER,
    snr                              REAL,
    rssi                             INTEGER,
    bitfield                         INTEGER
);

CREATE INDEX IF NOT EXISTS idx_neighbors_rx_time ON neighbors(rx_time);
CREATE INDEX IF NOT EXISTS idx_neighbors_node_id ON neighbors(node_id);

CREATE TABLE IF NOT EXISTS neighbor_peers (
    neighbor_id   INTEGER NOT NULL,
    node_id       TEXT,
    node_num      INTEGER,
    last_heard    INTEGER,
    last_heard_iso TEXT,
    rssi          INTEGER,
    snr           REAL,
    PRIMARY KEY (neighbor_id, node_id, node_num),
    FOREIGN KEY (neighbor_id) REFERENCES neighbors(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_neighbor_peers_neighbor_id ON neighbor_peers(neighbor_id);
CREATE INDEX IF NOT EXISTS idx_neighbor_peers_node_id ON neighbor_peers(node_id);
