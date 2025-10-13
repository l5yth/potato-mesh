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

import { computeBoundingBox, computeBoundsForPoints, haversineDistanceKm } from './map-bounds.js';
import { createMapAutoFitController } from './map-auto-fit-controller.js';
import { attachNodeInfoRefreshToMarker, overlayToPopupNode } from './map-marker-node-info.js';
import { refreshNodeInformation } from './node-details.js';

/**
 * Entry point for the interactive dashboard. Wires up event listeners,
 * initializes the map, and triggers the first data refresh cycle.
 *
 * @param {{
 *   refreshMs: number,
 *   refreshIntervalSeconds: number,
 *   chatEnabled: boolean,
 *   channel: string,
 *   frequency: string,
 *   mapCenter: { lat: number, lon: number },
 *   maxDistanceKm: number,
 *   tileFilters: { light: string, dark: string }
 * }} config Normalized application configuration.
 * @returns {void}
 */
export function initializeApp(config) {
  const statusEl = document.getElementById('status');
  const fitBoundsEl = document.getElementById('fitBounds');
  const autoRefreshEl = document.getElementById('autoRefresh');
  const refreshBtn = document.getElementById('refreshBtn');
  const filterInput = document.getElementById('filterInput');
  const filterClearButton = document.getElementById('filterClear');
  const themeToggle = document.getElementById('themeToggle');
  const infoBtn = document.getElementById('infoBtn');
  const infoOverlay = document.getElementById('infoOverlay');
  const infoClose = document.getElementById('infoClose');
  const infoDialog = infoOverlay ? infoOverlay.querySelector('.info-dialog') : null;
  const shortInfoOverlay = document.getElementById('shortInfoOverlay');
  const shortInfoClose = shortInfoOverlay ? shortInfoOverlay.querySelector('.short-info-close') : null;
  const shortInfoContent = shortInfoOverlay ? shortInfoOverlay.querySelector('.short-info-content') : null;
  const titleEl = document.querySelector('title');
  const headerEl = document.querySelector('h1');
  const headerTitleTextEl = headerEl ? headerEl.querySelector('.site-title-text') : null;
  const chatEl = document.getElementById('chat');
  const refreshInfo = document.getElementById('refreshInfo');
  const baseTitle = document.title;
  const nodesTable = document.getElementById('nodes');
  const sortButtons = nodesTable ? Array.from(nodesTable.querySelectorAll('thead .sort-button[data-sort-key]')) : [];
  /**
   * Column sorter configuration for the node table.
   *
   * Each entry provides a value extractor, comparator, and optional
   * presence checker used to sort the rendered rows.
   *
   * @type {Record<string, {getValue: Function, compare: Function, hasValue?: Function, defaultDirection: 'asc' | 'desc'}>}
   */
  const tableSorters = {
    node_id: { getValue: n => n.node_id, compare: compareString, hasValue: hasStringValue, defaultDirection: 'asc' },
    short_name: { getValue: n => n.short_name, compare: compareString, hasValue: hasStringValue, defaultDirection: 'asc' },
    long_name: { getValue: n => n.long_name, compare: compareString, hasValue: hasStringValue, defaultDirection: 'asc' },
    last_heard: { getValue: n => n.last_heard, compare: compareNumber, hasValue: hasNumberValue, defaultDirection: 'desc' },
    role: { getValue: n => n.role, compare: compareString, hasValue: hasStringValue, defaultDirection: 'asc' },
    hw_model: { getValue: n => n.hw_model, compare: compareString, hasValue: hasStringValue, defaultDirection: 'asc' },
    battery_level: { getValue: n => n.battery_level, compare: compareNumber, hasValue: hasNumberValue, defaultDirection: 'desc' },
    voltage: { getValue: n => n.voltage, compare: compareNumber, hasValue: hasNumberValue, defaultDirection: 'desc' },
    uptime_seconds: { getValue: n => n.uptime_seconds, compare: compareNumber, hasValue: hasNumberValue, defaultDirection: 'desc' },
    channel_utilization: { getValue: n => n.channel_utilization, compare: compareNumber, hasValue: hasNumberValue, defaultDirection: 'desc' },
    air_util_tx: { getValue: n => n.air_util_tx, compare: compareNumber, hasValue: hasNumberValue, defaultDirection: 'desc' },
    temperature: { getValue: n => n.temperature, compare: compareNumber, hasValue: hasNumberValue, defaultDirection: 'desc' },
    relative_humidity: { getValue: n => n.relative_humidity, compare: compareNumber, hasValue: hasNumberValue, defaultDirection: 'desc' },
    barometric_pressure: { getValue: n => n.barometric_pressure, compare: compareNumber, hasValue: hasNumberValue, defaultDirection: 'desc' },
    latitude: { getValue: n => n.latitude, compare: compareNumber, hasValue: hasNumberValue, defaultDirection: 'asc' },
    longitude: { getValue: n => n.longitude, compare: compareNumber, hasValue: hasNumberValue, defaultDirection: 'asc' },
    altitude: { getValue: n => n.altitude, compare: compareNumber, hasValue: hasNumberValue, defaultDirection: 'desc' },
    position_time: { getValue: n => n.position_time, compare: compareNumber, hasValue: hasNumberValue, defaultDirection: 'desc' }
  };
  /**
   * Current table sorting state shared between refreshes.
   * @type {{key: string, direction: 'asc' | 'desc'}}
   */
  let sortState = {
    key: 'last_heard',
    direction: tableSorters.last_heard ? tableSorters.last_heard.defaultDirection : 'desc'
  };
  /** @type {Array<Object>} */
  let allNodes = [];
  /** @type {Array<Object>} */
  let allNeighbors = [];
  /** @type {Map<string, Object>} */
  let nodesById = new Map();
  /** @type {HTMLElement|null} */
  let shortInfoAnchor = null;
  /** @type {number} */
  let shortInfoRequestToken = 0;
  /** @type {string|undefined} */
  let lastChatDate;
  const NODE_LIMIT = 1000;
  const CHAT_LIMIT = 1000;
  const CHAT_RECENT_WINDOW_SECONDS = 7 * 24 * 60 * 60;
  const REFRESH_MS = config.refreshMs;
  const CHAT_ENABLED = Boolean(config.chatEnabled);
  refreshInfo.textContent = `${config.channel} (${config.frequency}) — active nodes: …`;

  /** @type {ReturnType<typeof setTimeout>|null} */
  let refreshTimer = null;

  /**
   * Determine whether the provided value contains a non-empty string.
   *
   * @param {*} value Candidate value extracted from a node record.
   * @returns {boolean} True when the value is a non-empty string.
   */
  function hasStringValue(value) {
    if (value == null) return false;
    return String(value).trim().length > 0;
  }

  /**
   * Determine whether the provided value can be interpreted as a finite number.
   *
   * @param {*} value Candidate value extracted from a node record.
   * @returns {boolean} True when the value parses to a finite number.
   */
  function hasNumberValue(value) {
    if (value == null || value === '') return false;
    const num = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(num);
  }

  /**
   * Locale-aware comparator for string table values.
   *
   * @param {*} a First value.
   * @param {*} b Second value.
   * @returns {number} Comparator result compatible with ``Array.prototype.sort``.
   */
  function compareString(a, b) {
    const strA = (a == null ? '' : String(a)).trim();
    const strB = (b == null ? '' : String(b)).trim();
    const hasA = strA.length > 0;
    const hasB = strB.length > 0;
    if (!hasA && !hasB) return 0;
    if (!hasA) return 1;
    if (!hasB) return -1;
    return strA.localeCompare(strB, undefined, { numeric: true, sensitivity: 'base' });
  }

  /**
   * Comparator for numeric table values that tolerates string inputs.
   *
   * @param {*} a First value.
   * @param {*} b Second value.
   * @returns {number} Comparator result for ``Array.prototype.sort``.
   */
  function compareNumber(a, b) {
    const numA = typeof a === 'number' ? a : Number(a);
    const numB = typeof b === 'number' ? b : Number(b);
    const validA = Number.isFinite(numA);
    const validB = Number.isFinite(numB);
    if (validA && validB) {
      if (numA === numB) return 0;
      return numA < numB ? -1 : 1;
    }
    if (validA) return -1;
    if (validB) return 1;
    return 0;
  }

  /**
   * Sort a list of nodes using the active table sorter configuration.
   *
   * @param {Array<Object>} nodes Collection of node entries.
   * @returns {Array<Object>} Sorted shallow copy of ``nodes``.
   */
  function sortNodes(nodes) {
    if (!Array.isArray(nodes)) return [];
    const config = tableSorters[sortState.key];
    if (!config) return nodes.slice();
    const dir = sortState.direction === 'asc' ? 1 : -1;
    const getter = config.getValue;
    const hasValue = config.hasValue;
    const compare = config.compare;
    const arr = nodes.slice();
    arr.sort((a, b) => {
      const valueA = getter(a);
      const valueB = getter(b);
      const presentA = hasValue ? hasValue(valueA) : valueA != null && valueA !== '';
      const presentB = hasValue ? hasValue(valueB) : valueB != null && valueB !== '';
      if (!presentA && !presentB) return 0;
      if (!presentA) return 1;
      if (!presentB) return -1;
      const result = compare(valueA, valueB);
      return result * dir;
    });
    return arr;
  }

  /**
   * Synchronise the sort indicator icons and ARIA attributes in the table head.
   *
   * @returns {void}
   */
  function updateSortIndicators() {
    if (!nodesTable || !sortButtons.length) return;
    nodesTable.querySelectorAll('thead th').forEach(th => th.removeAttribute('aria-sort'));
    sortButtons.forEach(button => {
      const indicator = button.querySelector('.sort-indicator');
      if (indicator) indicator.textContent = '';
      button.removeAttribute('data-sort-active');
      button.setAttribute('aria-pressed', 'false');
      const label = button.dataset.sortLabel || button.textContent.trim();
      button.setAttribute('aria-label', `Sort by ${label}`);
    });
    const activeButton = sortButtons.find(button => button.dataset.sortKey === sortState.key);
    if (!activeButton) return;
    const indicator = activeButton.querySelector('.sort-indicator');
    if (indicator) indicator.textContent = sortState.direction === 'asc' ? '▲' : '▼';
    const th = activeButton.closest('th');
    if (th) {
      th.setAttribute('aria-sort', sortState.direction === 'asc' ? 'ascending' : 'descending');
    }
    activeButton.setAttribute('data-sort-active', 'true');
    activeButton.setAttribute('aria-pressed', 'true');
    const label = activeButton.dataset.sortLabel || activeButton.textContent.trim();
    const directionLabel = sortState.direction === 'asc' ? 'ascending' : 'descending';
    const nextDirection = sortState.direction === 'asc' ? 'descending' : 'ascending';
    activeButton.setAttribute('aria-label', `${label}, sorted ${directionLabel}. Activate to sort ${nextDirection}.`);
  }

  if (sortButtons.length) {
    sortButtons.forEach(button => {
      button.addEventListener('click', () => {
        const key = button.dataset.sortKey;
        if (!key) return;
        if (sortState.key === key) {
          sortState = { key, direction: sortState.direction === 'asc' ? 'desc' : 'asc' };
        } else {
          const config = tableSorters[key];
          const dir = config && config.defaultDirection ? config.defaultDirection : 'asc';
          sortState = { key, direction: dir };
        }
        applyFilter();
      });
    });
  }

  updateSortIndicators();

  /**
   * Restart the auto-refresh timer according to the user's preferences.
   *
   * @returns {void}
   */
  function restartAutoRefresh() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
    if (autoRefreshEl && autoRefreshEl.checked) {
      refreshTimer = setInterval(refresh, REFRESH_MS);
    }
  }

  const MAP_CENTER_COORDS = Object.freeze({ lat: config.mapCenter.lat, lon: config.mapCenter.lon });
  const hasLeaflet = typeof window !== 'undefined' && typeof window.L === 'object' && window.L && typeof window.L.map === 'function';
  const mapContainer = document.getElementById('map');
  const mapPanel = document.getElementById('mapPanel');
  const mapFullscreenToggle = document.getElementById('mapFullscreenToggle');
  const fullscreenContainer = mapPanel || mapContainer;
  let mapStatusEl = null;
  let map = null;
  let mapCenterLatLng = null;
  let tiles = null;
  let offlineTiles = null;
  let usingOfflineTiles = false;
  const MAX_DISTANCE_KM = Number.isFinite(config.maxDistanceKm) && config.maxDistanceKm > 0
    ? config.maxDistanceKm
    : null;
  const LIMIT_DISTANCE = Number.isFinite(MAX_DISTANCE_KM);
  const INITIAL_VIEW_PADDING_PX = 12;
  const AUTO_FIT_PADDING_PX = 12;
  const MAX_INITIAL_ZOOM = 13;
  let neighborLinesLayer = null;
  let neighborLinesVisible = true;
  let neighborLinesToggleButton = null;
  let markersLayer = null;
  let tileDomObserver = null;
  const fullscreenChangeEvents = [
    'fullscreenchange',
    'webkitfullscreenchange',
    'mozfullscreenchange',
    'MSFullscreenChange',
    'msfullscreenchange'
  ];

  const autoFitController = createMapAutoFitController({
    toggleEl: fitBoundsEl,
    windowObject: typeof window !== 'undefined' ? window : undefined,
    defaultPaddingPx: AUTO_FIT_PADDING_PX
  });

  /**
   * Fit the Leaflet map to the provided geographic bounds.
   *
   * @param {[[number, number], [number, number]]|null} bounds Lat/lon bounds tuple.
   * @param {{ animate?: boolean, paddingPx?: number, maxZoom?: number }} [options] Fit options.
   * @returns {void}
   */
  function fitMapToBounds(bounds, options = {}) {
    if (!map || !bounds) return;
    const padding = Number.isFinite(options.paddingPx) && options.paddingPx >= 0 ? options.paddingPx : AUTO_FIT_PADDING_PX;
    const fitOptions = {
      animate: Boolean(options.animate),
      padding: [padding, padding]
    };
    if (Number.isFinite(options.maxZoom) && options.maxZoom > 0) {
      fitOptions.maxZoom = options.maxZoom;
    }
    autoFitController.recordFit(bounds, { paddingPx: padding, maxZoom: fitOptions.maxZoom });
    autoFitController.runAutoFitOperation(() => {
      map.fitBounds(bounds, fitOptions);
    });
  }

  /**
   * Attempt to reapply the last recorded bounds when auto-fit is enabled.
   *
   * @param {{ animate?: boolean }} [options] Animation preferences.
   * @returns {void}
   */
  function applyLastRecordedBounds(options = {}) {
    if (!autoFitController.isAutoFitEnabled()) return;
    const snapshot = autoFitController.getLastFit();
    if (!snapshot) return;
    const { bounds, options: fitOptions } = snapshot;
    fitMapToBounds(bounds, {
      animate: Boolean(options.animate),
      paddingPx: fitOptions.paddingPx,
      maxZoom: fitOptions.maxZoom
    });
  }

  /**
   * Determine whether the browser supports fullscreen requests on the map container.
   *
   * @returns {boolean} True when the Fullscreen API is available for the map element.
   */
  function supportsMapFullscreen() {
    if (!fullscreenContainer) return false;
    return (
      typeof fullscreenContainer.requestFullscreen === 'function' ||
      typeof fullscreenContainer.webkitRequestFullscreen === 'function' ||
      typeof fullscreenContainer.msRequestFullscreen === 'function'
    );
  }

  /**
   * Resolve the element currently being displayed in fullscreen mode.
   *
   * @returns {Element|null} Active fullscreen element if any.
   */
  function getActiveFullscreenElement() {
    if (typeof document === 'undefined') return null;
    return (
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.msFullscreenElement ||
      null
    );
  }

  /**
   * Determine whether the map container is currently in fullscreen mode.
   *
   * @returns {boolean} True when the map container owns fullscreen state.
   */
  function isMapInFullscreen() {
    if (!fullscreenContainer) return false;
    return getActiveFullscreenElement() === fullscreenContainer;
  }

  /**
   * Update the fullscreen toggle button label and pressed state.
   *
   * @returns {void}
   */
  function updateFullscreenToggleState() {
    if (!mapFullscreenToggle) return;
    const active = isMapInFullscreen();
    const label = active ? 'Exit full screen map view' : 'Enter full screen map view';
    mapFullscreenToggle.setAttribute('aria-pressed', active ? 'true' : 'false');
    mapFullscreenToggle.setAttribute('aria-label', label);
    mapFullscreenToggle.dataset.fullscreen = active ? 'true' : 'false';
  }

  /**
   * Request that the browser place the map container into fullscreen mode.
   *
   * @returns {void}
   */
  function enterMapFullscreen() {
    if (!fullscreenContainer) return;
    try {
      if (typeof fullscreenContainer.requestFullscreen === 'function') {
        const result = fullscreenContainer.requestFullscreen();
        if (result && typeof result.catch === 'function') {
          result.catch(() => {});
        }
        return;
      }
      if (typeof fullscreenContainer.webkitRequestFullscreen === 'function') {
        fullscreenContainer.webkitRequestFullscreen();
        return;
      }
      if (typeof fullscreenContainer.msRequestFullscreen === 'function') {
        fullscreenContainer.msRequestFullscreen();
      }
    } catch (error) {
      // Ignore errors triggered by the browser blocking fullscreen requests.
    }
  }

  /**
   * Exit fullscreen mode if the map container currently owns it.
   *
   * @returns {void}
   */
  function exitMapFullscreen() {
    if (typeof document === 'undefined') return;
    try {
      if (typeof document.exitFullscreen === 'function') {
        const result = document.exitFullscreen();
        if (result && typeof result.catch === 'function') {
          result.catch(() => {});
        }
        return;
      }
      if (typeof document.webkitExitFullscreen === 'function') {
        document.webkitExitFullscreen();
        return;
      }
      if (typeof document.msExitFullscreen === 'function') {
        document.msExitFullscreen();
      }
    } catch (error) {
      // Ignore errors triggered by the browser blocking fullscreen exit.
    }
  }

  /**
   * Toggle fullscreen mode depending on the current state.
   *
   * @returns {void}
   */
  function toggleMapFullscreen() {
    if (!supportsMapFullscreen()) return;
    if (isMapInFullscreen()) {
      exitMapFullscreen();
    } else {
      enterMapFullscreen();
    }
  }

  /**
   * Schedule a Leaflet resize to ensure the map fills the container.
   *
   * @returns {void}
   */
  function refreshMapSize() {
    if (!map || typeof map.invalidateSize !== 'function') return;
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        map.invalidateSize(true);
      });
    } else {
      setTimeout(() => {
        map.invalidateSize(true);
      }, 160);
    }
  }

  autoFitController.attachResizeListener(snapshot => {
    refreshMapSize();
    if (!snapshot) return;
    if (!autoFitController.isAutoFitEnabled()) return;
    fitMapToBounds(snapshot.bounds, {
      animate: false,
      paddingPx: snapshot.options.paddingPx,
      maxZoom: snapshot.options.maxZoom
    });
  });

  /**
   * Respond to fullscreen change events originating from the browser.
   *
   * @returns {void}
   */
  function handleFullscreenChange() {
    const active = isMapInFullscreen();
    if (fullscreenContainer && fullscreenContainer.classList) {
      fullscreenContainer.classList.toggle('is-fullscreen', active);
    }
    if (fullscreenContainer !== mapContainer && mapContainer && mapContainer.classList) {
      mapContainer.classList.toggle('is-fullscreen', active);
    }
    if (mapContainer && mapContainer.style) {
      if (active) {
        mapContainer.style.width = '100vw';
        mapContainer.style.height = '100vh';
        mapContainer.style.maxWidth = '100vw';
        mapContainer.style.maxHeight = '100vh';
        mapContainer.style.minWidth = '100vw';
        mapContainer.style.minHeight = '100vh';
      } else {
        mapContainer.style.width = '';
        mapContainer.style.height = '';
        mapContainer.style.maxWidth = '';
        mapContainer.style.maxHeight = '';
        mapContainer.style.minWidth = '';
        mapContainer.style.minHeight = '';
      }
    }
    updateFullscreenToggleState();
    refreshMapSize();
  }

  if (mapFullscreenToggle) {
    if (!supportsMapFullscreen() || typeof document === 'undefined') {
      mapFullscreenToggle.hidden = true;
    } else {
      mapFullscreenToggle.hidden = false;
      mapFullscreenToggle.addEventListener('click', event => {
        event.preventDefault();
        toggleMapFullscreen();
      });
      fullscreenChangeEvents.forEach(eventName => {
        document.addEventListener(eventName, handleFullscreenChange, false);
      });
      updateFullscreenToggleState();
    }
  }

  // Firmware 2.7.10 / Android 2.7.0 roles and colors (see issue #177)
  const roleColors = Object.freeze({
    CLIENT_HIDDEN: '#A9CBE8',
    SENSOR: '#A8D5BA',
    TRACKER: '#B9DFAC',
    CLIENT_MUTE: '#CDE7A9',
    CLIENT: '#E8E6A1',
    CLIENT_BASE: '#F6D0A6',
    REPEATER: '#F7B7A3',
    ROUTER_LATE: '#F29AA3',
    ROUTER: '#E88B94',
    LOST_AND_FOUND: '#C3A8E8'
  });

  const roleRenderOrder = Object.freeze({
    CLIENT_HIDDEN: 1,
    SENSOR: 2,
    TRACKER: 3,
    CLIENT_MUTE: 4,
    CLIENT: 5,
    CLIENT_BASE: 6,
    REPEATER: 7,
    ROUTER_LATE: 8,
    ROUTER: 9,
    LOST_AND_FOUND: 10
  });

  const activeRoleFilters = new Set();
  const legendRoleButtons = new Map();

  /**
   * Lazily create the floating map status element used for progress messages.
   *
   * @returns {HTMLElement|null} Status element attached to the map container.
   */
  function ensureMapStatusElement() {
    if (!mapContainer) return null;
    if (mapStatusEl && mapStatusEl.parentElement === mapContainer) {
      return mapStatusEl;
    }
    mapStatusEl = document.createElement('div');
    mapStatusEl.className = 'map-status-message';
    mapStatusEl.hidden = true;
    mapContainer.appendChild(mapStatusEl);
    return mapStatusEl;
  }

  /**
   * Display a short-lived status message overlay on the map.
   *
   * @param {string} message Human readable description of the current state.
   * @returns {void}
   */
  function showMapStatus(message) {
    if (!mapContainer) return;
    const el = ensureMapStatusElement();
    if (!el) return;
    if (message) {
      el.textContent = message;
      el.hidden = false;
    } else {
      el.hidden = true;
    }
  }

  /**
   * Hide the map status banner without removing the element from the DOM.
   *
   * @returns {void}
   */
  function hideMapStatus() {
    if (mapStatusEl) {
      mapStatusEl.hidden = true;
    }
  }

  /**
   * Replace the map tiles with a textual placeholder message.
   *
   * @param {string} message Explanation rendered below the placeholder heading.
   * @returns {void}
   */
  function setMapPlaceholder(message) {
    if (!mapContainer) return;
    mapContainer.dataset.mapStatus = 'placeholder';
    mapContainer.innerHTML = '';
    const placeholder = document.createElement('div');
    placeholder.className = 'map-placeholder-message';
    placeholder.innerHTML = `<strong>Map unavailable</strong>${message ? `<br/><span>${message}</span>` : ''}`;
    mapContainer.appendChild(placeholder);
  }

  /**
   * Normalise role strings so lookups remain consistent.
   *
   * @param {*} role Raw role value from the API.
   * @returns {string} Uppercase role identifier with a fallback of ``CLIENT``.
   */
  function normalizeRole(role) {
    if (role == null) return 'CLIENT';
    const str = String(role).trim();
    return str.length ? str : 'CLIENT';
  }

  /**
   * Resolve the canonical role key used for colour lookup tables.
   *
   * @param {*} role Raw role value from the API.
   * @returns {string} Canonical role identifier.
   */
  function getRoleKey(role) {
    const normalized = normalizeRole(role);
    if (roleColors[normalized]) return normalized;
    const upper = normalized.toUpperCase();
    if (roleColors[upper]) return upper;
    return normalized;
  }

  /**
   * Determine the colour assigned to a role for legend badges.
   *
   * @param {*} role Raw role value.
   * @returns {string} CSS colour string.
   */
  function getRoleColor(role) {
    const key = getRoleKey(role);
    return roleColors[key] || roleColors.CLIENT || '#3388ff';
  }

  /**
   * Determine the render priority that decides marker stacking order.
   *
   * @param {*} role Raw role value.
   * @returns {number} Higher numbers render above lower ones.
   */
  function getRoleRenderPriority(role) {
    const key = getRoleKey(role);
    const priority = roleRenderOrder[key];
    return typeof priority === 'number' ? priority : 0;
  }

  // --- Map setup ---
  const TILE_LAYER_URL = 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png';
  const TILE_FILTER_LIGHT = config.tileFilters.light;
  const TILE_FILTER_DARK = config.tileFilters.dark;

  if (hasLeaflet) {
    mapCenterLatLng = L.latLng(MAP_CENTER_COORDS.lat, MAP_CENTER_COORDS.lon);
  }

  /**
   * Return the CSS filter applied to Leaflet tiles for the active theme.
   *
   * @returns {string} CSS filter expression.
   */
  function resolveTileFilter() {
    return document.body.classList.contains('dark') ? TILE_FILTER_DARK : TILE_FILTER_LIGHT;
  }

  /**
   * Apply the configured filter to an individual Leaflet tile element.
   *
   * @param {HTMLElement} tile Tile image element.
   * @param {string} filterValue CSS filter expression.
   * @returns {void}
   */
  function applyFilterToTileElement(tile, filterValue) {
    if (!tile || usingOfflineTiles) return;
    if (tile.classList && !tile.classList.contains('map-tiles')) {
      tile.classList.add('map-tiles');
    }
    const value = filterValue || resolveTileFilter();
    if (tile.style) {
      tile.style.filter = value;
      tile.style.webkitFilter = value;
    }
  }

  /**
   * Return the Leaflet DOM container that currently owns map tiles.
   *
   * @returns {HTMLElement|null} Tile layer container element.
   */
  function getActiveTileLayerContainer() {
    if (!map) return null;
    const layer = usingOfflineTiles ? offlineTiles : tiles;
    return layer && typeof layer.getContainer === 'function' ? layer.getContainer() : null;
  }

  /**
   * Apply a CSS filter to all currently mounted Leaflet tile elements.
   *
   * @param {string} filterValue CSS filter expression.
   * @returns {void}
   */
  function applyFilterToTileContainers(filterValue) {
    if (!map) return;
    const value = filterValue || resolveTileFilter();
    const container = getActiveTileLayerContainer();
    if (container && container.style) {
      container.style.filter = value;
      container.style.webkitFilter = value;
    }
    const tilePane = typeof map.getPane === 'function' ? map.getPane('tilePane') : null;
    if (tilePane && tilePane.style) {
      tilePane.style.filter = value;
      tilePane.style.webkitFilter = value;
    }
  }

  /**
   * Ensure a tile element reflects the active theme filter.
   *
   * @param {HTMLElement} tile Tile element managed by Leaflet.
   * @returns {void}
   */
  function ensureTileHasCurrentFilter(tile) {
    if (!map || usingOfflineTiles) return;
    const filterValue = resolveTileFilter();
    applyFilterToTileElement(tile, filterValue);
  }

  /**
   * Synchronise all existing tiles with the current theme filter.
   *
   * @returns {void}
   */
  function applyFiltersToAllTiles() {
    if (!map) return;
    const filterValue = resolveTileFilter();
    document.body.style.setProperty('--map-tiles-filter', filterValue);
    if (!usingOfflineTiles) {
      const tileEls = mapContainer ? mapContainer.querySelectorAll('.leaflet-tile') : [];
      tileEls.forEach(tile => applyFilterToTileElement(tile, filterValue));
    }
    applyFilterToTileContainers(filterValue);
  }

  /**
   * Convert a tile X coordinate to longitude degrees.
   *
   * @param {number} x Tile X index.
   * @param {number} z Zoom level.
   * @returns {number} Longitude in degrees.
   */
  function tileToLon(x, z) {
    return (x / Math.pow(2, z)) * 360 - 180;
  }

  /**
   * Convert a tile Y coordinate to latitude degrees.
   *
   * @param {number} y Tile Y index.
   * @param {number} z Zoom level.
   * @returns {number} Latitude in degrees.
   */
  function tileToLat(y, z) {
    const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, z);
    return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  }

  /**
   * Create a minimal Leaflet tile layer that renders offline tiles from cache.
   *
   * @returns {L.GridLayer} Configured tile layer instance.
   */
  function createOfflineTileLayer() {
    if (!hasLeaflet) return null;
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

  /**
   * Disconnect and clear the MutationObserver tracking tile additions.
   *
   * @returns {void}
   */
  function disconnectTileObserver() {
    if (tileDomObserver) {
      tileDomObserver.disconnect();
      tileDomObserver = null;
    }
  }

  /**
   * Observe a Leaflet tile container to reapply filters as new tiles load.
   *
   * @param {L.GridLayer} layer Leaflet layer whose container should be watched.
   * @returns {void}
   */
  function observeTileContainer(layer) {
    if (!map || typeof MutationObserver !== 'function') return;
    const targetLayer = layer || (usingOfflineTiles ? offlineTiles : tiles);
    const container = targetLayer && typeof targetLayer.getContainer === 'function' ? targetLayer.getContainer() : null;
    const tilePane = typeof map.getPane === 'function' ? map.getPane('tilePane') : null;
    const targets = [];
    if (container) targets.push(container);
    if (tilePane && !targets.includes(tilePane)) targets.push(tilePane);
    if (!targets.length) return;
    disconnectTileObserver();
    tileDomObserver = new MutationObserver(mutations => {
      const filterValue = resolveTileFilter();
      mutations.forEach(mutation => {
        mutation.addedNodes.forEach(node => {
          if (!node || node.nodeType !== 1) return;
          if (!usingOfflineTiles && node.classList && node.classList.contains('leaflet-tile')) {
            applyFilterToTileElement(node, filterValue);
          }
          if (typeof node.querySelectorAll === 'function') {
            const nestedTiles = node.querySelectorAll('.leaflet-tile');
            nestedTiles.forEach(tile => applyFilterToTileElement(tile, filterValue));
          }
        });
      });
      applyFilterToTileContainers(filterValue);
    });
    targets.forEach(target => tileDomObserver.observe(target, { childList: true, subtree: true }));
  }

  /**
   * Enable the offline tile fallback and notify the user.
   *
   * @param {string} message Status text explaining the fallback.
   * @returns {void}
   */
  function activateOfflineTiles(message) {
    if (!hasLeaflet || !map) {
      if (mapContainer) {
        setMapPlaceholder(
          message || 'Offline basemap unavailable: Leaflet map is not initialized.'
        );
      }
      return;
    }
    if (usingOfflineTiles) {
      if (message) showMapStatus(message);
      return;
    }
    if (!offlineTiles) {
      try {
        offlineTiles = createOfflineTileLayer();
      } catch (error) {
        console.error('Failed to create offline tile layer', error);
        if (mapContainer) {
          const prefix = message ? `${message} ` : '';
          const detail = error && error.message ? ` (${error.message})` : '';
          const errorMessage = `${prefix}Offline fallback could not be initialized.${detail}`;
          setMapPlaceholder(errorMessage);
        }
        return;
      }
    }
    if (!offlineTiles) {
      if (mapContainer) {
        const prefix = message ? `${message} ` : '';
        setMapPlaceholder(`${prefix}Offline fallback could not be initialized.`);
      }
      return;
    }
    if (tiles && map.hasLayer(tiles)) {
      map.removeLayer(tiles);
    }
    usingOfflineTiles = true;
    offlineTiles.addTo(map);
    observeTileContainer(offlineTiles);
    if (message) {
      showMapStatus(message);
    }
    applyFiltersToAllTiles();
  }

  if (hasLeaflet && mapContainer) {
    map = L.map(mapContainer, { worldCopyJump: true, attributionControl: false });
    showMapStatus('Loading map tiles…');
    tiles = L.tileLayer(TILE_LAYER_URL, {
      maxZoom: 19,
      className: 'map-tiles',
      crossOrigin: 'anonymous'
    });

    tiles.on('tileloadstart', event => {
      if (!event || !event.tile) return;
      ensureTileHasCurrentFilter(event.tile);
      applyFilterToTileContainers();
    });

    tiles.on('tileload', event => {
      if (!event || !event.tile) return;
      ensureTileHasCurrentFilter(event.tile);
      applyFilterToTileContainers();
    });

    tiles.on('load', () => {
      usingOfflineTiles = false;
      hideMapStatus();
      applyFiltersToAllTiles();
      observeTileContainer(tiles);
    });

    tiles.on('tileerror', () => {
      activateOfflineTiles('Map tiles unavailable. Showing offline placeholder basemap.');
    });

    tiles.addTo(map);
    observeTileContainer(tiles);

    const initialBounds = computeBoundingBox(
      MAP_CENTER_COORDS,
      LIMIT_DISTANCE ? MAX_DISTANCE_KM : null,
      { minimumRangeKm: 1 }
    );
    if (initialBounds) {
      fitMapToBounds(initialBounds, { animate: false, paddingPx: INITIAL_VIEW_PADDING_PX, maxZoom: MAX_INITIAL_ZOOM });
    } else if (mapCenterLatLng) {
      map.setView(mapCenterLatLng, 10);
    } else {
      map.setView([MAP_CENTER_COORDS.lat, MAP_CENTER_COORDS.lon], 10);
    }

    if (typeof map.whenReady === 'function') {
      map.whenReady(() => {
        applyFiltersToAllTiles();
        refreshMapSize();
        applyLastRecordedBounds({ animate: false });
      });
    } else {
      applyFiltersToAllTiles();
      applyLastRecordedBounds({ animate: false });
    }

    map.on('moveend', applyFiltersToAllTiles);
    map.on('zoomend', applyFiltersToAllTiles);
    map.on('movestart', () => {
      autoFitController.handleUserInteraction();
    });
    map.on('zoomstart', () => {
      autoFitController.handleUserInteraction();
    });

    neighborLinesLayer = L.layerGroup().addTo(map);
    markersLayer = L.layerGroup().addTo(map);

    if (typeof navigator !== 'undefined' && navigator && navigator.onLine === false) {
      activateOfflineTiles('Offline mode detected. Using placeholder basemap.');
    }
  } else if (mapContainer) {
    setMapPlaceholder('Leaflet assets are unavailable. Data will continue to refresh without a live map.');
  }

  if (typeof window !== 'undefined') {
    /**
     * Helper exposed for the theme module to refresh Leaflet tile filters.
     *
     * @type {function(): void}
     */
    window.applyFiltersToAllTiles = applyFiltersToAllTiles;
  }

  let legendContainer = null;
  let legendToggleControl = null;
  let legendToggleButton = null;
  let legendVisible = true;

  /**
   * Update the pressed state of the legend visibility toggle button.
   *
   * @returns {void}
   */
  function updateLegendToggleState() {
    if (!legendToggleButton) return;
    const hasFilters = activeRoleFilters.size > 0;
    legendToggleButton.setAttribute('aria-pressed', legendVisible ? 'true' : 'false');
    const baseLabel = legendVisible ? 'Hide map legend' : 'Show map legend';
    const baseText = legendVisible ? 'Hide legend' : 'Show legend';
    const labelSuffix = hasFilters ? ' (role filters active)' : '';
    const textSuffix = ' (filters)';
    legendToggleButton.setAttribute('aria-label', baseLabel + labelSuffix);
    legendToggleButton.textContent = baseText + textSuffix;
    if (hasFilters) {
      legendToggleButton.setAttribute('data-has-active-filters', 'true');
    } else {
      legendToggleButton.removeAttribute('data-has-active-filters');
    }
  }

  /**
   * Show or hide the map legend component.
   *
   * @param {boolean} visible Whether the legend should be displayed.
   * @returns {void}
   */
  function setLegendVisibility(visible) {
    legendVisible = visible;
    if (legendContainer) {
      legendContainer.classList.toggle('legend-hidden', !visible);
      legendContainer.setAttribute('aria-hidden', visible ? 'false' : 'true');
    }
    updateLegendToggleState();
  }

  /**
   * Synchronise the neighbour line toggle button with the active state.
   *
   * @returns {void}
   */
  function updateNeighborLinesToggleState() {
    if (!neighborLinesToggleButton) return;
    const label = neighborLinesVisible ? 'Hide neighbor lines' : 'Show neighbor lines';
    neighborLinesToggleButton.textContent = label;
    neighborLinesToggleButton.setAttribute('aria-pressed', neighborLinesVisible ? 'true' : 'false');
    neighborLinesToggleButton.setAttribute('aria-label', label);
  }

  /**
   * Toggle the Leaflet layer that renders neighbour connection lines.
   *
   * @param {boolean} visible Whether to show the layer.
   * @returns {void}
   */
  function setNeighborLinesVisibility(visible) {
    neighborLinesVisible = Boolean(visible);
    if (neighborLinesLayer && map) {
      const hasLayer = map.hasLayer(neighborLinesLayer);
      if (neighborLinesVisible && !hasLayer) {
        neighborLinesLayer.addTo(map);
      } else if (!neighborLinesVisible && hasLayer) {
        map.removeLayer(neighborLinesLayer);
      }
    }
    updateNeighborLinesToggleState();
  }

  /**
   * Refresh the legend buttons to reflect the active role filters.
   *
   * @returns {void}
   */
  function updateLegendRoleFiltersUI() {
    const hasFilters = activeRoleFilters.size > 0;
    legendRoleButtons.forEach((button, role) => {
      if (!button) return;
      const isActive = activeRoleFilters.has(role);
      button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
    if (legendContainer) {
      if (hasFilters) {
        legendContainer.setAttribute('data-has-active-filters', 'true');
      } else {
        legendContainer.removeAttribute('data-has-active-filters');
      }
    }
    updateLegendToggleState();
  }

  /**
   * Toggle the visibility filter for a given role.
   *
   * @param {string} role Role identifier.
   * @returns {void}
   */
  function toggleRoleFilter(role) {
    if (!role) return;
    if (activeRoleFilters.has(role)) {
      activeRoleFilters.delete(role);
    } else {
      activeRoleFilters.add(role);
    }
    updateLegendRoleFiltersUI();
    applyFilter();
  }

  if (map && hasLeaflet) {
    const legend = L.control({ position: 'bottomright' });
    /**
     * Leaflet control factory that renders the legend UI.
     *
     * @returns {HTMLElement} Legend DOM element.
     */
    legend.onAdd = function () {
      const div = L.DomUtil.create('div', 'legend');
      div.id = 'mapLegend';
      div.setAttribute('role', 'region');
      div.setAttribute('aria-label', 'Map legend');
      legendContainer = div;

      const header = L.DomUtil.create('div', 'legend-header', div);
      const title = L.DomUtil.create('span', 'legend-title', header);
      title.textContent = 'Legend';

      const itemsContainer = L.DomUtil.create('div', 'legend-items', div);
    legendRoleButtons.clear();
    for (const [role, color] of Object.entries(roleColors)) {
      if (!CHAT_ENABLED && role === 'CLIENT_HIDDEN') continue;
      const item = L.DomUtil.create('button', 'legend-item', itemsContainer);
      item.type = 'button';
      item.setAttribute('aria-pressed', 'false');
        item.dataset.role = role;
        const swatch = L.DomUtil.create('span', 'legend-swatch', item);
        swatch.style.background = color;
        swatch.setAttribute('aria-hidden', 'true');
        const label = L.DomUtil.create('span', 'legend-label', item);
        label.textContent = role;
        item.addEventListener('click', event => {
          event.preventDefault();
          event.stopPropagation();
          const exclusive = event.metaKey || event.ctrlKey;
          if (exclusive) {
            activeRoleFilters.clear();
            activeRoleFilters.add(role);
            updateLegendRoleFiltersUI();
            applyFilter();
          } else {
            toggleRoleFilter(role);
          }
        });
        legendRoleButtons.set(role, item);
      }
      updateLegendRoleFiltersUI();

      const toggle = L.DomUtil.create('div', 'legend-toggle', div);
      neighborLinesToggleButton = L.DomUtil.create('button', 'legend-item legend-toggle-neighbors', toggle);
      neighborLinesToggleButton.type = 'button';
      neighborLinesToggleButton.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        setNeighborLinesVisibility(!neighborLinesVisible);
      });
      updateNeighborLinesToggleState();

      const resetButton = L.DomUtil.create('button', 'legend-item legend-reset', toggle);
      resetButton.type = 'button';
      resetButton.textContent = 'Clear filters';
      resetButton.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        activeRoleFilters.clear();
        updateLegendRoleFiltersUI();
        applyFilter();
      });

      L.DomEvent.disableClickPropagation(div);
      L.DomEvent.disableScrollPropagation(div);

      return div;
    };
    legend.addTo(map);
    legendContainer = legend.getContainer();

    legendToggleControl = L.control({ position: 'bottomright' });
    /**
     * Leaflet control factory for the legend visibility toggle.
     *
     * @returns {HTMLElement} Toggle button element.
     */
    legendToggleControl.onAdd = function () {
      const container = L.DomUtil.create('div', 'leaflet-control legend-toggle');
      const button = L.DomUtil.create('button', 'legend-toggle-button', container);
      button.type = 'button';
      button.textContent = 'Hide legend (filters)';
      button.setAttribute('aria-pressed', 'true');
      button.setAttribute('aria-label', 'Hide map legend');
      button.setAttribute('aria-controls', 'mapLegend');
      button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        setLegendVisibility(!legendVisible);
      });
      legendToggleButton = button;
      updateLegendToggleState();
      L.DomEvent.disableClickPropagation(container);
      L.DomEvent.disableScrollPropagation(container);
      return container;
    };
    legendToggleControl.addTo(map);

    const legendMediaQuery = window.matchMedia('(max-width: 1024px)');
    setLegendVisibility(!legendMediaQuery.matches);
    legendMediaQuery.addEventListener('change', event => {
      setLegendVisibility(!event.matches);
    });
  } else if (mapContainer && !hasLeaflet) {
    setLegendVisibility(false);
  }

    themeToggle.addEventListener('click', () => {
      const dark = document.body.classList.toggle('dark');
      const themeValue = dark ? 'dark' : 'light';
      document.body.setAttribute('data-theme', themeValue);
      if (document.documentElement) {
        document.documentElement.setAttribute('data-theme', themeValue);
      }
      themeToggle.textContent = dark ? '☀️' : '🌙';
      if (window.__themeCookie) {
        if (typeof window.__themeCookie.persistTheme === 'function') {
          window.__themeCookie.persistTheme(themeValue);
        } else if (typeof window.__themeCookie.setCookie === 'function') {
          window.__themeCookie.setCookie('theme', themeValue);
        }
      }
      window.dispatchEvent(new CustomEvent('themechange', { detail: { theme: themeValue } }));
      if (typeof window.applyFiltersToAllTiles === 'function') window.applyFiltersToAllTiles();
    });

  let lastFocusBeforeInfo = null;

  /**
   * Display the modal overlay containing site information.
   *
   * @returns {void}
   */
  function openInfoOverlay() {
    if (!infoOverlay || !infoDialog) return;
    lastFocusBeforeInfo = document.activeElement;
    infoOverlay.hidden = false;
    document.body.style.setProperty('overflow', 'hidden');
    infoDialog.focus();
  }

  /**
   * Hide the site information overlay and restore focus.
   *
   * @returns {void}
   */
  function closeInfoOverlay() {
    if (!infoOverlay || !infoDialog) return;
    infoOverlay.hidden = true;
    document.body.style.removeProperty('overflow');
    const target = lastFocusBeforeInfo && typeof lastFocusBeforeInfo.focus === 'function' ? lastFocusBeforeInfo : infoBtn;
    if (target && typeof target.focus === 'function') {
      target.focus();
    }
    lastFocusBeforeInfo = null;
  }

  if (infoBtn && infoOverlay && infoClose) {
    infoBtn.addEventListener('click', openInfoOverlay);
    infoClose.addEventListener('click', closeInfoOverlay);
    infoOverlay.addEventListener('click', event => {
      if (event.target === infoOverlay) {
        closeInfoOverlay();
      }
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !infoOverlay.hidden) {
        closeInfoOverlay();
      }
    });
  }

  if (shortInfoClose) {
    shortInfoClose.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      closeShortInfoOverlay();
    });
  }

  document.addEventListener('click', event => {
    const shortTarget = event.target.closest('.short-name');
    if (
      shortTarget &&
      shortTarget.dataset &&
      (shortTarget.dataset.nodeInfo || shortTarget.dataset.nodeId || shortTarget.dataset.nodeNum)
    ) {
      event.preventDefault();
      event.stopPropagation();

      let fallbackInfo = null;
      if (shortTarget.dataset.nodeInfo) {
        try {
          fallbackInfo = JSON.parse(shortTarget.dataset.nodeInfo);
        } catch (err) {
          console.warn('Failed to parse node info payload', err);
        }
      }
      if (!fallbackInfo || typeof fallbackInfo !== 'object') {
        fallbackInfo = {};
      }

      const datasetNodeId = typeof shortTarget.dataset.nodeId === 'string'
        ? shortTarget.dataset.nodeId.trim()
        : '';
      if (datasetNodeId && !fallbackInfo.nodeId && !fallbackInfo.node_id) {
        fallbackInfo.nodeId = datasetNodeId;
      }

      if (fallbackInfo.nodeNum == null && fallbackInfo.node_num == null && shortTarget.dataset.nodeNum != null) {
        const parsedDatasetNum = Number(shortTarget.dataset.nodeNum);
        if (Number.isFinite(parsedDatasetNum)) {
          fallbackInfo.nodeNum = parsedDatasetNum;
        }
      }

      if (!fallbackInfo.shortName && shortTarget.textContent) {
        fallbackInfo.shortName = shortTarget.textContent.replace(/\u00a0/g, ' ').trim();
      }

      const fallbackDetails = mergeOverlayDetails(null, fallbackInfo);
      if (!fallbackDetails.shortName && shortTarget.textContent) {
        fallbackDetails.shortName = shortTarget.textContent.replace(/\u00a0/g, ' ').trim();
        fallbackInfo.shortName = fallbackDetails.shortName;
      }

      if (shortInfoOverlay && !shortInfoOverlay.hidden && shortInfoAnchor === shortTarget) {
        closeShortInfoOverlay();
        return;
      }

      const nodeId = typeof fallbackDetails.nodeId === 'string' && fallbackDetails.nodeId.trim().length
        ? fallbackDetails.nodeId.trim()
        : '';
      const nodeNum = Number.isFinite(fallbackDetails.nodeNum) ? fallbackDetails.nodeNum : null;

      if (!nodeId && !nodeNum) {
        openShortInfoOverlay(shortTarget, fallbackDetails);
        return;
      }

      const requestId = ++shortInfoRequestToken;
      showShortInfoLoading(shortTarget, fallbackDetails);

      refreshNodeInformation({ nodeId: nodeId || undefined, nodeNum: nodeNum ?? undefined, fallback: fallbackInfo })
        .then(details => {
          if (requestId !== shortInfoRequestToken) return;
          const overlayDetails = mergeOverlayDetails(details, fallbackInfo);
          if (!overlayDetails.shortName && shortTarget.textContent) {
            overlayDetails.shortName = shortTarget.textContent.replace(/\u00a0/g, ' ').trim();
          }
          openShortInfoOverlay(shortTarget, overlayDetails);
        })
        .catch(err => {
          console.warn('Failed to refresh node information', err);
          if (requestId !== shortInfoRequestToken) return;
          const overlayDetails = mergeOverlayDetails(null, fallbackInfo);
          if (!overlayDetails.shortName && shortTarget.textContent) {
            overlayDetails.shortName = shortTarget.textContent.replace(/\u00a0/g, ' ').trim();
          }
          openShortInfoOverlay(shortTarget, overlayDetails);
        });
      return;
    }
    if (event.target.closest('.neighbor-connection-line')) {
      return;
    }
    if (shortInfoOverlay && !shortInfoOverlay.hidden && !shortInfoOverlay.contains(event.target)) {
      closeShortInfoOverlay();
    }
  });

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && shortInfoOverlay && !shortInfoOverlay.hidden) {
      closeShortInfoOverlay();
    }
  });

  window.addEventListener('resize', () => {
    if (shortInfoOverlay && !shortInfoOverlay.hidden) {
      requestAnimationFrame(positionShortInfoOverlay);
    }
  });

  // --- Helpers ---
  /**
   * Escape a string for safe HTML insertion.
   *
   * @param {string} str Raw string.
   * @returns {string} Escaped HTML string.
   */
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Render a short name badge with role-based styling.
   *
   * @param {string} short Short node identifier.
   * @param {string} role Node role string.
   * @param {string} longName Full node name.
   * @param {?Object} nodeData Optional node metadata attached to the badge.
   * @returns {string} HTML snippet describing the badge.
   */
  function renderShortHtml(short, role, longName, nodeData = null) {
    const safeTitle = longName ? escapeHtml(String(longName)) : '';
    const titleAttr = safeTitle ? ` title="${safeTitle}"` : '';
    const roleValue = normalizeRole(role != null && role !== '' ? role : (nodeData && nodeData.role));
    let infoAttr = '';
    if (nodeData && typeof nodeData === 'object') {
      const info = {
        nodeId: nodeData.node_id ?? nodeData.nodeId ?? '',
        nodeNum: nodeData.num ?? nodeData.node_num ?? nodeData.nodeNum ?? null,
        shortName: short != null ? String(short) : (nodeData.short_name ?? ''),
        longName: nodeData.long_name ?? longName ?? '',
        role: roleValue,
        hwModel: nodeData.hw_model ?? nodeData.hwModel ?? '',
        battery: nodeData.battery_level ?? nodeData.battery ?? null,
        voltage: nodeData.voltage ?? null,
        uptime: nodeData.uptime_seconds ?? nodeData.uptime ?? null,
        channel: nodeData.channel_utilization ?? nodeData.channel ?? null,
        airUtil: nodeData.air_util_tx ?? nodeData.airUtil ?? null,
        temperature: nodeData.temperature ?? nodeData.temp ?? null,
        humidity: nodeData.relative_humidity ?? nodeData.relativeHumidity ?? nodeData.humidity ?? null,
        pressure: nodeData.barometric_pressure ?? nodeData.barometricPressure ?? nodeData.pressure ?? null,
        telemetryTime: nodeData.telemetry_time ?? nodeData.telemetryTime ?? null,
      };
      const attrParts = [` data-node-info="${escapeHtml(JSON.stringify(info))}"`];
      const attrNodeIdRaw = info.nodeId != null ? String(info.nodeId).trim() : '';
      if (attrNodeIdRaw) {
        attrParts.push(` data-node-id="${escapeHtml(attrNodeIdRaw)}"`);
      }
      const attrNodeNum = Number(info.nodeNum);
      if (Number.isFinite(attrNodeNum)) {
        attrParts.push(` data-node-num="${escapeHtml(String(attrNodeNum))}"`);
      }
      infoAttr = attrParts.join('');
    }
    if (!short) {
      return `<span class="short-name" style="background:#ccc"${titleAttr}${infoAttr}>?&nbsp;&nbsp;&nbsp;</span>`;
    }
    const padded = escapeHtml(String(short).padStart(4, ' ')).replace(/ /g, '&nbsp;');
    const color = getRoleColor(roleValue);
    return `<span class="short-name" style="background:${color}"${titleAttr}${infoAttr}>${padded}</span>`;
  }

  /**
   * Populate the ``nodesById`` index for quick lookups.
   *
   * @param {Array<Object>} nodes Collection of node payloads.
   * @returns {void}
   */
  function rebuildNodeIndex(nodes) {
    nodesById = new Map();
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue;
      const nodeId = typeof node.node_id === 'string'
        ? node.node_id
        : (typeof node.nodeId === 'string' ? node.nodeId : null);
      if (!nodeId) continue;
      nodesById.set(nodeId, node);
    }
  }

  /**
   * Return neighbour entries associated with a node.
   *
   * @param {string} nodeId Canonical node identifier.
   * @returns {Array<Object>} Neighbour records sorted by SNR.
   */
  function getNeighborNodesFor(nodeId) {
    if (typeof nodeId !== 'string' || nodeId.length === 0) return [];
    if (!Array.isArray(allNeighbors) || allNeighbors.length === 0) return [];
    const neighborsById = new Map();
    for (const entry of allNeighbors) {
      if (!entry || typeof entry !== 'object') continue;
      const sourceId = typeof entry.node_id === 'string' ? entry.node_id : null;
      if (sourceId !== nodeId) continue;
      const neighborId = typeof entry.neighbor_id === 'string' ? entry.neighbor_id : null;
      if (!neighborId) continue;
      const snrValue = toFiniteNumber(entry.snr);
      const rxTime = resolveTimestampSeconds(entry.rx_time, entry.rxTime);
      let record = neighborsById.get(neighborId);
      if (!record) {
        let neighborNode = nodesById.get(neighborId);
        if (!neighborNode) {
          const placeholder = { node_id: neighborId };
          applyNodeNameFallback(placeholder);
          neighborNode = placeholder;
        }
        record = {
          node: neighborNode,
          neighborId,
          snr: snrValue != null ? snrValue : null,
          rxTime: rxTime != null ? rxTime : null
        };
        neighborsById.set(neighborId, record);
        continue;
      }
      if (snrValue != null && (record.snr == null || snrValue > record.snr)) {
        record.snr = snrValue;
      }
      if (rxTime != null && (record.rxTime == null || rxTime > record.rxTime)) {
        record.rxTime = rxTime;
      }
    }
    return Array.from(neighborsById.values());
  }

  /**
   * Render HTML describing a neighbour relationship and SNR value.
   *
   * @param {Object} neighborEntry Neighbor payload.
   * @returns {string} HTML snippet for map tooltips.
   */
  function renderNeighborWithSnrHtml(neighborEntry) {
    if (!neighborEntry || !neighborEntry.node) return '';
    const node = neighborEntry.node;
    const shortHtml = renderShortHtml(
      node && (node.short_name ?? node.shortName),
      node && node.role,
      node && (node.long_name ?? node.longName),
      node
    );
    if (!shortHtml) return '';
    const snrText = shortInfoValueOrDash(formatSnrDisplay(neighborEntry.snr));
    return `${shortHtml}<span class="neighbor-snr">(SNR ${escapeHtml(snrText)})</span>`;
  }

  /**
   * Build HTML markup describing a node for a Leaflet popup.
   *
   * @param {Object} node Map node payload with snake_case keys.
   * @param {number} nowSec Reference timestamp for relative calculations.
   * @returns {string} HTML snippet rendered inside the popup.
   */
  function buildMapPopupHtml(node, nowSec) {
    const lines = [];
    const longName = node && node.long_name ? escapeHtml(String(node.long_name)) : '';
    if (longName) {
      lines.push(`<b>${longName}</b>`);
    }

    const shortHtml = renderShortHtml(node?.short_name, node?.role, node?.long_name, node);
    const nodeIdText = node && node.node_id ? `<span class="mono">${escapeHtml(String(node.node_id))}</span>` : '';
    const shortParts = [];
    if (shortHtml) shortParts.push(shortHtml);
    if (nodeIdText) shortParts.push(nodeIdText);
    if (shortParts.length) {
      lines.push(shortParts.join(' '));
    }

    const hardwareText = fmtHw(node?.hw_model);
    if (hardwareText) {
      lines.push(`Model: ${escapeHtml(hardwareText)}`);
    }

    const roleValue = node?.role || 'CLIENT';
    if (roleValue) {
      lines.push(`Role: ${escapeHtml(roleValue)}`);
    }

    const batteryParts = [];
    const batteryText = fmtAlt(node?.battery_level, '%');
    if (batteryText) batteryParts.push(batteryText);
    const voltageText = fmtAlt(node?.voltage, 'V');
    if (voltageText) batteryParts.push(voltageText);
    if (batteryParts.length) {
      lines.push(`Battery: ${batteryParts.join(', ')}`);
    }

    const temperatureText = fmtTemperature(node?.temperature);
    if (temperatureText) {
      lines.push(`Temperature: ${temperatureText}`);
    }
    const humidityText = fmtHumidity(node?.relative_humidity);
    if (humidityText) {
      lines.push(`Humidity: ${humidityText}`);
    }
    const pressureText = fmtPressure(node?.barometric_pressure);
    if (pressureText) {
      lines.push(`Pressure: ${pressureText}`);
    }

    const lastHeardNum = Number(node?.last_heard);
    if (Number.isFinite(lastHeardNum) && lastHeardNum > 0) {
      lines.push(`Last seen: ${timeAgo(lastHeardNum, nowSec)}`);
    }

    const uptimeNum = Number(node?.uptime_seconds);
    if (Number.isFinite(uptimeNum) && uptimeNum > 0) {
      lines.push(`Uptime: ${timeHum(uptimeNum)}`);
    }

    const overlayNeighbors = Array.isArray(node?.neighbors) ? node.neighbors : [];
    const neighborEntries = overlayNeighbors.length
      ? overlayNeighbors
      : getNeighborNodesFor(node?.node_id ?? '');
    if (neighborEntries.length) {
      const neighborParts = neighborEntries
        .map(renderNeighborWithSnrHtml)
        .filter(html => html && html.length);
      if (neighborParts.length) {
        lines.push(`Neighbors: ${neighborParts.join(' ')}`);
      }
    }

    return lines.join('<br/>');
  }

  /**
   * Format uptime values for the short-info overlay.
   *
   * @param {*} value Raw uptime value.
   * @returns {string} Human readable uptime string.
   */
  function formatShortInfoUptime(value) {
    if (value == null || value === '') return '';
    const num = Number(value);
    if (!Number.isFinite(num)) return '';
    return num === 0 ? '0s' : timeHum(num);
  }

  /**
   * Format overlay values with an em dash fallback when blank.
   *
   * @param {*} value Candidate value.
   * @returns {string} Formatted value or em dash.
   */
  function shortInfoValueOrDash(value) {
    return value != null && value !== '' ? String(value) : '—';
  }

  /**
   * Append telemetry information to the short-info overlay payload.
   *
   * @param {Array<string>} lines Output accumulator.
   * @param {string} label Field label.
   * @param {*} rawValue Raw telemetry value.
   * @param {Function} formatter Optional formatter callback.
   * @returns {void}
   */
  function appendTelemetryLine(lines, label, rawValue, formatter) {
    if (!Array.isArray(lines)) return;
    if (rawValue == null || rawValue === '') return;
    const formatted = formatter ? formatter(rawValue) : rawValue;
    if (formatted == null || formatted === '') return;
    lines.push(`${escapeHtml(label)}: ${escapeHtml(String(formatted))}`);
  }

  /**
   * Transform a node-shaped payload into the overlay data format.
   *
   * @param {*} source Arbitrary node data.
   * @returns {Object} Normalized overlay payload.
   */
  function normalizeOverlaySource(source) {
    if (!source || typeof source !== 'object') return {};
    const normalized = {};
    const nodeIdRaw = source.nodeId ?? source.node_id;
    if (typeof nodeIdRaw === 'string' && nodeIdRaw.trim().length > 0) {
      normalized.nodeId = nodeIdRaw.trim();
    }
    const nodeNumRaw = source.nodeNum ?? source.node_num ?? source.num;
    const nodeNumParsed = Number(nodeNumRaw);
    if (Number.isFinite(nodeNumParsed)) {
      normalized.nodeNum = nodeNumParsed;
    }
    const shortRaw = source.shortName ?? source.short_name;
    if (shortRaw != null && String(shortRaw).trim().length > 0) {
      normalized.shortName = String(shortRaw).trim();
    }
    const longRaw = source.longName ?? source.long_name;
    if (longRaw != null && String(longRaw).trim().length > 0) {
      normalized.longName = String(longRaw).trim();
    }
    if (source.role && String(source.role).trim().length > 0) {
      normalized.role = String(source.role).trim();
    }
    if (source.hwModel ?? source.hw_model) {
      normalized.hwModel = source.hwModel ?? source.hw_model;
    }

    const numericPairs = [
      ['battery', source.battery ?? source.battery_level],
      ['voltage', source.voltage],
      ['uptime', source.uptime ?? source.uptime_seconds],
      ['channel', source.channel ?? source.channel_utilization],
      ['airUtil', source.airUtil ?? source.air_util_tx],
      ['temperature', source.temperature],
      ['humidity', source.humidity ?? source.relative_humidity],
      ['pressure', source.pressure ?? source.barometric_pressure],
      ['telemetryTime', source.telemetryTime ?? source.telemetry_time],
      ['lastHeard', source.lastHeard ?? source.last_heard],
      ['latitude', source.latitude],
      ['longitude', source.longitude],
      ['altitude', source.altitude],
      ['positionTime', source.positionTime ?? source.position_time],
    ];
    for (const [key, value] of numericPairs) {
      if (value == null || value === '') continue;
      const num = Number(value);
      if (Number.isFinite(num)) {
        normalized[key] = num;
      }
    }

    const lastSeenRaw = source.lastSeenIso ?? source.last_seen_iso;
    if (typeof lastSeenRaw === 'string' && lastSeenRaw.trim().length > 0) {
      normalized.lastSeenIso = lastSeenRaw.trim();
    }
    const positionIsoRaw = source.positionTimeIso ?? source.position_time_iso;
    if (typeof positionIsoRaw === 'string' && positionIsoRaw.trim().length > 0) {
      normalized.positionTimeIso = positionIsoRaw.trim();
    }

    if (Array.isArray(source.neighbors)) {
      const overlayNeighbors = overlayToPopupNode({ neighbors: source.neighbors }).neighbors;
      if (overlayNeighbors.length) {
        normalized.neighbors = overlayNeighbors;
      }
    }

    return normalized;
  }

  /**
   * Combine primary and fallback node information into an overlay payload.
   *
   * @param {*} primary Primary node details (e.g. fetched from the API).
   * @param {*} fallback Fallback node details rendered with the page.
   * @returns {Object} Overlay payload ready for rendering.
   */
  function mergeOverlayDetails(primary, fallback) {
    const fallbackNormalized = normalizeOverlaySource(fallback);
    const primaryNormalized = normalizeOverlaySource(primary);
    const merged = { ...fallbackNormalized, ...primaryNormalized };
    const neighborList = primaryNormalized.neighbors ?? fallbackNormalized.neighbors;
    if (neighborList) {
      merged.neighbors = neighborList;
    }
    if (!merged.role || merged.role === '') {
      merged.role = 'CLIENT';
    }
    return merged;
  }

  /**
   * Display a temporary loading state while node details are fetched.
   *
   * @param {HTMLElement} target Anchor element associated with the overlay.
   * @param {Object} [info] Optional fallback information describing the node.
   * @returns {void}
   */
  function showShortInfoLoading(target, info) {
    if (!shortInfoOverlay || !shortInfoContent) return;
    const normalized = normalizeOverlaySource(info || {});
    const heading = normalized.longName || normalized.shortName || normalized.nodeId || '';
    const headingHtml = heading ? `<strong>${escapeHtml(heading)}</strong><br/>` : '';
    shortInfoContent.innerHTML = `${headingHtml}Loading…`;
    shortInfoAnchor = target;
    shortInfoOverlay.hidden = false;
    shortInfoOverlay.style.visibility = 'hidden';
    requestAnimationFrame(positionShortInfoOverlay);
  }

  /**
   * Hide the short-info overlay used for inline node details.
   *
   * @returns {void}
   */
  function closeShortInfoOverlay() {
    shortInfoRequestToken += 1;
    if (!shortInfoOverlay) return;
    shortInfoOverlay.hidden = true;
    shortInfoOverlay.style.visibility = 'visible';
    shortInfoAnchor = null;
  }

  /**
   * Position the short-info overlay near its anchor element.
   *
   * @returns {void}
   */
  function positionShortInfoOverlay() {
    if (!shortInfoOverlay || shortInfoOverlay.hidden || !shortInfoAnchor) return;
    if (!document.body.contains(shortInfoAnchor)) {
      closeShortInfoOverlay();
      return;
    }
    const rect = shortInfoAnchor.getBoundingClientRect();
    const overlayRect = shortInfoOverlay.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;
    let left = rect.left + window.scrollX;
    let top = rect.top + window.scrollY;
    const maxLeft = window.scrollX + viewportWidth - overlayRect.width - 8;
    const maxTop = window.scrollY + viewportHeight - overlayRect.height - 8;
    left = Math.max(window.scrollX + 8, Math.min(left, maxLeft));
    top = Math.max(window.scrollY + 8, Math.min(top, maxTop));
    shortInfoOverlay.style.left = `${left}px`;
    shortInfoOverlay.style.top = `${top}px`;
    shortInfoOverlay.style.visibility = 'visible';
  }

  /**
   * Populate and display the short-info overlay for a node badge.
   *
   * @param {HTMLElement} target Anchor element that triggered the overlay.
   * @param {Object} info Node payload displayed in the overlay.
   * @returns {void}
   */
  function openShortInfoOverlay(target, info) {
    if (!shortInfoOverlay || !shortInfoContent || !info) return;
    const overlayInfo = normalizeOverlaySource(info);
    if (!overlayInfo.role || overlayInfo.role === '') {
      overlayInfo.role = 'CLIENT';
    }
    const lines = [];
    const longNameValue = shortInfoValueOrDash(overlayInfo.longName ?? '');
    if (longNameValue !== '—') {
      lines.push(`<strong>${escapeHtml(longNameValue)}</strong>`);
    }
    const shortParts = [];
    const shortHtml = renderShortHtml(overlayInfo.shortName, overlayInfo.role, overlayInfo.longName);
    if (shortHtml) {
      shortParts.push(shortHtml);
    }
    const nodeIdValue = shortInfoValueOrDash(overlayInfo.nodeId ?? '');
    if (nodeIdValue !== '—') {
      shortParts.push(`<span class="mono">${escapeHtml(nodeIdValue)}</span>`);
    }
    if (shortParts.length) {
      lines.push(shortParts.join(' '));
    }
    const roleValue = shortInfoValueOrDash(overlayInfo.role || 'CLIENT');
    if (roleValue !== '—') {
      lines.push(`Role: ${escapeHtml(roleValue)}`);
    }
    let neighborLineHtml = '';
    const neighborEntries = Array.isArray(overlayInfo.neighbors) && overlayInfo.neighbors.some(entry => entry && entry.node)
      ? overlayInfo.neighbors
      : getNeighborNodesFor(overlayInfo.nodeId);
    if (neighborEntries.length) {
      const neighborParts = neighborEntries
        .map(renderNeighborWithSnrHtml)
        .filter(html => html && html.length);
      if (neighborParts.length) {
        neighborLineHtml = `Neighbors: ${neighborParts.join(' ')}`;
      }
    }
    const modelValue = fmtHw(overlayInfo.hwModel);
    if (modelValue) {
      lines.push(`Model: ${escapeHtml(modelValue)}`);
    }
    appendTelemetryLine(lines, 'Battery', overlayInfo.battery, value => fmtAlt(value, '%'));
    appendTelemetryLine(lines, 'Voltage', overlayInfo.voltage, value => fmtAlt(value, 'V'));
    appendTelemetryLine(lines, 'Uptime', overlayInfo.uptime, formatShortInfoUptime);
    appendTelemetryLine(lines, 'Channel Util', overlayInfo.channel, fmtTx);
    appendTelemetryLine(lines, 'Air Util Tx', overlayInfo.airUtil, fmtTx);
    appendTelemetryLine(lines, 'Temperature', overlayInfo.temperature, fmtTemperature);
    appendTelemetryLine(lines, 'Humidity', overlayInfo.humidity, fmtHumidity);
    appendTelemetryLine(lines, 'Pressure', overlayInfo.pressure, fmtPressure);
    if (neighborLineHtml) {
      lines.push(neighborLineHtml);
    }
    shortInfoContent.innerHTML = lines.join('<br/>');
    shortInfoAnchor = target;
    shortInfoOverlay.hidden = false;
    shortInfoOverlay.style.visibility = 'hidden';
    requestAnimationFrame(positionShortInfoOverlay);
  }

  /**
   * Display an overlay describing a neighbour link.
   *
   * @param {HTMLElement} target Anchor element for the overlay.
   * @param {Object} segment GeoJSON segment describing the connection.
   * @returns {void}
   */
  function openNeighborOverlay(target, segment) {
    if (!shortInfoOverlay || !shortInfoContent || !segment) return;
    const nodeName = shortInfoValueOrDash(segment.sourceDisplayName || segment.sourceId || '');
    const snrText = shortInfoValueOrDash(formatSnrDisplay(segment.snr));
    const sourceShortHtml = renderShortHtml(
      segment.sourceShortName,
      segment.sourceRole,
      segment.sourceDisplayName
    );
    const targetShortHtml = renderShortHtml(
      segment.targetShortName,
      segment.targetRole,
      segment.targetDisplayName
    );
    const sourceIdText = shortInfoValueOrDash(segment.sourceId || '');
    const neighborFullName = shortInfoValueOrDash(segment.targetDisplayName || segment.targetId || '');
    const lines = [];
    lines.push(`<strong>${escapeHtml(nodeName)}</strong>`);
    lines.push(`${sourceShortHtml} <span class="mono">${escapeHtml(sourceIdText)}</span>`);
    const neighborLine = `${targetShortHtml} [${escapeHtml(neighborFullName)}]`;
    lines.push(neighborLine);
    lines.push(`SNR: ${escapeHtml(snrText)}`);
    shortInfoContent.innerHTML = lines.join('<br/>');
    shortInfoAnchor = target;
    shortInfoOverlay.hidden = false;
    shortInfoOverlay.style.visibility = 'hidden';
    requestAnimationFrame(positionShortInfoOverlay);
  }

  /**
   * Create a chat log date divider when the day changes.
   *
   * @param {number} ts Unix timestamp in seconds.
   * @returns {HTMLElement} Divider element.
   */
  function maybeCreateDateDivider(ts) {
    if (!ts) return null;
    const d = new Date(ts * 1000);
    const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    if (lastChatDate !== key) {
      lastChatDate = key;
      const midnight = new Date(d);
      midnight.setHours(0, 0, 0, 0);
      const div = document.createElement('div');
      div.className = 'chat-entry-date';
      div.textContent = `-- ${formatDate(midnight)} --`;
      return div;
    }
    return null;
  }

  /**
   * Build a chat log entry describing a node join event.
   *
   * @param {Object} n Node payload.
   * @returns {HTMLElement} Chat log element.
   */
  function createNodeChatEntry(n) {
    const div = document.createElement('div');
    const ts = formatTime(new Date(n.first_heard * 1000));
    div.className = 'chat-entry-node';
    const short = renderShortHtml(n.short_name, n.role, n.long_name, n);
    const longName = escapeHtml(n.long_name || '');
    div.innerHTML = `[${ts}] ${short} <em>New node: ${longName}</em>`;
    return div;
  }

  /**
   * Build a chat log entry for a text message.
   *
   * @param {Object} m Message payload.
   * @returns {HTMLElement} Chat log element.
   */
  function createMessageChatEntry(m) {
    const div = document.createElement('div');
    const ts = formatTime(new Date(m.rx_time * 1000));
    const short = renderShortHtml(m.node?.short_name, m.node?.role, m.node?.long_name, m.node);
    const text = escapeHtml(m.text || '');
    div.className = 'chat-entry-msg';
    div.innerHTML = `[${ts}] ${short} ${text}`;
    return div;
  }

  /**
   * Render the chat history panel with nodes and messages.
   *
   * @param {Array<Object>} nodes Collection of node payloads.
   * @param {Array<Object>} messages Collection of message payloads.
   * @returns {void}
   */
  function renderChatLog(nodes, messages) {
    if (!CHAT_ENABLED || !chatEl) return;
    const entries = [];
    for (const n of nodes || []) {
      entries.push({ type: 'node', ts: n.first_heard ?? 0, item: n });
    }
    for (const m of messages || []) {
      if (!m || m.encrypted) continue;
      entries.push({ type: 'msg', ts: m.rx_time ?? 0, item: m });
    }
    const nowSeconds = Math.floor(Date.now() / 1000);
    const cutoff = nowSeconds - CHAT_RECENT_WINDOW_SECONDS;
    const recentEntries = entries.filter(entry => {
      if (entry == null) return false;
      const rawTs = entry.ts;
      if (rawTs == null) return false;
      const ts = typeof rawTs === 'number' ? rawTs : Number(rawTs);
      if (!Number.isFinite(ts)) return false;
      entry.ts = ts;
      return ts >= cutoff;
    });
    recentEntries.sort((a, b) => {
      if (a.ts !== b.ts) return a.ts - b.ts;
      return a.type === 'node' && b.type === 'msg' ? -1 : a.type === 'msg' && b.type === 'node' ? 1 : 0;
    });
    const frag = document.createDocumentFragment();
    lastChatDate = null;
    for (const entry of recentEntries) {
      const divider = maybeCreateDateDivider(entry.ts);
      if (divider) frag.appendChild(divider);
      if (entry.type === 'node') {
        frag.appendChild(createNodeChatEntry(entry.item));
      } else {
        frag.appendChild(createMessageChatEntry(entry.item));
      }
    }
    chatEl.replaceChildren(frag);
    while (chatEl.childElementCount > CHAT_LIMIT) {
      chatEl.removeChild(chatEl.firstChild);
    }
    chatEl.scrollTop = chatEl.scrollHeight;
  }

  /**
   * Pad a numeric value with leading zeros.
   *
   * @param {number} n Numeric value.
   * @returns {string} Padded string.
   */
  function pad(n) { return String(n).padStart(2, "0"); }

  /**
   * Format a ``Date`` object as ``HH:MM``.
   *
   * @param {Date} d Date instance.
   * @returns {string} Time string.
   */
  function formatTime(d) {
    return pad(d.getHours()) + ":" +
          pad(d.getMinutes()) + ":" +
          pad(d.getSeconds());
  }

  /**
   * Format a ``Date`` object as ``YYYY-MM-DD``.
   *
   * @param {Date} d Date instance.
   * @returns {string} Date string.
   */
  function formatDate(d) {
    return d.getFullYear() + "-" +
          pad(d.getMonth() + 1) + "-" +
          pad(d.getDate());
  }

  /**
   * Format hardware model strings for display.
   *
   * @param {*} v Raw hardware model value.
   * @returns {string} Sanitised string.
   */
  function fmtHw(v) {
    return v && v !== "UNSET" ? String(v) : "";
  }

  /**
   * Format coordinate values with a configurable precision.
   *
   * @param {*} v Raw coordinate value.
   * @param {number} [d=5] Decimal precision.
   * @returns {string} Formatted coordinate string.
   */
  function fmtCoords(v, d = 5) {
    if (v == null || v === '') return "";
    const n = Number(v);
    return Number.isFinite(n) ? n.toFixed(d) : "";
  }

  /**
   * Format altitude values with units.
   *
   * @param {*} v Raw altitude value.
   * @param {string} s Unit suffix.
   * @returns {string} Altitude string.
   */
  function fmtAlt(v, s) {
    return (v == null || v === '') ? "" : `${v}${s}`;
  }

  /**
   * Format transmission utilisation values as percentages.
   *
   * @param {*} v Raw utilisation value.
   * @param {number} [d=3] Decimal precision.
   * @returns {string} Percentage string.
   */
  function fmtTx(v, d = 3) {
    if (v == null || v === '') return "";
    const n = Number(v);
    return Number.isFinite(n) ? `${n.toFixed(d)}%` : "";
  }

  /**
   * Format temperature telemetry with a degree suffix.
   *
   * @param {*} v Raw temperature value.
   * @returns {string} Temperature string.
   */
  function fmtTemperature(v) {
    if (v == null || v === '') return "";
    const n = Number(v);
    return Number.isFinite(n) ? `${n.toFixed(1)}°C` : "";
  }

  /**
   * Format humidity telemetry as a percentage.
   *
   * @param {*} v Raw humidity value.
   * @returns {string} Humidity string.
   */
  function fmtHumidity(v) {
    if (v == null || v === '') return "";
    const n = Number(v);
    return Number.isFinite(n) ? `${n.toFixed(1)}%` : "";
  }

  /**
   * Format barometric pressure telemetry in hPa.
   *
   * @param {*} v Raw pressure value.
   * @returns {string} Pressure string.
   */
  function fmtPressure(v) {
    if (v == null || v === '') return "";
    const n = Number(v);
    return Number.isFinite(n) ? `${n.toFixed(1)} hPa` : "";
  }

  /**
   * Format SNR readings with a ``dB`` suffix.
   *
   * @param {*} value Raw SNR value.
   * @returns {string} Formatted SNR string.
   */
  function formatSnrDisplay(value) {
    if (value == null || value === '') return '';
    const n = Number(value);
    if (!Number.isFinite(n)) return '';
    return `${n.toFixed(1)} dB`;
  }

  /**
   * Normalise node name fields by trimming whitespace.
   *
   * @param {*} value Raw name value.
   * @returns {string} Sanitised name string.
   */
  function normalizeNodeNameValue(value) {
    if (value == null) return '';
    const str = String(value).trim();
    return str.length ? str : '';
  }

  /**
   * Determine the preferred display name for overlay content.
   *
   * @param {Object} node Node payload.
   * @returns {string} Friendly display name.
   */
  function getNodeDisplayNameForOverlay(node) {
    if (!node || typeof node !== 'object') return '';
    return (
      normalizeNodeNameValue(node.long_name ?? node.longName) ||
      normalizeNodeNameValue(node.short_name ?? node.shortName) ||
      (typeof node.node_id === 'string' ? node.node_id : '')
    );
  }

  /**
   * Populate missing node name fields with sensible defaults.
   *
   * @param {Object} node Node payload.
   * @returns {Object} Updated node reference.
   */
  function applyNodeNameFallback(node) {
    if (!node || typeof node !== 'object') return;
    const short = normalizeNodeNameValue(node.short_name ?? node.shortName);
    const long = normalizeNodeNameValue(node.long_name ?? node.longName);
    if (short || long) return;
    const nodeId = normalizeNodeNameValue(node.node_id ?? node.nodeId);
    if (!nodeId) return;
    const fallbackShort = nodeId.slice(-4);
    const fallbackLong = `Meshtastic ${nodeId}`;
    node.short_name = fallbackShort;
    node.long_name = fallbackLong;
    if ('shortName' in node) node.shortName = fallbackShort;
    if ('longName' in node) node.longName = fallbackLong;
  }

  /**
   * Convert a duration in seconds into a human readable string.
   *
   * @param {number} unixSec Duration in seconds.
   * @returns {string} Human readable representation.
   */
  function timeHum(unixSec) {
    if (!unixSec) return "";
    if (unixSec < 0) return "0s";
    if (unixSec < 60) return `${unixSec}s`;
    if (unixSec < 3600) return `${Math.floor(unixSec/60)}m ${Math.floor((unixSec%60))}s`;
    if (unixSec < 86400) return `${Math.floor(unixSec/3600)}h ${Math.floor((unixSec%3600)/60)}m`;
    return `${Math.floor(unixSec/86400)}d ${Math.floor((unixSec%86400)/3600)}h`;
  }

  /**
   * Return a relative time string describing how long ago an event occurred.
   *
   * @param {number} unixSec Timestamp in seconds.
   * @param {number} [nowSec] Reference timestamp.
   * @returns {string} Human readable relative time.
   */
  function timeAgo(unixSec, nowSec = Date.now()/1000) {
    if (!unixSec) return "";
    const diff = Math.floor(nowSec - Number(unixSec));
    if (diff < 0) return "0s";
    if (diff < 60) return `${diff}s`;
    if (diff < 3600) return `${Math.floor(diff/60)}m ${Math.floor((diff%60))}s`;
    if (diff < 86400) return `${Math.floor(diff/3600)}h ${Math.floor((diff%3600)/60)}m`;
    return `${Math.floor(diff/86400)}d ${Math.floor((diff%86400)/3600)}h`;
  }

  /**
   * Fetch the latest nodes from the JSON API.
   *
   * @param {number} [limit=NODE_LIMIT] Maximum number of records.
   * @returns {Promise<Array<Object>>} Parsed node payloads.
   */
  async function fetchNodes(limit = NODE_LIMIT) {
    const r = await fetch(`/api/nodes?limit=${limit}`, { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  /**
   * Fetch recent messages from the JSON API.
   *
   * @param {number} [limit=NODE_LIMIT] Maximum number of rows.
   * @returns {Promise<Array<Object>>} Parsed message payloads.
   */
  async function fetchMessages(limit = NODE_LIMIT) {
    if (!CHAT_ENABLED) return [];
    const r = await fetch(`/api/messages?limit=${limit}`, { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  /**
   * Fetch neighbour information from the JSON API.
   *
   * @param {number} [limit=NODE_LIMIT] Maximum number of rows.
   * @returns {Promise<Array<Object>>} Parsed neighbour payloads.
   */
  async function fetchNeighbors(limit = NODE_LIMIT) {
    const r = await fetch(`/api/neighbors?limit=${limit}`, { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  /**
   * Fetch telemetry entries from the JSON API.
   *
   * @param {number} [limit=NODE_LIMIT] Maximum number of rows.
   * @returns {Promise<Array<Object>>} Parsed telemetry payloads.
   */
  async function fetchTelemetry(limit = NODE_LIMIT) {
    const r = await fetch(`/api/telemetry?limit=${limit}`, { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  /**
   * Fetch position packets from the JSON API.
   *
   * @param {number} [limit=NODE_LIMIT] Maximum number of rows.
   * @returns {Promise<Array<Object>>} Parsed position payloads.
   */
  async function fetchPositions(limit = NODE_LIMIT) {
    const r = await fetch(`/api/positions?limit=${limit}`, { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  /**
   * Convert arbitrary values to finite numbers when possible.
   *
   * @param {*} value Raw value.
   * @returns {number|null} Finite number or null when conversion fails.
   */
  function toFiniteNumber(value) {
    if (value == null || value === '') return null;
    const num = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(num) ? num : null;
  }

  /**
   * Determine the best-effort timestamp in seconds from numeric or ISO values.
   *
   * @param {*} numeric Numeric timestamp.
   * @param {*} isoString ISO formatted timestamp.
   * @returns {number|null} Timestamp in seconds.
   */
  function resolveTimestampSeconds(numeric, isoString) {
    const parsedNumeric = toFiniteNumber(numeric);
    if (parsedNumeric != null) return parsedNumeric;
    if (typeof isoString === 'string' && isoString.length) {
      const parsedIso = Date.parse(isoString);
      if (Number.isFinite(parsedIso)) {
        return parsedIso / 1000;
      }
    }
    return null;
  }

  /**
   * Merge recent position packets into the node list.
   *
   * @param {Array<Object>} nodes Node payloads.
   * @param {Array<Object>} positions Position entries.
   * @returns {Array<Object>} Updated node collection.
   */
  function mergePositionsIntoNodes(nodes, positions) {
    if (!Array.isArray(nodes) || !Array.isArray(positions) || nodes.length === 0) return;

    const nodesById = new Map();
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue;
      const key = typeof node.node_id === 'string' ? node.node_id : null;
      if (key) nodesById.set(key, node);
    }

    if (nodesById.size === 0) return;

    const updated = new Set();
    for (const pos of positions) {
      if (!pos || typeof pos !== 'object') continue;
      const nodeId = typeof pos.node_id === 'string' ? pos.node_id : null;
      if (!nodeId || updated.has(nodeId)) continue;
      const node = nodesById.get(nodeId);
      if (!node) continue;

      const lat = toFiniteNumber(pos.latitude);
      const lon = toFiniteNumber(pos.longitude);
      if (lat == null || lon == null) continue;

      const currentTimestamp = resolveTimestampSeconds(node.position_time, node.pos_time_iso);
      const incomingTimestamp = resolveTimestampSeconds(pos.position_time, pos.position_time_iso);
      if (currentTimestamp != null) {
        if (incomingTimestamp == null || incomingTimestamp <= currentTimestamp) {
          continue;
        }
      }

      updated.add(nodeId);
      node.latitude = lat;
      node.longitude = lon;

      const alt = toFiniteNumber(pos.altitude);
      if (alt != null) node.altitude = alt;

      const posTime = toFiniteNumber(pos.position_time);
      if (posTime != null) {
        node.position_time = posTime;
        node.pos_time_iso = typeof pos.position_time_iso === 'string' && pos.position_time_iso.length
          ? pos.position_time_iso
          : new Date(posTime * 1000).toISOString();
      } else if (typeof pos.position_time_iso === 'string' && pos.position_time_iso.length) {
        node.pos_time_iso = pos.position_time_iso;
      }

      if (pos.location_source != null && pos.location_source !== '') {
        node.location_source = pos.location_source;
      }

      const precision = toFiniteNumber(pos.precision_bits);
      if (precision != null) node.precision_bits = precision;
    }
  }

  /**
   * Build a lookup table of telemetry entries keyed by node identifier.
   *
   * @param {Array<Object>} entries Telemetry payloads.
   * @returns {Map<string, Object>} Indexed telemetry data.
   */
  function buildTelemetryIndex(entries) {
    const byNodeId = new Map();
    const byNodeNum = new Map();
    if (!Array.isArray(entries)) {
      return { byNodeId, byNodeNum };
    }
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      const nodeId = typeof entry.node_id === 'string' ? entry.node_id : (typeof entry.nodeId === 'string' ? entry.nodeId : null);
      const nodeNumRaw = entry.node_num ?? entry.nodeNum;
      const nodeNum = typeof nodeNumRaw === 'number' ? nodeNumRaw : Number(nodeNumRaw);
      const rxTime = toFiniteNumber(entry.rx_time ?? entry.rxTime);
      const telemetryTime = toFiniteNumber(entry.telemetry_time ?? entry.telemetryTime);
      const timestamp = rxTime != null ? rxTime : telemetryTime != null ? telemetryTime : Number.NEGATIVE_INFINITY;
      if (nodeId) {
        const existing = byNodeId.get(nodeId);
        if (!existing || timestamp > existing.timestamp) {
          byNodeId.set(nodeId, { entry, timestamp });
        }
      }
      if (Number.isFinite(nodeNum)) {
        const existing = byNodeNum.get(nodeNum);
        if (!existing || timestamp > existing.timestamp) {
          byNodeNum.set(nodeNum, { entry, timestamp });
        }
      }
    }
    return { byNodeId, byNodeNum };
  }

  /**
   * Merge telemetry metrics into the node list.
   *
   * @param {Array<Object>} nodes Node payloads.
   * @param {Array<Object>} telemetryEntries Telemetry data.
   * @returns {Array<Object>} Updated node collection.
   */
  function mergeTelemetryIntoNodes(nodes, telemetryEntries) {
    if (!Array.isArray(nodes) || !nodes.length) return;
    const { byNodeId, byNodeNum } = buildTelemetryIndex(telemetryEntries);
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue;
      const nodeId = typeof node.node_id === 'string' ? node.node_id : (typeof node.nodeId === 'string' ? node.nodeId : null);
      const nodeNumRaw = node.num ?? node.node_num ?? node.nodeNum;
      const nodeNum = typeof nodeNumRaw === 'number' ? nodeNumRaw : Number(nodeNumRaw);
      let telemetryEntry = null;
      if (nodeId && byNodeId.has(nodeId)) {
        telemetryEntry = byNodeId.get(nodeId).entry;
      } else if (Number.isFinite(nodeNum) && byNodeNum.has(nodeNum)) {
        telemetryEntry = byNodeNum.get(nodeNum).entry;
      }
      if (!telemetryEntry || typeof telemetryEntry !== 'object') continue;
      const metrics = {
        battery_level: toFiniteNumber(telemetryEntry.battery_level ?? telemetryEntry.batteryLevel),
        voltage: toFiniteNumber(telemetryEntry.voltage),
        uptime_seconds: toFiniteNumber(telemetryEntry.uptime_seconds ?? telemetryEntry.uptimeSeconds),
        channel_utilization: toFiniteNumber(telemetryEntry.channel_utilization ?? telemetryEntry.channelUtilization),
        air_util_tx: toFiniteNumber(telemetryEntry.air_util_tx ?? telemetryEntry.airUtilTx),
        temperature: toFiniteNumber(telemetryEntry.temperature),
        relative_humidity: toFiniteNumber(telemetryEntry.relative_humidity ?? telemetryEntry.relativeHumidity),
        barometric_pressure: toFiniteNumber(telemetryEntry.barometric_pressure ?? telemetryEntry.barometricPressure),
      };
      for (const [key, value] of Object.entries(metrics)) {
        if (value == null) continue;
        node[key] = value;
      }
      const telemetryTime = toFiniteNumber(telemetryEntry.telemetry_time ?? telemetryEntry.telemetryTime);
      if (telemetryTime != null) {
        node.telemetry_time = telemetryTime;
      }
      const rxTime = toFiniteNumber(telemetryEntry.rx_time ?? telemetryEntry.rxTime);
      if (rxTime != null) {
        node.telemetry_rx_time = rxTime;
      }
    }
  }

  /**
   * Compute distance from the configured map center.
   *
   * @param {number} lat Latitude in degrees.
   * @param {number} lon Longitude in degrees.
   * @returns {number|null} Distance in kilometres.
   */
  function distanceFromCenterKm(lat, lon) {
    if (hasLeaflet && mapCenterLatLng) {
      try {
        return L.latLng(lat, lon).distanceTo(mapCenterLatLng) / 1000;
      } catch (err) {
        // fall through to haversine fallback
      }
    }
    return haversineDistanceKm(lat, lon, MAP_CENTER_COORDS.lat, MAP_CENTER_COORDS.lon);
  }

  /**
   * Annotate nodes with their distance from the map center.
   *
   * @param {Array<Object>} nodes Node payloads.
   * @returns {Array<Object>} Updated node collection.
   */
  function computeDistances(nodes) {
    for (const n of nodes) {
      const latRaw = n.latitude;
      const lonRaw = n.longitude;
      if (latRaw == null || latRaw === '' || lonRaw == null || lonRaw === '') {
        n.distance_km = null;
        continue;
      }
      const lat = Number(latRaw);
      const lon = Number(lonRaw);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        n.distance_km = null;
        continue;
      }
      n.distance_km = distanceFromCenterKm(lat, lon);
    }
  }

  /**
   * Render the nodes table with sorted and filtered data.
   *
   * @param {Array<Object>} nodes Node payloads.
   * @param {number} nowSec Reference timestamp.
   * @returns {void}
   */
  function renderTable(nodes, nowSec) {
    const tb = document.querySelector('#nodes tbody');
    const frag = document.createDocumentFragment();
    for (const n of nodes) {
      const tr = document.createElement('tr');
      const lastPositionTime = toFiniteNumber(n.position_time ?? n.positionTime);
      const lastPositionCell = lastPositionTime != null ? timeAgo(lastPositionTime, nowSec) : '';
      tr.innerHTML = `
        <td class="mono">${n.node_id || ""}</td>
        <td>${renderShortHtml(n.short_name, n.role, n.long_name, n)}</td>
        <td>${n.long_name || ""}</td>
        <td>${timeAgo(n.last_heard, nowSec)}</td>
        <td>${n.role || "CLIENT"}</td>
        <td>${fmtHw(n.hw_model)}</td>
        <td>${fmtAlt(n.battery_level, "%")}</td>
        <td>${fmtAlt(n.voltage, "V")}</td>
        <td>${timeHum(n.uptime_seconds)}</td>
        <td>${fmtTx(n.channel_utilization)}</td>
        <td>${fmtTx(n.air_util_tx)}</td>
        <td>${fmtTemperature(n.temperature)}</td>
        <td>${fmtHumidity(n.relative_humidity)}</td>
        <td>${fmtPressure(n.barometric_pressure)}</td>
        <td>${fmtCoords(n.latitude)}</td>
        <td>${fmtCoords(n.longitude)}</td>
        <td>${fmtAlt(n.altitude, "m")}</td>
        <td class="mono">${lastPositionCell}</td>`;
      frag.appendChild(tr);
    }
    tb.replaceChildren(frag);
    if (shortInfoOverlay && shortInfoAnchor && !document.body.contains(shortInfoAnchor)) {
      closeShortInfoOverlay();
    }
  }

  /**
   * Render the Leaflet map markers and neighbour connections.
   *
   * @param {Array<Object>} nodes Node payloads.
   * @param {number} nowSec Reference timestamp.
   * @returns {void}
   */
  function renderMap(nodes, nowSec) {
    if (!map || !markersLayer || !hasLeaflet) {
      return;
    }
    if (neighborLinesLayer) {
      neighborLinesLayer.clearLayers();
    }
    markersLayer.clearLayers();
    const pts = [];
    const nodesById = new Map();
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue;
      const nodeId = node.node_id;
      if (typeof nodeId !== 'string' || nodeId.length === 0) continue;
      nodesById.set(nodeId, node);
    }

    if (neighborLinesLayer && Array.isArray(allNeighbors) && allNeighbors.length) {
      const neighborSegments = [];
      const seenDirections = new Set();
      for (const entry of allNeighbors) {
        if (!entry || typeof entry !== 'object') continue;
        const sourceId = typeof entry.node_id === 'string' ? entry.node_id : null;
        const targetId = typeof entry.neighbor_id === 'string' ? entry.neighbor_id : null;
        if (!sourceId || !targetId) continue;
        const directionKey = `${sourceId}→${targetId}`;
        if (seenDirections.has(directionKey)) continue;
        seenDirections.add(directionKey);

        const sourceNode = nodesById.get(sourceId);
        const targetNode = nodesById.get(targetId);
        if (!sourceNode || !targetNode) continue;

        const srcLatRaw = sourceNode.latitude;
        const srcLonRaw = sourceNode.longitude;
        const tgtLatRaw = targetNode.latitude;
        const tgtLonRaw = targetNode.longitude;
        if (
          srcLatRaw == null || srcLatRaw === '' || srcLonRaw == null || srcLonRaw === '' ||
          tgtLatRaw == null || tgtLatRaw === '' || tgtLonRaw == null || tgtLonRaw === ''
        ) {
          continue;
        }
        const srcLat = Number(srcLatRaw);
        const srcLon = Number(srcLonRaw);
        const tgtLat = Number(tgtLatRaw);
        const tgtLon = Number(tgtLonRaw);
        if (!Number.isFinite(srcLat) || !Number.isFinite(srcLon) || !Number.isFinite(tgtLat) || !Number.isFinite(tgtLon)) {
          continue;
        }
        if (LIMIT_DISTANCE && sourceNode.distance_km != null && sourceNode.distance_km > MAX_DISTANCE_KM) continue;
        if (LIMIT_DISTANCE && targetNode.distance_km != null && targetNode.distance_km > MAX_DISTANCE_KM) continue;

        const priority = getRoleRenderPriority(sourceNode.role);
        const rxTimeRaw = entry.rx_time;
        let rxTime = 0;
        if (typeof rxTimeRaw === 'number' && Number.isFinite(rxTimeRaw)) {
          rxTime = rxTimeRaw;
        } else if (typeof rxTimeRaw === 'string') {
          const parsed = Number(rxTimeRaw);
          rxTime = Number.isFinite(parsed) ? parsed : 0;
        }

        const snrValue = toFiniteNumber(entry.snr);
        const sourceDisplayName = getNodeDisplayNameForOverlay(sourceNode);
        const targetDisplayName = getNodeDisplayNameForOverlay(targetNode);
        const sourceShortName = normalizeNodeNameValue(sourceNode.short_name ?? sourceNode.shortName);
        const targetShortName = normalizeNodeNameValue(targetNode.short_name ?? targetNode.shortName);

        neighborSegments.push({
          latlngs: [[srcLat, srcLon], [tgtLat, tgtLon]],
          color: getRoleColor(sourceNode.role),
          priority,
          rxTime,
          sourceId,
          targetId,
          snr: snrValue,
          sourceDisplayName,
          targetDisplayName,
          sourceShortName,
          sourceRole: sourceNode.role,
          targetShortName,
          targetRole: targetNode.role
        });
      }

      neighborSegments
        .sort((a, b) => {
          if (a.priority !== b.priority) return a.priority - b.priority;
          if (a.rxTime !== b.rxTime) return b.rxTime - a.rxTime;
          if (a.sourceId !== b.sourceId) return a.sourceId < b.sourceId ? -1 : 1;
          if (a.targetId !== b.targetId) return a.targetId < b.targetId ? -1 : 1;
          return 0;
        })
        .forEach(segment => {
          const polyline = L.polyline(segment.latlngs, {
            color: segment.color,
            weight: 2,
            opacity: 0.42,
            className: 'neighbor-connection-line'
          }).addTo(neighborLinesLayer);
          if (polyline && typeof polyline.on === 'function') {
            polyline.on('click', event => {
              if (event && event.originalEvent) {
                if (typeof event.originalEvent.preventDefault === 'function') {
                  event.originalEvent.preventDefault();
                }
                if (typeof event.originalEvent.stopPropagation === 'function') {
                  event.originalEvent.stopPropagation();
                }
              }
              const clickTarget =
                event.originalEvent &&
                typeof Element !== 'undefined' &&
                event.originalEvent.target instanceof Element
                  ? event.originalEvent.target
                  : null;
              const anchorEl = polyline.getElement() || clickTarget;
              if (!anchorEl) return;
              if (shortInfoOverlay && !shortInfoOverlay.hidden && shortInfoAnchor === anchorEl) {
                closeShortInfoOverlay();
                return;
              }
              openNeighborOverlay(anchorEl, segment);
            });
          }
        });
    }

    const nodesByRenderOrder = nodes
      .map((node, index) => ({ node, index }))
      .sort((a, b) => {
        const orderA = getRoleRenderPriority(a.node && a.node.role);
        const orderB = getRoleRenderPriority(b.node && b.node.role);
        if (orderA !== orderB) return orderA - orderB;
        return a.index - b.index;
      })
      .map(entry => entry.node);

    for (const n of nodesByRenderOrder) {
      const latRaw = n.latitude, lonRaw = n.longitude;
      if (latRaw == null || latRaw === '' || lonRaw == null || lonRaw === '') continue;
      const lat = Number(latRaw), lon = Number(lonRaw);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      if (LIMIT_DISTANCE && n.distance_km != null && n.distance_km > MAX_DISTANCE_KM) continue;

      const color = getRoleColor(n.role);
      const marker = L.circleMarker([lat, lon], {
        radius: 9,
        color: '#000',
        weight: 1,
        fillColor: color,
        fillOpacity: 0.7,
        opacity: 0.7
      });

      const fallbackOverlayProvider = () => mergeOverlayDetails(null, n);
      const initialOverlay = fallbackOverlayProvider();
      const initialPopupHtml = buildMapPopupHtml(overlayToPopupNode(initialOverlay), nowSec);

      marker.bindPopup(initialPopupHtml);
      marker.addTo(markersLayer);
      pts.push([lat, lon]);

      const updateMarkerPopup = overlayDetails => {
        const popupNode = overlayToPopupNode(overlayDetails);
        const html = buildMapPopupHtml(popupNode, Math.floor(Date.now() / 1000));
        if (typeof marker.setPopupContent === 'function') {
          marker.setPopupContent(html);
          return;
        }
        if (typeof marker.getPopup === 'function') {
          const popup = marker.getPopup();
          if (popup && typeof popup.setContent === 'function') {
            popup.setContent(html);
            return;
          }
        }
        marker.bindPopup(html);
      };

      attachNodeInfoRefreshToMarker({
        marker,
        getOverlayFallback: fallbackOverlayProvider,
        refreshNodeInformation,
        mergeOverlayDetails,
        createRequestToken: () => ++shortInfoRequestToken,
        isTokenCurrent: token => token === shortInfoRequestToken,
        showLoading: (anchor, info) => {
          if (anchor) {
            showShortInfoLoading(anchor, info);
          }
        },
        showDetails: (anchor, info) => {
          if (anchor) {
            openShortInfoOverlay(anchor, info);
          }
        },
        showError: (anchor, info, error) => {
          console.warn('Failed to refresh node information for map marker', error);
          if (anchor) {
            openShortInfoOverlay(anchor, info);
          }
        },
        updatePopup: updateMarkerPopup,
        shouldHandleClick: anchor => {
          if (!anchor) return true;
          if (shortInfoOverlay && !shortInfoOverlay.hidden && shortInfoAnchor === anchor) {
            closeShortInfoOverlay();
            return false;
          }
          return true;
        },
      });
    }
    if (pts.length && fitBoundsEl && fitBoundsEl.checked) {
      const bounds = computeBoundsForPoints(pts, {
        paddingFraction: 0.2,
        minimumRangeKm: LIMIT_DISTANCE
          ? Math.min(Math.max(MAX_DISTANCE_KM * 0.1, 1), MAX_DISTANCE_KM)
          : 1
      });
      fitMapToBounds(bounds, { animate: false, paddingPx: AUTO_FIT_PADDING_PX });
    }
  }

  /**
   * Test whether a node matches the free-text filter string.
   *
   * @param {Object} node Node payload.
   * @param {string} query Filter query.
   * @returns {boolean} True when the node should be visible.
   */
  function matchesTextFilter(node, query) {
    if (!query) return true;
    return [node?.node_id, node?.short_name, node?.long_name]
      .filter(value => value != null && value !== '')
      .some(value => String(value).toLowerCase().includes(query));
  }

  /**
   * Test whether a node matches the active role filters.
   *
   * @param {Object} node Node payload.
   * @returns {boolean} True when the node should be visible.
   */
  function matchesRoleFilter(node) {
    if (!activeRoleFilters.size) return true;
    const roleKey = getRoleKey(node && node.role);
    return activeRoleFilters.has(roleKey);
  }

  /**
   * Show or hide the filter clear button depending on the input state.
   *
   * @returns {void}
   */
  function updateFilterClearVisibility() {
    if (!filterInput || !filterClearButton) return;
    const hasValue = filterInput.value && filterInput.value.length > 0;
    filterClearButton.hidden = !hasValue;
  }

  /**
   * Apply text and role filters to the node list and re-render outputs.
   *
   * @returns {void}
   */
  function applyFilter() {
    updateFilterClearVisibility();
    const rawQuery = filterInput ? filterInput.value : '';
    const q = rawQuery.trim().toLowerCase();
    const filteredNodes = allNodes.filter(n => matchesTextFilter(n, q) && matchesRoleFilter(n));
    const sortedNodes = sortNodes(filteredNodes);
    const nowSec = Date.now()/1000;
    renderTable(sortedNodes, nowSec);
    renderMap(sortedNodes, nowSec);
    updateCount(sortedNodes, nowSec);
    updateRefreshInfo(sortedNodes, nowSec);
    updateSortIndicators();
  }

  if (filterInput) {
    filterInput.addEventListener('input', () => {
      updateFilterClearVisibility();
      applyFilter();
    });
    updateFilterClearVisibility();
  }

  if (filterClearButton) {
    filterClearButton.addEventListener('click', () => {
      if (!filterInput) return;
      if (filterInput.value.length === 0) {
        filterInput.focus();
        return;
      }
      filterInput.value = '';
      updateFilterClearVisibility();
      applyFilter();
      filterInput.focus();
    });
  }

  /**
   * Refresh nodes, messages, and telemetry from the API and update the UI.
   *
   * @returns {Promise<void>} Resolves when rendering completes.
   */
  async function refresh() {
    try {
      statusEl.textContent = 'refreshing…';
      const neighborPromise = fetchNeighbors().catch(err => {
        console.warn('neighbor refresh failed; continuing without connections', err);
        return [];
      });
      const telemetryPromise = fetchTelemetry().catch(err => {
        console.warn('telemetry refresh failed; continuing without telemetry', err);
        return [];
      });
      const positionsPromise = fetchPositions().catch(err => {
        console.warn('position refresh failed; continuing without updates', err);
        return [];
      });
      const [nodes, positions, neighborTuples, messages, telemetryEntries] = await Promise.all([
        fetchNodes(),
        positionsPromise,
        neighborPromise,
        fetchMessages(),
        telemetryPromise,
      ]);
      nodes.forEach(applyNodeNameFallback);
      mergePositionsIntoNodes(nodes, positions);
      computeDistances(nodes);
      mergeTelemetryIntoNodes(nodes, telemetryEntries);
      if (Array.isArray(messages)) {
        messages.forEach(message => {
          if (message && message.node) applyNodeNameFallback(message.node);
        });
      }
      renderChatLog(nodes, messages);
      allNodes = nodes;
      rebuildNodeIndex(allNodes);
      allNeighbors = Array.isArray(neighborTuples) ? neighborTuples : [];
      applyFilter();
      statusEl.textContent = 'updated ' + new Date().toLocaleTimeString();
    } catch (e) {
      statusEl.textContent = 'error: ' + e.message;
      console.error(e);
    }
  }

  refresh();
  restartAutoRefresh();
  refreshBtn.addEventListener('click', refresh);

  if (autoRefreshEl) {
    autoRefreshEl.addEventListener('change', () => {
      restartAutoRefresh();
      if (autoRefreshEl.checked) {
        refresh();
      }
    });
  }

  /**
   * Update the count badge showing how many nodes are displayed.
   *
   * @param {Array<Object>} nodes Node payloads.
   * @param {number} nowSec Reference timestamp.
   * @returns {void}
   */
  function updateCount(nodes, nowSec) {
    const dayAgoSec = nowSec - 86400;
    const count = nodes.filter(n => n.last_heard && Number(n.last_heard) >= dayAgoSec).length;
    const text = `${baseTitle} (${count})`;
    titleEl.textContent = text;
    if (headerTitleTextEl) {
      headerTitleTextEl.textContent = text;
    } else if (headerEl) {
      headerEl.textContent = text;
    }
  }

  /**
   * Update the status message describing the currently rendered data.
   *
   * @param {Array<Object>} nodes Node payloads.
   * @param {number} nowSec Reference timestamp.
   * @returns {void}
   */
  function updateRefreshInfo(nodes, nowSec) {
    const windows = [
      { label: 'hour', secs: 3600 },
      { label: 'day', secs: 86400 },
      { label: 'week', secs: 7 * 86400 },
    ];
    const counts = windows.map(w => {
      const c = nodes.filter(n => n.last_heard && nowSec - Number(n.last_heard) <= w.secs).length;
      return `${c}/${w.label}`;
    }).join(', ');
    refreshInfo.textContent = `${config.channel} (${config.frequency}) — active nodes: ${counts}.`;
  }
}
