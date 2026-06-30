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

// Import from submodules — functions remain locally usable inside this file
// and are also re-exported so existing callers of './main.js' keep working.
import {
  computeLocalActiveNodeStats,
  normaliseActiveNodeStatsPayload,
  fetchActiveNodeStats,
  formatActiveNodeStatsText,
} from './stats.js';
export {
  computeLocalActiveNodeStats,
  normaliseActiveNodeStatsPayload,
  fetchActiveNodeStats,
  formatActiveNodeStatsText,
};

import {
  normalizeNodeNameValue,
  buildNodeDetailHref,
  canonicalNodeIdentifier,
  renderNodeLongNameLink,
} from './node-rendering.js';
export {
  normalizeNodeNameValue,
  buildNodeDetailHref,
  canonicalNodeIdentifier,
  renderNodeLongNameLink,
};

import { escapeHtml } from './utils.js';
export { escapeHtml };

import { computeBoundingBox, computeBoundsForPoints, haversineDistanceKm } from './map-bounds.js';
import {
  buildRenderableEntries,
  computeColocatedOffsets,
  isOffsetSignificant,
  refreshSpiderPositions
} from './map-colocated-offset.js';
import { createMapAutoFitController } from './map-auto-fit-controller.js';
import { resolveAutoFitBoundsConfig } from './map-auto-fit-settings.js';
import { attachNodeInfoRefreshToMarker, overlayToPopupNode } from './map-marker-node-info.js';
import { resolveLegendVisibility } from './map-legend-visibility.js';
import { createMapFocusHandler, DEFAULT_NODE_FOCUS_ZOOM } from './nodes-map-focus.js';
import { createMapCenterResetHandler } from './map-center-reset.js';
import { enhanceCoordinateCell } from './nodes-coordinate-links.js';
import { createShortInfoOverlayStack } from './short-info-overlay-manager.js';
import { createNodeDetailOverlayManager } from './node-detail-overlay.js';
import { refreshNodeInformation } from './node-details.js';
import { extractModemMetadata, formatLoraFrequencyMHz, formatModemDisplay, formatPresetDisplay } from './node-modem-metadata.js';
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
import { renderSatsInViewBadge } from './short-info-satellites.js';
import { createMessageNodeHydrator } from './message-node-hydrator.js';
import {
  extractChatMessageMetadata,
  formatChatMessagePrefix,
  formatNodeAnnouncementPrefix,
  formatChatPresetTag
} from './chat-format.js';
import { initializeInstanceSelector } from './instance-selector.js';
import { initializeMobileMenu } from './mobile-menu.js';
import { MESSAGE_LIMIT, normaliseMessageLimit } from './message-limit.js';
import { CHAT_LOG_ENTRY_TYPES, buildChatTabModel, MAX_CHANNEL_INDEX } from './chat-log-tabs.js';
import { renderChatTabs } from './chat-tabs.js';
import { createChatEntryCache } from './main/chat-entry-cache.js';
import { chatMessageEntryKey, chatLogEntryKey } from './main/chat-entry-keys.js';
import { createDataCache, CACHE_SCHEMA_VERSION } from './main/data-cache.js';
import { createIndexedDbBackend } from './main/data-cache-idb.js';
import { isExpired as isCacheEntryExpired, isStale as isCacheEntryStale } from './main/cache-lifetime.js';
import { cacheKeyFor } from './main/cache-keys.js';
import { formatPositionHighlights, formatTelemetryHighlights } from './chat-log-highlights.js';
import { filterChatModel, normaliseChatFilterQuery } from './chat-search.js';
import { buildMessageIndex } from './message-replies.js';
import { renderChatEntryContent } from './chat-entry-renderer.js';
import {
  SNAPSHOT_WINDOW,
  aggregateNodeSnapshots,
  aggregatePositionSnapshots,
  aggregateTelemetrySnapshots,
} from './snapshot-aggregator.js';
import { normalizeNodeCollection } from './node-snapshot-normalizer.js';
import { maxRecordTimestamp, minRecordTimestamp, mergeById, mergeByCompositeKey, trimToLimit, trimToWindow } from './incremental-helpers.js';
import { buildTraceSegments } from './trace-paths.js';
import {
  getRoleColor,
  getRoleFlashColor,
  getRoleKey,
  getRoleRenderPriority,
  getRoleTextColor,
  meshcoreRoleColors,
  normalizeRole,
  roleColors,
} from './role-helpers.js';
import {
  isMeshtasticProtocol,
  isMeshcoreProtocol,
  meshtasticIconHtml,
  MESHTASTIC_ICON_SRC,
  MESHCORE_ICON_SRC,
  protocolIconPrefixHtml,
} from './protocol-helpers.js';

// Pure helpers extracted into focused submodules under ``./main/``.  They
// remain locally callable inside ``initializeApp`` because module-level
// bindings are visible in every nested scope.
import {
  fmtCoords,
  fmtHw,
  formatDate,
  formatShortInfoUptime,
  formatSnrDisplay,
  formatTime,
  pad,
  parseNodeNumericRef,
  pickFirstProperty,
  pickNumericProperty,
  resolveTimestampSeconds,
  shortInfoValueOrDash,
  timeAgo,
  timeHum,
  toFiniteNumber,
} from './main/format-utils.js';
import {
  applyNodeNameFallback,
  buildNodePlaceholder,
  extractIdentifierFromHref,
  getNodeDisplayNameForOverlay,
  getNodeIdentifierFromLink,
  shouldHandleNodeLongLink,
} from './main/long-link-router.js';
import {
  buildTelemetryIndex,
  mergePositionsIntoNodes,
  mergeTelemetryIntoNodes,
} from './main/data-merge.js';
import { renderShortHtml } from './main/short-html-renderer.js';
import {
  NODE_LIMIT,
  SNAPSHOT_LIMIT,
  TRACE_LIMIT,
  TRACE_MAX_AGE_SECONDS,
  BOOT_CACHE_FLAG,
} from './main/constants.js';
import {
  fetchNeighbors,
  fetchNodes,
  fetchPositions,
  fetchTelemetry,
  fetchTraces,
  filterRecentTraces,
  resolveSnapshotLimit,
  fetchMessages as fetchMessagesImpl,
  paginateMessages as paginateMessagesImpl,
  paginateCollection,
} from './main/data-fetchers.js';
import {
  compareNumber,
  compareString,
  hasNumberValue,
  hasStringValue,
} from './main/sort-comparators.js';
import { makeRoleFilterKey, normalizeFilterProtocol } from './main/filter-helpers.js';
import { tileToLat, tileToLon } from './main/tile-coords.js';
import {
  buildMeshcoreIconImg,
  buildMeshtasticIconImg,
  buildProtocolIconImg,
} from './main/protocol-icons.js';
import { buildNeighborTooltipHtml, buildTraceTooltipHtml } from './main/tooltip-html.js';
import { createOfflineTileLayer as createOfflineTileLayerImpl } from './main/offline-tile-layer.js';
import { TILE_LAYER_URL, TILE_LAYER_OPTIONS } from './basemap-config.js';
import { createTileFailurePolicy } from './main/tile-failure-policy.js';
import { getActiveFullscreenElement, legendClickHandler } from './main/fullscreen-helpers.js';
import { createEventStream } from './main/event-stream.js';
import { flashNodeTargets, flashMessageTargets, emitNodeWaves } from './main/flash.js';
import { captureOpenMarkerOverlays, restoreMarkerOverlays } from './main/marker-overlay-preservation.js';
import { collectNodeIds, collectMessageIds, entryMessageId } from './main/flash-targets.js';

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
 *   maxDistanceKm: number
 * }} config Normalized application configuration.
 * @returns {{ _testUtils: Object }} Object whose ``_testUtils`` property exposes
 *   inner closures for unit tests. Production callers may ignore this.
 */
export function initializeApp(config) {
  const footerActiveNodes = document.getElementById('footerActiveNodes');
  const autorefreshToggle = document.getElementById('autorefreshToggle');
  const protocolToggleMeshcore = document.getElementById('protocolToggleMeshcore');
  const protocolToggleMeshtastic = document.getElementById('protocolToggleMeshtastic');
  const filterInput = document.getElementById('filterInput');
  const filterClearButton = document.getElementById('filterClear');
  const shortInfoTemplate = document.getElementById('shortInfoOverlayTemplate');
  const overlayStack = createShortInfoOverlayStack({ document, window, template: shortInfoTemplate });
  const titleEl = document.querySelector('title');
  const headerEl = document.querySelector('h1');
  const headerTitleTextEl = headerEl ? headerEl.querySelector('.site-title-text') : null;
  const chatEl = document.getElementById('chat');
  const instanceSelect = document.getElementById('instanceSelect');
  const baseTitle = document.title;
  const nodesTable = document.getElementById('nodes');
  const sortButtons = nodesTable ? Array.from(nodesTable.querySelectorAll('thead .sort-button[data-sort-key]')) : [];
  const bodyClassList = document.body ? document.body.classList : null;
  const isPrivateMode = document.body && document.body.dataset
    ? String(document.body.dataset.privateMode).toLowerCase() === 'true'
    : false;
  const isDashboardView = bodyClassList ? bodyClassList.contains('view-dashboard') : false;
  const isMapView = bodyClassList ? bodyClassList.contains('view-map') : false;
  const mapZoomOverride = Number.isFinite(config.mapZoom) ? Number(config.mapZoom) : null;

  initializeMobileMenu({ documentObject: document, windowObject: window });
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
  // No ``fetchNodeById`` is supplied, so the hydrator resolves senders purely
  // from the already-loaded bulk node map (``nodesById``) and renders an ``!id``
  // placeholder on a miss — it never issues per-node ``GET /api/nodes/:id``
  // requests, which used to storm the server with hundreds of round trips (many
  // 404s for RF-only nodes) on every cold load (issue: node hydration). A
  // deliberate, batched refresh path can opt back in by injecting a fetcher.
  const messageNodeHydrator = createMessageNodeHydrator({
    applyNodeFallback: applyNodeNameFallback,
    logger: console,
  });
  // Timestamps of the most recent record seen per data type.  Used to pass
  // the ``since`` query parameter on subsequent refreshes so only new/changed
  // rows are transferred over the wire.
  let lastNodeTimestamp = 0;
  let lastMessageTimestamp = 0;
  let lastPositionTimestamp = 0;
  let lastTelemetryTimestamp = 0;
  let lastNeighborTimestamp = 0;
  let lastTraceTimestamp = 0;
  /** Whether the very first full fetch has completed. */
  let initialFetchDone = false;
  /** Whether the background chat-history backfill is currently running. */
  let chatBackfillRunning = false;
  /** One-shot guard: the chat-history backfill runs once after the first load. */
  let chatHistoryBackfilled = false;
  /**
   * Oldest ``rx_time`` of the newest delta page (the "live frontier"). The
   * background backfill pages backward from here, not from the global-oldest
   * loaded row, so a warm-cache load bridges the gap between the newest page
   * and the seeded cache instead of paging below the cache and orphaning the
   * window in between. 0 until the first fetch; on a cold load it equals the
   * global-oldest, so the cold backfill is unchanged.
   */
  let chatLiveFrontier = 0;
  /** Settles when the one-shot chat-history backfill finishes (test hook). */
  let backfillPromise = Promise.resolve();
  /**
   * Live frontiers for the bulk collections (oldest cursor value of the newest
   * page) — the one-shot background backfill pages backward from here, exactly
   * like {@link chatLiveFrontier}. 0 means "no backfill" (a short newest page,
   * or a warm-cache load whose data is already seeded). Issue #832 / SPEC BP9a.
   * @type {{ nodes: number, positions: number, telemetry: number, neighbors: number, traces: number }}
   */
  let collectionLiveFrontiers = { nodes: 0, positions: 0, telemetry: 0, neighbors: 0, traces: 0 };
  /** One-shot guard: the bulk-collection backfill runs once after the first load. */
  let collectionsBackfilled = false;
  /** Settles when the one-shot bulk-collection backfill finishes (test hook). */
  let collectionBackfillPromise = Promise.resolve();

  // Persistent read-side cache (SPEC FC1–FC7). The IndexedDB backend is null
  // when storage is unavailable, and PRIVATE mode disables + wipes the cache —
  // either way ``createDataCache`` yields a no-op cache and the app falls back to
  // network-only behavior. ``cachedAt`` is stamped in unix seconds to match the
  // API's record timestamps (used by the lifetime helper).
  const dataCache = createDataCache({
    backend: createIndexedDbBackend(),
    schemaVersion: CACHE_SCHEMA_VERSION,
    instanceId: config.instanceDomain || '',
    isPrivate: isPrivateMode,
    now: () => Math.floor(Date.now() / 1000),
  });
  /** Unix-seconds of the last full cache write-back (throttle gate). */
  let lastCacheWriteSeconds = 0;
  /** Minimum seconds between full cache write-backs (the cache lags slightly). */
  const CACHE_WRITE_INTERVAL_SECONDS = 30;
  /** Settles when the most recent write-back's stores have flushed (test hook). */
  let pendingCacheWrite = Promise.resolve();

  /**
   * Record (in ``localStorage``, synchronously readable by the cold-load boot
   * prefetch) whether the persistent cache holds data. A warm marker makes the
   * next load skip the early prefetch and use the faster FC2 seed-then-delta
   * path; clearing it re-enables the cold prefetch. Best-effort — storage errors
   * are swallowed, since the prefetch degrades gracefully either way.
   *
   * @param {boolean} present Whether the cache now holds data.
   * @returns {void}
   */
  function setCachePresentFlag(present) {
    try {
      const store = typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
      if (!store) return;
      if (present) store.setItem(BOOT_CACHE_FLAG, '1');
      else store.removeItem(BOOT_CACHE_FLAG);
    } catch (error) {
      /* storage unavailable/blocked — the prefetch still degrades gracefully */
    }
  }

  /**
   * Persist a collection's current rows into the cache, fire-and-forget. The
   * cache is best-effort and never blocks rendering (FC7).
   *
   * @param {string} collection Cache collection name.
   * @param {Array<Object>} records Rows to persist.
   * @returns {void}
   */
  function cacheWriteCollection(collection, records) {
    if (!Array.isArray(records) || records.length === 0) return Promise.resolve();
    const entries = [];
    for (const record of records) {
      const key = cacheKeyFor(collection, record);
      if (key != null) entries.push({ key, value: record });
    }
    return entries.length > 0 ? dataCache.putAll(collection, entries) : Promise.resolve();
  }

  /**
   * Shallow-copy a chat message without its hydrated ``node`` so the cache stores
   * the raw row; the sender is re-resolved from the bulk node map on seed.
   *
   * @param {Object} message Hydrated chat message.
   * @returns {Object} Message copy without ``node``.
   */
  function messageForCache(message) {
    if (!message || typeof message !== 'object') return message;
    const copy = { ...message };
    delete copy.node;
    return copy;
  }

  /**
   * Throttled full write-back of the live dashboard state to the cache (SPEC
   * FC2). Runs at most once per {@link CACHE_WRITE_INTERVAL_SECONDS} (always on
   * the first successful refresh). No-op when the cache is disabled.
   *
   * @returns {void}
   */
  function writeBackCache() {
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (lastCacheWriteSeconds && nowSeconds - lastCacheWriteSeconds < CACHE_WRITE_INTERVAL_SECONDS) {
      return;
    }
    lastCacheWriteSeconds = nowSeconds;
    pendingCacheWrite = Promise.allSettled([
      cacheWriteCollection('nodes', allNodes),
      cacheWriteCollection('positions', allPositionEntries),
      cacheWriteCollection('telemetry', allTelemetryEntries),
      cacheWriteCollection('neighbors', allNeighbors),
      cacheWriteCollection('traces', allTraces),
      cacheWriteCollection('messages', allMessages.map(messageForCache)),
      cacheWriteCollection('encrypted', allEncryptedMessages.map(messageForCache)),
    ]);
    // Mark the cache populated so the next load skips the cold prefetch in favour
    // of the faster FC2 seed-then-delta path — only when we actually have data to
    // persist and the cache is enabled (PRIVATE / no-IndexedDB leave it cold).
    if (!dataCache.isDisabled() && allNodes.length > 0) setCachePresentFlag(true);
  }

  /**
   * Read non-expired entries for ``collection`` from the cache, deleting any
   * past their eviction window so the store stays bounded across sessions
   * (FC3/FC5). Returns the full entries (``{ key, value, cachedAt }``) so callers
   * can both seed the value and judge staleness.
   *
   * @param {string} collection Cache collection name.
   * @param {number} nowSeconds Current time, unix seconds.
   * @returns {Promise<Array<{ key: string, value: Object, cachedAt: number }>>} Live entries.
   */
  async function readLiveCacheEntries(collection, nowSeconds) {
    const rows = await dataCache.getAll(collection);
    const live = [];
    for (const entry of rows) {
      if (isCacheEntryExpired(collection, entry, nowSeconds)) {
        void dataCache.delete(collection, entry.key);
      } else {
        live.push(entry);
      }
    }
    return live;
  }

  /**
   * Seed the in-memory dashboard state from the persistent cache for an instant
   * first paint, then set the per-collection high-water marks so the subsequent
   * refresh fetches only the delta (SPEC FC2). Cached rows are already the
   * render-ready ``all*`` form, so seeding is a direct assignment (messages are
   * re-hydrated against the seeded node map). No-op (returns false) when the
   * cache is disabled or empty, leaving the normal cold fetch to proceed.
   *
   * @returns {Promise<boolean>} True when any cached data seeded the state.
   */
  async function seedFromCache() {
    await dataCache.ready();
    if (dataCache.isDisabled()) {
      // No persistent cache this session (PRIVATE mode or storage unavailable);
      // clear any stale warm-marker so the next load runs the cold prefetch.
      setCachePresentFlag(false);
      return false;
    }
    const nowSeconds = Math.floor(Date.now() / 1000);
    const [nodeEntries, positionEntries, telemetryEntries, neighborEntries, traceEntries] = await Promise.all([
      readLiveCacheEntries('nodes', nowSeconds),
      readLiveCacheEntries('positions', nowSeconds),
      readLiveCacheEntries('telemetry', nowSeconds),
      readLiveCacheEntries('neighbors', nowSeconds),
      readLiveCacheEntries('traces', nowSeconds),
    ]);
    const messageEntries = CHAT_ENABLED ? await readLiveCacheEntries('messages', nowSeconds) : [];
    const encryptedEntries = CHAT_ENABLED ? await readLiveCacheEntries('encrypted', nowSeconds) : [];
    if (
      nodeEntries.length === 0 &&
      messageEntries.length === 0 &&
      encryptedEntries.length === 0 &&
      positionEntries.length === 0 &&
      telemetryEntries.length === 0 &&
      neighborEntries.length === 0 &&
      traceEntries.length === 0
    ) {
      return false;
    }

    allNodes = nodeEntries.map(entry => entry.value);
    allPositionEntries = positionEntries.map(entry => entry.value);
    allTelemetryEntries = telemetryEntries.map(entry => entry.value);
    allNeighbors = neighborEntries.map(entry => entry.value);
    allTraces = traceEntries.map(entry => entry.value);
    rebuildNodeIndex(allNodes);
    const [seededChat, seededEncrypted] = await Promise.all([
      messageNodeHydrator.hydrate(messageEntries.map(entry => entry.value), nodesById),
      messageNodeHydrator.hydrate(encryptedEntries.map(entry => entry.value), nodesById),
    ]);
    allMessages = Array.isArray(seededChat) ? seededChat : [];
    allEncryptedMessages = Array.isArray(seededEncrypted) ? seededEncrypted : [];

    // FC3 staleness: when every cached node copy is older than the 24 h node
    // staleness window, prefer a full node refresh (high-water 0 → since=0) over
    // a delta, so all node metadata is refreshed rather than only nodes heard
    // since the newest cached one. Inactive nodes are still seeded (retained),
    // they are just re-fetched fresh on this first refresh.
    const nodesStale =
      nodeEntries.length > 0 && nodeEntries.every(entry => isCacheEntryStale('nodes', entry, nowSeconds));
    lastNodeTimestamp = nodesStale ? 0 : maxRecordTimestamp(allNodes, ['last_heard']);
    lastMessageTimestamp = Math.max(
      maxRecordTimestamp(allMessages, ['rx_time']),
      maxRecordTimestamp(allEncryptedMessages, ['rx_time']),
    );
    lastPositionTimestamp = maxRecordTimestamp(allPositionEntries, ['rx_time', 'position_time']);
    lastTelemetryTimestamp = maxRecordTimestamp(allTelemetryEntries, ['rx_time', 'telemetry_time']);
    lastNeighborTimestamp = maxRecordTimestamp(allNeighbors, ['rx_time']);
    lastTraceTimestamp = maxRecordTimestamp(allTraces, ['rx_time']);
    initialFetchDone = true;
    applyFilter();
    return true;
  }

  /**
   * Empty the persistent cache on demand (the FC4 "clear cached data" control).
   *
   * @returns {Promise<void>} Resolves once the cache is cleared.
   */
  async function clearDataCache() {
    await dataCache.clear();
    // Re-enable the cold prefetch on the next load now that the cache is empty.
    setCachePresentFlag(false);
  }

  // NODE_LIMIT, TRACE_LIMIT, TRACE_MAX_AGE_SECONDS, and SNAPSHOT_LIMIT are
  // imported from ``./main/constants.js`` so the helpers extracted into
  // ``./main/data-fetchers.js`` and ``./main/data-merge.js`` share the same
  // values without re-declaring them here.
  const CHAT_LIMIT = MESSAGE_LIMIT;
  const CHAT_RECENT_WINDOW_SECONDS = 7 * 24 * 60 * 60;
  // Memoising cache of chat-log entry DOM nodes. Incremental rendering reuses
  // already-built entries across refresh ticks so only new/changed entries are
  // parsed from HTML, keeping idle re-renders free of per-entry work (issue:
  // chat-log render). Exposed via ``_testUtils.getChatRenderStats`` so unit
  // tests and the manual verification hook can confirm idle ticks materialise
  // no entries.
  const chatEntryCache = createChatEntryCache({ documentRef: document });
  const REFRESH_MS = config.refreshMs;
  // Live-update (SSE) configuration. When live updates are active the SSE stream
  // drives refreshes and the only timer is the slow safety poll; otherwise the
  // app falls back to the REFRESH_MS poll exactly as before (SPEC PS5/PS8).
  const LIVE_UPDATES_ENABLED = Boolean(config.liveUpdatesEnabled);
  const LIVE_UPDATES_PATH = typeof config.liveUpdatesPath === 'string' && config.liveUpdatesPath
    ? config.liveUpdatesPath
    : '/api/events';
  const SAFETY_POLL_MS = Number.isFinite(config.safetyPollMs) && config.safetyPollMs > 0
    ? config.safetyPollMs
    : REFRESH_MS;
  // Coalesce a burst of SSE pings into one delta fetch (client-side throttle,
  // complementing the server-side coalescing, SPEC PS4).
  const LIVE_DEBOUNCE_MS = 250;
  const CHAT_ENABLED = Boolean(config.chatEnabled);
  const instanceSelectorEnabled = Boolean(config.instancesFeatureEnabled);

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
  let autorefreshPaused = false;
  let activeStatsRequestId = 0;
  // --- Live-update (SSE) state ---
  /** @type {?ReturnType<typeof createEventStream>} */
  let liveStream = null;
  /** Whether an SSE stream is currently open and driving updates. */
  let liveActive = false;
  /** The auto-refresh timer cadence last armed (ms); exposed for tests. */
  let autoRefreshIntervalMs = 0;
  /** Collections flagged dirty by SSE pings, fetched on the next debounced refresh. */
  const dirtyCollections = new Set();
  /** @type {ReturnType<typeof setTimeout>|null} */
  let liveRefreshTimer = null;
  /** Promise of the most recent live-driven refresh (test hook). */
  let liveRefreshPromise = Promise.resolve();
  /** Count of flash rounds triggered by SSE pings (VF2 gating; test hook). */
  let liveFlashCount = 0;
  /** Node ids flashed by the most recent SSE-ping refresh (test hook). */
  let lastFlashedNodeIds = [];
  /** Message ids flashed by the most recent SSE-ping refresh (test hook). */
  let lastFlashedMessageIds = [];
  /** Per-render map of message id → its channel tab id, for the tab-header flash. */
  let messageTabId = new Map();

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
   * Fetch only the collections flagged dirty by SSE pings, then clear the
   * pending set. Targeted delta fetch (SPEC PS3): a `messages` ping fetches only
   * `/api/messages`, not the whole dataset.
   *
   * @returns {Promise<void>} resolves once the targeted refresh completes.
   */
  function runLiveRefresh() {
    liveRefreshTimer = null;
    const collections = new Set(dirtyCollections);
    dirtyCollections.clear();
    // flash: true marks this as the SSE-ping path, the only refresh that
    // flashes changed rows (SPEC VF2). Resync / safety poll / initial load
    // call refresh() without it, so they never flash.
    liveRefreshPromise = refresh({ collections, flash: true });
    return liveRefreshPromise;
  }

  /**
   * Flash each changed node's table row(s) and map marker white (SPEC VF3).
   * Called after the table + map have rendered so the highlight lands on the
   * final element. Targets already-rendered DOM only — it never re-materialises
   * rows or fetches, so the incremental-render invariants (CR-A1) are preserved.
   *
   * @param {Set<string>} nodeIds Canonical node ids to flash.
   * @returns {void}
   */
  function flashChangedNodes(nodeIds) {
    if (!nodeIds || nodeIds.size === 0) return;
    // Record that a flash round was triggered (VF2 gating — test hook).
    liveFlashCount += 1;
    lastFlashedNodeIds = [...nodeIds];
    flashNodeTargets(nodeIds, { documentRef: document, markerByNodeId });
    // Emit an expanding wave from each changed node's marker (SPEC LV5). Guarded
    // on Leaflet so the poll / no-map paths stay no-ops; the wave colour resolves
    // to the node's role colour.
    if (hasLeaflet && flashWavesLayer) {
      emitNodeWaves(nodeIds, {
        markerByNodeId,
        leaflet: L,
        layer: flashWavesLayer,
        colorForNodeId: (id) => {
          const node = nodesById.get(id);
          return getRoleFlashColor(node && node.role, node && node.protocol, 0.85);
        },
      });
    }
  }

  /**
   * Flash each changed message's chat row(s) and its channel tab header (SPEC
   * VF3). Called after the chat has rendered (so the rows + tabs exist and the
   * message→tab map is populated). Targets already-rendered DOM only.
   *
   * @param {Set<string>} messageIds Message ids to flash.
   * @returns {void}
   */
  function flashChangedMessages(messageIds) {
    if (!messageIds || messageIds.size === 0) return;
    lastFlashedMessageIds = [...messageIds];
    flashMessageTargets(messageIds, { documentRef: document, messageTabId });
  }

  /**
   * Flag a collection dirty in response to an SSE change ping and arm the
   * debounce timer so a burst of pings collapses into one delta fetch.
   *
   * @param {string} collection Changed collection name.
   * @returns {void}
   */
  function scheduleLiveRefresh(collection) {
    dirtyCollections.add(collection);
    if (!liveRefreshTimer) {
      liveRefreshTimer = setTimeout(runLiveRefresh, LIVE_DEBOUNCE_MS);
    }
  }

  /**
   * Run a full delta refresh on every SSE (re)connect so any change missed
   * while the stream was down is recovered (SPEC PS5).
   *
   * @returns {void}
   */
  function handleLiveResync() {
    if (liveRefreshTimer) {
      clearTimeout(liveRefreshTimer);
      liveRefreshTimer = null;
    }
    dirtyCollections.clear();
    liveRefreshPromise = refresh();
  }

  /**
   * Open the SSE stream when live updates are enabled.
   *
   * @returns {boolean} true when a stream is active (caller uses the safety
   *   poll); false when disabled/unsupported (caller uses the REFRESH_MS poll).
   */
  function startLiveUpdates() {
    if (!LIVE_UPDATES_ENABLED) return false;
    if (!liveStream) {
      liveStream = createEventStream({
        path: LIVE_UPDATES_PATH,
        onChange: collection => scheduleLiveRefresh(collection),
        onResync: () => handleLiveResync(),
        onError: (message, error) => console.debug('live updates:', message, error),
      });
    }
    liveActive = liveStream.start();
    return liveActive;
  }

  /**
   * Close the SSE stream and drop any pending live refresh.
   *
   * @returns {void}
   */
  function stopLiveUpdates() {
    if (liveStream) liveStream.stop();
    liveActive = false;
    if (liveRefreshTimer) {
      clearTimeout(liveRefreshTimer);
      liveRefreshTimer = null;
    }
    dirtyCollections.clear();
  }

  /**
   * Restart the auto-refresh according to the user's preferences.
   *
   * With live updates active the SSE stream drives fetches and the timer is the
   * slow safety poll ({@link SAFETY_POLL_MS}); otherwise it is the legacy
   * {@link REFRESH_MS} poll. Paused auto-refresh arms no timer and closes the
   * stream so no background requests are made (SPEC PS5).
   *
   * @returns {void}
   */
  function restartAutoRefresh() {
    // Tear down any existing timer so the interval never double-fires when
    // the config is re-applied.
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
    autoRefreshIntervalMs = 0;
    // When the user has explicitly paused auto-refresh, skip arming the timer
    // and tear down the live stream so no background API requests are made.
    if (autorefreshPaused) {
      stopLiveUpdates();
      return;
    }
    // Prefer live push; fall back to polling when SSE is disabled/unsupported.
    const live = startLiveUpdates();
    const intervalMs = live ? SAFETY_POLL_MS : REFRESH_MS;
    // Only arm the timer when a positive interval is configured; a zero or
    // negative value means auto-refresh is intentionally disabled.
    if (intervalMs > 0) {
      autoRefreshIntervalMs = intervalMs;
      refreshTimer = setInterval(refresh, intervalMs);
    }
  }

  const MAP_CENTER_COORDS = Object.freeze({ lat: config.mapCenter.lat, lon: config.mapCenter.lon });
  const hasLeaflet = typeof window !== 'undefined' && typeof window.L === 'object' && window.L && typeof window.L.map === 'function';
  const mapContainer = document.getElementById('map');
  const mapPanel = document.getElementById('mapPanel');
  const mapFullscreenToggle = document.getElementById('mapFullscreenToggle');
  const mapCenterResetEl = document.getElementById('mapCenterReset');
  const fullscreenContainer = mapPanel || mapContainer;
  const isFederationView = bodyClassList ? bodyClassList.contains('view-federation') : false;
  const legendDefaultCollapsed = mapPanel ? mapPanel.dataset.legendCollapsed === 'true' : false;
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
  // Below this zoom level the co-located spider feature is disabled
  // entirely: markers stack at their shared coordinate (no fan, no leader
  // lines, no hub badge).  At or above it, multi-node groups collapse into
  // a single hub badge that the user can click to expand into the spider.
  // Intentionally aligned with ``MAX_INITIAL_ZOOM`` above so the auto-fit
  // initial view (which clamps at zoom 13) lands directly on the bucket
  // boundary and users see the hub representation as soon as the map is
  // ready rather than after their first zoom-in interaction.
  const COLOCATED_HUB_MIN_ZOOM = 13;
  let neighborLinesLayer = null;
  let traceLinesLayer = null;
  let neighborLinesVisible = true;
  let traceLinesVisible = true;
  let neighborLinesToggleButton = null;
  let traceLinesToggleButton = null;
  let markersLayer = null;
  let spiderLinesLayer = null;
  // Dedicated, never-cleared layer hosting transient LV5 wave rings; each wave
  // self-removes after its animation, so a map re-render never clears it.
  let flashWavesLayer = null;
  // Per-render map of canonical node id → its Leaflet marker, so a live update
  // can flash the marker for a changed node (SPEC VF3). Rebuilt every renderMap.
  let markerByNodeId = new Map();
  // Per-render record of the offset markers we created so the zoom event
  // handlers can re-project them and keep the on-screen pixel gap constant
  // regardless of zoom level.  Each entry is
  // `{ marker, line, lat, lon, dx, dy }` where `lat`/`lon` are the original
  // (un-offset) coordinates.
  let colocatedSpiderState = [];
  // requestAnimationFrame handle used to coalesce per-frame `zoom` events
  // into a single refresh; reset to ``null`` once the scheduled callback
  // runs so the next frame can schedule again.
  let pendingSpiderRefreshHandle = null;
  // Leaflet layer that holds the small "asterisk + count" hub badges that
  // collapse co-located groups at zoom levels at or above
  // ``COLOCATED_HUB_MIN_ZOOM``.  Initialised alongside the other map layers
  // and cleared on every render before being re-populated.
  let colocatedHubsLayer = null;
  // Bucket keys (as returned by ``computeColocatedOffsets``) for groups the
  // user has explicitly clicked open.  Hubs whose key is in the set render
  // their members fanned out + leader lines; absent keys render the hub
  // alone.  Cleared whenever the map crosses the zoom threshold so the
  // collapsed default is restored when the visual context changes.
  let expandedColocatedKeys = new Set();
  // Tracks whether the most recent render was below or at/above the zoom
  // threshold so the ``zoomend`` handler can detect threshold crossings and
  // trigger a re-render that swaps the hub representation in or out.
  let lastRenderedZoomBucket = null;
  // Cache of divIcon instances keyed by group size.  Building an icon for
  // every multi-node group on every render is expensive at scale (hundreds
  // of nodes can produce dozens of hubs); since the icon's html only varies
  // by groupSize we share a single instance across same-size groups and
  // across renders.  See ``getColocatedHubIcon`` for the lookup.
  const colocatedHubIconCache = new Map();
  const fullscreenChangeEvents = [
    'fullscreenchange',
    'webkitfullscreenchange',
    'mozfullscreenchange',
    'MSFullscreenChange',
    'msfullscreenchange'
  ];

  const autoFitController = createMapAutoFitController({
    toggleEl: null,
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

  const centerResetHandler = createMapCenterResetHandler({
    getMap: () => map,
    autoFitController,
    fitMapToBounds,
    mapCenterCoords: MAP_CENTER_COORDS,
    mapZoomOverride,
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

  if (mapCenterResetEl) {
    mapCenterResetEl.addEventListener('click', event => {
      event.preventDefault();
      centerResetHandler();
    });
  }

  /** @type {Set<string>} Hidden role compound keys — roles in this set are excluded from display. */
  const activeRoleFilters = new Set();
  /** @type {Map<string, HTMLElement>} Compound key → legend button element. */
  const legendRoleButtons = new Map();
  /** @type {Set<string>} Protocols hidden by the user via legend toggles. */
  const hiddenProtocols = new Set();
  const legendProtocolButtons = new Map();

  /**
   * Wrap a legend button click handler so it always calls
   * ``preventDefault`` and ``stopPropagation`` before running the body.
   *
   * Centralising this prevents the two-line boilerplate from repeating in
   * every legend button handler, reducing token-level duplication.
   *
   * @param {function(Event): void} fn Handler body.
   * @returns {function(Event): void} Full click listener.
   */

  /**
   * Canonical protocol token for use in compound filter keys.
   *
   * Collapses null/absent/unknown protocol values to ``'meshtastic'`` so that
   * pre-protocol legacy records land in the Meshtastic filter bucket.
   *
   * @param {string|null|undefined} protocol Raw protocol value.
   * @returns {'meshtastic'|'meshcore'} Normalised protocol token.
   */
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


  // --- Map setup ---
  // The basemap is CARTO Dark Matter (see ``./basemap-config.js``). Its tiles
  // are natively dark-grey, so there is no per-theme CSS colour filter — the
  // old ``grayscale``/``invert`` pipeline was removed with the provider swap.

  if (hasLeaflet) {
    mapCenterLatLng = L.latLng(MAP_CENTER_COORDS.lat, MAP_CENTER_COORDS.lon);
  }

  /**
   * Closure-bound dependency-injection bridge to
   * ``createOfflineTileLayerImpl``.  The implementation in
   * ``./main/offline-tile-layer.js`` is dependency-free so it can be unit
   * tested standalone; this shim feeds it the Leaflet global from
   * ``initializeApp``'s closure.  **Do not inline** — keeping the wrapper
   * preserves Leaflet-as-parameter so tests can pass a fake.
   *
   * Returns ``null`` when Leaflet is absent to preserve the original
   * semantics.
   *
   * @returns {Object|null} Configured Leaflet ``GridLayer`` or ``null``.
   */
  function createOfflineTileLayer() {
    if (!hasLeaflet) return null;
    return createOfflineTileLayerImpl(L);
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
    if (message) {
      showMapStatus(message);
    }
  }

  const mapAlreadyInitialized = mapContainer && mapContainer._leaflet_id;

  if (hasLeaflet && mapContainer && !isFederationView && !mapAlreadyInitialized) {
    map = L.map(mapContainer, { worldCopyJump: true, attributionControl: false });
    showMapStatus('Loading map tiles…');
    tiles = L.tileLayer(TILE_LAYER_URL, TILE_LAYER_OPTIONS);
    const tileFailurePolicy = createTileFailurePolicy();
    const OFFLINE_TILES_MESSAGE =
      'Map tiles unavailable. Showing offline placeholder basemap.';

    tiles.on('tileload', () => {
      // The first successful tile latches the basemap "alive": from here on,
      // isolated tile errors are tolerated and never swap in the offline layer.
      tileFailurePolicy.recordTileLoad();
      hideMapStatus();
    });

    tiles.on('tileerror', () => {
      // A single tile error no longer kills the basemap (DM3). The offline
      // fallback only fires once the policy judges the basemap comprehensively
      // unreachable (no successes after enough failures).
      if (tileFailurePolicy.recordTileError()) {
        activateOfflineTiles(OFFLINE_TILES_MESSAGE);
      }
    });

    tiles.on('load', () => {
      // The current viewport finished loading. If not a single tile succeeded,
      // the provider is unreachable — fall back; otherwise the basemap is up.
      if (tileFailurePolicy.recordLayerLoad()) {
        activateOfflineTiles(OFFLINE_TILES_MESSAGE);
        return;
      }
      usingOfflineTiles = false;
      hideMapStatus();
    });

    tiles.addTo(map);

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
        refreshMapSize();
        applyLastRecordedBounds({ animate: false });
      });
    } else {
      applyLastRecordedBounds({ animate: false });
    }

    map.on('movestart', () => {
      autoFitController.handleUserInteraction();
    });
    map.on('zoomstart', () => {
      autoFitController.handleUserInteraction();
    });

    neighborLinesLayer = L.layerGroup().addTo(map);
    flashWavesLayer = L.layerGroup().addTo(map);
    traceLinesLayer = L.layerGroup().addTo(map);
    // Spider lines render between the connection lines and the markers so the
    // dashed white "leader" lines are visible against neighbour/trace overlays
    // but never sit on top of the marker glyphs themselves.
    spiderLinesLayer = L.layerGroup().addTo(map);
    markersLayer = L.layerGroup().addTo(map);
    // Hub badges render on top of the marker glyphs so the click target is
    // always reachable, even when a stale marker happens to share the exact
    // pixel coordinate of the hub centre.
    colocatedHubsLayer = L.layerGroup().addTo(map);

    // Pixel-space offsets are baked into a LatLng at render time, so the
    // on-screen spread would otherwise scale with zoom — at extreme zoom-outs
    // the offset becomes many degrees wide and the markers fly off-screen
    // when the user later zooms in.  Recompute continuously throughout every
    // zoom task: the `zoom` event fires per animation frame and is throttled
    // through `requestAnimationFrame` to coalesce redundant updates into a
    // single redraw per frame; `zoomend` snaps to the final position; and
    // `viewreset` covers projection resets such as resize / fullscreen /
    // dateline wrap.  ``zoomend`` additionally watches for crossings of
    // ``COLOCATED_HUB_MIN_ZOOM`` and re-runs ``applyFilter`` so the marker
    // representation switches between flat / hub modes.
    map.on('zoom', scheduleColocatedSpiderRefresh);
    map.on('zoomend', handleZoomEndForColocatedHubs);
    map.on('viewreset', refreshColocatedSpiderState);

    if (typeof navigator !== 'undefined' && navigator && navigator.onLine === false) {
      activateOfflineTiles('Offline mode detected. Using placeholder basemap.');
    }
  } else if (mapContainer && !isFederationView) {
    setMapPlaceholder('Leaflet assets are unavailable. Data will continue to refresh without a live map.');
  }

  let legendContainer = null;
  let legendToggleControl = null;
  let meshcoreCountEl = null;
  let meshtasticCountEl = null;
  let meshcoreColEl = null;
  let meshtasticColEl = null;
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
  /**
   * Build a protocol icon ``<img>`` element via DOM APIs.
   *
   * Shared implementation used by {@link buildMeshtasticIconImg} and
   * {@link buildMeshcoreIconImg}.  Mirrors the attribute set produced by
   * the HTML-string helpers in ``protocol-helpers.js`` so the rendered
   * output is identical regardless of insertion method.
   *
   * @param {string} src Absolute path to the SVG asset.
   * @param {string} variantClass BEM modifier class, e.g. ``protocol-icon--meshtastic``.
   * @returns {HTMLImageElement} Icon element ready to append.
   */
  function updateNeighborLinesToggleState() {
    if (!neighborLinesToggleButton) return;
    const label = neighborLinesVisible ? 'Hide neighbor lines' : 'Show neighbor lines';
    neighborLinesToggleButton.textContent = label;
    // aria-pressed reflects whether the user has *activated* the toggle (i.e. lines are
    // currently hidden). When lines are visible (default), the button is unpressed.
    neighborLinesToggleButton.setAttribute('aria-pressed', neighborLinesVisible ? 'false' : 'true');
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
   * Synchronise the traceroute line toggle button with the active state.
   *
   * @returns {void}
   */
  function updateTraceLinesToggleState() {
    if (!traceLinesToggleButton) return;
    const label = traceLinesVisible ? 'Hide trace lines' : 'Show trace lines';
    traceLinesToggleButton.textContent = label;
    // aria-pressed reflects whether the user has *activated* the toggle (lines hidden).
    traceLinesToggleButton.setAttribute('aria-pressed', traceLinesVisible ? 'false' : 'true');
    traceLinesToggleButton.setAttribute('aria-label', label);
  }

  /**
   * Toggle the Leaflet layer that renders traceroute connections.
   *
   * @param {boolean} visible Whether to show traceroute paths.
   * @returns {void}
   */
  function setTraceLinesVisibility(visible) {
    traceLinesVisible = Boolean(visible);
    if (traceLinesLayer && map) {
      const hasLayer = map.hasLayer(traceLinesLayer);
      if (traceLinesVisible && !hasLayer) {
        traceLinesLayer.addTo(map);
      } else if (!traceLinesVisible && hasLayer) {
        map.removeLayer(traceLinesLayer);
      }
    }
    updateTraceLinesToggleState();
  }

  /**
   * Refresh the legend buttons to reflect the active role filters.
   *
   * @returns {void}
   */
  function updateLegendRoleFiltersUI() {
    const hasFilters = activeRoleFilters.size > 0;
    // activeRoleFilters is a *hidden-roles* set: roles present in the set are
    // hidden.  Buttons show aria-pressed="true" when the role is *visible*
    // (i.e. NOT in the hidden set) so that the default all-visible state
    // highlights every button.
    legendRoleButtons.forEach((button, compoundKey) => {
      if (!button) return;
      const isHidden = activeRoleFilters.has(compoundKey);
      button.setAttribute('aria-pressed', isHidden ? 'false' : 'true');
    });
    if (legendContainer) {
      if (hasFilters || hiddenProtocols.size > 0) {
        legendContainer.setAttribute('data-has-active-filters', 'true');
      } else {
        legendContainer.removeAttribute('data-has-active-filters');
      }
    }
    updateMetaProtocolToggleUI();
    updateLegendToggleState();
  }

  /**
   * Sync the meta-row protocol toggle buttons with the current
   * {@link hiddenProtocols} state.
   *
   * When a protocol is hidden the button's ``<img>`` receives a greyscale
   * filter and ``aria-pressed`` is set to ``"true"``.
   *
   * @returns {void}
   */
  function updateMetaProtocolToggleUI() {
    /** @type {Array<{btn: HTMLElement|null, protocol: string, name: string}>} */
    const toggles = [
      { btn: protocolToggleMeshcore, protocol: 'meshcore', name: 'MeshCore' },
      { btn: protocolToggleMeshtastic, protocol: 'meshtastic', name: 'Meshtastic' },
    ];
    toggles.forEach(({ btn, protocol, name }) => {
      if (!btn) return;
      const isHidden = hiddenProtocols.has(protocol);
      btn.setAttribute('aria-pressed', isHidden ? 'true' : 'false');
      btn.setAttribute('aria-label', isHidden ? `Show ${name} nodes` : `Hide ${name} nodes`);
      const img = btn.querySelector('.protocol-toggle-icon');
      if (img) {
        img.style.filter = isHidden ? 'grayscale(1) opacity(0.4)' : '';
      }
    });
  }

  /**
   * Toggle the visibility filter for a role+protocol combination.
   *
   * @param {string} compoundKey Compound key in the form ``"<protocol>:<roleKey>"``.
   * @returns {void}
   */
  function toggleRoleFilter(compoundKey) {
    if (!compoundKey) return;
    if (activeRoleFilters.has(compoundKey)) {
      activeRoleFilters.delete(compoundKey);
    } else {
      activeRoleFilters.add(compoundKey);
    }
    updateLegendRoleFiltersUI();
    applyFilter();
  }

  /**
   * Build role filter buttons for a given palette and append them to a column.
   *
   * Each button is keyed by a compound ``"<protocol>:<roleKey>"`` string so
   * that roles sharing a name across protocols (e.g. ``SENSOR``, ``REPEATER``)
   * produce independent buttons without colliding in {@link legendRoleButtons}.
   *
   * @param {HTMLElement} colEl Column container element.
   * @param {Record<string,string>} palette Role→colour map to render.
   * @param {'meshtastic'|'meshcore'} protocol Protocol token for this column.
   * @returns {void}
   */
  function buildRoleButtons(colEl, palette, protocol) {
    for (const [role, color] of Object.entries(palette)) {
      if (!CHAT_ENABLED && role === 'CLIENT_HIDDEN') continue;
      const compoundKey = makeRoleFilterKey(role, protocol);
      const item = document.createElement('button');
      item.className = 'legend-item';
      colEl.appendChild(item);
      item.type = 'button';
      item.setAttribute('aria-pressed', 'true');
      item.dataset.role = role;
      item.dataset.protocol = protocol;
      const swatch = document.createElement('span');
      swatch.className = 'legend-swatch';
      item.appendChild(swatch);
      swatch.style.background = color;
      swatch.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.className = 'legend-label';
      item.appendChild(label);
      label.textContent = role;
      item.addEventListener('click', legendClickHandler(event => {
        const exclusive = event.metaKey || event.ctrlKey;
        if (exclusive) {
          // Ctrl/Cmd+Click: hide only this role (all others become visible).
          activeRoleFilters.clear();
          activeRoleFilters.add(compoundKey);
          updateLegendRoleFiltersUI();
          applyFilter();
        } else {
          toggleRoleFilter(compoundKey);
        }
      }));
      legendRoleButtons.set(compoundKey, item);
    }
  }

  if (map && hasLeaflet) {
    // Single combined control: [toggle button | legend panel] in a flex row.
    // The toggle sits to the left so it remains accessible when the legend is collapsed.
    const legendControl = L.control({ position: 'bottomright' });
    /**
     * Leaflet control factory that renders the toggle button and legend panel
     * as a single side-by-side control.
     *
     * @returns {HTMLElement} Wrapper element containing both children.
     */
    legendControl.onAdd = function () {
      const wrapper = L.DomUtil.create('div', 'legend-outer');

      // --- Toggle button (left) ---
      const button = L.DomUtil.create('button', 'legend-toggle-button', wrapper);
      button.type = 'button';
      button.setAttribute('aria-pressed', 'true');
      button.setAttribute('aria-controls', 'mapLegend');
      button.addEventListener('click', legendClickHandler(() => {
        setLegendVisibility(!legendVisible);
      }));
      legendToggleButton = button;

      // --- Legend panel (right) ---
      const div = L.DomUtil.create('div', 'legend', wrapper);
      div.id = 'mapLegend';
      div.setAttribute('role', 'region');
      div.setAttribute('aria-label', 'Map legend');
      legendContainer = div;

      const header = L.DomUtil.create('div', 'legend-header', div);
      const title = L.DomUtil.create('span', 'legend-title', header);
      title.textContent = 'Legend';

      const itemsContainer = L.DomUtil.create('div', 'legend-items legend-items--columns', div);

      // --- MeshCore column (left, bottom-aligned) ---
      const meshcoreCol = L.DomUtil.create('div', 'legend-column legend-column--bottom', itemsContainer);
      meshcoreColEl = meshcoreCol;
      const meshcoreColHeader = L.DomUtil.create('div', 'legend-column-header', meshcoreCol);
      meshcoreColHeader.appendChild(buildMeshcoreIconImg());
      const meshcoreColTitle = document.createElement('span');
      meshcoreColTitle.textContent = 'MeshCore';
      meshcoreColHeader.appendChild(meshcoreColTitle);
      meshcoreCountEl = document.createElement('span');
      meshcoreCountEl.className = 'legend-protocol-count';
      meshcoreColHeader.appendChild(meshcoreCountEl);

      // --- Meshtastic column (right) ---
      const meshtasticCol = L.DomUtil.create('div', 'legend-column', itemsContainer);
      meshtasticColEl = meshtasticCol;
      const meshtasticColHeader = L.DomUtil.create('div', 'legend-column-header', meshtasticCol);
      meshtasticColHeader.appendChild(buildMeshtasticIconImg());
      const meshtasticColTitle = document.createElement('span');
      meshtasticColTitle.textContent = 'Meshtastic';
      meshtasticColHeader.appendChild(meshtasticColTitle);
      meshtasticCountEl = document.createElement('span');
      meshtasticCountEl.className = 'legend-protocol-count';
      meshtasticColHeader.appendChild(meshtasticCountEl);

      legendRoleButtons.clear();
      buildRoleButtons(meshcoreCol, meshcoreRoleColors, 'meshcore');
      buildRoleButtons(meshtasticCol, roleColors, 'meshtastic');

      // --- Meshtastic column: line toggles at bottom ---
      neighborLinesToggleButton = L.DomUtil.create('button', 'legend-item legend-toggle-neighbors', meshtasticCol);
      neighborLinesToggleButton.type = 'button';
      neighborLinesToggleButton.addEventListener('click', legendClickHandler(() => {
        setNeighborLinesVisibility(!neighborLinesVisible);
      }));
      updateNeighborLinesToggleState();

      traceLinesToggleButton = L.DomUtil.create('button', 'legend-item legend-toggle-traces', meshtasticCol);
      traceLinesToggleButton.type = 'button';
      traceLinesToggleButton.addEventListener('click', legendClickHandler(() => {
        setTraceLinesVisibility(!traceLinesVisible);
      }));
      updateTraceLinesToggleState();

      updateLegendRoleFiltersUI();

      // --- Clear filters — full-width below the two columns ---
      const filterToggle = L.DomUtil.create('div', 'legend-toggle', div);

      const resetButton = L.DomUtil.create('button', 'legend-item legend-reset', filterToggle);
      resetButton.type = 'button';
      resetButton.textContent = 'Clear filters';
      resetButton.addEventListener('click', legendClickHandler(() => {
        activeRoleFilters.clear();
        hiddenProtocols.clear();
        updateLegendRoleFiltersUI();
        applyFilter();
      }));

      updateLegendToggleState();
      L.DomEvent.disableClickPropagation(wrapper);
      L.DomEvent.disableScrollPropagation(wrapper);
      return wrapper;
    };
    legendControl.addTo(map);

    const legendMediaQuery = window.matchMedia('(max-width: 1024px)');
    const initialLegendVisible = resolveLegendVisibility({
      defaultCollapsed: legendDefaultCollapsed,
      mediaQueryMatches: legendMediaQuery.matches,
      viewMode: isDashboardView ? 'dashboard' : (isMapView ? 'map' : undefined)
    });
    setLegendVisibility(initialLegendVisible);
    legendMediaQuery.addEventListener('change', event => {
      if (legendDefaultCollapsed || isDashboardView || isMapView) return;
      setLegendVisibility(!event.matches);
    });
  } else if (mapContainer && !hasLeaflet) {
    setLegendVisibility(false);
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
  // ``renderShortHtml`` is imported from ``./main/short-html-renderer.js`` —
  // see the module-level imports near the top of this file.

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
        const numericFromId = parseNodeNumericRef(nodeIdRaw);
        if (numericFromId != null && !nodesByNum.has(numericFromId)) {
          nodesByNum.set(numericFromId, node);
        }
      }
      const nodeNumRaw = node.num ?? node.node_num ?? node.nodeNum;
      const nodeNum = parseNodeNumericRef(nodeNumRaw);
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
          // Inherit the source node's protocol so the fallback label tracks
          // the radio the neighbor lives on.  Neighborinfo entries are emitted
          // by a node talking to its own radio peers, so cross-protocol mixing
          // is not a concern here.
          const placeholder = buildNodePlaceholder(neighborId, entry);
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
    const longNameLink = renderNodeLongNameLink(node?.long_name, node?.node_id, { protocol: node?.protocol });
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
      ['satsInView', source.satsInView ?? source.sats_in_view],
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

    const protocolRaw = source.protocol;
    if (protocolRaw != null && typeof protocolRaw === 'string') {
      normalized.protocol = protocolRaw;
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
      const link = renderNodeLongNameLink(normalized.longName, normalized.nodeId, { protocol: normalized.protocol });
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
    const longNameLink = renderNodeLongNameLink(overlayInfo.longName, overlayInfo.nodeId, {
      protocol: overlayInfo.protocol,
    });
    if (longNameLink) {
      lines.push(`<strong>${longNameLink}</strong>`);
    } else {
      const longNameValue = shortInfoValueOrDash(overlayInfo.longName ?? '');
      if (longNameValue !== '—') {
        lines.push(`<strong>${escapeHtml(longNameValue)}</strong>`);
      }
    }
    const shortParts = [];
    const shortHtml = renderShortHtml(overlayInfo.shortName, overlayInfo.role, overlayInfo.longName, overlayInfo);
    if (shortHtml) {
      shortParts.push(shortHtml);
    }
    const nodeIdValue = shortInfoValueOrDash(overlayInfo.nodeId ?? '');
    if (nodeIdValue !== '—') {
      shortParts.push(`<span class="mono">${escapeHtml(nodeIdValue)}</span>`);
    }
    const satelliteLine = renderSatsInViewBadge(overlayInfo);
    if (satelliteLine) {
      shortParts.push(satelliteLine);
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
   * Build the parts (class name + HTML) for a node-join chat entry.
   *
   * @param {Object} node Node payload.
   * @param {?number} [timestampOverride=null] Optional timestamp override.
   * @returns {{ className: string, html: string }|null} Entry parts or null.
   */
  function buildNodeChatEntryParts(node, timestampOverride = null) {
    if (!node || typeof node !== 'object') return null;
    const nodeIdRaw = pickFirstProperty([node], ['node_id', 'nodeId']);
    const fallbackId = nodeIdRaw || 'Unknown node';
    const longNameRaw = pickFirstProperty([node], ['long_name', 'longName']);
    const longNameDisplay = longNameRaw ? String(longNameRaw) : fallbackId;
    const nodeProtocol = pickFirstProperty([node], ['protocol']);
    const longNameLink = renderNodeLongNameLink(longNameRaw, nodeIdRaw, { protocol: nodeProtocol });
    const announcementName = longNameLink || escapeHtml(longNameDisplay);
    const shortNameRaw = pickFirstProperty([node], ['short_name', 'shortName']);
    const shortNameDisplay = shortNameRaw ? String(shortNameRaw) : (nodeIdRaw ? nodeIdRaw.slice(-4) : null);
    const roleDisplay = pickFirstProperty([node], ['role']);
    const tsSeconds = timestampOverride != null
      ? timestampOverride
      : resolveTimestampSeconds(node.first_heard ?? node.firstHeard, node.first_heard_iso ?? node.firstHeardIso);
    return buildAnnouncementParts({
      timestampSeconds: tsSeconds,
      shortName: shortNameDisplay,
      longName: longNameDisplay,
      role: roleDisplay,
      metadataSource: node,
      nodeData: node,
      protocol: nodeProtocol,
      messageHtml: `${renderEmojiHtml('☀️')} ${renderAnnouncementCopy('New node:', ` ${announcementName}`)}`
    });
  }

  /**
   * Build a formatted suffix that enumerates highlight values.
   *
   * @param {Array<{label: string, value: string}>} highlights Highlight metadata entries.
   * @param {string} [separator=' — '] Leading separator placed before the joined
   *   highlights (e.g. ``': '`` so a position reads "Broadcasted position info: …").
   * @returns {string} HTML suffix containing escaped highlight entries.
   */
  function buildHighlightSuffix(highlights, separator = ' — ') {
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
    return `${separator}${parts.join(', ')}`;
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

  /**
   * Build the parts for a "node info updated" chat entry.
   *
   * @param {Object} entry Structured chat-log entry.
   * @param {Object} context Display context from {@link buildDisplayContext}.
   * @returns {{ className: string, html: string }} Entry parts.
   */
  function buildNodeInfoChatEntryParts(entry, context) {
    const label = context.longName ? String(context.longName) : (context.nodeId || 'Unknown node');
    // The reason annotates *why* the node record updated — "(advert)" for a bare
    // heard / node-info update, "(message)" for a decrypted chat message recorded
    // node-centrically so its body never reaches the Log (LV7).  Absent reason
    // degrades to the plain "Updated node info" copy.
    const reason = typeof entry?.reason === 'string' ? entry.reason.trim() : '';
    const reasonSuffix = reason ? ` (${reason})` : '';
    return buildAnnouncementParts({
      timestampSeconds: entry?.ts ?? null,
      shortName: context.shortName,
      longName: label,
      role: context.role,
      metadataSource: context.metadataSource,
      nodeData: context.nodeData,
      protocol: context.protocol,
      messageHtml: `${renderEmojiHtml('💾')} ${renderAnnouncementCopy(`Updated node info${reasonSuffix}`)}`
    });
  }

  /**
   * Build the parts for a telemetry-broadcast chat entry.
   *
   * @param {Object} entry Structured chat-log entry.
   * @param {Object} context Display context from {@link buildDisplayContext}.
   * @returns {{ className: string, html: string }} Entry parts.
   */
  function buildTelemetryChatEntryParts(entry, context) {
    const label = context.longName ? String(context.longName) : (context.nodeId || 'Unknown node');
    const highlightSuffix = buildHighlightSuffix(formatTelemetryHighlights(entry?.telemetry));
    return buildAnnouncementParts({
      timestampSeconds: entry?.ts ?? null,
      shortName: context.shortName,
      longName: label,
      role: context.role,
      metadataSource: context.metadataSource,
      nodeData: context.nodeData,
      protocol: context.protocol,
      messageHtml: `${renderEmojiHtml('🔋')} ${renderAnnouncementCopy('Broadcasted telemetry', highlightSuffix)}`
    });
  }

  /**
   * Build the parts for a position-broadcast chat entry.
   *
   * @param {Object} entry Structured chat-log entry.
   * @param {Object} context Display context from {@link buildDisplayContext}.
   * @returns {{ className: string, html: string }} Entry parts.
   */
  function buildPositionChatEntryParts(entry, context) {
    const label = context.longName ? String(context.longName) : (context.nodeId || 'Unknown node');
    // A position reads "Broadcasted position info: <lat>, <lon>" (colon, not the
    // em dash used by telemetry) to match the neighbour entry's punctuation.
    const highlightSuffix = buildHighlightSuffix(formatPositionHighlights(entry?.position), ': ');
    return buildAnnouncementParts({
      timestampSeconds: entry?.ts ?? null,
      shortName: context.shortName,
      longName: label,
      role: context.role,
      metadataSource: context.metadataSource,
      nodeData: context.nodeData,
      protocol: context.protocol,
      messageHtml: `${renderEmojiHtml('📍')} ${renderAnnouncementCopy('Broadcasted position info', highlightSuffix)}`
    });
  }

  /**
   * Build the parts for a neighbour-broadcast chat entry.
   *
   * @param {Object} entry Structured chat-log entry.
   * @param {Object} context Display context from {@link buildDisplayContext}.
   * @returns {{ className: string, html: string }} Entry parts.
   */
  function buildNeighborChatEntryParts(entry, context) {
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
    return buildAnnouncementParts({
      timestampSeconds: entry?.ts ?? null,
      shortName: context.shortName,
      longName: label,
      role: context.role,
      metadataSource: context.metadataSource,
      nodeData: context.nodeData,
      protocol: context.protocol,
      messageHtml: `${renderEmojiHtml('🏘️')} ${renderAnnouncementCopy('Broadcasted neighbor info', detail)}`
    });
  }

  /**
   * Compute the class name and HTML for a mixed-feed (Log tab) chat entry,
   * dispatching on the entry type, without touching the DOM. Returns ``null``
   * for entries that should not render. Used by the memoising render path.
   *
   * @param {Object} entry Structured chat-log entry.
   * @returns {{ className: string, html: string }|null} Entry parts or null.
   */
  function buildChatLogEntryParts(entry) {
    if (!entry || typeof entry !== 'object') return null;
    if (entry.type === CHAT_LOG_ENTRY_TYPES.NODE_NEW) {
      return buildNodeChatEntryParts(entry.node ?? resolveNodeForLogEntry(entry) ?? null, entry?.ts ?? null);
    }
    const context = buildDisplayContext(entry);
    switch (entry.type) {
      case CHAT_LOG_ENTRY_TYPES.NODE_INFO:
        return buildNodeInfoChatEntryParts(entry, context);
      case CHAT_LOG_ENTRY_TYPES.TELEMETRY:
        return buildTelemetryChatEntryParts(entry, context);
      case CHAT_LOG_ENTRY_TYPES.POSITION:
        return buildPositionChatEntryParts(entry, context);
      case CHAT_LOG_ENTRY_TYPES.NEIGHBOR:
        return buildNeighborChatEntryParts(entry, context);
      case CHAT_LOG_ENTRY_TYPES.TRACE:
        return buildTraceChatEntryParts(entry, context);
      case CHAT_LOG_ENTRY_TYPES.MESSAGE:
      case CHAT_LOG_ENTRY_TYPES.MESSAGE_ENCRYPTED:
        return entry?.message ? buildMessageChatEntryParts(entry.message) : null;
      default:
        return null;
    }
  }

  /**
   * Compute the class name and HTML string for a node-centric announcement
   * entry, without touching the DOM. The render path consumes this pure form so
   * the HTML parse can be memoised per entry (issue: chat-log render); the
   * {@link createAnnouncementEntry} wrapper materialises it into a node.
   *
   * @param {{
   *   timestampSeconds: ?number,
   *   shortName: ?string,
   *   longName: ?string,
   *   role: ?string,
   *   metadataSource: Object|null,
   *   nodeData: Object|null,
   *   messageHtml: string,
   *   protocol: ?string
   * }} params Rendering parameters.
   * @returns {{ className: string, html: string }} Entry class name and HTML.
   */
  function buildAnnouncementParts({
    timestampSeconds,
    shortName,
    longName,
    role,
    metadataSource,
    nodeData,
    messageHtml,
    protocol: protocolHint = null
  }) {
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
    const announcementProtocol =
      protocolHint ?? pickFirstProperty([nodeData, metadataSource], ['protocol']);
    const announcementIconPrefix = protocolIconPrefixHtml(announcementProtocol);
    return {
      className: 'chat-entry-node',
      html: `${prefix}${presetTag} ${announcementIconPrefix}${shortHtml} ${messageHtml}`
    };
  }

  /**
   * Materialise a node-centric announcement entry as a DOM element. Thin wrapper
   * over {@link buildAnnouncementParts} retained for the test-utility surface;
   * the render path uses the parts form directly so it can memoise the parse.
   *
   * @param {Object} params Rendering parameters (see {@link buildAnnouncementParts}).
   * @returns {HTMLElement} Chat log element.
   */
  function createAnnouncementEntry(params) {
    return materializeEntryNode(buildAnnouncementParts(params));
  }

  /**
   * Convert a trace path into user-friendly labels using cached node metadata.
   *
   * @param {Array<{id: ?string, num: ?number, raw: *}>} tracePath Ordered hop references.
   * @returns {Array<string>} Display labels for each hop.
   */
  function formatTracePathLabels(tracePath) {
    if (!Array.isArray(tracePath)) return [];
    const labels = [];
    for (const hop of tracePath) {
      if (!hop || typeof hop !== 'object') continue;
      const node = resolveNodeForHop(hop);
      const fallbackId = hop.id ?? (Number.isFinite(hop.num) ? String(hop.num) : (hop.raw != null ? String(hop.raw) : ''));
      const shortName = node ? normalizeNodeNameValue(node.short_name ?? node.shortName) : null;
      const label = shortName || (node ? (getNodeDisplayNameForOverlay(node) || fallbackId) : fallbackId);
      if (label) {
        labels.push(String(label));
      }
    }
    return labels;
  }

  /**
   * Build the parts for a traceroute chat entry, or null when the trace path is
   * too short to render.
   *
   * @param {Object} entry Structured chat-log entry carrying ``tracePath``.
   * @param {Object} context Display context from {@link buildDisplayContext}.
   * @returns {{ className: string, html: string }|null} Entry parts or null.
   */
  function buildTraceChatEntryParts(entry, context) {
    if (!entry || !Array.isArray(entry.tracePath) || entry.tracePath.length < 2) {
      return null;
    }
    const sourceHop = entry.tracePath[0] || null;
    const sourceNode = resolveNodeForHop(sourceHop);
    const labels = formatTracePathLabels(entry.tracePath);
    const labelText = labels.length ? labels.join(', ') : 'Traceroute';
    const labelSuffix = `: ${escapeHtml(labelText)}`;
    return buildAnnouncementParts({
      timestampSeconds: entry?.ts ?? null,
      shortName: context.shortName,
      longName: context.longName || context.nodeId || labels[0] || 'Traceroute',
      role: context.role,
      metadataSource: sourceNode || context.metadataSource,
      nodeData: sourceNode || context.nodeData,
      protocol: context.protocol,
      messageHtml: `${renderEmojiHtml('👣')} ${renderAnnouncementCopy('Caught trace', labelSuffix)}`
    });
  }

  /**
   * Resolve a node reference for a trace hop using cached node indices.
   *
   * @param {{id?: string, num?: number}|null} hop Trace hop descriptor.
   * @returns {?Object} Node payload when available.
   */
  function resolveNodeForHop(hop) {
    if (!hop || typeof hop !== 'object') {
      return null;
    }
    const id = typeof hop.id === 'string' ? hop.id.trim() : null;
    const idCandidates = [];
    if (id) {
      idCandidates.push(id);
      idCandidates.push(id.toUpperCase());
      idCandidates.push(id.toLowerCase());
    }
    for (const candidate of idCandidates) {
      if (candidate && nodesById instanceof Map && nodesById.has(candidate)) {
        return nodesById.get(candidate);
      }
    }
    const numericCandidates = [];
    if (Number.isFinite(hop.num)) numericCandidates.push(hop.num);
    const parsedFromId = parseNodeNumericRef(id);
    if (parsedFromId != null) numericCandidates.push(parsedFromId);
    const parsedFromNum = parseNodeNumericRef(hop.num);
    if (parsedFromNum != null) numericCandidates.push(parsedFromNum);
    for (const numeric of numericCandidates) {
      if (Number.isFinite(numeric) && nodesByNum instanceof Map && nodesByNum.has(numeric)) {
        return nodesByNum.get(numeric);
      }
    }
    return null;
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
   *   nodeData: Object|null,
   *   protocol: ?string
   * }} Normalised display metadata.
   */
  function buildDisplayContext(entry) {
    const resolvedNode = resolveNodeForLogEntry(entry);
    const candidateSources = [
      resolvedNode,
      entry?.node,
      entry?.telemetry,
      entry?.position,
      entry?.neighbor,
      entry?.trace,
    ].filter(source => source && typeof source === 'object');
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
    const protocol = pickFirstProperty(candidateSources, ['protocol']);
    return { nodeId, nodeNum, shortName, longName, role, metadataSource, nodeData, protocol };
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
   * Compute the class name and HTML for a text-message chat entry, without
   * touching the DOM. Returns ``null`` for encrypted placeholder blobs that
   * should not render. The render path consumes this pure form so the HTML
   * parse can be memoised per message (issue: chat-log render).
   *
   * @param {Object} m Message payload.
   * @returns {{ className: string, html: string }|null} Entry parts or null.
   */
  function buildMessageChatEntryParts(m) {
    let plainText = '';
    if (m?.text != null) {
      plainText = String(m.text).trim();
    }
    if (m?.encrypted && plainText === 'GAA=') {
      return null;
    }

    const tsSeconds = resolveTimestampSeconds(
      m.rx_time ?? m.rxTime,
      m.rx_iso ?? m.rxIso
    );
    const tsDate = tsSeconds != null ? new Date(tsSeconds * 1000) : null;
    const ts = tsDate ? formatTime(tsDate) : '--:--:--';
    const messageProtocol = pickFirstProperty([m, m?.node], ['protocol']);

    const nodeProtocolPrefix = protocolIconPrefixHtml(messageProtocol);

    // Delegate reply-prefix / mention / body / encrypted rendering to the
    // shared chat entry renderer so the dashboard and the node detail page
    // produce identical message HTML.  The renderer also returns the parsed
    // MeshCore sender prefix and any name-resolved sender node so we can
    // reuse them for the badge below without duplicating the lookup.
    const { html: text, meshcoreSenderNode } = renderChatEntryContent({
      message: m,
      nodesById,
      messagesById,
      renderShortHtml,
      escapeHtml,
      renderEmojiHtml,
      formatEncryptedMessageNotice,
    });

    // Sender badge: prefer the ingestor-hydrated node; fall back to the
    // MeshCore name-based lookup performed inside the shared renderer for
    // channel messages whose sender wasn't yet known to the contacts roster.
    let short;
    if (!m.node && meshcoreSenderNode) {
      short = renderShortHtml(
        meshcoreSenderNode.short_name ?? meshcoreSenderNode.shortName,
        meshcoreSenderNode.role,
        meshcoreSenderNode.long_name ?? meshcoreSenderNode.longName,
        meshcoreSenderNode
      );
    } else {
      short = renderShortHtml(m.node?.short_name, m.node?.role, m.node?.long_name, m.node);
    }
    const metadata = extractChatMessageMetadata(m);
    const prefix = formatChatMessagePrefix({
      timestamp: escapeHtml(ts),
      frequency: metadata.frequency ? escapeHtml(metadata.frequency) : ''
    });
    const presetTag = formatChatPresetTag({ presetCode: metadata.presetCode });
    return {
      className: 'chat-entry-msg',
      html: `${prefix}${presetTag} ${nodeProtocolPrefix}${short} ${text}`
    };
  }

  /**
   * Materialise a text-message chat entry as a DOM element. Thin wrapper over
   * {@link buildMessageChatEntryParts} retained for the test-utility surface;
   * the render path uses the parts form directly so it can memoise the parse.
   *
   * @param {Object} m Message payload.
   * @returns {HTMLElement|null} Chat log element, or null for hidden blobs.
   */
  function createMessageChatEntry(m) {
    const parts = buildMessageChatEntryParts(m);
    return parts ? materializeEntryNode(parts) : null;
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
   *   traceEntries?: Array<Object>,
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
    traceEntries = [],
    filterQuery = ''
  }) {
    if (!CHAT_ENABLED || !chatEl) return;
    // Reset the message→tab map for this render; buildChatFragment repopulates it
    // as it materialises each channel tab's entries (SPEC VF3 tab flash).
    messageTabId = new Map();
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
      traces: traceEntries,
      messages,
      logOnlyMessages: encryptedMessages,
      nowSeconds,
      windowSeconds: CHAT_RECENT_WINDOW_SECONDS,
      maxChannelIndex: MAX_CHANNEL_INDEX,
      primaryChannelFallbackLabel: config.channel
    });

    const enrichedLogEntries = attachNodeContextToLogEntries(logEntries);
    // When a protocol is hidden, exclude its entries from the chat display.
    // Entries without a resolved node are kept; entries with a node but a
    // null/missing protocol are treated as meshtastic (the default protocol).
    const protocolVisibleEntries = hiddenProtocols.size > 0
      ? enrichedLogEntries.filter(e => {
        if (!e || !e.node) return true;
        const proto = normalizeFilterProtocol(e.node.protocol);
        return !hiddenProtocols.has(proto);
      })
      : enrichedLogEntries;
    const protocolVisibleChannels = hiddenProtocols.size > 0
      ? channels.filter(ch => {
        const proto = ch.protocol ? normalizeFilterProtocol(ch.protocol) : null;
        return !proto || !hiddenProtocols.has(proto);
      })
      : channels;
    const { logEntries: filteredLogEntries, channels: filteredChannels } = filterChatModel(
      { logEntries: protocolVisibleEntries, channels: protocolVisibleChannels },
      filterQuery
    );

    const logContent = buildChatFragment({
      namespace: 'log',
      entries: filteredLogEntries,
      renderParts: buildChatLogEntryParts,
      keyOf: chatLogEntryKey,
      emptyLabel: 'No recent mesh activity.'
    });

    const channelTabs = filteredChannels.map(channel => {
      const tabId = channel.id || `channel-${channel.index}`;
      return {
        id: tabId,
        label: `${channel.label} (${channel.messageCount})`,
        iconSrc: isMeshtasticProtocol(channel.protocol)
          ? MESHTASTIC_ICON_SRC
          : isMeshcoreProtocol(channel.protocol)
            ? MESHCORE_ICON_SRC
            : null,
        // Channel tabs are the chat proper: render the entire window (issue #796)
        // rather than only the newest CHAT_LIMIT.  The entry set is already bounded
        // by the seven-day window, so there is no count cap to apply here.
        content: buildChatFragment({
          namespace: tabId,
          entries: channel.entries.map(e => ({ ts: e.ts, item: e.message })),
          renderParts: entry => buildMessageChatEntryParts(entry.item),
          keyOf: entry => chatMessageEntryKey(entry.item),
          emptyLabel: 'No messages on this channel.',
          limit: Infinity
        }),
        index: channel.index,
        isPrimaryFallback: Boolean(channel.isPrimaryFallback)
      };
    });

    const tabs = [
      { id: 'log', label: 'Log', content: logContent },
      ...channelTabs
    ];
    // Release entry-node caches for tabs no longer present (e.g. a channel that
    // dropped out of the window) so cached DOM nodes are not retained forever.
    chatEntryCache.retainNamespaces(new Set(tabs.map(tab => tab.id)));

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
    // renderChatTabs now owns chat-panel scroll: it pins to the bottom on the
    // initial render and tail-follows a bottom-pinned reader, but preserves the
    // vertical position on a passive live refresh (bugfix B). No extra
    // force-scroll here — that was what reset the reader to the bottom every tick.
  }

  /**
   * Build a div element from precomputed entry parts (class name + HTML). This
   * is the single place a chat entry is parsed from an HTML string; both the
   * node-returning ``create…Entry`` test wrappers and {@link chatEntryCache}
   * funnel through it.
   *
   * @param {{ className: string, html: string }} parts Entry class name and HTML.
   * @returns {HTMLElement} Entry element.
   */
  function materializeEntryNode({ className, html }) {
    const div = document.createElement('div');
    div.className = className;
    div.innerHTML = html;
    return div;
  }

  /**
   * Construct a document fragment for chat entries, inserting date dividers and
   * an optional empty-state label. Entry nodes are sourced from
   * {@link chatEntryCache}, so an entry whose rendered HTML is unchanged since
   * the previous refresh is reused rather than re-parsed (issue: chat-log
   * render). Entries that aged out of this tab's window are pruned from the
   * cache afterwards.
   *
   * @param {{
   *   namespace: string,
   *   entries: Array<{ ts: number, item?: Object }>,
   *   renderParts: Function,
   *   keyOf: Function,
   *   emptyLabel?: string,
   *   limit?: number
   * }} params Fragment construction parameters.  ``namespace`` scopes the entry
   *   cache to a single tab; ``limit`` caps how many of the newest entries are
   *   rendered (pass ``Infinity`` to render them all — the Log firehose defaults
   *   to {@link CHAT_LIMIT}, chat channel tabs opt out).
   * @returns {DocumentFragment} Populated fragment.
   */
  function buildChatFragment({ namespace, entries = [], renderParts, keyOf, emptyLabel, limit = CHAT_LIMIT }) {
    const fragment = document.createDocumentFragment();
    const getDivider = createDateDividerFactory();
    const limitedEntries = Number.isFinite(limit)
      ? entries.slice(Math.max(entries.length - limit, 0))
      : entries;
    let renderedEntries = 0;
    for (const entry of limitedEntries) {
      if (!entry || typeof entry.ts !== 'number') {
        continue;
      }
      if (typeof renderParts !== 'function' || typeof keyOf !== 'function') {
        continue;
      }
      const parts = renderParts(entry);
      if (!parts) {
        continue;
      }
      const node = chatEntryCache.materialize(namespace, keyOf(entry), parts.className, parts.html);
      // Tag message rows so a live update can flash them (SPEC VF3); for channel
      // tabs (namespace is the tab id, not 'log') record the message→tab id so
      // the channel's tab header can flash too.
      const messageId = entryMessageId(entry);
      if (messageId) {
        node.dataset.messageId = messageId;
        if (namespace !== 'log') messageTabId.set(messageId, namespace);
        // Stamp the sender's role colour so the live-update fade lands on it
        // (LV3). Falls back to the CSS default when the sender node is unknown.
        const flashMessage = entry.item || entry.message;
        const senderId = flashMessage && (flashMessage.from_id || flashMessage.fromId);
        const senderNode = senderId ? nodesById.get(senderId) : null;
        if (senderNode && node.style && typeof node.style.setProperty === 'function') {
          node.style.setProperty('--flash-role-color', getRoleFlashColor(senderNode.role, senderNode.protocol));
        }
      }
      const divider = getDivider(entry.ts);
      if (divider) fragment.appendChild(divider);
      fragment.appendChild(node);
      renderedEntries += 1;
    }
    // Drop cached nodes for entries no longer present in this tab's window.
    chatEntryCache.prune(namespace);
    if (renderedEntries === 0 && emptyLabel) {
      const empty = document.createElement('p');
      empty.className = 'chat-empty';
      empty.textContent = emptyLabel;
      fragment.appendChild(empty);
    }
    return fragment;
  }

  /**
   * Closure-bound dependency-injection bridge to ``fetchMessagesImpl``.  The
   * implementation in ``./main/data-fetchers.js`` is dependency-free so it
   * can be unit tested standalone; this shim feeds it the dashboard's
   * ``CHAT_ENABLED`` flag and ``normaliseMessageLimit`` from
   * ``initializeApp``'s closure.  **Do not inline** — keeping the wrapper
   * preserves the chat-enabled and limit-normalisation flags as injected
   * dependencies so the underlying fetcher remains pure.
   *
   * @param {number} [limit=MESSAGE_LIMIT] Requested limit.
   * @param {{ encrypted?: boolean, since?: number }} [options] Optional retrieval flags.
   * @returns {Promise<Array<Object>>} Message payloads.
   */
  function fetchMessages(limit = MESSAGE_LIMIT, options = {}) {
    return fetchMessagesImpl(limit, {
      ...options,
      chatEnabled: CHAT_ENABLED,
      normaliseMessageLimit,
    });
  }

  /**
   * Hydrate one page of older messages and merge it into the live chat state,
   * then re-render the chat log.  The read-modify-write of ``allMessages`` is
   * synchronous (no ``await`` between the merge and the assignment) so a
   * concurrent incremental {@link refresh} cannot clobber the history this adds.
   *
   * @param {Array<Object>} batch Raw older message rows from the backfill pager.
   * @returns {Promise<void>} Resolves once the page is merged and rendered.
   */
  async function commitHistoricalMessages(batch) {
    if (!Array.isArray(batch) || batch.length === 0) return;
    const hydrated = await messageNodeHydrator.hydrate(batch, nodesById);
    const rows = Array.isArray(hydrated) ? hydrated : [];
    if (rows.length === 0) return;
    const floor = Math.floor(Date.now() / 1000) - CHAT_RECENT_WINDOW_SECONDS;
    allMessages = trimToWindow(mergeById(allMessages, rows, 'id'), floor);
    rerenderChatLog();
  }

  /**
   * Stream the rest of the chat window in the background once the initial load
   * has rendered the newest page (issue #802).  Pages backward from the oldest
   * loaded message, committing and rendering each page as it arrives so the feed
   * fills progressively while the main thread stays responsive — every awaited
   * fetch yields to the event loop, so this is cooperative background work
   * rather than a blocking burst (a true Worker cannot touch the DOM).  A guard
   * prevents overlapping runs.
   *
   * @returns {Promise<void>} Resolves when the window is exhausted (or on error).
   */
  async function backfillChatHistory() {
    if (!CHAT_ENABLED || chatBackfillRunning) return;
    // Page backward from the live frontier (oldest row of the newest delta
    // page), not the global-oldest loaded row. On a cold load they are equal;
    // on a warm-cache load the cache contributes older rows, so anchoring at the
    // global min would page below the cache and never fill the gap between the
    // cache's newest row and the newest page's oldest row (the orphaned middle
    // window). Falls back to the global min when no live page was fetched.
    const before = chatLiveFrontier > 0
      ? chatLiveFrontier
      : minRecordTimestamp(allMessages, ['rx_time']);
    if (!(before > 0)) return;
    chatBackfillRunning = true;
    try {
      for await (const batch of paginateMessagesImpl(MESSAGE_LIMIT, {
        before,
        chatEnabled: CHAT_ENABLED,
        normaliseMessageLimit,
      })) {
        await commitHistoricalMessages(batch);
      }
    } catch (err) {
      console.warn('chat history backfill failed; showing the most recent page only', err);
    } finally {
      chatBackfillRunning = false;
    }
  }

  /**
   * Re-aggregate the per-source snapshot arrays and re-enrich the node
   * collection (display name, position, distance, telemetry) from the current
   * module-level ``all*`` sources, then rebuild the node lookup index. Shared by
   * {@link refresh} and the background collection backfill (issue #832) so a
   * streamed history page derives the rendered node state identically to a full
   * refresh. Does not touch ``allMessages`` / ``allEncryptedMessages`` (hydrated
   * separately) or ``allTraces`` (not node-derived).
   *
   * @returns {void}
   */
  function rebuildNodeDerivedState() {
    const aggregatedNodes = aggregateNodeSnapshots(allNodes);
    const aggregatedPositions = aggregatePositionSnapshots(allPositionEntries);
    const aggregatedTelemetry = aggregateTelemetrySnapshots(allTelemetryEntries);
    // Enrich merged node records with display name, position, distance, and
    // telemetry before any rendering or filtering takes place.
    aggregatedNodes.forEach(applyNodeNameFallback);
    mergePositionsIntoNodes(aggregatedNodes, aggregatedPositions);
    computeDistances(aggregatedNodes);
    mergeTelemetryIntoNodes(aggregatedNodes, aggregatedTelemetry);
    normalizeNodeCollection(aggregatedNodes);
    allNodes = aggregatedNodes;
    // Rebuild lookup maps so marker updates and message hydration always resolve
    // to the latest node objects.
    rebuildNodeIndex(allNodes);
    // The per-packet accumulators (allTelemetryEntries / allPositionEntries /
    // allNeighbors) are deliberately left RAW — the aggregated forms above are
    // locals used only to enrich the node records. Writing an aggregate back into
    // an accumulator would feed it into the next refresh's merge + re-aggregation,
    // which is lossy: aggregateSnapshots clones with ``{...snapshot}`` (dropping
    // the non-enumerable ``snapshots`` history) and merges oldest-last (pinning to
    // the stalest reading), collapsing each node's history to {stale-first, newest}
    // so a telemetry/position Log entry flashes in and vanishes on the next tick.
    // Keeping the accumulators raw gives every packet a stable, id-keyed Log entry
    // (bugfix A1).
  }

  /** Floor (unix s) below which backfilled positions/telemetry are dropped (FC3: 7 d). */
  const recentBackfillFloor = () => Math.floor(Date.now() / 1000) - CHAT_RECENT_WINDOW_SECONDS;
  /** Floor (unix s) below which backfilled neighbors/traces are dropped (FC3: 28 d). */
  const longBackfillFloor = () => Math.floor(Date.now() / 1000) - TRACE_MAX_AGE_SECONDS;

  /**
   * Per-collection wiring for the background backfill (issue #832). Each entry
   * knows how to fetch a backward page (inclusive ``before`` cursor on the
   * route's primary sort column), how to identify a row for cross-page
   * de-duplication, which cursor value advances the walk, how to merge a page
   * into the module state (bounded by the same window the refresh tick uses), and
   * how to re-derive the rendered state the merged collection feeds.
   *
   * Cursor columns match each route's server-side ``ORDER BY`` (SPEC BP1):
   * ``last_heard`` for nodes, ``rx_time`` for the rest.
   *
   * @type {ReadonlyArray<Object>}
   */
  const COLLECTION_BACKFILLS = [
    {
      name: 'nodes',
      fetchPage: (limit, before) => fetchNodes(limit, 0, { before }),
      idOf: row => row && row.node_id,
      cursorOf: row => row && row.last_heard,
      merge: batch => { allNodes = mergeById(allNodes, batch, 'node_id'); },
      refine: () => rebuildNodeDerivedState(),
    },
    {
      name: 'positions',
      fetchPage: (limit, before) => fetchPositions(limit, 0, { before }),
      idOf: row => row && row.id,
      cursorOf: row => row && row.rx_time,
      merge: batch => {
        allPositionEntries = trimToWindow(mergeById(allPositionEntries, batch, 'id'), recentBackfillFloor());
      },
      refine: () => rebuildNodeDerivedState(),
    },
    {
      name: 'telemetry',
      fetchPage: (limit, before) => fetchTelemetry(limit, 0, { before }),
      idOf: row => row && row.id,
      cursorOf: row => row && row.rx_time,
      merge: batch => {
        allTelemetryEntries = trimToWindow(mergeById(allTelemetryEntries, batch, 'id'), recentBackfillFloor());
      },
      refine: () => rebuildNodeDerivedState(),
    },
    {
      name: 'neighbors',
      fetchPage: (limit, before) => fetchNeighbors(limit, 0, { before }),
      // Composite primary key (node_id, neighbor_id) — unique per tuple, so the
      // inclusive boundary row is de-duplicated across pages.
      idOf: row => (row ? `${row.node_id}|${row.neighbor_id}` : undefined),
      cursorOf: row => row && row.rx_time,
      merge: batch => {
        allNeighbors = trimToWindow(
          mergeByCompositeKey(allNeighbors, batch, ['node_id', 'neighbor_id']),
          longBackfillFloor(),
        );
      },
      // Neighbors stay RAW (like traces) so the Log keeps every per-pair snapshot
      // and the map / overlay consumers dedupe internally; re-aggregating here
      // would erode history exactly as the refresh path used to (bugfix A1).
      refine: () => {},
    },
    {
      name: 'traces',
      // Fetch raw (applyAgeFilter:false) so the pager sees the server's true page
      // length for short-page termination; the age bound is applied by the
      // window-trim in merge() instead.
      fetchPage: (limit, before) => fetchTraces(limit, 0, { before, applyAgeFilter: false }),
      idOf: row => row && row.id,
      cursorOf: row => row && row.rx_time,
      merge: batch => {
        allTraces = trimToWindow(mergeById(allTraces, batch, 'id'), longBackfillFloor());
      },
      refine: () => {},
    },
  ];

  /**
   * Merge one streamed backward page into the module state, re-derive what it
   * feeds, and repaint — progressively, one page at a time, mirroring the chat
   * history backfill (issue #802). The merge + re-render is synchronous (no
   * ``await``) so it cannot interleave with a concurrent refresh or another
   * collection's commit. Each page is network-spaced, so the per-page render is
   * not a hot loop; the stats fetch is skipped (the authoritative count is
   * server-computed and unchanged by how many rows the client has paged in).
   *
   * @param {Object} spec One {@link COLLECTION_BACKFILLS} entry.
   * @param {Array<Object>} batch Freshly-seen rows for this page (the pager only
   *   ever yields a non-empty array).
   * @returns {void}
   */
  function commitBackfillPage(spec, batch) {
    spec.merge(batch);
    spec.refine();
    renderFilteredOutputs();
  }

  /**
   * Page one collection backward from its live frontier, committing+rendering
   * each page, until the visibility window is exhausted. A no-op (no request)
   * when the collection recorded no frontier — a short newest page or a warm-cache
   * load. Errors are swallowed (logged) so one failing stream never aborts the
   * others or the rendered newest page — mirroring {@link backfillChatHistory}.
   *
   * @param {Object} spec One {@link COLLECTION_BACKFILLS} entry.
   * @returns {Promise<void>} Resolves when this collection's window is exhausted.
   */
  async function backfillCollection(spec) {
    const before = collectionLiveFrontiers[spec.name];
    if (!(before > 0)) return;
    try {
      for await (const batch of paginateCollection(spec.fetchPage, {
        limit: NODE_LIMIT,
        before,
        idOf: spec.idOf,
        cursorOf: spec.cursorOf,
      })) {
        commitBackfillPage(spec, batch);
      }
    } catch (err) {
      console.warn(`${spec.name} backfill failed; showing the most recent page only`, err);
    }
  }

  /**
   * One-shot background backfill of every bulk collection (issue #832). After
   * the first paint has rendered each collection's newest page, page the five
   * collections backward through their visibility windows concurrently, each
   * committing+repainting its pages as they arrive. Each {@link backfillCollection}
   * self-gates on its frontier, so a collection with none (a short newest page, or
   * a warm-cache load) returns without a request and the fan-out is a clean no-op
   * when there is nothing to page — no pointless request, no empty long-load.
   * Invoked once (guarded by ``collectionsBackfilled`` in {@link refresh}).
   *
   * @returns {Promise<void>} Resolves when every collection's window is exhausted.
   */
  async function backfillAllCollections() {
    await Promise.all(COLLECTION_BACKFILLS.map(spec => backfillCollection(spec)));
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
      // Row-level node id hook for live-update flashes (SPEC VF3); kept distinct
      // from the inner link's data-node-id so it never affects click handling.
      if (typeof n.node_id === 'string' && n.node_id) {
        tr.dataset.nodeRow = n.node_id;
      }
      // Stamp the role colour so the live-update fade lands on it (LV3); the CSS
      // keyframe reads --flash-role-color, so the flash helper needs no colour.
      if (tr.style && typeof tr.style.setProperty === 'function') {
        tr.style.setProperty('--flash-role-color', getRoleFlashColor(n.role, n.protocol));
      }
      const lastPositionTime = toFiniteNumber(n.position_time ?? n.positionTime);
      const lastPositionCell = lastPositionTime != null ? timeAgo(lastPositionTime, nowSec) : '';
      const latitudeDisplay = fmtCoords(n.latitude);
      const longitudeDisplay = fmtCoords(n.longitude);
      const nodeDisplayName = getNodeDisplayNameForOverlay(n);
      const modemMetadata = extractModemMetadata(n);
      const loraFrequencyText = formatLoraFrequencyMHz(modemMetadata.loraFreq);
      const loraFrequencyDisplay = loraFrequencyText ? escapeHtml(loraFrequencyText) : '';
      const resolvedPreset = formatPresetDisplay(modemMetadata.modemPreset, modemMetadata.loraFreq);
      const modemPresetDisplay = resolvedPreset ? escapeHtml(resolvedPreset) : '';
      const longNameHtml = renderNodeLongNameLink(n.long_name, n.node_id);
      const protocolIconCell = protocolIconPrefixHtml(n.protocol);
      tr.innerHTML = `
        <td class="nodes-col nodes-col--protocol">${protocolIconCell}</td>
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
   * Project a base coordinate to its co-located display position by adding a
   * pixel-space offset against the live map projection.
   *
   * @param {number} lat Original latitude in degrees.
   * @param {number} lon Original longitude in degrees.
   * @param {number} dx Pixel offset along the layer-point X axis.
   * @param {number} dy Pixel offset along the layer-point Y axis.
   * @returns {[number, number]} Display ``[lat, lng]`` for the marker.
   */
  function projectColocatedOffsetLatLng(lat, lon, dx, dy) {
    if (dx === 0 && dy === 0) return [lat, lon];
    const basePoint = map.latLngToLayerPoint([lat, lon]);
    const offsetPoint = L.point(basePoint.x + dx, basePoint.y + dy);
    const projected = map.layerPointToLatLng(offsetPoint);
    return [projected.lat, projected.lng];
  }

  /**
   * Re-project every co-located marker (and its spider leader line) so the
   * pixel gap between markers stays constant after the user zooms.  Wired to
   * the map's ``zoomend`` and ``viewreset`` events from {@link initializeApp},
   * and reached via the rAF-throttled {@link scheduleColocatedSpiderRefresh}
   * for the per-frame ``zoom`` event.
   *
   * @returns {void}
   */
  function refreshColocatedSpiderState() {
    if (!map) return;
    refreshSpiderPositions(colocatedSpiderState, projectColocatedOffsetLatLng);
  }

  /**
   * Throttled wrapper around {@link refreshColocatedSpiderState} that
   * coalesces multiple ``zoom`` events fired inside a single animation frame
   * into one update.  Falls back to an immediate call when the host has no
   * ``requestAnimationFrame`` (e.g. unit-test environments).
   *
   * @returns {void}
   */
  function scheduleColocatedSpiderRefresh() {
    if (typeof requestAnimationFrame !== 'function') {
      refreshColocatedSpiderState();
      return;
    }
    if (pendingSpiderRefreshHandle !== null) return;
    pendingSpiderRefreshHandle = requestAnimationFrame(() => {
      pendingSpiderRefreshHandle = null;
      refreshColocatedSpiderState();
    });
  }

  /**
   * Classify the current zoom level relative to ``COLOCATED_HUB_MIN_ZOOM``.
   *
   * Returns ``'low'`` when the user is zoomed out far enough that the
   * collapsed-hub representation should not be drawn (markers stack at the
   * shared coordinate instead) and ``'high'`` otherwise.  Defaults to
   * ``'high'`` when the map is missing or its ``getZoom`` returns a
   * non-finite value, which preserves the pre-feature behaviour during
   * early init / tests where the projection is not yet available.
   *
   * @returns {'low'|'high'} Bucket name for the current zoom level.
   */
  function currentZoomBucket() {
    if (!map || typeof map.getZoom !== 'function') return 'high';
    const zoom = map.getZoom();
    if (!Number.isFinite(zoom)) return 'high';
    return zoom < COLOCATED_HUB_MIN_ZOOM ? 'low' : 'high';
  }

  /**
   * Wired to the map's ``zoomend`` event in addition to the spider
   * re-projection.  When the user crosses the
   * ``COLOCATED_HUB_MIN_ZOOM`` threshold in either direction we forget the
   * previously-expanded hub state and trigger a full re-render through
   * {@link applyFilter}, since the marker representation switches between
   * "flat overlap" and "hub badge" modes.
   *
   * @returns {void}
   */
  function handleZoomEndForColocatedHubs() {
    refreshColocatedSpiderState();
    const bucket = currentZoomBucket();
    if (bucket !== lastRenderedZoomBucket) {
      expandedColocatedKeys.clear();
      // Bucket flips only swap the marker representation; the node table,
      // chat log, and active-stats counts are unaffected, so we re-render
      // just the map rather than running the full applyFilter pipeline.
      rerenderMapForFiltering();
    }
  }

  /**
   * Build the small "asterisk + count" hub badge that represents a collapsed
   * (or expanded-but-still-visible) co-located group.  The badge is a
   * Leaflet ``L.marker`` backed by an ``L.divIcon`` so the visual is HTML/CSS
   * (themable via ``var(--fg)`` / ``var(--bg)``) rather than the SVG
   * ``L.circleMarker`` used for node points.
   *
   * Clicking the hub toggles ``expandedColocatedKeys`` for ``groupKey`` and
   * triggers a full re-render via {@link applyFilter}.  The hub deliberately
   * does NOT participate in the node-info overlay — it is a control rather
   * than a node anchor — so the click handler stops propagation to keep the
   * ``overlayStack`` close path from also firing.
   *
   * @param {string} groupKey Bucket key from {@link computeColocatedOffsets}.
   * @param {number} groupSize Number of (visible) nodes in the group.
   * @param {number} lat Latitude of the shared centre.
   * @param {number} lon Longitude of the shared centre.
   * @returns {Object} The created Leaflet marker, already added to the layer.
   */
  function createColocatedHubMarker(groupKey, groupSize, lat, lon) {
    // ``bubblingMouseEvents: false`` keeps Leaflet's internal event system
    // from forwarding the click to the map and any registered map-level
    // ``click`` handlers (e.g. overlay close).  ``riseOnHover`` is omitted
    // intentionally — it is documented for the default raster icon's
    // z-index handling and behaves inconsistently with ``divIcon`` across
    // Leaflet versions; layer ordering (``colocatedHubsLayer`` is added
    // *after* ``markersLayer``) keeps the hub on top reliably.
    const marker = L.marker([lat, lon], {
      icon: getColocatedHubIcon(groupSize),
      keyboard: false,
      bubblingMouseEvents: false
    });
    marker.on('click', event => {
      // Stop the Leaflet event from bubbling to the map's own click handlers
      // and stop the raw DOM event so the ``overlayStack`` close path does
      // not also fire.  We use the Leaflet helper rather than only the raw
      // DOM stopPropagation because Leaflet routes events through its own
      // pipeline before the browser does.
      if (event && L && L.DomEvent && typeof L.DomEvent.stopPropagation === 'function') {
        L.DomEvent.stopPropagation(event);
      }
      if (event && event.originalEvent && typeof event.originalEvent.stopPropagation === 'function') {
        event.originalEvent.stopPropagation();
      }
      if (expandedColocatedKeys.has(groupKey)) {
        expandedColocatedKeys.delete(groupKey);
      } else {
        expandedColocatedKeys.add(groupKey);
      }
      // Surgical re-render: only the map's marker representation changed.
      // The table, chat log, and active-stats counts stay valid, so we skip
      // the full applyFilter pipeline (and its ``/api/stats`` fetch) — that
      // saves a round-trip per click and keeps rapid expand/collapse cheap.
      rerenderMapForFiltering();
    });
    marker.addTo(colocatedHubsLayer);
    return marker;
  }

  /**
   * Lookup or lazily create the divIcon used to render a hub badge for a
   * group of ``groupSize`` co-located nodes.  Icons are cached because
   * Leaflet allows the same icon instance to be shared across markers, the
   * underlying DOM element is cloned per marker, and ``L.divIcon`` itself
   * is non-trivially expensive at the volumes this feature can produce
   * (every render creates one icon per multi-node group).  The cache is
   * keyed by ``groupSize`` because the html string is the only thing that
   * varies between groups; it is bounded in practice (typical group sizes
   * are small single digits) so it never grows large enough to warrant
   * eviction.
   *
   * Theme changes do not invalidate the cache: the icon's html only carries
   * the static text label and class hooks; all colour / border styling
   * comes from CSS variables that resolve at paint time.
   *
   * @param {number} groupSize Number of visible nodes in the group.
   * @returns {Object} Cached or freshly-created Leaflet divIcon.
   */
  function getColocatedHubIcon(groupSize) {
    const cached = colocatedHubIconCache.get(groupSize);
    if (cached) return cached;
    const icon = L.divIcon({
      html: '<span class="colocated-spider-hub__glyph">*' + groupSize + '</span>',
      className: 'colocated-spider-hub',
      iconSize: [16, 16],
      iconAnchor: [8, 8]
    });
    colocatedHubIconCache.set(groupSize, icon);
    return icon;
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
    if (traceLinesLayer) {
      traceLinesLayer.clearLayers();
    }
    if (spiderLinesLayer) {
      spiderLinesLayer.clearLayers();
    }
    if (colocatedHubsLayer) {
      colocatedHubsLayer.clearLayers();
    }
    // Drop the previous render's spider records before populating them again
    // so the zoom handler does not try to reposition stale Leaflet objects.
    colocatedSpiderState = [];
    // Capture the zoom bucket the upcoming render targets so the zoomend
    // handler can detect threshold crossings on the next zoom event.
    lastRenderedZoomBucket = currentZoomBucket();
    // Snapshot any open marker overlay before clearing the layer (item 7):
    // clearLayers() destroys each marker's DOM element, which would orphan an
    // open overlay and let cleanupOrphans() close it. We re-anchor to the
    // rebuilt markers after the render below so the overlay stays open.
    const preservedMarkerOverlays = captureOpenMarkerOverlays(overlayStack, markerByNodeId);
    markersLayer.clearLayers();
    // Reset the node→marker map for this render so live-update flashes target
    // the current markers (SPEC VF3).
    markerByNodeId = new Map();
    const pts = [];
    const nodesById = new Map();
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue;
      const nodeId = node.node_id;
      if (typeof nodeId !== 'string' || nodeId.length === 0) continue;
      nodesById.set(nodeId, node);
    }
    const traceSegments = traceLinesLayer
      ? buildTraceSegments(allTraces, nodes, {
          limitDistance: LIMIT_DISTANCE,
          maxDistanceKm: MAX_DISTANCE_KM,
          colorForNode: node => getRoleColor(node.role, node.protocol)
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

        const priority = getRoleRenderPriority(sourceNode.role, sourceNode.protocol);
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
          color: getRoleColor(sourceNode.role, sourceNode.protocol),
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
          if (polyline && typeof polyline.bindTooltip === 'function') {
            const tooltipHtml = buildNeighborTooltipHtml({
              ...segment,
              sourceNode: nodesById.get(segment.sourceId),
              targetNode: nodesById.get(segment.targetId)
            });
            if (tooltipHtml) {
              polyline.bindTooltip(tooltipHtml, {
                direction: 'center',
                opacity: 0.92,
                sticky: true,
                className: 'trace-tooltip'
              });
            }
          }
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
              if (polyline && typeof polyline.isTooltipOpen === 'function' && typeof polyline.openTooltip === 'function') {
                if (polyline.isTooltipOpen()) {
                  polyline.closeTooltip();
                } else {
                  polyline.openTooltip();
                }
              }
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

    if (traceLinesLayer && traceSegments.length) {
      traceSegments
        .sort((a, b) => {
          const rxA = Number.isFinite(a.rxTime) ? a.rxTime : -Infinity;
          const rxB = Number.isFinite(b.rxTime) ? b.rxTime : -Infinity;
          if (rxA === rxB) return 0;
          return rxA - rxB;
        })
        .forEach(segment => {
          const polyline = L.polyline(segment.latlngs, {
            color: segment.color,
            weight: 2,
            opacity: 0.42,
            dashArray: '6 6',
            className: 'neighbor-connection-line trace-connection-line'
          }).addTo(traceLinesLayer);
          if (polyline && typeof polyline.bindTooltip === 'function') {
            const tooltipHtml = buildTraceTooltipHtml(segment.pathNodes);
            if (tooltipHtml) {
              polyline.bindTooltip(tooltipHtml, {
                direction: 'center',
                opacity: 0.92,
                sticky: true,
                className: 'trace-tooltip'
              });
            }
          }
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
              if (polyline && typeof polyline.isTooltipOpen === 'function' && typeof polyline.openTooltip === 'function') {
                if (polyline.isTooltipOpen()) {
                  polyline.closeTooltip();
                } else {
                  polyline.openTooltip();
                }
              }
            });
          }
        });
    }

    const nodesByRenderOrder = nodes
      .map((node, index) => ({ node, index }))
      .sort((a, b) => {
        const orderA = getRoleRenderPriority(a.node && a.node.role, a.node && a.node.protocol);
        const orderB = getRoleRenderPriority(b.node && b.node.role, b.node && b.node.protocol);
        if (orderA !== orderB) return orderA - orderB;
        return a.index - b.index;
      })
      .map(entry => entry.node);

    // Pre-pass: parse + filter renderable entries once so co-located nodes can
    // be spread visually before any marker is created.  Resolving entries up
    // front (via the helper module so the parsing rules stay unit-testable)
    // means LIMIT_DISTANCE-filtered nodes do not influence per-coordinate
    // group sizes.
    const renderableEntries = buildRenderableEntries(nodesByRenderOrder, {
      maxDistanceKm: LIMIT_DISTANCE ? MAX_DISTANCE_KM : null
    });

    const offsets = computeColocatedOffsets(renderableEntries);

    // Build the set of bucket keys that currently host more than one visible
    // node so we can drop stale entries from ``expandedColocatedKeys`` (a
    // group that lost members to the distance filter, an upstream delete,
    // etc.).  Keys whose group has shrunk to a singleton are pruned here so
    // the remaining slot renders as a normal marker rather than carrying an
    // orphaned "expanded" flag.
    const visibleMultiGroupKeys = new Set();
    for (const slot of offsets) {
      if (slot && slot.groupSize >= 2) visibleMultiGroupKeys.add(slot.groupKey);
    }
    // Snapshot the keys before mutating the live set: ``Set`` iteration
    // during ``delete`` is technically safe per spec, but copying first
    // makes the intent explicit and keeps the loop body straightforward
    // for future maintainers.
    for (const key of Array.from(expandedColocatedKeys)) {
      if (!visibleMultiGroupKeys.has(key)) expandedColocatedKeys.delete(key);
    }

    const zoomBucket = currentZoomBucket();
    // Each multi-node group emits a single hub badge.  Track which keys we
    // have already drawn so we create the hub once even though the offsets
    // array yields one slot per member.
    const renderedHubKeys = new Set();

    for (const slot of offsets) {
      const { entry, dx, dy, groupKey, groupSize } = slot;
      const n = entry.node;
      const { lat, lon } = entry;

      const isMulti = groupSize >= 2;
      const lowZoom = zoomBucket === 'low';
      const isExpanded = isMulti && !lowZoom && expandedColocatedKeys.has(groupKey);
      // Hub badges represent multi-node groups at zoom levels where the
      // collapsed control is meaningful; below the threshold they would just
      // sit in a sea of overlapping markers without conveying useful info.
      const showHub = isMulti && !lowZoom;
      // Singletons always render their marker; multi-node groups render
      // member markers only when the user has expanded the hub (or when the
      // zoom is below the threshold and we fall back to flat overlap).
      const showMarker = !isMulti || lowZoom || isExpanded;
      // Use the helper-level significance test (rather than strict !== 0)
      // because trig at angles like π produces values around 1e-15 which
      // would otherwise pass the strict check and cause us to draw
      // zero-length spider lines.
      const useOffset = isExpanded && isOffsetSignificant(dx, dy);

      if (showHub && !renderedHubKeys.has(groupKey)) {
        createColocatedHubMarker(groupKey, groupSize, lat, lon);
        renderedHubKeys.add(groupKey);
      }

      // Auto-fit bounds always use the original coordinate so the
      // collapse/expand state cannot widen or narrow the fit window.  Push
      // here even when the underlying marker is suppressed so a fully
      // collapsed group still contributes to the bounds.
      pts.push([lat, lon]);

      if (!showMarker) {
        continue;
      }

      // Translate the pixel-space offset into the LatLng to render at.  The
      // baked-in LatLng is correct for the current zoom only; the zoom event
      // handlers re-project on zoom/zoomend/viewreset to keep the gap
      // visually constant when the user changes zoom.
      const markerLatLng = useOffset ? projectColocatedOffsetLatLng(lat, lon, dx, dy) : [lat, lon];

      const color = getRoleColor(n.role, n.protocol);
      const marker = L.circleMarker(markerLatLng, {
        radius: 9,
        color: '#000',
        weight: 1,
        fillColor: color,
        fillOpacity: 0.7,
        opacity: 0.7
      });

      // Draw a faint dotted leader line from each fanned-out marker back to
      // the shared physical location so the spider hub is visually obvious.
      // Singleton / collapsed / low-zoom markers get no line.  Stroke
      // colour, dash, weight and opacity all live in `.colocated-spider-line`
      // so the line can pick up theme-aware tokens (var(--fg)) and stay
      // legible on both light and dark basemaps without code changes here.
      let spiderLine = null;
      if (useOffset && spiderLinesLayer) {
        spiderLine = L.polyline([[lat, lon], markerLatLng], {
          interactive: false,
          className: 'colocated-spider-line'
        }).addTo(spiderLinesLayer);
      }

      const fallbackOverlayProvider = () => mergeOverlayDetails(null, n);
      let markerToken = 0;
      marker.addTo(markersLayer);
      // Remember this node's marker so a live update can flash it (SPEC VF3).
      if (n && typeof n.node_id === 'string' && n.node_id) {
        markerByNodeId.set(n.node_id, marker);
      }
      // Track every offset marker so the zoomend handler can reposition the
      // marker + leader line in lock-step.  Markers rendered at the shared
      // centre (singletons / low-zoom overlap / collapsed-group fallback)
      // skip the record since their position never changes between zooms.
      if (useOffset) {
        colocatedSpiderState.push({ marker, line: spiderLine, lat, lon, dx, dy });
      }

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
    // Re-anchor any overlay preserved above onto its rebuilt marker so it
    // stays open across the re-render instead of being closed by
    // cleanupOrphans (item 7).
    restoreMarkerOverlays(overlayStack, preservedMarkerOverlays, markerByNodeId);
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
   * Filters use compound ``"<protocol>:<roleKey>"`` keys so that shared role
   * names (e.g. ``SENSOR``, ``REPEATER``) can be toggled independently per
   * protocol.  Nodes whose protocol is null/absent are treated as Meshtastic
   * (via {@link normalizeFilterProtocol}) to keep legacy records visible when
   * the Meshtastic SENSOR filter is active.
   *
   * @param {Object} node Node payload.
   * @returns {boolean} True when the node should be visible.
   */
  function matchesRoleFilter(node) {
    if (!activeRoleFilters.size) return true;
    const compoundKey = makeRoleFilterKey(node && node.role, node && node.protocol);
    return !activeRoleFilters.has(compoundKey);
  }

  /**
   * Check whether a node passes the active protocol visibility filters.
   *
   * Nodes with a null/absent protocol are always shown — hiding
   * ``'meshtastic'`` hides only nodes that explicitly carry that protocol
   * value.  Pre-protocol legacy records remain visible regardless.
   *
   * @param {Object} node Node payload.
   * @returns {boolean} True when the node should be visible.
   */
  function matchesProtocolFilter(node) {
    if (!hiddenProtocols.size) return true;
    const protocol = (node && node.protocol) || null;
    if (protocol && hiddenProtocols.has(protocol)) return false;
    return true;
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
   * Return a copy of the stats object with totals reduced by the counts of
   * any protocols the user has explicitly hidden.
   *
   * Per-protocol sub-objects are left untouched so legend column counts and
   * visibility decisions still use the raw server values.
   *
   * @param {Object|null} stats Normalised stats from ``/api/stats``.
   * @returns {Object|null} Adjusted stats (new object) or the original if nothing is hidden.
   */
  function adjustStatsForHiddenProtocols(stats) {
    if (!hiddenProtocols.size || !stats) return stats;
    const adjusted = { ...stats };
    for (const protocol of hiddenProtocols) {
      const bucket = stats[protocol];
      if (!bucket || typeof bucket !== 'object') continue;
      for (const key of ['hour', 'day', 'week', 'month']) {
        if (typeof adjusted[key] === 'number' && typeof bucket[key] === 'number') {
          adjusted[key] = Math.max(0, adjusted[key] - bucket[key]);
        }
      }
    }
    return adjusted;
  }

  /**
   * Re-run the active text/role/protocol filter pipeline over ``allNodes``
   * and return the nodes that should currently render on the map and table.
   * Pulled out of {@link applyFilter} so the colocated-hub click handler and
   * the zoom-bucket-crossing handler can call it without paying for the
   * table re-render, chat-log re-render, or stats fetch — none of which are
   * affected by either of those events.
   *
   * @returns {Array<Object>} Filtered + sorted node list.
   */
  function getFilteredSortedNodes() {
    const filterQuery = filterInput ? filterInput.value : '';
    const q = normaliseChatFilterQuery(filterQuery);
    const filteredNodes = allNodes.filter(n => matchesTextFilter(n, q) && matchesRoleFilter(n) && matchesProtocolFilter(n));
    return sortNodes(filteredNodes);
  }

  /**
   * Re-render only the map markers (hub badges, member markers, leader
   * lines) without touching the node table, chat log, page title, or the
   * ``/api/stats`` fetch.  Used for events that only affect the marker
   * representation — currently the colocated-hub expand/collapse click and
   * the zoom-bucket threshold crossing — so we avoid the full
   * {@link applyFilter} pipeline that those events would otherwise trigger.
   *
   * @returns {void}
   */
  function rerenderMapForFiltering() {
    renderMap(getFilteredSortedNodes(), Date.now() / 1000);
  }

  /**
   * Re-render only the chat log from the current message/node/telemetry state.
   * Used both by {@link applyFilter} and by the background history backfill
   * (issue #802) so each streamed page repaints the chat without re-running the
   * full filter pipeline (node table, map, ``/api/stats`` fetch).
   *
   * @param {string} [filterQuery] Raw filter text for substring highlighting;
   *   defaults to the current filter input value.
   * @returns {void}
   */
  function rerenderChatLog(filterQuery = filterInput ? filterInput.value : '') {
    renderChatLog({
      nodes: allNodes,
      messages: allMessages,
      encryptedMessages: allEncryptedMessages,
      telemetryEntries: allTelemetryEntries,
      positionEntries: allPositionEntries,
      neighborEntries: allNeighbors,
      traceEntries: allTraces,
      filterQuery
    });
  }

  /**
   * Render the filter-dependent outputs — node table, map markers, sort
   * indicators, and chat log — from the current in-memory state, **without** the
   * ``/api/stats`` fetch. {@link applyFilter} composes this with the stats
   * refresh; the background collection backfill (issue #832) calls it directly so
   * streaming a history page repaints the table/map without firing a redundant
   * authoritative-count request per page — the ``/api/stats`` count is
   * server-computed and unaffected by how many rows the client has paged in.
   *
   * @param {string} [filterQuery] Raw filter text for substring highlighting;
   *   defaults to the current filter input value.
   * @returns {void}
   */
  function renderFilteredOutputs(filterQuery = filterInput ? filterInput.value : '') {
    // Text and role filters apply only to the node table and map; the chat log
    // always receives the full node collection so reply-thread lookups succeed
    // even for nodes that are currently hidden by the active filter.
    const sortedNodes = getFilteredSortedNodes();
    const nowSec = Date.now() / 1000;
    renderTable(sortedNodes, nowSec);
    renderMap(sortedNodes, nowSec);
    updateSortIndicators();
    // Pass the raw filterQuery (not the normalised form) so the chat log can
    // highlight matching substrings in their original case.
    rerenderChatLog(filterQuery);
  }

  /**
   * Apply text and role filters to the node list and re-render outputs.
   *
   * @returns {void}
   */
  function applyFilter() {
    updateFilterClearVisibility();
    const filterQuery = filterInput ? filterInput.value : '';
    renderFilteredOutputs(filterQuery);
    // Show an immediate local estimate for the title so it doesn't flicker
    // to (0) while waiting for the async /api/stats response.
    const nowSec = Date.now() / 1000;
    const localStats = computeLocalActiveNodeStats(allNodes, nowSec);
    updateTitleCount(adjustStatsForHiddenProtocols(localStats));
    // Title, legend, footer, and visibility are then corrected by /api/stats
    // which provides the authoritative, uncapped counts.
    const statsRequestId = ++activeStatsRequestId;
    void fetchActiveNodeStats({ nodes: allNodes, nowSeconds: nowSec }).then(stats => {
      if (statsRequestId !== activeStatsRequestId) return;
      const visibleStats = adjustStatsForHiddenProtocols(stats);
      updateTitleCount(visibleStats);
      updateLegendProtocolCounts(stats);
      updateFooterStats(visibleStats);
      applyProtocolVisibility(stats);
    });
  }

  // Re-filter on every keystroke so the table and map stay in sync with the
  // input field without requiring an explicit submit action.
  if (filterInput) {
    filterInput.addEventListener('input', () => {
      updateFilterClearVisibility();
      applyFilter();
    });
    updateFilterClearVisibility();
  }

  // The clear button only resets the field when it contains text; when empty
  // it focuses the input so the user can start typing immediately.
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
  async function refresh(refreshOptions = {}) {
    try {
      // On the first load fetch the full dataset; subsequent refreshes pass
      // the ``since`` timestamp so only new/changed rows are transferred.
      // A 1-second overlap avoids missing rows that arrive at the boundary.
      const useSince = initialFetchDone;
      // Targeted delta (SPEC PS3): when an SSE ping requests specific
      // collections, fetch only those. Gating applies only once the initial
      // full load is done, so a ping racing the first load can never
      // partial-fetch and wipe the collections it skipped.
      const only = useSince && refreshOptions.collections instanceof Set
        ? refreshOptions.collections
        : null;
      const want = name => !only || only.has(name);
      const nodeSince = useSince ? Math.max(0, lastNodeTimestamp - 1) : 0;
      const msgSince = useSince ? Math.max(0, lastMessageTimestamp - 1) : 0;
      const posSince = useSince ? Math.max(0, lastPositionTimestamp - 1) : 0;
      const telSince = useSince ? Math.max(0, lastTelemetryTimestamp - 1) : 0;
      const nbSince = useSince ? Math.max(0, lastNeighborTimestamp - 1) : 0;
      const trSince = useSince ? Math.max(0, lastTraceTimestamp - 1) : 0;

      // Cold-load boot prefetch (initial-load latency fix): the early boot module
      // (main/boot-prefetch.js) may have already issued the first-load (since=0)
      // requests in parallel with the module graph. On the first cold refresh,
      // consume those in-flight responses instead of issuing our own. One-shot
      // (the global is cleared on read), so reconnect resyncs and later refreshes
      // fetch normally; on a warm load the boot module skipped prefetch so this is
      // absent and the FC2 delta path is untouched.
      const bootSource = typeof window !== 'undefined' ? window : globalThis;
      const boot = (!useSince && bootSource && bootSource.__PM_BOOT__) ? bootSource.__PM_BOOT__ : null;
      if (boot) bootSource.__PM_BOOT__ = null;
      const bootResponse = key => (boot ? boot[key] : undefined);

      // Secondary fetches are fire-and-forget with individual error handlers so
      // that a failure in one stream (e.g. telemetry) does not abort the whole
      // refresh cycle.  Each promise resolves to an empty array on error, which
      // preserves the previous data until the next successful fetch.
      const neighborPromise = want('neighbors') ? fetchNeighbors(NODE_LIMIT, nbSince, { responsePromise: bootResponse('neighbors') }).catch(err => {
        console.warn('neighbor refresh failed; continuing without connections', err);
        return [];
      }) : Promise.resolve([]);
      const telemetryPromise = want('telemetry') ? fetchTelemetry(NODE_LIMIT, telSince, { responsePromise: bootResponse('telemetry') }).catch(err => {
        console.warn('telemetry refresh failed; continuing without telemetry', err);
        return [];
      }) : Promise.resolve([]);
      const positionsPromise = want('positions') ? fetchPositions(NODE_LIMIT, posSince, { responsePromise: bootResponse('positions') }).catch(err => {
        console.warn('position refresh failed; continuing without updates', err);
        return [];
      }) : Promise.resolve([]);
      const tracesPromise = want('traces') ? fetchTraces(TRACE_LIMIT, trSince, { responsePromise: bootResponse('traces') }).catch(err => {
        console.warn('trace refresh failed; continuing without traceroutes', err);
        return [];
      }) : Promise.resolve([]);
      const encryptedMessagesPromise = want('messages') ? fetchMessages(MESSAGE_LIMIT, { encrypted: true, since: msgSince, responsePromise: bootResponse('encryptedMessages') }).catch(err => {
        console.warn('encrypted message refresh failed; continuing without encrypted entries', err);
        return [];
      }) : Promise.resolve([]);
      // Fan-out all requests simultaneously; nodes are the primary resource and
      // must succeed for rendering to proceed.
      const [
        incomingNodes,
        incomingPositions,
        incomingNeighbors,
        incomingTraces,
        incomingMessages,
        incomingTelemetry,
        incomingEncryptedMessages
      ] = await Promise.all([
        want('nodes') ? fetchNodes(NODE_LIMIT, nodeSince, { responsePromise: bootResponse('nodes') }) : Promise.resolve([]),
        positionsPromise,
        neighborPromise,
        tracesPromise,
        // Always fetch a single newest page here so the first paint is fast
        // (issue #802); the rest of the seven-day window streams in afterwards
        // via backfillChatHistory().  ``msgSince`` is 0 on the first load (so
        // this is the newest page) and the slice past the high-water mark on
        // every refresh after.
        want('messages') ? fetchMessages(MESSAGE_LIMIT, { since: msgSince, responsePromise: bootResponse('messages') }) : Promise.resolve([]),
        telemetryPromise,
        encryptedMessagesPromise
      ]);

      // Update high-water marks for incremental fetching.
      const incomingNodeTs = maxRecordTimestamp(incomingNodes, ['last_heard']);
      const incomingMsgTs = maxRecordTimestamp(incomingMessages, ['rx_time']);
      // Record the oldest row of this delta page as the backfill's live frontier
      // (see {@link chatLiveFrontier}); the newest delta page is what the
      // one-shot backfill must extend backward from.
      const incomingMsgOldest = minRecordTimestamp(incomingMessages, ['rx_time']);
      if (incomingMsgOldest > 0) chatLiveFrontier = incomingMsgOldest;
      const incomingEncMsgTs = maxRecordTimestamp(incomingEncryptedMessages, ['rx_time']);
      const incomingPosTs = maxRecordTimestamp(incomingPositions, ['rx_time', 'position_time']);
      const incomingTelTs = maxRecordTimestamp(incomingTelemetry, ['rx_time', 'telemetry_time']);
      const incomingNbTs = maxRecordTimestamp(incomingNeighbors, ['rx_time']);
      const incomingTrTs = maxRecordTimestamp(incomingTraces, ['rx_time']);
      if (incomingNodeTs > lastNodeTimestamp) lastNodeTimestamp = incomingNodeTs;
      const latestMsgTs = Math.max(incomingMsgTs, incomingEncMsgTs);
      if (latestMsgTs > lastMessageTimestamp) lastMessageTimestamp = latestMsgTs;
      if (incomingPosTs > lastPositionTimestamp) lastPositionTimestamp = incomingPosTs;
      if (incomingTelTs > lastTelemetryTimestamp) lastTelemetryTimestamp = incomingTelTs;
      if (incomingNbTs > lastNeighborTimestamp) lastNeighborTimestamp = incomingNbTs;
      if (incomingTrTs > lastTraceTimestamp) lastTraceTimestamp = incomingTrTs;

      // Capture each bulk collection's live frontier (oldest cursor of the
      // newest page) so the one-shot background backfill (issue #832) can page
      // backward from there, exactly like chatLiveFrontier. Cold load only: a
      // warm-cache load already has the deeper history seeded (and its useSince
      // delta pages are short), and a *short* newest page means the window is
      // already exhausted — both record 0 so no pointless backward request fires
      // (avoids an empty, long-loading page). The cursor column matches each
      // route's server-side ORDER BY: last_heard for nodes, rx_time for the rest.
      if (!useSince) {
        const frontierIfFull = (rows, cap, keys) =>
          Array.isArray(rows) && rows.length >= cap ? minRecordTimestamp(rows, keys) : 0;
        collectionLiveFrontiers = {
          nodes: frontierIfFull(incomingNodes, NODE_LIMIT, ['last_heard']),
          positions: frontierIfFull(incomingPositions, NODE_LIMIT, ['rx_time']),
          telemetry: frontierIfFull(incomingTelemetry, NODE_LIMIT, ['rx_time']),
          neighbors: frontierIfFull(incomingNeighbors, NODE_LIMIT, ['rx_time']),
          traces: frontierIfFull(incomingTraces, TRACE_LIMIT, ['rx_time']),
        };
      }

      // Merge incremental results into the module-level collections.  On first
      // load the existing arrays are empty so the merge is effectively a no-op.
      // The per-packet collections (positions/telemetry/neighbors/traces) are
      // bounded by their server visibility window rather than a fixed row count
      // (issue #832): a count cap would trim a background backfill's older pages
      // straight back out on the next refresh tick. Windows mirror FC3 — 7 d for
      // positions/telemetry (like messages), 28 d for neighbors/traces.
      const nowSeconds = Math.floor(Date.now() / 1000);
      const messageWindowFloor = nowSeconds - CHAT_RECENT_WINDOW_SECONDS;
      const recentWindowFloor = nowSeconds - CHAT_RECENT_WINDOW_SECONDS;
      const longWindowFloor = nowSeconds - TRACE_MAX_AGE_SECONDS;
      allNodes = useSince ? mergeById(allNodes, incomingNodes, 'node_id') : incomingNodes;
      allPositionEntries = useSince
        ? trimToWindow(mergeById(allPositionEntries, incomingPositions, 'id'), recentWindowFloor)
        : incomingPositions;
      allTelemetryEntries = useSince
        ? trimToWindow(mergeById(allTelemetryEntries, incomingTelemetry, 'id'), recentWindowFloor)
        : incomingTelemetry;
      allNeighbors = useSince
        ? trimToWindow(mergeByCompositeKey(allNeighbors, incomingNeighbors, ['node_id', 'neighbor_id']), longWindowFloor)
        : incomingNeighbors;
      allTraces = useSince
        ? trimToWindow(mergeById(allTraces, incomingTraces, 'id'), longWindowFloor)
        : incomingTraces;
      // Encrypted blobs only feed the mixed Log tab (itself capped), so a count
      // cap is the right memory bound for them.
      const encryptedMessages = useSince
        ? trimToLimit(mergeById(allEncryptedMessages, incomingEncryptedMessages, 'id'), MESSAGE_LIMIT)
        : incomingEncryptedMessages;
      // Plaintext chat is shown for the full seven-day window (issue #796), so
      // bound the retained set by that window rather than a row count — a count
      // cap would silently drop older-but-in-window messages on the next merge.
      const messages = useSince
        ? trimToWindow(mergeById(allMessages, incomingMessages, 'id'), messageWindowFloor)
        : incomingMessages;

      // Aggregate per-source snapshots into locals and enrich the node collection
      // from the merged sources.  Shared with the background backfill so a streamed
      // page re-derives identically (issue #832).  The per-packet accumulators
      // (allPositionEntries/allTelemetryEntries/allNeighbors) are left RAW so the
      // Log keeps a stable entry per packet — re-storing the aggregated form would
      // erode history on the next tick (bugfix A1).
      rebuildNodeDerivedState();
      // Hydrate messages with node metadata in parallel; the node index has just
      // been rebuilt (inside rebuildNodeDerivedState) so lookups find the freshly
      // merged records.
      const [chatMessages, encryptedChatMessages] = await Promise.all([
        messageNodeHydrator.hydrate(messages, nodesById),
        messageNodeHydrator.hydrate(encryptedMessages, nodesById)
      ]);
      const hydratedChat = Array.isArray(chatMessages) ? chatMessages : [];
      // Re-merge into the *current* allMessages rather than replacing it: the
      // background history backfill (issue #802) may have appended older pages
      // while we awaited hydration, and a blind assignment would clobber them.
      // The read-modify-write is synchronous, so it cannot interleave with a
      // backfill commit.  First load has no backfill yet, so it just takes the
      // newest page as-is.
      allMessages = useSince
        ? trimToWindow(mergeById(allMessages, hydratedChat, 'id'), messageWindowFloor)
        : hydratedChat;
      allEncryptedMessages = Array.isArray(encryptedChatMessages) ? encryptedChatMessages : [];
      initialFetchDone = true;
      applyFilter();
      // SPEC VF2/VF3/VF4: only an SSE-ping refresh flashes (refreshOptions.flash),
      // and only after the table + map have rendered (applyFilter above), so the
      // highlight lands on the final, placed element. useSince excludes the
      // initial fill. A node/position/telemetry delta flashes the changed node.
      if (refreshOptions.flash && useSince) {
        flashChangedNodes(collectNodeIds(incomingNodes, incomingPositions, incomingTelemetry));
        flashChangedMessages(collectMessageIds(incomingMessages, incomingEncryptedMessages));
      }
      // Persist the freshly-merged state for the next reload/revisit (SPEC FC2),
      // throttled and fire-and-forget so it never blocks the paint.
      writeBackCache();
      // With the newest page on screen, stream the rest of the seven-day window
      // in the background (issue #802) so older history fills in progressively
      // instead of blocking the first paint on the whole backward pagination.
      // Runs once after the first load — whether that load was cold or seeded
      // from cache — so any window not already present in the cache is filled.
      if (!chatHistoryBackfilled) {
        chatHistoryBackfilled = true;
        backfillPromise = backfillChatHistory();
        void backfillPromise;
      }
      // Likewise stream the rest of every bulk collection's window in the
      // background (issue #832) so the node table / map fill past the newest
      // 1000-row page the server returns at once. One-shot after the first load;
      // a no-op when no collection recorded a frontier (warm load / short page).
      if (!collectionsBackfilled) {
        collectionsBackfilled = true;
        collectionBackfillPromise = backfillAllCollections();
        void collectionBackfillPromise;
      }
    } catch (e) {
      console.error(e);
    }
  }

  // Kick off the first data load immediately then start the silent background
  // auto-refresh timer. Paint from the persistent cache first (instant first
  // paint, SPEC FC2), then refresh fetches only the delta; a disabled/empty
  // cache makes seedFromCache a no-op so this is the normal cold load.
  const initialLoadPromise = seedFromCache()
    .catch(() => false)
    .then(() => refresh());
  void initialLoadPromise;
  restartAutoRefresh();

  // --- Auto-refresh play/pause toggle ---
  if (autorefreshToggle) {
    autorefreshToggle.addEventListener('click', () => {
      autorefreshPaused = !autorefreshPaused;
      if (autorefreshPaused) {
        if (refreshTimer) {
          clearInterval(refreshTimer);
          refreshTimer = null;
        }
        // Also close the live stream so a paused dashboard makes no requests.
        stopLiveUpdates();
        autorefreshToggle.textContent = '\u25B6';
        autorefreshToggle.setAttribute('aria-label', 'Resume auto-refresh');
        autorefreshToggle.setAttribute('aria-pressed', 'true');
      } else {
        autorefreshToggle.textContent = '\u23F8';
        autorefreshToggle.setAttribute('aria-label', 'Pause auto-refresh');
        autorefreshToggle.setAttribute('aria-pressed', 'false');
        refresh();
        restartAutoRefresh();
      }
    });
  }

  // --- Meta-row protocol toggle buttons ---
  /**
   * Wire a meta-row protocol toggle button to the shared
   * {@link hiddenProtocols} set.
   *
   * @param {HTMLElement|null} btn Button element.
   * @param {string} protocol Protocol token (``'meshcore'`` or ``'meshtastic'``).
   * @returns {void}
   */
  function setupMetaProtocolToggle(btn, protocol) {
    if (!btn) return;
    btn.addEventListener('click', () => {
      if (hiddenProtocols.has(protocol)) {
        hiddenProtocols.delete(protocol);
      } else {
        hiddenProtocols.add(protocol);
      }
      updateMetaProtocolToggleUI();
      updateLegendRoleFiltersUI();
      applyFilter();
    });
  }
  setupMetaProtocolToggle(protocolToggleMeshcore, 'meshcore');
  setupMetaProtocolToggle(protocolToggleMeshtastic, 'meshtastic');

  /**
   * Update the page/tab title with the total active-node count for the past 7 days.
   *
   * @param {{week: number}} stats Active-node stats from /api/stats.
   * @returns {void}
   */
  function updateTitleCount(stats) {
    const count = stats?.week ?? 0;
    const text = `${baseTitle} (${count})`;
    if (titleEl) titleEl.textContent = text;
    if (headerTitleTextEl) {
      headerTitleTextEl.textContent = text;
    } else if (headerEl) {
      headerEl.textContent = text;
    }
  }

  /**
   * Update legend column headers with per-protocol active node counts (7 days).
   *
   * @param {{meshcore?: {week: number}, meshtastic?: {week: number}}} stats Stats from /api/stats.
   * @returns {void}
   */
  function updateLegendProtocolCounts(stats) {
    if (!meshcoreCountEl && !meshtasticCountEl) return;
    if (meshcoreCountEl) meshcoreCountEl.textContent = ` (${stats?.meshcore?.week ?? 0})`;
    if (meshtasticCountEl) meshtasticCountEl.textContent = ` (${stats?.meshtastic?.week ?? 0})`;
  }

  /**
   * Update the footer active-node stats element with day/week/month counts.
   *
   * @param {{day: number, week: number, month: number, sampled: boolean}} stats Stats from /api/stats.
   * @returns {void}
   */
  function updateFooterStats(stats) {
    if (!footerActiveNodes) return;
    footerActiveNodes.textContent = 'Active: ' + formatActiveNodeStatsText({ stats });
  }

  /**
   * Hide/show UI elements based on per-protocol activity in the past 7 days.
   *
   * Hides the Charts nav link when meshtastic has no active nodes, and hides
   * legend columns for protocols with zero weekly activity.
   *
   * @param {{meshcore?: {week: number}, meshtastic?: {week: number}}} stats Stats from /api/stats.
   * @returns {void}
   */
  function applyProtocolVisibility(stats) {
    const meshcoreWeek = stats?.meshcore?.week ?? 0;
    const meshtasticWeek = stats?.meshtastic?.week ?? 0;

    // Hide legend columns for protocols with no activity in the past 7 days.
    if (meshcoreColEl) meshcoreColEl.style.display = meshcoreWeek === 0 ? 'none' : '';
    if (meshtasticColEl) meshtasticColEl.style.display = meshtasticWeek === 0 ? 'none' : '';

    // Show protocol toggle buttons only when both protocols have weekly
    // activity — filtering is pointless when only one protocol is present.
    const bothActive = meshcoreWeek > 0 && meshtasticWeek > 0;
    if (protocolToggleMeshcore) protocolToggleMeshcore.hidden = !bothActive;
    if (protocolToggleMeshtastic) protocolToggleMeshtastic.hidden = !bothActive;

    // Charts is meshtastic-only; hide the nav link when no meshtastic activity.
    document.querySelectorAll('a[href="/charts"]').forEach(el => {
      el.style.display = meshtasticWeek === 0 ? 'none' : '';
    });
  }

  /**
   * Inner closures exposed for unit tests. Production callers should ignore
   * this return value.
   *
   * @returns {{ _testUtils: { buildMapPopupHtml: Function, normalizeOverlaySource: Function, createAnnouncementEntry: Function, createMessageChatEntry: Function, buildChatLogEntryParts: Function, buildDisplayContext: Function, rebuildNodeIndex: Function } }}
   */
  return {
    _testUtils: {
      buildMapPopupHtml,
      normalizeOverlaySource,
      createAnnouncementEntry,
      createMessageChatEntry,
      buildChatLogEntryParts,
      buildDisplayContext,
      rebuildNodeIndex,
      makeRoleFilterKey,
      normalizeFilterProtocol,
      matchesRoleFilter,
      matchesProtocolFilter,
      buildProtocolIconImg,
      buildMeshtasticIconImg,
      buildMeshcoreIconImg,
      buildRoleButtons,
      updateLegendRoleFiltersUI,
      legendClickHandler,
      activeRoleFilters,
      hiddenProtocols,
      legendRoleButtons,
      legendProtocolButtons,
      updateTitleCount,
      updateLegendProtocolCounts,
      updateFooterStats,
      applyProtocolVisibility,
      restartAutoRefresh,
      updateMetaProtocolToggleUI,
      adjustStatsForHiddenProtocols,
      /** Whether auto-refresh is currently paused. */
      isAutorefreshPaused: () => autorefreshPaused,
      /** Whether an SSE live-update stream is currently active (test hook). */
      isLiveActive: () => liveActive,
      /** The auto-refresh cadence last armed, in ms (test hook). */
      getAutoRefreshIntervalMs: () => autoRefreshIntervalMs,
      /** Count of flash rounds triggered by SSE pings (VF2 gating; test hook). */
      getLiveFlashCount: () => liveFlashCount,
      /** Node ids flashed by the most recent SSE-ping refresh (test hook). */
      getLastFlashedNodeIds: () => lastFlashedNodeIds,
      /** Flash (and wave) the given changed node ids — test hook for the LV5 wiring. */
      flashChangedNodes,
      /** Inject a marker into the node->marker map — test hook for the LV5 wiring. */
      _setMarkerForTests: (id, marker) => markerByNodeId.set(id, marker),
      /** Message ids flashed by the most recent SSE-ping refresh (test hook). */
      getLastFlashedMessageIds: () => lastFlashedMessageIds,
      /**
       * Flush any pending debounced live refresh and await the latest
       * live-driven refresh (test hook).
       *
       * @returns {Promise<void>}
       */
      flushLiveRefresh: async () => {
        if (liveRefreshTimer) {
          clearTimeout(liveRefreshTimer);
          runLiveRefresh();
        }
        await liveRefreshPromise;
      },
      /** Stop the auto-refresh timer and close the live stream (test teardown). */
      stopAutoRefresh: () => {
        if (refreshTimer) {
          clearInterval(refreshTimer);
          refreshTimer = null;
        }
        stopLiveUpdates();
      },
      /** Inject mock count span elements for legend protocol count tests. */
      _setProtocolCountElements(mc, mt) {
        meshcoreCountEl = mc;
        meshtasticCountEl = mt;
      },
      /** Inject mock column elements for protocol visibility tests. */
      _setProtocolColElements(mc, mt) {
        meshcoreColEl = mc;
        meshtasticColEl = mt;
      },
      /** Trigger a manual refresh cycle (test use only). */
      refresh,
      /** Re-render the chat log from current state (test/verification hook). */
      rerenderChatLog,
      /**
       * Chat-render instrumentation: how many entries have been materialised
       * into DOM nodes so far. Idle re-renders should not increase this once
       * incremental rendering is in place (issue: chat-log render).
       *
       * @returns {{ materialized: number }} Cumulative materialisation count.
       */
      getChatRenderStats: () => chatEntryCache.stats(),
      /** Reset the chat-render materialisation counter (test use only). */
      resetChatRenderStats: () => {
        chatEntryCache.resetStats();
      },
      /** Number of plaintext chat messages currently loaded (test use only). */
      getLoadedMessageCount: () => allMessages.length,
      /** Number of node rows currently loaded into the table (test use only). */
      getLoadedNodeCount: () => allNodes.length,
      /** Number of position entries currently loaded (test use only). */
      getLoadedPositionCount: () => allPositionEntries.length,
      /** Number of telemetry entries currently loaded (test use only). */
      getLoadedTelemetryCount: () => allTelemetryEntries.length,
      /** Number of neighbour tuples currently loaded (test use only). */
      getLoadedNeighborCount: () => allNeighbors.length,
      /** Number of trace entries currently loaded (test use only). */
      getLoadedTraceCount: () => allTraces.length,
      /** The persistent data cache instance (test use only). */
      dataCache,
      /** Seed in-memory state from the persistent cache (test use only). */
      seedFromCache,
      /** Promise resolving once the initial seed + first refresh complete (test hook). */
      initialLoad: initialLoadPromise,
      /** Promise resolving once the latest cache write-back has flushed (test hook). */
      flushCacheWrites: () => pendingCacheWrite,
      /** Promise resolving once the one-shot chat-history backfill finishes (test hook). */
      flushBackfill: () => backfillPromise,
      /** Promise resolving once the one-shot bulk-collection backfill finishes (test hook). */
      flushCollectionBackfills: () => collectionBackfillPromise,
      /** Empty the persistent cache — the "clear cached data" control (FC4). */
      clearDataCache,
      /** Project an original lat/lon + pixel offset into a display LatLng. */
      projectColocatedOffsetLatLng,
      /** Re-project every recorded co-located marker (no-op without a map). */
      refreshColocatedSpiderState,
      /** rAF-throttled wrapper around the spider refresh. */
      scheduleColocatedSpiderRefresh,
      /** ``zoomend`` handler that also detects co-located zoom-bucket crossings. */
      handleZoomEndForColocatedHubs,
      /** Build the asterisk + count hub badge for a co-located group. */
      createColocatedHubMarker,
      /** Lazily look up or create the divIcon for a hub of a given size. */
      getColocatedHubIcon,
      /** Render the map (test use only). */
      renderMap,
      /** Re-render only the map (skips the table / chat log / stats pipeline). */
      rerenderMapForFiltering,
      /** Classify the current zoom level as ``'low'`` or ``'high'``. */
      _currentZoomBucketForTests: currentZoomBucket,
      /** Inspect the live divIcon cache (test use only). */
      _getColocatedHubIconCacheForTests() {
        return colocatedHubIconCache;
      },
      /** Replace the recorded spider state for tests; returns the previous value. */
      _setColocatedSpiderStateForTests(next) {
        const previous = colocatedSpiderState;
        colocatedSpiderState = Array.isArray(next) ? next : [];
        return previous;
      },
      /** Inspect the recorded spider state (test use only). */
      _getColocatedSpiderStateForTests() {
        return colocatedSpiderState;
      },
      /** Replace the expanded-group key set for tests; returns the previous value. */
      _setExpandedColocatedKeysForTests(next) {
        const previous = expandedColocatedKeys;
        expandedColocatedKeys = next instanceof Set ? next : new Set();
        return previous;
      },
      /** Inspect the live expanded-group key set (test use only). */
      _getExpandedColocatedKeysForTests() {
        return expandedColocatedKeys;
      },
      /** Inject a stub hub layer for tests; returns the previous value. */
      _setColocatedHubsLayerForTests(next) {
        const previous = colocatedHubsLayer;
        colocatedHubsLayer = next;
        return previous;
      },
      /** Inspect the hub layer (test use only). */
      _getColocatedHubsLayerForTests() {
        return colocatedHubsLayer;
      },
      /** Read or override the cached zoom bucket from the previous render. */
      _setLastRenderedZoomBucketForTests(next) {
        const previous = lastRenderedZoomBucket;
        lastRenderedZoomBucket = next;
        return previous;
      },
      _getLastRenderedZoomBucketForTests() {
        return lastRenderedZoomBucket;
      },
      /** Inject a stub Leaflet map for tests that need to drive the projection. */
      _setMapForTests(stub) {
        const previous = map;
        map = stub;
        return previous;
      },
    },
  };
}
