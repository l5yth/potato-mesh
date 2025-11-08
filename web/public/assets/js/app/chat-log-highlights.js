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

import { buildTelemetryDisplayEntries, collectTelemetryMetrics, fmtAlt } from './short-info-telemetry.js';

/**
 * Field descriptors inspected when highlighting position updates.
 *
 * Each entry describes a label, possible property names to inspect within a
 * position payload, and a formatter that converts the raw value into a string.
 *
 * @type {Array<{
 *   label: string,
 *   sources: Array<string>,
 *   formatter: (value: *) => string,
 *   suppressZero?: boolean
 * }>}
 */
const POSITION_HIGHLIGHT_FIELDS = Object.freeze([
  { label: 'Lat', sources: ['latitude', 'lat', 'latitude_i'], formatter: value => formatCoordinate(value, 5) },
  { label: 'Lon', sources: ['longitude', 'lon', 'longitude_i'], formatter: value => formatCoordinate(value, 5) },
  { label: 'Alt', sources: ['altitude', 'alt'], formatter: value => fmtAlt(value, 'm'), suppressZero: true },
  {
    label: 'Accuracy',
    sources: ['accuracy', 'pos_accuracy', 'position_accuracy', 'horizontal_accuracy', 'horz_accuracy'],
    formatter: value => fmtAlt(value, 'm'),
    suppressZero: true,
  },
  { label: 'Speed', sources: ['speed', 'ground_speed', 'groundSpeed'], formatter: formatSpeed, suppressZero: true },
  { label: 'Heading', sources: ['heading', 'course', 'bearing'], formatter: formatHeading },
  { label: 'Sats', sources: ['satellites', 'sats', 'num_sats', 'numSats'], formatter: formatInteger },
]);

/**
 * Convert arbitrary values to finite numbers when possible.
 *
 * @param {*} value Raw value.
 * @returns {?number} Normalised finite number or ``null`` for invalid input.
 */
function toFiniteNumber(value) {
  if (value == null || value === '') {
    return null;
  }
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * Extract the first present value from ``source`` using ``keys``.
 *
 * @param {?Object} source Candidate container.
 * @param {Array<string>} keys Ordered list of property names.
 * @returns {*} First non-nullish value or ``null`` when absent.
 */
function pickFirstValueWithKey(source, keys) {
  if (!source || typeof source !== 'object' || !Array.isArray(keys)) {
    return null;
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) {
      continue;
    }
    const value = source[key];
    if (value == null || value === '') {
      continue;
    }
    return { value, key };
  }
  return null;
}

/**
 * Retrieve position values from the provided payload.
 *
 * @param {*} positionPayload Raw position record.
 * @param {Array<string>} keys Candidate property names.
 * @returns {{value: *, key: string}|null} First value discovered in any supported container.
 */
function extractPositionValue(positionPayload, keys) {
  if (!positionPayload || typeof positionPayload !== 'object') {
    return null;
  }
  const containers = [positionPayload];
  const nestedCandidates = ['position', 'gps'];
  for (const property of nestedCandidates) {
    if (positionPayload[property] && typeof positionPayload[property] === 'object') {
      containers.push(positionPayload[property]);
    }
  }
  for (const container of containers) {
    const result = pickFirstValueWithKey(container, keys);
    if (result) {
      return result;
    }
  }
  return null;
}

/**
 * Normalise raw position values based on the originating property.
 *
 * @param {*} value Raw value extracted from the payload.
 * @param {string} [sourceKey] Property name the value originated from.
 * @returns {*} Normalised value ready for formatting.
 */
function normalizePositionValue(value, sourceKey) {
  if (value == null || value === '') {
    return value;
  }
  if (typeof sourceKey === 'string' && sourceKey.endsWith('_i')) {
    const numeric = toFiniteNumber(value);
    return numeric == null ? value : numeric / 1_000_000;
  }
  if (typeof sourceKey === 'string' && ['latitude', 'longitude', 'lat', 'lon'].includes(sourceKey)) {
    const numeric = toFiniteNumber(value);
    if (numeric != null && Math.abs(numeric) > 180 && Math.abs(numeric) <= 180_000_000) {
      return numeric / 1_000_000;
    }
  }
  return value;
}

/**
 * Format coordinate values with a configurable precision.
 *
 * @param {*} value Raw coordinate value.
 * @param {number} [decimals=5] Decimal precision applied when formatting.
 * @returns {string} Formatted coordinate string or an empty string on failure.
 */
function formatCoordinate(value, decimals = 5) {
  if (value == null || value === '') {
    return '';
  }
  const numeric = toFiniteNumber(value);
  if (numeric == null) {
    return '';
  }
  return numeric.toFixed(decimals);
}

/**
 * Format velocity readings in metres per second.
 *
 * @param {*} value Raw speed value.
 * @returns {string} Formatted speed string or an empty string when absent.
 */
function formatSpeed(value) {
  const numeric = toFiniteNumber(value);
  if (numeric == null) {
    return '';
  }
  return `${numeric.toFixed(1)} m/s`;
}

/**
 * Format directional readings in degrees.
 *
 * @param {*} value Raw heading value.
 * @returns {string} Heading string or an empty string when invalid.
 */
function formatHeading(value) {
  const numeric = toFiniteNumber(value);
  if (numeric == null) {
    return '';
  }
  return `${Math.round(numeric)}°`;
}

/**
 * Format integer-like values such as satellite counts.
 *
 * @param {*} value Raw numeric input.
 * @returns {string} Integer string or an empty string on failure.
 */
function formatInteger(value) {
  const numeric = toFiniteNumber(value);
  if (numeric == null) {
    return '';
  }
  return String(Math.round(numeric));
}

/**
 * Build highlight entries for telemetry broadcasts.
 *
 * The returned collection contains label/value tuples describing only the
 * fields present within ``telemetryPayload``.
 *
 * @param {*} telemetryPayload Raw telemetry record.
 * @returns {Array<{label: string, value: string}>} Highlight entries.
 */
export function formatTelemetryHighlights(telemetryPayload) {
  if (!telemetryPayload || typeof telemetryPayload !== 'object') {
    return [];
  }
  const metrics = collectTelemetryMetrics(telemetryPayload);
  if (!metrics || Object.keys(metrics).length === 0) {
    return [];
  }
  const entries = buildTelemetryDisplayEntries(metrics);
  return entries.map(entry => ({ label: entry.label, value: entry.value }));
}

/**
 * Build highlight entries for position broadcasts.
 *
 * Only non-empty values discovered in the payload are returned.
 *
 * @param {*} positionPayload Raw position record.
 * @returns {Array<{label: string, value: string}>} Highlight entries.
 */
export function formatPositionHighlights(positionPayload) {
  if (!positionPayload || typeof positionPayload !== 'object') {
    return [];
  }
  const highlights = [];
  for (const field of POSITION_HIGHLIGHT_FIELDS) {
    const extracted = extractPositionValue(positionPayload, field.sources);
    if (!extracted || extracted.value == null || extracted.value === '') {
      continue;
    }
    const rawValue = normalizePositionValue(extracted.value, extracted.key);
    if (field.suppressZero) {
      const numeric = toFiniteNumber(rawValue);
      if (numeric === 0) {
        continue;
      }
    }
    let formatted = field.formatter(rawValue);
    if (formatted == null) {
      continue;
    }
    formatted = String(formatted).trim();
    if (formatted.length === 0) {
      continue;
    }
    highlights.push({ label: field.label, value: formatted });
  }
  return highlights;
}

export default {
  formatTelemetryHighlights,
  formatPositionHighlights,
};
