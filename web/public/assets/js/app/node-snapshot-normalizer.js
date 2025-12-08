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

import { translateRoleId } from './role-helpers.js';

/**
 * Determine whether the supplied value acts like an object instance.
 *
 * @param {*} value Candidate reference.
 * @returns {boolean} True when the value is non-null and of type ``object``.
 */
function isObject(value) {
  return value != null && typeof value === 'object';
}

/**
 * Convert a raw value into a trimmed string when possible.
 *
 * @param {*} value Candidate value.
 * @returns {string|null} Trimmed string or ``null`` when blank.
 */
function normalizeString(value) {
  if (value == null) return null;
  const str = String(value).trim();
  return str.length === 0 ? null : str;
}

/**
 * Convert a raw role value into a canonical identifier.
 *
 * @param {*} value Raw role candidate from the API or cached snapshots.
 * @returns {string|null} Canonical role string or ``null`` when blank.
 */
function normalizeRole(value) {
  if (value == null) return null;
  const translated = translateRoleId(value);
  return normalizeString(translated);
}

/**
 * Convert a raw value into a finite number when possible.
 *
 * @param {*} value Candidate numeric value.
 * @returns {number|null} Finite number or ``null`` when coercion fails.
 */
function normalizeNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Field alias metadata describing how canonical keys map to alternate names.
 *
 * @type {Array<{keys: Array<string>, normalise?: (value: *) => *}>}
 */
const FIELD_ALIASES = Object.freeze([
  { keys: ['node_id', 'nodeId'], normalise: normalizeString },
  { keys: ['node_num', 'nodeNum', 'num'], normalise: normalizeNumber },
  { keys: ['short_name', 'shortName'], normalise: normalizeString },
  { keys: ['long_name', 'longName'], normalise: normalizeString },
  { keys: ['role'], normalise: normalizeRole },
  { keys: ['hw_model', 'hwModel'], normalise: normalizeString },
  { keys: ['modem_preset', 'modemPreset'], normalise: normalizeString },
  { keys: ['lora_freq', 'loraFreq'], normalise: normalizeNumber },
  { keys: ['battery_level', 'battery', 'batteryLevel'], normalise: normalizeNumber },
  { keys: ['voltage'], normalise: normalizeNumber },
  { keys: ['uptime_seconds', 'uptime', 'uptimeSeconds'], normalise: normalizeNumber },
  { keys: ['channel_utilization', 'channelUtilization', 'channel'], normalise: normalizeNumber },
  { keys: ['air_util_tx', 'airUtilTx', 'airUtil'], normalise: normalizeNumber },
  { keys: ['temperature'], normalise: normalizeNumber },
  { keys: ['relative_humidity', 'relativeHumidity', 'humidity'], normalise: normalizeNumber },
  { keys: ['barometric_pressure', 'barometricPressure', 'pressure'], normalise: normalizeNumber },
  { keys: ['gas_resistance', 'gasResistance'], normalise: normalizeNumber },
  { keys: ['sats_in_view', 'satsInView'], normalise: normalizeNumber },
  { keys: ['snr'], normalise: normalizeNumber },
  { keys: ['last_heard', 'lastHeard'], normalise: normalizeNumber },
  { keys: ['last_seen_iso', 'lastSeenIso'], normalise: normalizeString },
  { keys: ['telemetry_time', 'telemetryTime'], normalise: normalizeNumber },
  { keys: ['position_time', 'positionTime'], normalise: normalizeNumber },
  { keys: ['position_time_iso', 'positionTimeIso'], normalise: normalizeString },
  { keys: ['latitude', 'lat'], normalise: normalizeNumber },
  { keys: ['longitude', 'lon'], normalise: normalizeNumber },
  { keys: ['altitude', 'alt'], normalise: normalizeNumber },
  { keys: ['distance_km', 'distanceKm'], normalise: normalizeNumber },
  { keys: ['precision_bits', 'precisionBits'], normalise: normalizeNumber },
]);

/**
 * Resolve the first usable value amongst the provided alias keys.
 *
 * @param {Object} node Node snapshot inspected for values.
 * @param {{keys: Array<string>, normalise?: Function}} config Alias metadata.
 * @returns {*|null} Normalized value or ``null``.
 */
function resolveAliasValue(node, config) {
  if (!isObject(node)) return null;
  for (const key of config.keys) {
    if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
    const raw = node[key];
    const value = typeof config.normalise === 'function'
      ? config.normalise(raw)
      : raw;
    if (value != null) {
      return value;
    }
  }
  return null;
}

/**
 * Populate alias keys with the supplied value.
 *
 * @param {Object} node Node snapshot mutated in-place.
 * @param {{keys: Array<string>}} config Alias metadata.
 * @param {*} value Canonical value assigned to all aliases.
 * @returns {void}
 */
function assignAliasValue(node, config, value) {
  for (const key of config.keys) {
    node[key] = value;
  }
}

/**
 * Normalise a node snapshot to ensure canonical telemetry and identity fields
 * exist under all supported aliases.
 *
 * @param {*} node Candidate node snapshot.
 * @returns {*} Normalised node snapshot.
 */
export function normalizeNodeSnapshot(node) {
  if (!isObject(node)) {
    return node;
  }
  for (const aliasConfig of FIELD_ALIASES) {
    const value = resolveAliasValue(node, aliasConfig);
    if (value == null) continue;
    assignAliasValue(node, aliasConfig, value);
  }
  return node;
}

/**
 * Apply {@link normalizeNodeSnapshot} to each node in the provided collection.
 *
 * @param {Array<*>} nodes Node collection.
 * @returns {Array<*>} Normalised node collection.
 */
export function normalizeNodeCollection(nodes) {
  if (!Array.isArray(nodes)) {
    return nodes;
  }
  nodes.forEach(node => {
    normalizeNodeSnapshot(node);
  });
  return nodes;
}

export const __testUtils = {
  isObject,
  normalizeString,
  normalizeNumber,
  FIELD_ALIASES,
  resolveAliasValue,
  assignAliasValue,
};
