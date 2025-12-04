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

/**
 * Leaflet map instance for the federation page.
 *
 * @type {L.Map|null}
 */
let map = null;

/**
 * Leaflet layer group for instance markers.
 *
 * @type {L.LayerGroup|null}
 */
let markersLayer = null;

/**
 * Initialize the federation page by fetching instances, rendering the map,
 * and populating the table.
 *
 * @returns {Promise<void>}
 */
export async function initializeFederationPage() {
  const rawConfig = readAppConfig();
  const config = mergeConfig(rawConfig);
  const mapContainer = document.getElementById('map');
  const tableBody = document.querySelector('#instances tbody');
  const statusEl = document.getElementById('status');

  const hasLeaflet =
    typeof window !== 'undefined' &&
    typeof window.L === 'object' &&
    window.L &&
    typeof window.L.map === 'function';

  // Initialize the map if Leaflet is available
  if (hasLeaflet && mapContainer) {
    map = L.map(mapContainer, { worldCopyJump: true, attributionControl: false });
    map.setView([config.mapCenter.lat, config.mapCenter.lon], 3);

    // Determine theme and apply appropriate tile filter
    const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
    const tileFilter =
      currentTheme === 'dark' ? config.tileFilters.dark : config.tileFilters.light;

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      className: 'map-tiles'
    }).addTo(map);

    // Apply CSS filter to tiles
    const style = document.createElement('style');
    style.textContent = `.map-tiles { filter: ${tileFilter}; }`;
    document.head.appendChild(style);

    markersLayer = L.layerGroup().addTo(map);
  }

  // Fetch instances data
  let instances = [];
  try {
    const response = await fetch('/api/instances', {
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
    const bounds = [];

    for (const instance of instances) {
      const lat = Number(instance.latitude);
      const lon = Number(instance.longitude);

      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

      bounds.push([lat, lon]);

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

    // Fit bounds if we have markers
    if (bounds.length > 0) {
      try {
        map.fitBounds(bounds, { padding: [50, 50], maxZoom: 10 });
      } catch (err) {
        console.warn('Failed to fit map bounds', err);
      }
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

      tr.innerHTML = `
        <td class="instances-col instances-col--name">${nameHtml}</td>
        <td class="instances-col instances-col--domain mono">${domainHtml}</td>
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
