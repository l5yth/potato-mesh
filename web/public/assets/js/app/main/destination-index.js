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
 * Background loader and per-node index for Reticulum destinations (SPEC RA8).
 *
 * The nodes table groups a Reticulum identity's destinations under it (RA1), but
 * `/api/nodes` carries no destinations, so they are fetched separately and joined
 * in the browser by `node_id` (RA4).  That fetch runs **after first paint and
 * never blocks the table**: the row hierarchy renders from `/api/nodes` alone and
 * gains its chips, counts and sub-rows as pages arrive.  A slow, failing, or
 * truncated fetch therefore degrades to a table without groups rather than a
 * stalled one.
 *
 * @module main/destination-index
 */

import { paginateCollection } from './data-fetchers.js';

/**
 * Rows requested per destinations page.
 *
 * Well under the route's `MAX_QUERY_LIMIT` of 1000 so a mesh with many
 * destinations yields its first group quickly instead of waiting on one large
 * response — the whole point of paging this in the background.
 *
 * @type {number}
 */
export const DESTINATION_PAGE_LIMIT = 250;

/**
 * Page-count backstop for the destinations walk.
 *
 * `paginateCollection` already stops on a short page, a duplicate-only page, or
 * a missing cursor; this only bounds a pathological server.
 *
 * @type {number}
 */
export const DESTINATION_MAX_PAGES = 40;

/**
 * Fetch one page of destinations bounded by an inclusive `before` cursor.
 *
 * Fails **soft**: a non-OK status or a non-array body yields `[]`, which
 * `paginateCollection` reads as "window exhausted" and stops the walk. The table
 * keeps whatever groups already arrived.
 *
 * @param {number} limit Page size.
 * @param {number} before Inclusive `last_heard` upper bound (0 ⇒ newest page).
 * @param {{ fetchImpl?: Function }} [options] Injected fetch (tests).
 * @returns {Promise<Array<Object>>} Destination rows, or `[]` on any failure.
 */
export async function fetchDestinationPage(limit, before, { fetchImpl } = {}) {
  const fetchFn = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  if (typeof fetchFn !== 'function') return [];
  let url = `/api/destinations?limit=${limit}`;
  if (Number.isFinite(before) && before > 0) {
    url += `&before=${before}`;
  }
  try {
    // +cache: 'default'+ matches every other /api/* fetch: the dashboard relies
    // on HTTP caching and weak ETags rather than bypassing them per request.
    const response = await fetchFn(url, {
      cache: 'default',
      headers: { Accept: 'application/json' },
    });
    if (!response || !response.ok) return [];
    const payload = await response.json();
    return Array.isArray(payload) ? payload : [];
  } catch {
    // Offline, aborted, or malformed JSON — the groups simply do not appear.
    return [];
  }
}

/**
 * Group destination rows by the node they belong to.
 *
 * Rows without a usable `node_id` are dropped rather than collected under a
 * placeholder key: a destination that names no node cannot be grouped, and a
 * bucket keyed on `undefined` would render as a phantom identity.
 *
 * @param {Array<Object>} rows Destination rows.
 * @param {Map<string, Array<Object>>} [into] Existing index to extend, so
 *   successive pages accumulate instead of replacing.
 * @returns {Map<string, Array<Object>>} `node_id` → its destination rows.
 */
export function indexDestinationsByNode(rows, into = new Map()) {
  if (!Array.isArray(rows)) return into;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const nodeId = typeof row.node_id === 'string' ? row.node_id.trim() : '';
    if (!nodeId) continue;
    const bucket = into.get(nodeId);
    if (bucket) {
      bucket.push(row);
    } else {
      into.set(nodeId, [row]);
    }
  }
  return into;
}

/**
 * Walk every destinations page in the background, reporting progress.
 *
 * Each page extends one accumulating index and invokes `onUpdate` with it, so a
 * caller can repaint groups incrementally rather than waiting for the whole
 * window. The walk is the shared {@link paginateCollection} cursor loop — the
 * same one the chat feed uses — keyed on `id` with `last_heard` as the cursor,
 * which is the column `/api/destinations` orders by (SPEC RA8).
 *
 * Never rejects. Any failure mid-walk simply ends it with the pages gathered so
 * far already delivered, because a table without groups is a far better outcome
 * than a table that never renders (RA-A4).  The default page fetcher already
 * absorbs every transport failure, so the outer guard exists for an injected
 * `fetchPage` or a future change to the walk itself — it is the reason this
 * function can promise "never rejects" rather than inheriting the promise from
 * one collaborator.
 *
 * @param {{ fetchImpl?: Function, onUpdate?: Function, limit?: number,
 *   maxPages?: number, fetchPage?: Function }} [options] Injected fetch,
 *   progress callback, page size, runaway backstop, and an optional page
 *   fetcher override (tests, and any caller with its own transport).
 * @returns {Promise<Map<string, Array<Object>>>} The completed index.
 */
export async function loadDestinationIndex({
  fetchImpl,
  onUpdate,
  limit = DESTINATION_PAGE_LIMIT,
  maxPages = DESTINATION_MAX_PAGES,
  fetchPage,
} = {}) {
  const index = new Map();
  const loadPage = typeof fetchPage === 'function'
    ? fetchPage
    : (pageLimit, before) => fetchDestinationPage(pageLimit, before, { fetchImpl });
  const pages = paginateCollection(
    loadPage,
    {
      limit,
      maxPages,
      idOf: row => row?.id,
      cursorOf: row => row?.last_heard,
    },
  );
  try {
    for await (const rows of pages) {
      indexDestinationsByNode(rows, index);
      if (typeof onUpdate === 'function') {
        // A throwing consumer must not abort the walk it is observing.
        try {
          onUpdate(index);
        } catch {
          /* a bad repaint is not a reason to stop loading */
        }
      }
    }
  } catch {
    /* fail soft: keep whatever pages already landed */
  }
  return index;
}
