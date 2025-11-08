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

import { createMessageNodeHydrator } from '../message-node-hydrator.js';

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
