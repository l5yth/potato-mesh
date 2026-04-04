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
 * Generic string and HTML utilities shared across the application.
 *
 * @module utils
 */

/**
 * Escape a string for safe HTML insertion.
 *
 * Converts the five HTML-special characters (&, <, >, ", ') into their
 * corresponding named or numeric entities so the result can be safely embedded
 * in an HTML attribute value or text node.
 *
 * @param {string} str Raw string.
 * @returns {string} Escaped HTML string.
 */
export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Normalise a raw value to a trimmed non-empty string, or ``null``.
 *
 * - ``null`` / ``undefined`` → ``null``
 * - Strings are trimmed; blank results become ``null``
 * - Finite numbers are converted via ``String()``
 * - Infinite / NaN numbers return ``null``
 * - All other types return ``null``
 *
 * @param {*} value Raw value.
 * @returns {string|null} Sanitised string or ``null`` when blank/absent.
 */
export function normalizeString(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return String(value);
  }
  return null;
}
