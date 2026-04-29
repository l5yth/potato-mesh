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
 * Neighbor / trace role index helpers shared across the node-detail submodules.
 *
 * @module node-page/role-index
 */

import { numberOrNull, stringOrNull } from '../value-helpers.js';

const DEFAULT_FETCH_OPTIONS = Object.freeze({ cache: 'default' });

/**
 * Maximum number of in-flight ``/api/nodes`` fetches issued in parallel when
 * resolving role information for neighbour badges.  Kept small to avoid
 * overwhelming the server with bursts of concurrent requests.
 */
const NEIGHBOR_ROLE_FETCH_CONCURRENCY = 4;

/**
 * Normalise a node identifier for consistent lookups.
 *
 * @param {*} identifier Candidate identifier.
 * @returns {string|null} Lower-case identifier or ``null`` when invalid.
 */
export function normalizeNodeId(identifier) {
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
export function registerRoleCandidate(
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
 * Clone an existing role index into fresh map instances.
 *
 * @param {Object|null|undefined} index Original role index maps.
 * @returns {{byId: Map<string, string>, byNum: Map<number, string>, detailsById: Map<string, Object>, detailsByNum: Map<number, Object>}}
 *   Cloned maps with identical entries.
 */
export function cloneRoleIndex(index) {
  return {
    byId: index?.byId instanceof Map ? new Map(index.byId) : new Map(),
    byNum: index?.byNum instanceof Map ? new Map(index.byNum) : new Map(),
    detailsById: index?.detailsById instanceof Map ? new Map(index.detailsById) : new Map(),
    detailsByNum: index?.detailsByNum instanceof Map ? new Map(index.detailsByNum) : new Map(),
  };
}

/**
 * Resolve a role from the provided index using identifier or numeric keys.
 *
 * @param {{byId?: Map<string, string>, byNum?: Map<number, string>}|null} index Role lookup maps.
 * @param {{ identifier?: *, numericId?: * }} payload Lookup payload.
 * @returns {string|null} Resolved role string or ``null`` when unavailable.
 */
export function lookupRole(index, { identifier = null, numericId = null } = {}) {
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
export function lookupNeighborDetails(index, { identifier = null, numericId = null } = {}) {
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
export function seedNeighborRoleIndex(index, neighbors) {
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
 * Fetch node metadata for the supplied identifiers and merge it into the role index.
 *
 * @param {{byId: Map<string, string>, byNum: Map<number, string>, detailsById: Map<string, Object>, detailsByNum: Map<number, Object>}} index Role index maps.
 * @param {Map<string, *>} fetchIdMap Mapping of normalized identifiers to raw fetch identifiers.
 * @param {Function} fetchImpl Fetch implementation.
 * @param {string} [contextLabel='node metadata'] Context string used in warning logs.
 * @returns {Promise<void>} Completion promise.
 */
export async function fetchNodeDetailsIntoIndex(index, fetchIdMap, fetchImpl, contextLabel = 'node metadata') {
  if (!(fetchIdMap instanceof Map) || fetchIdMap.size === 0) {
    return;
  }
  const fetchFn = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    return;
  }
  const tasks = [];
  for (const [, raw] of fetchIdMap.entries()) {
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
        console.warn(`Failed to resolve ${contextLabel}`, error);
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
 * Fetch missing neighbor role assignments using the nodes API.
 *
 * @param {{byId: Map<string, string>, byNum: Map<number, string>}} index Role index maps.
 * @param {Map<string, string>} fetchIdMap Mapping of normalized identifiers to raw fetch identifiers.
 * @param {Function} fetchImpl Fetch implementation.
 * @returns {Promise<void>} Completion promise.
 */
export async function fetchMissingNeighborRoles(index, fetchIdMap, fetchImpl) {
  await fetchNodeDetailsIntoIndex(index, fetchIdMap, fetchImpl, 'neighbor role');
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
 * }>} Role index maps enriched with neighbour metadata.
 */
export async function buildNeighborRoleIndex(node, neighbors, { fetchImpl } = {}) {
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
