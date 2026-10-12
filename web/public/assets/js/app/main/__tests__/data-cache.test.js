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
  createDataCache,
  createMemoryBackend,
  CACHE_SCHEMA_VERSION,
  CACHE_COLLECTIONS,
} from '../data-cache.js';

/**
 * Wrap a memory backend so individual methods can be forced to throw, for
 * graceful-degradation tests. The `fail` set names methods that should reject.
 *
 * @returns {object} Controllable backend with a mutable `fail` set + `reads` counter.
 */
function makeControllableBackend() {
  const mem = createMemoryBackend();
  const fail = new Set();
  let metaReads = 0;
  const wrap = name => async (...args) => {
    if (name === 'read' && args[0] === 'meta') metaReads += 1;
    if (fail.has(name)) throw new Error(`${name} failed`);
    return mem[name](...args);
  };
  return {
    read: wrap('read'),
    readAll: wrap('readAll'),
    write: wrap('write'),
    writeMany: wrap('writeMany'),
    remove: wrap('remove'),
    removeMany: wrap('removeMany'),
    clearStore: wrap('clearStore'),
    fail,
    metaReads: () => metaReads,
  };
}

/** A matching marker so init does not wipe a freshly seeded backend. */
const MATCHING_MARKER = { schemaVersion: CACHE_SCHEMA_VERSION, instanceId: '' };

// --- memory backend ------------------------------------------------------

test('memory backend round-trips reads, writes, batch, remove, and clear', async () => {
  const be = createMemoryBackend();
  assert.equal(await be.read('nodes', '!a'), undefined);
  await be.write('nodes', '!a', { value: 1 });
  assert.deepEqual(await be.read('nodes', '!a'), { value: 1 });
  await be.writeMany('nodes', [
    { key: '!b', record: { value: 2 } },
    { key: '!c', record: { value: 3 } },
  ]);
  const all = await be.readAll('nodes');
  assert.equal(all.length, 3);
  await be.remove('nodes', '!a');
  assert.equal(await be.read('nodes', '!a'), undefined);
  await be.clearStore('nodes');
  assert.deepEqual(await be.readAll('nodes'), []);
});

test('memory backend removeMany deletes keys across stores', async () => {
  const be = createMemoryBackend();
  await be.write('nodes', '!a', 1);
  await be.write('nodes', '!b', 2);
  await be.write('traces', 't', 3);
  await be.removeMany([{ store: 'nodes', key: '!a' }, { store: 'traces', key: 't' }, { store: 'traces', key: 'absent' }]);
  assert.deepEqual((await be.readAll('nodes')).map(row => row.key), ['!b']);
  assert.deepEqual(await be.readAll('traces'), []);
});

// --- disabled (no backend) ----------------------------------------------

test('a cache without a backend is disabled and every op is a safe no-op', async () => {
  const cache = createDataCache({ backend: null });
  await cache.ready();
  assert.equal(cache.isDisabled(), true);
  assert.equal(await cache.get('nodes', '!a'), undefined);
  assert.deepEqual(await cache.getAll('nodes'), []);
  // None of these throw.
  await cache.put('nodes', '!a', { x: 1 });
  assert.equal(await cache.putAll('nodes', [{ key: '!a', value: {} }]), false, 'nothing is stored');
  await cache.delete('nodes', '!a');
  await cache.deleteMany([{ collection: 'nodes', key: '!a' }]);
  assert.equal(await cache.getCoverage(), null);
  assert.equal(await cache.putCoverage({ nodes: {} }), false);
  await cache.clearCollection('nodes');
  await cache.clear();
});

// --- happy path ----------------------------------------------------------

test('put/get round-trips the value and stamps cachedAt from the injected clock', async () => {
  const cache = createDataCache({ backend: createMemoryBackend(), now: () => 4242 });
  await cache.put('nodes', '!a', { short_name: 'A' });
  assert.deepEqual(await cache.get('nodes', '!a'), {
    value: { short_name: 'A' },
    cachedAt: 4242,
  });
  assert.equal(cache.isDisabled(), false);
});

test('get returns undefined for an absent key', async () => {
  const cache = createDataCache({ backend: createMemoryBackend() });
  assert.equal(await cache.get('messages', 'nope'), undefined);
});

test('putAll/getAll round-trip with key/value/cachedAt projection', async () => {
  const cache = createDataCache({ backend: createMemoryBackend(), now: () => 7 });
  await cache.putAll('messages', [
    { key: '1', value: { text: 'a' } },
    { key: '2', value: { text: 'b' } },
  ]);
  const rows = (await cache.getAll('messages')).sort((x, y) => x.key.localeCompare(y.key));
  assert.deepEqual(rows, [
    { key: '1', value: { text: 'a' }, cachedAt: 7 },
    { key: '2', value: { text: 'b' }, cachedAt: 7 },
  ]);
});

test('putAll is a no-op for an empty or non-array argument', async () => {
  const be = createMemoryBackend();
  const cache = createDataCache({ backend: be });
  assert.equal(await cache.putAll('nodes', []), true, 'nothing to store is stored');
  assert.equal(await cache.putAll('nodes', null), true);
  assert.deepEqual(await be.readAll('nodes'), []);
});

test('putAll resolves true once stored (SPEC CC4)', async () => {
  const cache = createDataCache({ backend: createMemoryBackend() });
  assert.equal(await cache.putAll('nodes', [{ key: '!a', value: { n: 1 } }]), true);
});

test('deleteMany removes keys of several collections in one backend call (SPEC CC5)', async () => {
  const mem = createMemoryBackend();
  const calls = [];
  const be = { ...mem, removeMany: async items => { calls.push(items); return mem.removeMany(items); } };
  const cache = createDataCache({ backend: be });
  await cache.put('nodes', '!a', { n: 1 });
  await cache.put('positions', 'p1', { n: 2 });
  await cache.put('positions', 'p2', { n: 3 });
  await cache.deleteMany([{ collection: 'nodes', key: '!a' }, { collection: 'positions', key: 'p1' }]);
  assert.deepEqual(calls, [[{ store: 'nodes', key: '!a' }, { store: 'positions', key: 'p1' }]]);
  assert.deepEqual(await cache.getAll('nodes'), []);
  assert.deepEqual((await cache.getAll('positions')).map(row => row.key), ['p2']);
  await cache.deleteMany([]);
  await cache.deleteMany(null);
  assert.equal(calls.length, 1, 'nothing to delete makes no call');
});

test('the coverage marker round-trips and is stamped like a row (SPEC CC2)', async () => {
  const be = createMemoryBackend();
  const cache = createDataCache({ backend: be, now: () => 77 });
  assert.equal(await cache.getCoverage(), null, 'no marker yet');
  const marker = { nodes: { from: 0, to: 9, complete: true } };
  assert.equal(await cache.putCoverage(marker), true);
  assert.deepEqual(await cache.getCoverage(), marker);
  assert.deepEqual(await be.read('meta', 'coverage'), { value: marker, cachedAt: 77 });
  await be.write('meta', 'coverage', 'not a record');
  assert.equal(await cache.getCoverage(), null, 'a malformed record reads as none');
});

test('clear and a schema change remove the coverage marker with the rows (SPEC CC2)', async () => {
  const be = createMemoryBackend();
  const cache = createDataCache({ backend: be, instanceId: 'x' });
  await cache.putCoverage({ nodes: { from: 0, to: 9, complete: true } });
  await cache.clear();
  assert.equal(await cache.getCoverage(), null);
  await cache.putCoverage({ nodes: { from: 0, to: 9, complete: true } });
  const next = createDataCache({ backend: be, instanceId: 'x', schemaVersion: CACHE_SCHEMA_VERSION + 1 });
  assert.equal(await next.getCoverage(), null);
});

test('delete removes a single key; clearCollection empties one collection', async () => {
  const cache = createDataCache({ backend: createMemoryBackend() });
  await cache.put('telemetry', 't1', { v: 1 });
  await cache.put('telemetry', 't2', { v: 2 });
  await cache.delete('telemetry', 't1');
  assert.equal(await cache.get('telemetry', 't1'), undefined);
  assert.equal((await cache.getAll('telemetry')).length, 1);
  await cache.clearCollection('telemetry');
  assert.deepEqual(await cache.getAll('telemetry'), []);
});

test('neighbors accept a composite string key', async () => {
  const cache = createDataCache({ backend: createMemoryBackend() });
  await cache.put('neighbors', '!a|!b', { snr: 5 });
  assert.deepEqual((await cache.get('neighbors', '!a|!b')).value, { snr: 5 });
});

// --- schema / identity guard (FC6) --------------------------------------

test('a fresh backend gets a schema/identity marker written on open', async () => {
  const be = createMemoryBackend();
  const cache = createDataCache({ backend: be, instanceId: 'demo' });
  await cache.ready();
  assert.deepEqual(await be.read('meta', 'meta'), {
    schemaVersion: CACHE_SCHEMA_VERSION,
    instanceId: 'demo',
  });
});

test('a matching marker retains cached data across cache instances', async () => {
  const be = createMemoryBackend();
  const first = createDataCache({ backend: be, instanceId: 'x' });
  await first.put('nodes', '!a', { n: 1 });
  // A second instance over the same backend with the same schema + identity.
  const second = createDataCache({ backend: be, instanceId: 'x' });
  assert.deepEqual((await second.get('nodes', '!a')).value, { n: 1 });
});

test('a schema-version bump discards the cache and rewrites the marker', async () => {
  const be = createMemoryBackend();
  const old = createDataCache({ backend: be, schemaVersion: 1, instanceId: 'x' });
  await old.put('nodes', '!a', { n: 1 });
  const next = createDataCache({ backend: be, schemaVersion: 2, instanceId: 'x' });
  assert.equal(await next.get('nodes', '!a'), undefined);
  assert.deepEqual(await be.read('meta', 'meta'), { schemaVersion: 2, instanceId: 'x' });
});

test('an instance-identity change discards the cache', async () => {
  const be = createMemoryBackend();
  const a = createDataCache({ backend: be, instanceId: 'alpha' });
  await a.put('messages', '1', { text: 'hi' });
  const b = createDataCache({ backend: be, instanceId: 'beta' });
  assert.deepEqual(await b.getAll('messages'), []);
});

// --- privacy gate (FC4) --------------------------------------------------

test('PRIVATE mode disables the cache and wipes any prior data', async () => {
  const be = createMemoryBackend();
  const pub = createDataCache({ backend: be, instanceId: 'x' });
  await pub.put('messages', '1', { text: 'secret' });
  await pub.put('nodes', '!a', { n: 1 });

  const priv = createDataCache({ backend: be, instanceId: 'x', isPrivate: true });
  await priv.ready();
  assert.equal(priv.isDisabled(), true);
  // Prior data wiped from the backend, and the private cache writes nothing.
  assert.deepEqual(await be.readAll('messages'), []);
  assert.deepEqual(await be.readAll('nodes'), []);
  await priv.put('messages', '2', { text: 'nope' });
  assert.equal(await priv.get('messages', '2'), undefined);
  assert.deepEqual(await be.readAll('messages'), []);
});

// --- graceful degradation (FC7) -----------------------------------------

test('a backend that throws on open disables the cache', async () => {
  const be = makeControllableBackend();
  be.fail.add('read'); // meta read during init throws
  const cache = createDataCache({ backend: be });
  await cache.ready();
  assert.equal(cache.isDisabled(), true);
  assert.equal(await cache.get('nodes', '!a'), undefined);
});

test('per-operation backend errors degrade to safe no-ops', async () => {
  const be = makeControllableBackend();
  await be.write('meta', 'meta', MATCHING_MARKER); // matching marker → no wipe at init
  const cache = createDataCache({ backend: be });
  await cache.ready();
  assert.equal(cache.isDisabled(), false);

  be.fail.add('read');
  assert.equal(await cache.get('nodes', '!a'), undefined);
  be.fail.add('readAll');
  assert.deepEqual(await cache.getAll('nodes'), []);
  be.fail.add('write');
  await cache.put('nodes', '!a', { n: 1 }); // no throw
  be.fail.add('writeMany');
  assert.equal(await cache.putAll('nodes', [{ key: '!a', value: {} }]), false); // no throw
  assert.equal(await cache.getCoverage(), null); // read failure → no marker
  be.fail.add('write');
  assert.equal(await cache.putCoverage({ nodes: {} }), false); // no throw
  be.fail.add('removeMany');
  await cache.deleteMany([{ collection: 'nodes', key: '!a' }]); // no throw
  be.fail.add('remove');
  await cache.delete('nodes', '!a'); // no throw
  be.fail.add('clearStore');
  await cache.clearCollection('nodes'); // no throw
  await cache.clear(); // clearCollections hits clearStore failure → no throw
});

// --- clear + init memoisation -------------------------------------------

test('clear empties all collections but preserves the marker', async () => {
  const be = createMemoryBackend();
  const cache = createDataCache({ backend: be, instanceId: 'x' });
  for (const collection of CACHE_COLLECTIONS) {
    await cache.put(collection, 'k', { v: 1 });
  }
  await cache.clear();
  for (const collection of CACHE_COLLECTIONS) {
    assert.deepEqual(await cache.getAll(collection), []);
  }
  // Marker preserved → no re-wipe, writes resume normally.
  assert.deepEqual(await be.read('meta', 'meta'), {
    schemaVersion: CACHE_SCHEMA_VERSION,
    instanceId: 'x',
  });
  await cache.put('nodes', '!a', { n: 2 });
  assert.deepEqual((await cache.get('nodes', '!a')).value, { n: 2 });
});

test('initialisation runs exactly once across many operations', async () => {
  const be = makeControllableBackend();
  await be.write('meta', 'meta', MATCHING_MARKER);
  const cache = createDataCache({ backend: be });
  await cache.ready();
  await cache.ready();
  await cache.get('nodes', '!a');
  await cache.getAll('nodes');
  // The schema marker is read exactly once — init is memoised, not re-run per op.
  assert.equal(be.metaReads(), 1, 'init reads the marker exactly once');
});

// --- store generation (SPEC CC4) ---------------------------------------------

test('getGeneration mints a generation once and returns it after', async () => {
  const be = createMemoryBackend();
  let minted = 0;
  const cache = createDataCache({ backend: be, now: () => 5, newGeneration: () => `g${(minted += 1)}` });
  assert.equal(await cache.getGeneration(), 'g1');
  assert.equal(await cache.getGeneration(), 'g1');
  assert.deepEqual(await be.read('meta', 'generation'), { value: 'g1', cachedAt: 5 });
  const other = createDataCache({ backend: be, newGeneration: () => 'never' });
  assert.equal(await other.getGeneration(), 'g1', 'another tab reads the same generation');
});

test('every wipe gives the store a new generation: clear and a schema or instance change', async () => {
  const be = createMemoryBackend();
  let minted = 0;
  const mint = () => `g${(minted += 1)}`;
  const cache = createDataCache({ backend: be, instanceId: 'x', newGeneration: mint });
  const first = await cache.getGeneration();
  await cache.clear();
  const second = await cache.getGeneration();
  assert.notEqual(second, first, 'clear');
  const newerSchema = createDataCache({ backend: be, instanceId: 'x', schemaVersion: CACHE_SCHEMA_VERSION + 1, newGeneration: mint });
  await newerSchema.ready();
  const third = await cache.getGeneration();
  assert.notEqual(third, second, 'a schema change');
  const otherInstance = createDataCache({ backend: be, instanceId: 'y', schemaVersion: CACHE_SCHEMA_VERSION + 1, newGeneration: mint });
  await otherInstance.ready();
  assert.notEqual(await cache.getGeneration(), third, 'an instance change');
});

test('the default generation is a fresh token per wipe', async () => {
  const be = createMemoryBackend();
  const cache = createDataCache({ backend: be });
  const first = await cache.getGeneration();
  assert.match(first, /^[0-9a-z]+-[0-9a-z]+$/);
  await cache.clear();
  assert.notEqual(await cache.getGeneration(), first);
});

test('getGeneration is null for a disabled cache and when the store fails', async () => {
  assert.equal(await createDataCache({ backend: null }).getGeneration(), null);
  const be = makeControllableBackend();
  await be.write('meta', 'meta', MATCHING_MARKER);
  const cache = createDataCache({ backend: be });
  await cache.ready();
  be.fail.add('write');
  assert.equal(await cache.getGeneration(), null, 'minting fails');
  be.fail.add('read');
  assert.equal(await cache.getGeneration(), null, 'reading fails');
});

test('a store written before generations existed gets one on the first read', async () => {
  const be = createMemoryBackend();
  await be.write('meta', 'meta', MATCHING_MARKER); // matching marker, so init wipes nothing
  const cache = createDataCache({ backend: be, now: () => 9, newGeneration: () => 'minted' });
  assert.equal(await cache.getGeneration(), 'minted');
  assert.deepEqual(await be.read('meta', 'generation'), { value: 'minted', cachedAt: 9 });
});
