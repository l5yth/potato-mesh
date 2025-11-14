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

import { extractModemMetadata } from './node-modem-metadata.js';
import { normalizeNodeSnapshot } from './node-snapshot-normalizer.js';
import {
  SNAPSHOT_WINDOW,
  aggregateNeighborSnapshots,
  aggregateNodeSnapshots,
  aggregatePositionSnapshots,
  aggregateTelemetrySnapshots,
} from './snapshot-aggregator.js';

const DEFAULT_FETCH_OPTIONS = Object.freeze({ cache: 'no-store' });
const TELEMETRY_LIMIT = 1000;
const POSITION_LIMIT = SNAPSHOT_WINDOW;
const NEIGHBOR_LIMIT = 1000;

/**
 * Determine whether the supplied value behaves like a plain object.
 *
 * @param {*} value Candidate value.
 * @returns {boolean} True when ``value`` is an object instance.
 */
function isObject(value) {
  return value != null && typeof value === 'object';
}

/**
 * Convert a candidate value into a trimmed string representation.
 *
 * @param {*} value Raw value from an API payload.
 * @returns {string|null} Trimmed string or ``null`` when blank.
 */
function toTrimmedString(value) {
  if (value == null) return null;
  const str = String(value).trim();
  return str.length === 0 ? null : str;
}

/**
 * Coerce a candidate value to a finite number when possible.
 *
 * @param {*} value Raw value from an API payload.
 * @returns {number|null} Finite number or ``null`` when coercion fails.
 */
function toFiniteNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (value == null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/**
 * Extract the first non-empty string associated with one of the provided keys.
 *
 * @param {Object} record Source record inspected for values.
 * @param {Array<string>} keys Candidate property names.
 * @returns {string|null} First non-empty string or ``null``.
 */
function extractString(record, keys) {
  if (!isObject(record)) return null;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    const value = toTrimmedString(record[key]);
    if (value != null) return value;
  }
  return null;
}

/**
 * Extract the first finite number associated with the provided keys.
 *
 * @param {Object} record Source record inspected for values.
 * @param {Array<string>} keys Candidate property names.
 * @returns {number|null} First finite number or ``null``.
 */
function extractNumber(record, keys) {
  if (!isObject(record)) return null;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    const value = toFiniteNumber(record[key]);
    if (value != null) return value;
  }
  return null;
}

/**
 * Assign a string property when the supplied value is present.
 *
 * @param {Object} target Destination object mutated with the value.
 * @param {string} key Property name to assign.
 * @param {*} value Raw value to assign.
 * @param {Object} [options] Behaviour modifiers.
 * @param {boolean} [options.preferExisting=false] When true, only assign when the target lacks a value.
 * @returns {void}
 */
function assignString(target, key, value, { preferExisting = false } = {}) {
  const stringValue = toTrimmedString(value);
  if (stringValue == null) return;
  if (preferExisting) {
    const existing = toTrimmedString(target[key]);
    if (existing != null) return;
  }
  target[key] = stringValue;
}

/**
 * Assign a numeric property when the supplied value parses successfully.
 *
 * @param {Object} target Destination object mutated with the value.
 * @param {string} key Property name to assign.
 * @param {*} value Raw value to assign.
 * @param {Object} [options] Behaviour modifiers.
 * @param {boolean} [options.preferExisting=false] When true, only assign when the target lacks a value.
 * @returns {void}
 */
function assignNumber(target, key, value, { preferExisting = false } = {}) {
  const numericValue = toFiniteNumber(value);
  if (numericValue == null) return;
  if (preferExisting) {
    const existing = toFiniteNumber(target[key]);
    if (existing != null) return;
  }
  target[key] = numericValue;
}

/**
 * Merge modem preset and frequency metadata into the aggregate node object.
 *
 * @param {Object} target Mutable aggregate node reference.
 * @param {*} source Source record inspected for modem attributes.
 * @param {{ preferExisting?: boolean }} [options] Behaviour modifiers.
 * @returns {void}
 */
function mergeModemMetadata(target, source, { preferExisting = false } = {}) {
  if (!isObject(target)) return;
  if (!source || typeof source !== 'object') return;
  const metadata = extractModemMetadata(source);
  if (metadata.modemPreset) {
    if (!preferExisting || toTrimmedString(target.modemPreset) == null) {
      target.modemPreset = metadata.modemPreset;
    }
  }
  if (metadata.loraFreq != null) {
    if (!preferExisting || toFiniteNumber(target.loraFreq) == null) {
      target.loraFreq = metadata.loraFreq;
    }
  }
}

/**
 * Merge base node fields from an arbitrary record into the aggregate node object.
 *
 * @param {Object} target Mutable aggregate node reference.
 * @param {Object} record Source record providing base attributes.
 * @returns {void}
 */
function mergeNodeFields(target, record) {
  if (!isObject(record)) return;
  assignString(target, 'nodeId', extractString(record, ['nodeId', 'node_id']));
  assignNumber(target, 'nodeNum', extractNumber(record, ['nodeNum', 'node_num', 'num']));
  assignString(target, 'shortName', extractString(record, ['shortName', 'short_name']));
  assignString(target, 'longName', extractString(record, ['longName', 'long_name']));
  assignString(target, 'role', extractString(record, ['role']));
  assignString(target, 'hwModel', extractString(record, ['hwModel', 'hw_model']));
  mergeModemMetadata(target, record);
  assignNumber(target, 'snr', extractNumber(record, ['snr']));
  assignNumber(target, 'battery', extractNumber(record, ['battery', 'battery_level', 'batteryLevel']));
  assignNumber(target, 'voltage', extractNumber(record, ['voltage']));
  assignNumber(target, 'uptime', extractNumber(record, ['uptime', 'uptime_seconds', 'uptimeSeconds']));
  assignNumber(target, 'channel', extractNumber(record, ['channel_utilization', 'channelUtilization', 'channel']));
  assignNumber(target, 'airUtil', extractNumber(record, ['airUtil', 'air_util_tx', 'airUtilTx']));
  assignNumber(target, 'temperature', extractNumber(record, ['temperature']));
  assignNumber(target, 'humidity', extractNumber(record, ['humidity', 'relative_humidity', 'relativeHumidity']));
  assignNumber(target, 'pressure', extractNumber(record, ['pressure', 'barometric_pressure', 'barometricPressure']));
  assignNumber(target, 'lastHeard', extractNumber(record, ['lastHeard', 'last_heard']));
  assignString(target, 'lastSeenIso', extractString(record, ['lastSeenIso', 'last_seen_iso']));
  assignNumber(target, 'positionTime', extractNumber(record, ['position_time', 'positionTime']));
  assignString(target, 'positionTimeIso', extractString(record, ['position_time_iso', 'positionTimeIso']));
  assignNumber(target, 'telemetryTime', extractNumber(record, ['telemetry_time', 'telemetryTime']));
  assignNumber(target, 'latitude', extractNumber(record, ['latitude']));
  assignNumber(target, 'longitude', extractNumber(record, ['longitude']));
  assignNumber(target, 'altitude', extractNumber(record, ['altitude']));
}

/**
 * Merge telemetry metrics into the aggregate node object when missing.
 *
 * @param {Object} target Mutable aggregate node reference.
 * @param {Object} telemetry Telemetry record returned by the API.
 * @returns {void}
 */
function mergeTelemetry(target, telemetry) {
  if (!isObject(telemetry)) return;
  target.telemetry = telemetry;
  assignString(target, 'nodeId', extractString(telemetry, ['node_id', 'nodeId']), { preferExisting: true });
  assignNumber(target, 'nodeNum', extractNumber(telemetry, ['node_num', 'nodeNum']), { preferExisting: true });
  mergeModemMetadata(target, telemetry, { preferExisting: true });
  assignNumber(target, 'battery', extractNumber(telemetry, ['battery_level', 'batteryLevel']), { preferExisting: true });
  assignNumber(target, 'voltage', extractNumber(telemetry, ['voltage']), { preferExisting: true });
  assignNumber(target, 'uptime', extractNumber(telemetry, ['uptime_seconds', 'uptimeSeconds']), { preferExisting: true });
  assignNumber(target, 'channel', extractNumber(telemetry, ['channel_utilization', 'channelUtilization', 'channel']), { preferExisting: true });
  assignNumber(target, 'airUtil', extractNumber(telemetry, ['air_util_tx', 'airUtilTx', 'airUtil']), { preferExisting: true });
  assignNumber(target, 'temperature', extractNumber(telemetry, ['temperature']), { preferExisting: true });
  assignNumber(target, 'humidity', extractNumber(telemetry, ['relative_humidity', 'relativeHumidity', 'humidity']), { preferExisting: true });
  assignNumber(target, 'pressure', extractNumber(telemetry, ['barometric_pressure', 'barometricPressure', 'pressure']), { preferExisting: true });

  const telemetryTime = extractNumber(telemetry, ['telemetry_time', 'telemetryTime']);
  if (telemetryTime != null) {
    const existingTelemetryTime = toFiniteNumber(target.telemetryTime);
    if (existingTelemetryTime == null || telemetryTime > existingTelemetryTime) {
      target.telemetryTime = telemetryTime;
    }
  }

  const rxTime = extractNumber(telemetry, ['rx_time', 'rxTime']);
  if (rxTime != null) {
    const existingLastHeard = toFiniteNumber(target.lastHeard);
    if (existingLastHeard == null || rxTime > existingLastHeard) {
      target.lastHeard = rxTime;
      assignString(target, 'lastSeenIso', extractString(telemetry, ['rx_iso', 'rxIso']));
    } else {
      assignString(target, 'lastSeenIso', extractString(telemetry, ['rx_iso', 'rxIso']), { preferExisting: true });
    }
  }
}

/**
 * Merge position data into the aggregate node object when missing.
 *
 * @param {Object} target Mutable aggregate node reference.
 * @param {Object} position Position record returned by the API.
 * @returns {void}
 */
function mergePosition(target, position) {
  if (!isObject(position)) return;
  target.position = position;
  assignString(target, 'nodeId', extractString(position, ['node_id', 'nodeId']), { preferExisting: true });
  assignNumber(target, 'nodeNum', extractNumber(position, ['node_num', 'nodeNum']), { preferExisting: true });
  assignNumber(target, 'latitude', extractNumber(position, ['latitude']), { preferExisting: true });
  assignNumber(target, 'longitude', extractNumber(position, ['longitude']), { preferExisting: true });
  assignNumber(target, 'altitude', extractNumber(position, ['altitude']), { preferExisting: true });

  const positionTime = extractNumber(position, ['position_time', 'positionTime']);
  if (positionTime != null) {
    const existingPositionTime = toFiniteNumber(target.positionTime);
    if (existingPositionTime == null || positionTime > existingPositionTime) {
      target.positionTime = positionTime;
      assignString(target, 'positionTimeIso', extractString(position, ['position_time_iso', 'positionTimeIso']));
    } else {
      assignString(target, 'positionTimeIso', extractString(position, ['position_time_iso', 'positionTimeIso']), { preferExisting: true });
    }
  }

  const rxTime = extractNumber(position, ['rx_time', 'rxTime']);
  if (rxTime != null) {
    const existingLastHeard = toFiniteNumber(target.lastHeard);
    if (existingLastHeard == null || rxTime > existingLastHeard) {
      target.lastHeard = rxTime;
      assignString(target, 'lastSeenIso', extractString(position, ['rx_iso', 'rxIso']));
    } else {
      assignString(target, 'lastSeenIso', extractString(position, ['rx_iso', 'rxIso']), { preferExisting: true });
    }
  }
}

/**
 * Safely parse a fallback payload used as an initial node reference.
 *
 * @param {*} fallback User-provided fallback data.
 * @returns {Object|null} Parsed fallback object or ``null``.
 */
function parseFallback(fallback) {
  if (isObject(fallback)) return { ...fallback };
  if (typeof fallback === 'string') {
    try {
      const parsed = JSON.parse(fallback);
      return isObject(parsed) ? parsed : null;
    } catch (error) {
      console.warn('Failed to parse node fallback payload', error);
      return null;
    }
  }
  return null;
}

/**
 * Normalise a node reference into a canonical structure used by the fetcher.
 *
 * @param {*} reference Raw reference passed to {@link refreshNodeInformation}.
 * @returns {{nodeId: (string|null), nodeNum: (number|null), fallback: (Object|null)}} Normalised reference data.
 */
function normalizeReference(reference) {
  if (reference == null) {
    return { nodeId: null, nodeNum: null, fallback: null };
  }
  if (typeof reference === 'string') {
    return { nodeId: toTrimmedString(reference), nodeNum: null, fallback: null };
  }
  if (typeof reference === 'number') {
    const nodeNum = toFiniteNumber(reference);
    return { nodeId: null, nodeNum, fallback: null };
  }

  if (!isObject(reference)) {
    return { nodeId: null, nodeNum: null, fallback: null };
  }

  const fallback = parseFallback(reference.fallback ?? reference.nodeInfo ?? null);
  let nodeId = toTrimmedString(reference.nodeId ?? reference.node_id ?? null);
  if (nodeId == null) {
    nodeId = toTrimmedString(fallback?.nodeId ?? fallback?.node_id ?? null);
  }
  let nodeNum = reference.nodeNum ?? reference.node_num ?? null;
  if (nodeNum == null) {
    nodeNum = fallback?.nodeNum ?? fallback?.node_num ?? null;
  }
  nodeNum = toFiniteNumber(nodeNum);

  return { nodeId, nodeNum, fallback };
}

/**
 * Retrieve and merge node, telemetry, position, and neighbor information.
 *
 * @param {*} reference Node identifier string/number or an object containing ``nodeId``/``nodeNum``.
 * @param {{fetchImpl?: Function}} [options] Optional overrides such as a custom ``fetch`` implementation.
 * @returns {Promise<Object>} Normalised node payload enriched with telemetry, position, and neighbor data.
 */
export async function refreshNodeInformation(reference, options = {}) {
  const normalized = normalizeReference(reference);
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('A fetch implementation is required to refresh node information');
  }

  const identifier = normalized.nodeId ?? normalized.nodeNum;
  if (identifier == null) {
    throw new Error('A node identifier or numeric reference must be provided');
  }

  const encodedId = encodeURIComponent(String(identifier));

  const [nodeRecord, telemetryRecords, positionRecords, neighborRecords] = await Promise.all([
    (async () => {
      const response = await fetchImpl(`/api/nodes/${encodedId}?limit=${SNAPSHOT_WINDOW}`, DEFAULT_FETCH_OPTIONS);
      if (response.status === 404) return null;
      if (!response.ok) {
        throw new Error(`Failed to load node information (HTTP ${response.status})`);
      }
      return response.json();
    })(),
    (async () => {
      const response = await fetchImpl(`/api/telemetry/${encodedId}?limit=${TELEMETRY_LIMIT}`, DEFAULT_FETCH_OPTIONS);
      if (response.status === 404) return [];
      if (!response.ok) {
        throw new Error(`Failed to load telemetry information (HTTP ${response.status})`);
      }
      return response.json();
    })(),
    (async () => {
      const response = await fetchImpl(`/api/positions/${encodedId}?limit=${POSITION_LIMIT}`, DEFAULT_FETCH_OPTIONS);
      if (response.status === 404) return [];
      if (!response.ok) {
        throw new Error(`Failed to load position information (HTTP ${response.status})`);
      }
      return response.json();
    })(),
    (async () => {
      const response = await fetchImpl(`/api/neighbors/${encodedId}?limit=${NEIGHBOR_LIMIT}`, DEFAULT_FETCH_OPTIONS);
      if (response.status === 404) return [];
      if (!response.ok) {
        throw new Error(`Failed to load neighbor information (HTTP ${response.status})`);
      }
      return response.json();
    })(),
  ]);

  const nodeCandidates = Array.isArray(nodeRecord)
    ? nodeRecord.filter(isObject)
    : (isObject(nodeRecord) ? [nodeRecord] : []);
  const aggregatedNodeRecords = aggregateNodeSnapshots(nodeCandidates);
  const nodeRecordEntry = aggregatedNodeRecords[0] ?? null;

  const telemetryCandidates = Array.isArray(telemetryRecords)
    ? telemetryRecords.filter(isObject)
    : (isObject(telemetryRecords) ? [telemetryRecords] : []);
  const aggregatedTelemetry = aggregateTelemetrySnapshots(telemetryCandidates);
  const telemetryEntry = aggregatedTelemetry[0] ?? null;

  const positionCandidates = Array.isArray(positionRecords)
    ? positionRecords
    : (isObject(positionRecords) ? [positionRecords] : []);
  const aggregatedPositions = aggregatePositionSnapshots(positionCandidates);
  const positionEntry = aggregatedPositions[0] ?? null;

  const neighborCandidates = Array.isArray(neighborRecords)
    ? neighborRecords
    : (isObject(neighborRecords) ? [neighborRecords] : []);
  const neighborEntries = aggregateNeighborSnapshots(neighborCandidates);

  const node = { neighbors: neighborEntries };

  if (normalized.fallback) {
    mergeNodeFields(node, normalized.fallback);
  }
  if (nodeRecordEntry) {
    mergeNodeFields(node, nodeRecordEntry);
  }
  if (normalized.nodeId && !node.nodeId) {
    node.nodeId = normalized.nodeId;
  }
  if (normalized.nodeNum != null && toFiniteNumber(node.nodeNum) == null) {
    node.nodeNum = normalized.nodeNum;
  }

  mergeTelemetry(node, telemetryEntry);
  mergePosition(node, positionEntry);

  const derivedLastHeardValues = [
    toFiniteNumber(node.lastHeard),
    toFiniteNumber(node.telemetryTime),
    toFiniteNumber(node.positionTime),
  ].filter(value => value != null);
  if (derivedLastHeardValues.length > 0) {
    node.lastHeard = Math.max(...derivedLastHeardValues);
  }

  if (!node.role) {
    node.role = 'CLIENT';
  }

  node.rawSources = {
    node: nodeRecordEntry,
    telemetry: telemetryEntry,
    telemetrySnapshots: telemetryCandidates,
    position: positionEntry,
    neighbors: neighborEntries,
  };

  normalizeNodeSnapshot(node);

  return node;
}

export const __testUtils = {
  toTrimmedString,
  toFiniteNumber,
  extractString,
  extractNumber,
  assignString,
  assignNumber,
  mergeModemMetadata,
  mergeNodeFields,
  mergeTelemetry,
  mergePosition,
  parseFallback,
  normalizeReference,
};
