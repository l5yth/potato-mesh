/*
 * Copyright © 2025-26 l5yth & contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * You may not use this file except in compliance with the License.
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
 * Convert raw numeric identifiers into finite numbers.
 *
 * @param {*} value Candidate numeric value.
 * @returns {number|null} Finite number or ``null`` when invalid.
 */
function coerceFiniteNumber(value) {
  if (value == null) return null;
  if (typeof value === 'string' && value.trim().length === 0) return null;
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : null;
}

/**
 * Build lookup tables for locating nodes by identifier.
 *
 * @param {Array<Object>} nodes Node payloads.
 * @returns {{ byId: Map<string, Object>, byNum: Map<number, Object> }} Lookup maps.
 */
function buildNodeIndex(nodes) {
  const byId = new Map();
  const byNum = new Map();
  if (!Array.isArray(nodes)) {
    return { byId, byNum };
  }
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    const nodeIdRaw = typeof node.node_id === 'string'
      ? node.node_id
      : (typeof node.nodeId === 'string' ? node.nodeId : null);
    if (nodeIdRaw) {
      const trimmed = nodeIdRaw.trim();
      if (trimmed.length) {
        byId.set(trimmed, node);
        const numericFromId = coerceFiniteNumber(trimmed);
        if (numericFromId != null && !byNum.has(numericFromId)) {
          byNum.set(numericFromId, node);
        }
      }
    }
    const candidates = [node.num, node.node_num, node.nodeNum];
    for (const candidate of candidates) {
      const num = coerceFiniteNumber(candidate);
      if (num == null || byNum.has(num)) continue;
      byNum.set(num, node);
    }
  }
  return { byId, byNum };
}

/**
 * Locate a node by either string identifier or numeric reference.
 *
 * @param {Map<string, Object>} byId Lookup keyed by canonical identifier.
 * @param {Map<number, Object>} byNum Lookup keyed by numeric identifier.
 * @param {*} ref Raw reference number or string.
 * @returns {Object|null} Node payload or ``null`` when absent.
 */
function findNode(byId, byNum, ref) {
  const numeric = coerceFiniteNumber(ref);
  const stringId = typeof ref === 'string' ? ref.trim() : null;
  if (stringId && byId.has(stringId)) {
    return byId.get(stringId) || null;
  }
  if (numeric != null) {
    if (byNum.has(numeric)) return byNum.get(numeric) || null;
    const asString = String(numeric);
    if (byId.has(asString)) return byId.get(asString) || null;
  }
  return null;
}

/**
 * Resolve a coordinate pair for a node when a valid location is present and
 * optionally within the configured range.
 *
 * @param {Object} node Node payload.
 * @param {{ limitDistance?: boolean, maxDistanceKm?: number }} options Distance filtering options.
 * @returns {[number, number]|null} ``[lat, lon]`` tuple or ``null`` when unusable.
 */
function resolveNodeCoordinates(node, { limitDistance = false, maxDistanceKm = null } = {}) {
  if (!node || typeof node !== 'object') return null;
  const lat = coerceFiniteNumber(node.latitude ?? node.lat);
  const lon = coerceFiniteNumber(node.longitude ?? node.lon);
  if (lat == null || lon == null) return null;
  const enforceDistance = Boolean(limitDistance) && Number.isFinite(maxDistanceKm);
  if (enforceDistance) {
    const distance = coerceFiniteNumber(node.distance_km ?? node.distanceKm);
    if (distance != null && distance > maxDistanceKm) return null;
  }
  return [lat, lon];
}

/**
 * Normalise a traceroute payload into a list of ordered node references.
 *
 * @param {Object} trace Trace payload.
 * @returns {Array<number>} Ordered identifiers including source, hops, and destination.
 */
function extractTracePath(trace) {
  if (!trace || typeof trace !== 'object') return [];
  const path = [];
  const source = coerceFiniteNumber(trace.src ?? trace.source ?? trace.from);
  if (source != null) {
    path.push(source);
  }
  const hops = Array.isArray(trace.hops) ? trace.hops : [];
  for (const hop of hops) {
    const hopId = coerceFiniteNumber(hop);
    if (hopId != null) {
      path.push(hopId);
    }
  }
  const dest = coerceFiniteNumber(trace.dest ?? trace.destination ?? trace.to);
  if (dest != null) {
    path.push(dest);
  }
  return path;
}

/**
 * Build drawable line segments for traceroute records using available node
 * coordinates. Segments are only created when both endpoints have valid
 * locations; missing hops break the chain rather than skipping ahead.
 *
 * @param {Array<Object>} traces Trace payloads fetched from the API.
 * @param {Array<Object>} nodes Node payloads currently in view.
 * @param {{
 *   limitDistance?: boolean,
 *   maxDistanceKm?: number,
 *   colorForNode?: (node: Object) => string
 * }} [options] Rendering options.
 * @returns {Array<Object>} Drawable segment descriptors.
 */
export function buildTraceSegments(traces, nodes, { limitDistance = false, maxDistanceKm = null, colorForNode } = {}) {
  if (!Array.isArray(traces) || !Array.isArray(nodes) || nodes.length === 0) {
    return [];
  }

  const { byId, byNum } = buildNodeIndex(nodes);
  const segments = [];
  const colorResolver = typeof colorForNode === 'function'
    ? colorForNode
    : () => '#3388ff';

  for (const trace of traces) {
    const path = extractTracePath(trace);
    if (path.length < 2) continue;
    const rxTime = coerceFiniteNumber(trace.rx_time ?? trace.rxTime);
    let previous = null;

    for (const ref of path) {
      const node = findNode(byId, byNum, ref);
      const coords = resolveNodeCoordinates(node, { limitDistance, maxDistanceKm });
      if (!node || !coords) {
        previous = null;
        continue;
      }
      if (previous) {
        segments.push({
          latlngs: [previous.coords, coords],
          color: colorResolver(previous.node),
          traceId: trace.id ?? trace.packet_id ?? trace.trace_id,
          rxTime,
        });
      }
      previous = { node, coords };
    }
  }

  return segments;
}

export const __testUtils = {
  coerceFiniteNumber,
  buildNodeIndex,
  findNode,
  resolveNodeCoordinates,
  extractTracePath,
};
