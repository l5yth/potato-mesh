/*
 * Copyright (C) 2025 l5yth
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

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 1000;

/**
 * Convert arbitrary input into a finite number when possible.
 *
 * @param {*} value Candidate numeric value.
 * @returns {number|null} Finite number or ``null`` when coercion fails.
 */
function toFiniteNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (value == null || value === '') {
    return null;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/**
 * Resolve the most appropriate timestamp in seconds from a telemetry record.
 *
 * @param {Object} record Telemetry payload.
 * @returns {number|null} Timestamp in seconds or ``null`` when absent.
 */
function telemetryTimestampSeconds(record) {
  if (!record || typeof record !== 'object') return null;
  const telemetryTime = toFiniteNumber(record.telemetry_time ?? record.telemetryTime);
  if (telemetryTime != null) return telemetryTime;
  const rxTime = toFiniteNumber(record.rx_time ?? record.rxTime);
  return rxTime != null ? rxTime : null;
}

/**
 * Resolve the most appropriate timestamp in seconds from a position record.
 *
 * @param {Object} record Position payload.
 * @returns {number|null} Timestamp in seconds or ``null`` when absent.
 */
function positionTimestampSeconds(record) {
  if (!record || typeof record !== 'object') return null;
  const positionTime = toFiniteNumber(record.position_time ?? record.positionTime);
  if (positionTime != null) return positionTime;
  const rxTime = toFiniteNumber(record.rx_time ?? record.rxTime);
  return rxTime != null ? rxTime : null;
}

/**
 * Ensure a node identifier is a non-empty string.
 *
 * @param {string} nodeId Node identifier provided by the caller.
 * @throws {TypeError} When the identifier is not a non-empty string.
 */
function assertNodeId(nodeId) {
  if (typeof nodeId !== 'string' || nodeId.trim().length === 0) {
    throw new TypeError('nodeId must be a non-empty string');
  }
}

/**
 * Fetch telemetry records for a node over the past ``days`` days.
 *
 * @param {Object} options Behaviour customisation options.
 * @param {string} options.nodeId Canonical node identifier.
 * @param {number} [options.days=7] Number of days to retain.
 * @param {number} [options.limit=1000] Maximum records to request from the API.
 * @param {Function} [options.fetchImpl=fetch] Fetch-like implementation to use.
 * @param {number} [options.now=Date.now()] Reference timestamp in milliseconds.
 * @returns {Promise<Array<Object>>} Normalised telemetry list sorted oldest first.
 */
export async function fetchTelemetryForNode({
  nodeId,
  days = 7,
  limit = DEFAULT_LIMIT,
  fetchImpl = globalThis.fetch,
  now = Date.now()
} = {}) {
  assertNodeId(nodeId);
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('fetchImpl must be a function');
  }
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.trunc(limit), DEFAULT_LIMIT) : DEFAULT_LIMIT;
  const cutoffMs = now - Math.max(1, days) * ONE_DAY_MS;
  const response = await fetchImpl(`/api/telemetry/${encodeURIComponent(nodeId)}?limit=${safeLimit}`, {
    cache: 'no-store'
  });
  if (!response || typeof response.ok !== 'boolean' || !response.ok) {
    const status = response && typeof response.status === 'number' ? response.status : 'unknown';
    throw new Error(`Failed to load telemetry for node ${nodeId} (status: ${status})`);
  }
  const payload = await response.json();
  if (!Array.isArray(payload)) {
    return [];
  }
  const entries = [];
  for (const record of payload) {
    const timestampSeconds = telemetryTimestampSeconds(record);
    if (timestampSeconds == null) continue;
    const timestampMs = timestampSeconds * 1000;
    if (timestampMs < cutoffMs) continue;
    const batteryLevel = toFiniteNumber(record?.battery_level ?? record?.batteryLevel);
    const channelUtilization = toFiniteNumber(record?.channel_utilization ?? record?.channelUtilization);
    const airUtilTx = toFiniteNumber(record?.air_util_tx ?? record?.airUtilTx ?? record?.airUtil);
    if (batteryLevel == null && channelUtilization == null && airUtilTx == null) continue;
    entries.push({
      timestampMs,
      batteryLevel,
      channelUtilization,
      airUtilTx
    });
  }
  entries.sort((a, b) => a.timestampMs - b.timestampMs);
  return entries;
}

/**
 * Fetch positional history for a node over the past ``days`` days.
 *
 * @param {Object} options Behaviour customisation options.
 * @param {string} options.nodeId Canonical node identifier.
 * @param {number} [options.days=7] Number of days to retain.
 * @param {number} [options.limit=1000] Maximum records to request from the API.
 * @param {Function} [options.fetchImpl=fetch] Fetch-like implementation to use.
 * @param {number} [options.now=Date.now()] Reference timestamp in milliseconds.
 * @returns {Promise<Array<Object>>} Normalised positions sorted oldest first.
 */
export async function fetchPositionsForNode({
  nodeId,
  days = 7,
  limit = DEFAULT_LIMIT,
  fetchImpl = globalThis.fetch,
  now = Date.now()
} = {}) {
  assertNodeId(nodeId);
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('fetchImpl must be a function');
  }
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.trunc(limit), DEFAULT_LIMIT) : DEFAULT_LIMIT;
  const cutoffMs = now - Math.max(1, days) * ONE_DAY_MS;
  const response = await fetchImpl(`/api/positions/${encodeURIComponent(nodeId)}?limit=${safeLimit}`, {
    cache: 'no-store'
  });
  if (!response || typeof response.ok !== 'boolean' || !response.ok) {
    const status = response && typeof response.status === 'number' ? response.status : 'unknown';
    throw new Error(`Failed to load positions for node ${nodeId} (status: ${status})`);
  }
  const payload = await response.json();
  if (!Array.isArray(payload)) {
    return [];
  }
  const entries = [];
  for (const record of payload) {
    const timestampSeconds = positionTimestampSeconds(record);
    if (timestampSeconds == null) continue;
    const timestampMs = timestampSeconds * 1000;
    if (timestampMs < cutoffMs) continue;
    const latitude = toFiniteNumber(record?.latitude);
    const longitude = toFiniteNumber(record?.longitude);
    if (latitude == null || longitude == null) continue;
    const altitude = toFiniteNumber(record?.altitude);
    entries.push({
      timestampMs,
      latitude,
      longitude,
      altitude
    });
  }
  entries.sort((a, b) => a.timestampMs - b.timestampMs);
  return entries;
}

export { toFiniteNumber };
