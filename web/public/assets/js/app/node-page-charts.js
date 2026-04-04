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
 * Chart constants, pure formatting utilities, tick builders, and SVG renderers
 * used by the node detail telemetry charts.
 *
 * All functions are exported so they can be unit-tested in isolation and
 * reused from {@link module:node-page} or future chart consumers.
 *
 * @module node-page-charts
 */

import { escapeHtml } from './utils.js';
import {
  fmtCurrent,
} from './short-info-telemetry.js';

// ---------------------------------------------------------------------------
// Time-window constants
// ---------------------------------------------------------------------------

/** One day expressed in milliseconds. */
export const DAY_MS = 86_400_000;

/** One hour expressed in milliseconds. */
export const HOUR_MS = 3_600_000;

/** Rolling telemetry display window: seven days in milliseconds. */
export const TELEMETRY_WINDOW_MS = DAY_MS * 7;

// ---------------------------------------------------------------------------
// Chart layout constants
// ---------------------------------------------------------------------------

/**
 * Default SVG viewport dimensions (pixels) for telemetry charts.
 *
 * @type {Readonly<{width: number, height: number}>}
 */
export const DEFAULT_CHART_DIMENSIONS = Object.freeze({ width: 660, height: 360 });

/**
 * Default inner margin (pixels) applied to every telemetry chart.
 *
 * Extra room for secondary axes is added dynamically in
 * {@link createChartDimensions}.
 *
 * @type {Readonly<{top: number, right: number, bottom: number, left: number}>}
 */
export const DEFAULT_CHART_MARGIN = Object.freeze({ top: 28, right: 80, bottom: 64, left: 80 });

/**
 * Telemetry chart definitions describing axes and series metadata.
 *
 * Each entry drives a separate {@link renderTelemetryChart} call inside
 * {@link module:node-page}.renderTelemetryCharts.
 *
 * @type {ReadonlyArray<Object>}
 */
export const TELEMETRY_CHART_SPECS = Object.freeze([
  {
    id: 'device-health',
    title: 'Device health',
    typeFilter: ['device', 'unknown'],
    axes: [
      {
        id: 'battery',
        position: 'left',
        label: 'Battery (%)',
        min: 0,
        max: 100,
        ticks: 4,
        color: '#8856a7',
      },
      {
        id: 'voltage',
        position: 'right',
        label: 'Voltage (V)',
        min: 0,
        max: 6,
        ticks: 3,
        color: '#9ebcda',
        allowUpperOverflow: true,
      },
    ],
    series: [
      {
        id: 'battery',
        axis: 'battery',
        color: '#8856a7',
        label: 'Battery level',
        legend: 'Battery (%)',
        fields: ['battery', 'battery_level', 'batteryLevel'],
        valueFormatter: value => `${value.toFixed(1)}%`,
      },
      {
        id: 'voltage',
        axis: 'voltage',
        color: '#9ebcda',
        label: 'Voltage',
        legend: 'Voltage (V)',
        fields: ['voltage', 'voltageReading'],
        valueFormatter: value => `${value.toFixed(2)} V`,
      },
    ],
  },
  {
    id: 'power-sensor',
    title: 'Power sensor',
    typeFilter: ['power'],
    axes: [
      {
        id: 'voltage',
        position: 'left',
        label: 'Voltage (V)',
        min: 0,
        max: 6,
        ticks: 3,
        color: '#9ebcda',
        allowUpperOverflow: true,
      },
      {
        id: 'current',
        position: 'right',
        label: 'Current (A)',
        min: 0,
        max: 3,
        ticks: 3,
        color: '#3182bd',
        allowUpperOverflow: true,
      },
    ],
    series: [
      {
        id: 'voltage',
        axis: 'voltage',
        color: '#9ebcda',
        label: 'Voltage',
        legend: 'Voltage (V)',
        fields: ['voltage', 'voltageReading'],
        valueFormatter: value => `${value.toFixed(2)} V`,
      },
      {
        id: 'current',
        axis: 'current',
        color: '#3182bd',
        label: 'Current',
        legend: 'Current (A)',
        fields: ['current'],
        valueFormatter: value => fmtCurrent(value),
      },
    ],
  },
  {
    id: 'channel',
    title: 'Channel utilization',
    typeFilter: ['device', 'unknown'],
    axes: [
      {
        id: 'channel',
        position: 'left',
        label: 'Utilization (%)',
        min: 0,
        max: 100,
        ticks: 4,
        color: '#2ca25f',
      },
    ],
    series: [
      {
        id: 'channel',
        axis: 'channel',
        color: '#2ca25f',
        label: 'Channel util',
        legend: 'Channel utilization (%)',
        fields: ['channel_utilization', 'channelUtilization'],
        valueFormatter: value => `${value.toFixed(1)}%`,
      },
      {
        id: 'air',
        axis: 'channel',
        color: '#99d8c9',
        label: 'Air util tx',
        legend: 'Air util TX (%)',
        fields: ['airUtil', 'air_util_tx', 'airUtilTx'],
        valueFormatter: value => `${value.toFixed(1)}%`,
      },
    ],
  },
  {
    id: 'environment',
    title: 'Environmental telemetry',
    typeFilter: ['environment'],
    axes: [
      {
        id: 'temperature',
        position: 'left',
        label: 'Temperature (\u00b0C)',
        min: -20,
        max: 40,
        ticks: 4,
        color: '#fc8d59',
        allowUpperOverflow: true,
      },
      {
        id: 'humidity',
        position: 'left',
        label: 'Humidity (%)',
        min: 0,
        max: 100,
        ticks: 4,
        color: '#91bfdb',
        visible: false,
      },
    ],
    series: [
      {
        id: 'temperature',
        axis: 'temperature',
        color: '#fc8d59',
        label: 'Temperature',
        legend: 'Temperature (\u00b0C)',
        fields: ['temperature', 'temp'],
        valueFormatter: value => `${value.toFixed(1)}\u00b0C`,
      },
      {
        id: 'humidity',
        axis: 'humidity',
        color: '#91bfdb',
        label: 'Humidity',
        legend: 'Humidity (%)',
        fields: ['humidity', 'relative_humidity', 'relativeHumidity'],
        valueFormatter: value => `${value.toFixed(1)}%`,
      },
    ],
  },
  {
    id: 'airQuality',
    title: 'Air quality',
    typeFilter: ['environment', 'air_quality'],
    axes: [
      {
        id: 'pressure',
        position: 'left',
        label: 'Pressure (hPa)',
        min: 800,
        max: 1_100,
        ticks: 4,
        color: '#c51b8a',
      },
      {
        id: 'gas',
        position: 'right',
        label: 'Gas resistance (\u03a9)',
        min: 10,
        max: 100_000,
        ticks: 5,
        color: '#fa9fb5',
        scale: 'log',
      },
      {
        id: 'iaq',
        position: 'rightSecondary',
        label: 'IAQ index',
        min: 0,
        max: 500,
        ticks: 5,
        color: '#636363',
        allowUpperOverflow: true,
      },
    ],
    series: [
      {
        id: 'pressure',
        axis: 'pressure',
        color: '#c51b8a',
        label: 'Pressure',
        legend: 'Pressure (hPa)',
        fields: ['pressure', 'barometric_pressure', 'barometricPressure'],
        valueFormatter: value => `${value.toFixed(1)} hPa`,
      },
      {
        id: 'gas',
        axis: 'gas',
        color: '#fa9fb5',
        label: 'Gas resistance',
        legend: 'Gas resistance (\u03a9)',
        fields: ['gas_resistance', 'gasResistance'],
        valueFormatter: value => formatGasResistance(value),
      },
      {
        id: 'iaq',
        axis: 'iaq',
        color: '#636363',
        label: 'IAQ',
        legend: 'IAQ index',
        fields: ['iaq'],
        valueFormatter: value => value.toFixed(0),
      },
    ],
  },
]);

// ---------------------------------------------------------------------------
// Pure number / string helpers
// ---------------------------------------------------------------------------

/**
 * Attempt to coerce a raw value to a finite number.
 *
 * Used internally wherever chart code needs a numeric guard without importing
 * the full ``node-page`` ``numberOrNull`` helper.
 *
 * @param {*} value Raw value.
 * @returns {number|null} Finite number or ``null``.
 */
function numberOrNull(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (value == null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/**
 * Coerce a raw value to a trimmed non-empty string.
 *
 * @param {*} value Raw value.
 * @returns {string|null} Trimmed string or ``null``.
 */
function stringOrNull(value) {
  if (value == null) return null;
  const str = String(value).trim();
  return str.length === 0 ? null : str;
}

// ---------------------------------------------------------------------------
// Exported pure utility functions
// ---------------------------------------------------------------------------

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
    return `${(numeric / 1_000_000).toFixed(2)} M\u03a9`;
  }
  if (absValue >= 1_000) {
    return `${(numeric / 1_000).toFixed(2)} k\u03a9`;
  }
  if (absValue >= 100) {
    return `${numeric.toFixed(1)} \u03a9`;
  }
  return `${numeric.toFixed(0)} \u03a9`;
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
 * Format a frequency value using MHz units when a numeric reading is
 * available.  Non-numeric input is passed through unchanged.
 *
 * @param {*} value Raw frequency value.
 * @returns {string|null} Formatted frequency string or ``null``.
 */
export function formatFrequency(value) {
  if (value == null || value === '') return null;
  const numeric = numberOrNull(value);
  if (numeric == null) {
    return stringOrNull(value);
  }
  const abs = Math.abs(numeric);
  if (abs >= 1_000_000) {
    return `${(numeric / 1_000_000).toFixed(3)} MHz`;
  }
  if (abs >= 1_000) {
    return `${(numeric / 1_000).toFixed(3)} MHz`;
  }
  return `${numeric.toFixed(3)} MHz`;
}

/**
 * Format a battery reading as a percentage with one decimal place.
 *
 * @param {*} value Raw battery value.
 * @returns {string|null} Formatted percentage or ``null``.
 */
export function formatBattery(value) {
  const numeric = numberOrNull(value);
  if (numeric == null) return null;
  return `${numeric.toFixed(1)}%`;
}

/**
 * Format a voltage reading with two decimal places.
 *
 * @param {*} value Raw voltage value.
 * @returns {string|null} Formatted voltage string or ``null``.
 */
export function formatVoltage(value) {
  const numeric = numberOrNull(value);
  if (numeric == null) return null;
  return `${numeric.toFixed(2)} V`;
}

/**
 * Convert an uptime reading in seconds to a concise human-readable string.
 *
 * @param {*} value Raw uptime value.
 * @returns {string|null} Formatted uptime string or ``null`` when invalid.
 */
export function formatUptime(value) {
  const numeric = numberOrNull(value);
  if (numeric == null) return null;
  const seconds = Math.floor(numeric);
  const parts = [];
  const days = Math.floor(seconds / 86_400);
  if (days > 0) parts.push(`${days}d`);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  if (hours > 0) parts.push(`${hours}h`);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (minutes > 0) parts.push(`${minutes}m`);
  const remainSeconds = seconds % 60;
  if (parts.length === 0 || remainSeconds > 0) {
    parts.push(`${remainSeconds}s`);
  }
  return parts.join(' ');
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
 * Format a timestamp for the message log as ``YYYY-MM-DD HH:MM`` in the
 * local time zone.
 *
 * @param {*} value Seconds since the epoch.
 * @param {string|null} [isoFallback] ISO timestamp to prefer when available.
 * @returns {string|null} Formatted timestamp string or ``null``.
 */
export function formatMessageTimestamp(value, isoFallback = null) {
  const iso = stringOrNull(isoFallback);
  let date = null;
  if (iso) {
    const candidate = new Date(iso);
    if (!Number.isNaN(candidate.getTime())) {
      date = candidate;
    }
  }
  if (!date) {
    const numeric = numberOrNull(value);
    if (numeric == null) return null;
    const candidate = new Date(numeric * 1000);
    if (Number.isNaN(candidate.getTime())) {
      return null;
    }
    date = candidate;
  }
  const year = date.getFullYear();
  const month = padTwo(date.getMonth() + 1);
  const day = padTwo(date.getDate());
  const hours = padTwo(date.getHours());
  const minutes = padTwo(date.getMinutes());
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

/**
 * Format a hardware model string while hiding unset placeholders.
 *
 * Firmware uses the literal string ``"UNSET"`` for nodes that have not
 * reported a hardware model; this helper suppresses that value so the UI
 * displays an empty cell instead.
 *
 * @param {*} value Raw hardware model value.
 * @returns {string} Sanitised hardware model string, or empty string.
 */
export function formatHardwareModel(value) {
  const text = stringOrNull(value);
  if (!text || text.toUpperCase() === 'UNSET') {
    return '';
  }
  return text;
}

/**
 * Format a geographic coordinate with consistent decimal precision.
 *
 * @param {*} value Raw coordinate value.
 * @param {number} [precision=5] Number of decimal places.
 * @returns {string} Formatted coordinate string, or empty string when invalid.
 */
export function formatCoordinate(value, precision = 5) {
  const numeric = numberOrNull(value);
  if (numeric == null) return '';
  return numeric.toFixed(precision);
}

/**
 * Convert an absolute UNIX timestamp into a relative time description.
 *
 * Returns strings such as ``"42s"``, ``"3m 15s"``, ``"2h 5m"``, ``"1d 3h"``.
 *
 * @param {*} value Raw timestamp expressed in seconds since the epoch.
 * @param {number} [referenceSeconds] Optional reference timestamp in seconds.
 *   Defaults to ``Date.now() / 1000``.
 * @returns {string} Relative time string or empty string when unavailable.
 */
export function formatRelativeSeconds(value, referenceSeconds = Date.now() / 1000) {
  const numeric = numberOrNull(value);
  if (numeric == null) return '';
  const reference = numberOrNull(referenceSeconds);
  const base = reference != null ? reference : Date.now() / 1000;
  const diff = Math.floor(base - numeric);
  const safeDiff = Number.isFinite(diff) ? Math.max(diff, 0) : 0;
  if (safeDiff < 60) return `${safeDiff}s`;
  if (safeDiff < 3_600) {
    const minutes = Math.floor(safeDiff / 60);
    const seconds = safeDiff % 60;
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  if (safeDiff < 86_400) {
    const hours = Math.floor(safeDiff / 3_600);
    const minutes = Math.floor((safeDiff % 3_600) / 60);
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  const days = Math.floor(safeDiff / 86_400);
  const hours = Math.floor((safeDiff % 86_400) / 3_600);
  return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
}

/**
 * Format a duration expressed in seconds using a compact human-readable form.
 *
 * @param {*} value Raw duration in seconds.
 * @returns {string} Human-readable duration string or empty string.
 */
export function formatDurationSeconds(value) {
  const numeric = numberOrNull(value);
  if (numeric == null) return '';
  const duration = Math.max(Math.floor(numeric), 0);
  if (duration < 60) return `${duration}s`;
  if (duration < 3_600) {
    const minutes = Math.floor(duration / 60);
    const seconds = duration % 60;
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  if (duration < 86_400) {
    const hours = Math.floor(duration / 3_600);
    const minutes = Math.floor((duration % 3_600) / 60);
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  const days = Math.floor(duration / 86_400);
  const hours = Math.floor((duration % 86_400) / 3_600);
  return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
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

// ---------------------------------------------------------------------------
// Tick builders
// ---------------------------------------------------------------------------

/**
 * Build midnight tick timestamps covering the rolling telemetry window.
 *
 * Walks backwards from ``nowMs`` by one day until the domain start is
 * reached, then reverses the array for chronological order.
 *
 * @param {number} nowMs Reference timestamp in milliseconds.
 * @param {number} [windowMs=TELEMETRY_WINDOW_MS] Window size in milliseconds.
 * @returns {Array<number>} Midnight timestamps within the window.
 */
export function buildMidnightTicks(nowMs, windowMs = TELEMETRY_WINDOW_MS) {
  const ticks = [];
  const safeWindow = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : TELEMETRY_WINDOW_MS;
  const domainStart = nowMs - safeWindow;
  const cursor = new Date(nowMs);
  cursor.setHours(0, 0, 0, 0);
  for (let ts = cursor.getTime(); ts >= domainStart; ts -= DAY_MS) {
    ticks.push(ts);
  }
  return ticks.reverse();
}

/**
 * Build hourly tick timestamps across the provided window.
 *
 * @param {number} nowMs Reference timestamp in milliseconds.
 * @param {number} [windowMs=DAY_MS] Window size in milliseconds.
 * @returns {Array<number>} Hourly tick timestamps in chronological order.
 */
export function buildHourlyTicks(nowMs, windowMs = DAY_MS) {
  const ticks = [];
  const safeWindow = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : DAY_MS;
  const domainStart = nowMs - safeWindow;
  const cursor = new Date(nowMs);
  cursor.setMinutes(0, 0, 0);
  for (let ts = cursor.getTime(); ts >= domainStart; ts -= HOUR_MS) {
    ticks.push(ts);
  }
  return ticks.reverse();
}

/**
 * Build evenly spaced ticks for linear axes.
 *
 * @param {number} min Axis minimum.
 * @param {number} max Axis maximum.
 * @param {number} [count=4] Number of tick segments (produces count+1 values).
 * @returns {Array<number>} Tick values including both extrema.
 */
export function buildLinearTicks(min, max, count = 4) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (max <= min) return [min];
  const segments = Math.max(1, Math.floor(count));
  const step = (max - min) / segments;
  const ticks = [];
  for (let idx = 0; idx <= segments; idx += 1) {
    ticks.push(min + step * idx);
  }
  return ticks;
}

/**
 * Build base-10 ticks for logarithmic axes.
 *
 * Returns one tick per order of magnitude between ``min`` and ``max``,
 * plus the raw min/max values when they are not already included.
 *
 * @param {number} min Minimum domain value (must be > 0).
 * @param {number} max Maximum domain value.
 * @returns {Array<number>} Tick values distributed across powers of ten.
 */
export function buildLogTicks(min, max) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max <= min) {
    return [];
  }
  const ticks = [];
  const minExp = Math.ceil(Math.log10(min));
  const maxExp = Math.floor(Math.log10(max));
  for (let exp = minExp; exp <= maxExp; exp += 1) {
    ticks.push(10 ** exp);
  }
  if (!ticks.includes(min)) ticks.unshift(min);
  if (!ticks.includes(max)) ticks.push(max);
  return ticks;
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

// ---------------------------------------------------------------------------
// Chart renderers
// ---------------------------------------------------------------------------

/**
 * Compute the layout metrics for the supplied chart specification.
 *
 * Automatically widens the left/right margins when the spec requests
 * secondary axes.
 *
 * @param {Object} spec Chart specification (must include an ``axes`` array).
 * @returns {{
 *   width: number,
 *   height: number,
 *   margin: {top: number, right: number, bottom: number, left: number},
 *   innerWidth: number,
 *   innerHeight: number,
 *   chartTop: number,
 *   chartBottom: number,
 * }} Computed chart dimensions.
 */
export function createChartDimensions(spec) {
  const margin = { ...DEFAULT_CHART_MARGIN };
  // Widen the left margin when a secondary left axis is present.
  if (spec.axes.some(axis => axis.position === 'leftSecondary')) {
    margin.left += 36;
  }
  // Widen the right margin when a secondary right axis is present.
  if (spec.axes.some(axis => axis.position === 'rightSecondary')) {
    margin.right += 40;
  }
  const width = DEFAULT_CHART_DIMENSIONS.width;
  const height = DEFAULT_CHART_DIMENSIONS.height;
  const innerWidth = Math.max(1, width - margin.left - margin.right);
  const innerHeight = Math.max(1, height - margin.top - margin.bottom);
  return {
    width,
    height,
    margin,
    innerWidth,
    innerHeight,
    chartTop: margin.top,
    chartBottom: height - margin.bottom,
  };
}

/**
 * Compute the horizontal drawing position for an axis descriptor.
 *
 * Maps position keywords to their SVG X coordinates relative to the chart
 * viewport.
 *
 * @param {string} position Axis position keyword.
 * @param {Object} dims Chart dimensions returned by {@link createChartDimensions}.
 * @returns {number} X coordinate for the axis baseline.
 */
export function resolveAxisX(position, dims) {
  switch (position) {
    case 'leftSecondary':
      return dims.margin.left - 32;
    case 'right':
      return dims.width - dims.margin.right;
    case 'rightSecondary':
      return dims.width - dims.margin.right + 32;
    case 'left':
    default:
      return dims.margin.left;
  }
}

/**
 * Compute the X coordinate for a timestamp constrained to the rolling window.
 *
 * Linear interpolation between ``domainStart`` and ``domainEnd``, clamped so
 * points never fall outside the chart frame.
 *
 * @param {number} timestamp Timestamp in milliseconds.
 * @param {number} domainStart Start of the window in milliseconds.
 * @param {number} domainEnd End of the window in milliseconds.
 * @param {Object} dims Chart dimensions.
 * @returns {number} X coordinate inside the SVG viewport.
 */
export function scaleTimestamp(timestamp, domainStart, domainEnd, dims) {
  const safeStart = Math.min(domainStart, domainEnd);
  const safeEnd = Math.max(domainStart, domainEnd);
  const span = Math.max(1, safeEnd - safeStart);
  const clamped = clamp(timestamp, safeStart, safeEnd);
  const ratio = (clamped - safeStart) / span;
  return dims.margin.left + ratio * dims.innerWidth;
}

/**
 * Convert a value bound to a specific axis into a Y coordinate.
 *
 * Supports both linear and logarithmic (``scale: 'log'``) axes.
 *
 * @param {number} value Series value.
 * @param {Object} axis Axis descriptor.
 * @param {Object} dims Chart dimensions.
 * @returns {number} Y coordinate (higher values map to lower Y numbers).
 */
export function scaleValueToAxis(value, axis, dims) {
  if (!axis) return dims.chartBottom;
  if (axis.scale === 'log') {
    // Logarithmic scale: map log10(value) linearly between log10(min) and
    // log10(max) so each order of magnitude occupies the same pixel height.
    const minLog = Math.log10(axis.min);
    const maxLog = Math.log10(axis.max);
    const safe = clamp(value, axis.min, axis.max);
    const ratio = (Math.log10(safe) - minLog) / (maxLog - minLog);
    return dims.chartBottom - ratio * dims.innerHeight;
  }
  // Linear scale: ratio grows from 0 at axis.min to 1 at axis.max.
  // Subtracting from chartBottom inverts the Y axis so higher values appear
  // nearer the top of the SVG viewport (lower Y coordinate).
  const safe = clamp(value, axis.min, axis.max);
  const ratio = (safe - axis.min) / (axis.max - axis.min || 1);
  return dims.chartBottom - ratio * dims.innerHeight;
}

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

/**
 * Render a telemetry series as SVG circles with an optional translucent
 * guide line.
 *
 * An optional ``lineReducer`` can be supplied to down-sample the point set
 * used for the path (the full set is always used for circles).
 *
 * @param {Object} seriesConfig Series metadata.
 * @param {Array<{timestamp: number, value: number}>} points Series data points.
 * @param {Object} axis Axis descriptor.
 * @param {Object} dims Chart dimensions.
 * @param {number} domainStart Window start timestamp.
 * @param {number} domainEnd Window end timestamp.
 * @param {{ lineReducer?: Function }} [options] Optional rendering overrides.
 * @returns {string} SVG markup for the series.
 */
export function renderTelemetrySeries(seriesConfig, points, axis, dims, domainStart, domainEnd, { lineReducer } = {}) {
  if (!Array.isArray(points) || points.length === 0) {
    return '';
  }
  const convertPoint = point => {
    const cx = scaleTimestamp(point.timestamp, domainStart, domainEnd, dims);
    const cy = scaleValueToAxis(point.value, axis, dims);
    return { cx, cy, value: point.value };
  };
  // Build circle elements — one per data point.
  const circleEntries = points.map(point => {
    const coords = convertPoint(point);
    const tooltip = formatSeriesPointValue(seriesConfig, point.value);
    const titleMarkup = tooltip ? `<title>${escapeHtml(tooltip)}</title>` : '';
    return `<circle class="node-detail__chart-point" cx="${coords.cx.toFixed(2)}" cy="${coords.cy.toFixed(2)}" r="3.2" fill="${seriesConfig.color}" aria-hidden="true">${titleMarkup}</circle>`;
  });
  // Allow a custom reducer to thin the line path (e.g. LTTB).
  const lineSource = typeof lineReducer === 'function' ? lineReducer(points) : points;
  const linePoints = Array.isArray(lineSource) && lineSource.length > 0 ? lineSource : points;
  const coordinates = linePoints.map(convertPoint);
  let line = '';
  if (coordinates.length > 1) {
    // Build a straight-line interpolation between consecutive data points.
    // The path uses full opacity on the circles but 50% opacity on the trend
    // line so individual readings remain visually dominant over the guide.
    const path = coordinates
      .map((coord, idx) => `${idx === 0 ? 'M' : 'L'}${coord.cx.toFixed(2)} ${coord.cy.toFixed(2)}`)
      .join(' ');
    line = `<path class="node-detail__chart-trend" d="${path}" fill="none" stroke="${hexToRgba(seriesConfig.color, 0.5)}" stroke-width="1.5" aria-hidden="true"></path>`;
  }
  // Render the path before the circles so circles sit on top of the line.
  return `${line}${circleEntries.join('')}`;
}

/**
 * Render a vertical axis with tick marks and a rotated axis label.
 *
 * Returns an empty string when ``axis.visible === false``.
 *
 * @param {Object} axis Axis descriptor.
 * @param {Object} dims Chart dimensions.
 * @returns {string} SVG markup for the Y axis, or empty string.
 */
export function renderYAxis(axis, dims) {
  if (!axis || axis.visible === false) {
    return '';
  }
  const x = resolveAxisX(axis.position, dims);
  const ticks = axis.scale === 'log'
    ? buildLogTicks(axis.min, axis.max)
    : buildLinearTicks(axis.min, axis.max, axis.ticks);
  const tickElements = ticks
    .map(value => {
      const y = scaleValueToAxis(value, axis, dims);
      const tickLength = axis.position === 'left' || axis.position === 'leftSecondary' ? -4 : 4;
      const textAnchor = axis.position === 'left' || axis.position === 'leftSecondary' ? 'end' : 'start';
      const textOffset = axis.position === 'left' || axis.position === 'leftSecondary' ? -6 : 6;
      return `
        <g class="node-detail__chart-tick" aria-hidden="true">
          <line x1="${x}" y1="${y.toFixed(2)}" x2="${(x + tickLength).toFixed(2)}" y2="${y.toFixed(2)}"></line>
          <text x="${(x + textOffset).toFixed(2)}" y="${(y + 3).toFixed(2)}" text-anchor="${textAnchor}" dominant-baseline="middle">${escapeHtml(formatAxisTick(value, axis))}</text>
        </g>
      `;
    })
    .join('');
  const labelPadding = axis.position === 'left' || axis.position === 'leftSecondary' ? -56 : 56;
  const labelX = x + labelPadding;
  const labelY = (dims.chartTop + dims.chartBottom) / 2;
  const labelTransform = `rotate(-90 ${labelX.toFixed(2)} ${labelY.toFixed(2)})`;
  return `
    <g class="node-detail__chart-axis node-detail__chart-axis--y" aria-hidden="true">
      <line x1="${x}" y1="${dims.chartTop}" x2="${x}" y2="${dims.chartBottom}"></line>
      ${tickElements}
      <text class="node-detail__chart-axis-label" x="${labelX.toFixed(2)}" y="${labelY.toFixed(2)}" text-anchor="middle" dominant-baseline="middle" transform="${labelTransform}">${escapeHtml(axis.label)}</text>
    </g>
  `;
}

/**
 * Render the horizontal time axis with grid lines and date tick labels.
 *
 * @param {Object} dims Chart dimensions.
 * @param {number} domainStart Window start timestamp in milliseconds.
 * @param {number} domainEnd Window end timestamp in milliseconds.
 * @param {Array<number>} tickTimestamps Tick timestamps to label.
 * @param {{ labelFormatter?: Function }} [options] Optional tick label override.
 * @returns {string} SVG markup for the X axis.
 */
export function renderXAxis(dims, domainStart, domainEnd, tickTimestamps, { labelFormatter = formatCompactDate } = {}) {
  const y = dims.chartBottom;
  const ticks = tickTimestamps
    .map(ts => {
      const x = scaleTimestamp(ts, domainStart, domainEnd, dims);
      const labelY = y + 18;
      const xStr = x.toFixed(2);
      const yStr = labelY.toFixed(2);
      const label = labelFormatter(ts);
      return `
        <g class="node-detail__chart-tick" aria-hidden="true">
          <line class="node-detail__chart-grid-line" x1="${xStr}" y1="${dims.chartTop}" x2="${xStr}" y2="${dims.chartBottom}"></line>
          <text x="${xStr}" y="${yStr}" text-anchor="end" dominant-baseline="central" transform="rotate(-90 ${xStr} ${yStr})">${escapeHtml(label)}</text>
        </g>
      `;
    })
    .join('');
  return `
    <g class="node-detail__chart-axis node-detail__chart-axis--x" aria-hidden="true">
      <line x1="${dims.margin.left}" y1="${y}" x2="${dims.width - dims.margin.right}" y2="${y}"></line>
      ${ticks}
    </g>
  `;
}

/**
 * Render a single telemetry chart defined by ``spec``.
 *
 * Returns an empty string when no series data falls within the time window.
 * Supports an optional ``chartOptions`` bag for custom window sizes, tick
 * builders, tick formatters, line reducers, and aggregation flags.
 *
 * @param {Object} spec Chart specification from {@link TELEMETRY_CHART_SPECS}.
 * @param {Array<{timestamp: number, snapshot: Object}>} entries Telemetry entries.
 * @param {number} nowMs Reference timestamp in milliseconds.
 * @param {Object} [chartOptions] Optional rendering overrides.
 * @returns {string} Rendered chart HTML/SVG markup or empty string.
 */
export function renderTelemetryChart(spec, entries, nowMs, chartOptions = {}) {
  const windowMs = Number.isFinite(chartOptions.windowMs) && chartOptions.windowMs > 0 ? chartOptions.windowMs : TELEMETRY_WINDOW_MS;
  const timeRangeLabel = stringOrNull(chartOptions.timeRangeLabel) ?? 'Last 7 days';
  const domainEnd = nowMs;
  const domainStart = nowMs - windowMs;
  // When not in aggregated mode, filter entries by the chart's typeFilter.
  const effectiveEntries = Array.isArray(spec.typeFilter) && !chartOptions.isAggregated
    ? entries.filter(e => spec.typeFilter.includes(classifySnapshot(e.snapshot)))
    : entries;
  const dims = createChartDimensions(spec);
  const seriesEntries = spec.series
    .map(series => {
      const points = buildSeriesPoints(effectiveEntries, series.fields, domainStart, domainEnd);
      if (points.length === 0) return null;
      return { config: series, axisId: series.axis, points };
    })
    .filter(entry => entry != null);
  if (seriesEntries.length === 0) {
    return '';
  }
  // Apply allowUpperOverflow adjustments to each axis.
  const adjustedAxes = spec.axes.map(axis => {
    const resolvedMax = resolveAxisMax(axis, seriesEntries);
    if (resolvedMax != null && resolvedMax !== axis.max) {
      return { ...axis, max: resolvedMax };
    }
    return axis;
  });
  const axisMap = new Map(adjustedAxes.map(axis => [axis.id, axis]));
  const plottedSeries = seriesEntries
    .map(series => {
      const axis = axisMap.get(series.axisId);
      if (!axis) return null;
      return { config: series.config, axis, points: series.points };
    })
    .filter(entry => entry != null);
  if (plottedSeries.length === 0) {
    return '';
  }
  const axesMarkup = adjustedAxes.map(axis => renderYAxis(axis, dims)).join('');
  // Allow caller to supply a custom tick builder (e.g. hourly ticks for short windows).
  const tickBuilder = typeof chartOptions.xAxisTickBuilder === 'function' ? chartOptions.xAxisTickBuilder : buildMidnightTicks;
  const tickFormatter = typeof chartOptions.xAxisTickFormatter === 'function' ? chartOptions.xAxisTickFormatter : formatCompactDate;
  const ticks = tickBuilder(nowMs, windowMs);
  const xAxisMarkup = renderXAxis(dims, domainStart, domainEnd, ticks, { labelFormatter: tickFormatter });

  const seriesMarkup = plottedSeries
    .map(series =>
      renderTelemetrySeries(series.config, series.points, series.axis, dims, domainStart, domainEnd, {
        lineReducer: chartOptions.lineReducer,
      }),
    )
    .join('');
  const legendItems = plottedSeries
    .map(series => {
      const legendLabel = stringOrNull(series.config.legend) ?? series.config.label;
      return `
        <span class="node-detail__chart-legend-item">
          <span class="node-detail__chart-legend-swatch" style="background:${series.config.color}"></span>
          <span class="node-detail__chart-legend-text">${escapeHtml(legendLabel)}</span>
        </span>
      `;
    })
    .join('');
  const legendMarkup = legendItems
    ? `<div class="node-detail__chart-legend" aria-hidden="true">${legendItems}</div>`
    : '';
  return `
    <figure class="node-detail__chart">
      <figcaption class="node-detail__chart-header">
        <h4>${escapeHtml(spec.title)}</h4>
        <span>${escapeHtml(timeRangeLabel)}</span>
      </figcaption>
      <svg viewBox="0 0 ${dims.width} ${dims.height}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${escapeHtml(`${spec.title} over last seven days`)}">
        ${axesMarkup}
        ${xAxisMarkup}
        ${seriesMarkup}
      </svg>
      ${legendMarkup}
    </figure>
  `;
}
