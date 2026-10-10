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
import {
  fetchDestinationsForNode,
  fetchMessages,
  fetchNodesById,
  fetchTracesForNode,
  fetchWaypointsForNode,
  requestNodesById,
} from '../node-page-data.js';
import { numberOrNull, stringOrNull } from '../value-helpers.js';
import { buildNeighborRoleIndex } from './role-index.js';
import { buildTraceRoleIndex } from './traces.js';
import { renderNodeDetailHtml } from './detail-html.js';

/**
 * Bring the element named by the current URL fragment into view.
 *
 * A no-op without a fragment, without a matching element, or in an environment
 * with no `scrollIntoView` — the page is already correct in each case, the link
 * simply lands at the top.
 *
 * @param {Document} documentRef Document to resolve the fragment against.
 * @returns {boolean} `true` when an element was scrolled to.
 */
export function scrollToHashTarget(documentRef) {
  const hash = documentRef?.location?.hash
    ?? documentRef?.defaultView?.location?.hash
    ?? (typeof globalThis !== 'undefined' ? globalThis.location?.hash : '');
  const id = typeof hash === 'string' ? hash.replace(/^#/, '') : '';
  if (!id || typeof documentRef?.getElementById !== 'function') return false;
  const target = documentRef.getElementById(id);
  if (!target || typeof target.scrollIntoView !== 'function') return false;
  target.scrollIntoView();
  return true;
}
import { startRelativeTimeTicker } from '../main/relative-time-ticker.js';
import { badgeProtocol } from '../main/short-html-renderer.js';

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
  // The fallback badge names its protocol like the dashboard's (SPEC LA5).
  return (short, _role, _longName, nodeData = null) =>
    `<span class="short-name" data-protocol="${badgeProtocol(nodeData?.protocol)}">${escapeHtml(short ?? '?')}</span>`;
}

/**
 * Whether a supplied node registry can stand in for the ``/api/nodes`` page:
 * a Map holding at least one node. The dashboard's map is empty before its
 * first load and on pages without its data pipeline (ACCEPTANCE FP-A5), and
 * those fetch the page like the standalone node page (SPEC OV1).
 *
 * @param {*} nodesById Candidate registry.
 * @returns {boolean} ``true`` when the registry is usable.
 */
function isUsableRegistry(nodesById) {
  return nodesById instanceof Map && nodesById.size > 0;
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
 *   nodesById?: ?Map<string, Object>,
 * }} [options] Optional overrides for testing; ``nodesById`` is the
 *   dashboard's node registry, which the overlay hands over (SPEC OV1).
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

  // The node registry: the dashboard's when the overlay hands one over (SPEC
  // OV1), otherwise the ``/api/nodes`` page, requested beside the node's own
  // reads and read once they succeeded, so a failed node read drops it
  // unread and quietly (SPEC OV3). The role indexes fill from it, so only
  // nodes it lacks are looked up one by one (SPEC OV2), and the chat-entry
  // renderer resolves MeshCore ``@[Name]`` mentions and reply targets against
  // it: without it, mention badges degrade to plain ``@[Name]`` text and
  // leading-mention replies don't surface as ``↩`` reply prefixes.
  const givenRegistry = isUsableRegistry(options.nodesById) ? options.nodesById : null;
  const registryRequest = givenRegistry ? null : requestNodesById({ fetchImpl: options.fetchImpl });
  const node = await refreshImpl(referenceData, { fetchImpl: options.fetchImpl });
  const nodesById = givenRegistry
    ?? await fetchNodesById({ fetchImpl: options.fetchImpl, responsePromise: registryRequest });
  const neighborRoleIndex = await buildNeighborRoleIndex(node, node.neighbors, {
    fetchImpl: options.fetchImpl,
    nodesById,
  });
  const messageIdentifier =
    normalized.nodeId ??
    stringOrNull(node.nodeId ?? node.node_id) ??
    (normalized.nodeNum != null ? normalized.nodeNum : null);
  // Fetch messages, traces, waypoints and destinations in parallel.
  const [messages, traces, waypoints, destinations] = await Promise.all([
    fetchMessages(messageIdentifier, {
      fetchImpl: options.fetchImpl,
      privateMode: options.privateMode === true,
    }),
    fetchTracesForNode(messageIdentifier, { fetchImpl: options.fetchImpl }),
    fetchWaypointsForNode(messageIdentifier, {
      fetchImpl: options.fetchImpl,
      privateMode: options.privateMode === true,
    }),
    // Destinations for the identity page (SPEC RA5); empty for every
    // non-Reticulum node, which is what keeps the section absent there.
    fetchDestinationsForNode(messageIdentifier, { fetchImpl: options.fetchImpl }),
  ]);
  const roleIndex = await buildTraceRoleIndex(traces, neighborRoleIndex, {
    fetchImpl: options.fetchImpl,
    nodesById,
  });
  return renderNodeDetailHtml(node, {
    neighbors: node.neighbors,
    messages,
    traces,
    waypoints,
    destinations,
    renderShortHtml,
    roleIndex,
    nodesById,
  });
}

/**
 * The node-detail page's shared relative-time ticker handle (SPEC RT1/RT2);
 * a re-init stops the previous ticker so exactly one clock drives the page.
 */
let relativeTimeTicker = null;

/**
 * Expose the page's ticker handle for unit tests (SPEC RT5).
 *
 * @returns {?{tick: Function, stop: Function, running: Function}} The live
 *   ticker handle, or null before {@link initializeNodeDetailPage} rendered.
 */
export function getNodeDetailRelativeTimeTicker() {
  return relativeTimeTicker;
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
    // The destinations table is built after several awaited fetches, so the
    // browser has already resolved any `#dest-…` fragment against a page that
    // did not yet contain the row (SPEC RL5). Re-target it once the row exists,
    // otherwise a destination link lands at the top of the page instead of on
    // the row it names.
    scrollToHashTarget(documentRef);
    // One shared presentation clock keeps the rendered last-seen /
    // last-position ages counting up in place (SPEC RT1/RT2); re-initialising
    // replaces the previous ticker so the page never runs two clocks.
    if (relativeTimeTicker) relativeTimeTicker.stop();
    relativeTimeTicker = startRelativeTimeTicker({ documentRef });
    return true;
  } catch (error) {
    console.error('Failed to render node detail page', error);
    root.innerHTML = '<p class="node-detail__error">Failed to load node details.</p>';
    return false;
  }
}
