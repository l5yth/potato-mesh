/*
 * Copyright (C) 2025 l5yth
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

const EARTH_RADIUS_KM = 6371;
const RAD_TO_DEG = 180 / Math.PI;
const DEFAULT_MIN_RANGE_KM = 0.5;
const POLE_LONGITUDE_SPAN_DEGREES = 180;
const COS_EPSILON = 1e-6;

/**
 * Clamp a latitude value to the valid WGS84 range.
 *
 * @param {number} latitude Latitude in degrees.
 * @returns {number} Latitude clamped to [-90, 90].
 */
function clampLatitude(latitude) {
  if (!Number.isFinite(latitude)) {
    return latitude < 0 ? -90 : 90;
  }
  return Math.max(-90, Math.min(90, latitude));
}

/**
 * Clamp a longitude value to the valid WGS84 range.
 *
 * @param {number} longitude Longitude in degrees.
 * @returns {number} Longitude clamped to [-180, 180].
 */
function clampLongitude(longitude) {
  if (!Number.isFinite(longitude)) {
    return longitude < 0 ? -180 : 180;
  }
  if (longitude < -180) return -180;
  if (longitude > 180) return 180;
  return longitude;
}

/**
 * Convert degrees to radians.
 *
 * @param {number} degrees Angle in degrees.
 * @returns {number} Angle in radians.
 */
export function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

/**
 * Compute the great-circle distance between two coordinates using the
 * haversine formula.
 *
 * @param {number} lat1 Latitude of the first point in degrees.
 * @param {number} lon1 Longitude of the first point in degrees.
 * @param {number} lat2 Latitude of the second point in degrees.
 * @param {number} lon2 Longitude of the second point in degrees.
 * @returns {number} Distance in kilometres.
 */
export function haversineDistanceKm(lat1, lon1, lat2, lon2) {
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const a = sinLat * sinLat + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * sinLon * sinLon;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
}

/**
 * Normalise range inputs to a safe, positive value.
 *
 * @param {number} rangeKm Requested range in kilometres.
 * @param {number} minimumRangeKm Minimum permitted range in kilometres.
 * @returns {number} Normalised range in kilometres.
 */
function normaliseRange(rangeKm, minimumRangeKm) {
  const minRange = Number.isFinite(minimumRangeKm) && minimumRangeKm > 0 ? minimumRangeKm : DEFAULT_MIN_RANGE_KM;
  if (!Number.isFinite(rangeKm) || rangeKm <= 0) {
    return minRange;
  }
  return Math.max(rangeKm, minRange);
}

/**
 * Compute a geographic bounding box for a circular range centred on a point.
 *
 * The resulting bounds are suitable for use with Leaflet ``fitBounds`` and
 * similar APIs that accept a ``[[south, west], [north, east]]`` tuple.
 *
 * @param {{lat: number, lon: number}} center Map centre coordinate.
 * @param {number} rangeKm Desired radius from the centre in kilometres.
 * @param {{ minimumRangeKm?: number }} [options] Optional configuration.
 * @returns {[[number, number], [number, number]] | null} Bounding box tuple or
 *   ``null`` when the inputs are invalid.
 */
export function computeBoundingBox(center, rangeKm, options = {}) {
  if (!center || !Number.isFinite(center.lat) || !Number.isFinite(center.lon)) {
    return null;
  }
  const minRange = Number.isFinite(options.minimumRangeKm) && options.minimumRangeKm > 0
    ? options.minimumRangeKm
    : DEFAULT_MIN_RANGE_KM;
  const radiusKm = normaliseRange(rangeKm, minRange);
  const angularDistance = radiusKm / EARTH_RADIUS_KM;
  const latDelta = angularDistance * RAD_TO_DEG;
  const minLat = clampLatitude(center.lat - latDelta);
  const maxLat = clampLatitude(center.lat + latDelta);

  const cosLat = Math.cos(toRadians(center.lat));
  let lonDelta;
  if (Math.abs(cosLat) < COS_EPSILON) {
    lonDelta = POLE_LONGITUDE_SPAN_DEGREES;
  } else {
    lonDelta = Math.min(POLE_LONGITUDE_SPAN_DEGREES, (angularDistance * RAD_TO_DEG) / Math.max(Math.abs(cosLat), COS_EPSILON));
  }
  if (!Number.isFinite(lonDelta) || lonDelta >= POLE_LONGITUDE_SPAN_DEGREES) {
    return [[minLat, -POLE_LONGITUDE_SPAN_DEGREES], [maxLat, POLE_LONGITUDE_SPAN_DEGREES]];
  }

  const minLon = clampLongitude(center.lon - lonDelta);
  const maxLon = clampLongitude(center.lon + lonDelta);
  return [[minLat, minLon], [maxLat, maxLon]];
}

/**
 * Determine a bounding box that encloses the provided coordinates with a
 * configurable safety margin.
 *
 * @param {Array<[number, number]>} points Collection of ``[lat, lon]`` pairs.
 * @param {{
 *   paddingFraction?: number,
 *   minimumRangeKm?: number
 * }} [options] Optional configuration controlling the computed bounds.
 * @returns {[[number, number], [number, number]] | null} Bounding box tuple or
 *   ``null`` when the input list is empty or invalid.
 */
export function computeBoundsForPoints(points, options = {}) {
  if (!Array.isArray(points) || !points.length) {
    return null;
  }
  const validPoints = points.filter(point => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]));
  if (!validPoints.length) {
    return null;
  }

  let latSum = 0;
  let lonSum = 0;
  for (const [lat, lon] of validPoints) {
    latSum += lat;
    lonSum += lon;
  }
  const centre = {
    lat: latSum / validPoints.length,
    lon: lonSum / validPoints.length
  };

  let maxDistanceKm = 0;
  for (const [lat, lon] of validPoints) {
    const distance = haversineDistanceKm(centre.lat, centre.lon, lat, lon);
    if (distance > maxDistanceKm) {
      maxDistanceKm = distance;
    }
  }

  const paddingFraction = Number.isFinite(options.paddingFraction) && options.paddingFraction >= 0
    ? options.paddingFraction
    : 0.15;
  const minimumRangeKm = Number.isFinite(options.minimumRangeKm) && options.minimumRangeKm > 0
    ? options.minimumRangeKm
    : DEFAULT_MIN_RANGE_KM;
  const paddedRangeKm = Math.max(minimumRangeKm, maxDistanceKm * (1 + paddingFraction));
  return computeBoundingBox(centre, paddedRangeKm, { minimumRangeKm });
}

export const __testUtils = {
  clampLatitude,
  clampLongitude,
  normaliseRange
};
