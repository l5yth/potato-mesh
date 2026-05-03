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
 * Offline-fallback Leaflet ``GridLayer`` factory.
 *
 * Receives the Leaflet global as a parameter so the module remains free of
 * implicit closure dependencies while still rendering identical placeholder
 * tiles when network basemaps are unavailable.
 *
 * @module main/offline-tile-layer
 */

import { tileToLat, tileToLon } from './tile-coords.js';

/**
 * Create a minimal Leaflet tile layer that renders offline tiles from cache.
 *
 * @param {Object|null} L Leaflet global, or ``null`` when Leaflet is unavailable.
 * @returns {Object|null} Configured tile layer instance, or ``null`` when Leaflet is missing.
 */
export function createOfflineTileLayer(L) {
  if (!L || typeof L.gridLayer !== 'function') return null;
  const offlineLayer = L.gridLayer({ className: 'map-tiles map-tiles-offline' });
  /** @type {HTMLElement|null} */
  let cachedOfflineFallbackTile = null;

  /**
   * Provide a minimal placeholder tile when canvas rendering is not available.
   *
   * @param {number} size Pixel width and height of the tile.
   * @returns {HTMLElement} Cloned fallback element ready for Leaflet consumption.
   */
  function getOfflineFallbackTile(size) {
    if (!cachedOfflineFallbackTile) {
      const placeholder = document.createElement('div');
      placeholder.className = 'offline-tile-fallback';
      placeholder.style.width = `${size}px`;
      placeholder.style.height = `${size}px`;
      placeholder.style.backgroundColor = 'rgba(33, 66, 110, 0.92)';
      placeholder.style.display = 'flex';
      placeholder.style.alignItems = 'center';
      placeholder.style.justifyContent = 'center';
      placeholder.style.color = 'rgba(255, 255, 255, 0.6)';
      placeholder.style.font = 'bold 14px system-ui, sans-serif';
      placeholder.style.textTransform = 'uppercase';
      placeholder.textContent = 'Offline tile';
      cachedOfflineFallbackTile = placeholder;
    }
    return /** @type {HTMLElement} */ (cachedOfflineFallbackTile.cloneNode(true));
  }

  /**
   * Render a placeholder tile for offline map usage.
   *
   * @param {{x: number, y: number, z: number}} coords Tile coordinates supplied by Leaflet.
   * @returns {HTMLElement} Tile node containing placeholder artwork.
   */
  offlineLayer.createTile = coords => {
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      console.warn('Canvas 2D context unavailable for offline tile rendering. Using fallback placeholder.');
      return getOfflineFallbackTile(size);
    }
    try {
      const gradient = ctx.createLinearGradient(0, 0, size, size);
      gradient.addColorStop(0, 'rgba(33, 66, 110, 0.92)');
      gradient.addColorStop(1, 'rgba(64, 98, 144, 0.92)');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, size, size);

      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.lineWidth = 1;
      const steps = 4;
      for (let i = 1; i < steps; i++) {
        const pos = (size / steps) * i;
        ctx.beginPath();
        ctx.moveTo(pos, 0);
        ctx.lineTo(pos, size);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, pos);
        ctx.lineTo(size, pos);
        ctx.stroke();
      }

      const west = tileToLon(coords.x, coords.z);
      const east = tileToLon(coords.x + 1, coords.z);
      const north = tileToLat(coords.y, coords.z);
      const south = tileToLat(coords.y + 1, coords.z);

      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.font = '12px system-ui, sans-serif';
      ctx.textBaseline = 'top';
      ctx.fillText(`${west.toFixed(1)}°`, 8, 8);
      ctx.textBaseline = 'bottom';
      ctx.fillText(`${east.toFixed(1)}°`, 8, size - 8);
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      ctx.fillText(`${north.toFixed(1)}°`, size - 8, 8);
      ctx.textBaseline = 'bottom';
      ctx.fillText(`${south.toFixed(1)}°`, size - 8, size - 8);

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.font = 'bold 22px system-ui, sans-serif';
      ctx.fillText('PotatoMesh offline basemap', size / 2, size / 2);

      return canvas;
    } catch (error) {
      console.error('Failed to render offline tile. Falling back to placeholder element.', error);
      return getOfflineFallbackTile(size);
    }
  };
  return offlineLayer;
}
