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
 * SPEC CC6 (the OR5 follow-up of the security and performance review): a
 * late response that carries an older version of a row no longer replaces
 * the newer one in memory; on a key collision the row with the newer own time
 * wins. Covers the OR5 case, a hung first refresh that answers after the
 * stream's resync loaded the page, and a backward page that answers after a
 * delta brought a node that was heard again.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as sequencer from '../main/page-open-sequencer.js';
import {
  NOW, COLD_NODES, boot, settle, waitFor, releaseExcept, coldNodes, hangFirstNodes,
} from './page-open-harness.js';
import { createFakeMeshApi, makeRows } from './fake-mesh-api.js';
import { bootPage } from './cache-visit-harness.js';

test('CC6: a hung first refresh that answers after the resync keeps the newer node row (OR5)', async () => {
  // The first /api/nodes was asked before !a was heard again: it answers !a
  // as the server held it ten minutes earlier.
  let cold = 0;
  const serve = (url, body) => {
    if (!COLD_NODES.test(url)) return body;
    cold += 1;
    if (cold > 1) return body;
    return body.map(node => (node.node_id === '!a' ? { ...node, last_heard: NOW - 600, long_name: 'Node A, old' } : node));
  };
  const { u, calls, es, bounds, teardown } = await boot({ captureBounds: true, serve });
  try {
    const hung = await hangFirstNodes(calls);
    assert.equal(bounds.fire(sequencer.START_TIMEOUT_MS), 1, 'the start bound was armed');
    await settle();
    es().dispatch('open', {}); // the stream's resync loads the page
    await waitFor(() => coldNodes(calls) === 2);
    releaseExcept(calls, hung);
    await waitFor(() => u.getLoadedNodeCount() === 2);
    hung.release(); // the first refresh finally answers, with the older row
    await settle();
    const a = u.getLoadedNodes().find(node => node.node_id === '!a');
    assert.equal(a.last_heard, NOW, `!a after the late first refresh: last_heard NOW${a.last_heard - NOW}`);
    assert.equal(a.long_name, 'Node A');
  } finally {
    await teardown();
  }
});

test('CC6: a backward node page that answers after a delta keeps the newer node row', async () => {
  const api = createFakeMeshApi();
  api.upsert('nodes', makeRows('nodes', { count: 1200, newest: NOW - 100, step: 400 }));
  // Hold the first backward node page: its body is what the server held when
  // it was asked, before node 1100 was heard again.
  let release = null;
  const fetch = url => {
    const response = api.fetch(url);
    if (release || !/\/api\/nodes\?.*before=/.test(url)) return response;
    return new Promise(resolve => {
      release = () => resolve(response);
    });
  };
  const { u, teardown } = bootPage({ fetch });
  try {
    await u.initialLoad;
    await waitFor(() => release !== null);
    const heard = { ...api.rows.nodes[1100], last_heard: NOW };
    api.upsert('nodes', [heard]);
    await u.refresh(); // a delta brings node 1100 as heard now
    release(); // the backward page answers with node 1100 as it was
    await u.flushCollectionBackfills();
    const node = u.getLoadedNodes().find(row => row.node_id === heard.node_id);
    assert.equal(node.last_heard, NOW, `node 1100 after the late backward page: last_heard NOW${node.last_heard - NOW}`);
    assert.equal(u.getLoadedNodeCount(), 1200);
  } finally {
    teardown();
  }
});
