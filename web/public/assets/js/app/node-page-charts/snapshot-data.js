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
 * Telemetry-snapshot data extraction helpers used to derive series points.
 *
 * @module node-page-charts/snapshot-data
 */

import { numberOrNull, stringOrNull } from '../value-helpers.js';

/**
 * Collect candidate containers that may hold telemetry values for a snapshot.
 *
 * Handles both flat telemetry rows and nested ``device_metrics`` /
 * ``environment_metrics`` sub-objects so that value extraction works
 * regardless of the API response shape.
 *
 * @param {Object} snapshot Telemetry snapshot payload.
 * @returns {Array<Object>} Container objects to inspect for telemetry fields.
 */
export function collectSnapshotContainers(snapshot) {
  const containers = [];
  if (!snapshot || typeof snapshot !== 'object') {
    return containers;
  }
  const seen = new Set();
  const enqueue = value => {
    if (!value || typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);
    containers.push(value);
  };
  enqueue(snapshot);
  // Top-level nested keys that carry metric sub-objects.
  const directKeys = [
    'device_metrics',
    'deviceMetrics',
    'environment_metrics',
    'environmentMetrics',
    'raw',
  ];
  directKeys.forEach(key => {
    if (Object.prototype.hasOwnProperty.call(snapshot, key)) {
      enqueue(snapshot[key]);
    }
  });
  // Also drill one level into `.raw` for double-nested API shapes.
  if (snapshot.raw && typeof snapshot.raw === 'object') {
    ['device_metrics', 'deviceMetrics', 'environment_metrics', 'environmentMetrics'].forEach(key => {
      if (Object.prototype.hasOwnProperty.call(snapshot.raw, key)) {
        enqueue(snapshot.raw[key]);
      }
    });
  }
  return containers;
}

/**
 * Infer the telemetry sub-type for a snapshot.
 *
 * Uses the stored ``telemetry_type`` field when available.  Falls back to
 * field-presence heuristics for rows that pre-date the discriminator column.
 *
 * @param {Object} snapshot Telemetry snapshot payload.
 * @returns {string} One of ``'device'``, ``'environment'``, ``'power'``,
 *   ``'air_quality'``, or ``'unknown'``.
 */
export function classifySnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return 'unknown';
  const stored = stringOrNull(snapshot.telemetry_type);
  if (stored) return stored;
  // Heuristics for legacy rows — check both flat and nested shapes.
  const hasBattery =
    snapshot.battery_level != null ||
    snapshot.channel_utilization != null ||
    snapshot.air_util_tx != null ||
    snapshot.uptime_seconds != null ||
    snapshot.device_metrics?.battery_level != null ||
    snapshot.deviceMetrics?.batteryLevel != null;
  if (hasBattery) return 'device';
  const hasEnv =
    snapshot.temperature != null ||
    snapshot.relative_humidity != null ||
    snapshot.barometric_pressure != null ||
    snapshot.environment_metrics?.temperature != null ||
    snapshot.environmentMetrics?.temperature != null;
  if (hasEnv) return 'environment';
  // device_metrics also carries a `voltage` field (~4.2 V for battery), so a
  // device row with `voltage` but none of the four battery-discriminator fields
  // above would be misclassified as 'power'.  This is consistent with the SQL
  // backfill and is negligible in practice (firmware always sends at least
  // battery_level or channel_utilization alongside voltage).
  if (snapshot.current != null || snapshot.voltage != null) return 'power';
  if (snapshot.iaq != null || snapshot.gas_resistance != null) return 'environment';
  return 'unknown';
}

/**
 * Extract the first numeric telemetry value matching one of the supplied
 * field names from any candidate container in the snapshot.
 *
 * @param {*} snapshot Telemetry payload.
 * @param {Array<string>} fields Candidate property names.
 * @returns {number|null} Extracted numeric value or ``null``.
 */
export function extractSnapshotValue(snapshot, fields) {
  if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(fields)) {
    return null;
  }
  const containers = collectSnapshotContainers(snapshot);
  for (const container of containers) {
    for (const field of fields) {
      if (!Object.prototype.hasOwnProperty.call(container, field)) continue;
      const numeric = numberOrNull(container[field]);
      if (numeric != null) {
        return numeric;
      }
    }
  }
  return null;
}

/**
 * Build data points for a series constrained to the given time window.
 *
 * Entries outside ``[domainStart, domainEnd]`` are silently dropped.
 *
 * @param {Array<{timestamp: number, snapshot: Object}>} entries Telemetry entries.
 * @param {Array<string>} fields Candidate metric names.
 * @param {number} domainStart Window start in milliseconds.
 * @param {number} domainEnd Window end in milliseconds.
 * @returns {Array<{timestamp: number, value: number}>} Series points sorted by timestamp.
 */
export function buildSeriesPoints(entries, fields, domainStart, domainEnd) {
  const points = [];
  entries.forEach(entry => {
    if (!entry || typeof entry !== 'object') return;
    const value = extractSnapshotValue(entry.snapshot, fields);
    if (value == null) return;
    if (entry.timestamp < domainStart || entry.timestamp > domainEnd) {
      return;
    }
    points.push({ timestamp: entry.timestamp, value });
  });
  points.sort((a, b) => a.timestamp - b.timestamp);
  return points;
}

/**
 * Resolve the effective axis maximum when upper-overflow is enabled.
 *
 * When ``axis.allowUpperOverflow`` is ``true`` and the observed data exceeds
 * the declared maximum, the axis ceiling is raised to the observed peak.
 *
 * @param {Object} axis Axis descriptor.
 * @param {Array<{axisId: string, points: Array<{timestamp: number, value: number}>}>} seriesEntries
 *   Series entries for the chart.
 * @returns {number} Effective axis maximum.
 */
export function resolveAxisMax(axis, seriesEntries) {
  if (!axis || axis.allowUpperOverflow !== true) {
    return axis?.max;
  }
  let observedMax = null;
  for (const entry of seriesEntries) {
    if (!entry || entry.axisId !== axis.id || !Array.isArray(entry.points)) continue;
    for (const point of entry.points) {
      if (!point || !Number.isFinite(point.value)) continue;
      observedMax = observedMax == null ? point.value : Math.max(observedMax, point.value);
    }
  }
  if (observedMax != null && Number.isFinite(axis.max) && observedMax > axis.max) {
    return observedMax;
  }
  return axis.max;
}
