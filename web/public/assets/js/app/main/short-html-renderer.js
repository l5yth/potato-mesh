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
 * Render the role-aware short-name badge used by maps, tables, popups, and
 * overlay surfaces.
 *
 * The function is deliberately dependency-free besides shared modules so it
 * can be exposed via ``globalThis.PotatoMesh.renderShortHtml`` and consumed by
 * the node-detail page without dragging the dashboard's closure state along.
 *
 * @module main/short-html-renderer
 */

import { escapeHtml } from '../utils.js';
import { collectTelemetryMetrics } from '../short-info-telemetry.js';
import { getRoleColor, getRoleTextColor, normalizeRole } from '../role-helpers.js';

/**
 * Render a short name badge with role-based styling.
 *
 * @param {string} short Short node identifier.
 * @param {string} role Node role string.
 * @param {string} longName Full node name.
 * @param {?Object} nodeData Optional node metadata attached to the badge.
 * @returns {string} HTML snippet describing the badge.
 */
export function renderShortHtml(short, role, longName, nodeData = null) {
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
    return `<span class="short-name" style="background:#ccc"${titleAttr}${infoAttr}>&nbsp;?&nbsp;</span>`;
  }
  // Pad the label for the badge.  For plain-ASCII names that are already
  // 4 characters (meshtastic always stores exactly 4) no padding is added.
  // Shorter names or names containing emoji/non-ASCII get a single space
  // on each side — grapheme width varies too much for character-count
  // centering to work reliably.
  const raw = String(short);
  const graphemeCount = typeof Intl !== 'undefined' && Intl.Segmenter
    ? [...new Intl.Segmenter().segment(raw)].length
    : raw.length;
  let centred;
  if (graphemeCount >= 4) {
    centred = raw;
  } else {
    centred = ` ${raw} `;
  }
  const padded = escapeHtml(centred).replace(/ /g, '&nbsp;');
  const protocol = nodeData?.protocol ?? null;
  const color = getRoleColor(roleValue, protocol);
  const textColor = getRoleTextColor(roleValue, protocol);
  const styleAttr = textColor ? `background:${color};color:${textColor}` : `background:${color}`;
  return `<span class="short-name" style="${styleAttr}"${titleAttr}${infoAttr}>${padded}</span>`;
}
