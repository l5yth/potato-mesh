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

import { refreshNodeInformation } from './node-details.js';
import { renderTelemetryChartSections } from './node-telemetry-charts.js';
import {
  extractChatMessageMetadata,
  formatChatChannelTag,
  formatChatMessagePrefix,
  formatChatPresetTag,
} from './chat-format.js';
import {
  fmtAlt,
  fmtHumidity,
  fmtPressure,
  fmtTemperature,
  fmtTx,
} from './short-info-telemetry.js';

const DEFAULT_FETCH_OPTIONS = Object.freeze({ cache: 'no-store' });
const MESSAGE_LIMIT = 50;
const RENDER_WAIT_INTERVAL_MS = 20;
const RENDER_WAIT_TIMEOUT_MS = 500;
const NEIGHBOR_ROLE_FETCH_CONCURRENCY = 4;

/**
 * Convert a candidate value into a trimmed string.
 *
 * @param {*} value Raw value.
 * @returns {string|null} Trimmed string or ``null``.
 */
function stringOrNull(value) {
  if (value == null) return null;
  const str = String(value).trim();
  return str.length === 0 ? null : str;
}

/**
 * Attempt to coerce a value into a finite number.
 *
 * @param {*} value Raw value.
 * @returns {number|null} Finite number or ``null``.
 */
function numberOrNull(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (value == null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/**
 * Escape HTML sensitive characters from the provided string.
 *
 * @param {string} input Raw HTML string.
 * @returns {string} Escaped HTML representation.
 */
function escapeHtml(input) {
  const str = input == null ? '' : String(input);
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Format a frequency value using MHz units when a numeric reading is
 * available. Non-numeric input is passed through unchanged.
 *
 * @param {*} value Raw frequency value.
 * @returns {string|null} Formatted frequency string or ``null``.
 */
function formatFrequency(value) {
  if (value == null || value === '') return null;
  const numeric = numberOrNull(value);
  if (numeric == null) {
    return stringOrNull(value);
  }
  const abs = Math.abs(numeric);
  if (abs >= 1_000_000) {
    return `${(numeric / 1_000_000).toFixed(3)} MHz`;
  }
  if (abs >= 1_000) {
    return `${(numeric / 1_000).toFixed(3)} MHz`;
  }
  return `${numeric.toFixed(3)} MHz`;
}

/**
 * Format a battery reading as a percentage with a single decimal place.
 *
 * @param {*} value Raw battery value.
 * @returns {string|null} Formatted percentage or ``null``.
 */
function formatBattery(value) {
  const numeric = numberOrNull(value);
  if (numeric == null) return null;
  return `${numeric.toFixed(1)}%`;
}

/**
 * Format a voltage reading with two decimal places.
 *
 * @param {*} value Raw voltage value.
 * @returns {string|null} Formatted voltage string.
 */
function formatVoltage(value) {
  const numeric = numberOrNull(value);
  if (numeric == null) return null;
  return `${numeric.toFixed(2)} V`;
}

/**
 * Convert an uptime reading in seconds to a concise human-readable string.
 *
 * @param {*} value Raw uptime value.
 * @returns {string|null} Formatted uptime string or ``null`` when invalid.
 */
function formatUptime(value) {
  const numeric = numberOrNull(value);
  if (numeric == null) return null;
  const seconds = Math.floor(numeric);
  const parts = [];
  const days = Math.floor(seconds / 86_400);
  if (days > 0) parts.push(`${days}d`);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  if (hours > 0) parts.push(`${hours}h`);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (minutes > 0) parts.push(`${minutes}m`);
  const remainSeconds = seconds % 60;
  if (parts.length === 0 || remainSeconds > 0) {
    parts.push(`${remainSeconds}s`);
  }
  return parts.join(' ');
}

/**
 * Format a numeric timestamp expressed in seconds since the epoch.
 *
 * @param {*} value Raw timestamp value.
 * @param {string|null} isoFallback ISO formatted string to prefer.
 * @returns {string|null} ISO timestamp string.
 */
function formatTimestamp(value, isoFallback = null) {
  const iso = stringOrNull(isoFallback);
  if (iso) return iso;
  const numeric = numberOrNull(value);
  if (numeric == null) return null;
  try {
    return new Date(numeric * 1000).toISOString();
  } catch (error) {
    return null;
  }
}

/**
 * Pad a numeric value with leading zeros.
 *
 * @param {number} value Numeric value to pad.
 * @returns {string} Padded string representation.
 */
function padTwo(value) {
  return String(Math.trunc(Math.abs(Number(value)))).padStart(2, '0');
}

/**
 * Format a timestamp for the message log using ``YYYY-MM-DD HH:MM:SS``.
 *
 * @param {*} value Seconds since the epoch.
 * @param {string|null} isoFallback ISO timestamp to prefer when available.
 * @returns {string|null} Formatted timestamp string or ``null``.
 */
function formatMessageTimestamp(value, isoFallback = null) {
  const iso = stringOrNull(isoFallback);
  let date = null;
  if (iso) {
    const candidate = new Date(iso);
    if (!Number.isNaN(candidate.getTime())) {
      date = candidate;
    }
  }
  if (!date) {
    const numeric = numberOrNull(value);
    if (numeric == null) return null;
    const candidate = new Date(numeric * 1000);
    if (Number.isNaN(candidate.getTime())) {
      return null;
    }
    date = candidate;
  }
  const year = date.getFullYear();
  const month = padTwo(date.getMonth() + 1);
  const day = padTwo(date.getDate());
  const hours = padTwo(date.getHours());
  const minutes = padTwo(date.getMinutes());
  const seconds = padTwo(date.getSeconds());
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

/**
/**
 * Format a hardware model string while hiding unset placeholders.
 *
 * @param {*} value Raw hardware model value.
 * @returns {string} Sanitised hardware model string.
 */
function formatHardwareModel(value) {
  const text = stringOrNull(value);
  if (!text || text.toUpperCase() === 'UNSET') {
    return '';
  }
  return text;
}

/**
 * Format a coordinate with consistent precision.
 *
 * @param {*} value Raw coordinate value.
 * @param {number} [precision=5] Decimal precision applied to the coordinate.
 * @returns {string} Formatted coordinate string.
 */
function formatCoordinate(value, precision = 5) {
  const numeric = numberOrNull(value);
  if (numeric == null) return '';
  return numeric.toFixed(precision);
}

/**
 * Convert an absolute timestamp into a relative time description.
 *
 * @param {*} value Raw timestamp expressed in seconds since the epoch.
 * @param {number} [referenceSeconds] Optional reference timestamp in seconds.
 * @returns {string} Relative time string or an empty string when unavailable.
 */
function formatRelativeSeconds(value, referenceSeconds = Date.now() / 1000) {
  const numeric = numberOrNull(value);
  if (numeric == null) return '';
  const reference = numberOrNull(referenceSeconds);
  const base = reference != null ? reference : Date.now() / 1000;
  const diff = Math.floor(base - numeric);
  const safeDiff = Number.isFinite(diff) ? Math.max(diff, 0) : 0;
  if (safeDiff < 60) return `${safeDiff}s`;
  if (safeDiff < 3_600) {
    const minutes = Math.floor(safeDiff / 60);
    const seconds = safeDiff % 60;
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  if (safeDiff < 86_400) {
    const hours = Math.floor(safeDiff / 3_600);
    const minutes = Math.floor((safeDiff % 3_600) / 60);
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  const days = Math.floor(safeDiff / 86_400);
  const hours = Math.floor((safeDiff % 86_400) / 3_600);
  return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
}

/**
 * Format a duration expressed in seconds using a compact human readable form.
 *
 * @param {*} value Raw duration in seconds.
 * @returns {string} Human readable duration string or an empty string.
 */
function formatDurationSeconds(value) {
  const numeric = numberOrNull(value);
  if (numeric == null) return '';
  const duration = Math.max(Math.floor(numeric), 0);
  if (duration < 60) return `${duration}s`;
  if (duration < 3_600) {
    const minutes = Math.floor(duration / 60);
    const seconds = duration % 60;
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  if (duration < 86_400) {
    const hours = Math.floor(duration / 3_600);
    const minutes = Math.floor((duration % 3_600) / 60);
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  const days = Math.floor(duration / 86_400);
  const hours = Math.floor((duration % 86_400) / 3_600);
  return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
}

/**
 * Format an SNR reading with a decibel suffix.
 *
 * @param {*} value Raw SNR value.
 * @returns {string} Formatted SNR string or an empty string.
 */
function formatSnr(value) {
  const numeric = numberOrNull(value);
  if (numeric == null) return '';
  return `${numeric.toFixed(1)} dB`;
}

/**
 * Normalise a node identifier for consistent lookups.
 *
 * @param {*} identifier Candidate identifier.
 * @returns {string|null} Lower-case identifier or ``null`` when invalid.
 */
function normalizeNodeId(identifier) {
  const value = stringOrNull(identifier);
  return value ? value.toLowerCase() : null;
}

/**
 * Register a role candidate within the supplied index.
 *
 * @param {{
 *   byId: Map<string, string>,
 *   byNum: Map<number, string>,
 *   detailsById: Map<string, Object>,
 *   detailsByNum: Map<number, Object>,
 * }} index Role index maps.
 * @param {{
 *   identifier?: *,
 *   numericId?: *,
 *   role?: *,
 *   shortName?: *,
 *   longName?: *,
 * }} payload Role candidate payload.
 * @returns {void}
 */
function registerRoleCandidate(
  index,
  { identifier = null, numericId = null, role = null, shortName = null, longName = null } = {},
) {
  if (!index || typeof index !== 'object') return;

  if (!(index.byId instanceof Map)) index.byId = new Map();
  if (!(index.byNum instanceof Map)) index.byNum = new Map();
  if (!(index.detailsById instanceof Map)) index.detailsById = new Map();
  if (!(index.detailsByNum instanceof Map)) index.detailsByNum = new Map();

  const resolvedRole = stringOrNull(role);
  const resolvedShort = stringOrNull(shortName);
  const resolvedLong = stringOrNull(longName);

  const idKey = normalizeNodeId(identifier);
  const numKey = numberOrNull(numericId);

  if (resolvedRole) {
    if (idKey && !index.byId.has(idKey)) {
      index.byId.set(idKey, resolvedRole);
    }
    if (numKey != null && !index.byNum.has(numKey)) {
      index.byNum.set(numKey, resolvedRole);
    }
  }

  const applyDetails = (existing, keyType) => {
    const current = existing instanceof Map && (keyType === 'id' ? idKey : numKey) != null
      ? existing.get(keyType === 'id' ? idKey : numKey)
      : null;
    const merged = current && typeof current === 'object' ? { ...current } : {};
    if (resolvedRole && !merged.role) merged.role = resolvedRole;
    if (resolvedShort && !merged.shortName) merged.shortName = resolvedShort;
    if (resolvedLong && !merged.longName) merged.longName = resolvedLong;
    if (keyType === 'id' && idKey && merged.identifier == null) merged.identifier = idKey;
    if (keyType === 'num' && numKey != null && merged.numericId == null) {
      merged.numericId = numKey;
    }
    return merged;
  };

  if (idKey) {
    const merged = applyDetails(index.detailsById, 'id');
    if (Object.keys(merged).length > 0) {
      index.detailsById.set(idKey, merged);
    }
  }
  if (numKey != null) {
    const merged = applyDetails(index.detailsByNum, 'num');
    if (Object.keys(merged).length > 0) {
      index.detailsByNum.set(numKey, merged);
    }
  }
}

/**
 * Resolve a role from the provided index using identifier or numeric keys.
 *
 * @param {{byId?: Map<string, string>, byNum?: Map<number, string>}|null} index Role lookup maps.
 * @param {{ identifier?: *, numericId?: * }} payload Lookup payload.
 * @returns {string|null} Resolved role string or ``null`` when unavailable.
 */
function lookupRole(index, { identifier = null, numericId = null } = {}) {
  if (!index || typeof index !== 'object') return null;
  const idKey = normalizeNodeId(identifier);
  if (idKey && index.byId instanceof Map && index.byId.has(idKey)) {
    return index.byId.get(idKey) ?? null;
  }
  const numKey = numberOrNull(numericId);
  if (numKey != null && index.byNum instanceof Map && index.byNum.has(numKey)) {
    return index.byNum.get(numKey) ?? null;
  }
  return null;
}

/**
 * Resolve neighbour metadata from the provided index.
 *
 * @param {{
 *   detailsById?: Map<string, Object>,
 *   detailsByNum?: Map<number, Object>,
 *   byId?: Map<string, string>,
 *   byNum?: Map<number, string>,
 * }|null} index Role lookup maps.
 * @param {{ identifier?: *, numericId?: * }} payload Lookup payload.
 * @returns {{ role?: string|null, shortName?: string|null, longName?: string|null }|null}
 *   Resolved metadata object or ``null`` when unavailable.
 */
function lookupNeighborDetails(index, { identifier = null, numericId = null } = {}) {
  if (!index || typeof index !== 'object') return null;
  const idKey = normalizeNodeId(identifier);
  const numKey = numberOrNull(numericId);

  const details = {};
  if (idKey && index.detailsById instanceof Map && index.detailsById.has(idKey)) {
    Object.assign(details, index.detailsById.get(idKey));
  }
  if (numKey != null && index.detailsByNum instanceof Map && index.detailsByNum.has(numKey)) {
    Object.assign(details, index.detailsByNum.get(numKey));
  }

  if (!details.role) {
    const role = lookupRole(index, { identifier, numericId });
    if (role) details.role = role;
  }

  if (Object.keys(details).length === 0) {
    return null;
  }

  return {
    role: details.role ?? null,
    shortName: details.shortName ?? null,
    longName: details.longName ?? null,
  };
}

/**
 * Gather role hints from neighbor entries into the provided index.
 *
 * @param {{
 *   byId: Map<string, string>,
 *   byNum: Map<number, string>,
 *   detailsById: Map<string, Object>,
 *   detailsByNum: Map<number, Object>,
 * }} index Role index maps.
 * @param {Array<Object>} neighbors Raw neighbor entries.
 * @returns {Set<string>} Normalized identifiers missing from the index.
 */
function seedNeighborRoleIndex(index, neighbors) {
  const missing = new Set();
  if (!Array.isArray(neighbors)) {
    return missing;
  }
  neighbors.forEach(entry => {
    if (!entry || typeof entry !== 'object') {
      return;
    }
    registerRoleCandidate(index, {
      identifier: entry.neighbor_id ?? entry.neighborId,
      numericId: entry.neighbor_num ?? entry.neighborNum,
      role: entry.neighbor_role ?? entry.neighborRole,
      shortName:
        entry.neighbor_short_name
          ?? entry.neighborShortName
          ?? entry.neighbor?.short_name
          ?? entry.neighbor?.shortName
          ?? null,
      longName:
        entry.neighbor_long_name
          ?? entry.neighborLongName
          ?? entry.neighbor?.long_name
          ?? entry.neighbor?.longName
          ?? null,
    });
    registerRoleCandidate(index, {
      identifier: entry.node_id ?? entry.nodeId,
      numericId: entry.node_num ?? entry.nodeNum,
      role: entry.node_role ?? entry.nodeRole,
      shortName:
        entry.node_short_name
          ?? entry.nodeShortName
          ?? entry.node?.short_name
          ?? entry.node?.shortName
          ?? null,
      longName:
        entry.node_long_name
          ?? entry.nodeLongName
          ?? entry.node?.long_name
          ?? entry.node?.longName
          ?? null,
    });
    if (entry.neighbor && typeof entry.neighbor === 'object') {
      registerRoleCandidate(index, {
        identifier: entry.neighbor.node_id ?? entry.neighbor.nodeId ?? entry.neighbor.id,
        numericId: entry.neighbor.node_num ?? entry.neighbor.nodeNum ?? entry.neighbor.num,
        role: entry.neighbor.role ?? entry.neighbor.roleName,
        shortName: entry.neighbor.short_name ?? entry.neighbor.shortName ?? null,
        longName: entry.neighbor.long_name ?? entry.neighbor.longName ?? null,
      });
    }
    if (entry.node && typeof entry.node === 'object') {
      registerRoleCandidate(index, {
        identifier: entry.node.node_id ?? entry.node.nodeId ?? entry.node.id,
        numericId: entry.node.node_num ?? entry.node.nodeNum ?? entry.node.num,
        role: entry.node.role ?? entry.node.roleName,
        shortName: entry.node.short_name ?? entry.node.shortName ?? null,
        longName: entry.node.long_name ?? entry.node.longName ?? null,
      });
    }
    const candidateIds = [
      entry.neighbor_id,
      entry.neighborId,
      entry.node_id,
      entry.nodeId,
      entry.neighbor?.node_id,
      entry.neighbor?.nodeId,
      entry.node?.node_id,
      entry.node?.nodeId,
    ];
    candidateIds.forEach(identifier => {
      const normalized = normalizeNodeId(identifier);
      if (normalized && !index.byId.has(normalized)) {
        missing.add(normalized);
      }
    });
  });
  return missing;
}

/**
 * Fetch missing neighbor role assignments using the nodes API.
 *
 * @param {{byId: Map<string, string>, byNum: Map<number, string>}} index Role index maps.
 * @param {Map<string, string>} fetchIdMap Mapping of normalized identifiers to raw fetch identifiers.
 * @param {Function} fetchImpl Fetch implementation.
 * @returns {Promise<void>} Completion promise.
 */
async function fetchMissingNeighborRoles(index, fetchIdMap, fetchImpl) {
  if (!(fetchIdMap instanceof Map) || fetchIdMap.size === 0) {
    return;
  }
  const fetchFn = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    return;
  }
  const tasks = [];
  for (const [normalized, raw] of fetchIdMap.entries()) {
    const task = (async () => {
      try {
        const response = await fetchFn(`/api/nodes/${encodeURIComponent(raw)}`, DEFAULT_FETCH_OPTIONS);
        if (response.status === 404) {
          return;
        }
        if (!response.ok) {
          throw new Error(`Failed to load node information for ${raw} (HTTP ${response.status})`);
        }
        const payload = await response.json();
        registerRoleCandidate(index, {
          identifier:
            payload?.node_id
            ?? payload?.nodeId
            ?? payload?.id
            ?? raw,
          numericId: payload?.node_num ?? payload?.nodeNum ?? payload?.num ?? null,
          role: payload?.role ?? payload?.node_role ?? payload?.nodeRole ?? null,
          shortName: payload?.short_name ?? payload?.shortName ?? null,
          longName: payload?.long_name ?? payload?.longName ?? null,
        });
      } catch (error) {
        console.warn('Failed to resolve neighbor role', error);
      }
    })();
    tasks.push(task);
  }
  if (tasks.length === 0) return;
  const batches = [];
  for (let i = 0; i < tasks.length; i += NEIGHBOR_ROLE_FETCH_CONCURRENCY) {
    batches.push(tasks.slice(i, i + NEIGHBOR_ROLE_FETCH_CONCURRENCY));
  }
  for (const batch of batches) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.all(batch);
  }
}

/**
 * Build an index of neighbor roles using cached data and API lookups.
 *
 * @param {Object} node Normalised node payload.
 * @param {Array<Object>} neighbors Neighbor entries for the node.
 * @param {{ fetchImpl?: Function }} [options] Fetch overrides.
 * @returns {Promise<{
 *   byId: Map<string, string>,
 *   byNum: Map<number, string>,
 *   detailsById: Map<string, Object>,
 *   detailsByNum: Map<number, Object>,
 * }>>} Role index maps enriched with neighbour metadata.
 */
async function buildNeighborRoleIndex(node, neighbors, { fetchImpl } = {}) {
  const index = { byId: new Map(), byNum: new Map(), detailsById: new Map(), detailsByNum: new Map() };
  registerRoleCandidate(index, {
    identifier: node?.nodeId ?? node?.node_id ?? node?.id ?? null,
    numericId: node?.nodeNum ?? node?.node_num ?? node?.num ?? null,
    role: node?.role ?? node?.rawSources?.node?.role ?? null,
    shortName: node?.shortName ?? node?.short_name ?? null,
    longName: node?.longName ?? node?.long_name ?? null,
  });
  if (node?.rawSources?.node && typeof node.rawSources.node === 'object') {
    registerRoleCandidate(index, {
      identifier: node.rawSources.node.node_id ?? node.rawSources.node.nodeId ?? null,
      numericId: node.rawSources.node.node_num ?? node.rawSources.node.nodeNum ?? null,
      role: node.rawSources.node.role ?? node.rawSources.node.node_role ?? null,
      shortName: node.rawSources.node.short_name ?? node.rawSources.node.shortName ?? null,
      longName: node.rawSources.node.long_name ?? node.rawSources.node.longName ?? null,
    });
  }

  const missingNormalized = seedNeighborRoleIndex(index, neighbors);
  if (missingNormalized.size === 0) {
    return index;
  }

  const fetchIdMap = new Map();
  if (Array.isArray(neighbors)) {
    neighbors.forEach(entry => {
      if (!entry || typeof entry !== 'object') return;
      const candidates = [
        entry.neighbor_id,
        entry.neighborId,
        entry.node_id,
        entry.nodeId,
        entry.neighbor?.node_id,
        entry.neighbor?.nodeId,
        entry.node?.node_id,
        entry.node?.nodeId,
      ];
      candidates.forEach(identifier => {
        const normalized = normalizeNodeId(identifier);
        if (normalized && missingNormalized.has(normalized) && !fetchIdMap.has(normalized)) {
          fetchIdMap.set(normalized, identifier);
        }
      });
    });
  }

  await fetchMissingNeighborRoles(index, fetchIdMap, fetchImpl);
  return index;
}

/**
 * Determine whether a neighbour record references the current node.
 *
 * @param {Object} entry Raw neighbour entry.
 * @param {string|null} ourId Canonical identifier for the current node.
 * @param {number|null} ourNum Canonical numeric identifier for the current node.
 * @param {Array<string>} idKeys Candidate identifier property names.
 * @param {Array<string>} numKeys Candidate numeric identifier property names.
 * @returns {boolean} ``true`` when the neighbour refers to the current node.
 */
function neighborMatches(entry, ourId, ourNum, idKeys, numKeys) {
  if (!entry || typeof entry !== 'object') return false;
  const ids = idKeys
    .map(key => stringOrNull(entry[key]))
    .filter(candidate => candidate != null)
    .map(candidate => candidate.toLowerCase());
  if (ourId && ids.includes(ourId.toLowerCase())) {
    return true;
  }
  if (ourNum == null) return false;
  return numKeys
    .map(key => numberOrNull(entry[key]))
    .some(candidate => candidate != null && candidate === ourNum);
}

/**
 * Categorise neighbour entries by their relationship to the current node.
 *
 * @param {Object} node Normalised node payload.
 * @param {Array<Object>} neighbors Raw neighbour entries.
 * @returns {{heardBy: Array<Object>, weHear: Array<Object>}} Categorised neighbours.
 */
function categoriseNeighbors(node, neighbors) {
  const heardBy = [];
  const weHear = [];
  if (!Array.isArray(neighbors) || neighbors.length === 0) {
    return { heardBy, weHear };
  }
  const ourId = stringOrNull(node?.nodeId ?? node?.node_id) ?? null;
  const ourNum = numberOrNull(node?.nodeNum ?? node?.node_num ?? node?.num);
  neighbors.forEach(entry => {
    if (!entry || typeof entry !== 'object') {
      return;
    }
    const matchesNeighbor = neighborMatches(entry, ourId, ourNum, ['neighbor_id', 'neighborId'], ['neighbor_num', 'neighborNum']);
    const matchesNode = neighborMatches(entry, ourId, ourNum, ['node_id', 'nodeId'], ['node_num', 'nodeNum']);
    if (matchesNeighbor) {
      heardBy.push(entry);
    }
    if (matchesNode) {
      weHear.push(entry);
    }
  });
  return { heardBy, weHear };
}

/**
 * Render a short-name badge with consistent role-aware styling.
 *
 * @param {Function} renderShortHtml Badge rendering implementation.
 * @param {{
 *   shortName?: string|null,
 *   longName?: string|null,
 *   role?: string|null,
 *   identifier?: string|null,
 *   numericId?: number|null,
 *   source?: Object|null,
 * }} payload Badge rendering payload.
 * @returns {string} HTML snippet describing the badge.
 */
function renderRoleAwareBadge(renderShortHtml, {
  shortName = null,
  longName = null,
  role = null,
  identifier = null,
  numericId = null,
  source = null,
} = {}) {
  const resolvedIdentifier = stringOrNull(identifier);
  let resolvedShort = stringOrNull(shortName);
  const resolvedLong = stringOrNull(longName);
  const resolvedRole = stringOrNull(role) ?? 'CLIENT';
  const resolvedNumericId = numberOrNull(numericId);
  let fallbackShort = resolvedShort;
  if (!fallbackShort && resolvedIdentifier) {
    const trimmed = resolvedIdentifier.replace(/^!+/, '');
    fallbackShort = trimmed.slice(-4).toUpperCase();
  }
  if (!fallbackShort) {
    fallbackShort = '?';
  }

  const badgeSource = source && typeof source === 'object' ? { ...source } : {};
  if (resolvedIdentifier) {
    if (!badgeSource.node_id) badgeSource.node_id = resolvedIdentifier;
    if (!badgeSource.nodeId) badgeSource.nodeId = resolvedIdentifier;
  }
  if (resolvedNumericId != null) {
    if (!badgeSource.node_num) badgeSource.node_num = resolvedNumericId;
    if (!badgeSource.nodeNum) badgeSource.nodeNum = resolvedNumericId;
  }
  if (resolvedShort) {
    if (!badgeSource.short_name) badgeSource.short_name = resolvedShort;
    if (!badgeSource.shortName) badgeSource.shortName = resolvedShort;
  }
  if (resolvedLong) {
    if (!badgeSource.long_name) badgeSource.long_name = resolvedLong;
    if (!badgeSource.longName) badgeSource.longName = resolvedLong;
  }
  badgeSource.role = badgeSource.role ?? resolvedRole;

  if (typeof renderShortHtml === 'function') {
    return renderShortHtml(resolvedShort ?? fallbackShort, resolvedRole, resolvedLong, badgeSource);
  }
  return `<span class="short-name">${escapeHtml(resolvedShort ?? fallbackShort)}</span>`;
}

/**
 * Generate a badge HTML fragment for a neighbour entry.
 *
 * @param {Object} entry Raw neighbour entry.
 * @param {'heardBy'|'weHear'} perspective Group perspective describing the relation.
 * @param {Function} renderShortHtml Badge rendering implementation.
 * @returns {string} HTML snippet for the badge or an empty string.
 */
function renderNeighborBadge(entry, perspective, renderShortHtml, roleIndex = null) {
  if (!entry || typeof entry !== 'object' || typeof renderShortHtml !== 'function') {
    return '';
  }
  const idKeys = perspective === 'heardBy'
    ? ['node_id', 'nodeId', 'id']
    : ['neighbor_id', 'neighborId', 'id'];
  const numKeys = perspective === 'heardBy'
    ? ['node_num', 'nodeNum']
    : ['neighbor_num', 'neighborNum'];
  const shortKeys = perspective === 'heardBy'
    ? ['node_short_name', 'nodeShortName', 'short_name', 'shortName']
    : ['neighbor_short_name', 'neighborShortName', 'short_name', 'shortName'];
  const longKeys = perspective === 'heardBy'
    ? ['node_long_name', 'nodeLongName', 'long_name', 'longName']
    : ['neighbor_long_name', 'neighborLongName', 'long_name', 'longName'];
  const roleKeys = perspective === 'heardBy'
    ? ['node_role', 'nodeRole', 'role']
    : ['neighbor_role', 'neighborRole', 'role'];

  const identifier = idKeys.map(key => stringOrNull(entry[key])).find(value => value != null);
  if (!identifier) return '';
  const numericId = numKeys.map(key => numberOrNull(entry[key])).find(value => value != null) ?? null;
  let shortName = shortKeys.map(key => stringOrNull(entry[key])).find(value => value != null) ?? null;
  let longName = longKeys.map(key => stringOrNull(entry[key])).find(value => value != null) ?? null;
  let role = roleKeys.map(key => stringOrNull(entry[key])).find(value => value != null) ?? null;
  const source = perspective === 'heardBy' ? entry.node : entry.neighbor;

  const metadata = lookupNeighborDetails(roleIndex, { identifier, numericId });
  if (metadata) {
    if (!shortName && metadata.shortName) {
      shortName = metadata.shortName;
    }
    if (!role && metadata.role) {
      role = metadata.role;
    }
    if (!longName && metadata.longName) {
      longName = metadata.longName;
    }
    if (metadata.shortName && source && typeof source === 'object') {
      if (!source.short_name) source.short_name = metadata.shortName;
      if (!source.shortName) source.shortName = metadata.shortName;
    }
    if (metadata.longName && source && typeof source === 'object') {
      if (!source.long_name) source.long_name = metadata.longName;
      if (!source.longName) source.longName = metadata.longName;
    }
    if (metadata.role && source && typeof source === 'object' && !source.role) {
      source.role = metadata.role;
    }
  }
  if (!shortName) {
    const trimmed = identifier.replace(/^!+/, '');
    shortName = trimmed.slice(-4).toUpperCase();
  }

  if (!role && source && typeof source === 'object') {
    role = stringOrNull(
      source.role
        ?? source.node_role
        ?? source.nodeRole
        ?? source.neighbor_role
        ?? source.neighborRole
        ?? source.roleName
        ?? null,
    );
  }

  if (!role) {
    const sourceId = source && typeof source === 'object'
      ? source.node_id ?? source.nodeId ?? source.id ?? null
      : null;
    const sourceNum = source && typeof source === 'object'
      ? source.node_num ?? source.nodeNum ?? source.num ?? null
      : null;
    role = lookupRole(roleIndex, {
      identifier: identifier ?? sourceId,
      numericId: numericId ?? sourceNum,
    });
  }

  return renderRoleAwareBadge(renderShortHtml, {
    shortName,
    longName,
    role: role ?? 'CLIENT',
    identifier,
    numericId,
    source,
  });
}

/**
 * Render a neighbour group as a titled list.
 *
 * @param {string} title Section title for the group.
 * @param {Array<Object>} entries Neighbour entries included in the group.
 * @param {'heardBy'|'weHear'} perspective Group perspective.
 * @param {Function} renderShortHtml Badge rendering implementation.
 * @returns {string} HTML markup or an empty string when no entries render.
 */
function renderNeighborGroup(title, entries, perspective, renderShortHtml, roleIndex = null) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return '';
  }
  const items = entries
    .map(entry => {
      const badgeHtml = renderNeighborBadge(entry, perspective, renderShortHtml, roleIndex);
      if (!badgeHtml) {
        return null;
      }
      const snrDisplay = formatSnr(entry?.snr);
      const snrHtml = snrDisplay ? `<span class="node-detail__neighbor-snr">(${escapeHtml(snrDisplay)})</span>` : '';
      return `<li>${badgeHtml}${snrHtml}</li>`;
    })
    .filter(item => item != null);
  if (items.length === 0) return '';
  return `
    <div class="node-detail__neighbors-group">
      <h4 class="node-detail__neighbors-title">${escapeHtml(title)}</h4>
      <ul class="node-detail__neighbors-list">${items.join('')}</ul>
    </div>
  `;
}

/**
 * Render neighbour information grouped by signal direction.
 *
 * @param {Object} node Normalised node payload.
 * @param {Array<Object>} neighbors Raw neighbour entries.
 * @param {Function} renderShortHtml Badge rendering implementation.
 * @returns {string} HTML markup for the neighbour section.
 */
function renderNeighborGroups(node, neighbors, renderShortHtml, { roleIndex = null } = {}) {
  const { heardBy, weHear } = categoriseNeighbors(node, neighbors);
  const heardByHtml = renderNeighborGroup('Heard by', heardBy, 'heardBy', renderShortHtml, roleIndex);
  const weHearHtml = renderNeighborGroup('We hear', weHear, 'weHear', renderShortHtml, roleIndex);
  const groups = [heardByHtml, weHearHtml].filter(section => stringOrNull(section));
  if (groups.length === 0) {
    return '';
  }
  return `
    <section class="node-detail__section node-detail__neighbors">
      <h3>Neighbors</h3>
      <div class="node-detail__neighbors-grid">${groups.join('')}</div>
    </section>
  `;
}

/**
 * Render a condensed node table containing a single entry.
 *
 * @param {Object} node Normalised node payload.
 * @param {Function} renderShortHtml Badge rendering implementation.
 * @param {number} [referenceSeconds] Optional reference timestamp for relative metrics.
 * @returns {string} HTML markup for the node table or an empty string.
 */
function renderSingleNodeTable(node, renderShortHtml, referenceSeconds = Date.now() / 1000) {
  if (!node || typeof node !== 'object' || typeof renderShortHtml !== 'function') {
    return '';
  }
  const nodeId = stringOrNull(node.nodeId ?? node.node_id) ?? '';
  const shortName = stringOrNull(node.shortName ?? node.short_name) ?? null;
  const longName = stringOrNull(node.longName ?? node.long_name) ?? '';
  const role = stringOrNull(node.role) ?? 'CLIENT';
  const numericId = numberOrNull(node.nodeNum ?? node.node_num ?? node.num);
  const badgeSource = node.rawSources?.node && typeof node.rawSources.node === 'object'
    ? node.rawSources.node
    : node;
  const badgeHtml = renderRoleAwareBadge(renderShortHtml, {
    shortName,
    longName,
    role,
    identifier: nodeId || null,
    numericId,
    source: badgeSource,
  });
  const hardware = formatHardwareModel(node.hwModel ?? node.hw_model);
  const battery = formatBattery(node.battery ?? node.battery_level);
  const voltage = formatVoltage(node.voltage ?? node.voltageReading);
  const uptime = formatDurationSeconds(node.uptime ?? node.uptime_seconds ?? node.uptimeSeconds);
  const channel = fmtTx(node.channel ?? node.channel_utilization ?? node.channelUtilization ?? null, 3);
  const airUtil = fmtTx(node.airUtil ?? node.air_util_tx ?? node.airUtilTx ?? null, 3);
  const temperature = fmtTemperature(node.temperature ?? node.temp);
  const humidity = fmtHumidity(node.humidity ?? node.relative_humidity ?? node.relativeHumidity);
  const pressure = fmtPressure(node.pressure ?? node.barometric_pressure ?? node.barometricPressure);
  const latitude = formatCoordinate(node.latitude ?? node.lat);
  const longitude = formatCoordinate(node.longitude ?? node.lon);
  const altitude = fmtAlt(node.altitude ?? node.alt, 'm');
  const lastSeen = formatRelativeSeconds(node.lastHeard ?? node.last_heard, referenceSeconds);
  const lastPosition = formatRelativeSeconds(node.positionTime ?? node.position_time, referenceSeconds);

  return `
    <div class="nodes-table-wrapper">
      <table class="nodes-detail-table" aria-label="Selected node details">
        <thead>
          <tr>
            <th class="nodes-col nodes-col--node-id">Node ID</th>
            <th class="nodes-col nodes-col--short-name">Short</th>
            <th class="nodes-col nodes-col--long-name">Long Name</th>
            <th class="nodes-col nodes-col--last-seen">Last Seen</th>
            <th class="nodes-col nodes-col--role">Role</th>
            <th class="nodes-col nodes-col--hw-model">HW Model</th>
            <th class="nodes-col nodes-col--battery">Battery</th>
            <th class="nodes-col nodes-col--voltage">Voltage</th>
            <th class="nodes-col nodes-col--uptime">Uptime</th>
            <th class="nodes-col nodes-col--channel-util">Channel Util</th>
            <th class="nodes-col nodes-col--air-util-tx">Air Util Tx</th>
            <th class="nodes-col nodes-col--temperature">Temperature</th>
            <th class="nodes-col nodes-col--humidity">Humidity</th>
            <th class="nodes-col nodes-col--pressure">Pressure</th>
            <th class="nodes-col nodes-col--latitude">Latitude</th>
            <th class="nodes-col nodes-col--longitude">Longitude</th>
            <th class="nodes-col nodes-col--altitude">Altitude</th>
            <th class="nodes-col nodes-col--last-position">Last Position</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td class="mono nodes-col nodes-col--node-id">${escapeHtml(nodeId)}</td>
            <td class="nodes-col nodes-col--short-name">${badgeHtml}</td>
            <td class="nodes-col nodes-col--long-name">${escapeHtml(longName)}</td>
            <td class="nodes-col nodes-col--last-seen">${escapeHtml(lastSeen)}</td>
            <td class="nodes-col nodes-col--role">${escapeHtml(role)}</td>
            <td class="nodes-col nodes-col--hw-model">${escapeHtml(hardware)}</td>
            <td class="nodes-col nodes-col--battery">${escapeHtml(battery ?? '')}</td>
            <td class="nodes-col nodes-col--voltage">${escapeHtml(voltage ?? '')}</td>
            <td class="nodes-col nodes-col--uptime">${escapeHtml(uptime)}</td>
            <td class="nodes-col nodes-col--channel-util">${escapeHtml(channel ?? '')}</td>
            <td class="nodes-col nodes-col--air-util-tx">${escapeHtml(airUtil ?? '')}</td>
            <td class="nodes-col nodes-col--temperature">${escapeHtml(temperature ?? '')}</td>
            <td class="nodes-col nodes-col--humidity">${escapeHtml(humidity ?? '')}</td>
            <td class="nodes-col nodes-col--pressure">${escapeHtml(pressure ?? '')}</td>
            <td class="nodes-col nodes-col--latitude">${escapeHtml(latitude)}</td>
            <td class="nodes-col nodes-col--longitude">${escapeHtml(longitude)}</td>
            <td class="nodes-col nodes-col--altitude">${escapeHtml(altitude ?? '')}</td>
            <td class="mono nodes-col nodes-col--last-position">${escapeHtml(lastPosition)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  `;
}

/**
 * Render a message list using structured metadata formatting.
 *
 * @param {Array<Object>} messages Message records.
 * @param {Function} renderShortHtml Badge rendering implementation.
 * @param {Object} node Node context used when message metadata is incomplete.
 * @returns {string} HTML string for the messages section.
 */
function renderMessages(messages, renderShortHtml, node) {
  if (!Array.isArray(messages) || messages.length === 0) return '';

  const fallbackNode = node && typeof node === 'object' ? node : null;

  const items = messages
    .map(message => {
      if (!message || typeof message !== 'object') return null;
      const text = stringOrNull(message.text) || stringOrNull(message.emoji);
      if (!text) return null;

      const timestamp = formatMessageTimestamp(message.rx_time, message.rx_iso);
      const metadata = extractChatMessageMetadata(message);
      if (!metadata.channelName) {
        const fallbackChannel = stringOrNull(
          message.channel_name
            ?? message.channelName
            ?? message.channel_label
            ?? null,
        );
        if (fallbackChannel) {
          metadata.channelName = fallbackChannel;
        } else {
          const numericChannel = numberOrNull(message.channel);
          if (numericChannel != null) {
            metadata.channelName = String(numericChannel);
          } else if (stringOrNull(message.channel)) {
            metadata.channelName = stringOrNull(message.channel);
          }
        }
      }

      const prefix = formatChatMessagePrefix({
        timestamp: escapeHtml(timestamp ?? ''),
        frequency: metadata.frequency ? escapeHtml(metadata.frequency) : null,
      });
      const presetTag = formatChatPresetTag({ presetCode: metadata.presetCode });
      const channelTag = formatChatChannelTag({ channelName: metadata.channelName });

      const messageNode = message.node && typeof message.node === 'object' ? message.node : null;
      const badgeHtml = renderRoleAwareBadge(renderShortHtml, {
        shortName: messageNode?.short_name ?? messageNode?.shortName ?? fallbackNode?.shortName ?? fallbackNode?.short_name,
        longName: messageNode?.long_name ?? messageNode?.longName ?? fallbackNode?.longName ?? fallbackNode?.long_name,
        role: messageNode?.role ?? fallbackNode?.role ?? null,
        identifier:
          message.node_id
            ?? message.nodeId
            ?? message.from_id
            ?? message.fromId
            ?? fallbackNode?.nodeId
            ?? fallbackNode?.node_id
            ?? null,
        numericId:
          message.node_num
            ?? message.nodeNum
            ?? message.from_num
            ?? message.fromNum
            ?? fallbackNode?.nodeNum
            ?? fallbackNode?.node_num
            ?? null,
        source: messageNode ?? fallbackNode?.rawSources?.node ?? fallbackNode,
      });

      return `<li>${prefix}${presetTag}${channelTag} ${badgeHtml} ${escapeHtml(text)}</li>`;
    })
    .filter(item => item != null);
  if (items.length === 0) return '';
  return `<ul class="node-detail__list">${items.join('')}</ul>`;
}

/**
 * Render the node detail layout to an HTML fragment.
 *
 * @param {Object} node Normalised node payload.
 * @param {{
 *   neighbors?: Array<Object>,
 *   messages?: Array<Object>,
 *   renderShortHtml: Function,
 * }} options Rendering options.
 * @returns {string} HTML fragment representing the detail view.
 */
function renderNodeDetailHtml(node, {
  neighbors = [],
  messages = [],
  renderShortHtml,
  neighborRoleIndex = null,
}) {
  const roleAwareBadge = renderRoleAwareBadge(renderShortHtml, {
    shortName: node.shortName ?? node.short_name,
    longName: node.longName ?? node.long_name,
    role: node.role,
    identifier: node.nodeId ?? node.node_id ?? null,
    numericId: node.nodeNum ?? node.node_num ?? node.num ?? null,
    source: node.rawSources?.node ?? node,
  });
  const longName = stringOrNull(node.longName ?? node.long_name);
  const identifier = stringOrNull(node.nodeId ?? node.node_id);
  const tableHtml = renderSingleNodeTable(node, renderShortHtml);
  const neighborsHtml = renderNeighborGroups(node, neighbors, renderShortHtml, { roleIndex: neighborRoleIndex });
  const messagesHtml = renderMessages(messages, renderShortHtml, node);

  const sections = [];
  const telemetrySections = renderTelemetryChartSections(Array.isArray(node.telemetryHistory) ? node.telemetryHistory : []);
  if (telemetrySections.length > 0) {
    sections.push(...telemetrySections);
  }
  if (neighborsHtml) {
    sections.push(neighborsHtml);
  }
  if (Array.isArray(messages) && messages.length > 0 && messagesHtml) {
    sections.push(`<section class="node-detail__section"><h3>Messages</h3>${messagesHtml}</section>`);
  }

  const identifierHtml = identifier ? `<span class="node-detail__identifier">[${escapeHtml(identifier)}]</span>` : '';
  const nameHtml = longName ? `<span class="node-detail__name">${escapeHtml(longName)}</span>` : '';
  const badgeHtml = `<span class="node-detail__badge">${roleAwareBadge}</span>`;
  const tableSection = tableHtml ? `<div class="node-detail__table">${tableHtml}</div>` : '';
  const contentHtml = sections.length > 0 ? `<div class="node-detail__content">${sections.join('')}</div>` : '';

  return `
    <header class="node-detail__header">
      <h2 class="node-detail__title">${badgeHtml}${nameHtml}${identifierHtml}</h2>
    </header>
    ${tableSection}
    ${contentHtml}
  `;
}

/**
 * Parse the serialized reference payload embedded in the DOM.
 *
 * @param {string} raw Raw JSON string.
 * @returns {Object|null} Parsed object or ``null`` when invalid.
 */
function parseReferencePayload(raw) {
  const trimmed = stringOrNull(raw);
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (error) {
    console.warn('Failed to parse node reference payload', error);
    return null;
  }
}

/**
 * Resolve the canonical renderShortHtml implementation, waiting briefly for
 * the dashboard to expose it when necessary.
 *
 * @param {Function|undefined} override Explicit override supplied by tests.
 * @returns {Promise<Function>} Badge rendering implementation.
 */
async function resolveRenderShortHtml(override) {
  if (typeof override === 'function') return override;
  const deadline = Date.now() + RENDER_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const candidate = globalThis.PotatoMesh?.renderShortHtml;
    if (typeof candidate === 'function') {
      return candidate;
    }
    await new Promise(resolve => setTimeout(resolve, RENDER_WAIT_INTERVAL_MS));
  }
  return short => `<span class="short-name">${escapeHtml(short ?? '?')}</span>`;
}

/**
 * Fetch recent messages for a node. Private mode bypasses the request.
 *
 * @param {string} identifier Canonical node identifier.
 * @param {{fetchImpl?: Function, includeEncrypted?: boolean, privateMode?: boolean}} options Fetch options.
 * @returns {Promise<Array<Object>>} Resolved message collection.
 */
async function fetchMessages(identifier, { fetchImpl, includeEncrypted = false, privateMode = false } = {}) {
  if (privateMode) return [];
  const fetchFn = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    throw new TypeError('A fetch implementation is required to load node messages');
  }
  const encodedId = encodeURIComponent(String(identifier));
  const encryptedFlag = includeEncrypted ? '&encrypted=1' : '';
  const url = `/api/messages/${encodedId}?limit=${MESSAGE_LIMIT}${encryptedFlag}`;
  const response = await fetchFn(url, DEFAULT_FETCH_OPTIONS);
  if (response.status === 404) return [];
  if (!response.ok) {
    throw new Error(`Failed to load node messages (HTTP ${response.status})`);
  }
  const payload = await response.json();
  return Array.isArray(payload) ? payload : [];
}

/**
 * Initialise the node detail page by hydrating the DOM with fetched data.
 *
 * @param {{
 *   document?: Document,
 *   fetchImpl?: Function,
 *   refreshImpl?: Function,
 *   renderShortHtml?: Function,
 * }} options Optional overrides for testing.
 * @returns {Promise<boolean>} ``true`` when the node was rendered successfully.
 */
export async function initializeNodeDetailPage(options = {}) {
  const documentRef = options.document ?? globalThis.document;
  if (!documentRef || typeof documentRef.querySelector !== 'function') {
    throw new TypeError('A document with querySelector support is required');
  }
  const root = documentRef.querySelector('#nodeDetail');
  if (!root) return false;

  const filterContainer = typeof documentRef.querySelector === 'function'
    ? documentRef.querySelector('.filter-input')
    : null;
  if (filterContainer) {
    if (typeof filterContainer.remove === 'function') {
      filterContainer.remove();
    } else {
      filterContainer.hidden = true;
    }
  }

  const referenceData = parseReferencePayload(root.dataset?.nodeReference ?? null);
  if (!referenceData) {
    root.innerHTML = '<p class="node-detail__error">Node reference unavailable.</p>';
    return false;
  }

  const identifier = stringOrNull(referenceData.nodeId) ?? null;
  const nodeNum = numberOrNull(referenceData.nodeNum);
  if (!identifier && nodeNum == null) {
    root.innerHTML = '<p class="node-detail__error">Node identifier missing.</p>';
    return false;
  }

  const refreshImpl = typeof options.refreshImpl === 'function' ? options.refreshImpl : refreshNodeInformation;
  const renderShortHtml = await resolveRenderShortHtml(options.renderShortHtml);
  const privateMode = (root.dataset?.privateMode ?? '').toLowerCase() === 'true';

  try {
    const node = await refreshImpl(referenceData, { fetchImpl: options.fetchImpl });
    const neighborRoleIndex = await buildNeighborRoleIndex(node, node.neighbors, {
      fetchImpl: options.fetchImpl,
    });
    const messages = await fetchMessages(identifier ?? node.nodeId ?? node.node_id ?? nodeNum, {
      fetchImpl: options.fetchImpl,
      privateMode,
    });
    const html = renderNodeDetailHtml(node, {
      neighbors: node.neighbors,
      messages,
      renderShortHtml,
      neighborRoleIndex,
    });
    root.innerHTML = html;
    return true;
  } catch (error) {
    console.error('Failed to render node detail page', error);
    root.innerHTML = '<p class="node-detail__error">Failed to load node details.</p>';
    return false;
  }
}

export const __testUtils = {
  stringOrNull,
  numberOrNull,
  escapeHtml,
  formatFrequency,
  formatBattery,
  formatVoltage,
  formatUptime,
  formatTimestamp,
  formatMessageTimestamp,
  formatHardwareModel,
  formatCoordinate,
  formatRelativeSeconds,
  formatDurationSeconds,
  formatSnr,
  padTwo,
  normalizeNodeId,
  registerRoleCandidate,
  lookupRole,
  lookupNeighborDetails,
  seedNeighborRoleIndex,
  buildNeighborRoleIndex,
  categoriseNeighbors,
  renderNeighborGroups,
  renderSingleNodeTable,
  renderMessages,
  renderNodeDetailHtml,
  parseReferencePayload,
  resolveRenderShortHtml,
  fetchMessages,
};
