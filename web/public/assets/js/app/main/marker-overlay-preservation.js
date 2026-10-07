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
 * Carry an open map-marker short-info overlay across a full map re-render
 * (item 7).
 *
 * `renderMap` clears and rebuilds every Leaflet marker on each refresh, which
 * destroys the marker DOM element an open overlay is anchored to. The overlay
 * stack's `cleanupOrphans` then closes that now-orphaned overlay, so any
 * overlay the user opened snaps shut the instant a live update lands. These two
 * pure helpers snapshot which node's marker currently hosts an open overlay
 * *before* the rebuild and re-anchor it to the rebuilt marker *after*, so the
 * overlay stays open while updates fire. They take the overlay stack and the
 * node->marker map as arguments, so they unit-test without a real map or DOM.
 *
 * Both delegate to the keyed helpers in `map-overlay-anchors.js` (SPEC DR2),
 * which carry overlays and tooltips across a rebuild for every map layer; these
 * keep the node-id-keyed shape the marker path and LD-A3 use.
 *
 * @module main/marker-overlay-preservation
 */

import { captureKeyedAnchors, restoreKeyedAnchors } from './map-overlay-anchors.js';

/**
 * Snapshot the open marker overlays, keyed by node id, before a map rebuild.
 *
 * @param {{ isOpen: Function }} overlayStack Short-info overlay stack.
 * @param {Map<string, { getElement?: Function }>} markerByNodeId Current
 *   node-id -> Leaflet marker map (the render about to be replaced).
 * @returns {Array<{ nodeId: string, anchor: Element }>} the overlays to
 *   preserve; empty when the stack/map is missing or nothing is open.
 */
export function captureOpenMarkerOverlays(overlayStack, markerByNodeId) {
  // Markers bind no tooltip, so only entries that host an overlay matter here.
  return captureKeyedAnchors(overlayStack, markerByNodeId)
    .filter(entry => entry.anchor)
    .map(entry => ({ nodeId: entry.key, anchor: entry.anchor }));
}

/**
 * Re-anchor previously-captured overlays onto the rebuilt markers.
 *
 * For each snapshot entry, the rebuilt marker for the same node id is looked up
 * and the overlay re-pointed from its old (now-detached) anchor to the new
 * marker's element. A node that vanished from the rebuild (no marker) is left
 * for `cleanupOrphans` to close, which is the correct behaviour.
 *
 * @param {{ reanchor: Function }} overlayStack Short-info overlay stack.
 * @param {Array<{ nodeId: string, anchor: Element }>} captured Snapshot from
 *   {@link captureOpenMarkerOverlays}.
 * @param {Map<string, { getElement?: Function }>} markerByNodeId Rebuilt
 *   node-id -> Leaflet marker map.
 * @returns {number} count of overlays re-anchored.
 */
export function restoreMarkerOverlays(overlayStack, captured, markerByNodeId) {
  if (!Array.isArray(captured)) return 0;
  const snapshots = captured
    .filter(entry => entry && entry.nodeId)
    .map(entry => ({ key: entry.nodeId, anchor: entry.anchor, tooltipOpen: false, tooltipLatLng: null }));
  return restoreKeyedAnchors(overlayStack, snapshots, markerByNodeId).overlays;
}
