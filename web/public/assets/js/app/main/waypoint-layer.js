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
 * Waypoint map layer (SPEC W6 — design variants 1c-A / 1d-A).
 *
 * Renders community POI waypoints as 22 px dark glyph chips — a third marker
 * shape, deliberately distinct from the Meshtastic circle and the MeshCore
 * diamond so a waypoint never reads as a node of some new role — stacked above
 * the node markers. Marker opacity follows the expiry ladder (a waypoint about
 * to lapse reads dimmer, exactly as a stale node does), and rows past their
 * ``expire`` timestamp or without usable coordinates are not rendered at all
 * (W5: expired waypoints leave the read surface; the Log keeps their broadcast
 * history).
 *
 * Everything here is pure and dependency-injected (Leaflet, clock) so the
 * layer is fully unit-testable headlessly.
 *
 * @module main/waypoint-layer
 */

import { escapeHtml } from '../utils.js';
import { timeAgo, timeHum, toFiniteNumber } from './format-utils.js';

/** Chip edge length in CSS pixels (design 1c-A: "22px, r6"). */
export const WAYPOINT_MARKER_SIZE = 22;

/** Markers stack above node markers (whose offset is 0). */
export const WAYPOINT_Z_INDEX_OFFSET = 500;

/** Fallback glyph when the payload carries no usable icon codepoint. */
const FALLBACK_GLYPH = '\u{1F4CC}'; // 📌 — the waypoint's Log emoji.

/**
 * Resolve the marker glyph from the payload's unicode ``icon`` codepoint.
 *
 * @param {*} icon Raw ``icon`` value (int codepoint per CONTRACTS.md).
 * @returns {string} A printable glyph; the 📌 fallback when absent/invalid.
 */
export function waypointGlyph(icon) {
  const code = toFiniteNumber(icon);
  if (code == null || code <= 0) return FALLBACK_GLYPH;
  try {
    const glyph = String.fromCodePoint(Math.floor(code));
    // Reject control/unassigned codepoints — they would render an empty chip.
    return /\p{C}/u.test(glyph) ? FALLBACK_GLYPH : glyph;
  } catch {
    return FALLBACK_GLYPH;
  }
}

/**
 * Whether a waypoint is past its expiry (W5: excluded from the map layer).
 * ``expire`` absent/0 means "never expires".
 *
 * @param {*} expire Raw ``expire`` unix timestamp.
 * @param {number} nowSeconds Current time, unix seconds.
 * @returns {boolean} True when expired.
 */
export function isWaypointExpired(expire, nowSeconds) {
  const ts = toFiniteNumber(expire);
  if (ts == null || ts <= 0) return false;
  return ts <= nowSeconds;
}

/**
 * Marker opacity for a waypoint's remaining lifetime — the expiry ladder
 * (design 1a; mirrors the age-bucket freshness ladder): < 1 h remaining →
 * 0.4, < 24 h → 0.7, otherwise (or never expiring) → 1.
 *
 * @param {*} expire Raw ``expire`` unix timestamp (absent ⇒ never).
 * @param {number} nowSeconds Current time, unix seconds.
 * @returns {number} Opacity in [0.4, 1].
 */
export function waypointExpiryOpacity(expire, nowSeconds) {
  const ts = toFiniteNumber(expire);
  if (ts == null || ts <= 0) return 1;
  const remaining = ts - nowSeconds;
  if (remaining < 3600) return 0.4;
  if (remaining < 24 * 3600) return 0.7;
  return 1;
}

/**
 * Filter the waypoints that should render on the map: not expired, with a
 * finite coordinate pair.
 *
 * @param {Array<Object>} waypoints Waypoint rows from the API/cache.
 * @param {number} nowSeconds Current time, unix seconds.
 * @returns {Array<Object>} Renderable waypoints.
 */
export function visibleWaypoints(waypoints, nowSeconds) {
  if (!Array.isArray(waypoints)) return [];
  return waypoints.filter(waypoint => {
    if (!waypoint || typeof waypoint !== 'object') return false;
    if (isWaypointExpired(waypoint.expire, nowSeconds)) return false;
    const lat = toFiniteNumber(waypoint.latitude);
    const lon = toFiniteNumber(waypoint.longitude);
    return lat != null && lon != null;
  });
}

/**
 * Build the ``L.divIcon`` definition for one waypoint chip (design 1c-A: a
 * dark glyph chip in the overlay chrome — #1c1c1c on a --fg hairline — so it
 * reads as annotation, not as a node).
 *
 * @param {Object} waypoint Waypoint row.
 * @param {number} nowSeconds Current time, unix seconds (expiry dimming).
 * @returns {{ className: string, html: string, iconSize: [number, number], iconAnchor: [number, number] }}
 *   Definition consumable by ``L.divIcon``.
 */
export function waypointIconDefinition(waypoint, nowSeconds) {
  const size = WAYPOINT_MARKER_SIZE;
  const opacity = waypointExpiryOpacity(waypoint && waypoint.expire, nowSeconds);
  const glyph = escapeHtml(waypointGlyph(waypoint && waypoint.icon));
  return {
    className: '',
    html:
      '<span class="waypoint-chip" style="display:flex; align-items:center; justify-content:center; ' +
      `box-sizing:border-box; width:${size}px; height:${size}px; border-radius:6px; background:#1c1c1c; ` +
      'border:1px solid rgba(230,235,240,0.55); box-shadow:0 2px 6px rgba(0,0,0,0.6); ' +
      `font-size:13px; line-height:1; opacity:${opacity}">${glyph}</span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  };
}

/**
 * Render the waypoint layer: clear it and add one chip marker per visible
 * waypoint, binding the selection callback.
 *
 * @param {{
 *   waypoints: Array<Object>,
 *   layer: { clearLayers: Function, addLayer?: Function },
 *   leaflet: { marker: Function, divIcon: Function },
 *   nowSeconds: number,
 *   onSelect?: (waypoint: Object, anchorEl: ?Element) => void
 * }} options Render inputs: the rows, the target ``L.layerGroup``, the
 *   Leaflet namespace (injectable for tests), the clock, and the click
 *   callback (receives the waypoint and the marker's DOM element).
 * @returns {number} The number of markers rendered (feeds the legend count).
 */
export function renderWaypointsLayer({ waypoints, layer, leaflet, nowSeconds, onSelect }) {
  if (!layer || !leaflet || typeof leaflet.marker !== 'function' || typeof leaflet.divIcon !== 'function') {
    return 0;
  }
  layer.clearLayers();
  const rows = visibleWaypoints(waypoints, nowSeconds);
  for (const waypoint of rows) {
    const marker = leaflet.marker([Number(waypoint.latitude), Number(waypoint.longitude)], {
      keyboard: false,
      // Above the node markers: a POI annotates the map, it never hides under
      // a node dot (design 1a).
      zIndexOffset: WAYPOINT_Z_INDEX_OFFSET,
      icon: leaflet.divIcon(waypointIconDefinition(waypoint, nowSeconds)),
    });
    if (typeof onSelect === 'function' && typeof marker.on === 'function') {
      marker.on('click', event => {
        if (event && event.originalEvent) {
          if (typeof event.originalEvent.preventDefault === 'function') event.originalEvent.preventDefault();
          if (typeof event.originalEvent.stopPropagation === 'function') event.originalEvent.stopPropagation();
        }
        const anchorEl = typeof marker.getElement === 'function' ? marker.getElement() : null;
        onSelect(waypoint, anchorEl || null);
      });
    }
    marker.addTo(layer);
  }
  return rows.length;
}

/**
 * Build the detail-card HTML lines for one waypoint (design 1d-A: every
 * payload field in the node overlay's line order — title, id, body, coords,
 * then the label:value rows). The caller joins with ``<br/>`` and renders
 * into the short-info overlay chrome.
 *
 * The waypoint ``name``/``description`` are user-authored text and are always
 * HTML-escaped here. Author/locked-to badges are protocol-styled by the app,
 * so they arrive pre-rendered (and pre-escaped) via ``authorBadgeHtml`` /
 * ``lockedBadgeHtml``.
 *
 * @param {Object} waypoint Waypoint row.
 * @param {{
 *   nowSeconds: number,
 *   authorBadgeHtml?: string,
 *   lockedBadgeHtml?: string
 * }} options Clock plus optional pre-rendered badge HTML.
 * @returns {Array<string>} HTML lines for the overlay body.
 */
export function buildWaypointOverlayLines(waypoint, { nowSeconds, authorBadgeHtml = '', lockedBadgeHtml = '' } = {}) {
  if (!waypoint || typeof waypoint !== 'object') return [];
  const lines = [];
  const glyph = escapeHtml(waypointGlyph(waypoint.icon));
  const name = escapeHtml(String(waypoint.name ?? 'Waypoint'));
  lines.push(`<strong>${glyph} ${name}</strong>`);

  const idPart = waypoint.id != null ? `<span class="mono">wpt ${escapeHtml(String(waypoint.id))}</span> ` : '';
  lines.push(`${idPart}<span class="waypoint-kind-chip">waypoint</span>`);

  if (waypoint.description != null && String(waypoint.description).length > 0) {
    lines.push(escapeHtml(String(waypoint.description)));
  }

  const lat = toFiniteNumber(waypoint.latitude);
  const lon = toFiniteNumber(waypoint.longitude);
  if (lat != null && lon != null) {
    lines.push(`<span class="mono">${lat.toFixed(5)}, ${lon.toFixed(5)}</span>`);
  }

  const expire = toFiniteNumber(waypoint.expire);
  const expiresValue = expire != null && expire > 0
    ? `in ${timeHum(Math.max(0, Math.floor(expire - nowSeconds)))}`
    : 'never';
  lines.push(`Expires: <span>${escapeHtml(expiresValue)}</span>`);

  if (lockedBadgeHtml) {
    lines.push(`\u{1F512} Locked to ${lockedBadgeHtml}`);
  }

  const authorId = typeof waypoint.node_id === 'string' && waypoint.node_id ? waypoint.node_id : null;
  if (authorBadgeHtml || authorId) {
    const idHtml = authorId ? ` <span class="mono">${escapeHtml(authorId)}</span>` : '';
    lines.push(`By ${authorBadgeHtml}${idHtml}`.trim());
  }

  const rxTime = toFiniteNumber(waypoint.rx_time);
  if (rxTime != null && rxTime > 0) {
    lines.push(`Heard: ${escapeHtml(timeAgo(rxTime, nowSeconds))}`);
  }

  return lines;
}
