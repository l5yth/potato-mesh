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
 * Unit tests for `main/cache-write-back.js` (SPEC CC4, CC2): only changed
 * rows are put, the coverage marker follows the rows, failures are retried,
 * runs are serialised, and a clear makes the next run store everything.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createCacheWriteBack } from '../cache-write-back.js';

/**
 * A recording stand-in for the data cache.
 *
 * @param {{ disabled?: boolean }} [options] Whether the cache runs disabled.
 * @returns {Object} The cache, its recorded puts and coverage writes, and
 *   switches that make the next writes fail.
 */
function recordingCache({ disabled = false } = {}) {
  const cache = {
    puts: [],
    markers: [],
    failPutAll: new Set(),
    failCoverage: false,
    generation: 'g1',
    generationReads: 0,
    ready: async () => undefined,
    isDisabled: () => disabled,
    async getGeneration() {
      cache.generationReads += 1;
      return cache.generation;
    },
    async putAll(collection, entries) {
      if (cache.failPutAll.has(collection)) return false;
      cache.puts.push({ collection, keys: entries.map(entry => entry.key), values: entries.map(entry => entry.value) });
      return true;
    },
    async putCoverage(marker) {
      if (cache.failCoverage) return false;
      cache.markers.push(marker);
      return true;
    },
  };
  return cache;
}

/**
 * A writer over `state`, keyed by `id`.
 *
 * @param {Object} cache Recording cache.
 * @param {{ rows: Object<string, Array<Object>>, coverage?: ?Object }} state
 *   The rows per collection and the coverage marker, read at each run.
 * @param {Object} [extra] Other writer options.
 * @returns {Object} The writer.
 */
const writerOver = (cache, state, extra = {}) => createCacheWriteBack({
  cache,
  collections: () => state.rows,
  keyOf: (collection, row) => (row.id == null ? null : String(row.id)),
  coverage: () => state.coverage ?? null,
  ...extra,
});

test('the first run puts every row and the marker; an unchanged run puts nothing', async () => {
  const cache = recordingCache();
  const state = { rows: { nodes: [{ id: 1, n: 'a' }, { id: 2, n: 'b' }], traces: [] }, coverage: { nodes: { from: 0, to: 9, complete: true } } };
  const writer = writerOver(cache, state);
  assert.deepEqual(await writer.write(), { puts: { nodes: 2 }, coverage: true });
  assert.deepEqual(cache.puts.map(put => [put.collection, put.keys]), [['nodes', ['1', '2']]]);
  assert.deepEqual(cache.markers, [{ nodes: { from: 0, to: 9, complete: true }, generation: 'g1' }], 'stamped with the generation');
  assert.deepEqual(await writer.write(), { puts: {}, coverage: false });
  assert.equal(cache.puts.length, 1, 'no put for unchanged rows');
  assert.equal(cache.markers.length, 1, 'no put for an unchanged marker');
});

test('a run puts only rows that are new or differ; equal copies and kept objects are skipped', async () => {
  const cache = recordingCache();
  const kept = { id: 1, n: 'a', nested: { v: [1, 2] } };
  const state = { rows: { nodes: [kept, { id: 2, n: 'b' }, { id: 3, n: 'c' }] } };
  const writer = writerOver(cache, state);
  await writer.write();
  // Row 1 kept by identity, row 2 re-sent as an equal copy, row 3 changed, row 4 new, row 5 has no key.
  state.rows = { nodes: [kept, { id: 2, n: 'b' }, { id: 3, n: 'C' }, { id: 4, n: 'd' }, { n: 'no key' }] };
  assert.deepEqual(await writer.write(), { puts: { nodes: 2 }, coverage: false });
  assert.deepEqual(cache.puts[1].keys, ['3', '4']);
});

test('rows that left memory are forgotten, so they are stored again when they come back', async () => {
  const cache = recordingCache();
  const state = { rows: { nodes: [{ id: 1 }, { id: 2 }] } };
  const writer = writerOver(cache, state);
  await writer.write();
  state.rows = { nodes: [{ id: 1 }] };
  await writer.write();
  state.rows = { nodes: [{ id: 1 }, { id: 2 }] };
  assert.deepEqual(await writer.write(), { puts: { nodes: 1 }, coverage: false });
  assert.deepEqual(cache.puts.at(-1).keys, ['2']);
});

test('storedValue shapes the stored value and the comparison', async () => {
  const cache = recordingCache();
  const state = { rows: { messages: [{ id: 1, text: 'hi', node: { name: 'A' } }] } };
  const writer = writerOver(cache, state, {
    storedValue: (collection, row) => {
      const { node, ...rest } = row;
      return rest;
    },
  });
  await writer.write();
  assert.deepEqual(cache.puts[0].values, [{ id: 1, text: 'hi' }]);
  // A copy that differs only in the dropped field is unchanged.
  state.rows = { messages: [{ id: 1, text: 'hi', node: { name: 'B' } }] };
  assert.deepEqual((await writer.write()).puts, {});
});

test('a collection that is not a list counts as empty', async () => {
  const cache = recordingCache();
  const writer = writerOver(cache, { rows: { nodes: null } });
  assert.deepEqual(await writer.write(), { puts: {}, coverage: false });
  assert.deepEqual(cache.puts, []);
});

test('a failed put is retried by the next run, and the marker waits until every put succeeded', async () => {
  const cache = recordingCache();
  const state = { rows: { nodes: [{ id: 1 }], traces: [{ id: 7 }] }, coverage: { nodes: { from: 0, to: 1, complete: true } } };
  const writer = writerOver(cache, state);
  cache.failPutAll.add('traces');
  assert.deepEqual(await writer.write(), { puts: { nodes: 1 }, coverage: false });
  assert.deepEqual(cache.markers, [], 'no marker over rows that were not stored');
  cache.failPutAll.clear();
  assert.deepEqual(await writer.write(), { puts: { traces: 1 }, coverage: true });
  assert.equal(cache.markers.length, 1);
});

test('a marker that fails to store is stored by the next run', async () => {
  const cache = recordingCache();
  const state = { rows: { nodes: [{ id: 1 }] }, coverage: { nodes: { from: 0, to: 1, complete: true } } };
  const writer = writerOver(cache, state);
  cache.failCoverage = true;
  assert.equal((await writer.write()).coverage, false);
  cache.failCoverage = false;
  assert.equal((await writer.write()).coverage, true);
});

test('without a coverage source the writer stores rows only', async () => {
  const cache = recordingCache();
  const writer = createCacheWriteBack({ cache, collections: () => ({ nodes: [{ id: 1 }] }), keyOf: (c, row) => String(row.id) });
  assert.deepEqual(await writer.write(), { puts: { nodes: 1 }, coverage: false });
  assert.deepEqual(cache.markers, []);
});

test('a disabled cache stores nothing and remembers nothing', async () => {
  const cache = recordingCache({ disabled: true });
  let reads = 0;
  const writer = createCacheWriteBack({
    cache,
    collections: () => {
      reads += 1;
      return { nodes: [{ id: 1 }] };
    },
    keyOf: (c, row) => String(row.id),
  });
  assert.deepEqual(await writer.write(), { puts: {}, coverage: false });
  assert.equal(reads, 0, 'the rows are not even read');
});

test('runs are serialised: each one diffs against what the previous one stored', async () => {
  const cache = recordingCache();
  let releaseFirst;
  const gate = new Promise(resolve => {
    releaseFirst = resolve;
  });
  let first = true;
  cache.ready = async () => {
    if (first) {
      first = false;
      await gate;
    }
  };
  const state = { rows: { nodes: [{ id: 1 }] } };
  const writer = writerOver(cache, state);
  const one = writer.write();
  const two = writer.write();
  releaseFirst();
  assert.deepEqual(await one, { puts: { nodes: 1 }, coverage: false });
  assert.deepEqual(await two, { puts: {}, coverage: false }, 'the second run found nothing new');
});

test('a run that throws resolves empty, and later runs still go', async () => {
  const cache = recordingCache();
  let explode = true;
  const writer = createCacheWriteBack({
    cache,
    collections: () => {
      if (explode) throw new Error('collections failed');
      return { nodes: [{ id: 1 }] };
    },
    keyOf: (c, row) => String(row.id),
  });
  assert.deepEqual(await writer.write(), { puts: {}, coverage: false });
  explode = false;
  assert.deepEqual(await writer.write(), { puts: { nodes: 1 }, coverage: false });
});

test('clear runs after the queued writes, then the next run stores every row and the marker again', async () => {
  const cache = recordingCache();
  const state = { rows: { nodes: [{ id: 1 }, { id: 2 }] }, coverage: { nodes: { from: 0, to: 2, complete: true } } };
  const writer = writerOver(cache, state);
  const order = [];
  void writer.write().then(() => order.push('write'));
  await writer.clear(async () => {
    order.push('wipe');
  });
  assert.deepEqual(order, ['write', 'wipe']);
  assert.deepEqual(await writer.write(), { puts: { nodes: 2 }, coverage: true });
});

test('a wipe that fails rejects clear, and later runs still go', async () => {
  const cache = recordingCache();
  const writer = writerOver(cache, { rows: { nodes: [{ id: 1 }] } });
  await writer.write();
  await assert.rejects(() => writer.clear(async () => {
    throw new Error('wipe failed');
  }), /wipe failed/);
  assert.deepEqual(await writer.write(), { puts: {}, coverage: false }, 'what was written is still known');
});

test('seeded rows count as written: the next run puts only what changed after them', async () => {
  const cache = recordingCache();
  const seededRows = { nodes: [{ id: 1, n: 'a' }, { id: 2, n: 'b' }, { n: 'no key' }] };
  const marker = { nodes: { from: 0, to: 2, complete: true } };
  const state = { rows: { nodes: [{ id: 1, n: 'a' }, { id: 2, n: 'B' }] }, coverage: marker };
  const writer = writerOver(cache, state);
  writer.seeded(seededRows, { ...marker, generation: 'g1' }, 'g1');
  assert.deepEqual(await writer.write(), { puts: { nodes: 1 }, coverage: false }, 'the stored marker is not written again');
  assert.deepEqual(cache.puts[0].keys, ['2']);
  const fresh = writerOver(recordingCache(), state);
  fresh.seeded({ nodes: [] }, undefined);
  assert.deepEqual(await fresh.write(), { puts: { nodes: 2 }, coverage: true }, 'no seeded rows or marker: everything is new');
});

test('seeded rows are ignored once a write-back was queued: what it stores stays authoritative', async () => {
  const cache = recordingCache();
  const state = { rows: { nodes: [{ id: 1 }] } };
  const writer = writerOver(cache, state);
  const first = writer.write();
  // A seed that lands after the first write-back was queued must not mark the
  // rows of memory as written.
  writer.seeded({ nodes: [{ id: 1 }, { id: 2 }] }, { nodes: { from: 0, to: 2, complete: true } });
  assert.deepEqual(await first, { puts: { nodes: 1 }, coverage: false });
  state.rows = { nodes: [{ id: 1 }, { id: 2 }] };
  assert.deepEqual(await writer.write(), { puts: { nodes: 1 }, coverage: false }, 'row 2 is still stored');
});

test('a new store generation makes the next run store every row and a marker stamped with it (SPEC CC4)', async () => {
  const cache = recordingCache();
  const state = { rows: { nodes: [{ id: 1 }, { id: 2 }] }, coverage: { nodes: { from: 0, to: 2, complete: true } } };
  const writer = writerOver(cache, state);
  await writer.write();
  assert.deepEqual(await writer.write(), { puts: {}, coverage: false }, 'same generation: nothing new');
  cache.generation = 'g2'; // another tab emptied the store
  assert.deepEqual(await writer.write(), { puts: { nodes: 2 }, coverage: true }, 'every row again');
  assert.equal(cache.markers.at(-1).generation, 'g2');
  assert.deepEqual(await writer.write(), { puts: {}, coverage: false });
  assert.equal(cache.generationReads, 4, 'every run reads the generation');
});

test('seeded rows under another generation than the store holds are written again (SPEC CC4)', async () => {
  const cache = recordingCache();
  cache.generation = 'g2';
  const state = { rows: { nodes: [{ id: 1 }] } };
  const writer = writerOver(cache, state);
  writer.seeded({ nodes: state.rows.nodes }, null, 'g1');
  assert.deepEqual(await writer.write(), { puts: { nodes: 1 }, coverage: false });
  const unknown = writerOver(recordingCache(), state);
  unknown.seeded({ nodes: state.rows.nodes }, null, undefined);
  assert.deepEqual(await unknown.write(), { puts: { nodes: 1 }, coverage: false }, 'a seed across a wipe knows no generation');
});

test('a store whose generation cannot be read is written in full each run', async () => {
  const cache = recordingCache();
  cache.generation = null;
  const writer = writerOver(cache, { rows: { nodes: [{ id: 1 }] } });
  assert.deepEqual(await writer.write(), { puts: { nodes: 1 }, coverage: false });
  assert.deepEqual(await writer.write(), { puts: {}, coverage: false }, 'null stays the same generation');
});

test('clear forgets the generation as well', async () => {
  const cache = recordingCache();
  const writer = writerOver(cache, { rows: { nodes: [{ id: 1 }] } });
  await writer.write();
  await writer.clear(async () => {
    cache.generation = 'g3';
  });
  assert.deepEqual(await writer.write(), { puts: { nodes: 1 }, coverage: false });
});
