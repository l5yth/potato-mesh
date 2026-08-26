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
 * render as equal-area rotated-diamond `L.divIcon` chips while Meshtastic (and
 * anything unknown) keeps the circular `L.circleMarker`. Differentiation, not
 * privilege (Invariant IV): both shapes carry identical interaction wiring and
 * equal visual weight — the shape channel simply makes the two mesh populations
 * distinguishable where an 8° hue offset could not.
 *
 * @module main/node-marker
 */

/**
 * Resolve the marker shape for a protocol.
 *
 * Reticulum returns `hexagon` (SPEC RD6). That branch is a **reserved slot** on
 * the map: a Reticulum announce carries no position, so no RNS node currently
 * reaches {@link createNodeMarker}. It is implemented rather than stubbed so
 * the shape channel is complete the moment positions exist, and because the
 * legend swatch — which *is* live — derives its shape from this same function
 * (SPEC LC1).
 *
 * @param {?string} protocol Node protocol identifier.
 * @returns {'square' | 'hexagon' | 'circle'} Marker shape.
 */
export function nodeMarkerShapeForProtocol(protocol) {
  const normalized = String(protocol ?? '').toLowerCase();
  if (normalized === 'meshcore') return 'square';
  if (normalized === 'reticulum') return 'hexagon';
  return 'circle';
}

/**
 * Equal-area chip side length, as a multiple of the circle marker's radius.
 *
 * A raw `2 × radius` box out-weighs the circle it replaces, so each shape is
 * scaled to ≈ the circle's `πr²` footprint (SPEC FU3). The rotated square keeps
 * its full box area, hence `√π ≈ 1.78`; the hexagon's clip-path removes four
 * corner triangles totalling 27 % of the box, so it needs `√(π / 0.73) ≈ 2.07`
 * to land on the same optical weight.
 *
 * @type {Readonly<Record<string, number>>}
 */
const CHIP_AREA_SCALE = Object.freeze({ square: 1.78, hexagon: 2.07 });

/**
 * Create the Leaflet marker for a node.
 *
 * Circle markers receive the familiar `circleMarker` style options; MeshCore
 * chips are built from a `divIcon` whose inline style carries the same role
 * colour and bucket fill opacity, sized `round(radius × 1.78)` so the chip —
 * rotated 45° into a diamond and corner-rounded by `base.css` — covers ≈ the
 * circle's `πr²` optical area (a raw `2 × radius` square reads ~27 % heavier).
 * Both returned markers expose the standard Leaflet interaction surface
 * (`on`, `bindPopup`, `bindTooltip`, …).
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
  const shape = nodeMarkerShapeForProtocol(protocol);
  if (shape === 'circle') {
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
  // Equal-area sizing (audit follow-up 03): a `2 × radius` square out-weighs
  // the circle it replaces by ~27 %. `radius × 1.78` (16 px at radius 9) lands
  // the 45°-rotated, corner-rounded chip at ≈ the circle's πr² footprint. The
  // rotation is CSS-only, so the divIcon box stays `size × size` and the anchor
  // is unchanged; the rotated diagonal (~22.6 px) shows via the chip's
  // `overflow: visible`.
  // `circle` returned above, so the shape is necessarily a keyed chip here —
  // no fallback, which would be an unreachable branch.
  const size = Math.round(radius * CHIP_AREA_SCALE[shape]);
  // The base `__fill` class carries the diamond; a modifier swaps in another
  // shape, so MeshCore's chip is byte-identical to what it rendered before the
  // hexagon existed (FU-A3 / UX-A5 stay green).
  const shapeClass = shape === 'square' ? '' : ` node-marker-chip__fill--${shape}`;
  const icon = L.divIcon({
    className: 'node-marker-chip',
    html:
      `<span class="node-marker-chip__fill${shapeClass}" style="background:${color};opacity:${fillOpacity};` +
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
