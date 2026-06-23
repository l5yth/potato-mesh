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

import { createIndexedDbBackend } from '../data-cache-idb.js';
import { createFakeIndexedDb } from '../../__tests__/fake-indexeddb.js';

test('returns null when IndexedDB is unavailable', () => {
  assert.equal(createIndexedDbBackend({ indexedDB: undefined }), null);
  assert.equal(createIndexedDbBackend({ indexedDB: {} }), null); // no open()
});

test('write then read round-trips a record', async () => {
  const { factory } = createFakeIndexedDb();
  const be = createIndexedDbBackend({ indexedDB: factory, databaseName: 'db1' });
  assert.equal(await be.read('nodes', '!a'), undefined);
  await be.write('nodes', '!a', { value: { n: 1 }, cachedAt: 5 });
  assert.deepEqual(await be.read('nodes', '!a'), { value: { n: 1 }, cachedAt: 5 });
});

test('writeMany then readAll returns key/record pairs in order', async () => {
  const { factory } = createFakeIndexedDb();
  const be = createIndexedDbBackend({ indexedDB: factory, databaseName: 'db2' });
  assert.deepEqual(await be.readAll('messages'), []);
  await be.writeMany('messages', [
    { key: '1', record: { value: 'a' } },
    { key: '2', record: { value: 'b' } },
  ]);
  const rows = await be.readAll('messages');
  assert.deepEqual(rows, [
    { key: '1', record: { value: 'a' } },
    { key: '2', record: { value: 'b' } },
  ]);
});

test('remove and clearStore delete data', async () => {
  const { factory } = createFakeIndexedDb();
  const be = createIndexedDbBackend({ indexedDB: factory, databaseName: 'db3' });
  await be.write('traces', 't1', { value: 1 });
  await be.write('traces', 't2', { value: 2 });
  await be.remove('traces', 't1');
  assert.equal(await be.read('traces', 't1'), undefined);
  assert.equal((await be.readAll('traces')).length, 1);
  await be.clearStore('traces');
  assert.deepEqual(await be.readAll('traces'), []);
});

test('data persists across backend handles over the same database', async () => {
  const { factory } = createFakeIndexedDb();
  const first = createIndexedDbBackend({ indexedDB: factory, databaseName: 'shared' });
  await first.write('nodes', '!a', { value: { n: 1 } });
  const second = createIndexedDbBackend({ indexedDB: factory, databaseName: 'shared' });
  assert.deepEqual(await second.read('nodes', '!a'), { value: { n: 1 } });
});

test('a failing request rejects the operation', async () => {
  const { factory, setFailMode } = createFakeIndexedDb();
  const be = createIndexedDbBackend({ indexedDB: factory, databaseName: 'db4' });
  setFailMode('request');
  await assert.rejects(() => be.write('nodes', '!a', { value: 1 }));
});
