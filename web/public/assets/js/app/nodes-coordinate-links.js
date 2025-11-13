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
 * Convert raw values to finite numeric coordinates when possible.
 *
 * @param {*} value Raw coordinate value.
 * @returns {number|null} Parsed coordinate or ``null`` when invalid.
 */
function toFiniteCoordinate(value) {
  if (value == null || value === '') return null;
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : null;
}

/**
 * Enhance a table cell so that it contains a clickable button capable of
 * focusing the map on the provided coordinates.
 *
 * @param {{
 *   cell: { replaceChildren?: Function } | null,
 *   document: { createElement: Function } | Document,
 *   displayText: string,
 *   formattedLatitude?: string,
 *   formattedLongitude?: string,
 *   lat: *,
 *   lon: *,
 *   nodeName?: string,
 *   onActivate?: (lat: number, lon: number) => boolean | void,
 *   buttonClassName?: string
 * }} options Enhancement configuration.
 * @returns {HTMLElement|null} The created button when enhancement succeeds.
 */
export function enhanceCoordinateCell({
  cell,
  document,
  displayText,
  formattedLatitude,
  formattedLongitude,
  lat,
  lon,
  nodeName,
  onActivate,
  buttonClassName = 'nodes-coordinate-button'
}) {
  if (!cell || typeof cell.replaceChildren !== 'function') return null;
  if (!displayText) return null;
  const latNum = toFiniteCoordinate(lat);
  const lonNum = toFiniteCoordinate(lon);
  if (latNum == null || lonNum == null) return null;
  const doc = document && typeof document.createElement === 'function' ? document : null;
  if (!doc) return null;

  const button = doc.createElement('button');
  button.type = 'button';
  button.className = buttonClassName;
  button.textContent = displayText;
  if (!button.dataset) button.dataset = {};
  button.dataset.lat = String(latNum);
  button.dataset.lon = String(lonNum);

  const coordsSummary = [formattedLatitude, formattedLongitude].filter(Boolean).join(', ');
  const displayName = nodeName ? String(nodeName) : 'node';
  const ariaLabelBase = `Center map on ${displayName}`;
  const ariaLabel = coordsSummary ? `${ariaLabelBase} at ${coordsSummary}` : ariaLabelBase;
  if (typeof button.setAttribute === 'function') {
    button.setAttribute('aria-label', ariaLabel);
  }

  button.addEventListener('click', event => {
    if (event && typeof event.preventDefault === 'function') {
      event.preventDefault();
    }
    if (event && typeof event.stopPropagation === 'function') {
      event.stopPropagation();
    }
    if (typeof onActivate === 'function') {
      onActivate(latNum, lonNum);
    }
  });

  cell.replaceChildren(button);
  return button;
}

export const __testUtils = {
  toFiniteCoordinate
};
