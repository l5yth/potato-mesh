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
 * Waypoints section for the node detail page (SPEC W11).
 *
 * The minimal detail card (design 1d-C) shows only title, body, and
 * ``<expiry> · by`` — the remaining payload fields (coordinates, the waypoint
 * id, the locked-to reference, heard age) live here, on the author's node
 * page, per the design note "Coords, id and lockedTo move to the node page".
 * Every field renders per the PD-A1 spec-sheet ethic: nothing hidden, absent
 * reads as omitted rather than invented.
 *
 * @module node-page/waypoints
 */

import { escapeHtml } from '../utils.js';
import { timeAgo, toFiniteNumber } from '../main/format-utils.js';
import { tickAttributes } from '../main/relative-time-ticker.js';
import { formatWaypointExpiry, waypointGlyph } from '../main/waypoint-layer.js';

/**
 * Render one waypoint row for the node-page list.
 *
 * @param {Object} waypoint Waypoint row from ``GET /api/waypoints/:id``.
 * @param {Function} renderShortHtml Badge renderer (protocol/role styled).
 * @param {number} nowSeconds Current time, unix seconds.
 * @returns {string} ``<li>`` fragment, or ``''`` for an unusable row.
 */
function renderWaypointItem(waypoint, renderShortHtml, nowSeconds) {
  if (!waypoint || typeof waypoint !== 'object' || waypoint.id == null) return '';
  const glyph = escapeHtml(waypointGlyph(waypoint.icon));
  const name = escapeHtml(String(waypoint.name ?? 'Waypoint'));
  const parts = [`<strong>${glyph} ${name}</strong>`];
  parts.push(`<span class="mono">wpt ${escapeHtml(String(waypoint.id))}</span>`);

  const lat = toFiniteNumber(waypoint.latitude);
  const lon = toFiniteNumber(waypoint.longitude);
  if (lat != null && lon != null) {
    parts.push(`<span class="mono">${lat.toFixed(5)}, ${lon.toFixed(5)}</span>`);
  }

  parts.push(`Expires: ${escapeHtml(formatWaypointExpiry(waypoint.expire, nowSeconds))}`);

  const lockedTo = typeof waypoint.locked_to === 'string' && waypoint.locked_to ? waypoint.locked_to : null;
  if (lockedTo) {
    const lockedBadge = typeof renderShortHtml === 'function'
      ? renderShortHtml(lockedTo.slice(-4).toUpperCase(), null, lockedTo)
      : '';
    const lockedHtml = lockedBadge || `<span class="mono">${escapeHtml(lockedTo)}</span>`;
    parts.push(`\u{1F512} Locked to ${lockedHtml}`);
  }

  const rxTime = toFiniteNumber(waypoint.rx_time);
  if (rxTime != null && rxTime > 0) {
    // Live-ticking heard age (SPEC RT1/RT2) — the page's shared clock updates it.
    parts.push(`Heard: <span ${tickAttributes(rxTime)}>${escapeHtml(timeAgo(rxTime, nowSeconds))}</span>`);
  }

  return `<li class="node-detail__waypoint">${parts.join(' · ')}</li>`;
}

/**
 * Render the node page's Waypoints section: one row per waypoint the node has
 * broadcast, carrying the fields the minimal card omits (W11). Mirrors the
 * traceroutes section contract — an empty or unusable collection renders
 * ``''`` so the section simply does not appear.
 *
 * @param {Array<Object>} waypoints Waypoint rows authored by the page's node.
 * @param {Function} renderShortHtml Badge renderer for locked-to references.
 * @param {{ nowSeconds?: number }} [options] Clock override (tests).
 * @returns {string} HTML fragment or ``''`` when absent.
 */
export function renderWaypointsSection(waypoints, renderShortHtml, { nowSeconds = Math.floor(Date.now() / 1000) } = {}) {
  if (!Array.isArray(waypoints) || waypoints.length === 0) {
    return '';
  }
  const items = waypoints
    .map(waypoint => renderWaypointItem(waypoint, renderShortHtml, nowSeconds))
    .filter(fragment => fragment.length > 0);
  if (items.length === 0) {
    return '';
  }
  return `
    <section class="node-detail__section node-detail__waypoints">
      <h3>Waypoints</h3>
      <ul class="node-detail__waypoint-list">${items.join('')}</ul>
    </section>
  `;
}
