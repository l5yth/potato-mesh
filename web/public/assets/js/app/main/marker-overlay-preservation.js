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
 * @module main/marker-overlay-preservation
 */

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
  const captured = [];
  if (!overlayStack || typeof overlayStack.isOpen !== 'function' || !markerByNodeId) {
    return captured;
  }
  for (const [nodeId, marker] of markerByNodeId) {
    const anchor = marker && typeof marker.getElement === 'function' ? marker.getElement() : null;
    if (anchor && overlayStack.isOpen(anchor)) {
      captured.push({ nodeId, anchor });
    }
  }
  return captured;
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
  if (
    !overlayStack ||
    typeof overlayStack.reanchor !== 'function' ||
    !Array.isArray(captured) ||
    !markerByNodeId ||
    typeof markerByNodeId.get !== 'function'
  ) {
    return 0;
  }
  let restored = 0;
  for (const entry of captured) {
    if (!entry || !entry.nodeId) {
      continue;
    }
    const marker = markerByNodeId.get(entry.nodeId);
    const newAnchor = marker && typeof marker.getElement === 'function' ? marker.getElement() : null;
    if (newAnchor && overlayStack.reanchor(entry.anchor, newAnchor)) {
      restored += 1;
    }
  }
  return restored;
}
