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
import { roleColors } from './role-helpers.js';

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

const NODE_COUNT_COLOR_STOPS = [
  { limit: 100, color: roleColors.CLIENT_HIDDEN },
  { limit: 200, color: roleColors.SENSOR },
  { limit: 300, color: roleColors.TRACKER },
  { limit: 400, color: roleColors.CLIENT_MUTE },
  { limit: 500, color: roleColors.CLIENT },
  { limit: 600, color: roleColors.CLIENT_BASE },
  { limit: 700, color: roleColors.REPEATER },
  { limit: 800, color: roleColors.ROUTER_LATE },
  { limit: 900, color: roleColors.ROUTER }
];

const DEFAULT_INSTANCE_COLOR = roleColors.LOST_AND_FOUND || '#3388ff';

/**
 * Determine the marker colour for an instance based on its active node count.
 *
 * @param {*} count Raw node count value from the API.
 * @returns {string} CSS colour string.
 */
function colorForNodeCount(count) {
  const numeric = Number(count);
  if (!Number.isFinite(numeric) || numeric < 0) return DEFAULT_INSTANCE_COLOR;
  const stop = NODE_COUNT_COLOR_STOPS.find(entry => numeric < entry.limit);
  return stop && stop.color ? stop.color : DEFAULT_INSTANCE_COLOR;
}

/**
 * Render arbitrary contact text while hyperlinking recognised URL-like segments.
 *
 * @param {*} contact Raw contact value from the API.
 * @returns {string} HTML markup safe for insertion.
 */
function renderContactHtml(contact) {
  if (typeof contact !== 'string') return '';
  const trimmed = contact.trim();
  if (!trimmed) return '';
  const urlPattern = /(https?:\/\/[^\s]+|mailto:[^\s]+|matrix:[^\s]+)/gi;
  const parts = [];
  let lastIndex = 0;
  let match;

  while ((match = urlPattern.exec(trimmed)) !== null) {
    const textBefore = trimmed.slice(lastIndex, match.index);
    if (textBefore) {
      parts.push(escapeHtml(textBefore));
    }
    const url = match[0];
    const safeUrl = escapeHtml(url);
    parts.push(`<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeUrl}</a>`);
    lastIndex = match.index + url.length;
  }

  const trailing = trimmed.slice(lastIndex);
  if (trailing) {
    parts.push(escapeHtml(trailing));
  }

  const html = parts.join('');
  return html.replace(/\r?\n/g, '<br>');
}

/**
 * Convert a value into a finite number or null when invalid.
 *
 * @param {*} value Raw value to convert.
 * @returns {number|null} Finite number or null.
 */
function toFiniteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/**
 * Compare two string-like values ignoring case.
 *
 * @param {*} a Left-hand operand.
 * @param {*} b Right-hand operand.
 * @returns {number} Comparator result.
 */
function compareString(a, b) {
  const left = typeof a === 'string' ? a.toLowerCase() : String(a ?? '').toLowerCase();
  const right = typeof b === 'string' ? b.toLowerCase() : String(b ?? '').toLowerCase();
  return left.localeCompare(right);
}

/**
 * Compare two numeric values.
 *
 * @param {*} a Left-hand operand.
 * @param {*} b Right-hand operand.
 * @returns {number} Comparator result.
 */
function compareNumber(a, b) {
  const left = toFiniteNumber(a);
  const right = toFiniteNumber(b);
  if (left == null && right == null) return 0;
  if (left == null) return 1;
  if (right == null) return -1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * Determine whether a string-like value is present.
 *
 * @param {*} value Candidate value.
 * @returns {boolean} true when present.
 */
function hasStringValue(value) {
  if (value == null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  return String(value).trim() !== '';
}

/**
 * Determine whether a numeric value is present.
 *
 * @param {*} value Candidate value.
 * @returns {boolean} true when present.
 */
function hasNumberValue(value) {
  return toFiniteNumber(value) != null;
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
  const tableEl = document.getElementById('instances');
  const tableBody = document.querySelector('#instances tbody');
  const statusEl = document.getElementById('status');
  const sortHeaders = tableEl
    ? Array.from(tableEl.querySelectorAll('thead .sort-header[data-sort-key]'))
    : [];

  const hasLeaflet =
    typeof leaflet === 'object' &&
    leaflet &&
    typeof leaflet.map === 'function' &&
    typeof leaflet.tileLayer === 'function';

  let map = null;
  let markersLayer = null;
  let tileLayer = null;
  const tableSorters = {
    name: { getValue: inst => inst.name ?? '', compare: compareString, hasValue: hasStringValue, defaultDirection: 'asc' },
    domain: { getValue: inst => inst.domain ?? '', compare: compareString, hasValue: hasStringValue, defaultDirection: 'asc' },
    contact: { getValue: inst => inst.contactLink ?? '', compare: compareString, hasValue: hasStringValue, defaultDirection: 'asc' },
    version: { getValue: inst => inst.version ?? '', compare: compareString, hasValue: hasStringValue, defaultDirection: 'asc' },
    channel: { getValue: inst => inst.channel ?? '', compare: compareString, hasValue: hasStringValue, defaultDirection: 'asc' },
    frequency: { getValue: inst => inst.frequency ?? '', compare: compareString, hasValue: hasStringValue, defaultDirection: 'asc' },
    nodesCount: {
      getValue: inst => toFiniteNumber(inst.nodesCount ?? inst.nodes_count),
      compare: compareNumber,
      hasValue: hasNumberValue,
      defaultDirection: 'desc'
    },
    latitude: { getValue: inst => toFiniteNumber(inst.latitude), compare: compareNumber, hasValue: hasNumberValue, defaultDirection: 'asc' },
    longitude: { getValue: inst => toFiniteNumber(inst.longitude), compare: compareNumber, hasValue: hasNumberValue, defaultDirection: 'asc' },
    lastUpdateTime: {
      getValue: inst => toFiniteNumber(inst.lastUpdateTime),
      compare: compareNumber,
      hasValue: hasNumberValue,
      defaultDirection: 'desc'
    }
  };
  let sortState = {
    key: 'lastUpdateTime',
    direction: tableSorters.lastUpdateTime ? tableSorters.lastUpdateTime.defaultDirection : 'desc'
  };

  /**
   * Sort instances using the active sort configuration.
   *
   * @param {Array<Object>} data Instance rows.
   * @returns {Array<Object>} sorted rows.
   */
  const sortInstancesData = data => {
    const sorter = tableSorters[sortState.key];
    if (!sorter) return Array.isArray(data) ? [...data] : [];
    const dir = sortState.direction === 'asc' ? 1 : -1;
    return [...(data || [])].sort((a, b) => {
      const aVal = sorter.getValue(a);
      const bVal = sorter.getValue(b);
      const aHas = sorter.hasValue ? sorter.hasValue(aVal) : hasStringValue(aVal);
      const bHas = sorter.hasValue ? sorter.hasValue(bVal) : hasStringValue(bVal);
      if (aHas && bHas) {
        return sorter.compare(aVal, bVal) * dir;
      }
      if (aHas) return -1;
      if (bHas) return 1;
      return 0;
    });
  };

  /**
   * Update the visual sort indicators for the active column.
   *
   * @returns {void}
   */
  const syncSortIndicators = () => {
    if (!tableEl || !sortHeaders.length) return;
    tableEl.querySelectorAll('thead th').forEach(th => th.removeAttribute('aria-sort'));
    sortHeaders.forEach(header => {
      header.removeAttribute('data-sort-active');
      const indicator = header.querySelector('.sort-indicator');
      if (indicator) indicator.textContent = '';
    });
    const active = sortHeaders.find(header => header.dataset.sortKey === sortState.key);
    if (!active) return;
    const indicator = active.querySelector('.sort-indicator');
    if (indicator) indicator.textContent = sortState.direction === 'asc' ? '▲' : '▼';
    active.setAttribute('data-sort-active', 'true');
    const th = active.closest('th');
    if (th) {
      th.setAttribute('aria-sort', sortState.direction === 'asc' ? 'ascending' : 'descending');
    }
  };

  /**
   * Render the instances table body with sorting applied.
   *
   * @param {Array<Object>} data Instance rows.
   * @param {number} nowSec Reference timestamp for relative time rendering.
   * @returns {void}
   */
  const renderTableRows = (data, nowSec) => {
    if (!tableBody) return;
    const frag = document.createDocumentFragment();
    const sorted = sortInstancesData(data);

    for (const instance of sorted) {
      const tr = document.createElement('tr');
      const url = buildInstanceUrl(instance.domain);
      const nameHtml = instance.name ? escapeHtml(instance.name) : '<em>—</em>';
      const domainHtml = url
        ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(instance.domain || '')}</a>`
        : escapeHtml(instance.domain || '');
      const contactHtml = renderContactHtml(instance.contactLink);
      const nodesCountValue = toFiniteNumber(instance.nodesCount ?? instance.nodes_count);
      const nodesCountText = nodesCountValue == null ? '<em>—</em>' : escapeHtml(String(nodesCountValue));

      tr.innerHTML = `
        <td class="instances-col instances-col--name">${nameHtml}</td>
        <td class="instances-col instances-col--domain mono">${domainHtml}</td>
        <td class="instances-col instances-col--contact">${contactHtml || '<em>—</em>'}</td>
        <td class="instances-col instances-col--version mono">${escapeHtml(instance.version || '')}</td>
        <td class="instances-col instances-col--channel">${escapeHtml(instance.channel || '')}</td>
        <td class="instances-col instances-col--frequency">${escapeHtml(instance.frequency || '')}</td>
        <td class="instances-col instances-col--nodes mono">${nodesCountText}</td>
        <td class="instances-col instances-col--latitude mono">${fmtCoords(instance.latitude)}</td>
        <td class="instances-col instances-col--longitude mono">${fmtCoords(instance.longitude)}</td>
        <td class="instances-col instances-col--last-update mono">${timeAgo(instance.lastUpdateTime, nowSec)}</td>
      `;

      frag.appendChild(tr);
    }

    tableBody.replaceChildren(frag);
    syncSortIndicators();
  };

  /**
   * Wire up click and keyboard handlers for sortable headers.
   *
   * @param {Function} rerender Callback to refresh the table.
   * @returns {void}
   */
  const attachSortHandlers = rerender => {
    if (!sortHeaders.length) return;
    const applySortKey = key => {
      if (!key) return;
      if (sortState.key === key) {
        sortState = { key, direction: sortState.direction === 'asc' ? 'desc' : 'asc' };
      } else {
        const defaultDir = tableSorters[key]?.defaultDirection || 'asc';
        sortState = { key, direction: defaultDir };
      }
      rerender();
    };

    sortHeaders.forEach(header => {
      const key = header.dataset.sortKey;
      header.addEventListener('click', () => applySortKey(key));
      header.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          applySortKey(key);
        }
      });
    });
  };

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
    const bounds = [];
    const canRenderLegend =
      typeof leaflet.control === 'function' && leaflet.DomUtil && typeof leaflet.DomUtil.create === 'function';
    if (canRenderLegend) {
      const legendStops = NODE_COUNT_COLOR_STOPS.map((stop, index) => {
        const lower = index === 0 ? 0 : NODE_COUNT_COLOR_STOPS[index - 1].limit;
        const upper = stop.limit - 1;
        const label = index === 0 ? `< ${stop.limit} nodes` : `${lower}-${upper} nodes`;
        return { color: stop.color || DEFAULT_INSTANCE_COLOR, label };
      });
      const lastLimit = NODE_COUNT_COLOR_STOPS[NODE_COUNT_COLOR_STOPS.length - 1]?.limit || 900;
      legendStops.push({ color: DEFAULT_INSTANCE_COLOR, label: `≥ ${lastLimit} nodes` });

      const legend = leaflet.control({ position: 'bottomright' });
      legend.onAdd = function onAdd() {
        const container = leaflet.DomUtil.create('div', 'legend legend--instances');
        container.setAttribute('aria-label', 'Active nodes legend');
        const header = leaflet.DomUtil.create('div', 'legend-header', container);
        const title = leaflet.DomUtil.create('span', 'legend-title', header);
        title.textContent = 'Active nodes';
        const items = leaflet.DomUtil.create('div', 'legend-items', container);
        legendStops.forEach(stop => {
          const item = leaflet.DomUtil.create('div', 'legend-item', items);
          item.setAttribute('aria-hidden', 'true');
          const swatch = leaflet.DomUtil.create('span', 'legend-swatch', item);
          swatch.style.background = stop.color;
          const label = leaflet.DomUtil.create('span', 'legend-label', item);
          label.textContent = stop.label;
        });
        return container;
      };
      legend.addTo(map);
    }

    for (const instance of instances) {
      const lat = Number(instance.latitude);
      const lon = Number(instance.longitude);

      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

      bounds.push([lat, lon]);

      const name = instance.name || instance.domain || 'Unknown';
      const url = buildInstanceUrl(instance.domain);
      const nodeCountValue = toFiniteNumber(instance.nodesCount ?? instance.nodes_count);
      const popupLines = [
        url
          ? `<strong><a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(name)}</a></strong>`
          : `<strong>${escapeHtml(name)}</strong>`,
        `<span class="mono">${escapeHtml(instance.domain || '')}</span>`,
        instance.channel ? `Channel: ${escapeHtml(instance.channel)}` : '',
        instance.frequency ? `Frequency: ${escapeHtml(instance.frequency)}` : '',
        instance.version ? `Version: ${escapeHtml(instance.version)}` : '',
        nodeCountValue != null ? `Active nodes (24h): ${escapeHtml(String(nodeCountValue))}` : ''
      ].filter(Boolean);

      const marker = leaflet.circleMarker([lat, lon], {
        radius: 9,
        fillColor: colorForNodeCount(nodeCountValue),
        color: '#000',
        weight: 1,
        opacity: 0.8,
        fillOpacity: 0.75
      });

      marker.bindPopup(popupLines.join('<br>'));
      markersLayer.addLayer(marker);
    }

    if (bounds.length > 0 && typeof map.fitBounds === 'function') {
      try {
        map.fitBounds(bounds, { padding: [50, 50], maxZoom: 10 });
      } catch (err) {
        console.warn('Failed to fit federation map bounds', err);
      }
    }
  }

  // Render table
  if (tableBody && Array.isArray(instances)) {
    attachSortHandlers(() => renderTableRows(instances, nowSec));
    renderTableRows(instances, nowSec);
  }
}
