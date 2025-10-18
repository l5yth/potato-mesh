/*
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

import { buildInstanceUrl, initializeInstanceSelector, __test__ } from '../instance-selector.js';

const { resolveInstanceLabel } = __test__;

function setupSelectElement(document) {
  const select = document.createElement('select');
  const listeners = new Map();
  const options = [];

  Object.defineProperty(select, 'options', {
    get() {
      return options;
    }
  });

  Object.defineProperty(select, 'value', {
    get() {
      if (typeof select.selectedIndex !== 'number') {
        return '';
      }
      const current = options[select.selectedIndex];
      return current ? current.value : '';
    },
    set(newValue) {
      const index = options.findIndex(option => option.value === newValue);
      select.selectedIndex = index >= 0 ? index : -1;
    }
  });

  select.selectedIndex = -1;

  select.appendChild = option => {
    options.push(option);
    if (select.selectedIndex === -1) {
      select.selectedIndex = 0;
    }
    return option;
  };

  select.remove = index => {
    if (index >= 0 && index < options.length) {
      options.splice(index, 1);
      if (options.length === 0) {
        select.selectedIndex = -1;
      } else if (select.selectedIndex >= options.length) {
        select.selectedIndex = options.length - 1;
      }
    }
  };

  select.addEventListener = (event, handler) => {
    listeners.set(event, handler);
  };
  select.dispatchEvent = event => {
    const key = typeof event === 'string' ? event : event?.type;
    const handler = listeners.get(key);
    if (handler) {
      handler(event);
    }
  };
  return select;
}

test('resolveInstanceLabel falls back to the domain when the name is missing', () => {
  assert.equal(resolveInstanceLabel({ domain: 'mesh.example' }), 'mesh.example');
  assert.equal(resolveInstanceLabel({ name: '  Mesh Name  ' }), 'Mesh Name');
  assert.equal(resolveInstanceLabel(null), '');
});

test('buildInstanceUrl normalises domains into navigable HTTPS URLs', () => {
  assert.equal(buildInstanceUrl('mesh.example'), 'https://mesh.example');
  assert.equal(buildInstanceUrl(' https://mesh.example '), 'https://mesh.example');
  assert.equal(buildInstanceUrl(''), null);
  assert.equal(buildInstanceUrl(null), null);
});

test('initializeInstanceSelector populates options alphabetically and selects the configured domain', async () => {
  const env = createDomEnvironment();
  const select = setupSelectElement(env.document);

  const fetchCalls = [];
  const fetchImpl = async url => {
    fetchCalls.push(url);
    return {
      ok: true,
      async json() {
        return [
          { name: 'Zulu Mesh', domain: 'zulu.mesh' },
          { name: 'Alpha Mesh', domain: 'alpha.mesh' },
          { domain: 'beta.mesh' }
        ];
      }
    };
  };

  try {
    await initializeInstanceSelector({
      selectElement: select,
      fetchImpl,
      windowObject: env.window,
      documentObject: env.document,
      instanceDomain: 'beta.mesh',
      defaultLabel: 'Select region ...'
    });

    assert.equal(fetchCalls.length, 1);
    assert.equal(select.options.length, 4);
    assert.equal(select.options[0].textContent, 'Select region ...');
    assert.equal(select.options[1].textContent, 'Alpha Mesh');
    assert.equal(select.options[2].textContent, 'beta.mesh');
    assert.equal(select.options[3].textContent, 'Zulu Mesh');
    assert.equal(select.options[select.selectedIndex].value, 'beta.mesh');
  } finally {
    env.cleanup();
  }
});

test('initializeInstanceSelector navigates to the chosen instance domain', async () => {
  const env = createDomEnvironment();
  const select = setupSelectElement(env.document);

  const fetchImpl = async () => ({
    ok: true,
    async json() {
      return [{ domain: 'mesh.example' }];
    }
  });

  let navigatedTo = null;
  const navigate = url => {
    navigatedTo = url;
  };

  try {
    await initializeInstanceSelector({
      selectElement: select,
      fetchImpl,
      windowObject: env.window,
      documentObject: env.document,
      navigate,
      defaultLabel: 'Select region ...'
    });

    assert.equal(select.options.length, 2);
    assert.equal(select.options[1].value, 'mesh.example');

    select.value = 'mesh.example';
    select.dispatchEvent({ type: 'change', target: select });

    assert.equal(navigatedTo, 'https://mesh.example');
  } finally {
    env.cleanup();
  }
});
