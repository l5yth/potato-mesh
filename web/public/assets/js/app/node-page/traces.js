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
 * Trace-route rendering and the role-index extension that hydrates hop names.
 *
 * @module node-page/traces
 */

import { numberOrNull, stringOrNull } from '../value-helpers.js';
import {
  cloneRoleIndex,
  fetchNodeDetailsIntoIndex,
  lookupNeighborDetails,
  normalizeNodeId,
  registerRoleCandidate,
} from './role-index.js';
import { renderRoleAwareBadge } from './badge.js';

/**
 * Normalise a trace node reference into identifier and numeric forms.
 *
 * @param {*} value Raw trace endpoint/hop reference.
 * @returns {{ identifier: (string|null), numericId: (number|null) }|null} Normalised reference.
 */
export function normalizeTraceNodeRef(value) {
  const numericId = numberOrNull(value);
  const identifier = (() => {
    const stringId = stringOrNull(value);
    if (numericId != null) {
      const hex = (numericId >>> 0).toString(16).padStart(8, '0');
      return `!${hex}`;
    }
    return stringId;
  })();
  if (identifier == null && numericId == null) {
    return null;
  }
  return { identifier, numericId };
}

/**
 * Extract an ordered trace path containing the source, hops, and destination.
 *
 * @param {Object} trace Trace payload.
 * @returns {Array<{identifier: (string|null), numericId: (number|null)}>} Normalised path entries.
 */
export function extractTracePath(trace) {
  if (!trace || typeof trace !== 'object') return [];
  const path = [];
  const append = ref => {
    const normalized = normalizeTraceNodeRef(ref);
    if (!normalized) return;
    path.push(normalized);
  };
  append(trace.src ?? trace.source ?? trace.from);
  const hops = Array.isArray(trace.hops) ? trace.hops : [];
  hops.forEach(append);
  append(trace.dest ?? trace.destination ?? trace.to);
  return path;
}

/**
 * Build a fetch map for trace nodes missing display metadata.
 *
 * @param {Array<Object>} traces Trace payloads to inspect.
 * @param {{byId: Map<string, string>, byNum: Map<number, string>, detailsById: Map<string, Object>, detailsByNum: Map<number, Object>}} roleIndex Existing role index hydrated with known nodes.
 * @returns {Map<string, *>} Mapping of normalized identifiers to fetch payloads.
 */
export function collectTraceNodeFetchMap(traces, roleIndex) {
  const fetchIdMap = new Map();
  if (!Array.isArray(traces)) return fetchIdMap;

  for (const trace of traces) {
    const path = extractTracePath(trace);
    for (const ref of path) {
      const identifier = ref?.identifier ?? null;
      const numericId = ref?.numericId ?? null;
      registerRoleCandidate(roleIndex, { identifier, numericId });
      const details = lookupNeighborDetails(roleIndex, { identifier, numericId });
      const hasNames = Boolean(stringOrNull(details?.shortName) || stringOrNull(details?.longName));
      if (hasNames) continue;
      const normalized = normalizeNodeId(identifier);
      const numericKey = numberOrNull(numericId);
      const mapKey = normalized ?? (numericKey != null ? `#${numericKey}` : null);
      const fetchKey = identifier ?? numericKey;
      if (mapKey && fetchKey != null && !fetchIdMap.has(mapKey)) {
        fetchIdMap.set(mapKey, fetchKey);
      }
    }
  }

  return fetchIdMap;
}

/**
 * Build a role index enriched with node metadata for trace hops.
 *
 * @param {Array<Object>} traces Trace payloads.
 * @param {{byId?: Map<string, string>, byNum?: Map<number, string>, detailsById?: Map<string, Object>, detailsByNum?: Map<number, Object>}} [baseIndex]
 *   Optional base role index to clone.
 * @param {{ fetchImpl?: Function }} [options] Fetch overrides.
 * @returns {Promise<{byId: Map<string, string>, byNum: Map<number, string>, detailsById: Map<string, Object>, detailsByNum: Map<number, Object>}>}
 *   Hydrated role index containing hop metadata.
 */
export async function buildTraceRoleIndex(traces, baseIndex = null, { fetchImpl } = {}) {
  const roleIndex = cloneRoleIndex(baseIndex);
  const fetchIdMap = collectTraceNodeFetchMap(traces, roleIndex);
  await fetchNodeDetailsIntoIndex(roleIndex, fetchIdMap, fetchImpl, 'trace node metadata');
  return roleIndex;
}

/**
 * Render a trace path using short-name badges.
 *
 * @param {Array<{identifier: (string|null), numericId: (number|null)}>} path Ordered path references.
 * @param {Function} renderShortHtml Badge rendering function.
 * @param {{ roleIndex?: Object|null, node?: Object|null }} options Rendering helpers.
 * @returns {string} HTML fragment for the trace or ``''`` when unsuitable.
 */
export function renderTracePath(path, renderShortHtml, { roleIndex = null, node = null } = {}) {
  if (!Array.isArray(path) || path.length < 2 || typeof renderShortHtml !== 'function') {
    return '';
  }

  const nodeIdNormalized = normalizeNodeId(node?.nodeId ?? node?.node_id);
  const nodeNumNormalized = numberOrNull(node?.nodeNum ?? node?.node_num ?? node?.num);

  const renderBadge = ref => {
    const identifier = ref?.identifier ?? null;
    const numericId = ref?.numericId ?? null;
    const normalizedId = normalizeNodeId(identifier);
    const matchesNode =
      (normalizedId && nodeIdNormalized && normalizedId === nodeIdNormalized) ||
      (numericId != null && nodeNumNormalized != null && numericId === nodeNumNormalized);

    let details = lookupNeighborDetails(roleIndex, { identifier, numericId }) ?? undefined;
    if (matchesNode && node) {
      details = {
        ...(details || {}),
        role: node.role ?? details?.role ?? 'CLIENT',
        shortName: node.shortName ?? node.short_name ?? details?.shortName ?? null,
        longName: node.longName ?? node.long_name ?? details?.longName ?? null,
      };
    }

    return renderRoleAwareBadge(renderShortHtml, {
      shortName: details?.shortName ?? null,
      longName: details?.longName ?? null,
      role: details?.role ?? null,
      identifier,
      numericId,
      source: details,
    });
  };

  const items = path
    .map(renderBadge)
    .filter(fragment => stringOrNull(fragment));
  if (items.length < 2) {
    return '';
  }
  const arrow = '<span class="node-detail__trace-arrow" aria-hidden="true">&rarr;</span>';
  return `<li class="node-detail__trace">${items.join(arrow)}</li>`;
}

/**
 * Render all traceroutes associated with the node.
 *
 * @param {Array<Object>} traces Trace payloads.
 * @param {Function} renderShortHtml Badge renderer.
 * @param {{ roleIndex?: Object|null, node?: Object|null }} options Rendering helpers.
 * @returns {string} HTML fragment or ``''`` when absent.
 */
export function renderTraceroutes(traces, renderShortHtml, { roleIndex = null, node = null } = {}) {
  if (!Array.isArray(traces) || traces.length === 0 || typeof renderShortHtml !== 'function') {
    return '';
  }
  const items = traces
    .map(trace => renderTracePath(extractTracePath(trace), renderShortHtml, { roleIndex, node }))
    .filter(fragment => stringOrNull(fragment));
  if (items.length === 0) {
    return '';
  }
  return `
    <section class="node-detail__section node-detail__traceroutes">
      <h3>Traceroutes</h3>
      <ul class="node-detail__trace-list">${items.join('')}</ul>
    </section>
  `;
}
