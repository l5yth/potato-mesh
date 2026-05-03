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
 * Page-bootstrap helpers — DOM hydration and orchestration of the data fetch.
 *
 * @module node-page/bootstrap
 */

import { escapeHtml } from '../utils.js';
import { refreshNodeInformation } from '../node-details.js';
import { fetchMessages, fetchNodesById, fetchTracesForNode } from '../node-page-data.js';
import { numberOrNull, stringOrNull } from '../value-helpers.js';
import { buildNeighborRoleIndex } from './role-index.js';
import { buildTraceRoleIndex } from './traces.js';
import { renderNodeDetailHtml } from './detail-html.js';

const RENDER_WAIT_INTERVAL_MS = 20;
const RENDER_WAIT_TIMEOUT_MS = 500;

/**
 * Parse the serialized reference payload embedded in the DOM.
 *
 * @param {string} raw Raw JSON string.
 * @returns {Object|null} Parsed object or ``null`` when invalid.
 */
export function parseReferencePayload(raw) {
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
 * Normalise a node reference payload by extracting the canonical identifier or number.
 *
 * @param {*} reference Candidate reference object.
 * @returns {{nodeId: (string|null), nodeNum: (number|null)}|null} Normalised reference.
 */
export function normalizeNodeReference(reference) {
  if (!reference || typeof reference !== 'object') {
    return null;
  }
  const nodeId = stringOrNull(reference.nodeId ?? reference.node_id);
  const nodeNum = numberOrNull(reference.nodeNum ?? reference.node_num ?? reference.num);
  if (!nodeId && nodeNum == null) {
    return null;
  }
  return { nodeId, nodeNum };
}

/**
 * Resolve the canonical renderShortHtml implementation, waiting briefly for
 * the dashboard to expose it when necessary.
 *
 * @param {Function|undefined} override Explicit override supplied by tests.
 * @returns {Promise<Function>} Badge rendering implementation.
 */
export async function resolveRenderShortHtml(override) {
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
 * Fetch node detail HTML for the supplied reference payload.
 *
 * @param {Object} referenceData Node reference object embedded in the DOM.
 * @param {{
 *   document?: Document,
 *   fetchImpl?: Function,
 *   refreshImpl?: Function,
 *   renderShortHtml?: Function,
 *   privateMode?: boolean,
 * }} [options] Optional overrides for testing.
 * @returns {Promise<string>} HTML fragment for the detail view.
 */
export async function fetchNodeDetailHtml(referenceData, options = {}) {
  if (!referenceData || typeof referenceData !== 'object') {
    throw new TypeError('A node reference object is required to render node details');
  }
  const normalized = normalizeNodeReference(referenceData);
  if (!normalized) {
    throw new Error('Node identifier missing.');
  }

  const refreshImpl = typeof options.refreshImpl === 'function' ? options.refreshImpl : refreshNodeInformation;
  const renderShortHtml = await resolveRenderShortHtml(options.renderShortHtml);

  const node = await refreshImpl(referenceData, { fetchImpl: options.fetchImpl });
  const neighborRoleIndex = await buildNeighborRoleIndex(node, node.neighbors, {
    fetchImpl: options.fetchImpl,
  });
  const messageIdentifier =
    normalized.nodeId ??
    stringOrNull(node.nodeId ?? node.node_id) ??
    (normalized.nodeNum != null ? normalized.nodeNum : null);
  // Fetch messages, traces, and the global node registry in parallel.  The
  // registry is used by the chat-entry renderer to resolve MeshCore
  // ``@[Name]`` mentions and reply targets that reference nodes other than
  // the page's own node — without it, mention badges silently degrade to
  // plain ``@[Name]`` text and leading-mention replies don't surface as
  // ``[in reply to ...]`` prefixes.
  const [messages, traces, nodesById] = await Promise.all([
    fetchMessages(messageIdentifier, {
      fetchImpl: options.fetchImpl,
      privateMode: options.privateMode === true,
    }),
    fetchTracesForNode(messageIdentifier, { fetchImpl: options.fetchImpl }),
    fetchNodesById({ fetchImpl: options.fetchImpl }),
  ]);
  const roleIndex = await buildTraceRoleIndex(traces, neighborRoleIndex, { fetchImpl: options.fetchImpl });
  return renderNodeDetailHtml(node, {
    neighbors: node.neighbors,
    messages,
    traces,
    renderShortHtml,
    roleIndex,
    nodesById,
  });
}

/**
 * Initialise the node detail page by hydrating the DOM with fetched data.
 *
 * @param {{
 *   document?: Document,
 *   fetchImpl?: Function,
 *   refreshImpl?: Function,
 *   renderShortHtml?: Function,
 * }} [options] Optional overrides for testing.
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
  const privateMode = (root.dataset?.privateMode ?? '').toLowerCase() === 'true';

  try {
    const html = await fetchNodeDetailHtml(referenceData, {
      fetchImpl: options.fetchImpl,
      refreshImpl,
      renderShortHtml: options.renderShortHtml,
      privateMode,
    });
    root.innerHTML = html;
    return true;
  } catch (error) {
    console.error('Failed to render node detail page', error);
    root.innerHTML = '<p class="node-detail__error">Failed to load node details.</p>';
    return false;
  }
}
