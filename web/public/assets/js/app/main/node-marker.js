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
 * Protocol-shaped node markers (SPEC UX7, audit D-013).
 *
 * Colour keeps encoding *role*; shape now encodes *protocol*: MeshCore nodes
 * render as square `L.divIcon` chips while Meshtastic (and anything unknown)
 * keeps the circular `L.circleMarker`. Differentiation, not privilege
 * (Invariant IV): both shapes carry identical interaction wiring and equal
 * visual weight — the shape channel simply makes the two mesh populations
 * distinguishable where an 8° hue offset could not.
 *
 * @module main/node-marker
 */

/**
 * Resolve the marker shape for a protocol.
 *
 * @param {?string} protocol Node protocol identifier.
 * @returns {'square' | 'circle'} Marker shape.
 */
export function nodeMarkerShapeForProtocol(protocol) {
  return String(protocol ?? '').toLowerCase() === 'meshcore' ? 'square' : 'circle';
}

/**
 * Create the Leaflet marker for a node.
 *
 * Circle markers receive the familiar `circleMarker` style options; square
 * chips are built from a `divIcon` whose inline style carries the same role
 * colour and bucket fill opacity, sized `2 × radius` so both shapes cover the
 * same footprint. Both returned markers expose the standard Leaflet
 * interaction surface (`on`, `bindPopup`, `bindTooltip`, …).
 *
 * @param {Object} L Leaflet namespace.
 * @param {*} latlng Marker position (Leaflet lat/lng form).
 * @param {{
 *   protocol: ?string,
 *   color: string,
 *   radius: number,
 *   fillOpacity: number,
 *   pane: (string|undefined),
 * }} options Marker styling derived from the node's role and age bucket.
 * @returns {Object} Leaflet marker (circle or divIcon-based).
 */
export function createNodeMarker(L, latlng, options) {
  const { protocol, color, radius, fillOpacity, pane } = options;
  if (nodeMarkerShapeForProtocol(protocol) === 'circle') {
    return L.circleMarker(latlng, {
      radius,
      color: '#000',
      weight: 1,
      opacity: 0.7,
      fillColor: color,
      fillOpacity,
      ...(pane ? { pane } : {}),
    });
  }
  const size = Math.round(radius * 2);
  const icon = L.divIcon({
    className: 'node-marker-chip',
    html:
      `<span class="node-marker-chip__fill" style="background:${color};opacity:${fillOpacity};` +
      `width:${size}px;height:${size}px;"></span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
  const marker = L.marker(latlng, {
    icon,
    keyboard: false,
    ...(pane ? { pane } : {}),
  });
  // Live-flash compatibility (SPEC VF3/LV1, Invariant IV): the flash helper
  // white-flashes markers via `setStyle({fillColor, fillOpacity})` and
  // restores from `marker.options`. Plain icon markers have neither, which
  // would silently drop the flash for every MeshCore node — so the chip
  // mirrors the circleMarker surface: style state lives on `options` and
  // `setStyle` restyles the chip's fill span in place.
  marker.options.fillColor = color;
  marker.options.fillOpacity = fillOpacity;
  marker.setStyle = style => {
    if (!style || typeof style !== 'object') return marker;
    if ('fillColor' in style) marker.options.fillColor = style.fillColor;
    if ('fillOpacity' in style) marker.options.fillOpacity = style.fillOpacity;
    const element = typeof marker.getElement === 'function' ? marker.getElement() : null;
    const fill = element && typeof element.querySelector === 'function'
      ? element.querySelector('.node-marker-chip__fill')
      : null;
    if (fill && fill.style) {
      if ('fillColor' in style) fill.style.background = style.fillColor;
      if ('fillOpacity' in style) fill.style.opacity = String(style.fillOpacity);
    }
    return marker;
  };
  return marker;
}
