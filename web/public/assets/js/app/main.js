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

import { computeBoundingBox, computeBoundsForPoints, haversineDistanceKm } from './map-bounds.js';
import { createMapAutoFitController } from './map-auto-fit-controller.js';
import { resolveAutoFitBoundsConfig } from './map-auto-fit-settings.js';
import { attachNodeInfoRefreshToMarker, overlayToPopupNode } from './map-marker-node-info.js';
import { createMapFocusHandler, DEFAULT_NODE_FOCUS_ZOOM } from './nodes-map-focus.js';
import { enhanceCoordinateCell } from './nodes-coordinate-links.js';
import { createShortInfoOverlayStack } from './short-info-overlay-manager.js';
import { createNodeDetailOverlayManager } from './node-detail-overlay.js';
import { refreshNodeInformation } from './node-details.js';
import { extractModemMetadata, formatLoraFrequencyMHz, formatModemDisplay } from './node-modem-metadata.js';
import {
  TELEMETRY_FIELDS,
  buildTelemetryDisplayEntries,
  collectTelemetryMetrics,
  fmtAlt,
  fmtHumidity,
  fmtPressure,
  fmtTemperature,
  fmtTx,
} from './short-info-telemetry.js';
import { createMessageNodeHydrator } from './message-node-hydrator.js';
import {
  extractChatMessageMetadata,
  formatChatMessagePrefix,
  formatNodeAnnouncementPrefix,
  formatChatPresetTag
} from './chat-format.js';
import { initializeInstanceSelector } from './instance-selector.js';
import { MESSAGE_LIMIT, normaliseMessageLimit } from './message-limit.js';
import { CHAT_LOG_ENTRY_TYPES, buildChatTabModel, MAX_CHANNEL_INDEX } from './chat-log-tabs.js';
import { renderChatTabs } from './chat-tabs.js';
import { formatPositionHighlights, formatTelemetryHighlights } from './chat-log-highlights.js';
import { filterChatModel, normaliseChatFilterQuery } from './chat-search.js';
import { buildMessageBody, buildMessageIndex, resolveReplyPrefix } from './message-replies.js';
import {
  SNAPSHOT_WINDOW,
  aggregateNeighborSnapshots,
  aggregateNodeSnapshots,
  aggregatePositionSnapshots,
  aggregateTelemetrySnapshots,
} from './snapshot-aggregator.js';
import { normalizeNodeCollection } from './node-snapshot-normalizer.js';
import { buildTraceSegments } from './trace-paths.js';

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
 *   mapZoom: number | null,
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
  const shortInfoTemplate = document.getElementById('shortInfoOverlayTemplate');
  const overlayStack = createShortInfoOverlayStack({ document, window, template: shortInfoTemplate });
  const titleEl = document.querySelector('title');
  const headerEl = document.querySelector('h1');
  const headerTitleTextEl = headerEl ? headerEl.querySelector('.site-title-text') : null;
  const chatEl = document.getElementById('chat');
  const refreshInfo = document.getElementById('refreshInfo');
  const instanceSelect = document.getElementById('instanceSelect');
  const baseTitle = document.title;
  const nodesTable = document.getElementById('nodes');
  const sortButtons = nodesTable ? Array.from(nodesTable.querySelectorAll('thead .sort-button[data-sort-key]')) : [];
  const infoOverlayHome = infoOverlay
    ? { parent: infoOverlay.parentNode, nextSibling: infoOverlay.nextSibling }
    : null;
  const bodyClassList = document.body ? document.body.classList : null;
  const isPrivateMode = document.body && document.body.dataset
    ? String(document.body.dataset.privateMode).toLowerCase() === 'true'
    : false;
  const isDashboardView = bodyClassList ? bodyClassList.contains('view-dashboard') : false;
  const isChatView = bodyClassList ? bodyClassList.contains('view-chat') : false;
  const mapZoomOverride = Number.isFinite(config.mapZoom) ? Number(config.mapZoom) : null;
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
    lora_freq: {
      getValue: n => n.lora_freq ?? n.loraFreq ?? n.frequency,
      compare: compareNumber,
      hasValue: hasNumberValue,
      defaultDirection: 'desc'
    },
    modem_preset: {
      getValue: n => n.modem_preset ?? n.modemPreset,
      compare: compareString,
      hasValue: hasStringValue,
      defaultDirection: 'asc'
    },
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
  /** @type {Array<Object>} */
  let allTraces = [];
  /** @type {Array<Object>} */
  let allMessages = [];
  /** @type {Array<Object>} */
  let allEncryptedMessages = [];
  /** @type {Array<Object>} */
  let allTelemetryEntries = [];
  /** @type {Array<Object>} */
  let allPositionEntries = [];
  /** @type {Map<string, Object>} */
  let nodesById = new Map();
  let messagesById = new Map();
  let nodesByNum = new Map();
  const messageNodeHydrator = createMessageNodeHydrator({
    fetchNodeById,
    applyNodeFallback: applyNodeNameFallback,
    logger: console,
  });
  const NODE_LIMIT = 1000;
  const TRACE_LIMIT = 200;
  const SNAPSHOT_LIMIT = SNAPSHOT_WINDOW;
  const CHAT_LIMIT = MESSAGE_LIMIT;
  const CHAT_RECENT_WINDOW_SECONDS = 7 * 24 * 60 * 60;
  const REFRESH_MS = config.refreshMs;
  const CHAT_ENABLED = Boolean(config.chatEnabled);
  const instanceSelectorEnabled = Boolean(config.instancesFeatureEnabled);
  if (refreshInfo) {
    if (isDashboardView) {
      refreshInfo.textContent = `${config.channel} (${config.frequency}) — active nodes: …`;
    } else {
      refreshInfo.textContent = '';
    }
  }

  if (instanceSelectorEnabled && instanceSelect) {
    void initializeInstanceSelector({
      selectElement: instanceSelect,
      instanceDomain: config.instanceDomain,
      defaultLabel: 'Select region ...',
    }).catch(error => {
      console.warn('Instance selector initialisation failed', error);
    });
  }

  /** @type {ReturnType<typeof setTimeout>|null} */
  let refreshTimer = null;

  /**
   * Close any open short-info overlays that do not contain the provided anchor.
   *
   * The method preserves ancestor overlays that host nested short-name badges,
   * ensuring context overlays (for example, neighbor listings) remain visible
   * while unrelated overlays are dismissed.
   *
   * @param {?Element} anchorEl Short-name badge that triggered the interaction.
   * @returns {void}
   */
  function closeUnrelatedShortOverlays(anchorEl) {
    if (!anchorEl) {
      return;
    }
    const openOverlays = overlayStack.getOpenOverlays();
    for (const entry of openOverlays) {
      if (!entry || !entry.element || entry.element.contains(anchorEl)) {
        continue;
      }
      overlayStack.close(entry.anchor);
    }
  }

  /**
   * Scroll the active chat tab panel to its most recent entry when the
   * dedicated chat view is displayed.
   *
   * @returns {void}
   */
  function scrollActiveChatPanelToBottom() {
    if (!chatEl || !isChatView) {
      return;
    }
    const activeTabId = chatEl.dataset?.activeTab;
    if (!activeTabId) {
      return;
    }
    const escapedId = cssEscape(activeTabId);
    if (!escapedId) {
      return;
    }
    const panel = chatEl.querySelector(`#chat-panel-${escapedId}`);
    if (panel && typeof panel.scrollHeight === 'number' && typeof panel.scrollTop === 'number') {
      panel.scrollTop = panel.scrollHeight;
    }
  }

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

  if (fitBoundsEl && mapZoomOverride !== null) {
    fitBoundsEl.checked = false;
    fitBoundsEl.disabled = true;
    fitBoundsEl.setAttribute('aria-disabled', 'true');
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
  const autoFitBoundsConfig = resolveAutoFitBoundsConfig({
    hasDistanceLimit: LIMIT_DISTANCE,
    maxDistanceKm: MAX_DISTANCE_KM
  });
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

  const focusMapOnCoordinates = createMapFocusHandler({
    getMap: () => map,
    autoFitController,
    leaflet: hasLeaflet ? window.L : null,
    defaultZoom: DEFAULT_NODE_FOCUS_ZOOM,
    setMapCenter: value => {
      mapCenterLatLng = value;
    }
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
   * Append the informational modal overlay to the fullscreen container when active.
   *
   * @returns {void}
   */
  function attachInfoOverlayToFullscreenHost() {
    if (!infoOverlay || !fullscreenContainer) return;
    if (infoOverlay.parentNode !== fullscreenContainer) {
      fullscreenContainer.appendChild(infoOverlay);
    }
    if (infoOverlay.classList) {
      infoOverlay.classList.add('info-overlay--fullscreen');
    }
  }

  /**
   * Restore the informational overlay to its original DOM position.
   *
   * @returns {void}
   */
  function restoreInfoOverlayToHome() {
    if (!infoOverlay || !infoOverlayHome || !infoOverlayHome.parent) return;
    if (infoOverlay.parentNode === infoOverlayHome.parent) {
      if (infoOverlay.classList) {
        infoOverlay.classList.remove('info-overlay--fullscreen');
      }
      return;
    }
    if (
      infoOverlayHome.nextSibling &&
      infoOverlayHome.nextSibling.parentNode === infoOverlayHome.parent &&
      typeof infoOverlayHome.parent.insertBefore === 'function'
    ) {
      infoOverlayHome.parent.insertBefore(infoOverlay, infoOverlayHome.nextSibling);
    } else if (typeof infoOverlayHome.parent.appendChild === 'function') {
      infoOverlayHome.parent.appendChild(infoOverlay);
    }
    if (infoOverlay.classList) {
      infoOverlay.classList.remove('info-overlay--fullscreen');
    }
  }

  /**
   * Ensure the informational overlay participates in the active fullscreen subtree.
   *
   * @returns {void}
   */
  function syncInfoOverlayHost() {
    if (!infoOverlay) return;
    if (isMapInFullscreen()) {
      attachInfoOverlayToFullscreenHost();
    } else {
      restoreInfoOverlayToHome();
    }
  }

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
    syncInfoOverlayHost();
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

  syncInfoOverlayHost();

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
    if (mapZoomOverride !== null) {
      map.setView([MAP_CENTER_COORDS.lat, MAP_CENTER_COORDS.lon], mapZoomOverride);
    } else if (initialBounds) {
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
    syncInfoOverlayHost();
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

  const nodeDetailOverlayManager = createNodeDetailOverlayManager({
    document,
    privateMode: isPrivateMode,
  });

  document.addEventListener('click', event => {
    const longNameLink = event.target.closest('.node-long-link');
    if (
      longNameLink &&
      nodeDetailOverlayManager &&
      shouldHandleNodeLongLink(longNameLink) &&
      !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
    ) {
      const identifier = getNodeIdentifierFromLink(longNameLink);
      if (identifier) {
        event.preventDefault();
        event.stopPropagation();
        overlayStack.closeAll();
        const label = typeof longNameLink.textContent === 'string' ? longNameLink.textContent.trim() : '';
        nodeDetailOverlayManager.open({ nodeId: identifier }, { trigger: longNameLink, label })
          .catch(err => console.error('Failed to open node detail overlay', err));
        return;
      }
    }

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

      if (overlayStack.isOpen(shortTarget)) {
        overlayStack.close(shortTarget);
        return;
      }

      const nodeId = typeof fallbackDetails.nodeId === 'string' && fallbackDetails.nodeId.trim().length
        ? fallbackDetails.nodeId.trim()
        : '';
      const nodeNum = Number.isFinite(fallbackDetails.nodeNum) ? fallbackDetails.nodeNum : null;

      if (!nodeId && !nodeNum) {
        closeUnrelatedShortOverlays(shortTarget);
        openShortInfoOverlay(shortTarget, fallbackDetails);
        return;
      }

      const requestId = overlayStack.incrementRequestToken(shortTarget);
      showShortInfoLoading(shortTarget, fallbackDetails);

      refreshNodeInformation({ nodeId: nodeId || undefined, nodeNum: nodeNum ?? undefined, fallback: fallbackInfo })
        .then(details => {
          if (!overlayStack.isTokenCurrent(shortTarget, requestId)) return;
          const overlayDetails = mergeOverlayDetails(details, fallbackInfo);
          if (!overlayDetails.shortName && shortTarget.textContent) {
            overlayDetails.shortName = shortTarget.textContent.replace(/\u00a0/g, ' ').trim();
          }
          closeUnrelatedShortOverlays(shortTarget);
          openShortInfoOverlay(shortTarget, overlayDetails);
        })
        .catch(err => {
          console.warn('Failed to refresh node information', err);
          if (!overlayStack.isTokenCurrent(shortTarget, requestId)) return;
          const overlayDetails = mergeOverlayDetails(null, fallbackInfo);
          if (!overlayDetails.shortName && shortTarget.textContent) {
            overlayDetails.shortName = shortTarget.textContent.replace(/\u00a0/g, ' ').trim();
          }
          closeUnrelatedShortOverlays(shortTarget);
          openShortInfoOverlay(shortTarget, overlayDetails);
        });
      return;
    }
    if (event.target.closest('.neighbor-connection-line')) {
      return;
    }
    if (overlayStack.containsNode(event.target)) {
      return;
    }
    overlayStack.closeAll();
  });

  window.addEventListener('resize', () => {
    overlayStack.positionAll();
  });
  window.addEventListener('scroll', () => {
    overlayStack.positionAll();
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
          telemetryTime: nodeData.telemetry_time ?? nodeData.telemetryTime ?? null,
        };
        Object.assign(info, collectTelemetryMetrics(nodeData));
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

  const potatoMeshNamespace = globalThis.PotatoMesh || (globalThis.PotatoMesh = {});
  potatoMeshNamespace.renderShortHtml = renderShortHtml;
  potatoMeshNamespace.getRoleColor = getRoleColor;
  potatoMeshNamespace.getRoleKey = getRoleKey;
  potatoMeshNamespace.normalizeRole = normalizeRole;

  /**
   * Escape a CSS selector fragment with a defensive fallback for
   * environments lacking ``CSS.escape`` support.
   *
   * @param {string} value Raw selector fragment.
   * @returns {string} Escaped selector fragment safe for interpolation.
   */
  function cssEscape(value) {
    if (typeof value !== 'string' || value.length === 0) {
      return '';
    }
    if (typeof window !== 'undefined' && window.CSS && typeof window.CSS.escape === 'function') {
      return window.CSS.escape(value);
    }
    return value.replace(/[^a-zA-Z0-9_-]/g, chr => `\\${chr}`);
  }

  /**
   * Populate the ``nodesById`` index for quick lookups.
   *
   * @param {Array<Object>} nodes Collection of node payloads.
   * @returns {void}
   */
  function rebuildNodeIndex(nodes) {
    nodesById = new Map();
    nodesByNum = new Map();
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue;
      const nodeIdRaw = typeof node.node_id === 'string'
        ? node.node_id
        : (typeof node.nodeId === 'string' ? node.nodeId : null);
      if (nodeIdRaw) {
        nodesById.set(nodeIdRaw.trim(), node);
      }
      const nodeNumRaw = node.num ?? node.node_num ?? node.nodeNum;
      const nodeNum = typeof nodeNumRaw === 'number' ? nodeNumRaw : Number(nodeNumRaw);
      if (Number.isFinite(nodeNum)) {
        nodesByNum.set(nodeNum, node);
      }
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
    const longNameLink = renderNodeLongNameLink(node?.long_name, node?.node_id);
    if (longNameLink) {
      lines.push(`<b>${longNameLink}</b>`);
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

    const modemMetadata = extractModemMetadata(source);
    if (modemMetadata.modemPreset) {
      normalized.modemPreset = modemMetadata.modemPreset;
    }
    if (modemMetadata.loraFreq != null) {
      normalized.loraFreq = modemMetadata.loraFreq;
    }

    const numericPairs = [
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

    const telemetryMetrics = collectTelemetryMetrics(source);
    for (const field of TELEMETRY_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(telemetryMetrics, field.key)) {
        continue;
      }
      normalized[field.key] = telemetryMetrics[field.key];
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
    if (!target) return;
    const normalized = normalizeOverlaySource(info || {});
    const heading = normalized.longName || normalized.shortName || normalized.nodeId || '';
    let headingHtml = '';
    if (normalized.longName) {
      const link = renderNodeLongNameLink(normalized.longName, normalized.nodeId);
      if (link) {
        headingHtml = `<strong>${link}</strong><br/>`;
      }
    }
    if (!headingHtml && heading) {
      headingHtml = `<strong>${escapeHtml(heading)}</strong><br/>`;
    }
    overlayStack.render(target, `${headingHtml}Loading…`);
  }

  /**
   * Populate and display the short-info overlay for a node badge.
   *
   * @param {HTMLElement} target Anchor element that triggered the overlay.
   * @param {Object} info Node payload displayed in the overlay.
   * @returns {void}
   */
  function openShortInfoOverlay(target, info) {
    if (!target || !info) return;
    const overlayInfo = normalizeOverlaySource(info);
    if (!overlayInfo.role || overlayInfo.role === '') {
      overlayInfo.role = 'CLIENT';
    }
    const lines = [];
    const longNameLink = renderNodeLongNameLink(overlayInfo.longName, overlayInfo.nodeId);
    if (longNameLink) {
      lines.push(`<strong>${longNameLink}</strong>`);
    } else {
      const longNameValue = shortInfoValueOrDash(overlayInfo.longName ?? '');
      if (longNameValue !== '—') {
        lines.push(`<strong>${escapeHtml(longNameValue)}</strong>`);
      }
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
    const modemDisplay = formatModemDisplay(overlayInfo.modemPreset, overlayInfo.loraFreq);
    if (modemDisplay) {
      lines.push(escapeHtml(modemDisplay));
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
    const telemetryEntries = buildTelemetryDisplayEntries(overlayInfo, { formatUptime: formatShortInfoUptime });
    for (const entry of telemetryEntries) {
      lines.push(`${escapeHtml(entry.label)}: ${escapeHtml(entry.value)}`);
    }
    if (neighborLineHtml) {
      lines.push(neighborLineHtml);
    }
    overlayStack.render(target, lines.join('<br/>'));
  }

  /**
   * Display an overlay describing a neighbour link.
   *
   * @param {HTMLElement} target Anchor element for the overlay.
   * @param {Object} segment GeoJSON segment describing the connection.
   * @returns {void}
   */
  function openNeighborOverlay(target, segment) {
    if (!target || !segment) return;
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
    const sourceLongLink = renderNodeLongNameLink(segment.sourceDisplayName, segment.sourceId);
    if (sourceLongLink) {
      lines.push(`<strong>${sourceLongLink}</strong>`);
    } else {
      lines.push(`<strong>${escapeHtml(nodeName)}</strong>`);
    }
    lines.push(`${sourceShortHtml} <span class="mono">${escapeHtml(sourceIdText)}</span>`);
    const neighborLongLink = renderNodeLongNameLink(segment.targetDisplayName, segment.targetId);
    const neighborLabel = neighborLongLink || escapeHtml(neighborFullName);
    const neighborLine = `${targetShortHtml} [${neighborLabel}]`;
    lines.push(neighborLine);
    lines.push(`SNR: ${escapeHtml(snrText)}`);
    overlayStack.render(target, lines.join('<br/>'));
  }

  /**
   * Create a chat log date divider when the day changes.
   *
   * @param {number} ts Unix timestamp in seconds.
   * @returns {HTMLElement} Divider element.
   */
  function createDateDividerFactory() {
    let lastChatDate = null;
    return ts => {
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
    };
  }

  /**
   * Build a chat log entry describing a node join event.
   *
   * @param {Object} n Node payload.
   * @returns {HTMLElement} Chat log element.
   */
  function createNodeChatEntry(node, timestampOverride = null) {
    if (!node || typeof node !== 'object') return null;
    const nodeIdRaw = pickFirstProperty([node], ['node_id', 'nodeId']);
    const fallbackId = nodeIdRaw || 'Unknown node';
    const longNameRaw = pickFirstProperty([node], ['long_name', 'longName']);
    const longNameDisplay = longNameRaw ? String(longNameRaw) : fallbackId;
    const longNameLink = renderNodeLongNameLink(longNameRaw, nodeIdRaw);
    const announcementName = longNameLink || escapeHtml(longNameDisplay);
    const shortNameRaw = pickFirstProperty([node], ['short_name', 'shortName']);
    const shortNameDisplay = shortNameRaw ? String(shortNameRaw) : (nodeIdRaw ? nodeIdRaw.slice(-4) : null);
    const roleDisplay = pickFirstProperty([node], ['role']);
    const tsSeconds = timestampOverride != null
      ? timestampOverride
      : resolveTimestampSeconds(node.first_heard ?? node.firstHeard, node.first_heard_iso ?? node.firstHeardIso);
    return createAnnouncementEntry({
      timestampSeconds: tsSeconds,
      shortName: shortNameDisplay,
      longName: longNameDisplay,
      role: roleDisplay,
      metadataSource: node,
      nodeData: node,
      messageHtml: `${renderEmojiHtml('☀️')} ${renderAnnouncementCopy('New node:', ` ${announcementName}`)}`
    });
  }

  /**
   * Build a formatted suffix that enumerates highlight values.
   *
   * @param {Array<{label: string, value: string}>} highlights Highlight metadata entries.
   * @returns {string} HTML suffix containing escaped highlight entries.
   */
  function buildHighlightSuffix(highlights) {
    if (!Array.isArray(highlights) || highlights.length === 0) {
      return '';
    }
    const parts = [];
    for (const entry of highlights) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }
      const { label, value } = entry;
      if (label == null || value == null || value === '') {
        continue;
      }
      const labelText = String(label).trim();
      const valueText = String(value).trim();
      if (!labelText || !valueText) {
        continue;
      }
      parts.push(`${escapeHtml(labelText)}: ${escapeHtml(valueText)}`);
    }
    if (!parts.length) {
      return '';
    }
    return ` — ${parts.join(', ')}`;
  }

  /**
   * Render a non-italicised emoji span suitable for announcement entries.
   *
   * @param {string} symbol Emoji or short textual marker.
   * @returns {string} HTML span wrapping the escaped symbol.
   */
  function renderEmojiHtml(symbol) {
    if (symbol == null) {
      return '';
    }
    const trimmed = String(symbol).trim();
    if (!trimmed) {
      return '';
    }
    return `<span class="chat-entry-emoji" aria-hidden="true">${escapeHtml(trimmed)}</span>`;
  }

  /**
   * Render chat announcement copy without italic styling.
   *
   * @param {string} baseText Base message content before any suffix.
   * @param {string} [suffix=''] Optional HTML-safe suffix appended to the base copy.
   * @returns {string} Escaped HTML span containing the announcement copy.
   */
  function renderAnnouncementCopy(baseText, suffix = '') {
    const safeBase = baseText != null ? String(baseText) : '';
    const safeSuffix = suffix != null ? String(suffix) : '';
    return `<span class="chat-entry-copy">${escapeHtml(safeBase)}${safeSuffix}</span>`;
  }

  function createNodeInfoChatEntry(entry, context) {
    const label = context.longName ? String(context.longName) : (context.nodeId || 'Unknown node');
    return createAnnouncementEntry({
      timestampSeconds: entry?.ts ?? null,
      shortName: context.shortName,
      longName: label,
      role: context.role,
      metadataSource: context.metadataSource,
      nodeData: context.nodeData,
      messageHtml: `${renderEmojiHtml('💾')} ${renderAnnouncementCopy('Updated node info')}`
    });
  }

  function createTelemetryChatEntry(entry, context) {
    const label = context.longName ? String(context.longName) : (context.nodeId || 'Unknown node');
    const highlightSuffix = buildHighlightSuffix(formatTelemetryHighlights(entry?.telemetry));
    return createAnnouncementEntry({
      timestampSeconds: entry?.ts ?? null,
      shortName: context.shortName,
      longName: label,
      role: context.role,
      metadataSource: context.metadataSource,
      nodeData: context.nodeData,
      messageHtml: `${renderEmojiHtml('🔋')} ${renderAnnouncementCopy('Broadcasted telemetry', highlightSuffix)}`
    });
  }

  function createPositionChatEntry(entry, context) {
    const label = context.longName ? String(context.longName) : (context.nodeId || 'Unknown node');
    const highlightSuffix = buildHighlightSuffix(formatPositionHighlights(entry?.position));
    return createAnnouncementEntry({
      timestampSeconds: entry?.ts ?? null,
      shortName: context.shortName,
      longName: label,
      role: context.role,
      metadataSource: context.metadataSource,
      nodeData: context.nodeData,
      messageHtml: `${renderEmojiHtml('📍')} ${renderAnnouncementCopy('Broadcasted position info', highlightSuffix)}`
    });
  }

  function createNeighborChatEntry(entry, context) {
    const label = context.longName ? String(context.longName) : (context.nodeId || 'Unknown node');
    const neighborId = entry?.neighborId ?? pickFirstProperty([entry?.neighbor], ['neighbor_id', 'neighborId']);
    let neighborLabel = null;
    if (neighborId) {
      const trimmed = String(neighborId).trim();
      if (trimmed && nodesById.has(trimmed)) {
        const neighborNode = nodesById.get(trimmed);
        neighborLabel = pickFirstProperty([neighborNode], ['long_name', 'longName', 'short_name', 'shortName']) ?? trimmed;
      } else {
        neighborLabel = trimmed;
      }
    }
    const detail = neighborLabel ? `: ${escapeHtml(String(neighborLabel))}` : '';
    return createAnnouncementEntry({
      timestampSeconds: entry?.ts ?? null,
      shortName: context.shortName,
      longName: label,
      role: context.role,
      metadataSource: context.metadataSource,
      nodeData: context.nodeData,
      messageHtml: `${renderEmojiHtml('🏘️')} ${renderAnnouncementCopy('Broadcasted neighbor info', detail)}`
    });
  }

  function createChatLogEntry(entry) {
    if (!entry || typeof entry !== 'object') return null;
    if (entry.type === CHAT_LOG_ENTRY_TYPES.NODE_NEW) {
      return createNodeChatEntry(entry.node ?? resolveNodeForLogEntry(entry) ?? null, entry?.ts ?? null);
    }
    const context = buildDisplayContext(entry);
    switch (entry.type) {
      case CHAT_LOG_ENTRY_TYPES.NODE_INFO:
        return createNodeInfoChatEntry(entry, context);
      case CHAT_LOG_ENTRY_TYPES.TELEMETRY:
        return createTelemetryChatEntry(entry, context);
      case CHAT_LOG_ENTRY_TYPES.POSITION:
        return createPositionChatEntry(entry, context);
      case CHAT_LOG_ENTRY_TYPES.NEIGHBOR:
        return createNeighborChatEntry(entry, context);
      case CHAT_LOG_ENTRY_TYPES.MESSAGE_ENCRYPTED:
        return entry?.message ? createMessageChatEntry(entry.message) : null;
      default:
        return null;
    }
  }

  /**
   * Create a consistently formatted chat log entry for node-centric events.
   *
   * @param {{
   *   timestampSeconds: ?number,
   *   shortName: ?string,
   *   longName: ?string,
   *   role: ?string,
   *   metadataSource: Object|null,
   *   nodeData: Object|null,
   *   messageHtml: string
   * }} params Rendering parameters.
   * @returns {HTMLElement} Chat log element.
   */
  function createAnnouncementEntry({
    timestampSeconds,
    shortName,
    longName,
    role,
    metadataSource,
    nodeData,
    messageHtml
  }) {
    const div = document.createElement('div');
    const tsDate = timestampSeconds != null ? new Date(timestampSeconds * 1000) : null;
    const ts = tsDate ? formatTime(tsDate) : '--:--:--';
    const metadata = extractChatMessageMetadata(metadataSource || nodeData || {});
    const prefix = formatNodeAnnouncementPrefix({
      timestamp: escapeHtml(ts),
      frequency: metadata.frequency ? escapeHtml(metadata.frequency) : ''
    });
    const presetTag = formatChatPresetTag({ presetCode: metadata.presetCode });
    const longNameDisplay = longName != null ? String(longName) : '';
    const shortHtml = renderShortHtml(shortName, role, longNameDisplay, nodeData || metadataSource || {});
    div.className = 'chat-entry-node';
    div.innerHTML = `${prefix}${presetTag} ${shortHtml} ${messageHtml}`;
    return div;
  }

  /**
   * Derive display context for a chat log entry by inspecting node payloads.
   *
   * @param {Object} entry Chat log entry payload.
   * @returns {{
   *   nodeId: ?string,
   *   nodeNum: ?number,
   *   shortName: ?string,
   *   longName: ?string,
   *   role: ?string,
   *   metadataSource: Object|null,
   *   nodeData: Object|null
   * }} Normalised display metadata.
   */
  function buildDisplayContext(entry) {
    const resolvedNode = resolveNodeForLogEntry(entry);
    const candidateSources = [resolvedNode, entry?.node, entry?.telemetry, entry?.position, entry?.neighbor]
      .filter(source => source && typeof source === 'object');
    const nodeId = typeof entry?.nodeId === 'string' && entry.nodeId.trim().length
      ? entry.nodeId.trim()
      : pickFirstProperty(candidateSources, ['node_id', 'nodeId']);
    const nodeNum = Number.isFinite(entry?.nodeNum)
      ? entry.nodeNum
      : pickNumericProperty(candidateSources, ['node_num', 'nodeNum', 'num']);
    let shortName = pickFirstProperty(candidateSources, ['short_name', 'shortName']);
    if ((!shortName || String(shortName).trim().length === 0) && nodeId) {
      shortName = nodeId.slice(-4);
    }
    let longName = pickFirstProperty(candidateSources, ['long_name', 'longName']);
    if ((!longName || String(longName).trim().length === 0) && nodeId) {
      longName = nodeId;
    }
    const role = pickFirstProperty(candidateSources, ['role']);
    const metadataSource = resolvedNode || candidateSources[0] || {};
    const nodeData = resolvedNode || candidateSources[0] || {};
    return { nodeId, nodeNum, shortName, longName, role, metadataSource, nodeData };
  }

  /**
   * Locate the canonical node object associated with a chat log entry.
   *
   * @param {Object} entry Chat log entry payload.
   * @returns {?Object} Matched node payload when available.
   */
  function resolveNodeForLogEntry(entry) {
    if (!entry || typeof entry !== 'object') return null;
    if (entry.node && typeof entry.node === 'object') {
      return entry.node;
    }
    const idCandidates = [];
    if (typeof entry?.nodeId === 'string') {
      idCandidates.push(entry.nodeId);
    }
    for (const source of [entry?.node, entry?.telemetry, entry?.position, entry?.neighbor]) {
      const candidate = pickFirstProperty([source], ['node_id', 'nodeId']);
      if (candidate) {
        idCandidates.push(candidate);
      }
    }
    for (const rawId of idCandidates) {
      const trimmed = typeof rawId === 'string' ? rawId.trim() : String(rawId);
      if (trimmed && nodesById.has(trimmed)) {
        return nodesById.get(trimmed);
      }
    }
    const numCandidates = [];
    if (Number.isFinite(entry?.nodeNum)) {
      numCandidates.push(entry.nodeNum);
    }
    for (const source of [entry?.node, entry?.telemetry, entry?.position, entry?.neighbor]) {
      const candidate = pickNumericProperty([source], ['node_num', 'nodeNum', 'num']);
      if (Number.isFinite(candidate)) {
        numCandidates.push(candidate);
      }
    }
    for (const num of numCandidates) {
      if (Number.isFinite(num) && nodesByNum.has(num)) {
        return nodesByNum.get(num);
      }
    }
    return null;
  }

  /**
   * Retrieve the first present property value from a collection of objects.
   *
   * @param {Array<Object>} sources Candidate objects.
   * @param {Array<string>} keys Ordered property names to inspect.
   * @returns {*} First present non-blank value or ``null`` when absent.
   */
  function pickFirstProperty(sources, keys) {
    if (!Array.isArray(sources) || !Array.isArray(keys)) {
      return null;
    }
    for (const source of sources) {
      if (!source || typeof source !== 'object') continue;
      for (const key of keys) {
        if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
        const value = source[key];
        if (value == null) continue;
        if (typeof value === 'string') {
          const trimmed = value.trim();
          if (trimmed.length === 0) {
            continue;
          }
          return trimmed;
        }
        return value;
      }
    }
    return null;
  }

  /**
   * Retrieve the first finite numeric property from candidate objects.
   *
   * @param {Array<Object>} sources Candidate objects.
   * @param {Array<string>} keys Ordered property names to inspect.
   * @returns {?number} First finite number when available.
   */
  function pickNumericProperty(sources, keys) {
    if (!Array.isArray(sources) || !Array.isArray(keys)) {
      return null;
    }
    for (const source of sources) {
      if (!source || typeof source !== 'object') continue;
      for (const key of keys) {
        if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
        const raw = source[key];
        if (raw == null || raw === '') continue;
        const num = typeof raw === 'number' ? raw : Number(raw);
        if (Number.isFinite(num)) {
          return num;
        }
      }
    }
    return null;
  }

  /**
   * Describe an encrypted message when the payload cannot be decrypted.
   *
   * @param {Object} message Raw message payload.
   * @returns {{content: string, isHtml: boolean}} Renderable notice payload.
   */
  function formatEncryptedMessageNotice(message) {
    const recipient = pickFirstProperty([message], ['to_id', 'toId']);
    const recipientText = recipient != null && recipient !== ''
      ? String(recipient).trim()
      : '';
    if (recipientText && recipientText.toLowerCase() !== '^all') {
      const targetNode = resolveRecipientNode(recipientText);
      if (targetNode) {
        const badge = renderShortHtml(
          targetNode.short_name ?? targetNode.shortName,
          targetNode.role,
          targetNode.long_name ?? targetNode.longName,
          targetNode
        );
        const idSpan = `<span class="mono">${escapeHtml(recipientText)}</span>`;
        return { content: `🔒 encrypted message to ${badge} ${idSpan}`, isHtml: true };
      }
      return { content: `🔒 encrypted message to ${recipientText}`, isHtml: false };
    }

    const channelCandidate = pickFirstProperty([message], ['channel', 'channel_index', 'channelIndex']);
    let channelLabel = null;
    if (channelCandidate != null && channelCandidate !== '') {
      if (typeof channelCandidate === 'number' && Number.isFinite(channelCandidate)) {
        channelLabel = String(Math.round(channelCandidate));
      } else {
        const trimmedChannel = String(channelCandidate).trim();
        if (trimmedChannel.length > 0) {
          const numericChannel = Number(trimmedChannel);
          channelLabel = Number.isFinite(numericChannel) ? String(Math.round(numericChannel)) : trimmedChannel;
        }
      }
    }

    if (!channelLabel) {
      const channelName = pickFirstProperty([message], ['channel_name', 'channelName']);
      if (channelName != null) {
        const trimmedName = String(channelName).trim();
        if (trimmedName.length > 0) {
          channelLabel = trimmedName;
        }
      }
    }

    if (!channelLabel) {
      channelLabel = 'unknown channel';
    }

    return { content: `🔒 encrypted message on channel ${channelLabel}`, isHtml: false };
  }

  /**
   * Resolve a recipient node using identifier or numeric references.
   *
   * @param {string} recipientId Target node reference.
   * @returns {?Object} Node metadata when available.
   */
  function resolveRecipientNode(recipientId) {
    if (typeof recipientId !== 'string' || recipientId.length === 0) {
      return null;
    }

    if (nodesById instanceof Map && nodesById.size > 0) {
      const direct = nodesById.get(recipientId);
      if (direct) {
        return direct;
      }
    }

    if (nodesByNum instanceof Map && nodesByNum.size > 0) {
      const decimal = Number(recipientId);
      if (Number.isFinite(decimal) && nodesByNum.has(decimal)) {
        return nodesByNum.get(decimal);
      }
      if (/^0x[0-9a-f]+$/i.test(recipientId)) {
        const hexValue = Number.parseInt(recipientId, 16);
        if (Number.isFinite(hexValue) && nodesByNum.has(hexValue)) {
          return nodesByNum.get(hexValue);
        }
      }
    }

    return null;
  }

  /**
   * Build a chat log entry for a text message.
   *
   * @param {Object} m Message payload.
   * @returns {HTMLElement} Chat log element.
   */
  function createMessageChatEntry(m) {
    const div = document.createElement('div');
    const tsSeconds = resolveTimestampSeconds(
      m.rx_time ?? m.rxTime,
      m.rx_iso ?? m.rxIso
    );
    const tsDate = tsSeconds != null ? new Date(tsSeconds * 1000) : null;
    const ts = tsDate ? formatTime(tsDate) : '--:--:--';
    const short = renderShortHtml(m.node?.short_name, m.node?.role, m.node?.long_name, m.node);
    const replyPrefix = resolveReplyPrefix({
      message: m,
      messagesById,
      nodesById,
      renderShortHtml,
      escapeHtml
    });

    let messageBodyHtml = '';
    if (m && m.encrypted) {
      const notice = formatEncryptedMessageNotice(m);
      if (notice && typeof notice === 'object') {
        const content = notice.content ?? '';
        messageBodyHtml = notice.isHtml ? content : escapeHtml(content);
      } else {
        messageBodyHtml = '';
      }
    } else {
      messageBodyHtml = buildMessageBody({
        message: m || {},
        escapeHtml,
        renderEmojiHtml
      });
    }

    const combinedSegments = [];
    if (replyPrefix) combinedSegments.push(replyPrefix);
    if (messageBodyHtml) combinedSegments.push(messageBodyHtml);
    const text = combinedSegments.length > 0 ? combinedSegments.join(' ') : '';
    const metadata = extractChatMessageMetadata(m);
    const prefix = formatChatMessagePrefix({
      timestamp: escapeHtml(ts),
      frequency: metadata.frequency ? escapeHtml(metadata.frequency) : ''
    });
    const presetTag = formatChatPresetTag({ presetCode: metadata.presetCode });
    div.className = 'chat-entry-msg';
    div.innerHTML = `${prefix}${presetTag} ${short} ${text}`;
    return div;
  }

  /**
   * Attach node context to chat log entries when identifier metadata exists.
   *
   * @param {Array<Object>} entries Chat log entries.
   * @returns {Array<Object>} Enriched entries.
   */
  function attachNodeContextToLogEntries(entries) {
    if (!Array.isArray(entries) || entries.length === 0) {
      return Array.isArray(entries) ? entries : [];
    }
    return entries.map(entry => {
      if (!entry || typeof entry !== 'object') {
        return entry;
      }
      const hasNode = entry.node && typeof entry.node === 'object';
      const hasNeighborNode = entry.neighborNode && typeof entry.neighborNode === 'object';
      const resolvedNode = hasNode ? entry.node : resolveNodeForLogEntryContext(entry);
      const resolvedNeighbor = hasNeighborNode ? entry.neighborNode : resolveNeighborForLogEntry(entry);
      if (resolvedNode === entry.node && resolvedNeighbor === entry.neighborNode) {
        return entry;
      }
      const enriched = { ...entry };
      if (resolvedNode && !hasNode) {
        enriched.node = resolvedNode;
      }
      if (resolvedNeighbor && !hasNeighborNode) {
        enriched.neighborNode = resolvedNeighbor;
      }
      return enriched;
    });
  }

  /**
   * Locate the canonical node associated with a chat log entry for filtering.
   *
   * @param {Object} entry Chat log entry.
   * @returns {?Object} Node payload when available.
   */
  function resolveNodeForLogEntryContext(entry) {
    if (!entry || typeof entry !== 'object') {
      return null;
    }
    if (nodesById instanceof Map && typeof entry.nodeId === 'string' && nodesById.has(entry.nodeId)) {
      return nodesById.get(entry.nodeId);
    }
    if (nodesByNum instanceof Map && Number.isFinite(entry.nodeNum) && nodesByNum.has(entry.nodeNum)) {
      return nodesByNum.get(entry.nodeNum);
    }
    return null;
  }

  /**
   * Locate the neighbor node metadata for a chat log entry when available.
   *
   * @param {Object} entry Chat log entry.
   * @returns {?Object} Neighbor node payload when available.
   */
  function resolveNeighborForLogEntry(entry) {
    if (!entry || typeof entry !== 'object' || !(nodesById instanceof Map)) {
      return null;
    }
    const neighborId = typeof entry.neighborId === 'string' ? entry.neighborId : null;
    if (neighborId && nodesById.has(neighborId)) {
      return nodesById.get(neighborId);
    }
    return null;
  }

  /**
   * Render the chat history panel with nodes and messages.
   *
   * @param {{
   *   nodes?: Array<Object>,
   *   messages?: Array<Object>,
   *   encryptedMessages?: Array<Object>,
   *   telemetryEntries?: Array<Object>,
   *   positionEntries?: Array<Object>,
   *   neighborEntries?: Array<Object>,
   *   filterQuery?: string
   * }} params Render inputs.
   * @returns {void}
   */
  function renderChatLog({
    nodes = [],
    messages = [],
    encryptedMessages = [],
    telemetryEntries = [],
    positionEntries = [],
    neighborEntries = [],
    filterQuery = ''
  }) {
    if (!CHAT_ENABLED || !chatEl) return;
    const combinedMessages = Array.isArray(messages) ? [...messages] : [];
    if (Array.isArray(encryptedMessages) && encryptedMessages.length > 0) {
      combinedMessages.push(...encryptedMessages);
    }
    messagesById = buildMessageIndex(combinedMessages);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const { logEntries, channels } = buildChatTabModel({
      nodes,
      telemetry: telemetryEntries,
      positions: positionEntries,
      neighbors: neighborEntries,
      messages,
      logOnlyMessages: encryptedMessages,
      nowSeconds,
      windowSeconds: CHAT_RECENT_WINDOW_SECONDS,
      maxChannelIndex: MAX_CHANNEL_INDEX,
      primaryChannelFallbackLabel: config.channel
    });

    const enrichedLogEntries = attachNodeContextToLogEntries(logEntries);
    const { logEntries: filteredLogEntries, channels: filteredChannels } = filterChatModel(
      { logEntries: enrichedLogEntries, channels },
      filterQuery
    );

    const logContent = buildChatFragment({
      entries: filteredLogEntries,
      renderEntry: createChatLogEntry,
      emptyLabel: 'No recent mesh activity.'
    });

    const channelTabs = filteredChannels.map(channel => ({
      id: channel.id || `channel-${channel.index}`,
      label: channel.label,
      content: buildChatFragment({
        entries: channel.entries.map(e => ({ ts: e.ts, item: e.message })),
        renderEntry: entry => createMessageChatEntry(entry.item),
        emptyLabel: 'No messages on this channel.'
      }),
      index: channel.index,
      isPrimaryFallback: Boolean(channel.isPrimaryFallback)
    }));

    const tabs = [
      { id: 'log', label: 'Log', content: logContent },
      ...channelTabs
    ];

    const previousActive = chatEl.dataset?.activeTab || null;
    const defaultActive =
      channelTabs.find(tab => tab.isPrimaryFallback)?.id ||
      channelTabs.find(tab => tab.index === 0)?.id ||
      channelTabs[0]?.id ||
      'log';
    renderChatTabs({
      document,
      container: chatEl,
      tabs,
      previousActiveTabId: previousActive,
      defaultActiveTabId: defaultActive
    });
    scrollActiveChatPanelToBottom();
  }

  /**
   * Construct a document fragment for chat entries, inserting date dividers
   * and optional empty-state labels.
   *
   * @param {{
   *   entries: Array<{ ts: number, item: Object }>,
   *   renderEntry: Function,
   *   emptyLabel?: string
   * }} params Fragment construction parameters.
   * @returns {DocumentFragment} Populated fragment.
   */
  function buildChatFragment({ entries = [], renderEntry, emptyLabel }) {
    const fragment = document.createDocumentFragment();
    if (!entries || entries.length === 0) {
      if (emptyLabel) {
        const empty = document.createElement('p');
        empty.className = 'chat-empty';
        empty.textContent = emptyLabel;
        fragment.appendChild(empty);
      }
      return fragment;
    }
    const getDivider = createDateDividerFactory();
    const limitedEntries = entries.slice(Math.max(entries.length - CHAT_LIMIT, 0));
    for (const entry of limitedEntries) {
      if (!entry || typeof entry.ts !== 'number') {
        continue;
      }
      const divider = getDivider(entry.ts);
      if (divider) fragment.appendChild(divider);
      if (typeof renderEntry === 'function') {
        const node = renderEntry(entry);
        if (node) {
          fragment.appendChild(node);
        }
      }
    }
    return fragment;
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
   * Compute the node detail path for a given identifier.
   *
   * @param {string|null} identifier Node identifier.
   * @returns {string|null} Detail path.
   */
  function buildNodeDetailHref(identifier) {
    if (identifier == null) return null;
    const trimmed = String(identifier).trim();
    if (!trimmed) return null;
    const body = trimmed.startsWith('!') ? trimmed.slice(1) : trimmed;
    if (!body) return null;
    const encoded = encodeURIComponent(body);
    return `/nodes/!${encoded}`;
  }

  /**
   * Ensure ``identifier`` includes the canonical ``!`` prefix.
   *
   * @param {*} identifier Candidate identifier.
   * @returns {string|null} Canonical identifier or ``null``.
   */
  function canonicalNodeIdentifier(identifier) {
    if (identifier == null) return null;
    const trimmed = String(identifier).trim();
    if (!trimmed) return null;
    return trimmed.startsWith('!') ? trimmed : `!${trimmed}`;
  }

  /**
   * Render a linked long name pointing to the node detail view.
   *
   * @param {string|null} longName Display name.
   * @param {string|null} identifier Node identifier.
   * @param {string} [className='node-long-link'] Optional class attribute.
   * @returns {string} Escaped HTML snippet.
   */
  function renderNodeLongNameLink(longName, identifier, className = 'node-long-link') {
    const text = normalizeNodeNameValue(longName);
    if (!text) return '';
    const href = buildNodeDetailHref(identifier);
    if (!href) {
      return escapeHtml(text);
    }
    const classAttr = className ? ` class="${escapeHtml(className)}"` : '';
    const canonicalIdentifier = canonicalNodeIdentifier(identifier);
    const dataAttrs = canonicalIdentifier
      ? ` data-node-detail-link="true" data-node-id="${escapeHtml(canonicalIdentifier)}"`
      : ' data-node-detail-link="true"';
    return `<a${classAttr} href="${href}"${dataAttrs}>${escapeHtml(text)}</a>`;
  }

  /**
   * Determine whether a long name link should trigger the overlay behaviour.
   *
   * @param {?Element} link Anchor element.
   * @returns {boolean} ``true`` when the link participates in overlays.
   */
  function shouldHandleNodeLongLink(link) {
    if (!link || !link.dataset) return false;
    if ('nodeDetailLink' in link.dataset && link.dataset.nodeDetailLink === 'false') {
      return false;
    }
    return true;
  }

  /**
   * Extract the canonical node identifier from the provided link element.
   *
   * @param {?Element} link Anchor element.
   * @returns {string} Canonical node identifier or ``''`` when unavailable.
   */
  function getNodeIdentifierFromLink(link) {
    if (!link) return '';
    const datasetIdentifier = link.dataset && typeof link.dataset.nodeId === 'string'
      ? canonicalNodeIdentifier(link.dataset.nodeId)
      : null;
    if (datasetIdentifier) {
      return datasetIdentifier;
    }
    if (typeof link.getAttribute === 'function') {
      const attrHref = link.getAttribute('href');
      const canonicalFromAttr = extractIdentifierFromHref(attrHref);
      if (canonicalFromAttr) {
        return canonicalFromAttr;
      }
    }
    if (typeof link.href === 'string') {
      const canonicalFromProperty = extractIdentifierFromHref(link.href);
      if (canonicalFromProperty) {
        return canonicalFromProperty;
      }
    }
    return '';
  }

  /**
   * Extract the canonical identifier from a node detail hyperlink.
   *
   * @param {string} href Link href attribute.
   * @returns {string} Canonical identifier or ``''``.
   */
  function extractIdentifierFromHref(href) {
    if (typeof href !== 'string' || href.length === 0) {
      return '';
    }
    const match = href.match(/\/nodes\/(![^/?#]+)/i);
    if (!match || !match[1]) {
      return '';
    }
    try {
      const decoded = decodeURIComponent(match[1]);
      return canonicalNodeIdentifier(decoded) ?? '';
    } catch {
      return canonicalNodeIdentifier(match[1]) ?? '';
    }
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
   * Determine how many snapshots should be requested from the API to build a
   * richer aggregate.
   *
   * @param {number} requestedLimit Desired number of unique entities.
   * @param {number} [maxLimit=NODE_LIMIT] Maximum rows accepted by the API.
   * @returns {number} Effective request limit honouring {@link SNAPSHOT_LIMIT}.
   */
  function resolveSnapshotLimit(requestedLimit, maxLimit = NODE_LIMIT) {
    const base = Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.floor(requestedLimit)
      : maxLimit;
    const expanded = base * SNAPSHOT_LIMIT;
    const candidate = expanded > base ? expanded : base;
    return Math.min(candidate, maxLimit);
  }

  /**
   * Fetch the latest nodes from the JSON API.
   *
   * @param {number} [limit=NODE_LIMIT] Maximum number of records.
   * @returns {Promise<Array<Object>>} Parsed node payloads.
   */
  async function fetchNodes(limit = NODE_LIMIT) {
    const effectiveLimit = resolveSnapshotLimit(limit, NODE_LIMIT);
    const r = await fetch(`/api/nodes?limit=${effectiveLimit}`, { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  /**
   * Retrieve a single node record by identifier from the API.
   *
   * @param {string} nodeId Canonical node identifier.
   * @returns {Promise<Object|null>} Parsed node payload or null when absent.
   */
  async function fetchNodeById(nodeId) {
    if (typeof nodeId !== 'string') return null;
    const trimmed = nodeId.trim();
    if (trimmed.length === 0) return null;
    const r = await fetch(`/api/nodes/${encodeURIComponent(trimmed)}`, { cache: 'no-store' });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  /**
   * Fetch recent messages from the JSON API.
   *
   * @param {number} [limit=NODE_LIMIT] Maximum number of rows.
   * @param {{ encrypted?: boolean }} [options] Optional retrieval flags.
   * @returns {Promise<Array<Object>>} Parsed message payloads.
   */
  async function fetchMessages(limit = MESSAGE_LIMIT, options = {}) {
    if (!CHAT_ENABLED) return [];
    const safeLimit = normaliseMessageLimit(limit);
    const params = new URLSearchParams({ limit: String(safeLimit) });
    if (options && options.encrypted) {
      params.set('encrypted', 'true');
    }
    const query = params.toString();
    const r = await fetch(`/api/messages?${query}`, { cache: 'no-store' });
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
    const effectiveLimit = resolveSnapshotLimit(limit, NODE_LIMIT);
    const r = await fetch(`/api/neighbors?limit=${effectiveLimit}`, { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  /**
   * Fetch traceroute observations from the JSON API.
   *
   * @param {number} [limit=TRACE_LIMIT] Maximum number of records.
   * @returns {Promise<Array<Object>>} Parsed trace payloads.
   */
  async function fetchTraces(limit = TRACE_LIMIT) {
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : TRACE_LIMIT;
    const effectiveLimit = Math.min(safeLimit, NODE_LIMIT);
    const r = await fetch(`/api/traces?limit=${effectiveLimit}`, { cache: 'no-store' });
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
    const effectiveLimit = resolveSnapshotLimit(limit, NODE_LIMIT);
    const r = await fetch(`/api/telemetry?limit=${effectiveLimit}`, { cache: 'no-store' });
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
    const effectiveLimit = resolveSnapshotLimit(limit, NODE_LIMIT);
    const r = await fetch(`/api/positions?limit=${effectiveLimit}`, { cache: 'no-store' });
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
    if (hasLeaflet && mapCenterLatLng && typeof mapCenterLatLng.distanceTo === 'function') {
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
    if (!tb) {
      overlayStack.cleanupOrphans();
      return;
    }
    const frag = document.createDocumentFragment();
    for (const n of nodes) {
      const tr = document.createElement('tr');
      const lastPositionTime = toFiniteNumber(n.position_time ?? n.positionTime);
      const lastPositionCell = lastPositionTime != null ? timeAgo(lastPositionTime, nowSec) : '';
      const latitudeDisplay = fmtCoords(n.latitude);
      const longitudeDisplay = fmtCoords(n.longitude);
      const nodeDisplayName = getNodeDisplayNameForOverlay(n);
      const modemMetadata = extractModemMetadata(n);
      const loraFrequencyText = formatLoraFrequencyMHz(modemMetadata.loraFreq);
      const loraFrequencyDisplay = loraFrequencyText ? escapeHtml(loraFrequencyText) : '';
      const modemPresetDisplay = modemMetadata.modemPreset ? escapeHtml(modemMetadata.modemPreset) : '';
      const longNameHtml = renderNodeLongNameLink(n.long_name, n.node_id);
      tr.innerHTML = `
        <td class="mono nodes-col nodes-col--node-id">${n.node_id || ""}</td>
        <td class="nodes-col nodes-col--short-name">${renderShortHtml(n.short_name, n.role, n.long_name, n)}</td>
        <td class="nodes-col nodes-col--long-name">${longNameHtml}</td>
        <td class="nodes-col nodes-col--frequency">${loraFrequencyDisplay}</td>
        <td class="nodes-col nodes-col--modem-preset">${modemPresetDisplay}</td>
        <td class="nodes-col nodes-col--last-seen">${timeAgo(n.last_heard, nowSec)}</td>
        <td class="nodes-col nodes-col--role">${n.role || "CLIENT"}</td>
        <td class="nodes-col nodes-col--hw-model">${fmtHw(n.hw_model)}</td>
        <td class="nodes-col nodes-col--battery">${fmtAlt(n.battery_level, "%")}</td>
        <td class="nodes-col nodes-col--voltage">${fmtAlt(n.voltage, "V")}</td>
        <td class="nodes-col nodes-col--uptime">${timeHum(n.uptime_seconds)}</td>
        <td class="nodes-col nodes-col--channel-util">${fmtTx(n.channel_utilization)}</td>
        <td class="nodes-col nodes-col--air-util-tx">${fmtTx(n.air_util_tx)}</td>
        <td class="nodes-col nodes-col--temperature">${fmtTemperature(n.temperature)}</td>
        <td class="nodes-col nodes-col--humidity">${fmtHumidity(n.relative_humidity)}</td>
        <td class="nodes-col nodes-col--pressure">${fmtPressure(n.barometric_pressure)}</td>
        <td class="nodes-col nodes-col--latitude">${latitudeDisplay}</td>
        <td class="nodes-col nodes-col--longitude">${longitudeDisplay}</td>
        <td class="nodes-col nodes-col--altitude">${fmtAlt(n.altitude, "m")}</td>
        <td class="mono nodes-col nodes-col--last-position">${lastPositionCell}</td>`;

      enhanceCoordinateCell({
        cell: tr.querySelector('.nodes-col--latitude'),
        document,
        displayText: latitudeDisplay,
        formattedLatitude: latitudeDisplay,
        formattedLongitude: longitudeDisplay,
        lat: n.latitude,
        lon: n.longitude,
        nodeName: nodeDisplayName,
        onActivate: focusMapOnCoordinates
      });
      enhanceCoordinateCell({
        cell: tr.querySelector('.nodes-col--longitude'),
        document,
        displayText: longitudeDisplay,
        formattedLatitude: latitudeDisplay,
        formattedLongitude: longitudeDisplay,
        lat: n.latitude,
        lon: n.longitude,
        nodeName: nodeDisplayName,
        onActivate: focusMapOnCoordinates
      });
      frag.appendChild(tr);
    }
    tb.replaceChildren(frag);
    overlayStack.cleanupOrphans();
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
    const traceSegments = neighborLinesLayer
      ? buildTraceSegments(allTraces, nodes, {
          limitDistance: LIMIT_DISTANCE,
          maxDistanceKm: MAX_DISTANCE_KM,
          colorForNode: node => getRoleColor(node.role)
        })
      : [];

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
              if (overlayStack.isOpen(anchorEl)) {
                overlayStack.close(anchorEl);
                return;
              }
              openNeighborOverlay(anchorEl, segment);
            });
          }
        });
    }

    if (neighborLinesLayer && traceSegments.length) {
      traceSegments
        .sort((a, b) => {
          const rxA = Number.isFinite(a.rxTime) ? a.rxTime : -Infinity;
          const rxB = Number.isFinite(b.rxTime) ? b.rxTime : -Infinity;
          if (rxA === rxB) return 0;
          return rxA - rxB;
        })
        .forEach(segment => {
          L.polyline(segment.latlngs, {
            color: segment.color,
            weight: 2,
            opacity: 0.42,
            dashArray: '6 6',
            className: 'neighbor-connection-line trace-connection-line'
          }).addTo(neighborLinesLayer);
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
      let markerToken = 0;
      marker.addTo(markersLayer);
      pts.push([lat, lon]);

      attachNodeInfoRefreshToMarker({
        marker,
        getOverlayFallback: fallbackOverlayProvider,
        refreshNodeInformation,
        mergeOverlayDetails,
        createRequestToken: anchor => {
          if (anchor) {
            return overlayStack.incrementRequestToken(anchor);
          }
          markerToken += 1;
          return markerToken;
        },
        isTokenCurrent: (anchor, token) => {
          if (anchor) {
            return overlayStack.isTokenCurrent(anchor, token);
          }
          return token === markerToken;
        },
        showLoading: (anchor, info) => {
          if (anchor) {
            showShortInfoLoading(anchor, info);
          }
        },
        showDetails: (anchor, info) => {
          if (anchor) {
            closeUnrelatedShortOverlays(anchor);
            openShortInfoOverlay(anchor, info);
          }
        },
        showError: (anchor, info, error) => {
          console.warn('Failed to refresh node information for map marker', error);
          if (anchor) {
            closeUnrelatedShortOverlays(anchor);
            openShortInfoOverlay(anchor, info);
          }
        },
        shouldHandleClick: anchor => {
          if (!anchor) return true;
          if (overlayStack.isOpen(anchor)) {
            overlayStack.close(anchor);
            return false;
          }
          return true;
        },
      });
    }
    if (pts.length && fitBoundsEl && fitBoundsEl.checked) {
      const bounds = computeBoundsForPoints(pts, { ...autoFitBoundsConfig });
      fitMapToBounds(bounds, { animate: false, paddingPx: AUTO_FIT_PADDING_PX });
    }
    overlayStack.cleanupOrphans();
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
    const filterQuery = filterInput ? filterInput.value : '';
    const q = normaliseChatFilterQuery(filterQuery);
    const filteredNodes = allNodes.filter(n => matchesTextFilter(n, q) && matchesRoleFilter(n));
    const sortedNodes = sortNodes(filteredNodes);
    const nowSec = Date.now()/1000;
    renderTable(sortedNodes, nowSec);
    renderMap(sortedNodes, nowSec);
    updateCount(sortedNodes, nowSec);
    updateRefreshInfo(sortedNodes, nowSec);
    updateSortIndicators();
    renderChatLog({
      nodes: allNodes,
      messages: allMessages,
      encryptedMessages: allEncryptedMessages,
      telemetryEntries: allTelemetryEntries,
      positionEntries: allPositionEntries,
      neighborEntries: allNeighbors,
      filterQuery
    });
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
      if (statusEl) {
        statusEl.textContent = 'refreshing…';
      }
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
      const tracesPromise = fetchTraces().catch(err => {
        console.warn('trace refresh failed; continuing without traceroutes', err);
        return [];
      });
      const encryptedMessagesPromise = fetchMessages(MESSAGE_LIMIT, { encrypted: true }).catch(err => {
        console.warn('encrypted message refresh failed; continuing without encrypted entries', err);
        return [];
      });
      const [
        nodes,
        positions,
        neighborTuples,
        traceEntries,
        messages,
        telemetryEntries,
        encryptedMessages
      ] = await Promise.all([
        fetchNodes(),
        positionsPromise,
        neighborPromise,
        tracesPromise,
        fetchMessages(MESSAGE_LIMIT),
        telemetryPromise,
        encryptedMessagesPromise
      ]);
      const aggregatedNodes = aggregateNodeSnapshots(nodes);
      const aggregatedPositions = aggregatePositionSnapshots(positions);
      const aggregatedNeighbors = aggregateNeighborSnapshots(neighborTuples);
      const aggregatedTelemetry = aggregateTelemetrySnapshots(telemetryEntries);
      aggregatedNodes.forEach(applyNodeNameFallback);
      mergePositionsIntoNodes(aggregatedNodes, aggregatedPositions);
      computeDistances(aggregatedNodes);
      mergeTelemetryIntoNodes(aggregatedNodes, aggregatedTelemetry);
      normalizeNodeCollection(aggregatedNodes);
      allNodes = aggregatedNodes;
      rebuildNodeIndex(allNodes);
      const [chatMessages, encryptedChatMessages] = await Promise.all([
        messageNodeHydrator.hydrate(messages, nodesById),
        messageNodeHydrator.hydrate(encryptedMessages, nodesById)
      ]);
      allMessages = Array.isArray(chatMessages) ? chatMessages : [];
      allEncryptedMessages = Array.isArray(encryptedChatMessages) ? encryptedChatMessages : [];
      allTelemetryEntries = aggregatedTelemetry;
      allPositionEntries = aggregatedPositions;
      allNeighbors = aggregatedNeighbors;
      allTraces = Array.isArray(traceEntries) ? traceEntries : [];
      applyFilter();
      if (statusEl) {
        statusEl.textContent = 'updated ' + new Date().toLocaleTimeString();
      }
    } catch (e) {
      if (statusEl) {
        statusEl.textContent = 'error: ' + e.message;
      }
      console.error(e);
    }
  }

  refresh();
  restartAutoRefresh();
  if (refreshBtn) {
    refreshBtn.addEventListener('click', refresh);
  }

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
    if (!refreshInfo || !isDashboardView) {
      return;
    }
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
