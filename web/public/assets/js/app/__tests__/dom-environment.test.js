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

test('dom environment supports class queries and innerHTML setter', () => {
  const env = createDomEnvironment({ includeBody: true });
  const { document, createElement, cleanup } = env;

  const parent = createElement('div');
  const child = createElement('span');
  child.classList.add('leaflet-tile');
  child.setAttribute('data-test', 'ok');
  parent.appendChild(child);

  const matches = parent.querySelectorAll('.leaflet-tile');
  assert.equal(matches.length, 1);
  assert.equal(matches[0], child);

  const target = createElement('div');
  target.innerHTML = '<b>hello</b>';
  assert.match(target.innerHTML, /hello/);

  const fragment = document.createDocumentFragment();
  fragment.replaceChildren(createElement('p'));
  const container = createElement('section');
  const decorated = createElement('span');
  decorated.setAttribute('data-id', '123');
  decorated.classList.add('foo');
  container.appendChild(decorated);
  assert.match(container.innerHTML, /data-id="123"/);
  assert.match(container.innerHTML, /class="foo"/);
  container.replaceChildren(createElement('div')); // cover non-fragment path
  container.childNodes.push({}); // cover empty serialization branch
  assert.ok(container.innerHTML.includes('<div'));

  cleanup();
});
