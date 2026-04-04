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

import { fetchMessages, fetchTracesForNode } from '../node-page-data.js';

// ---------------------------------------------------------------------------
// fetchMessages
// ---------------------------------------------------------------------------

test('fetchMessages returns empty array in privateMode', async () => {
  // fetchImpl must not be called when privateMode is true.
  const fetchImpl = async () => { throw new Error('should not be called'); };
  const result = await fetchMessages('!abc', { fetchImpl, privateMode: true });
  assert.deepEqual(result, []);
});

test('fetchMessages fetches correct URL and returns parsed JSON', async () => {
  const calls = [];
  const messages = [{ text: 'hello' }];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, async json() { return messages; } };
  };

  const result = await fetchMessages('!aabbccdd', { fetchImpl });
  assert.deepEqual(result, messages);
  assert.ok(calls[0].url.includes('/api/messages/'), 'URL should include messages path');
  assert.ok(calls[0].url.includes('limit='), 'URL should include limit parameter');
  assert.ok(!calls[0].url.includes('encrypted=1'), 'should not include encrypted flag by default');
});

test('fetchMessages appends encrypted flag when includeEncrypted is true', async () => {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    return { ok: true, status: 200, async json() { return []; } };
  };

  await fetchMessages('!abc', { fetchImpl, includeEncrypted: true });
  assert.ok(calls[0].includes('encrypted=1'), 'URL should include encrypted=1 flag');
});

test('fetchMessages returns empty array on 404', async () => {
  const fetchImpl = async () => ({ ok: false, status: 404 });
  const result = await fetchMessages('!abc', { fetchImpl });
  assert.deepEqual(result, []);
});

test('fetchMessages throws on non-404 error status', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500 });
  await assert.rejects(
    () => fetchMessages('!abc', { fetchImpl }),
    { message: /HTTP 500/ }
  );
});

test('fetchMessages returns empty array when payload is not an array', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    async json() { return { data: [] }; },
  });
  const result = await fetchMessages('!abc', { fetchImpl });
  assert.deepEqual(result, []);
});

test('fetchMessages throws TypeError when no fetch implementation is available', async () => {
  // Remove globalThis.fetch so no implicit fallback is available.
  const savedFetch = globalThis.fetch;
  try {
    delete globalThis.fetch;
    await assert.rejects(
      () => fetchMessages('!abc'),
      TypeError
    );
  } finally {
    if (savedFetch !== undefined) globalThis.fetch = savedFetch;
  }
});

test('fetchMessages percent-encodes the node identifier in the URL', async () => {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    return { ok: true, status: 200, async json() { return []; } };
  };
  await fetchMessages('!aa bb', { fetchImpl });
  assert.ok(!calls[0].includes(' '), 'spaces should be percent-encoded in URL');
});

// ---------------------------------------------------------------------------
// fetchTracesForNode
// ---------------------------------------------------------------------------

test('fetchTracesForNode returns empty array when identifier is null', async () => {
  const fetchImpl = async () => { throw new Error('should not be called'); };
  assert.deepEqual(await fetchTracesForNode(null, { fetchImpl }), []);
  assert.deepEqual(await fetchTracesForNode(undefined, { fetchImpl }), []);
});

test('fetchTracesForNode fetches correct URL and returns parsed JSON', async () => {
  const calls = [];
  const traces = [{ hops: [] }];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, async json() { return traces; } };
  };

  const result = await fetchTracesForNode('!aabbccdd', { fetchImpl });
  assert.deepEqual(result, traces);
  assert.ok(calls[0].url.includes('/api/traces/'), 'URL should include traces path');
  assert.ok(calls[0].url.includes('limit='), 'URL should include limit parameter');
});

test('fetchTracesForNode returns empty array on 404', async () => {
  const fetchImpl = async () => ({ ok: false, status: 404 });
  const result = await fetchTracesForNode('!abc', { fetchImpl });
  assert.deepEqual(result, []);
});

test('fetchTracesForNode throws on non-404 error status', async () => {
  const fetchImpl = async () => ({ ok: false, status: 503 });
  await assert.rejects(
    () => fetchTracesForNode('!abc', { fetchImpl }),
    { message: /HTTP 503/ }
  );
});

test('fetchTracesForNode returns empty array when payload is not an array', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    async json() { return { traces: [] }; },
  });
  const result = await fetchTracesForNode('!abc', { fetchImpl });
  assert.deepEqual(result, []);
});

test('fetchTracesForNode throws TypeError when no fetch implementation is available', async () => {
  const savedFetch = globalThis.fetch;
  try {
    delete globalThis.fetch;
    await assert.rejects(
      () => fetchTracesForNode('!abc'),
      TypeError
    );
  } finally {
    if (savedFetch !== undefined) globalThis.fetch = savedFetch;
  }
});

test('fetchTracesForNode accepts numeric identifier', async () => {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    return { ok: true, status: 200, async json() { return []; } };
  };
  await fetchTracesForNode(12345, { fetchImpl });
  assert.ok(calls[0].includes('12345'), 'numeric identifier should appear in URL');
});
