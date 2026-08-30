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
 * Reticulum identity groups for the nodes table (SPEC RA1–RA3).
 *
 * Since RE7 a Reticulum identity is one node and its destinations are aspects of
 * it, so the table renders the identity as a parent row and each destination as
 * a sub-row.  Everything here is pure: `renderTable` owns the DOM, this module
 * owns the decisions and the markup, which is what makes the rules testable
 * without standing up the dashboard closure.
 *
 * @module main/identity-groups
 */

import { escapeHtml } from '../utils.js';
import { formatTableCell } from './table-cell-format.js';
import {
  defaultRoleFor,
  getRoleColor,
  getRoleTextColor,
  normalizeRole,
} from '../role-helpers.js';

/**
 * Aspect precedence for anything that must pick one of an identity's several
 * roles (SPEC RE10).
 *
 * The same order the ingestor ranks by, so the chip that leads a parent row is
 * the aspect that named it.  Lower is stronger.
 *
 * @type {Readonly<Record<string, number>>}
 */
export const ASPECT_ROLE_RANK = Object.freeze({
  NODE: 1,
  PEER: 2,
  PROPAGATION: 3,
  TRANSPORT: 4,
});

/**
 * Role chips shown on a parent row before the `+N` overflow takes over.
 *
 * Four aspects is the most a stock RNS stack announces, so a wider set is a
 * long tail that would push the Role column past its share of the row.
 *
 * @type {number}
 */
export const MAX_VISIBLE_ROLE_CHIPS = 3;

/**
 * The stored aspect naming the host's own transport instance (SPEC RE9/RA7).
 *
 * Kept in the data because it is what maps the row to the `TRANSPORT` role;
 * rendered as "no aspect" because it is not a destination anyone announces.
 *
 * @type {string}
 */
export const TRANSPORT_ASPECT = 'rns.transport';

/**
 * Rank a role for aspect precedence, unknown roles sorting last.
 *
 * @param {*} role Raw role value.
 * @returns {number} Sort rank; unknown roles fall after every known one.
 */
export function aspectRoleRank(role) {
  // Rank keys are protocol-neutral: every aspect role is explicit in
  // ASPECT_ROLE_RANK, and an unknown one sorts last either way.
  const key = normalizeRole(role);
  return ASPECT_ROLE_RANK[key] ?? Number.MAX_SAFE_INTEGER;
}

/**
 * Order an identity's destinations by aspect precedence, then newest first.
 *
 * Deterministic on purpose: the chip order on a collapsed parent and the
 * sub-row order under an open one are the same sequence, so opening a group
 * never reshuffles what the reader just looked at.
 *
 * @param {Array<Object>} destinations Destination rows for one identity.
 * @returns {Array<Object>} A new, sorted array.
 */
export function sortDestinations(destinations) {
  if (!Array.isArray(destinations)) return [];
  return [...destinations].sort((a, b) => {
    const byRank = aspectRoleRank(a?.role) - aspectRoleRank(b?.role);
    if (byRank !== 0) return byRank;
    return (Number(b?.last_heard) || 0) - (Number(a?.last_heard) || 0);
  });
}

/**
 * Decide whether a node renders as an expandable identity group.
 *
 * A single-destination identity renders flat with **no caret** (SPEC RA1): a
 * disclosure that opens onto one row misrepresents depth, and every
 * non-Reticulum node keeps its ordinary row (Invariant IV).
 *
 * @param {Object} node Node row from `/api/nodes`.
 * @param {Array<Object>} destinations The node's destinations.
 * @returns {boolean} `true` when a caret and sub-rows should render.
 */
export function isIdentityGroup(node, destinations) {
  return Array.isArray(destinations) && destinations.length > 1;
}

/**
 * Display label for an aspect, hiding the synthetic transport one (SPEC RA7).
 *
 * @param {*} aspect Stored aspect value.
 * @returns {string} Aspect name, or `''` when there is nothing to show.
 */
export function aspectLabel(aspect) {
  const text = typeof aspect === 'string' ? aspect.trim() : '';
  if (!text || text === TRANSPORT_ASPECT) return '';
  return text;
}

/**
 * Newest `last_heard` across an identity's destinations (SPEC RA1).
 *
 * @param {Array<Object>} destinations Destination rows.
 * @returns {?number} Newest timestamp, or `null` when none is usable.
 */
export function newestLastHeard(destinations) {
  if (!Array.isArray(destinations)) return null;
  let newest = null;
  for (const destination of destinations) {
    const ts = Number(destination?.last_heard);
    if (Number.isFinite(ts) && (newest === null || ts > newest)) newest = ts;
  }
  return newest;
}

/**
 * Render one role chip in its protocol's role colour.
 *
 * @param {string} role Role identifier.
 * @param {?string} protocol Protocol whose ramp to use.
 * @returns {string} Chip markup.
 */
function roleChipHtml(role, protocol) {
  // Delegate to the shared resolvers rather than indexing the palette here: a
  // local `?? colors.CLIENT` fallback reintroduces exactly the defect SPEC RA9
  // fixed, because CLIENT is a Meshtastic role absent from the Meshcore and
  // Reticulum ramps -- it resolved to grey and labelled the chip CLIENT.
  const key = normalizeRole(role, protocol);
  const background = getRoleColor(role, protocol);
  const textColor = getRoleTextColor(role, protocol);
  return (
    `<span class="role-chip" style="background:${background};color:${textColor}">` +
    `${escapeHtml(key)}</span>`
  );
}

/**
 * Render a parent row's role cell: one chip per aspect, then `+N`.
 *
 * Chips follow aspect precedence, so the role that named the identity leads and
 * the overflow hides the weakest aspects rather than an arbitrary tail.
 *
 * @param {Array<Object>} destinations Destination rows for the identity.
 * @param {?string} protocol Protocol whose role ramp applies.
 * @param {number} [maxChips] Visible chip budget before overflow.
 * @returns {string} Cell inner markup, or `''` when there is nothing to show.
 */
export function roleChipsHtml(destinations, protocol, maxChips = MAX_VISIBLE_ROLE_CHIPS) {
  const sorted = sortDestinations(destinations);
  if (sorted.length === 0) return '';
  const seen = [];
  for (const destination of sorted) {
    const key = normalizeRole(destination?.role, protocol);
    if (!seen.includes(key)) seen.push(key);
  }
  const visible = seen.slice(0, maxChips);
  const hidden = seen.length - visible.length;
  const chips = visible.map(role => roleChipHtml(role, protocol)).join('');
  // The overflow counts distinct roles, matching what the chips represent.
  const overflow = hidden > 0
    ? `<span class="role-chip role-chip--overflow">+${hidden}</span>`
    : '';
  return `${chips}${overflow}`;
}

/**
 * Render the disclosure control that replaces a grouped row's protocol glyph.
 *
 * Keeps the tile's violet inset so a collapsed group still reads as Reticulum
 * before it opens (SPEC RA1).
 *
 * @param {boolean} expanded Whether the group is currently open.
 * @param {string} nodeId Identity the control belongs to.
 * @returns {string} Button markup.
 */
export function disclosureCellHtml(expanded, nodeId) {
  const glyph = expanded ? '▾' : '▸';
  const label = expanded ? 'Collapse destinations' : 'Expand destinations';
  return (
    '<button type="button" class="identity-disclosure" ' +
    `aria-expanded="${expanded ? 'true' : 'false'}" ` +
    `data-identity="${escapeHtml(nodeId || '')}" ` +
    `aria-label="${label}">${glyph}</button>`
  );
}

/**
 * Format a protocol count as `identities (destinations)` (SPEC RA3).
 *
 * The bracket appears only where a node can hold more than one address, so it
 * marks a real distinction instead of decorating every protocol: pass a
 * `destinations` of `null` for Meshtastic and Meshcore and the bare count is
 * returned unchanged.
 *
 * @param {number} identities Node count for the protocol.
 * @param {?number} destinations Destination count, or `null` for a bare count.
 * @returns {string} Rendered count.
 */
export function formatProtocolCount(identities, destinations) {
  const nodes = Number.isFinite(identities) ? identities : 0;
  if (!Number.isFinite(destinations)) return String(nodes);
  return `${nodes} (${destinations})`;
}

/**
 * Total destinations across an index, for the bracketed count.
 *
 * @param {Map<string, Array<Object>>} index `node_id` → destination rows.
 * @returns {number} Total rows held.
 */
export function countDestinations(index) {
  if (!index || typeof index.forEach !== 'function') return 0;
  let total = 0;
  index.forEach(rows => {
    total += Array.isArray(rows) ? rows.length : 0;
  });
  return total;
}

/**
 * Order nodes for render so sub-rows can never separate from their parent.
 *
 * Sorting orders **parents**; a group's destinations are emitted immediately
 * after the identity they belong to (SPEC RA2), so no sort interleaves one
 * identity's addresses with another's.
 *
 * @param {Array<Object>} nodes Nodes in the active sort order.
 * @param {Map<string, Array<Object>>} index `node_id` → destination rows.
 * @param {Set<string>} expanded Identities currently open.
 * @returns {Array<{node: Object, destinations: Array<Object>, isGroup: boolean,
 *   isExpanded: boolean, subRows: Array<Object>}>} Render plan, parents in the
 *   given order with their destinations attached.
 */
export function planIdentityRows(nodes, index, expanded) {
  const plan = [];
  if (!Array.isArray(nodes)) return plan;
  const open = expanded instanceof Set ? expanded : new Set();
  for (const node of nodes) {
    const nodeId = typeof node?.node_id === 'string' ? node.node_id : '';
    const rows = (index && typeof index.get === 'function' ? index.get(nodeId) : null) ?? [];
    const destinations = sortDestinations(rows);
    const isGroup = isIdentityGroup(node, destinations);
    const isExpanded = isGroup && open.has(nodeId);
    plan.push({
      node,
      destinations,
      isGroup,
      isExpanded,
      subRows: isExpanded ? destinations : [],
    });
  }
  return plan;
}

/**
 * Render one destination sub-row's cells (SPEC RA2).
 *
 * Pure so the row markup is testable: `renderTable` owns the `<tr>` element and
 * the DOM, this owns what goes inside it. The aspect leads in place of the node
 * id, `Long Name` carries the destination's own name and `[!id]`, and every
 * remaining column reports the muted dash — a destination has no radio, no
 * battery and no position, and RA6 preserves the table's dash precisely so
 * "not reported" stays distinct from "still loading".
 *
 * @param {Object} destination Destination row.
 * @param {string} parentNodeId Identity the destination belongs to; the badge
 *   links here, since a destination's page canonicalises to its identity (RA5).
 * @param {string} lastSeenCellHtml Pre-rendered Last Seen `<td>` from the
 *   caller's timestamp builder, so the live-tick hook is identical to a
 *   parent row's.
 * @param {Function} renderShortHtmlImpl Badge renderer.
 * @returns {string} The row's inner cell markup.
 */
export function subRowCellsHtml(destination, parentNodeId, lastSeenCellHtml, renderShortHtmlImpl) {
  const label = aspectLabel(destination?.aspect);
  const destinationId = typeof destination?.id === 'string' ? destination.id : '';
  const shortId = destinationId ? `!${destinationId.slice(0, 8)}` : '';
  const badgeText = shortId.slice(1, 5);
  const name = typeof destination?.name === 'string' ? destination.name.trim() : '';
  const nameCell = [
    name ? escapeHtml(name) : formatTableCell(''),
    // A link, not decoration (SPEC RL5): /nodes/!<destination> canonicalises to
    // the owning identity (RA5), and until this existed the route was reachable
    // only by typing a URL.
    shortId
      ? `<a class="nodes-subrow__id mono" href="/nodes/${encodeURIComponent(shortId)}#dest-${escapeHtml(destinationId.slice(0, 8))}">[${escapeHtml(shortId)}]</a>`
      : '',
  ].filter(Boolean).join(' ');
  const blank = formatTableCell('');
  const blanks = [
    'frequency num', 'modem-preset',
  ].map(c => `<td class="nodes-col nodes-col--${c}">${blank}</td>`).join('');
  const trailing = [
    'hw-model', 'battery num', 'voltage num', 'uptime num', 'channel-util num',
    'air-util-tx num', 'temperature num', 'humidity num', 'pressure num',
    'latitude num', 'longitude num', 'altitude num', 'last-position num',
  ].map(c => `<td class="nodes-col nodes-col--${c}">${blank}</td>`).join('');
  return (
    '<td class="nodes-col nodes-col--protocol nodes-subrow__spacer"></td>' +
    `<td class="nodes-col nodes-col--node-id nodes-subrow__aspect mono">${label ? escapeHtml(label) : blank}</td>` +
    `<td class="nodes-col nodes-col--short-name">${renderShortHtmlImpl(badgeText, destination?.role, name, {
      protocol: 'reticulum', node_id: parentNodeId, short_name: badgeText, long_name: name,
    })}</td>` +
    `<td class="nodes-col nodes-col--long-name">${nameCell}</td>` +
    blanks +
    lastSeenCellHtml +
    // The role renders as a chip in its protocol colour, exactly as it does on
    // the parent row -- a sub-row that spells its role in plain text while the
    // row above it uses colour reads as two different kinds of value.
    `<td class="nodes-col nodes-col--role">${
      destination?.role ? roleChipsHtml([destination], 'reticulum') : formatTableCell('')
    }</td>` +
    trailing +
    '<td class="nodes-col nodes-col--more"></td>'
  );
}
