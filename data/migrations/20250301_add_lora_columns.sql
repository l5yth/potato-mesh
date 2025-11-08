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

-- Extend the nodes and messages tables with LoRa metadata columns.

BEGIN;
ALTER TABLE nodes ADD COLUMN lora_freq INTEGER;
ALTER TABLE nodes ADD COLUMN modem_preset TEXT;
ALTER TABLE messages ADD COLUMN lora_freq INTEGER;
ALTER TABLE messages ADD COLUMN modem_preset TEXT;
ALTER TABLE messages ADD COLUMN channel_name TEXT;
COMMIT;
