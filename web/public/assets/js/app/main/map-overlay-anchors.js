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
 * Keep open map overlays and line tooltips on their anchors across a map
 * rebuild (SPEC DR2, extends LD-A3).
 *
 * `renderMap` clears and rebuilds the node markers, the neighbour and trace
 * lines and the waypoint pins whenever their data changes. A rebuild destroys
 * the DOM element an open short-info overlay is anchored to, so
 * `cleanupOrphans` would close the overlay, and removing a Leaflet layer
 * closes its open tooltip. These helpers snapshot, per layer key, which layer
 * hosts an open overlay or an open tooltip before the rebuild, and carry each
 * one onto the rebuilt layer with the same key afterwards.
 *
 * Keys identify what a layer depicts rather than the layer object: the node id
 * for a marker, the segment key for a line ({@link neighborSegmentKey},
 * {@link traceSegmentKey}) and the waypoint key for a pin. A key the rebuild
 * no longer draws has no layer to move to; its overlay is left for
 * `cleanupOrphans` to close, which is the intended outcome.
 *
 * The helpers take the overlay stack and the key-to-layer maps as arguments
 * and touch nothing else, so they unit-test without Leaflet or a DOM.
 *
 * @module main/map-overlay-anchors
 */

/**
 * One layer's open overlay and tooltip state, captured before a rebuild.
 *
 * @typedef {Object} AnchorSnapshot
 * @property {string} key Key of the layer in its registry.
 * @property {?Object} anchor The old layer's element when it hosts an open
 *   overlay, otherwise ``null``.
 * @property {boolean} tooltipOpen Whether the old layer's tooltip was open.
 * @property {?Object} tooltipLatLng Where the open tooltip stood, so a sticky
 *   tooltip reopens where the reader saw it; ``null`` when unknown.
 */

/**
 * Resolve a Leaflet layer's DOM element.
 *
 * @param {?Object} layer Leaflet marker or path.
 * @returns {?Object} The element, or ``null`` when the layer has none.
 */
function layerElement(layer) {
  if (!layer || typeof layer.getElement !== 'function') return null;
  return layer.getElement() || null;
}

/**
 * The tooltip bound to a layer, if any.
 *
 * @param {?Object} layer Leaflet layer.
 * @returns {?Object} The bound tooltip, or ``null``.
 */
function boundTooltip(layer) {
  return layer && typeof layer.getTooltip === 'function' ? layer.getTooltip() || null : null;
}

/**
 * Report whether a layer's tooltip is open and where it stands.
 *
 * @param {?Object} layer Leaflet layer that may carry a bound tooltip.
 * @returns {{ open: boolean, latLng: ?Object }} Tooltip state.
 */
function tooltipState(layer) {
  const tooltip = boundTooltip(layer);
  // Leaflet's isTooltipOpen() dereferences the bound tooltip and throws on a
  // layer without one (a marker, a waypoint pin), so ask only when bound.
  if (!tooltip || typeof layer.isTooltipOpen !== 'function' || !layer.isTooltipOpen()) {
    return { open: false, latLng: null };
  }
  const latLng = typeof tooltip.getLatLng === 'function' ? tooltip.getLatLng() : null;
  return { open: true, latLng: latLng || null };
}

/**
 * Snapshot every keyed layer that hosts an open overlay or an open tooltip.
 *
 * @param {?{ isOpen?: Function }} overlayStack Short-info overlay stack; a
 *   stack without ``isOpen`` captures tooltips only.
 * @param {?Map<string, Object>} layersByKey Key to Leaflet layer map of the
 *   render about to be replaced.
 * @returns {Array<AnchorSnapshot>} One entry per layer with something open, in
 *   map order; empty when the map is missing.
 */
export function captureKeyedAnchors(overlayStack, layersByKey) {
  const captured = [];
  if (!(layersByKey instanceof Map)) return captured;
  const canCheckOverlays = Boolean(overlayStack) && typeof overlayStack.isOpen === 'function';
  for (const [key, layer] of layersByKey) {
    const element = layerElement(layer);
    const anchor = canCheckOverlays && element && overlayStack.isOpen(element) ? element : null;
    const tooltip = tooltipState(layer);
    if (anchor || tooltip.open) {
      captured.push({ key, anchor, tooltipOpen: tooltip.open, tooltipLatLng: tooltip.latLng });
    }
  }
  return captured;
}

/**
 * Carry captured overlays and tooltips onto the rebuilt layers.
 *
 * An overlay is re-anchored from its detached element to the element of the
 * rebuilt layer with the same key; a tooltip is reopened on that layer at the
 * captured position. A key without a rebuilt layer is skipped.
 *
 * @param {?{ reanchor?: Function }} overlayStack Short-info overlay stack; a
 *   stack without ``reanchor`` restores tooltips only.
 * @param {?Array<AnchorSnapshot>} captured Snapshot from
 *   {@link captureKeyedAnchors}.
 * @param {?Map<string, Object>} layersByKey Key to Leaflet layer map of the
 *   rebuilt render.
 * @returns {{ overlays: number, tooltips: number }} How many overlays were
 *   re-anchored and how many tooltips reopened.
 */
export function restoreKeyedAnchors(overlayStack, captured, layersByKey) {
  const restored = { overlays: 0, tooltips: 0 };
  if (!Array.isArray(captured) || !(layersByKey instanceof Map)) return restored;
  const canReanchor = Boolean(overlayStack) && typeof overlayStack.reanchor === 'function';
  for (const entry of captured) {
    const layer = entry && layersByKey.get(entry.key);
    if (!layer) continue;
    if (entry.anchor && canReanchor) {
      const element = layerElement(layer);
      if (element && overlayStack.reanchor(entry.anchor, element)) restored.overlays += 1;
    }
    if (entry.tooltipOpen && boundTooltip(layer) && typeof layer.openTooltip === 'function') {
      // Leaflet anchors a tooltip opened without a position at the layer's
      // centre; a sticky line tooltip reopens where the reader last saw it.
      layer.openTooltip(entry.tooltipLatLng || undefined);
      restored.tooltips += 1;
    }
  }
  return restored;
}

/**
 * Segment key of a directed neighbour line (the map draws one line per
 * direction, deduplicated on the same pair).
 *
 * @param {*} sourceId Canonical id of the reporting node.
 * @param {*} targetId Canonical id of the neighbour it heard.
 * @returns {?string} ``neighbor:<source>→<target>``, or ``null`` when either
 *   id is missing.
 */
export function neighborSegmentKey(sourceId, targetId) {
  if (typeof sourceId !== 'string' || !sourceId || typeof targetId !== 'string' || !targetId) {
    return null;
  }
  return `neighbor:${sourceId}→${targetId}`;
}

/**
 * Segment key of one hop line of a traceroute: the trace id plus the hop's
 * position among that trace's drawn segments. Every segment of a trace shows
 * the same path tooltip, so the position is a stable enough anchor even when a
 * hop gains or loses its coordinates.
 *
 * @param {*} traceId Trace (packet) id; traces without one get no key.
 * @param {*} index Zero-based position of the segment within its trace.
 * @returns {?string} ``trace:<id>#<index>``, or ``null`` without a usable id
 *   or index.
 */
export function traceSegmentKey(traceId, index) {
  if (traceId == null || traceId === '' || !Number.isInteger(index) || index < 0) return null;
  return `trace:${traceId}#${index}`;
}
