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
 * Top-level layout assembly for the node detail page.
 *
 * @module node-page/detail-html
 */

import { escapeHtml } from '../utils.js';
import { protocolIconPrefixHtml } from '../protocol-helpers.js';
import { stringOrNull } from '../value-helpers.js';
import { renderRoleAwareBadge } from './badge.js';
import { renderNeighborGroups } from './neighbor-rendering.js';
import { renderSingleNodeTable } from './single-node-table.js';
import { renderTelemetryCharts } from './telemetry-charts.js';
import { renderMessages } from './messages.js';
import { renderTraceroutes } from './traces.js';

/**
 * Render the node detail layout to an HTML fragment.
 *
 * @param {Object} node Normalised node payload.
 * @param {{
 *   neighbors?: Array<Object>,
 *   messages?: Array<Object>,
 *   traces?: Array<Object>,
 *   renderShortHtml: Function,
 *   roleIndex?: Object|null,
 *   chartNowMs?: number,
 *   nodesById?: Map<string, Object>|null,
 * }} options Rendering options.
 * @returns {string} HTML fragment representing the detail view.
 */
export function renderNodeDetailHtml(node, {
  neighbors = [],
  messages = [],
  traces = [],
  renderShortHtml,
  roleIndex = null,
  chartNowMs = Date.now(),
  nodesById = null,
} = {}) {
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
  const nodeProtocol = stringOrNull(node.protocol) ?? null;
  const tableHtml = renderSingleNodeTable(node, renderShortHtml);
  const chartsHtml = renderTelemetryCharts(node, { nowMs: chartNowMs });
  const neighborsHtml = renderNeighborGroups(node, neighbors, renderShortHtml, { roleIndex });
  const tracesHtml = renderTraceroutes(traces, renderShortHtml, { roleIndex, node });
  const messagesHtml = renderMessages(messages, renderShortHtml, node, nodesById);

  const sections = [];
  if (neighborsHtml) {
    sections.push(neighborsHtml);
  }
  if (tracesHtml) {
    sections.push(tracesHtml);
  }
  if (Array.isArray(messages) && messages.length > 0 && messagesHtml) {
    sections.push(`<section class="node-detail__section"><h3>Messages</h3>${messagesHtml}</section>`);
  }

  const identifierHtml = identifier ? `<span class="node-detail__identifier">[${escapeHtml(identifier)}]</span>` : '';
  const iconPrefix = protocolIconPrefixHtml(nodeProtocol);
  const nameHtml = longName ? `<span class="node-detail__name">${iconPrefix}${escapeHtml(longName)}</span>` : '';
  const badgeHtml = `<span class="node-detail__badge">${roleAwareBadge}</span>`;
  const tableSection = tableHtml ? `<div class="node-detail__table">${tableHtml}</div>` : '';
  const contentHtml = sections.length > 0 ? `<div class="node-detail__content">${sections.join('')}</div>` : '';

  return `
    <header class="node-detail__header">
      <h2 class="node-detail__title">${badgeHtml}${nameHtml}${identifierHtml}</h2>
    </header>
    ${chartsHtml ?? ''}
    ${tableSection}
    ${contentHtml}
  `;
}
