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
 * Coerce a candidate value into a positive integer satellite count.
 *
 * @param {*} value Raw candidate value.
 * @returns {number|null} Rounded positive integer or ``null``.
 */
function toPositiveInteger(value) {
  if (value == null || value === '') return null;
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  return Math.round(num);
}

/**
 * Extract the satellite count from a node-like payload.
 *
 * @param {*} info Node payload potentially containing satellite metadata.
 * @returns {number|null} Satellite count when present and positive.
 */
export function resolveSatsInView(info) {
  if (!info || typeof info !== 'object') {
    return toPositiveInteger(info);
  }
  const candidates = [
    info.satsInView,
    info.sats_in_view,
    info.position?.satsInView,
    info.position?.sats_in_view,
    info.rawSources?.position?.satsInView,
    info.rawSources?.position?.sats_in_view,
  ];
  for (const candidate of candidates) {
    const count = toPositiveInteger(candidate);
    if (count != null) {
      return count;
    }
  }
  return null;
}

const ICON_PATH = '/assets/img/satellite-icon.svg';

/**
 * Render a short-info overlay row describing visible satellites.
 *
 * @param {*} info Node payload providing satellite metadata.
 * @returns {string} HTML snippet or an empty string when unavailable.
 */
export function renderSatsInViewBadge(info) {
  const count = resolveSatsInView(info);
  if (count == null) {
    return '';
  }
  return [
    '<span class="short-info-sats" aria-label="Satellites in view">',
    `<span class="short-info-sats__icon" aria-hidden="true">` +
      `<img src="${ICON_PATH}" alt="" width="14" height="14" loading="lazy" decoding="async" class="short-info-sats__glyph">` +
    `</span>`,
    `<span class="short-info-sats__count">${count}</span>`,
    '</span>',
  ].join('');
}

export const __testUtils = {
  toPositiveInteger,
};
