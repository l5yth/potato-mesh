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

CREATE TABLE IF NOT EXISTS neighbor_snapshots (
  node_id                   TEXT PRIMARY KEY,
  last_sent_by_id           TEXT,
  broadcast_interval_secs   INTEGER,
  rx_time                   INTEGER NOT NULL,
  rx_iso                    TEXT NOT NULL,
  rx_snr                    REAL,
  rx_rssi                   INTEGER,
  hop_limit                 INTEGER,
  hop_start                 INTEGER,
  relay_node                INTEGER,
  transport_mechanism       TEXT
);

CREATE TABLE IF NOT EXISTS neighbor_links (
  node_id     TEXT NOT NULL,
  neighbor_id TEXT NOT NULL,
  snr         REAL,
  rx_time     INTEGER NOT NULL,
  PRIMARY KEY (node_id, neighbor_id),
  FOREIGN KEY (node_id) REFERENCES neighbor_snapshots(node_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_neighbor_links_neighbor ON neighbor_links(neighbor_id);
CREATE INDEX IF NOT EXISTS idx_neighbor_links_rx_time ON neighbor_links(rx_time);
