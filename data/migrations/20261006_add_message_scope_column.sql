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

-- MeshCore message flood scope (SPEC SC4/SC5, #765): additive column only.
--
-- messages.scope: the region a MeshCore channel message was flooded to, as
--   the ingestor resolved it from the delivered RX-log copy: the region name
--   without its '#', '*' for a plain unscoped flood, or the reserved '?' for
--   a scoped flood whose region the ingestor cannot name. NULL when no copy
--   was logged, for legacy rows and for other protocols. A later copy of the
--   same message fills a NULL scope and names a stored '?'; a stored name or
--   '*' is never overwritten.
--
-- The web app applies this conditionally at boot (database.rb); this file is
-- the standalone mirror for CLI/manual migration of older installations.

ALTER TABLE messages ADD COLUMN scope TEXT;
