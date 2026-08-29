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

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DESTINATION_PAGE_LIMIT,
  fetchDestinationPage,
  indexDestinationsByNode,
  loadDestinationIndex,
} from '../destination-index.js';

/** Build a destination row with the fields the index and walk rely on. */
function row(id, nodeId, lastHeard) {
  return { id, node_id: nodeId, last_heard: lastHeard, aspect: 'lxmf.delivery' };
}

/** A fetch stub serving fixed pages and recording the URLs requested. */
function pagedFetch(pages, { calls = [] } = {}) {
  let call = 0;
  return async url => {
    calls.push(url);
    const page = pages[call] ?? [];
    call += 1;
    return { ok: true, async json() { return page; } };
  };
}

test('fetchDestinationPage requests the paged route and omits a zero cursor', async () => {
  const calls = [];
  await fetchDestinationPage(250, 0, { fetchImpl: pagedFetch([[]], { calls }) });
  assert.match(calls[0], /^\/api\/destinations\?limit=250$/);

  const cursored = [];
  await fetchDestinationPage(250, 1700, { fetchImpl: pagedFetch([[]], { calls: cursored }) });
  assert.match(cursored[0], /\/api\/destinations\?limit=250&before=1700$/);
});

test('fetchDestinationPage fails soft on every failure mode', async () => {
  // Each of these must yield [] rather than throw: the walk reads [] as
  // "exhausted" and the table simply keeps the groups it already has.
  assert.deepEqual(
    await fetchDestinationPage(10, 0, { fetchImpl: async () => ({ ok: false, status: 500 }) }),
    [],
  );
  assert.deepEqual(
    await fetchDestinationPage(10, 0, { fetchImpl: async () => { throw new Error('offline'); } }),
    [],
  );
  assert.deepEqual(
    await fetchDestinationPage(10, 0, {
      fetchImpl: async () => ({ ok: true, async json() { return { not: 'an array' }; } }),
    }),
    [],
  );
  assert.deepEqual(
    await fetchDestinationPage(10, 0, { fetchImpl: async () => null }),
    [],
  );
  // No fetch implementation at all (SSR / stripped environment).
  assert.deepEqual(await fetchDestinationPage(10, 0, { fetchImpl: null }), []);
});

test('indexDestinationsByNode groups rows and accumulates across pages', () => {
  const index = indexDestinationsByNode([
    row('d1', '!aaaa1111', 30),
    row('d2', '!aaaa1111', 20),
    row('d3', '!bbbb2222', 10),
  ]);
  assert.deepEqual([...index.keys()], ['!aaaa1111', '!bbbb2222']);
  assert.equal(index.get('!aaaa1111').length, 2);

  // A second page extends the same index rather than replacing it.
  indexDestinationsByNode([row('d4', '!aaaa1111', 5)], index);
  assert.equal(index.get('!aaaa1111').length, 3);
});

test('indexDestinationsByNode drops rows that name no node', () => {
  // A bucket keyed on a missing node_id would render as a phantom identity.
  const index = indexDestinationsByNode([
    row('d1', '', 30),
    row('d2', '   ', 20),
    { id: 'd3', last_heard: 10 },
    null,
    'not-an-object',
    row('d5', '!cccc3333', 5),
  ]);
  assert.deepEqual([...index.keys()], ['!cccc3333']);
  assert.deepEqual(indexDestinationsByNode(null), new Map());
});

test('loadDestinationIndex walks pages and reports progress incrementally', async () => {
  // Two full pages then a short one. The cursor walk repeats the boundary row
  // (inclusive <=, SPEC RA8) and the id-dedup collapses it.
  const calls = [];
  const fetchImpl = pagedFetch(
    [
      [row('d1', '!aaaa1111', 30), row('d2', '!aaaa1111', 20)],
      [row('d2', '!aaaa1111', 20), row('d3', '!bbbb2222', 10)],
      [row('d3', '!bbbb2222', 10)],
    ],
    { calls },
  );
  const snapshots = [];
  const index = await loadDestinationIndex({
    fetchImpl,
    limit: 2,
    onUpdate: current => snapshots.push(current.size),
  });

  assert.equal(index.get('!aaaa1111').length, 2);
  assert.equal(index.get('!bbbb2222').length, 1);
  // Progress was reported as pages landed, not once at the end.
  assert.ok(snapshots.length >= 2, `expected incremental updates, got ${snapshots}`);
  // The second request carried the oldest last_heard of the first page.
  assert.match(calls[1], /before=20$/);
});

test('loadDestinationIndex keeps the pages it already has when one fails', async () => {
  // The RA-A4 promise: a mid-walk failure degrades to fewer groups, never to a
  // rejected promise that would strand the caller mid-render.
  let call = 0;
  const fetchImpl = async () => {
    call += 1;
    if (call === 1) {
      return { ok: true, async json() { return [row('d1', '!aaaa1111', 30), row('d2', '!aaaa1111', 20)]; } };
    }
    throw new Error('connection reset');
  };
  const index = await loadDestinationIndex({ fetchImpl, limit: 2 });
  assert.equal(index.get('!aaaa1111').length, 2);
});

test('loadDestinationIndex resolves empty when the very first page fails', async () => {
  const index = await loadDestinationIndex({
    fetchImpl: async () => ({ ok: false, status: 503 }),
  });
  assert.equal(index.size, 0);
});

test('loadDestinationIndex survives a throwing onUpdate consumer', async () => {
  // A bad repaint must not abort the walk it is observing.
  const fetchImpl = pagedFetch([[row('d1', '!aaaa1111', 30)]]);
  const index = await loadDestinationIndex({
    fetchImpl,
    limit: 1,
    onUpdate: () => { throw new Error('render blew up'); },
  });
  assert.equal(index.get('!aaaa1111').length, 1);
});

test('loadDestinationIndex stops at the page backstop', async () => {
  // A server that ignores the cursor would otherwise loop forever; the walk is
  // bounded even when every page looks full and fresh.
  let n = 0;
  const fetchImpl = async () => {
    n += 1;
    return { ok: true, async json() { return [row(`d${n}`, '!aaaa1111', 100 - n)]; } };
  };
  const index = await loadDestinationIndex({ fetchImpl, limit: 1, maxPages: 3 });
  assert.equal(index.get('!aaaa1111').length, 3);
});

test('the default page size stays under the route cap', () => {
  // MAX_QUERY_LIMIT is 1000; a page larger than that would be silently clamped
  // server-side and the walk's short-page stop condition would never fire.
  assert.ok(DESTINATION_PAGE_LIMIT > 0 && DESTINATION_PAGE_LIMIT <= 1000);
});

test('loadDestinationIndex never rejects, even if the walk itself throws', async () => {
  // The default page fetcher absorbs transport failures, so this exercises the
  // outer guard directly: the "never rejects" contract must hold on its own
  // rather than being inherited from one collaborator.
  const index = await loadDestinationIndex({
    fetchPage: async () => { throw new Error('walk exploded'); },
    limit: 2,
  });
  assert.equal(index.size, 0);
});

test('loadDestinationIndex accepts an injected page fetcher', async () => {
  const index = await loadDestinationIndex({
    fetchPage: async (limit, before) => (before > 0 ? [] : [row('d1', '!dddd4444', 42)]),
    limit: 1,
  });
  assert.equal(index.get('!dddd4444').length, 1);
});
