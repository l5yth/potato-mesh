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

import { createMessageNodeHydrator, MESSAGE_HYDRATION_CONCURRENCY } from '../message-node-hydrator.js';

/**
 * Build a fetch double that records the maximum number of simultaneously
 * pending lookups so tests can assert the worker-pool cap is honoured.
 *
 * @param {number} settleDelayMs Milliseconds to keep each lookup pending
 *   before resolving, giving sibling workers a chance to start.
 * @returns {{
 *   fetchNodeById: (id: string) => Promise<object|null>,
 *   maxInFlight: () => number,
 *   totalCalls: () => number,
 * }} Helper API exposing the recorded peak concurrency.
 */
function makeConcurrencyProbe(settleDelayMs = 10) {
  let inFlight = 0;
  let peak = 0;
  let total = 0;
  return {
    async fetchNodeById(id) {
      inFlight += 1;
      total += 1;
      peak = Math.max(peak, inFlight);
      try {
        await new Promise(resolve => setTimeout(resolve, settleDelayMs));
        return { node_id: id, short_name: id.slice(1, 5) };
      } finally {
        inFlight -= 1;
      }
    },
    maxInFlight: () => peak,
    totalCalls: () => total,
  };
}

/**
 * Build N messages with unique sender identifiers for concurrency tests.
 *
 * @param {number} count Number of messages to produce.
 * @returns {Array<object>} Synthetic message payloads.
 */
function makeUniqueSenderMessages(count) {
  return Array.from({ length: count }, (_, index) => ({
    from_id: `!sender${index.toString().padStart(4, '0')}`,
    text: `m${index}`,
  }));
}

/**
 * Capture warning invocations produced during a test run.
 */
class LoggerStub {
  constructor() {
    this.messages = [];
  }

  /**
   * Record a warning message for later inspection.
   *
   * @param {...*} args Warning arguments.
   * @returns {void}
   */
  warn(...args) {
    this.messages.push(args);
  }
}

test('hydrate attaches cached nodes without performing lookups', async () => {
  const node = { node_id: '!abc', short_name: 'Node' };
  const nodesById = new Map([[node.node_id, node]]);
  const hydrator = createMessageNodeHydrator({
    fetchNodeById: async () => {
      throw new Error('fetch should not be called');
    },
    applyNodeFallback: () => {}
  });

  const messages = [{ node_id: '!abc', text: 'Hello' }];
  const result = await hydrator.hydrate(messages, nodesById);

  assert.equal(result.length, 1);
  assert.strictEqual(result[0].node, node);
  assert.equal(nodesById.size, 1);
});

test('hydrate fetches missing nodes once and caches the result', async () => {
  let fetchCalls = 0;
  const fetchedNode = { node_id: '!fetch', short_name: 'Fetched' };
  const hydrator = createMessageNodeHydrator({
    fetchNodeById: async id => {
      fetchCalls += 1;
      assert.equal(id, '!fetch');
      return { ...fetchedNode };
    },
    applyNodeFallback: () => {}
  });
  const nodesById = new Map();
  const messages = [{ from_id: '!fetch', text: 'one' }, { node_id: '!fetch', text: 'two' }];

  const result = await hydrator.hydrate(messages, nodesById);

  assert.equal(fetchCalls, 1);
  assert.strictEqual(nodesById.get('!fetch').short_name, 'Fetched');
  assert.strictEqual(result[0].node, nodesById.get('!fetch'));
  assert.strictEqual(result[1].node, nodesById.get('!fetch'));
});

test('hydrate caches 404 results so subsequent calls do not refetch dead ids', async () => {
  let fetchCalls = 0;
  const hydrator = createMessageNodeHydrator({
    fetchNodeById: async () => {
      fetchCalls += 1;
      return null;
    },
    applyNodeFallback: () => {},
  });
  const messages = [{ from_id: '!gone', text: 'first' }];
  const nodesById = new Map();

  await hydrator.hydrate(messages, nodesById);
  await hydrator.hydrate([{ from_id: '!gone', text: 'second' }], nodesById);
  await hydrator.hydrate([{ from_id: '!gone', text: 'third' }], nodesById);

  assert.equal(fetchCalls, 1);
});

test('cached missing entry is overridden when nodesById later resolves the id', async () => {
  let fetchCalls = 0;
  const hydrator = createMessageNodeHydrator({
    fetchNodeById: async () => {
      fetchCalls += 1;
      return null;
    },
    applyNodeFallback: () => {},
  });
  const nodesById = new Map();

  await hydrator.hydrate([{ from_id: '!late', text: 'first' }], nodesById);
  assert.equal(fetchCalls, 1);

  // Bulk /api/nodes refresh resolves the id afterwards.
  const lateNode = { node_id: '!late', short_name: 'Late' };
  nodesById.set('!late', lateNode);

  const result = await hydrator.hydrate([{ from_id: '!late', text: 'second' }], nodesById);
  assert.equal(fetchCalls, 1);
  assert.strictEqual(result[0].node, lateNode);
});

test('hydrate caches lookup failures alongside 404s', async () => {
  let fetchCalls = 0;
  const hydrator = createMessageNodeHydrator({
    fetchNodeById: async () => {
      fetchCalls += 1;
      throw new Error('network down');
    },
    applyNodeFallback: () => {},
    logger: { warn() {} },
  });
  const nodesById = new Map();

  await hydrator.hydrate([{ from_id: '!flaky', text: 'a' }], nodesById);
  await hydrator.hydrate([{ from_id: '!flaky', text: 'b' }], nodesById);

  assert.equal(fetchCalls, 1);
});

test('hydrate falls back to placeholders when lookups fail', async () => {
  const logger = new LoggerStub();
  let fallbackCalls = 0;
  const hydrator = createMessageNodeHydrator({
    fetchNodeById: async () => null,
    applyNodeFallback: node => {
      fallbackCalls += 1;
      if (!node.short_name) {
        node.short_name = 'Fallback';
      }
    },
    logger
  });
  const nodesById = new Map();
  const messages = [{ from_id: '!missing', text: 'hi' }];

  const result = await hydrator.hydrate(messages, nodesById);

  assert.equal(nodesById.has('!missing'), false);
  assert.equal(fallbackCalls, 1);
  assert.ok(result[0].node);
  assert.equal(result[0].node.short_name, 'Fallback');
  assert.equal(logger.messages.length, 0);
});

test('hydrate records warning when fetch rejects', async () => {
  const logger = new LoggerStub();
  const hydrator = createMessageNodeHydrator({
    fetchNodeById: async () => {
      throw new Error('network error');
    },
    applyNodeFallback: () => {},
    logger
  });
  const nodesById = new Map();
  const messages = [{ from_id: '!warn', text: 'warn' }];

  const result = await hydrator.hydrate(messages, nodesById);

  assert.equal(result[0].node.node_id, '!warn');
  assert.ok(logger.messages.length >= 1);
  assert.equal(nodesById.has('!warn'), false);
});

test('hydrate caps in-flight lookups at the default concurrency', async () => {
  const probe = makeConcurrencyProbe();
  const hydrator = createMessageNodeHydrator({
    fetchNodeById: probe.fetchNodeById,
    applyNodeFallback: () => {},
  });
  const messages = makeUniqueSenderMessages(MESSAGE_HYDRATION_CONCURRENCY * 3);

  await hydrator.hydrate(messages, new Map());

  assert.equal(probe.totalCalls(), messages.length);
  assert.ok(
    probe.maxInFlight() <= MESSAGE_HYDRATION_CONCURRENCY,
    `expected <= ${MESSAGE_HYDRATION_CONCURRENCY} concurrent fetches, observed ${probe.maxInFlight()}`,
  );
});

test('hydrate honours a custom concurrency override', async () => {
  const probe = makeConcurrencyProbe();
  const hydrator = createMessageNodeHydrator({
    fetchNodeById: probe.fetchNodeById,
    applyNodeFallback: () => {},
    concurrency: 2,
  });
  const messages = makeUniqueSenderMessages(8);

  await hydrator.hydrate(messages, new Map());

  assert.equal(probe.totalCalls(), 8);
  assert.equal(probe.maxInFlight(), 2);
});

test('hydrate serialises lookups when concurrency is one', async () => {
  const probe = makeConcurrencyProbe();
  const hydrator = createMessageNodeHydrator({
    fetchNodeById: probe.fetchNodeById,
    applyNodeFallback: () => {},
    concurrency: 1,
  });
  const messages = makeUniqueSenderMessages(4);

  await hydrator.hydrate(messages, new Map());

  assert.equal(probe.maxInFlight(), 1);
});

test('hydrate falls back to the default cap for invalid concurrency values', async () => {
  for (const invalid of [0, -3, Number.NaN, Number.POSITIVE_INFINITY, 'four']) {
    const probe = makeConcurrencyProbe();
    const hydrator = createMessageNodeHydrator({
      fetchNodeById: probe.fetchNodeById,
      applyNodeFallback: () => {},
      concurrency: invalid,
    });
    const messages = makeUniqueSenderMessages(MESSAGE_HYDRATION_CONCURRENCY * 2);

    await hydrator.hydrate(messages, new Map());

    assert.ok(
      probe.maxInFlight() <= MESSAGE_HYDRATION_CONCURRENCY,
      `concurrency=${String(invalid)} should fall back to default; observed peak ${probe.maxInFlight()}`,
    );
  }
});

test('factory rejects missing fetch and fallback dependencies', () => {
  assert.throws(
    () => createMessageNodeHydrator({ applyNodeFallback: () => {} }),
    TypeError,
  );
  assert.throws(
    () => createMessageNodeHydrator({ fetchNodeById: async () => null }),
    TypeError,
  );
});

test('hydrate skips non-object entries and senderless messages', async () => {
  let fetchCalls = 0;
  const hydrator = createMessageNodeHydrator({
    fetchNodeById: async () => {
      fetchCalls += 1;
      return null;
    },
    applyNodeFallback: () => {},
  });
  const senderless = { text: 'no sender' };
  const messages = [null, 'not-an-object', senderless];

  const result = await hydrator.hydrate(messages, new Map());

  assert.equal(fetchCalls, 0);
  assert.equal(result.length, 3);
  assert.strictEqual(senderless.node, null);
});

test('hydrate dedupes duplicate senders without exceeding the cap', async () => {
  const probe = makeConcurrencyProbe();
  const hydrator = createMessageNodeHydrator({
    fetchNodeById: probe.fetchNodeById,
    applyNodeFallback: () => {},
    concurrency: 2,
  });
  // Twenty messages but only four unique senders.  After the first lookup
  // for a given sender resolves, ``resolveNode`` writes the result into the
  // shared ``nodesById`` cache; every later message with the same id is
  // bound synchronously from that cache before it ever reaches the worker
  // pool, so the total fetch count collapses to the four unique senders.
  // (The inflight-promise map only matters when two workers happen to race
  // on the same id, which barely happens at concurrency=2 — the
  // ``nodesById`` short-circuit is the dominant mechanism here.)
  const senders = ['!aaa', '!bbb', '!ccc', '!ddd'];
  const messages = Array.from({ length: 20 }, (_, index) => ({
    from_id: senders[index % senders.length],
    text: `dup${index}`,
  }));

  await hydrator.hydrate(messages, new Map());

  assert.equal(probe.totalCalls(), senders.length);
  assert.ok(probe.maxInFlight() <= 2);
});
