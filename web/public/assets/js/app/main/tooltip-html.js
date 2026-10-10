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
 * HTML builders for trace and neighbour map tooltips, and the tooltip content
 * the map binds, which Leaflet builds when a tooltip opens (SPEC MT1).
 *
 * @module main/tooltip-html
 */

import { normalizeNodeNameValue } from '../node-rendering.js';
import { renderShortHtml } from './short-html-renderer.js';

/**
 * The hops of a trace path that get a badge: its node objects, or ``null``
 * when the path has fewer than two entries or no node object at all.
 *
 * @param {*} pathNodes Ordered node payloads along the trace.
 * @returns {?Array<Object>} Hops to badge, in path order.
 */
function traceTooltipHops(pathNodes) {
  if (!Array.isArray(pathNodes) || pathNodes.length < 2) {
    return null;
  }
  const hops = pathNodes.filter(node => node && typeof node === 'object');
  return hops.length ? hops : null;
}

/**
 * Build tooltip HTML showing styled short-name badges for a trace path.
 *
 * @param {Array<Object>} pathNodes Ordered node payloads along the trace.
 * @returns {string} HTML fragment or ``''`` when unavailable.
 */
export function buildTraceTooltipHtml(pathNodes) {
  const hops = traceTooltipHops(pathNodes);
  if (!hops) return '';
  const parts = hops.map(node => {
    const short = normalizeNodeNameValue(node.short_name ?? node.shortName) || (typeof node.node_id === 'string' ? node.node_id : '');
    const long = normalizeNodeNameValue(node.long_name ?? node.longName) || '';
    return renderShortHtml(short, node.role, long, node);
  });
  const arrow = '<span class="trace-tooltip__arrow" aria-hidden="true">→</span>';
  return `<div class="trace-tooltip__content">${parts.join(arrow)}</div>`;
}

/**
 * The two short names a neighbour tooltip shows, or ``null`` when either is
 * missing and the segment gets no tooltip.
 *
 * @param {?Object} segment Neighbor segment descriptor.
 * @returns {?{sourceNode: ?Object, targetNode: ?Object, sourceShort: string, targetShort: string}}
 *   The nodes and their badge names.
 */
function neighborTooltipNames(segment) {
  if (!segment) return null;
  const sourceNode = segment.sourceNode || null;
  const targetNode = segment.targetNode || null;
  const sourceShort = normalizeNodeNameValue(
    segment.sourceShortName ||
    (sourceNode ? sourceNode.short_name ?? sourceNode.shortName : null) ||
    (sourceNode && typeof sourceNode.node_id === 'string' ? sourceNode.node_id : '')
  );
  const targetShort = normalizeNodeNameValue(
    segment.targetShortName ||
    (targetNode ? targetNode.short_name ?? targetNode.shortName : null) ||
    (targetNode && typeof targetNode.node_id === 'string' ? targetNode.node_id : '')
  );
  if (!sourceShort || !targetShort) return null;
  return { sourceNode, targetNode, sourceShort, targetShort };
}

/**
 * Build tooltip HTML for a neighbor segment showing styled short-name badges.
 *
 * @param {{sourceNode?: Object, targetNode?: Object, sourceShortName?: string, targetShortName?: string, sourceRole?: string, targetRole?: string}} segment Neighbor segment descriptor.
 * @returns {string} HTML fragment or ``''`` when unavailable.
 */
export function buildNeighborTooltipHtml(segment) {
  const names = neighborTooltipNames(segment);
  if (!names) return '';
  const { sourceNode, targetNode, sourceShort, targetShort } = names;
  const sourceLong = normalizeNodeNameValue(sourceNode?.long_name ?? sourceNode?.longName) || '';
  const targetLong = normalizeNodeNameValue(targetNode?.long_name ?? targetNode?.longName) || '';
  const sourceHtml = renderShortHtml(sourceShort, segment.sourceRole, sourceLong, sourceNode || {});
  const targetHtml = renderShortHtml(targetShort, segment.targetRole, targetLong, targetNode || {});
  const arrow = '<span class="trace-tooltip__arrow" aria-hidden="true">→</span>';
  return `<div class="trace-tooltip__content">${sourceHtml}${arrow}${targetHtml}</div>`;
}

/**
 * Tooltip content for a trace hop line that Leaflet builds each time the
 * tooltip opens (SPEC MT1): a function returning
 * {@link buildTraceTooltipHtml} for the path, or ``null`` where that builder
 * returns ``''``, so such a line still gets no tooltip.
 *
 * @param {Array<Object>} pathNodes Ordered node payloads along the trace.
 * @returns {?function(): string} Leaflet tooltip content, or ``null``.
 */
export function traceTooltipContent(pathNodes) {
  return traceTooltipHops(pathNodes) ? () => buildTraceTooltipHtml(pathNodes) : null;
}

/**
 * Tooltip content for a neighbour line that Leaflet builds each time the
 * tooltip opens (SPEC MT1): a function returning
 * {@link buildNeighborTooltipHtml} for the segment, or ``null`` where that
 * builder returns ``''``, so such a line still gets no tooltip.
 *
 * @param {Object} segment Neighbor segment descriptor, as for
 *   {@link buildNeighborTooltipHtml}.
 * @returns {?function(): string} Leaflet tooltip content, or ``null``.
 */
export function neighborTooltipContent(segment) {
  return neighborTooltipNames(segment) ? () => buildNeighborTooltipHtml(segment) : null;
}
