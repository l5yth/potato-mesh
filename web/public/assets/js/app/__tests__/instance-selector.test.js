/*
 * Copyright (C) 2025 l5yth
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
import { createInstanceSelector } from '../instance-selector.js';

/**
 * Prepare the DOM scaffolding required for the instance selector tests.
 *
 * @param {ReturnType<typeof createDomEnvironment>} env Active DOM harness.
 * @returns {{
 *   container: HTMLElement,
 *   select: HTMLSelectElement,
 *   placeholder: HTMLOptionElement
 * }}
 */
function setupInstanceSelectorDom(env) {
  const container = env.createElement('div', 'instanceSelectorContainer');
  container.hidden = true;
  const select = env.createElement('select', 'instanceSelect');
  select.disabled = true;
  const placeholder = env.createElement('option', 'instanceSelectPlaceholder');
  placeholder.value = '';
  placeholder.textContent = 'Loading instances…';
  select.appendChild(placeholder);
  container.appendChild(select);
  return { container, select, placeholder };
}

test('instance selector populates options and respects default domain', async () => {
  const env = createDomEnvironment();
  const { container, select, placeholder } = setupInstanceSelectorDom(env);
  env.window.location = {
    protocol: 'https:',
    assign(url) {
      this.lastUrl = url;
    }
  };

  let fetchCalls = 0;
  const selector = createInstanceSelector({
    document: env.document,
    window: env.window,
    fetchImpl: async url => {
      fetchCalls += 1;
      assert.equal(url, '/api/instances');
      return {
        ok: true,
        status: 200,
        async json() {
          return [
            { domain: 'beta.mesh', name: 'Beta Mesh' },
            { domain: 'gamma.mesh' },
            { domain: 'alpha.mesh', name: 'Alpha Mesh' }
          ];
        }
      };
    },
    config: { instanceDomain: 'gamma.mesh' }
  });

  const instances = await selector.loadInstances();

  assert.equal(fetchCalls, 1);
  assert.equal(container.hidden, false);
  assert.equal(select.disabled, false);
  assert.equal(placeholder.textContent, 'Select region ...');
  assert.equal(instances.length, 3);
  assert.deepEqual(instances.map(entry => entry.domain), [
    'alpha.mesh',
    'beta.mesh',
    'gamma.mesh'
  ]);
  assert.equal(select.children.length, 4);
  assert.equal(select.children[1].textContent, 'Alpha Mesh');
  assert.equal(select.children[2].textContent, 'Beta Mesh');
  assert.equal(select.children[3].textContent, 'gamma.mesh');
  assert.equal(select.value, 'gamma.mesh');

  select.value = 'alpha.mesh';
  selector.__testHooks.handleChange({ target: select });
  assert.equal(env.window.location.lastUrl, 'https://alpha.mesh');

  env.cleanup();
});

test('instance selector ignores placeholder changes and tolerates failures', async () => {
  const env = createDomEnvironment();
  const { container, select, placeholder } = setupInstanceSelectorDom(env);
  env.window.location = {
    protocol: 'http:',
    assign(url) {
      this.lastUrl = url;
    }
  };

  const selector = createInstanceSelector({
    document: env.document,
    window: env.window,
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => [] })
  });

  const empty = await selector.loadInstances();
  assert.deepEqual(empty, []);
  assert.equal(container.hidden, true);
  assert.equal(select.disabled, true);
  assert.equal(placeholder.textContent, 'Instances unavailable');

  select.value = '';
  selector.__testHooks.handleChange({ target: select });
  assert.equal(env.window.location.lastUrl, undefined);

  env.cleanup();
});

test('formatDomainUrl respects window protocol and sanitises domains', () => {
  const env = createDomEnvironment();
  setupInstanceSelectorDom(env);
  const selector = createInstanceSelector({ document: env.document, window: env.window });

  env.window.location = { protocol: 'http:' };
  assert.equal(selector.__testHooks.formatDomainUrl('example.com'), 'http://example.com');
  env.window.location = { protocol: 'custom:' };
  assert.equal(selector.__testHooks.formatDomainUrl('another.example'), 'https://another.example');
  assert.equal(selector.__testHooks.formatDomainUrl(''), null);
  assert.equal(selector.__testHooks.formatDomainUrl(42), null);

  env.cleanup();
});
