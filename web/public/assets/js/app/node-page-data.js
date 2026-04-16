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
 * Pure data-fetch helpers for the node detail page.
 *
 * These functions wrap the REST API calls needed by
 * {@link module:node-page}.  They are kept separate so they can be
 * unit-tested without importing the full rendering surface.
 *
 * @module node-page-data
 */

/** Shared fetch options for API calls, allowing conditional ETag revalidation. */
const DEFAULT_FETCH_OPTIONS = Object.freeze({ cache: 'default' });

/** Maximum number of messages to request from the messages API. */
const MESSAGE_LIMIT = 50;

/** Maximum number of traceroute records to request from the traces API. */
const TRACE_LIMIT = 200;

/** Maximum number of nodes to request from the nodes API for the registry. */
const NODES_LIMIT = 1000;

/**
 * Fetch the global node registry and return it as a Map keyed by node id.
 *
 * The node detail page uses this registry to resolve MeshCore mentions
 * (``@[Name]``) and reply targets that appear in messages but reference
 * nodes other than the page's own node.  The result is consumed by the
 * shared chat-entry renderer, mirroring the dashboard's behaviour.
 *
 * Returns an empty Map on any failure so the page still renders messages
 * without crashing — mentions and reply badges simply degrade to plain
 * fallback text in that case.
 *
 * @param {{ fetchImpl?: Function }} [options] Fetch options.
 * @returns {Promise<Map<string, Object>>} Lookup map keyed by node id.
 */
export async function fetchNodesById({ fetchImpl } = {}) {
  const fetchFn = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  if (typeof fetchFn !== 'function') return new Map();
  try {
    const response = await fetchFn(`/api/nodes?limit=${NODES_LIMIT}`, DEFAULT_FETCH_OPTIONS);
    if (!response.ok) return new Map();
    const payload = await response.json();
    if (!Array.isArray(payload)) return new Map();
    const map = new Map();
    for (const node of payload) {
      if (!node || typeof node !== 'object') continue;
      const id = node.node_id ?? node.nodeId ?? null;
      if (id) map.set(id, node);
    }
    return map;
  } catch (error) {
    // Network/JSON failures degrade gracefully — the page still renders.
    console.warn('Failed to load nodes registry for chat rendering', error);
    return new Map();
  }
}

/**
 * Fetch recent messages for a node.
 *
 * Private mode short-circuits the request and returns an empty array so that
 * deployments with ``PRIVATE=true`` never expose message content.
 *
 * @param {string} identifier Canonical node identifier (e.g. ``!aabbccdd``).
 * @param {{
 *   fetchImpl?: Function,
 *   includeEncrypted?: boolean,
 *   privateMode?: boolean,
 * }} [options] Fetch options.
 * @returns {Promise<Array<Object>>} Resolved message collection.
 * @throws {TypeError} When no fetch implementation is available.
 * @throws {Error} When the server returns a non-2xx, non-404 status.
 */
export async function fetchMessages(identifier, { fetchImpl, includeEncrypted = false, privateMode = false } = {}) {
  // Private deployments must never load message content.
  if (privateMode) return [];
  const fetchFn = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    throw new TypeError('A fetch implementation is required to load node messages');
  }
  const encodedId = encodeURIComponent(String(identifier));
  const encryptedFlag = includeEncrypted ? '&encrypted=1' : '';
  const url = `/api/messages/${encodedId}?limit=${MESSAGE_LIMIT}${encryptedFlag}`;
  const response = await fetchFn(url, DEFAULT_FETCH_OPTIONS);
  // A 404 simply means no messages exist yet — return empty rather than throw.
  if (response.status === 404) return [];
  if (!response.ok) {
    throw new Error(`Failed to load node messages (HTTP ${response.status})`);
  }
  const payload = await response.json();
  return Array.isArray(payload) ? payload : [];
}

/**
 * Fetch traceroute records for a node reference.
 *
 * Returns an empty array when ``identifier`` is ``null`` or ``undefined`` so
 * callers do not need to guard against missing identifiers.
 *
 * @param {string|number} identifier Canonical node identifier or numeric node
 *   number.
 * @param {{ fetchImpl?: Function }} [options] Fetch options.
 * @returns {Promise<Array<Object>>} Resolved trace collection.
 * @throws {TypeError} When no fetch implementation is available.
 * @throws {Error} When the server returns a non-2xx, non-404 status.
 */
export async function fetchTracesForNode(identifier, { fetchImpl } = {}) {
  // Nothing to fetch when the caller has no identifier yet.
  if (identifier == null) {
    return [];
  }
  const fetchFn = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    throw new TypeError('A fetch implementation is required to load traceroutes');
  }
  const encodedId = encodeURIComponent(String(identifier));
  const url = `/api/traces/${encodedId}?limit=${TRACE_LIMIT}`;
  const response = await fetchFn(url, DEFAULT_FETCH_OPTIONS);
  // A 404 means the node has no recorded traces — return empty rather than throw.
  if (response.status === 404) return [];
  if (!response.ok) {
    throw new Error(`Failed to load traceroutes (HTTP ${response.status})`);
  }
  const payload = await response.json();
  return Array.isArray(payload) ? payload : [];
}
