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
 * Pure formatting helpers used by chart axis renderers and short-info panels.
 *
 * @module node-page-charts/format-utils
 */

import { numberOrNull, stringOrNull } from '../value-helpers.js';

/**
 * Clamp a numeric value between ``min`` and ``max``.
 *
 * @param {number} value Value to clamp.
 * @param {number} min Minimum bound.
 * @param {number} max Maximum bound.
 * @returns {number} Clamped numeric value.
 */
export function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Convert a hex colour string into an ``rgba(…)`` CSS value.
 *
 * Supports both 3- and 6-character hex forms (without the ``#`` prefix being
 * required, though it is accepted).  Falls back to opaque black on invalid
 * input.
 *
 * @param {string} hex Hex colour string.
 * @param {number} [alpha=1] Alpha component in the range [0, 1].
 * @returns {string} RGBA CSS colour string.
 */
export function hexToRgba(hex, alpha = 1) {
  const normalised = stringOrNull(hex)?.replace(/^#/, '') ?? '';
  if (!(normalised.length === 6 || normalised.length === 3)) {
    return `rgba(0, 0, 0, ${alpha})`;
  }
  // Expand shorthand 3-char form to 6 characters.
  const expanded = normalised.length === 3
    ? normalised.split('').map(piece => piece + piece).join('')
    : normalised;
  const toComponent = (start, end) => parseInt(expanded.slice(start, end), 16);
  const r = toComponent(0, 2);
  const g = toComponent(2, 4);
  const b = toComponent(4, 6);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Pad a numeric value to two digits with a leading zero.
 *
 * Truncates towards zero and works on negative values by taking the absolute.
 *
 * @param {number} value Numeric value to pad.
 * @returns {string} Padded two-character string.
 */
export function padTwo(value) {
  return String(Math.trunc(Math.abs(Number(value)))).padStart(2, '0');
}

/**
 * Format a timestamp as a zero-padded day-of-month string (local time zone).
 *
 * Used as the default tick label formatter on the X axis.
 *
 * @param {number} timestampMs Timestamp expressed in milliseconds.
 * @returns {string} Two-digit day string, or empty string when invalid.
 */
export function formatCompactDate(timestampMs) {
  const date = new Date(timestampMs);
  if (Number.isNaN(date.getTime())) return '';
  const day = padTwo(date.getDate());
  return day;
}

/**
 * Format a gas resistance reading using sensible SI prefixes with the Ω symbol.
 *
 * @param {number} value Resistance value in Ohms.
 * @returns {string} Formatted resistance string, or empty string when invalid.
 */
export function formatGasResistance(value) {
  const numeric = numberOrNull(value);
  if (numeric == null) return '';
  const absValue = Math.abs(numeric);
  if (absValue >= 1_000_000) {
    return `${(numeric / 1_000_000).toFixed(2)} MΩ`;
  }
  if (absValue >= 1_000) {
    return `${(numeric / 1_000).toFixed(2)} kΩ`;
  }
  if (absValue >= 100) {
    return `${numeric.toFixed(1)} Ω`;
  }
  return `${numeric.toFixed(0)} Ω`;
}

/**
 * Format a data-point value for tooltip display using the series formatter.
 *
 * Falls back to a plain ``toString()`` when no ``valueFormatter`` is defined.
 *
 * @param {Object} seriesConfig Series configuration object.
 * @param {number} value Numeric data-point value.
 * @returns {string} Formatted value string.
 */
export function formatSeriesPointValue(seriesConfig, value) {
  const numeric = numberOrNull(value);
  if (numeric == null) return '';
  if (typeof seriesConfig.valueFormatter === 'function') {
    return seriesConfig.valueFormatter(numeric);
  }
  return numeric.toString();
}

/**
 * Format a numeric UNIX timestamp (seconds) as an ISO 8601 string.
 *
 * When an ISO fallback string is supplied it is returned verbatim.
 *
 * @param {*} value Raw timestamp value (seconds since the epoch).
 * @param {string|null} [isoFallback] ISO-formatted string to prefer.
 * @returns {string|null} ISO timestamp string or ``null``.
 */
export function formatTimestamp(value, isoFallback = null) {
  const iso = stringOrNull(isoFallback);
  if (iso) return iso;
  const numeric = numberOrNull(value);
  if (numeric == null) return null;
  try {
    return new Date(numeric * 1000).toISOString();
  } catch (error) {
    return null;
  }
}

/**
 * Format an SNR reading with a decibel suffix.
 *
 * @param {*} value Raw SNR value.
 * @returns {string} Formatted SNR string or empty string.
 */
export function formatSnr(value) {
  const numeric = numberOrNull(value);
  if (numeric == null) return '';
  return `${numeric.toFixed(1)} dB`;
}

/**
 * Convert a timestamp that may be expressed in seconds or milliseconds into
 * milliseconds.
 *
 * Values greater than 1 trillion are assumed to already be in milliseconds;
 * smaller values are multiplied by 1 000.
 *
 * @param {*} value Candidate timestamp.
 * @returns {number|null} Timestamp in milliseconds or ``null``.
 */
export function toTimestampMs(value) {
  const numeric = numberOrNull(value);
  if (numeric == null) return null;
  // Values above 1e12 are already in milliseconds (post-2001 epoch ms timestamps).
  if (numeric > 1_000_000_000_000) {
    return numeric;
  }
  return numeric * 1000;
}

/**
 * Resolve the canonical telemetry timestamp for a snapshot record.
 *
 * Checks ISO string fields first, then falls back to numeric candidates,
 * handling both snake_case and camelCase field names from the API.
 *
 * @param {*} snapshot Telemetry snapshot payload.
 * @returns {number|null} Timestamp in milliseconds or ``null``.
 */
export function resolveSnapshotTimestamp(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    return null;
  }
  const isoCandidate = stringOrNull(
    snapshot.rx_iso
      ?? snapshot.rxIso
      ?? snapshot.telemetry_time_iso
      ?? snapshot.telemetryTimeIso
      ?? snapshot.timestampIso,
  );
  if (isoCandidate) {
    const parsed = new Date(isoCandidate);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.getTime();
    }
  }
  const numericCandidates = [
    snapshot.rx_time,
    snapshot.rxTime,
    snapshot.telemetry_time,
    snapshot.telemetryTime,
    snapshot.timestamp,
    snapshot.ts,
  ];
  for (const candidate of numericCandidates) {
    const ts = toTimestampMs(candidate);
    if (ts != null) {
      return ts;
    }
  }
  return null;
}

/**
 * Format a tick label using compact units for better chart readability.
 *
 * Uses ``k``-suffix notation for large logarithmic values; one decimal
 * place when the axis range is narrow (≤ 10); integer otherwise.
 *
 * @param {number} value Tick value.
 * @param {Object} axis Axis descriptor containing ``scale``, ``min``, and ``max``.
 * @returns {string} Formatted label string.
 */
export function formatAxisTick(value, axis) {
  if (!Number.isFinite(value)) return '';
  if (axis.scale === 'log') {
    if (value >= 1000) {
      return `${Math.round(value / 1000)}k`;
    }
    return `${Math.round(value)}`;
  }
  if (Math.abs(axis.max - axis.min) <= 10) {
    return value.toFixed(1);
  }
  return Math.round(value).toString();
}
