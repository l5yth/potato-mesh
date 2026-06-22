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
 * Pure async fetch wrappers for the dashboard JSON API.
 *
 * Functions accept their own dependencies — chat-enabled flag, message-limit
 * normaliser — so they remain free of any closure / DOM state and can be
 * unit-tested standalone.
 *
 * @module main/data-fetchers
 */

import { NODE_LIMIT, SNAPSHOT_LIMIT, TRACE_LIMIT, TRACE_MAX_AGE_SECONDS } from './constants.js';
import { resolveTimestampSeconds } from './format-utils.js';

/**
 * Determine how many snapshots should be requested from the API to build a
 * richer aggregate.
 *
 * @param {number} requestedLimit Desired number of unique entities.
 * @param {number} [maxLimit=NODE_LIMIT] Maximum rows accepted by the API.
 * @returns {number} Effective request limit honouring {@link SNAPSHOT_LIMIT}.
 */
export function resolveSnapshotLimit(requestedLimit, maxLimit = NODE_LIMIT) {
  const base = Number.isFinite(requestedLimit) && requestedLimit > 0
    ? Math.floor(requestedLimit)
    : maxLimit;
  const expanded = base * SNAPSHOT_LIMIT;
  const candidate = expanded > base ? expanded : base;
  return Math.min(candidate, maxLimit);
}

/**
 * Filter trace entries to discard packets older than the configured window.
 *
 * @param {Array<Object>} traces Trace payloads.
 * @param {number} [maxAgeSeconds=TRACE_MAX_AGE_SECONDS] Maximum allowed age in seconds.
 * @returns {Array<Object>} Recent trace entries.
 */
export function filterRecentTraces(traces, maxAgeSeconds = TRACE_MAX_AGE_SECONDS) {
  if (!Array.isArray(traces)) {
    return [];
  }
  if (!Number.isFinite(maxAgeSeconds) || maxAgeSeconds <= 0) {
    return [...traces];
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  const cutoff = nowSeconds - maxAgeSeconds;
  return traces.filter(trace => {
    const rxTime = resolveTimestampSeconds(trace?.rx_time ?? trace?.rxTime, trace?.rx_iso ?? trace?.rxIso);
    return rxTime != null && rxTime >= cutoff;
  });
}

/**
 * Fetch the latest nodes from the JSON API.
 *
 * @param {number} [limit=NODE_LIMIT] Maximum number of records.
 * @param {number} [since=0] Unix timestamp; only rows newer than this are returned.
 * @returns {Promise<Array<Object>>} Parsed node payloads.
 */
export async function fetchNodes(limit = NODE_LIMIT, since = 0) {
  const effectiveLimit = resolveSnapshotLimit(limit, NODE_LIMIT);
  let url = `/api/nodes?limit=${effectiveLimit}`;
  if (since > 0) url += `&since=${since}`;
  const r = await fetch(url, { cache: 'default' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

/**
 * Retrieve a single node record by identifier from the API.
 *
 * @param {string} nodeId Canonical node identifier.
 * @returns {Promise<Object|null>} Parsed node payload or null when absent.
 */
export async function fetchNodeById(nodeId) {
  if (typeof nodeId !== 'string') return null;
  const trimmed = nodeId.trim();
  if (trimmed.length === 0) return null;
  const r = await fetch(`/api/nodes/${encodeURIComponent(trimmed)}`, { cache: 'default' });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

/**
 * Fetch recent messages from the JSON API.
 *
 * @param {number} limit Maximum number of rows.
 * @param {{ encrypted?: boolean, since?: number, before?: number, chatEnabled?: boolean, normaliseMessageLimit?: Function }} options
 *   Retrieval flags and dependency hooks.  When ``chatEnabled`` is false the
 *   function short-circuits to an empty array without contacting the API.
 *   ``before`` is an inclusive upper-bound ``rx_time`` cursor used for backward
 *   pagination (issue #796).
 * @returns {Promise<Array<Object>>} Parsed message payloads.
 */
export async function fetchMessages(limit, options = {}) {
  const { chatEnabled = true, normaliseMessageLimit, encrypted = false, since = 0, before = 0 } = options;
  if (!chatEnabled) return [];
  const safeLimit = typeof normaliseMessageLimit === 'function'
    ? normaliseMessageLimit(limit)
    : limit;
  const params = new URLSearchParams({ limit: String(safeLimit) });
  if (encrypted) {
    params.set('encrypted', 'true');
  }
  if (since > 0) {
    params.set('since', String(since));
  }
  if (before > 0) {
    params.set('before', String(before));
  }
  const query = params.toString();
  const r = await fetch(`/api/messages?${query}`, { cache: 'default' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

/**
 * Page backward through the message feed, ``yield``-ing each page's new rows.
 *
 * The API clamps each response to {@link MESSAGE_LIMIT} rows ordered newest →
 * oldest, so the whole window is only reachable by walking an inclusive
 * ``before`` cursor: pull a page, then re-request everything at or before the
 * oldest ``rx_time`` seen.  Rows are de-duplicated by ``id`` across pages (the
 * inclusive cursor re-returns each boundary row), and each page's freshly-seen
 * rows are yielded as soon as they arrive so callers can render progressively
 * instead of waiting for the entire window (issue #802).
 *
 * Iteration stops when a short page signals the window is exhausted, when a page
 * yields no new rows (the server ignored the cursor, or every row was a boundary
 * duplicate), when no row carries a usable timestamp cursor, or when ``maxPages``
 * is hit as a runaway backstop.
 *
 * @param {number} limit Page size (rows requested per API call).
 * @param {{ encrypted?: boolean, before?: number, chatEnabled?: boolean, normaliseMessageLimit?: Function, maxPages?: number }} [options]
 *   Retrieval flags, dependency hooks, an optional ``before`` cursor to seed the
 *   walk from (used to resume paging just past an already-loaded newest page),
 *   and an optional page-count backstop.
 * @yields {Array<Object>} The de-duplicated new rows of each page.
 * @returns {AsyncGenerator<Array<Object>>}
 */
export async function* paginateMessages(limit, options = {}) {
  const { maxPages = 200, before: initialBefore = 0, ...fetchOptions } = options;
  const seen = new Set();
  let before = Number.isFinite(initialBefore) && initialBefore > 0 ? initialBefore : 0;
  for (let page = 0; page < maxPages; page += 1) {
    // eslint-disable-next-line no-await-in-loop -- pages are inherently sequential (cursor depends on the prior page).
    const batch = await fetchMessages(limit, { ...fetchOptions, before });
    if (!Array.isArray(batch) || batch.length === 0) return;
    const fresh = [];
    let oldest = 0;
    for (const message of batch) {
      const id = message && message.id;
      if (id != null && !seen.has(id)) {
        seen.add(id);
        fresh.push(message);
      }
      const ts = Number(message && message.rx_time);
      if (Number.isFinite(ts) && (oldest === 0 || ts < oldest)) {
        oldest = ts;
      }
    }
    if (fresh.length > 0) {
      yield fresh;
    }
    // A short page means the window is exhausted; no new rows (or no usable
    // cursor) means we cannot make further progress without looping forever.
    if (batch.length < limit || fresh.length === 0 || oldest === 0) return;
    before = oldest;
  }
}

/**
 * Eagerly page *every* message in the server's visibility window into one array.
 *
 * Thin wrapper over {@link paginateMessages} that concatenates all yielded
 * pages — kept for callers (and tests) that want the whole window at once;
 * progressive callers iterate {@link paginateMessages} directly so they can
 * render each page as it arrives (issue #802).
 *
 * @param {number} limit Page size (rows requested per API call).
 * @param {{ encrypted?: boolean, before?: number, chatEnabled?: boolean, normaliseMessageLimit?: Function, maxPages?: number }} [options]
 *   Retrieval flags, dependency hooks, and an optional page-count backstop.
 * @returns {Promise<Array<Object>>} All de-duplicated messages in the window.
 */
export async function fetchAllMessages(limit, options = {}) {
  const all = [];
  for await (const batch of paginateMessages(limit, options)) {
    all.push(...batch);
  }
  return all;
}

/**
 * Fetch neighbour information from the JSON API.
 *
 * @param {number} [limit=NODE_LIMIT] Maximum number of rows.
 * @param {number} [since=0] Unix timestamp; only rows newer than this are returned.
 * @returns {Promise<Array<Object>>} Parsed neighbour payloads.
 */
export async function fetchNeighbors(limit = NODE_LIMIT, since = 0) {
  const effectiveLimit = resolveSnapshotLimit(limit, NODE_LIMIT);
  let url = `/api/neighbors?limit=${effectiveLimit}`;
  if (since > 0) url += `&since=${since}`;
  const r = await fetch(url, { cache: 'default' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

/**
 * Fetch traceroute observations from the JSON API.
 *
 * @param {number} [limit=TRACE_LIMIT] Maximum number of records.
 * @param {number} [since=0] Unix timestamp; only rows newer than this are returned.
 * @returns {Promise<Array<Object>>} Parsed trace payloads.
 */
export async function fetchTraces(limit = TRACE_LIMIT, since = 0) {
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : TRACE_LIMIT;
  const effectiveLimit = Math.min(safeLimit, NODE_LIMIT);
  let url = `/api/traces?limit=${effectiveLimit}`;
  if (since > 0) url += `&since=${since}`;
  const r = await fetch(url, { cache: 'default' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const traces = await r.json();
  return filterRecentTraces(traces, TRACE_MAX_AGE_SECONDS);
}

/**
 * Fetch telemetry entries from the JSON API.
 *
 * @param {number} [limit=NODE_LIMIT] Maximum number of rows.
 * @param {number} [since=0] Unix timestamp; only rows newer than this are returned.
 * @returns {Promise<Array<Object>>} Parsed telemetry payloads.
 */
export async function fetchTelemetry(limit = NODE_LIMIT, since = 0) {
  const effectiveLimit = resolveSnapshotLimit(limit, NODE_LIMIT);
  let url = `/api/telemetry?limit=${effectiveLimit}`;
  if (since > 0) url += `&since=${since}`;
  const r = await fetch(url, { cache: 'default' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

/**
 * Fetch position packets from the JSON API.
 *
 * @param {number} [limit=NODE_LIMIT] Maximum number of rows.
 * @param {number} [since=0] Unix timestamp; only rows newer than this are returned.
 * @returns {Promise<Array<Object>>} Parsed position payloads.
 */
export async function fetchPositions(limit = NODE_LIMIT, since = 0) {
  const effectiveLimit = resolveSnapshotLimit(limit, NODE_LIMIT);
  let url = `/api/positions?limit=${effectiveLimit}`;
  if (since > 0) url += `&since=${since}`;
  const r = await fetch(url, { cache: 'default' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
