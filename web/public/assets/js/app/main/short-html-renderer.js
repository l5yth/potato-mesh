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
import {
  getContrastTextColor,
  getRoleColor,
  getRoleTextColor,
  normalizeRole,
} from '../role-helpers.js';
import { isMeshcoreProtocol, isReticulumProtocol } from '../protocol-helpers.js';

/**
 * What a name needs the segmenter for: a CR or a code unit beyond ASCII. UAX
 * #29 joins no two ASCII characters but CR LF (GB3), so the grapheme count of
 * any other ASCII name is its length (SPEC MT2).
 *
 * @type {RegExp}
 */
const NEEDS_SEGMENTER = /[\r\u0080-\uffff]/;

/**
 * The one grapheme segmenter every badge shares (SPEC MT2), built on first
 * use: a new ``Intl.Segmenter`` per badge was about half of a badge's cost.
 * Its ``segment()`` returns an independent iterator on every call, so one
 * instance serves every badge.
 *
 * @type {?Intl.Segmenter}
 */
let sharedSegmenter = null;

/**
 * Count the grapheme clusters of a badge label as a new ``Intl.Segmenter()``
 * per call counted them (SPEC MT2): with the shared segmenter, without any for
 * ASCII without CR, and in UTF-16 code units where ``Intl.Segmenter`` is
 * missing, as before.
 *
 * @param {string} text Label text.
 * @returns {number} Number of grapheme clusters.
 */
function countGraphemes(text) {
  if (typeof Intl === 'undefined' || !Intl.Segmenter) return text.length;
  if (!NEEDS_SEGMENTER.test(text)) return text.length;
  if (!sharedSegmenter) sharedSegmenter = new Intl.Segmenter();
  return [...sharedSegmenter.segment(text)].length;
}

/**
 * The protocol a badge names in ``data-protocol`` (SPEC LA5): the one whose
 * palette paints it, so ``meshtastic`` for an absent or unknown protocol, as
 * {@link getRoleColor} reads it. ``base.css`` gives a MeshCore badge the
 * square corners of its map marker.
 *
 * @param {*} protocol Raw protocol of the badge's node.
 * @returns {'meshcore'|'reticulum'|'meshtastic'} The badge's protocol.
 */
export function badgeProtocol(protocol) {
  if (isMeshcoreProtocol(protocol)) return 'meshcore';
  if (isReticulumProtocol(protocol)) return 'reticulum';
  return 'meshtastic';
}

/**
 * Render a short name badge with role-based styling. Every badge names its
 * protocol in ``data-protocol`` ({@link badgeProtocol}, SPEC LA5).
 *
 * @param {string} short Short node identifier.
 * @param {string} role Node role string.
 * @param {string} longName Full node name.
 * @param {?Object} nodeData Optional node metadata attached to the badge.
 * @param {{ protocol?: ?string }} [options] ``protocol``: the protocol of the
 *   line the badge sits in, used when ``nodeData`` names none, also without a
 *   node record (a MeshCore line whose sender is unknown), so the badge's
 *   colours and corners follow its line.
 * @returns {string} HTML snippet describing the badge.
 */
export function renderShortHtml(short, role, longName, nodeData = null, { protocol: lineProtocol = null } = {}) {
  const safeTitle = longName ? escapeHtml(String(longName)) : '';
  const titleAttr = safeTitle ? ` title="${safeTitle}"` : '';
  const protocol = nodeData?.protocol ?? lineProtocol ?? null;
  // Pass the protocol so a role-less node takes its own base role rather than
  // Meshtastic's CLIENT (SPEC RA9); the overlay hook carries this value.
  const roleValue = normalizeRole(
    role != null && role !== '' ? role : (nodeData && nodeData.role),
    protocol,
  );
  let infoAttr = '';
  if (nodeData && typeof nodeData === 'object') {
    const info = {
      nodeId: nodeData.node_id ?? nodeData.nodeId ?? '',
      nodeNum: nodeData.num ?? nodeData.node_num ?? nodeData.nodeNum ?? null,
      shortName: short != null ? String(short) : (nodeData.short_name ?? ''),
      longName: nodeData.long_name ?? longName ?? '',
      role: roleValue,
      // Carry the protocol: the short-info overlay re-renders this badge from
      // `data-node-info` alone, so without it a Reticulum or Meshcore badge was
      // repainted in the Meshtastic palette (SPEC RA9/RD5).
      protocol,
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
  const protocolAttr = ` data-protocol="${badgeProtocol(protocol)}"`;
  if (!short) {
    const fallbackText = getContrastTextColor('#ccc');
    return `<span class="short-name"${protocolAttr} style="background:#ccc;color:${fallbackText}"${titleAttr}${infoAttr}>&nbsp;?&nbsp;</span>`;
  }
  // Pad the label for the badge.  For plain-ASCII names that are already
  // 4 characters (meshtastic always stores exactly 4) no padding is added.
  // Shorter names or names containing emoji/non-ASCII get a single space
  // on each side — grapheme width varies too much for character-count
  // centering to work reliably.
  const raw = String(short);
  const graphemeCount = countGraphemes(raw);
  let centred;
  if (graphemeCount >= 4) {
    centred = raw;
  } else {
    centred = ` ${raw} `;
  }
  const padded = escapeHtml(centred).replace(/ /g, '&nbsp;');
  const color = getRoleColor(roleValue, protocol);
  const textColor = getRoleTextColor(roleValue, protocol);
  const styleAttr = textColor ? `background:${color};color:${textColor}` : `background:${color}`;
  return `<span class="short-name"${protocolAttr} style="${styleAttr}"${titleAttr}${infoAttr}>${padded}</span>`;
}
