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
 * Waypoint map layer (SPEC W6 — design variants 1c-B / 1d-C, per re-roll).
 *
 * Renders community POI waypoints as 24 px teardrop pins — the map convention
 * for a place, in the dark overlay chrome so a waypoint never reads as a node
 * of some new role — stacked above the node markers with the pin tip anchored
 * on the coordinate. Marker opacity follows the expiry ladder (a waypoint
 * about to lapse reads dimmer, exactly as a stale node does), and rows past
 * their ``expire`` timestamp or without usable coordinates are not rendered
 * at all (W5: expired waypoints leave the read surface; the Log keeps their
 * broadcast history).
 *
 * Everything here is pure and dependency-injected (Leaflet, clock) so the
 * layer is fully unit-testable headlessly.
 *
 * @module main/waypoint-layer
 */

import { escapeHtml } from '../utils.js';
import { timeHum, toFiniteNumber } from './format-utils.js';

/** Pin body edge length in CSS pixels (design 1c-B: "24px, r50%/0"). */
export const WAYPOINT_MARKER_SIZE = 24;

/**
 * Icon bounding box + anchor for the rotated pin. A 24 px square rotated 45°
 * spans a ~33.94 px diagonal, so the box is a **square** that fully contains it
 * (34×34) with the body inset 5 px on both axes; the sharp corner (the tail)
 * then lands at the box bottom (~34 px). The anchor sits on that tip so the pin
 * points exactly at the waypoint's coordinate, and the whole silhouette — crown
 * included — stays inside the marker's clickable hit area (a 34×30 box left the
 * crown ~5 px above it, unclickable, since Leaflet does not clip the overflow).
 */
export const WAYPOINT_ICON_SIZE = Object.freeze([34, 34]);
/** Pin-tip anchor within {@link WAYPOINT_ICON_SIZE}. */
export const WAYPOINT_ICON_ANCHOR = Object.freeze([17, 34]);

/** Markers stack above node markers (whose offset is 0). */
export const WAYPOINT_Z_INDEX_OFFSET = 500;

/**
 * Canonical fallback marker glyph: used when the payload carries no usable icon
 * codepoint, and shared with the legend swatch ({@link legendWaypointSampleHtml})
 * so the key always shows the same glyph the pins fall back to.
 */
export const FALLBACK_GLYPH = '\u{1F4CC}'; // 📌 — the waypoint's Log emoji.

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
 * Build the ``L.divIcon`` definition for one waypoint teardrop pin (design
 * 1c-B: a 24 px square in the dark overlay chrome — #1c1c1c on a --fg
 * hairline — with three round corners and one sharp corner, rotated −45° so
 * the sharp corner becomes the downward tail). The glyph is counter-rotated
 * so it reads upright inside the rotated body, and the whole pin sits in a
 * bounding box whose anchor is the tail tip.
 *
 * @param {Object} waypoint Waypoint row.
 * @param {number} nowSeconds Current time, unix seconds (expiry dimming).
 * @returns {{ className: string, html: string, iconSize: number[], iconAnchor: number[] }}
 *   Definition consumable by ``L.divIcon``.
 */
export function waypointIconDefinition(waypoint, nowSeconds) {
  const size = WAYPOINT_MARKER_SIZE;
  const opacity = waypointExpiryOpacity(waypoint && waypoint.expire, nowSeconds);
  const glyph = escapeHtml(waypointGlyph(waypoint && waypoint.icon));
  const [boxWidth, boxHeight] = WAYPOINT_ICON_SIZE;
  const inset = (boxWidth - size) / 2;
  return {
    className: '',
    html:
      `<span class="waypoint-pin" style="position:relative; display:block; width:${boxWidth}px; height:${boxHeight}px; opacity:${opacity}">` +
      `<span style="position:absolute; left:${inset}px; top:${inset}px; display:flex; align-items:center; justify-content:center; ` +
      `box-sizing:border-box; width:${size}px; height:${size}px; border-radius:50% 50% 50% 2px; background:#1c1c1c; ` +
      'border:1px solid rgba(230,235,240,0.55); box-shadow:0 2px 6px rgba(0,0,0,0.6); ' +
      'transform:rotate(-45deg); transform-origin:center">' +
      `<span style="display:block; transform:rotate(45deg); font-size:13px; line-height:1">${glyph}</span>` +
      '</span></span>',
    iconSize: [...WAYPOINT_ICON_SIZE],
    iconAnchor: [...WAYPOINT_ICON_ANCHOR],
  };
}

/**
 * Cache key for a waypoint row — the composite ``protocol|id`` the server
 * upserts on (SPEC W5); shared by the cache layer and the marker registry.
 *
 * @param {?Object} waypoint Waypoint row.
 * @returns {?string} Composite key, or null without an id.
 */
export function waypointKey(waypoint) {
  if (!waypoint || typeof waypoint !== 'object' || waypoint.id == null) return null;
  return `${waypoint.protocol ?? ''}|${waypoint.id}`;
}

/**
 * Render the waypoint layer: clear it and add one pin marker per visible
 * waypoint, binding the selection callback.
 *
 * @param {{
 *   waypoints: Array<Object>,
 *   layer: { clearLayers: Function, addLayer?: Function },
 *   leaflet: { marker: Function, divIcon: Function },
 *   nowSeconds: number,
 *   onSelect?: (waypoint: Object, anchorEl: ?Element) => void,
 *   markerRegistry?: Map<string, Object>
 * }} options Render inputs: the rows, the target ``L.layerGroup``, the
 *   Leaflet namespace (injectable for tests), the clock, the click callback
 *   (receives the waypoint and the marker's DOM element), and an optional
 *   registry map the caller owns — cleared and repopulated with
 *   ``waypointKey → marker`` each render so live updates can flash the
 *   changed pin (SPEC W8 as re-rolled).
 * @returns {number} The number of markers rendered (feeds the legend count).
 */
export function renderWaypointsLayer({ waypoints, layer, leaflet, nowSeconds, onSelect, markerRegistry }) {
  if (!layer || !leaflet || typeof leaflet.marker !== 'function' || typeof leaflet.divIcon !== 'function') {
    return 0;
  }
  layer.clearLayers();
  if (markerRegistry instanceof Map) markerRegistry.clear();
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
    if (markerRegistry instanceof Map) {
      const key = waypointKey(waypoint);
      if (key != null) markerRegistry.set(key, marker);
    }
  }
  return rows.length;
}

/**
 * Format a waypoint's remaining lifetime for display.
 *
 * @param {*} expire Raw ``expire`` unix timestamp (absent/0 ⇒ never).
 * @param {number} nowSeconds Current time, unix seconds.
 * @returns {string} ``in <duration>``, ``expired``, or ``never``.
 */
export function formatWaypointExpiry(expire, nowSeconds) {
  const ts = toFiniteNumber(expire);
  if (ts == null || ts <= 0) return 'never';
  const remaining = Math.floor(ts - nowSeconds);
  return remaining > 0 ? `in ${timeHum(remaining)}` : 'expired';
}

/**
 * Build the detail-card HTML lines for one waypoint (design 1d-C: minimal —
 * three lines: title, body, ``<expiry> · by <badge>``). Coordinates, the
 * waypoint id, and the locked-to reference live on the author's node page
 * (SPEC W11), not on the card. The caller joins with ``<br/>`` and renders
 * into the short-info overlay chrome.
 *
 * The waypoint ``name``/``description`` are user-authored text and are always
 * HTML-escaped here. The author badge is protocol-styled by the app, so it
 * arrives pre-rendered (and pre-escaped) via ``authorBadgeHtml``; when no
 * badge resolves, the canonical author id is shown instead so the card never
 * loses attribution.
 *
 * @param {Object} waypoint Waypoint row.
 * @param {{ nowSeconds: number, authorBadgeHtml?: string }} options Clock plus
 *   optional pre-rendered author badge HTML.
 * @returns {Array<string>} HTML lines for the overlay body.
 */
export function buildWaypointOverlayLines(waypoint, { nowSeconds, authorBadgeHtml = '' } = {}) {
  if (!waypoint || typeof waypoint !== 'object') return [];
  const lines = [];
  const glyph = escapeHtml(waypointGlyph(waypoint.icon));
  const name = escapeHtml(String(waypoint.name ?? 'Waypoint'));
  lines.push(`<strong>${glyph} ${name}</strong>`);

  if (waypoint.description != null && String(waypoint.description).length > 0) {
    lines.push(escapeHtml(String(waypoint.description)));
  }

  const expiresValue = formatWaypointExpiry(waypoint.expire, nowSeconds);
  const authorId = typeof waypoint.node_id === 'string' && waypoint.node_id ? waypoint.node_id : null;
  const authorHtml = authorBadgeHtml ||
    (authorId ? `<span class="mono">${escapeHtml(authorId)}</span>` : '');
  const meta = authorHtml
    ? `<span class="waypoint-card-meta">${escapeHtml(expiresValue)} · by</span> ${authorHtml}`
    : `<span class="waypoint-card-meta">${escapeHtml(expiresValue)}</span>`;
  lines.push(meta);

  return lines;
}
