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
 * Neighbour-section rendering and the shared role-aware short-name badge.
 *
 * @module node-page/neighbor-rendering
 */

import { escapeHtml } from '../utils.js';
import { formatSnr } from '../node-page-charts.js';
import { numberOrNull, stringOrNull } from '../value-helpers.js';
import { lookupNeighborDetails, lookupRole } from './role-index.js';

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
export function neighborMatches(entry, ourId, ourNum, idKeys, numKeys) {
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
export function categoriseNeighbors(node, neighbors) {
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
export function renderRoleAwareBadge(renderShortHtml, {
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
 * @param {Object|null} [roleIndex] Role index providing supplementary metadata.
 * @returns {string} HTML snippet for the badge or an empty string.
 */
export function renderNeighborBadge(entry, perspective, renderShortHtml, roleIndex = null) {
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
 * @param {Object|null} [roleIndex] Role index providing supplementary metadata.
 * @returns {string} HTML markup or an empty string when no entries render.
 */
export function renderNeighborGroup(title, entries, perspective, renderShortHtml, roleIndex = null) {
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
 * @param {{ roleIndex?: Object|null }} [options] Rendering helpers.
 * @returns {string} HTML markup for the neighbour section.
 */
export function renderNeighborGroups(node, neighbors, renderShortHtml, { roleIndex = null } = {}) {
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
