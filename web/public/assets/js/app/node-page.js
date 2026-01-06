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

import { refreshNodeInformation } from './node-details.js';
import {
  extractChatMessageMetadata,
  formatChatChannelTag,
  formatChatMessagePrefix,
  formatChatPresetTag,
} from './chat-format.js';
import {
  fmtAlt,
  fmtCurrent,
  fmtHumidity,
  fmtPressure,
  fmtTemperature,
  fmtTx,
} from './short-info-telemetry.js';

const DEFAULT_FETCH_OPTIONS = Object.freeze({ cache: 'no-store' });
const MESSAGE_LIMIT = 50;
const RENDER_WAIT_INTERVAL_MS = 20;
const RENDER_WAIT_TIMEOUT_MS = 500;
const NEIGHBOR_ROLE_FETCH_CONCURRENCY = 4;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const TELEMETRY_WINDOW_MS = DAY_MS * 7;
const DEFAULT_CHART_DIMENSIONS = Object.freeze({ width: 660, height: 360 });
const DEFAULT_CHART_MARGIN = Object.freeze({ top: 28, right: 80, bottom: 64, left: 80 });
const TRACE_LIMIT = 200;
/**
 * Telemetry chart definitions describing axes and series metadata.
 *
 * @type {Array<Object>}
 */
const TELEMETRY_CHART_SPECS = Object.freeze([
  {
    id: 'power',
    title: 'Power metrics',
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
      {
        id: 'current',
        position: 'rightSecondary',
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
      {
        id: 'channelSecondary',
        position: 'right',
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
        axis: 'channelSecondary',
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
        position: 'right',
        label: 'Humidity (%)',
        min: 0,
        max: 100,
        ticks: 4,
        color: '#91bfdb',
        visible: true,
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

/**
 * Convert a candidate value into a trimmed string.
 *
 * @param {*} value Raw value.
 * @returns {string|null} Trimmed string or ``null``.
 */
function stringOrNull(value) {
  if (value == null) return null;
  const str = String(value).trim();
  return str.length === 0 ? null : str;
}

/**
 * Attempt to coerce a value into a finite number.
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
 * Escape HTML sensitive characters from the provided string.
 *
 * @param {string} input Raw HTML string.
 * @returns {string} Escaped HTML representation.
 */
function escapeHtml(input) {
  const str = input == null ? '' : String(input);
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Build a canonical node detail path for hyperlinking long names.
 *
 * @param {string|null} identifier Node identifier.
 * @returns {string|null} Node detail path.
 */
function buildNodeDetailHref(identifier) {
  const value = stringOrNull(identifier);
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const body = trimmed.startsWith('!') ? trimmed.slice(1) : trimmed;
  if (!body) return null;
  const encoded = encodeURIComponent(body);
  return `/nodes/!${encoded}`;
}

/**
 * Normalise a candidate identifier by enforcing the canonical ``!`` prefix.
 *
 * @param {*} identifier Candidate node identifier.
 * @returns {string|null} Canonical identifier or ``null`` when blank.
 */
function canonicalNodeIdentifier(identifier) {
  const value = stringOrNull(identifier);
  if (!value) return null;
  return value.startsWith('!') ? value : `!${value}`;
}

/**
 * Render a linked long name pointing to the node detail page.
 *
 * @param {string|null} longName Long name text.
 * @param {string|null} identifier Node identifier.
 * @param {{ className?: string }} [options] Rendering options.
 * @returns {string} Escaped HTML string.
 */
function renderNodeLongNameLink(longName, identifier, { className = 'node-long-link' } = {}) {
  const text = stringOrNull(longName);
  if (!text) return '';
  const href = buildNodeDetailHref(identifier);
  if (!href) {
    return escapeHtml(text);
  }
  const classAttr = className ? ` class="${escapeHtml(className)}"` : '';
  const canonicalIdentifier = canonicalNodeIdentifier(identifier);
  const dataAttrs = canonicalIdentifier
    ? ` data-node-detail-link="true" data-node-id="${escapeHtml(canonicalIdentifier)}"`
    : ' data-node-detail-link="true"';
  return `<a${classAttr} href="${href}"${dataAttrs}>${escapeHtml(text)}</a>`;
}

/**
 * Format a frequency value using MHz units when a numeric reading is
 * available. Non-numeric input is passed through unchanged.
 *
 * @param {*} value Raw frequency value.
 * @returns {string|null} Formatted frequency string or ``null``.
 */
function formatFrequency(value) {
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
 * Format a battery reading as a percentage with a single decimal place.
 *
 * @param {*} value Raw battery value.
 * @returns {string|null} Formatted percentage or ``null``.
 */
function formatBattery(value) {
  const numeric = numberOrNull(value);
  if (numeric == null) return null;
  return `${numeric.toFixed(1)}%`;
}

/**
 * Format a voltage reading with two decimal places.
 *
 * @param {*} value Raw voltage value.
 * @returns {string|null} Formatted voltage string.
 */
function formatVoltage(value) {
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
function formatUptime(value) {
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
 * Format a numeric timestamp expressed in seconds since the epoch.
 *
 * @param {*} value Raw timestamp value.
 * @param {string|null} isoFallback ISO formatted string to prefer.
 * @returns {string|null} ISO timestamp string.
 */
function formatTimestamp(value, isoFallback = null) {
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
 * Pad a numeric value with leading zeros.
 *
 * @param {number} value Numeric value to pad.
 * @returns {string} Padded string representation.
 */
function padTwo(value) {
  return String(Math.trunc(Math.abs(Number(value)))).padStart(2, '0');
}

/**
 * Format a timestamp for the message log using ``YYYY-MM-DD HH:MM`` in the
 * local time zone.
 *
 * @param {*} value Seconds since the epoch.
 * @param {string|null} isoFallback ISO timestamp to prefer when available.
 * @returns {string|null} Formatted timestamp string or ``null``.
 */
function formatMessageTimestamp(value, isoFallback = null) {
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
/**
 * Format a hardware model string while hiding unset placeholders.
 *
 * @param {*} value Raw hardware model value.
 * @returns {string} Sanitised hardware model string.
 */
function formatHardwareModel(value) {
  const text = stringOrNull(value);
  if (!text || text.toUpperCase() === 'UNSET') {
    return '';
  }
  return text;
}

/**
 * Format a coordinate with consistent precision.
 *
 * @param {*} value Raw coordinate value.
 * @param {number} [precision=5] Decimal precision applied to the coordinate.
 * @returns {string} Formatted coordinate string.
 */
function formatCoordinate(value, precision = 5) {
  const numeric = numberOrNull(value);
  if (numeric == null) return '';
  return numeric.toFixed(precision);
}

/**
 * Convert an absolute timestamp into a relative time description.
 *
 * @param {*} value Raw timestamp expressed in seconds since the epoch.
 * @param {number} [referenceSeconds] Optional reference timestamp in seconds.
 * @returns {string} Relative time string or an empty string when unavailable.
 */
function formatRelativeSeconds(value, referenceSeconds = Date.now() / 1000) {
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
 * Format a duration expressed in seconds using a compact human readable form.
 *
 * @param {*} value Raw duration in seconds.
 * @returns {string} Human readable duration string or an empty string.
 */
function formatDurationSeconds(value) {
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
 * @returns {string} Formatted SNR string or an empty string.
 */
function formatSnr(value) {
  const numeric = numberOrNull(value);
  if (numeric == null) return '';
  return `${numeric.toFixed(1)} dB`;
}

/**
 * Convert a timestamp that may be expressed in seconds or milliseconds into
 * milliseconds.
 *
 * @param {*} value Candidate timestamp.
 * @returns {number|null} Timestamp in milliseconds or ``null``.
 */
function toTimestampMs(value) {
  const numeric = numberOrNull(value);
  if (numeric == null) return null;
  if (numeric > 1_000_000_000_000) {
    return numeric;
  }
  return numeric * 1000;
}

/**
 * Resolve the canonical telemetry timestamp for a snapshot record.
 *
 * @param {*} snapshot Telemetry snapshot payload.
 * @returns {number|null} Timestamp in milliseconds.
 */
function resolveSnapshotTimestamp(snapshot) {
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
 * Clamp a numeric value between ``min`` and ``max``.
 *
 * @param {number} value Value to clamp.
 * @param {number} min Minimum bound.
 * @param {number} max Maximum bound.
 * @returns {number} Clamped numeric value.
 */
function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Convert a hex colour into an rgba string with the specified alpha.
 *
 * @param {string} hex Hex colour string.
 * @param {number} alpha Alpha component between 0 and 1.
 * @returns {string} RGBA CSS string.
 */
function hexToRgba(hex, alpha = 1) {
  const normalised = stringOrNull(hex)?.replace(/^#/, '') ?? '';
  if (!(normalised.length === 6 || normalised.length === 3)) {
    return `rgba(0, 0, 0, ${alpha})`;
  }
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
 * Format a timestamp as a day-of-month string using the local time zone.
 *
 * @param {number} timestampMs Timestamp expressed in milliseconds.
 * @returns {string} Compact date string.
 */
function formatCompactDate(timestampMs) {
  const date = new Date(timestampMs);
  if (Number.isNaN(date.getTime())) return '';
  const day = padTwo(date.getDate());
  return day;
}

/**
 * Build midnight tick timestamps covering the floating telemetry window.
 *
 * @param {number} nowMs Reference timestamp in milliseconds.
 * @returns {Array<number>} Midnight timestamps within the window.
 */
function buildMidnightTicks(nowMs, windowMs = TELEMETRY_WINDOW_MS) {
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
 * @returns {Array<number>} Hourly tick timestamps.
 */
function buildHourlyTicks(nowMs, windowMs = DAY_MS) {
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
 * @param {number} [count=4] Number of tick segments.
 * @returns {Array<number>} Tick values including the extrema.
 */
function buildLinearTicks(min, max, count = 4) {
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
 * @param {number} min Minimum domain value.
 * @param {number} max Maximum domain value.
 * @returns {Array<number>} Tick values distributed across powers of 10.
 */
function buildLogTicks(min, max) {
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
 * Format tick labels using compact units for better readability.
 *
 * @param {number} value Tick value.
 * @param {Object} axis Axis descriptor.
 * @returns {string} Formatted label.
 */
function formatAxisTick(value, axis) {
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

/**
 * Format a gas resistance reading using sensible prefixes with the Ω symbol.
 *
 * @param {number} value Resistance value in Ohms.
 * @returns {string} Formatted resistance string.
 */
function formatGasResistance(value) {
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
 * Format a data point value for tooltip display.
 *
 * @param {Object} seriesConfig Series configuration.
 * @param {number} value Numeric data point value.
 * @returns {string} Formatted value string.
 */
function formatSeriesPointValue(seriesConfig, value) {
  const numeric = numberOrNull(value);
  if (numeric == null) return '';
  if (typeof seriesConfig.valueFormatter === 'function') {
    return seriesConfig.valueFormatter(numeric);
  }
  return numeric.toString();
}

/**
 * Determine the layout metrics for the provided chart specification.
 *
 * @param {Object} spec Chart specification.
 * @returns {{width: number, height: number, margin: Object, innerWidth: number, innerHeight: number, chartTop: number, chartBottom: number}}
 *   Chart dimensions.
 */
function createChartDimensions(spec) {
  const margin = { ...DEFAULT_CHART_MARGIN };
  if (spec.axes.some(axis => axis.position === 'leftSecondary')) {
    margin.left += 36;
  }
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
 * Collect candidate containers that may hold telemetry values for a snapshot.
 *
 * @param {Object} snapshot Telemetry snapshot payload.
 * @returns {Array<Object>} Container objects inspected for telemetry fields.
 */
function collectSnapshotContainers(snapshot) {
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
 * Extract the first numeric telemetry value that matches one of the provided
 * field names.
 *
 * @param {*} snapshot Telemetry payload.
 * @param {Array<string>} fields Candidate property names.
 * @returns {number|null} Extracted numeric value or ``null``.
 */
function extractSnapshotValue(snapshot, fields) {
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
 * Build data points for a series constrained to the seven-day window.
 *
 * @param {Array<{timestamp: number, snapshot: Object}>} entries Telemetry entries.
 * @param {Array<string>} fields Candidate metric names.
 * @param {number} domainStart Window start in milliseconds.
 * @param {number} domainEnd Window end in milliseconds.
 * @returns {Array<{timestamp: number, value: number}>} Series points sorted by timestamp.
 */
function buildSeriesPoints(entries, fields, domainStart, domainEnd) {
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
 * Resolve the effective axis maximum when upper overflow is allowed.
 *
 * @param {Object} axis Axis descriptor.
 * @param {Array<{axisId: string, points: Array<{timestamp: number, value: number}>}>} seriesEntries Series entries.
 * @returns {number} Effective axis max.
 */
function resolveAxisMax(axis, seriesEntries) {
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
 * Build a telemetry chart model from a specification and series entries.
 *
 * @param {Object} spec Chart specification.
 * @param {Array<{timestamp: number, snapshot: Object}>} entries Telemetry entries.
 * @param {number} nowMs Reference timestamp.
 * @param {Object} chartOptions Rendering overrides.
 * @returns {Object|null} Chart model or ``null`` when empty.
 */
function buildTelemetryChartModel(spec, entries, nowMs, chartOptions = {}) {
  const windowMs = Number.isFinite(chartOptions.windowMs) && chartOptions.windowMs > 0 ? chartOptions.windowMs : TELEMETRY_WINDOW_MS;
  const timeRangeLabel = stringOrNull(chartOptions.timeRangeLabel) ?? 'Last 7 days';
  const domainEnd = nowMs;
  const domainStart = nowMs - windowMs;
  const dims = createChartDimensions(spec);
  const seriesEntries = spec.series
    .map(series => {
      const points = buildSeriesPoints(entries, series.fields, domainStart, domainEnd);
      if (points.length === 0) return null;
      return { config: series, axisId: series.axis, points };
    })
    .filter(entry => entry != null);
  if (seriesEntries.length === 0) {
    return null;
  }
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
    return null;
  }
  const tickBuilder = typeof chartOptions.xAxisTickBuilder === 'function' ? chartOptions.xAxisTickBuilder : buildMidnightTicks;
  const tickFormatter = typeof chartOptions.xAxisTickFormatter === 'function' ? chartOptions.xAxisTickFormatter : formatCompactDate;
  return {
    id: spec.id,
    title: spec.title,
    timeRangeLabel,
    domainStart,
    domainEnd,
    dims,
    axes: adjustedAxes,
    seriesEntries: plottedSeries,
    ticks: tickBuilder(nowMs, windowMs),
    tickFormatter,
    lineReducer: typeof chartOptions.lineReducer === 'function' ? chartOptions.lineReducer : null,
  };
}

/**
 * Render a telemetry chart container for a chart model.
 *
 * @param {Object} model Chart model.
 * @returns {string} Chart markup.
 */
function renderTelemetryChartMarkup(model) {
  const legendItems = model.seriesEntries
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
  const ariaLabel = `${model.title} over last seven days`;
  return `
    <figure class="node-detail__chart" data-telemetry-chart-id="${escapeHtml(model.id)}">
      <figcaption class="node-detail__chart-header">
        <h4>${escapeHtml(model.title)}</h4>
        <span>${escapeHtml(model.timeRangeLabel)}</span>
      </figcaption>
      <div class="node-detail__chart-plot" data-telemetry-plot role="img" aria-label="${escapeHtml(ariaLabel)}"></div>
      ${legendMarkup}
    </figure>
  `;
}

/**
 * Build a sorted timestamp index shared across series entries.
 *
 * @param {Array<Object>} seriesEntries Plotted series entries.
 * @param {Function|null} lineReducer Optional line reducer.
 * @returns {{timestamps: Array<number>, indexByTimestamp: Map<number, number>}} Timestamp index.
 */
function buildChartTimestampIndex(seriesEntries, lineReducer) {
  const timestampSet = new Set();
  for (const entry of seriesEntries) {
    if (!entry || !Array.isArray(entry.points)) continue;
    entry.points.forEach(point => {
      if (point && Number.isFinite(point.timestamp)) {
        timestampSet.add(point.timestamp);
      }
    });
    if (typeof lineReducer === 'function') {
      const reduced = lineReducer(entry.points);
      if (Array.isArray(reduced)) {
        reduced.forEach(point => {
          if (point && Number.isFinite(point.timestamp)) {
            timestampSet.add(point.timestamp);
          }
        });
      }
    }
  }
  const timestamps = Array.from(timestampSet).sort((a, b) => a - b);
  const indexByTimestamp = new Map(timestamps.map((ts, idx) => [ts, idx]));
  return { timestamps, indexByTimestamp };
}

/**
 * Convert a list of points into an aligned values array.
 *
 * @param {Array<{timestamp: number, value: number}>} points Series points.
 * @param {Map<number, number>} indexByTimestamp Timestamp index.
 * @param {number} length Length of the output array.
 * @returns {Array<number|null>} Values aligned to timestamps.
 */
function mapSeriesValues(points, indexByTimestamp, length) {
  const values = Array.from({ length }, () => null);
  if (!Array.isArray(points)) {
    return values;
  }
  for (const point of points) {
    if (!point || !Number.isFinite(point.timestamp)) continue;
    const idx = indexByTimestamp.get(point.timestamp);
    if (idx == null) continue;
    values[idx] = Number.isFinite(point.value) ? point.value : null;
  }
  return values;
}

/**
 * Build uPlot series and data arrays for a chart model.
 *
 * @param {Object} model Chart model.
 * @returns {{data: Array<Array<number|null>>, series: Array<Object>}} uPlot data and series config.
 */
function buildTelemetryChartData(model) {
  const { timestamps, indexByTimestamp } = buildChartTimestampIndex(model.seriesEntries, model.lineReducer);
  const data = [timestamps];
  const series = [{ label: 'Time' }];

  model.seriesEntries.forEach(entry => {
    const baseConfig = {
      label: entry.config.label,
      scale: entry.axis.id,
    };
    if (model.lineReducer) {
      const reducedPoints = model.lineReducer(entry.points);
      const linePoints = Array.isArray(reducedPoints) && reducedPoints.length > 0 ? reducedPoints : entry.points;
      const lineValues = mapSeriesValues(linePoints, indexByTimestamp, timestamps.length);
      series.push({
        ...baseConfig,
        stroke: hexToRgba(entry.config.color, 0.5),
        width: 1.5,
        points: { show: false },
      });
      data.push(lineValues);

      const pointValues = mapSeriesValues(entry.points, indexByTimestamp, timestamps.length);
      series.push({
        ...baseConfig,
        stroke: entry.config.color,
        width: 0,
        points: { show: true, size: 6, width: 1 },
      });
      data.push(pointValues);
    } else {
      const values = mapSeriesValues(entry.points, indexByTimestamp, timestamps.length);
      series.push({
        ...baseConfig,
        stroke: entry.config.color,
        width: 1.5,
        points: { show: true, size: 6, width: 1 },
      });
      data.push(values);
    }
  });

  return { data, series };
}

/**
 * Build uPlot chart configuration and data for a telemetry chart.
 *
 * @param {Object} model Chart model.
 * @returns {{options: Object, data: Array<Array<number|null>>}} uPlot config and data.
 */
function buildUPlotChartConfig(model, { width, height, axisColor, gridColor } = {}) {
  const { data, series } = buildTelemetryChartData(model);
  const fallbackWidth = Math.round(model.dims.width * 1.8);
  const resolvedWidth = Number.isFinite(width) && width > 0 ? width : fallbackWidth;
  const resolvedHeight = Number.isFinite(height) && height > 0 ? height : model.dims.height;
  const axisStroke = stringOrNull(axisColor) ?? '#5c6773';
  const gridStroke = stringOrNull(gridColor) ?? 'rgba(12, 15, 18, 0.08)';
  const axes = [
    {
      scale: 'x',
      side: 2,
      stroke: axisStroke,
      grid: { show: true, stroke: gridStroke },
      splits: () => model.ticks,
      values: (u, splits) => splits.map(value => model.tickFormatter(value)),
    },
  ];
  const scales = {
    x: {
      time: true,
      range: () => [model.domainStart, model.domainEnd],
    },
  };

  model.axes.forEach(axis => {
    const ticks = axis.scale === 'log'
      ? buildLogTicks(axis.min, axis.max)
      : buildLinearTicks(axis.min, axis.max, axis.ticks);
    const side = axis.position === 'right' || axis.position === 'rightSecondary' ? 1 : 3;
    axes.push({
      scale: axis.id,
      side,
      show: axis.visible !== false,
      stroke: axisStroke,
      grid: { show: false },
      label: axis.label,
      splits: () => ticks,
      values: (u, splits) => splits.map(value => formatAxisTick(value, axis)),
    });
    scales[axis.id] = {
      distr: axis.scale === 'log' ? 3 : 1,
      log: axis.scale === 'log' ? 10 : undefined,
      range: () => [axis.min, axis.max],
    };
  });

  return {
    options: {
      width: resolvedWidth,
      height: resolvedHeight,
      padding: [
        model.dims.margin.top,
        model.dims.margin.right,
        model.dims.margin.bottom,
        model.dims.margin.left,
      ],
      legend: { show: false },
      series,
      axes,
      scales,
    },
    data,
  };
}

/**
 * Instantiate uPlot charts for the provided chart models.
 *
 * @param {Array<Object>} chartModels Chart models to render.
 * @param {{root?: ParentNode, uPlotImpl?: Function}} [options] Rendering options.
 * @returns {Array<Object>} Instantiated uPlot charts.
 */
export function mountTelemetryCharts(chartModels, { root, uPlotImpl } = {}) {
  if (!Array.isArray(chartModels) || chartModels.length === 0) {
    return [];
  }
  const host = root ?? globalThis.document;
  if (!host || typeof host.querySelector !== 'function') {
    return [];
  }
  const uPlotCtor = typeof uPlotImpl === 'function' ? uPlotImpl : globalThis.uPlot;
  if (typeof uPlotCtor !== 'function') {
    console.warn('uPlot is unavailable; telemetry charts will not render.');
    return [];
  }

  const instances = [];
  const colorRoot = host?.ownerDocument?.body ?? host?.body ?? globalThis.document?.body ?? null;
  const axisColor = colorRoot && typeof globalThis.getComputedStyle === 'function'
    ? globalThis.getComputedStyle(colorRoot).getPropertyValue('--muted').trim()
    : null;
  const gridColor = colorRoot && typeof globalThis.getComputedStyle === 'function'
    ? globalThis.getComputedStyle(colorRoot).getPropertyValue('--line').trim()
    : null;
  chartModels.forEach(model => {
    const container = host.querySelector(`[data-telemetry-chart-id="${model.id}"]`);
    if (!container) return;
    const plotRoot = container.querySelector('[data-telemetry-plot]');
    if (!plotRoot) return;
    plotRoot.innerHTML = '';
    const plotWidth = plotRoot.clientWidth || plotRoot.getBoundingClientRect?.().width;
    const plotHeight = plotRoot.clientHeight || plotRoot.getBoundingClientRect?.().height;
    const { options, data } = buildUPlotChartConfig(model, {
      width: plotWidth ? Math.round(plotWidth) : undefined,
      height: plotHeight ? Math.round(plotHeight) : undefined,
      axisColor: axisColor || undefined,
      gridColor: gridColor || undefined,
    });
    const instance = new uPlotCtor(options, data, plotRoot);
    instance.__potatoMeshRoot = plotRoot;
    instances.push(instance);
  });
  registerTelemetryChartResize(instances);
  return instances;
}

const telemetryResizeRegistry = new Set();
const telemetryResizeObservers = new WeakMap();
let telemetryResizeListenerAttached = false;
let telemetryResizeDebounceId = null;
const TELEMETRY_RESIZE_DEBOUNCE_MS = 120;

function resizeUPlotInstance(instance) {
  if (!instance || typeof instance.setSize !== 'function') {
    return;
  }
  const root = instance.__potatoMeshRoot ?? instance.root ?? null;
  if (!root) return;
  const rect = typeof root.getBoundingClientRect === 'function' ? root.getBoundingClientRect() : null;
  const width = Number.isFinite(root.clientWidth) ? root.clientWidth : rect?.width;
  const height = Number.isFinite(root.clientHeight) ? root.clientHeight : rect?.height;
  if (!width || !height) return;
  instance.setSize({ width: Math.round(width), height: Math.round(height) });
}

function registerTelemetryChartResize(instances) {
  if (!Array.isArray(instances) || instances.length === 0) {
    return;
  }
  const scheduleResize = () => {
    if (telemetryResizeDebounceId != null) {
      clearTimeout(telemetryResizeDebounceId);
    }
    telemetryResizeDebounceId = setTimeout(() => {
      telemetryResizeDebounceId = null;
      telemetryResizeRegistry.forEach(instance => resizeUPlotInstance(instance));
    }, TELEMETRY_RESIZE_DEBOUNCE_MS);
  };
  instances.forEach(instance => {
    telemetryResizeRegistry.add(instance);
    resizeUPlotInstance(instance);
    if (typeof globalThis.ResizeObserver === 'function') {
      if (telemetryResizeObservers.has(instance)) return;
      const observer = new globalThis.ResizeObserver(scheduleResize);
      telemetryResizeObservers.set(instance, observer);
      const root = instance.__potatoMeshRoot ?? instance.root ?? null;
      if (root && typeof observer.observe === 'function') {
        observer.observe(root);
      }
    }
  });
  if (!telemetryResizeListenerAttached && typeof globalThis.addEventListener === 'function') {
    globalThis.addEventListener('resize', () => {
      scheduleResize();
    });
    telemetryResizeListenerAttached = true;
  }
}

function defaultLoadUPlot({ documentRef, onLoad }) {
  if (!documentRef || typeof documentRef.querySelector !== 'function') {
    return false;
  }
  const existing = documentRef.querySelector('script[data-uplot-loader="true"]');
  if (existing) {
    if (existing.dataset.loaded === 'true' && typeof onLoad === 'function') {
      onLoad();
    } else if (typeof existing.addEventListener === 'function' && typeof onLoad === 'function') {
      existing.addEventListener('load', onLoad, { once: true });
    }
    return true;
  }
  if (typeof documentRef.createElement !== 'function') {
    return false;
  }
  const script = documentRef.createElement('script');
  script.src = '/assets/vendor/uplot/uPlot.iife.min.js';
  script.defer = true;
  script.dataset.uplotLoader = 'true';
  if (typeof script.addEventListener === 'function') {
    script.addEventListener('load', () => {
      script.dataset.loaded = 'true';
      if (typeof onLoad === 'function') {
        onLoad();
      }
    });
  }
  const head = documentRef.head ?? documentRef.body;
  if (head && typeof head.appendChild === 'function') {
    head.appendChild(script);
    return true;
  }
  return false;
}

/**
 * Mount telemetry charts, retrying briefly if uPlot has not loaded yet.
 *
 * @param {Array<Object>} chartModels Chart models to render.
 * @param {{root?: ParentNode, uPlotImpl?: Function, loadUPlot?: Function}} [options] Rendering options.
 * @returns {Array<Object>} Instantiated uPlot charts.
 */
export function mountTelemetryChartsWithRetry(chartModels, { root, uPlotImpl, loadUPlot } = {}) {
  const instances = mountTelemetryCharts(chartModels, { root, uPlotImpl });
  if (instances.length > 0 || typeof uPlotImpl === 'function') {
    return instances;
  }
  const host = root ?? globalThis.document;
  if (!host || typeof host.querySelector !== 'function') {
    return instances;
  }
  let mounted = false;
  let attempts = 0;
  const maxAttempts = 10;
  const retryDelayMs = 50;
  const retry = () => {
    if (mounted) return;
    attempts += 1;
    const next = mountTelemetryCharts(chartModels, { root, uPlotImpl });
    if (next.length > 0) {
      mounted = true;
      return;
    }
    if (attempts >= maxAttempts) {
      return;
    }
    setTimeout(retry, retryDelayMs);
  };
  const loadFn = typeof loadUPlot === 'function' ? loadUPlot : defaultLoadUPlot;
  loadFn({
    documentRef: host.ownerDocument ?? globalThis.document,
    onLoad: () => {
      const next = mountTelemetryCharts(chartModels, { root, uPlotImpl });
      if (next.length > 0) {
        mounted = true;
      }
    },
  });
  setTimeout(retry, 0);
  return instances;
}

/**
 * Create chart markup and models for telemetry charts.
 *
 * @param {Object} node Normalised node payload.
 * @param {{ nowMs?: number, chartOptions?: Object }} [options] Rendering options.
 * @returns {{chartsHtml: string, chartModels: Array<Object>}} Chart markup and models.
 */
export function createTelemetryCharts(node, { nowMs = Date.now(), chartOptions = {} } = {}) {
  const telemetrySource = node?.rawSources?.telemetry;
  const snapshotHistory = Array.isArray(node?.rawSources?.telemetrySnapshots) && node.rawSources.telemetrySnapshots.length > 0
    ? node.rawSources.telemetrySnapshots
    : null;
  const aggregatedSnapshots = Array.isArray(telemetrySource?.snapshots)
    ? telemetrySource.snapshots
    : null;
  const rawSnapshots = snapshotHistory ?? aggregatedSnapshots;
  if (!Array.isArray(rawSnapshots) || rawSnapshots.length === 0) {
    return { chartsHtml: '', chartModels: [] };
  }
  const entries = rawSnapshots
    .map(snapshot => {
      const timestamp = resolveSnapshotTimestamp(snapshot);
      if (timestamp == null) return null;
      return { timestamp, snapshot };
    })
    .filter(entry => entry != null && entry.timestamp >= nowMs - TELEMETRY_WINDOW_MS && entry.timestamp <= nowMs)
    .sort((a, b) => a.timestamp - b.timestamp);
  if (entries.length === 0) {
    return { chartsHtml: '', chartModels: [] };
  }
  const chartModels = TELEMETRY_CHART_SPECS
    .map(spec => buildTelemetryChartModel(spec, entries, nowMs, chartOptions))
    .filter(model => model != null);
  if (chartModels.length === 0) {
    return { chartsHtml: '', chartModels: [] };
  }
  const chartsHtml = `
    <section class="node-detail__charts">
      <div class="node-detail__charts-grid">
        ${chartModels.map(model => renderTelemetryChartMarkup(model)).join('')}
      </div>
    </section>
  `;
  return { chartsHtml, chartModels };
}

/**
 * Render the telemetry charts for the supplied node when telemetry snapshots
 * exist.
 *
 * @param {Object} node Normalised node payload.
 * @param {{ nowMs?: number }} [options] Rendering options.
 * @returns {string} Chart grid markup or an empty string.
 */
export function renderTelemetryCharts(node, { nowMs = Date.now(), chartOptions = {} } = {}) {
  return createTelemetryCharts(node, { nowMs, chartOptions }).chartsHtml;
}

/**
 * Normalise a node identifier for consistent lookups.
 *
 * @param {*} identifier Candidate identifier.
 * @returns {string|null} Lower-case identifier or ``null`` when invalid.
 */
function normalizeNodeId(identifier) {
  const value = stringOrNull(identifier);
  return value ? value.toLowerCase() : null;
}

/**
 * Register a role candidate within the supplied index.
 *
 * @param {{
 *   byId: Map<string, string>,
 *   byNum: Map<number, string>,
 *   detailsById: Map<string, Object>,
 *   detailsByNum: Map<number, Object>,
 * }} index Role index maps.
 * @param {{
 *   identifier?: *,
 *   numericId?: *,
 *   role?: *,
 *   shortName?: *,
 *   longName?: *,
 * }} payload Role candidate payload.
 * @returns {void}
 */
function registerRoleCandidate(
  index,
  { identifier = null, numericId = null, role = null, shortName = null, longName = null } = {},
) {
  if (!index || typeof index !== 'object') return;

  if (!(index.byId instanceof Map)) index.byId = new Map();
  if (!(index.byNum instanceof Map)) index.byNum = new Map();
  if (!(index.detailsById instanceof Map)) index.detailsById = new Map();
  if (!(index.detailsByNum instanceof Map)) index.detailsByNum = new Map();

  const resolvedRole = stringOrNull(role);
  const resolvedShort = stringOrNull(shortName);
  const resolvedLong = stringOrNull(longName);

  const idKey = normalizeNodeId(identifier);
  const numKey = numberOrNull(numericId);

  if (resolvedRole) {
    if (idKey && !index.byId.has(idKey)) {
      index.byId.set(idKey, resolvedRole);
    }
    if (numKey != null && !index.byNum.has(numKey)) {
      index.byNum.set(numKey, resolvedRole);
    }
  }

  const applyDetails = (existing, keyType) => {
    const current = existing instanceof Map && (keyType === 'id' ? idKey : numKey) != null
      ? existing.get(keyType === 'id' ? idKey : numKey)
      : null;
    const merged = current && typeof current === 'object' ? { ...current } : {};
    if (resolvedRole && !merged.role) merged.role = resolvedRole;
    if (resolvedShort && !merged.shortName) merged.shortName = resolvedShort;
    if (resolvedLong && !merged.longName) merged.longName = resolvedLong;
    if (keyType === 'id' && idKey && merged.identifier == null) merged.identifier = idKey;
    if (keyType === 'num' && numKey != null && merged.numericId == null) {
      merged.numericId = numKey;
    }
    return merged;
  };

  if (idKey) {
    const merged = applyDetails(index.detailsById, 'id');
    if (Object.keys(merged).length > 0) {
      index.detailsById.set(idKey, merged);
    }
  }
  if (numKey != null) {
    const merged = applyDetails(index.detailsByNum, 'num');
    if (Object.keys(merged).length > 0) {
      index.detailsByNum.set(numKey, merged);
    }
  }
}

/**
 * Clone an existing role index into fresh map instances.
 *
 * @param {Object|null|undefined} index Original role index maps.
 * @returns {{byId: Map<string, string>, byNum: Map<number, string>, detailsById: Map<string, Object>, detailsByNum: Map<number, Object>}}
 *   Cloned maps with identical entries.
 */
function cloneRoleIndex(index) {
  return {
    byId: index?.byId instanceof Map ? new Map(index.byId) : new Map(),
    byNum: index?.byNum instanceof Map ? new Map(index.byNum) : new Map(),
    detailsById: index?.detailsById instanceof Map ? new Map(index.detailsById) : new Map(),
    detailsByNum: index?.detailsByNum instanceof Map ? new Map(index.detailsByNum) : new Map(),
  };
}

/**
 * Resolve a role from the provided index using identifier or numeric keys.
 *
 * @param {{byId?: Map<string, string>, byNum?: Map<number, string>}|null} index Role lookup maps.
 * @param {{ identifier?: *, numericId?: * }} payload Lookup payload.
 * @returns {string|null} Resolved role string or ``null`` when unavailable.
 */
function lookupRole(index, { identifier = null, numericId = null } = {}) {
  if (!index || typeof index !== 'object') return null;
  const idKey = normalizeNodeId(identifier);
  if (idKey && index.byId instanceof Map && index.byId.has(idKey)) {
    return index.byId.get(idKey) ?? null;
  }
  const numKey = numberOrNull(numericId);
  if (numKey != null && index.byNum instanceof Map && index.byNum.has(numKey)) {
    return index.byNum.get(numKey) ?? null;
  }
  return null;
}

/**
 * Resolve neighbour metadata from the provided index.
 *
 * @param {{
 *   detailsById?: Map<string, Object>,
 *   detailsByNum?: Map<number, Object>,
 *   byId?: Map<string, string>,
 *   byNum?: Map<number, string>,
 * }|null} index Role lookup maps.
 * @param {{ identifier?: *, numericId?: * }} payload Lookup payload.
 * @returns {{ role?: string|null, shortName?: string|null, longName?: string|null }|null}
 *   Resolved metadata object or ``null`` when unavailable.
 */
function lookupNeighborDetails(index, { identifier = null, numericId = null } = {}) {
  if (!index || typeof index !== 'object') return null;
  const idKey = normalizeNodeId(identifier);
  const numKey = numberOrNull(numericId);

  const details = {};
  if (idKey && index.detailsById instanceof Map && index.detailsById.has(idKey)) {
    Object.assign(details, index.detailsById.get(idKey));
  }
  if (numKey != null && index.detailsByNum instanceof Map && index.detailsByNum.has(numKey)) {
    Object.assign(details, index.detailsByNum.get(numKey));
  }

  if (!details.role) {
    const role = lookupRole(index, { identifier, numericId });
    if (role) details.role = role;
  }

  if (Object.keys(details).length === 0) {
    return null;
  }

  return {
    role: details.role ?? null,
    shortName: details.shortName ?? null,
    longName: details.longName ?? null,
  };
}

/**
 * Gather role hints from neighbor entries into the provided index.
 *
 * @param {{
 *   byId: Map<string, string>,
 *   byNum: Map<number, string>,
 *   detailsById: Map<string, Object>,
 *   detailsByNum: Map<number, Object>,
 * }} index Role index maps.
 * @param {Array<Object>} neighbors Raw neighbor entries.
 * @returns {Set<string>} Normalized identifiers missing from the index.
 */
function seedNeighborRoleIndex(index, neighbors) {
  const missing = new Set();
  if (!Array.isArray(neighbors)) {
    return missing;
  }
  neighbors.forEach(entry => {
    if (!entry || typeof entry !== 'object') {
      return;
    }
    registerRoleCandidate(index, {
      identifier: entry.neighbor_id ?? entry.neighborId,
      numericId: entry.neighbor_num ?? entry.neighborNum,
      role: entry.neighbor_role ?? entry.neighborRole,
      shortName:
        entry.neighbor_short_name
          ?? entry.neighborShortName
          ?? entry.neighbor?.short_name
          ?? entry.neighbor?.shortName
          ?? null,
      longName:
        entry.neighbor_long_name
          ?? entry.neighborLongName
          ?? entry.neighbor?.long_name
          ?? entry.neighbor?.longName
          ?? null,
    });
    registerRoleCandidate(index, {
      identifier: entry.node_id ?? entry.nodeId,
      numericId: entry.node_num ?? entry.nodeNum,
      role: entry.node_role ?? entry.nodeRole,
      shortName:
        entry.node_short_name
          ?? entry.nodeShortName
          ?? entry.node?.short_name
          ?? entry.node?.shortName
          ?? null,
      longName:
        entry.node_long_name
          ?? entry.nodeLongName
          ?? entry.node?.long_name
          ?? entry.node?.longName
          ?? null,
    });
    if (entry.neighbor && typeof entry.neighbor === 'object') {
      registerRoleCandidate(index, {
        identifier: entry.neighbor.node_id ?? entry.neighbor.nodeId ?? entry.neighbor.id,
        numericId: entry.neighbor.node_num ?? entry.neighbor.nodeNum ?? entry.neighbor.num,
        role: entry.neighbor.role ?? entry.neighbor.roleName,
        shortName: entry.neighbor.short_name ?? entry.neighbor.shortName ?? null,
        longName: entry.neighbor.long_name ?? entry.neighbor.longName ?? null,
      });
    }
    if (entry.node && typeof entry.node === 'object') {
      registerRoleCandidate(index, {
        identifier: entry.node.node_id ?? entry.node.nodeId ?? entry.node.id,
        numericId: entry.node.node_num ?? entry.node.nodeNum ?? entry.node.num,
        role: entry.node.role ?? entry.node.roleName,
        shortName: entry.node.short_name ?? entry.node.shortName ?? null,
        longName: entry.node.long_name ?? entry.node.longName ?? null,
      });
    }
    const candidateIds = [
      entry.neighbor_id,
      entry.neighborId,
      entry.node_id,
      entry.nodeId,
      entry.neighbor?.node_id,
      entry.neighbor?.nodeId,
      entry.node?.node_id,
      entry.node?.nodeId,
    ];
    candidateIds.forEach(identifier => {
      const normalized = normalizeNodeId(identifier);
      if (normalized && !index.byId.has(normalized)) {
        missing.add(normalized);
      }
    });
  });
  return missing;
}

/**
 * Fetch node metadata for the supplied identifiers and merge it into the role index.
 *
 * @param {{byId: Map<string, string>, byNum: Map<number, string>, detailsById: Map<string, Object>, detailsByNum: Map<number, Object>}} index Role index maps.
 * @param {Map<string, *>} fetchIdMap Mapping of normalized identifiers to raw fetch identifiers.
 * @param {Function} fetchImpl Fetch implementation.
 * @param {string} [contextLabel='node metadata'] Context string used in warning logs.
 * @returns {Promise<void>} Completion promise.
 */
async function fetchNodeDetailsIntoIndex(index, fetchIdMap, fetchImpl, contextLabel = 'node metadata') {
  if (!(fetchIdMap instanceof Map) || fetchIdMap.size === 0) {
    return;
  }
  const fetchFn = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    return;
  }
  const tasks = [];
  for (const [, raw] of fetchIdMap.entries()) {
    const task = (async () => {
      try {
        const response = await fetchFn(`/api/nodes/${encodeURIComponent(raw)}`, DEFAULT_FETCH_OPTIONS);
        if (response.status === 404) {
          return;
        }
        if (!response.ok) {
          throw new Error(`Failed to load node information for ${raw} (HTTP ${response.status})`);
        }
        const payload = await response.json();
        registerRoleCandidate(index, {
          identifier:
            payload?.node_id
            ?? payload?.nodeId
            ?? payload?.id
            ?? raw,
          numericId: payload?.node_num ?? payload?.nodeNum ?? payload?.num ?? null,
          role: payload?.role ?? payload?.node_role ?? payload?.nodeRole ?? null,
          shortName: payload?.short_name ?? payload?.shortName ?? null,
          longName: payload?.long_name ?? payload?.longName ?? null,
        });
      } catch (error) {
        console.warn(`Failed to resolve ${contextLabel}`, error);
      }
    })();
    tasks.push(task);
  }
  if (tasks.length === 0) return;
  const batches = [];
  for (let i = 0; i < tasks.length; i += NEIGHBOR_ROLE_FETCH_CONCURRENCY) {
    batches.push(tasks.slice(i, i + NEIGHBOR_ROLE_FETCH_CONCURRENCY));
  }
  for (const batch of batches) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.all(batch);
  }
}

/**
 * Fetch missing neighbor role assignments using the nodes API.
 *
 * @param {{byId: Map<string, string>, byNum: Map<number, string>}} index Role index maps.
 * @param {Map<string, string>} fetchIdMap Mapping of normalized identifiers to raw fetch identifiers.
 * @param {Function} fetchImpl Fetch implementation.
 * @returns {Promise<void>} Completion promise.
 */
async function fetchMissingNeighborRoles(index, fetchIdMap, fetchImpl) {
  await fetchNodeDetailsIntoIndex(index, fetchIdMap, fetchImpl, 'neighbor role');
}

/**
 * Build an index of neighbor roles using cached data and API lookups.
 *
 * @param {Object} node Normalised node payload.
 * @param {Array<Object>} neighbors Neighbor entries for the node.
 * @param {{ fetchImpl?: Function }} [options] Fetch overrides.
 * @returns {Promise<{
 *   byId: Map<string, string>,
 *   byNum: Map<number, string>,
 *   detailsById: Map<string, Object>,
 *   detailsByNum: Map<number, Object>,
 * }>>} Role index maps enriched with neighbour metadata.
 */
async function buildNeighborRoleIndex(node, neighbors, { fetchImpl } = {}) {
  const index = { byId: new Map(), byNum: new Map(), detailsById: new Map(), detailsByNum: new Map() };
  registerRoleCandidate(index, {
    identifier: node?.nodeId ?? node?.node_id ?? node?.id ?? null,
    numericId: node?.nodeNum ?? node?.node_num ?? node?.num ?? null,
    role: node?.role ?? node?.rawSources?.node?.role ?? null,
    shortName: node?.shortName ?? node?.short_name ?? null,
    longName: node?.longName ?? node?.long_name ?? null,
  });
  if (node?.rawSources?.node && typeof node.rawSources.node === 'object') {
    registerRoleCandidate(index, {
      identifier: node.rawSources.node.node_id ?? node.rawSources.node.nodeId ?? null,
      numericId: node.rawSources.node.node_num ?? node.rawSources.node.nodeNum ?? null,
      role: node.rawSources.node.role ?? node.rawSources.node.node_role ?? null,
      shortName: node.rawSources.node.short_name ?? node.rawSources.node.shortName ?? null,
      longName: node.rawSources.node.long_name ?? node.rawSources.node.longName ?? null,
    });
  }

  const missingNormalized = seedNeighborRoleIndex(index, neighbors);
  if (missingNormalized.size === 0) {
    return index;
  }

  const fetchIdMap = new Map();
  if (Array.isArray(neighbors)) {
    neighbors.forEach(entry => {
      if (!entry || typeof entry !== 'object') return;
      const candidates = [
        entry.neighbor_id,
        entry.neighborId,
        entry.node_id,
        entry.nodeId,
        entry.neighbor?.node_id,
        entry.neighbor?.nodeId,
        entry.node?.node_id,
        entry.node?.nodeId,
      ];
      candidates.forEach(identifier => {
        const normalized = normalizeNodeId(identifier);
        if (normalized && missingNormalized.has(normalized) && !fetchIdMap.has(normalized)) {
          fetchIdMap.set(normalized, identifier);
        }
      });
    });
  }

  await fetchMissingNeighborRoles(index, fetchIdMap, fetchImpl);
  return index;
}

/**
 * Determine whether a neighbour record references the current node.
 *
 * @param {Object} entry Raw neighbour entry.
 * @param {string|null} ourId Canonical identifier for the current node.
 * @param {number|null} ourNum Canonical numeric identifier for the current node.
 * @param {Array<string>} idKeys Candidate identifier property names.
 * @param {Array<string>} numKeys Candidate numeric identifier property names.
 * @returns {boolean} ``true`` when the neighbour refers to the current node.
 */
function neighborMatches(entry, ourId, ourNum, idKeys, numKeys) {
  if (!entry || typeof entry !== 'object') return false;
  const ids = idKeys
    .map(key => stringOrNull(entry[key]))
    .filter(candidate => candidate != null)
    .map(candidate => candidate.toLowerCase());
  if (ourId && ids.includes(ourId.toLowerCase())) {
    return true;
  }
  if (ourNum == null) return false;
  return numKeys
    .map(key => numberOrNull(entry[key]))
    .some(candidate => candidate != null && candidate === ourNum);
}

/**
 * Categorise neighbour entries by their relationship to the current node.
 *
 * @param {Object} node Normalised node payload.
 * @param {Array<Object>} neighbors Raw neighbour entries.
 * @returns {{heardBy: Array<Object>, weHear: Array<Object>}} Categorised neighbours.
 */
function categoriseNeighbors(node, neighbors) {
  const heardBy = [];
  const weHear = [];
  if (!Array.isArray(neighbors) || neighbors.length === 0) {
    return { heardBy, weHear };
  }
  const ourId = stringOrNull(node?.nodeId ?? node?.node_id) ?? null;
  const ourNum = numberOrNull(node?.nodeNum ?? node?.node_num ?? node?.num);
  neighbors.forEach(entry => {
    if (!entry || typeof entry !== 'object') {
      return;
    }
    const matchesNeighbor = neighborMatches(entry, ourId, ourNum, ['neighbor_id', 'neighborId'], ['neighbor_num', 'neighborNum']);
    const matchesNode = neighborMatches(entry, ourId, ourNum, ['node_id', 'nodeId'], ['node_num', 'nodeNum']);
    if (matchesNeighbor) {
      heardBy.push(entry);
    }
    if (matchesNode) {
      weHear.push(entry);
    }
  });
  return { heardBy, weHear };
}

/**
 * Render a short-name badge with consistent role-aware styling.
 *
 * @param {Function} renderShortHtml Badge rendering implementation.
 * @param {{
 *   shortName?: string|null,
 *   longName?: string|null,
 *   role?: string|null,
 *   identifier?: string|null,
 *   numericId?: number|null,
 *   source?: Object|null,
 * }} payload Badge rendering payload.
 * @returns {string} HTML snippet describing the badge.
 */
function renderRoleAwareBadge(renderShortHtml, {
  shortName = null,
  longName = null,
  role = null,
  identifier = null,
  numericId = null,
  source = null,
} = {}) {
  const resolvedIdentifier = stringOrNull(identifier);
  let resolvedShort = stringOrNull(shortName);
  const resolvedLong = stringOrNull(longName);
  const resolvedRole = stringOrNull(role) ?? 'CLIENT';
  const resolvedNumericId = numberOrNull(numericId);
  let fallbackShort = resolvedShort;
  if (!fallbackShort && resolvedIdentifier) {
    const trimmed = resolvedIdentifier.replace(/^!+/, '');
    fallbackShort = trimmed.slice(-4).toUpperCase();
  }
  if (!fallbackShort) {
    fallbackShort = '?';
  }

  const badgeSource = source && typeof source === 'object' ? { ...source } : {};
  if (resolvedIdentifier) {
    if (!badgeSource.node_id) badgeSource.node_id = resolvedIdentifier;
    if (!badgeSource.nodeId) badgeSource.nodeId = resolvedIdentifier;
  }
  if (resolvedNumericId != null) {
    if (!badgeSource.node_num) badgeSource.node_num = resolvedNumericId;
    if (!badgeSource.nodeNum) badgeSource.nodeNum = resolvedNumericId;
  }
  if (resolvedShort) {
    if (!badgeSource.short_name) badgeSource.short_name = resolvedShort;
    if (!badgeSource.shortName) badgeSource.shortName = resolvedShort;
  }
  if (resolvedLong) {
    if (!badgeSource.long_name) badgeSource.long_name = resolvedLong;
    if (!badgeSource.longName) badgeSource.longName = resolvedLong;
  }
  badgeSource.role = badgeSource.role ?? resolvedRole;

  if (typeof renderShortHtml === 'function') {
    return renderShortHtml(resolvedShort ?? fallbackShort, resolvedRole, resolvedLong, badgeSource);
  }
  return `<span class="short-name">${escapeHtml(resolvedShort ?? fallbackShort)}</span>`;
}

/**
 * Generate a badge HTML fragment for a neighbour entry.
 *
 * @param {Object} entry Raw neighbour entry.
 * @param {'heardBy'|'weHear'} perspective Group perspective describing the relation.
 * @param {Function} renderShortHtml Badge rendering implementation.
 * @returns {string} HTML snippet for the badge or an empty string.
 */
function renderNeighborBadge(entry, perspective, renderShortHtml, roleIndex = null) {
  if (!entry || typeof entry !== 'object' || typeof renderShortHtml !== 'function') {
    return '';
  }
  const idKeys = perspective === 'heardBy'
    ? ['node_id', 'nodeId', 'id']
    : ['neighbor_id', 'neighborId', 'id'];
  const numKeys = perspective === 'heardBy'
    ? ['node_num', 'nodeNum']
    : ['neighbor_num', 'neighborNum'];
  const shortKeys = perspective === 'heardBy'
    ? ['node_short_name', 'nodeShortName', 'short_name', 'shortName']
    : ['neighbor_short_name', 'neighborShortName', 'short_name', 'shortName'];
  const longKeys = perspective === 'heardBy'
    ? ['node_long_name', 'nodeLongName', 'long_name', 'longName']
    : ['neighbor_long_name', 'neighborLongName', 'long_name', 'longName'];
  const roleKeys = perspective === 'heardBy'
    ? ['node_role', 'nodeRole', 'role']
    : ['neighbor_role', 'neighborRole', 'role'];

  const identifier = idKeys.map(key => stringOrNull(entry[key])).find(value => value != null);
  if (!identifier) return '';
  const numericId = numKeys.map(key => numberOrNull(entry[key])).find(value => value != null) ?? null;
  let shortName = shortKeys.map(key => stringOrNull(entry[key])).find(value => value != null) ?? null;
  let longName = longKeys.map(key => stringOrNull(entry[key])).find(value => value != null) ?? null;
  let role = roleKeys.map(key => stringOrNull(entry[key])).find(value => value != null) ?? null;
  const source = perspective === 'heardBy' ? entry.node : entry.neighbor;

  const metadata = lookupNeighborDetails(roleIndex, { identifier, numericId });
  if (metadata) {
    if (!shortName && metadata.shortName) {
      shortName = metadata.shortName;
    }
    if (!role && metadata.role) {
      role = metadata.role;
    }
    if (!longName && metadata.longName) {
      longName = metadata.longName;
    }
    if (metadata.shortName && source && typeof source === 'object') {
      if (!source.short_name) source.short_name = metadata.shortName;
      if (!source.shortName) source.shortName = metadata.shortName;
    }
    if (metadata.longName && source && typeof source === 'object') {
      if (!source.long_name) source.long_name = metadata.longName;
      if (!source.longName) source.longName = metadata.longName;
    }
    if (metadata.role && source && typeof source === 'object' && !source.role) {
      source.role = metadata.role;
    }
  }
  if (!shortName) {
    const trimmed = identifier.replace(/^!+/, '');
    shortName = trimmed.slice(-4).toUpperCase();
  }

  if (!role && source && typeof source === 'object') {
    role = stringOrNull(
      source.role
        ?? source.node_role
        ?? source.nodeRole
        ?? source.neighbor_role
        ?? source.neighborRole
        ?? source.roleName
        ?? null,
    );
  }

  if (!role) {
    const sourceId = source && typeof source === 'object'
      ? source.node_id ?? source.nodeId ?? source.id ?? null
      : null;
    const sourceNum = source && typeof source === 'object'
      ? source.node_num ?? source.nodeNum ?? source.num ?? null
      : null;
    role = lookupRole(roleIndex, {
      identifier: identifier ?? sourceId,
      numericId: numericId ?? sourceNum,
    });
  }

  return renderRoleAwareBadge(renderShortHtml, {
    shortName,
    longName,
    role: role ?? 'CLIENT',
    identifier,
    numericId,
    source,
  });
}

/**
 * Render a neighbour group as a titled list.
 *
 * @param {string} title Section title for the group.
 * @param {Array<Object>} entries Neighbour entries included in the group.
 * @param {'heardBy'|'weHear'} perspective Group perspective.
 * @param {Function} renderShortHtml Badge rendering implementation.
 * @returns {string} HTML markup or an empty string when no entries render.
 */
function renderNeighborGroup(title, entries, perspective, renderShortHtml, roleIndex = null) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return '';
  }
  const items = entries
    .map(entry => {
      const badgeHtml = renderNeighborBadge(entry, perspective, renderShortHtml, roleIndex);
      if (!badgeHtml) {
        return null;
      }
      const snrDisplay = formatSnr(entry?.snr);
      const snrHtml = snrDisplay ? `<span class="node-detail__neighbor-snr">(${escapeHtml(snrDisplay)})</span>` : '';
      return `<li>${badgeHtml}${snrHtml}</li>`;
    })
    .filter(item => item != null);
  if (items.length === 0) return '';
  return `
    <div class="node-detail__neighbors-group">
      <h4 class="node-detail__neighbors-title">${escapeHtml(title)}</h4>
      <ul class="node-detail__neighbors-list">${items.join('')}</ul>
    </div>
  `;
}

/**
 * Render neighbour information grouped by signal direction.
 *
 * @param {Object} node Normalised node payload.
 * @param {Array<Object>} neighbors Raw neighbour entries.
 * @param {Function} renderShortHtml Badge rendering implementation.
 * @returns {string} HTML markup for the neighbour section.
 */
function renderNeighborGroups(node, neighbors, renderShortHtml, { roleIndex = null } = {}) {
  const { heardBy, weHear } = categoriseNeighbors(node, neighbors);
  const heardByHtml = renderNeighborGroup('Heard by', heardBy, 'heardBy', renderShortHtml, roleIndex);
  const weHearHtml = renderNeighborGroup('We hear', weHear, 'weHear', renderShortHtml, roleIndex);
  const groups = [heardByHtml, weHearHtml].filter(section => stringOrNull(section));
  if (groups.length === 0) {
    return '';
  }
  return `
    <section class="node-detail__section node-detail__neighbors">
      <h3>Neighbors</h3>
      <div class="node-detail__neighbors-grid">${groups.join('')}</div>
    </section>
  `;
}

/**
 * Render a condensed node table containing a single entry.
 *
 * @param {Object} node Normalised node payload.
 * @param {Function} renderShortHtml Badge rendering implementation.
 * @param {number} [referenceSeconds] Optional reference timestamp for relative metrics.
 * @returns {string} HTML markup for the node table or an empty string.
 */
function renderSingleNodeTable(node, renderShortHtml, referenceSeconds = Date.now() / 1000) {
  if (!node || typeof node !== 'object' || typeof renderShortHtml !== 'function') {
    return '';
  }
  const nodeId = stringOrNull(node.nodeId ?? node.node_id) ?? '';
  const shortName = stringOrNull(node.shortName ?? node.short_name) ?? null;
  const longName = stringOrNull(node.longName ?? node.long_name);
  const longNameLink = renderNodeLongNameLink(longName, nodeId);
  const role = stringOrNull(node.role) ?? 'CLIENT';
  const numericId = numberOrNull(node.nodeNum ?? node.node_num ?? node.num);
  const badgeSource = node.rawSources?.node && typeof node.rawSources.node === 'object'
    ? node.rawSources.node
    : node;
  const badgeHtml = renderRoleAwareBadge(renderShortHtml, {
    shortName,
    longName,
    role,
    identifier: nodeId || null,
    numericId,
    source: badgeSource,
  });
  const hardware = formatHardwareModel(node.hwModel ?? node.hw_model);
  const battery = formatBattery(node.battery ?? node.battery_level);
  const voltage = formatVoltage(node.voltage ?? node.voltageReading);
  const uptime = formatDurationSeconds(node.uptime ?? node.uptime_seconds ?? node.uptimeSeconds);
  const channelUtil = node.channel_utilization ?? node.channelUtilization ?? null;
  const channel = fmtTx(channelUtil, 3);
  const airUtil = fmtTx(node.airUtil ?? node.air_util_tx ?? node.airUtilTx ?? null, 3);
  const temperature = fmtTemperature(node.temperature ?? node.temp);
  const humidity = fmtHumidity(node.humidity ?? node.relative_humidity ?? node.relativeHumidity);
  const pressure = fmtPressure(node.pressure ?? node.barometric_pressure ?? node.barometricPressure);
  const latitude = formatCoordinate(node.latitude ?? node.lat);
  const longitude = formatCoordinate(node.longitude ?? node.lon);
  const altitude = fmtAlt(node.altitude ?? node.alt, 'm');
  const lastSeen = formatRelativeSeconds(node.lastHeard ?? node.last_heard, referenceSeconds);
  const lastPosition = formatRelativeSeconds(node.positionTime ?? node.position_time, referenceSeconds);

  return `
    <div class="nodes-table-wrapper">
      <table class="nodes-detail-table" aria-label="Selected node details">
        <thead>
          <tr>
            <th class="nodes-col nodes-col--node-id">Node ID</th>
            <th class="nodes-col nodes-col--short-name">Short</th>
            <th class="nodes-col nodes-col--long-name">Long Name</th>
            <th class="nodes-col nodes-col--last-seen">Last Seen</th>
            <th class="nodes-col nodes-col--role">Role</th>
            <th class="nodes-col nodes-col--hw-model">HW Model</th>
            <th class="nodes-col nodes-col--battery">Battery</th>
            <th class="nodes-col nodes-col--voltage">Voltage</th>
            <th class="nodes-col nodes-col--uptime">Uptime</th>
            <th class="nodes-col nodes-col--channel-util">Channel Util</th>
            <th class="nodes-col nodes-col--air-util-tx">Air Util Tx</th>
            <th class="nodes-col nodes-col--temperature">Temperature</th>
            <th class="nodes-col nodes-col--humidity">Humidity</th>
            <th class="nodes-col nodes-col--pressure">Pressure</th>
            <th class="nodes-col nodes-col--latitude">Latitude</th>
            <th class="nodes-col nodes-col--longitude">Longitude</th>
            <th class="nodes-col nodes-col--altitude">Altitude</th>
            <th class="nodes-col nodes-col--last-position">Last Position</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td class="mono nodes-col nodes-col--node-id">${escapeHtml(nodeId)}</td>
            <td class="nodes-col nodes-col--short-name">${badgeHtml}</td>
            <td class="nodes-col nodes-col--long-name">${longNameLink}</td>
            <td class="nodes-col nodes-col--last-seen">${escapeHtml(lastSeen)}</td>
            <td class="nodes-col nodes-col--role">${escapeHtml(role)}</td>
            <td class="nodes-col nodes-col--hw-model">${escapeHtml(hardware)}</td>
            <td class="nodes-col nodes-col--battery">${escapeHtml(battery ?? '')}</td>
            <td class="nodes-col nodes-col--voltage">${escapeHtml(voltage ?? '')}</td>
            <td class="nodes-col nodes-col--uptime">${escapeHtml(uptime)}</td>
            <td class="nodes-col nodes-col--channel-util">${escapeHtml(channel ?? '')}</td>
            <td class="nodes-col nodes-col--air-util-tx">${escapeHtml(airUtil ?? '')}</td>
            <td class="nodes-col nodes-col--temperature">${escapeHtml(temperature ?? '')}</td>
            <td class="nodes-col nodes-col--humidity">${escapeHtml(humidity ?? '')}</td>
            <td class="nodes-col nodes-col--pressure">${escapeHtml(pressure ?? '')}</td>
            <td class="nodes-col nodes-col--latitude">${escapeHtml(latitude)}</td>
            <td class="nodes-col nodes-col--longitude">${escapeHtml(longitude)}</td>
            <td class="nodes-col nodes-col--altitude">${escapeHtml(altitude ?? '')}</td>
            <td class="mono nodes-col nodes-col--last-position">${escapeHtml(lastPosition)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  `;
}

/**
 * Render a message list using structured metadata formatting.
 *
 * @param {Array<Object>} messages Message records.
 * @param {Function} renderShortHtml Badge rendering implementation.
 * @param {Object} node Node context used when message metadata is incomplete.
 * @returns {string} HTML string for the messages section.
 */
function renderMessages(messages, renderShortHtml, node) {
  if (!Array.isArray(messages) || messages.length === 0) return '';

  const fallbackNode = node && typeof node === 'object' ? node : null;

  const items = messages
    .map(message => {
      if (!message || typeof message !== 'object') return null;
      const text = stringOrNull(message.text) || stringOrNull(message.emoji);
      if (!text) return null;

      const timestamp = formatMessageTimestamp(message.rx_time, message.rx_iso);
      const metadata = extractChatMessageMetadata(message);
      if (!metadata.channelName) {
        const fallbackChannel = stringOrNull(
          message.channel_name
            ?? message.channelName
            ?? message.channel_label
            ?? null,
        );
        if (fallbackChannel) {
          metadata.channelName = fallbackChannel;
        } else {
          const numericChannel = numberOrNull(message.channel);
          if (numericChannel != null) {
            metadata.channelName = String(numericChannel);
          } else if (stringOrNull(message.channel)) {
            metadata.channelName = stringOrNull(message.channel);
          }
        }
      }

      const prefix = formatChatMessagePrefix({
        timestamp: escapeHtml(timestamp ?? ''),
        frequency: metadata.frequency ? escapeHtml(metadata.frequency) : null,
      });
      const presetTag = formatChatPresetTag({ presetCode: metadata.presetCode });
      const channelTag = formatChatChannelTag({ channelName: metadata.channelName });

      const messageNode = message.node && typeof message.node === 'object' ? message.node : null;
      const badgeHtml = renderRoleAwareBadge(renderShortHtml, {
        shortName: messageNode?.short_name ?? messageNode?.shortName ?? fallbackNode?.shortName ?? fallbackNode?.short_name,
        longName: messageNode?.long_name ?? messageNode?.longName ?? fallbackNode?.longName ?? fallbackNode?.long_name,
        role: messageNode?.role ?? fallbackNode?.role ?? null,
        identifier:
          message.node_id
            ?? message.nodeId
            ?? message.from_id
            ?? message.fromId
            ?? fallbackNode?.nodeId
            ?? fallbackNode?.node_id
            ?? null,
        numericId:
          message.node_num
            ?? message.nodeNum
            ?? message.from_num
            ?? message.fromNum
            ?? fallbackNode?.nodeNum
            ?? fallbackNode?.node_num
            ?? null,
        source: messageNode ?? fallbackNode?.rawSources?.node ?? fallbackNode,
      });

      return `<li>${prefix}${presetTag}${channelTag} ${badgeHtml} ${escapeHtml(text)}</li>`;
    })
    .filter(item => item != null);
  if (items.length === 0) return '';
  return `<ul class="node-detail__list">${items.join('')}</ul>`;
}

/**
 * Normalise a trace node reference into identifier and numeric forms.
 *
 * @param {*} value Raw trace endpoint/hop reference.
 * @returns {{ identifier: (string|null), numericId: (number|null) }|null} Normalised reference.
 */
function normalizeTraceNodeRef(value) {
  const numericId = numberOrNull(value);
  const identifier = (() => {
    const stringId = stringOrNull(value);
    if (numericId != null) {
      const hex = (numericId >>> 0).toString(16).padStart(8, '0');
      return `!${hex}`;
    }
    return stringId;
  })();
  if (identifier == null && numericId == null) {
    return null;
  }
  return { identifier, numericId };
}

/**
 * Extract an ordered trace path containing the source, hops, and destination.
 *
 * @param {Object} trace Trace payload.
 * @returns {Array<{identifier: (string|null), numericId: (number|null)}>} Normalised path entries.
 */
function extractTracePath(trace) {
  if (!trace || typeof trace !== 'object') return [];
  const path = [];
  const append = ref => {
    const normalized = normalizeTraceNodeRef(ref);
    if (!normalized) return;
    path.push(normalized);
  };
  append(trace.src ?? trace.source ?? trace.from);
  const hops = Array.isArray(trace.hops) ? trace.hops : [];
  hops.forEach(append);
  append(trace.dest ?? trace.destination ?? trace.to);
  return path;
}

/**
 * Build a fetch map for trace nodes missing display metadata.
 *
 * @param {Array<Object>} traces Trace payloads to inspect.
 * @param {{byId: Map<string, string>, byNum: Map<number, string>, detailsById: Map<string, Object>, detailsByNum: Map<number, Object>}} roleIndex Existing role index hydrated with known nodes.
 * @returns {Map<string, *>} Mapping of normalized identifiers to fetch payloads.
 */
function collectTraceNodeFetchMap(traces, roleIndex) {
  const fetchIdMap = new Map();
  if (!Array.isArray(traces)) return fetchIdMap;

  for (const trace of traces) {
    const path = extractTracePath(trace);
    for (const ref of path) {
      const identifier = ref?.identifier ?? null;
      const numericId = ref?.numericId ?? null;
      registerRoleCandidate(roleIndex, { identifier, numericId });
      const details = lookupNeighborDetails(roleIndex, { identifier, numericId });
      const hasNames = Boolean(stringOrNull(details?.shortName) || stringOrNull(details?.longName));
      if (hasNames) continue;
      const normalized = normalizeNodeId(identifier);
      const numericKey = numberOrNull(numericId);
      const mapKey = normalized ?? (numericKey != null ? `#${numericKey}` : null);
      const fetchKey = identifier ?? numericKey;
      if (mapKey && fetchKey != null && !fetchIdMap.has(mapKey)) {
        fetchIdMap.set(mapKey, fetchKey);
      }
    }
  }

  return fetchIdMap;
}

/**
 * Build a role index enriched with node metadata for trace hops.
 *
 * @param {Array<Object>} traces Trace payloads.
 * @param {{byId?: Map<string, string>, byNum?: Map<number, string>, detailsById?: Map<string, Object>, detailsByNum?: Map<number, Object>}} [baseIndex]
 *   Optional base role index to clone.
 * @param {{ fetchImpl?: Function }} [options] Fetch overrides.
 * @returns {Promise<{byId: Map<string, string>, byNum: Map<number, string>, detailsById: Map<string, Object>, detailsByNum: Map<number, Object>}>}
 *   Hydrated role index containing hop metadata.
 */
async function buildTraceRoleIndex(traces, baseIndex = null, { fetchImpl } = {}) {
  const roleIndex = cloneRoleIndex(baseIndex);
  const fetchIdMap = collectTraceNodeFetchMap(traces, roleIndex);
  await fetchNodeDetailsIntoIndex(roleIndex, fetchIdMap, fetchImpl, 'trace node metadata');
  return roleIndex;
}

/**
 * Render a trace path using short-name badges.
 *
 * @param {Array<{identifier: (string|null), numericId: (number|null)}>} path Ordered path references.
 * @param {Function} renderShortHtml Badge rendering function.
 * @param {{ roleIndex?: Object|null, node?: Object|null }} options Rendering helpers.
 * @returns {string} HTML fragment for the trace or ``''`` when unsuitable.
 */
function renderTracePath(path, renderShortHtml, { roleIndex = null, node = null } = {}) {
  if (!Array.isArray(path) || path.length < 2 || typeof renderShortHtml !== 'function') {
    return '';
  }

  const nodeIdNormalized = normalizeNodeId(node?.nodeId ?? node?.node_id);
  const nodeNumNormalized = numberOrNull(node?.nodeNum ?? node?.node_num ?? node?.num);

  const renderBadge = ref => {
    const identifier = ref?.identifier ?? null;
    const numericId = ref?.numericId ?? null;
    const normalizedId = normalizeNodeId(identifier);
    const matchesNode =
      (normalizedId && nodeIdNormalized && normalizedId === nodeIdNormalized) ||
      (numericId != null && nodeNumNormalized != null && numericId === nodeNumNormalized);

    let details = lookupNeighborDetails(roleIndex, { identifier, numericId }) ?? undefined;
    if (matchesNode && node) {
      details = {
        ...(details || {}),
        role: node.role ?? details?.role ?? 'CLIENT',
        shortName: node.shortName ?? node.short_name ?? details?.shortName ?? null,
        longName: node.longName ?? node.long_name ?? details?.longName ?? null,
      };
    }

    return renderRoleAwareBadge(renderShortHtml, {
      shortName: details?.shortName ?? null,
      longName: details?.longName ?? null,
      role: details?.role ?? null,
      identifier,
      numericId,
      source: details,
    });
  };

  const items = path
    .map(renderBadge)
    .filter(fragment => stringOrNull(fragment));
  if (items.length < 2) {
    return '';
  }
  const arrow = '<span class="node-detail__trace-arrow" aria-hidden="true">&rarr;</span>';
  return `<li class="node-detail__trace">${items.join(arrow)}</li>`;
}

/**
 * Render all traceroutes associated with the node.
 *
 * @param {Array<Object>} traces Trace payloads.
 * @param {Function} renderShortHtml Badge renderer.
 * @param {{ roleIndex?: Object|null, node?: Object|null }} options Rendering helpers.
 * @returns {string} HTML fragment or ``''`` when absent.
 */
function renderTraceroutes(traces, renderShortHtml, { roleIndex = null, node = null } = {}) {
  if (!Array.isArray(traces) || traces.length === 0 || typeof renderShortHtml !== 'function') {
    return '';
  }
  const items = traces
    .map(trace => renderTracePath(extractTracePath(trace), renderShortHtml, { roleIndex, node }))
    .filter(fragment => stringOrNull(fragment));
  if (items.length === 0) {
    return '';
  }
  return `
    <section class="node-detail__section node-detail__traceroutes">
      <h3>Traceroutes</h3>
      <ul class="node-detail__trace-list">${items.join('')}</ul>
    </section>
  `;
}

/**
 * Render the node detail layout to an HTML fragment.
 *
 * @param {Object} node Normalised node payload.
 * @param {{
  *   neighbors?: Array<Object>,
  *   messages?: Array<Object>,
 *   traces?: Array<Object>,
  *   renderShortHtml: Function,
  *   chartsHtml?: string,
  * }} options Rendering options.
 * @returns {string} HTML fragment representing the detail view.
 */
function renderNodeDetailHtml(node, {
  neighbors = [],
  messages = [],
  traces = [],
  renderShortHtml,
  roleIndex = null,
  chartsHtml = null,
  chartNowMs = Date.now(),
} = {}) {
  const roleAwareBadge = renderRoleAwareBadge(renderShortHtml, {
    shortName: node.shortName ?? node.short_name,
    longName: node.longName ?? node.long_name,
    role: node.role,
    identifier: node.nodeId ?? node.node_id ?? null,
    numericId: node.nodeNum ?? node.node_num ?? node.num ?? null,
    source: node.rawSources?.node ?? node,
  });
  const longName = stringOrNull(node.longName ?? node.long_name);
  const identifier = stringOrNull(node.nodeId ?? node.node_id);
  const tableHtml = renderSingleNodeTable(node, renderShortHtml);
  const telemetryChartsHtml = stringOrNull(chartsHtml) ?? renderTelemetryCharts(node, { nowMs: chartNowMs });
  const neighborsHtml = renderNeighborGroups(node, neighbors, renderShortHtml, { roleIndex });
  const tracesHtml = renderTraceroutes(traces, renderShortHtml, { roleIndex, node });
  const messagesHtml = renderMessages(messages, renderShortHtml, node);

  const sections = [];
  if (neighborsHtml) {
    sections.push(neighborsHtml);
  }
  if (tracesHtml) {
    sections.push(tracesHtml);
  }
  if (Array.isArray(messages) && messages.length > 0 && messagesHtml) {
    sections.push(`<section class="node-detail__section"><h3>Messages</h3>${messagesHtml}</section>`);
  }

  const identifierHtml = identifier ? `<span class="node-detail__identifier">[${escapeHtml(identifier)}]</span>` : '';
  const nameHtml = longName ? `<span class="node-detail__name">${escapeHtml(longName)}</span>` : '';
  const badgeHtml = `<span class="node-detail__badge">${roleAwareBadge}</span>`;
  const tableSection = tableHtml ? `<div class="node-detail__table">${tableHtml}</div>` : '';
  const contentHtml = sections.length > 0 ? `<div class="node-detail__content">${sections.join('')}</div>` : '';

  return `
    <header class="node-detail__header">
      <h2 class="node-detail__title">${badgeHtml}${nameHtml}${identifierHtml}</h2>
    </header>
    ${telemetryChartsHtml ?? ''}
    ${tableSection}
    ${contentHtml}
  `;
}

/**
 * Parse the serialized reference payload embedded in the DOM.
 *
 * @param {string} raw Raw JSON string.
 * @returns {Object|null} Parsed object or ``null`` when invalid.
 */
function parseReferencePayload(raw) {
  const trimmed = stringOrNull(raw);
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (error) {
    console.warn('Failed to parse node reference payload', error);
    return null;
  }
}

/**
 * Normalise a node reference payload by extracting the canonical identifier or number.
 *
 * @param {*} reference Candidate reference object.
 * @returns {{nodeId: (string|null), nodeNum: (number|null)}|null} Normalised reference.
 */
function normalizeNodeReference(reference) {
  if (!reference || typeof reference !== 'object') {
    return null;
  }
  const nodeId = stringOrNull(reference.nodeId ?? reference.node_id);
  const nodeNum = numberOrNull(reference.nodeNum ?? reference.node_num ?? reference.num);
  if (!nodeId && nodeNum == null) {
    return null;
  }
  return { nodeId, nodeNum };
}

/**
 * Resolve the canonical renderShortHtml implementation, waiting briefly for
 * the dashboard to expose it when necessary.
 *
 * @param {Function|undefined} override Explicit override supplied by tests.
 * @returns {Promise<Function>} Badge rendering implementation.
 */
async function resolveRenderShortHtml(override) {
  if (typeof override === 'function') return override;
  const deadline = Date.now() + RENDER_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const candidate = globalThis.PotatoMesh?.renderShortHtml;
    if (typeof candidate === 'function') {
      return candidate;
    }
    await new Promise(resolve => setTimeout(resolve, RENDER_WAIT_INTERVAL_MS));
  }
  return short => `<span class="short-name">${escapeHtml(short ?? '?')}</span>`;
}

/**
 * Fetch recent messages for a node. Private mode bypasses the request.
 *
 * @param {string} identifier Canonical node identifier.
 * @param {{fetchImpl?: Function, includeEncrypted?: boolean, privateMode?: boolean}} options Fetch options.
 * @returns {Promise<Array<Object>>} Resolved message collection.
 */
async function fetchMessages(identifier, { fetchImpl, includeEncrypted = false, privateMode = false } = {}) {
  if (privateMode) return [];
  const fetchFn = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    throw new TypeError('A fetch implementation is required to load node messages');
  }
  const encodedId = encodeURIComponent(String(identifier));
  const encryptedFlag = includeEncrypted ? '&encrypted=1' : '';
  const url = `/api/messages/${encodedId}?limit=${MESSAGE_LIMIT}${encryptedFlag}`;
  const response = await fetchFn(url, DEFAULT_FETCH_OPTIONS);
  if (response.status === 404) return [];
  if (!response.ok) {
    throw new Error(`Failed to load node messages (HTTP ${response.status})`);
  }
  const payload = await response.json();
  return Array.isArray(payload) ? payload : [];
}

/**
 * Fetch traceroute records for a node reference.
 *
 * @param {string|number} identifier Canonical node identifier or number.
 * @param {{fetchImpl?: Function}} options Fetch options.
 * @returns {Promise<Array<Object>>} Resolved trace collection.
 */
async function fetchTracesForNode(identifier, { fetchImpl } = {}) {
  if (identifier == null) {
    return [];
  }
  const fetchFn = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    throw new TypeError('A fetch implementation is required to load traceroutes');
  }
  const encodedId = encodeURIComponent(String(identifier));
  const url = `/api/traces/${encodedId}?limit=${TRACE_LIMIT}`;
  const response = await fetchFn(url, DEFAULT_FETCH_OPTIONS);
  if (response.status === 404) return [];
  if (!response.ok) {
    throw new Error(`Failed to load traceroutes (HTTP ${response.status})`);
  }
  const payload = await response.json();
  return Array.isArray(payload) ? payload : [];
}

/**
 * Fetch node detail data and render the HTML fragment.
 *
 * @param {{
 *   document?: Document,
 *   fetchImpl?: Function,
 *   refreshImpl?: Function,
 *   renderShortHtml?: Function,
 *   chartNowMs?: number,
 *   chartOptions?: Object,
 * }} options Optional overrides for testing.
 * @returns {Promise<string|{html: string, chartModels: Array<Object>}>} Rendered markup or chart models when requested.
 */
export async function fetchNodeDetailHtml(referenceData, options = {}) {
  if (!referenceData || typeof referenceData !== 'object') {
    throw new TypeError('A node reference object is required to render node details');
  }
  const normalized = normalizeNodeReference(referenceData);
  if (!normalized) {
    throw new Error('Node identifier missing.');
  }

  const refreshImpl = typeof options.refreshImpl === 'function' ? options.refreshImpl : refreshNodeInformation;
  const renderShortHtml = await resolveRenderShortHtml(options.renderShortHtml);

  const node = await refreshImpl(referenceData, { fetchImpl: options.fetchImpl });
  const neighborRoleIndex = await buildNeighborRoleIndex(node, node.neighbors, {
    fetchImpl: options.fetchImpl,
  });
  const messageIdentifier =
    normalized.nodeId ??
    stringOrNull(node.nodeId ?? node.node_id) ??
    (normalized.nodeNum != null ? normalized.nodeNum : null);
  const [messages, traces] = await Promise.all([
    fetchMessages(messageIdentifier, {
      fetchImpl: options.fetchImpl,
      privateMode: options.privateMode === true,
    }),
    fetchTracesForNode(messageIdentifier, { fetchImpl: options.fetchImpl }),
  ]);
  const roleIndex = await buildTraceRoleIndex(traces, neighborRoleIndex, { fetchImpl: options.fetchImpl });
  const chartNowMs = Number.isFinite(options.chartNowMs) ? options.chartNowMs : Date.now();
  const chartState = createTelemetryCharts(node, {
    nowMs: chartNowMs,
    chartOptions: options.chartOptions ?? {},
  });
  const html = renderNodeDetailHtml(node, {
    neighbors: node.neighbors,
    messages,
    traces,
    renderShortHtml,
    roleIndex,
    chartsHtml: chartState.chartsHtml,
    chartNowMs,
  });
  if (options.returnState === true) {
    return { html, chartModels: chartState.chartModels };
  }
  return html;
}

/**
 * Initialise the standalone node detail page and mount telemetry charts.
 *
 * @param {{
 *   document?: Document,
 *   fetchImpl?: Function,
 *   refreshImpl?: Function,
 *   renderShortHtml?: Function,
 *   uPlotImpl?: Function,
 * }} options Optional overrides for testing.
 * @returns {Promise<boolean>} ``true`` when the node was rendered successfully.
 */
export async function initializeNodeDetailPage(options = {}) {
  const documentRef = options.document ?? globalThis.document;
  if (!documentRef || typeof documentRef.querySelector !== 'function') {
    throw new TypeError('A document with querySelector support is required');
  }
  const root = documentRef.querySelector('#nodeDetail');
  if (!root) return false;

  const filterContainer = typeof documentRef.querySelector === 'function'
    ? documentRef.querySelector('.filter-input')
    : null;
  if (filterContainer) {
    if (typeof filterContainer.remove === 'function') {
      filterContainer.remove();
    } else {
      filterContainer.hidden = true;
    }
  }

  const referenceData = parseReferencePayload(root.dataset?.nodeReference ?? null);
  if (!referenceData) {
    root.innerHTML = '<p class="node-detail__error">Node reference unavailable.</p>';
    return false;
  }

  const identifier = stringOrNull(referenceData.nodeId) ?? null;
  const nodeNum = numberOrNull(referenceData.nodeNum);
  if (!identifier && nodeNum == null) {
    root.innerHTML = '<p class="node-detail__error">Node identifier missing.</p>';
    return false;
  }

  const refreshImpl = typeof options.refreshImpl === 'function' ? options.refreshImpl : refreshNodeInformation;
  const privateMode = (root.dataset?.privateMode ?? '').toLowerCase() === 'true';

  try {
    const result = await fetchNodeDetailHtml(referenceData, {
      fetchImpl: options.fetchImpl,
      refreshImpl,
      renderShortHtml: options.renderShortHtml,
      privateMode,
      returnState: true,
    });
    root.innerHTML = result.html;
    mountTelemetryChartsWithRetry(result.chartModels, { root, uPlotImpl: options.uPlotImpl });
    return true;
  } catch (error) {
    console.error('Failed to render node detail page', error);
    root.innerHTML = '<p class="node-detail__error">Failed to load node details.</p>';
    return false;
  }
}

export const __testUtils = {
  stringOrNull,
  numberOrNull,
  escapeHtml,
  formatFrequency,
  formatBattery,
  formatVoltage,
  formatUptime,
  formatTimestamp,
  formatMessageTimestamp,
  formatHardwareModel,
  formatCoordinate,
  formatRelativeSeconds,
  formatDurationSeconds,
  formatSnr,
  padTwo,
  normalizeNodeId,
  cloneRoleIndex,
  registerRoleCandidate,
  lookupRole,
  lookupNeighborDetails,
  seedNeighborRoleIndex,
  buildNeighborRoleIndex,
  collectTraceNodeFetchMap,
  buildTraceRoleIndex,
  categoriseNeighbors,
  renderNeighborGroups,
  renderSingleNodeTable,
  createTelemetryCharts,
  renderTelemetryCharts,
  mountTelemetryCharts,
  mountTelemetryChartsWithRetry,
  buildUPlotChartConfig,
  renderMessages,
  renderTraceroutes,
  renderTracePath,
  extractTracePath,
  normalizeTraceNodeRef,
  renderNodeDetailHtml,
  parseReferencePayload,
  resolveRenderShortHtml,
  fetchMessages,
  fetchTracesForNode,
  fetchNodeDetailHtml,
  normalizeNodeReference,
};
