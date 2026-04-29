/*
 * Copyright © 2025-26 l5yth & contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Filter-key helpers used to disambiguate role buttons across protocols.
 *
 * @module main/filter-helpers
 */

import { isMeshcoreProtocol } from '../protocol-helpers.js';
import { getRoleKey } from '../role-helpers.js';

/**
 * Canonical protocol token for use in compound filter keys.
 *
 * Collapses null/absent/unknown protocol values to ``'meshtastic'`` so that
 * pre-protocol legacy records land in the Meshtastic filter bucket.
 *
 * @param {string|null|undefined} protocol Raw protocol value.
 * @returns {'meshtastic'|'meshcore'} Normalised protocol token.
 */
export function normalizeFilterProtocol(protocol) {
  return isMeshcoreProtocol(protocol) ? 'meshcore' : 'meshtastic';
}

/**
 * Build a compound filter key that encodes both protocol and role.
 *
 * Using compound keys avoids collisions between role names that appear in
 * both Meshtastic and MeshCore (e.g. ``SENSOR``, ``REPEATER``).  The filter
 * set stores these keys so that clicking the MeshCore SENSOR button only
 * includes MeshCore SENSOR nodes, not Meshtastic ones.
 *
 * @param {*} role Raw role value from the API.
 * @param {string|null|undefined} protocol Protocol string from the API.
 * @returns {string} Compound key in the form ``"<protocol>:<roleKey>"``.
 */
export function makeRoleFilterKey(role, protocol) {
  return `${normalizeFilterProtocol(protocol)}:${getRoleKey(role)}`;
}
