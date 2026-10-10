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

import { createDomEnvironment } from './dom-environment.js';

// The charts, node and federation views load a boot module with
// `<script type="module" src>`, which the Content-Security-Policy allows by
// origin (SPEC HD3). Each boot module starts its page when it is evaluated.
// The runner gives this file its own process, so each import below evaluates
// its boot module once, against the globals the test stubs.

test('charts-page-boot starts the charts page against the document', async () => {
  const env = createDomEnvironment();
  const lookedUp = [];
  const { getElementById } = env.document;
  env.document.getElementById = id => {
    lookedUp.push(id);
    return getElementById.call(env.document, id);
  };
  try {
    const { chartsPageReady } = await import('../charts-page-boot.js');

    // No #chartsPage container on this document: the page reports false.
    assert.equal(await chartsPageReady, false);
    assert.deepEqual(lookedUp, ['chartsPage']);
  } finally {
    env.cleanup();
  }
});

test('node-page-boot starts the node page against the document', async () => {
  const env = createDomEnvironment();
  const selectors = [];
  env.document.querySelector = selector => {
    selectors.push(selector);
    return null;
  };
  try {
    const { nodeDetailPageReady } = await import('../node-page-boot.js');

    // No #nodeDetail section on this document: the page reports false.
    assert.equal(await nodeDetailPageReady, false);
    assert.deepEqual(selectors, ['#nodeDetail']);
  } finally {
    env.cleanup();
  }
});

test('federation-page-boot starts the federation page, which fetches the instances', async () => {
  const env = createDomEnvironment();
  const requested = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    requested.push(url);
    return { ok: true, json: async () => [] };
  };
  try {
    const { federationPageReady } = await import('../federation-page-boot.js');

    await federationPageReady;
    assert.deepEqual(requested, ['/api/instances']);
  } finally {
    globalThis.fetch = originalFetch;
    env.cleanup();
  }
});
