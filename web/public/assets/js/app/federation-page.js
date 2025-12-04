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

import { readAppConfig } from './config.js';
import { mergeConfig } from './settings.js';

/**
 * Escape HTML special characters to prevent XSS.
 *
 * @param {string} str Raw string to escape.
 * @returns {string} Escaped string safe for HTML insertion.
 */
function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Format a coordinate value to fixed decimal places.
 *
 * @param {number|null|undefined} v Coordinate value.
 * @param {number} d Decimal places (default 5).
 * @returns {string} Formatted coordinate or empty string.
 */
function fmtCoords(v, d = 5) {
  if (v == null || v === '') return '';
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  return n.toFixed(d);
}

/**
 * Convert a Unix timestamp to a human-readable relative time string.
 *
 * @param {number|null|undefined} unixSec Unix timestamp in seconds.
 * @param {number} nowSec Current timestamp in seconds.
 * @returns {string} Relative time string or empty string.
 */
function timeAgo(unixSec, nowSec = Date.now() / 1000) {
  if (unixSec == null || unixSec === '') return '';
  const ts = Number(unixSec);
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const diff = Math.max(0, Math.floor(nowSec - ts));
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

/**
 * Build a navigable URL for an instance domain.
 *
 * @param {string} domain Instance domain.
 * @returns {string|null} Navigable URL or null.
 */
function buildInstanceUrl(domain) {
  if (typeof domain !== 'string' || !domain.trim()) return null;
  const trimmed = domain.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

const TILE_LAYER_URL = 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png';

/**
 * Initialize the federation page by fetching instances, rendering the map,
 * and populating the table.
 *
 * @param {{
 *   config?: object,
 *   fetchImpl?: typeof fetch,
 *   leaflet?: typeof L
 * }} [options] Optional overrides for testing.
 * @returns {Promise<void>}
 */
export async function initializeFederationPage(options = {}) {
  const rawConfig = options.config || readAppConfig();
  const config = mergeConfig(rawConfig);
  const fetchImpl = options.fetchImpl || fetch;
  const leaflet = options.leaflet || (typeof window !== 'undefined' ? window.L : null);
  const mapContainer = document.getElementById('map');
  const tableBody = document.querySelector('#instances tbody');
  const statusEl = document.getElementById('status');

  const hasLeaflet =
    typeof leaflet === 'object' &&
    leaflet &&
    typeof leaflet.map === 'function' &&
    typeof leaflet.tileLayer === 'function';

  let map = null;
  let markersLayer = null;
  let tileLayer = null;

  /**
   * Resolve the active theme based on the DOM state.
   *
   * @returns {'dark' | 'light'}
   */
  const resolveTheme = () => {
    if (document.body && document.body.classList.contains('dark')) return 'dark';
    const htmlTheme = document.documentElement?.getAttribute('data-theme');
    if (htmlTheme === 'dark' || htmlTheme === 'light') return htmlTheme;
    return 'dark';
  };

  /**
   * Apply the configured CSS filter to the active tile container.
   *
   * @returns {void}
   */
  const applyTileFilter = () => {
    if (!tileLayer) return;
    const theme = resolveTheme();
    const filterValue = theme === 'dark' ? config.tileFilters.dark : config.tileFilters.light;
    const container =
      typeof tileLayer.getContainer === 'function' ? tileLayer.getContainer() : null;
    if (container && container.style) {
      container.style.filter = filterValue;
      container.style.webkitFilter = filterValue;
    }
    const tilePane = map && typeof map.getPane === 'function' ? map.getPane('tilePane') : null;
    if (tilePane && tilePane.style) {
      tilePane.style.filter = filterValue;
      tilePane.style.webkitFilter = filterValue;
    }
    const tileNodes = [];
    if (container && typeof container.querySelectorAll === 'function') {
      tileNodes.push(...container.querySelectorAll('.leaflet-tile'));
    }
    if (tilePane && typeof tilePane.querySelectorAll === 'function') {
      tileNodes.push(...tilePane.querySelectorAll('.leaflet-tile'));
    }
    tileNodes.forEach(tile => {
      if (tile && tile.style) {
        tile.style.filter = filterValue;
        tile.style.webkitFilter = filterValue;
      }
    });
  };

  // Initialize the map if Leaflet is available
  if (hasLeaflet && mapContainer) {
    const initialZoom = Number.isFinite(config.mapZoom) ? config.mapZoom : 5;
    map = leaflet.map(mapContainer, { worldCopyJump: true, attributionControl: false });
    map.setView([config.mapCenter.lat, config.mapCenter.lon], initialZoom);

    tileLayer = leaflet
      .tileLayer(TILE_LAYER_URL, {
        maxZoom: 19,
        className: 'map-tiles',
        crossOrigin: 'anonymous'
      })
      .addTo(map);

    tileLayer.on?.('load', applyTileFilter);
    applyTileFilter();

    window.addEventListener('themechange', applyTileFilter);
    markersLayer = leaflet.layerGroup().addTo(map);
  }

  // Fetch instances data
  let instances = [];
  try {
    const response = await fetchImpl('/api/instances', {
      headers: { Accept: 'application/json' },
      credentials: 'omit'
    });
    if (response.ok) {
      instances = await response.json();
    }
  } catch (err) {
    console.warn('Failed to fetch federation instances', err);
  }

  if (statusEl) {
    statusEl.textContent = `${instances.length} instances`;
    statusEl.classList.remove('pill--loading');
  }

  const nowSec = Date.now() / 1000;

  // Render map markers
  if (map && markersLayer && hasLeaflet && Array.isArray(instances)) {
    for (const instance of instances) {
      const lat = Number(instance.latitude);
      const lon = Number(instance.longitude);

      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

      const name = instance.name || instance.domain || 'Unknown';
      const url = buildInstanceUrl(instance.domain);
      const popupContent = url
        ? `<strong><a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(name)}</a></strong><br>
           <span class="mono">${escapeHtml(instance.domain || '')}</span><br>
           ${instance.channel ? `Channel: ${escapeHtml(instance.channel)}<br>` : ''}
           ${instance.frequency ? `Frequency: ${escapeHtml(instance.frequency)}<br>` : ''}
           ${instance.version ? `Version: ${escapeHtml(instance.version)}` : ''}`
        : `<strong>${escapeHtml(name)}</strong>`;

      const marker = L.circleMarker([lat, lon], {
        radius: 8,
        fillColor: '#4CAF50',
        color: '#2E7D32',
        weight: 2,
        opacity: 1,
        fillOpacity: 0.8
      });

      marker.bindPopup(popupContent);
      markersLayer.addLayer(marker);
    }
  }

  // Render table
  if (tableBody && Array.isArray(instances)) {
    const frag = document.createDocumentFragment();

    for (const instance of instances) {
      const tr = document.createElement('tr');
      const url = buildInstanceUrl(instance.domain);
      const nameHtml = instance.name
        ? escapeHtml(instance.name)
        : '<em>—</em>';
      const domainHtml = url
        ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(instance.domain || '')}</a>`
        : escapeHtml(instance.domain || '');
      const contact = instance.contactLink ? escapeHtml(instance.contactLink) : '';
      const contactHtml = contact ? `<span class="mono">${contact}</span>` : '<em>—</em>';

      tr.innerHTML = `
        <td class="instances-col instances-col--name">${nameHtml}</td>
        <td class="instances-col instances-col--domain mono">${domainHtml}</td>
        <td class="instances-col instances-col--contact">${contactHtml}</td>
        <td class="instances-col instances-col--version mono">${escapeHtml(instance.version || '')}</td>
        <td class="instances-col instances-col--channel">${escapeHtml(instance.channel || '')}</td>
        <td class="instances-col instances-col--frequency">${escapeHtml(instance.frequency || '')}</td>
        <td class="instances-col instances-col--latitude mono">${fmtCoords(instance.latitude)}</td>
        <td class="instances-col instances-col--longitude mono">${fmtCoords(instance.longitude)}</td>
        <td class="instances-col instances-col--last-update mono">${timeAgo(instance.lastUpdateTime, nowSec)}</td>
      `;

      frag.appendChild(tr);
    }

    tableBody.replaceChildren(frag);
  }
}
