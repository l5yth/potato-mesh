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
 * Default coordinate-bucketing precision.  Five decimal places is roughly 1.1
 * metres at the equator, which is well below the typical GPS uncertainty for
 * Meshtastic / MeshCore position reports — coordinates that match to this
 * precision are treated as the "same" location for offset purposes.
 */
const DEFAULT_PRECISION = 5;

/**
 * Default offset ring radius in pixels for a co-located group of two nodes.
 * Chosen slightly larger than the standard map marker radius so the markers
 * read as adjacent rather than overlapping.  Callers may pass ``0`` to
 * intentionally collapse all members of a group back onto the shared centre
 * — the value is honoured rather than substituted with the default so that
 * the offset feature can be disabled without touching the call sites that
 * still want grouping for other purposes.
 */
const DEFAULT_BASE_RADIUS_PX = 14;

/**
 * Tolerance (in pixels) below which an offset is considered effectively zero.
 * ``radius * Math.sin(Math.PI)`` is ~1.7e-15, not exactly ``0``, so the
 * ``isOffsetSignificant`` check uses a small epsilon rather than strict
 * equality to avoid producing zero-length spider lines for those slots.
 */
const OFFSET_EPSILON_PX = 1e-9;

/**
 * Additional pixels added to the offset ring radius for every node beyond the
 * second.  Keeps groups of five or more visually legible without growing
 * unbounded for any single pair.
 */
const DEFAULT_RADIUS_GROWTH_PX = 4;

/**
 * Build a string key used to bucket entries that share the same coordinate at
 * the requested precision.
 *
 * @param {number} lat Latitude in degrees.
 * @param {number} lon Longitude in degrees.
 * @param {number} precision Number of fractional digits to retain.
 * @returns {string} Stable bucket key.
 */
function coordinateKey(lat, lon, precision) {
  return `${lat.toFixed(precision)},${lon.toFixed(precision)}`;
}

/**
 * Upper bound on coordinate precision: ``Number.prototype.toFixed`` throws a
 * ``RangeError`` for values outside ``0..100``.
 */
const MAX_PRECISION = 100;

/**
 * Normalise the precision option to a non-negative integer in the range
 * accepted by ``Number.prototype.toFixed``, falling back to the module default
 * when the caller passes an invalid value.
 *
 * @param {number} value Caller-provided precision.
 * @returns {number} Precision used to format coordinate keys.
 */
function normalisePrecision(value) {
  if (!Number.isFinite(value) || value < 0) return DEFAULT_PRECISION;
  return Math.min(Math.floor(value), MAX_PRECISION);
}

/**
 * Normalise a positive numeric option, falling back to the supplied default
 * when the caller passes an invalid (non-finite or negative) value.
 *
 * @param {number} value Caller-provided value.
 * @param {number} fallback Default applied when ``value`` is invalid.
 * @returns {number} Sanitised numeric option.
 */
function normalisePositive(value, fallback) {
  if (!Number.isFinite(value) || value < 0) return fallback;
  return value;
}

/**
 * Filter and parse a list of node payloads down to the entries that should
 * actually be rendered as map markers.  The parsing rules mirror the legacy
 * inline loop in ``renderMap`` so behaviour stays identical:
 *
 * - ``null`` / ``undefined`` / empty-string lat or lon → skipped.
 * - lat or lon that does not parse as a finite number → skipped.
 * - When a positive ``maxDistanceKm`` is supplied, nodes whose ``distance_km``
 *   is finite and exceeds the limit are skipped.  Nodes with no ``distance_km``
 *   value are always kept regardless of the limit, matching the renderer's
 *   "show by default if we don't know" behaviour.
 *
 * The function lives in the helper module so it can be unit-tested without
 * spinning up Leaflet or the DOM environment used by the renderer.
 *
 * @param {Iterable<Object>} nodes Iterable of node payloads.
 * @param {Object} [options] Optional limits.
 * @param {number} [options.maxDistanceKm] When finite and positive, drop nodes
 *   whose ``distance_km`` field exceeds this value.
 * @returns {Array<{node: Object, lat: number, lon: number}>} Renderable
 *   entries in input order.
 */
export function buildRenderableEntries(nodes, options = {}) {
  if (!nodes || typeof nodes[Symbol.iterator] !== 'function') return [];
  const limit = Number.isFinite(options.maxDistanceKm) && options.maxDistanceKm > 0
    ? options.maxDistanceKm
    : null;
  const entries = [];
  for (const node of nodes) {
    if (!node) continue;
    const latRaw = node.latitude;
    const lonRaw = node.longitude;
    if (latRaw == null || latRaw === '' || lonRaw == null || lonRaw === '') continue;
    const lat = Number(latRaw);
    const lon = Number(lonRaw);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (limit !== null && node.distance_km != null && node.distance_km > limit) continue;
    entries.push({ node, lat, lon });
  }
  return entries;
}

/**
 * Compute pixel-space offsets that spread co-located map markers around their
 * shared coordinate so each node remains individually visible and clickable.
 *
 * The function is deliberately dependency-free and synchronous: it operates
 * entirely on plain data so that callers can unit-test the geometry without a
 * live Leaflet map in scope.  The caller is expected to translate the returned
 * ``{dx, dy}`` deltas from layer-pixel space into the final ``LatLng`` using
 * the active map projection.
 *
 * Output preserves the order of ``entries`` so that any prior render-priority
 * sort applied by the caller continues to drive draw order.  Within each
 * co-located group, the angular slot assigned to each node is determined by a
 * stable sort on ``node.node_id`` which ensures repeated renders place the
 * same node in the same slot.
 *
 * @param {Array<{node: Object, lat: number, lon: number}>} entries Renderable
 *   nodes paired with their parsed numeric coordinates.
 * @param {Object} [options] Optional tuning parameters.
 * @param {number} [options.precision=5] Decimal places used to bucket nearby
 *   coordinates into the same group.
 * @param {number} [options.baseRadiusPx=14] Pixel radius applied to a group
 *   of two nodes.
 * @param {number} [options.radiusGrowthPx=4] Pixel radius added per extra
 *   node beyond the second.
 * @returns {Array<{entry: {node: Object, lat: number, lon: number}, dx: number, dy: number}>}
 *   One result per input entry, in the original input order.  Singleton
 *   groups receive ``{dx: 0, dy: 0}``.
 */
export function computeColocatedOffsets(entries, options = {}) {
  if (!Array.isArray(entries) || entries.length === 0) return [];
  const precision = normalisePrecision(options.precision ?? DEFAULT_PRECISION);
  const baseRadiusPx = normalisePositive(options.baseRadiusPx ?? DEFAULT_BASE_RADIUS_PX, DEFAULT_BASE_RADIUS_PX);
  const radiusGrowthPx = normalisePositive(options.radiusGrowthPx ?? DEFAULT_RADIUS_GROWTH_PX, DEFAULT_RADIUS_GROWTH_PX);

  // Group entries by rounded coordinate so identical (or near-identical)
  // positions can be spread around a shared centre.  We retain each entry's
  // original index so the final result can be returned in input order.
  const groups = new Map();
  entries.forEach((entry, index) => {
    const key = coordinateKey(entry.lat, entry.lon, precision);
    let bucket = groups.get(key);
    if (!bucket) {
      bucket = [];
      groups.set(key, bucket);
    }
    bucket.push({ entry, index });
  });

  const results = new Array(entries.length);
  for (const bucket of groups.values()) {
    if (bucket.length === 1) {
      const { entry, index } = bucket[0];
      results[index] = { entry, dx: 0, dy: 0 };
      continue;
    }

    // Sort within the group by node_id so the angular slot is deterministic
    // across renders even if the caller-supplied entry order changes.  When
    // two entries share an identical id (e.g. two records with empty/missing
    // ids), fall back to the original input index so the comparator never
    // returns 0 — making the ordering portable across sort implementations
    // rather than relying on engine-specific stable-sort semantics.
    const ordered = bucket.slice().sort((a, b) => {
      const idA = a.entry?.node?.node_id ?? '';
      const idB = b.entry?.node?.node_id ?? '';
      if (idA !== idB) return idA < idB ? -1 : 1;
      return a.index - b.index;
    });

    const radius = baseRadiusPx + Math.max(0, ordered.length - 2) * radiusGrowthPx;
    const angularStep = (2 * Math.PI) / ordered.length;
    ordered.forEach((member, slot) => {
      const theta = slot * angularStep;
      results[member.index] = {
        entry: member.entry,
        dx: radius * Math.cos(theta),
        dy: radius * Math.sin(theta)
      };
    });
  }

  return results;
}

/**
 * Test whether a ``{dx, dy}`` pixel offset is large enough to materially
 * change a marker's on-screen position.  Used by the renderer to decide
 * whether to draw a spider leader line and to bypass an unnecessary
 * projection round-trip for singleton (or near-singleton) groups.
 *
 * @param {number} dx Pixel offset along the layer-point X axis.
 * @param {number} dy Pixel offset along the layer-point Y axis.
 * @returns {boolean} True when the offset magnitude exceeds ``OFFSET_EPSILON_PX``.
 */
export function isOffsetSignificant(dx, dy) {
  return Math.hypot(dx, dy) > OFFSET_EPSILON_PX;
}

/**
 * Re-position every entry in a previously-recorded spider state by re-running
 * the supplied projector and pushing the result back onto the marker / leader
 * line.  Pulled out of the renderer so it can be unit-tested without a live
 * Leaflet map: the caller injects whatever projector + Leaflet-marker shapes
 * make sense for the current host.
 *
 * Each ``state`` entry is expected to look like
 * ``{ marker, line, lat, lon, dx, dy }`` where ``lat``/``lon`` are the
 * original (un-offset) coordinates and ``marker``/``line`` may be ``null``.
 * Markers / lines that do not expose ``setLatLng`` / ``setLatLngs`` methods
 * are silently skipped so the helper is tolerant of stub objects supplied
 * by tests and of Leaflet objects whose API surface evolves over time.
 *
 * @param {Array<{marker: ?Object, line: ?Object, lat: number, lon: number, dx: number, dy: number}>} state
 *   Per-render record produced by the renderer when it places offset markers.
 * @param {(lat: number, lon: number, dx: number, dy: number) => [number, number]} project
 *   Function that converts an original coordinate plus a pixel offset into
 *   the corresponding display ``[lat, lng]`` for the current map projection.
 * @returns {void}
 */
export function refreshSpiderPositions(state, project) {
  if (!Array.isArray(state) || state.length === 0) return;
  if (typeof project !== 'function') return;
  for (const item of state) {
    if (!item) continue;
    const offsetLatLng = project(item.lat, item.lon, item.dx, item.dy);
    if (item.marker && typeof item.marker.setLatLng === 'function') {
      item.marker.setLatLng(offsetLatLng);
    }
    if (item.line && typeof item.line.setLatLngs === 'function') {
      item.line.setLatLngs([[item.lat, item.lon], offsetLatLng]);
    }
  }
}

export const __testUtils = {
  DEFAULT_PRECISION,
  DEFAULT_BASE_RADIUS_PX,
  DEFAULT_RADIUS_GROWTH_PX,
  MAX_PRECISION,
  OFFSET_EPSILON_PX,
  coordinateKey,
  normalisePrecision,
  normalisePositive
};
