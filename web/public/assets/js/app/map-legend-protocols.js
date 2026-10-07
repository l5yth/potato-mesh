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
 * Which protocols the map legend lists (SPEC LP1).
 *
 * Each protocol has its own part of the legend: the Meshtastic column, or a
 * group in the first column for MeshCore and Reticulum (SPEC LS1). That part
 * keys the markers of its protocol, so it is listed only while that protocol
 * is in view.
 *
 * @module app/map-legend-protocols
 */

import { normalizeFilterProtocol } from './main/filter-helpers.js';

/**
 * Protocols that own a part of the map legend.
 *
 * @type {ReadonlyArray<string>}
 */
const LEGEND_PROTOCOLS = Object.freeze(['meshcore', 'meshtastic', 'reticulum']);

/**
 * Collect the protocols that have at least one node passing a predicate.
 *
 * Nodes are bucketed with {@link normalizeFilterProtocol}, the mapping the
 * role filters use, so a legacy node without a protocol counts as Meshtastic.
 *
 * @param {Array<Object>|undefined} nodes Loaded node records.
 * @param {function(Object): boolean} passes Predicate a node must pass.
 * @returns {Set<string>} Protocol tokens with at least one passing node.
 */
function protocolsWithPassingNodes(nodes, passes) {
  const found = new Set();
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (node && passes(node)) found.add(normalizeFilterProtocol(node.protocol));
  }
  return found;
}

/**
 * Decide which protocols the map legend lists (SPEC LP1).
 *
 * A protocol is listed while all three hold:
 *
 * 1. it had activity in the past 7 days (`stats[protocol].week` above 0);
 * 2. it is not hidden with its meta-row toggle (`hiddenProtocols`);
 * 3. while a text filter is set, at least one loaded node of that protocol
 *    passes the text and protocol filters.
 *
 * Role filters are not part of the third condition: a protocol whose roles
 * are all switched off stays listed, so its role chips stay reachable.
 * With no text filter set, the third condition does not apply.
 *
 * @param {Object} params Inputs.
 * @param {?Object} params.stats Normalised `/api/stats` snapshot; a missing
 *   per-protocol `week` count reads as 0.
 * @param {Set<string>} params.hiddenProtocols Protocols hidden with the
 *   meta-row toggles.
 * @param {Array<Object>} [params.nodes] Loaded node records.
 * @param {string} [params.query] Normalised text filter; empty when none is set.
 * @param {function(Object, string): boolean} [params.matchesText] Text filter:
 *   whether a node matches the query.
 * @param {function(Object): boolean} [params.matchesProtocol] Protocol filter:
 *   whether a node's protocol is shown.
 * @returns {Set<string>} Protocols whose legend column or group shows.
 */
export function legendProtocolsInView({ stats, hiddenProtocols, nodes, query, matchesText, matchesProtocol }) {
  // Only a set text filter can leave a protocol without a matching node; skip
  // the scan otherwise.
  const matched = query
    ? protocolsWithPassingNodes(nodes, node => matchesText(node, query) && matchesProtocol(node))
    : null;
  return new Set(
    LEGEND_PROTOCOLS.filter(
      protocol =>
        (stats?.[protocol]?.week ?? 0) > 0 &&
        !hiddenProtocols.has(protocol) &&
        (matched === null || matched.has(protocol)),
    ),
  );
}
