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
    lora_preset TEXT,
    lora_frequency TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_rx_time   ON messages(rx_time);
CREATE INDEX IF NOT EXISTS idx_messages_from_id   ON messages(from_id);
CREATE INDEX IF NOT EXISTS idx_messages_to_id     ON messages(to_id);
CREATE INDEX IF NOT EXISTS idx_messages_channel   ON messages(channel);
CREATE INDEX IF NOT EXISTS idx_messages_portnum   ON messages(portnum);
