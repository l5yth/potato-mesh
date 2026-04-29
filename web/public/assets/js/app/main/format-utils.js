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
 * Pure formatting helpers used throughout the dashboard.
 *
 * Extracted from ``main.js`` so that submodules and unit tests can import
 * them without dragging in the entire ``initializeApp`` closure.  Every
 * function here is deterministic and free of closure / DOM state.
 *
 * @module main/format-utils
 */

/**
 * Pad a numeric value with leading zeros.
 *
 * @param {number} n Numeric value.
 * @returns {string} Padded string.
 */
export function pad(n) {
  return String(n).padStart(2, '0');
}

/**
 * Format a ``Date`` object as ``HH:MM:SS``.
 *
 * @param {Date} d Date instance.
 * @returns {string} Time string.
 */
export function formatTime(d) {
  return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

/**
 * Format a ``Date`` object as ``YYYY-MM-DD``.
 *
 * @param {Date} d Date instance.
 * @returns {string} Date string.
 */
export function formatDate(d) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

/**
 * Format hardware model strings for display.
 *
 * @param {*} v Raw hardware model value.
 * @returns {string} Sanitised string.
 */
export function fmtHw(v) {
  return v && v !== 'UNSET' ? String(v) : '';
}

/**
 * Format coordinate values with a configurable precision.
 *
 * @param {*} v Raw coordinate value.
 * @param {number} [d=5] Decimal precision.
 * @returns {string} Formatted coordinate string.
 */
export function fmtCoords(v, d = 5) {
  if (v == null || v === '') return '';
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(d) : '';
}

/**
 * Format SNR readings with a ``dB`` suffix.
 *
 * @param {*} value Raw SNR value.
 * @returns {string} Formatted SNR string.
 */
export function formatSnrDisplay(value) {
  if (value == null || value === '') return '';
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return `${n.toFixed(1)} dB`;
}

/**
 * Convert a duration in seconds into a human readable string.
 *
 * @param {number} unixSec Duration in seconds.
 * @returns {string} Human readable representation.
 */
export function timeHum(unixSec) {
  if (!unixSec) return '';
  if (unixSec < 0) return '0s';
  if (unixSec < 60) return `${unixSec}s`;
  if (unixSec < 3600) return `${Math.floor(unixSec / 60)}m ${Math.floor((unixSec % 60))}s`;
  if (unixSec < 86400) return `${Math.floor(unixSec / 3600)}h ${Math.floor((unixSec % 3600) / 60)}m`;
  return `${Math.floor(unixSec / 86400)}d ${Math.floor((unixSec % 86400) / 3600)}h`;
}

/**
 * Return a relative time string describing how long ago an event occurred.
 *
 * @param {number} unixSec Timestamp in seconds.
 * @param {number} [nowSec] Reference timestamp.
 * @returns {string} Human readable relative time.
 */
export function timeAgo(unixSec, nowSec = Date.now() / 1000) {
  if (!unixSec) return '';
  const diff = Math.floor(nowSec - Number(unixSec));
  if (diff < 0) return '0s';
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ${Math.floor((diff % 60))}s`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ${Math.floor((diff % 3600) / 60)}m`;
  return `${Math.floor(diff / 86400)}d ${Math.floor((diff % 86400) / 3600)}h`;
}

/**
 * Convert arbitrary values to finite numbers when possible.
 *
 * @param {*} value Raw value.
 * @returns {number|null} Finite number or null when conversion fails.
 */
export function toFiniteNumber(value) {
  if (value == null || value === '') return null;
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : null;
}

/**
 * Determine the best-effort timestamp in seconds from numeric or ISO values.
 *
 * @param {*} numeric Numeric timestamp.
 * @param {*} isoString ISO formatted timestamp.
 * @returns {number|null} Timestamp in seconds.
 */
export function resolveTimestampSeconds(numeric, isoString) {
  const parsedNumeric = toFiniteNumber(numeric);
  if (parsedNumeric != null) return parsedNumeric;
  if (typeof isoString === 'string' && isoString.length) {
    const parsedIso = Date.parse(isoString);
    if (Number.isFinite(parsedIso)) {
      return parsedIso / 1000;
    }
  }
  return null;
}

/**
 * Escape a string for safe use as a CSS selector fragment.
 *
 * Falls back to a manual escape when ``CSS.escape`` is unavailable.
 *
 * @param {string} value Selector fragment.
 * @returns {string} Escaped selector fragment safe for interpolation.
 */
export function cssEscape(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return '';
  }
  if (typeof window !== 'undefined' && window.CSS && typeof window.CSS.escape === 'function') {
    return window.CSS.escape(value);
  }
  return value.replace(/[^a-zA-Z0-9_-]/g, chr => `\\${chr}`);
}

/**
 * Parse a node identifier or numeric reference into a finite number.
 *
 * @param {*} ref Identifier or numeric reference.
 * @returns {number|null} Parsed number or ``null``.
 */
export function parseNodeNumericRef(ref) {
  if (ref == null) return null;
  if (typeof ref === 'number') {
    return Number.isFinite(ref) ? ref : null;
  }
  if (typeof ref === 'string') {
    const trimmed = ref.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('!')) {
      const hex = trimmed.slice(1);
      if (!/^[0-9A-Fa-f]+$/.test(hex)) return null;
      const parsedHex = Number.parseInt(hex, 16);
      return Number.isFinite(parsedHex) ? parsedHex >>> 0 : null;
    }
    if (/^0[xX][0-9A-Fa-f]+$/.test(trimmed)) {
      const parsedHex = Number.parseInt(trimmed, 16);
      return Number.isFinite(parsedHex) ? parsedHex >>> 0 : null;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const parsed = Number(ref);
  return Number.isFinite(parsed) ? parsed : null;
}
