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

import { enhanceCoordinateCell, __testUtils } from '../nodes-coordinate-links.js';

const { toFiniteCoordinate } = __testUtils;

test('enhanceCoordinateCell renders an interactive button for valid coordinates', () => {
  const cell = {
    replacedChildren: null,
    replaceChildren(...children) {
      this.replacedChildren = children;
    }
  };
  const buttonStub = {
    dataset: {},
    attributes: new Map(),
    listeners: new Map(),
    setAttribute(name, value) {
      this.attributes.set(name, value);
    },
    addEventListener(name, handler) {
      this.listeners.set(name, handler);
    }
  };
  const documentStub = {
    createElement(tagName) {
      assert.equal(tagName, 'button');
      return buttonStub;
    }
  };
  const activations = [];
  const button = enhanceCoordinateCell({
    cell,
    document: documentStub,
    displayText: '51.50000',
    formattedLatitude: '51.50000',
    formattedLongitude: '-0.12000',
    lat: '51.5',
    lon: '-0.12',
    nodeName: 'Alpha',
    onActivate: (lat, lon) => activations.push({ lat, lon })
  });

  assert.equal(button, buttonStub);
  assert.deepEqual(cell.replacedChildren, [buttonStub]);
  assert.equal(buttonStub.textContent, '51.50000');
  assert.equal(buttonStub.dataset.lat, '51.5');
  assert.equal(buttonStub.dataset.lon, '-0.12');
  assert.equal(buttonStub.className, 'nodes-coordinate-button');
  assert.equal(buttonStub.attributes.get('aria-label'), 'Center map on Alpha at 51.50000, -0.12000');

  const clickHandler = buttonStub.listeners.get('click');
  assert.equal(typeof clickHandler, 'function');
  const event = {
    prevented: false,
    stopped: false,
    preventDefault() {
      this.prevented = true;
    },
    stopPropagation() {
      this.stopped = true;
    }
  };
  clickHandler(event);
  assert.equal(event.prevented, true);
  assert.equal(event.stopped, true);
  assert.deepEqual(activations, [{ lat: 51.5, lon: -0.12 }]);
});

test('enhanceCoordinateCell ignores invalid input data', () => {
  const cell = {
    replaceChildren() {
      assert.fail('replaceChildren should not be called for invalid data');
    }
  };
  const resultEmpty = enhanceCoordinateCell({
    cell,
    document: {},
    displayText: '',
    lat: 0,
    lon: 0
  });
  assert.equal(resultEmpty, null);

  const resultInvalid = enhanceCoordinateCell({
    cell,
    document: {},
    displayText: 'value',
    lat: 'north',
    lon: 5
  });
  assert.equal(resultInvalid, null);
});

test('toFiniteCoordinate returns finite numbers and rejects NaN', () => {
  assert.equal(toFiniteCoordinate('12.34'), 12.34);
  assert.equal(toFiniteCoordinate(56.78), 56.78);
  assert.equal(toFiniteCoordinate('NaN'), null);
  assert.equal(toFiniteCoordinate(undefined), null);
});
