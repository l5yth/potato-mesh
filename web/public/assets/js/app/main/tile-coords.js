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
 * Tile-index ↔ longitude/latitude conversions for slippy map tiles.
 *
 * @module main/tile-coords
 */

/**
 * Convert a tile X coordinate to longitude degrees.
 *
 * @param {number} x Tile X index.
 * @param {number} z Zoom level.
 * @returns {number} Longitude in degrees.
 */
export function tileToLon(x, z) {
  return (x / Math.pow(2, z)) * 360 - 180;
}

/**
 * Convert a tile Y coordinate to latitude degrees.
 *
 * @param {number} y Tile Y index.
 * @param {number} z Zoom level.
 * @returns {number} Latitude in degrees.
 */
export function tileToLat(y, z) {
  const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, z);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}
