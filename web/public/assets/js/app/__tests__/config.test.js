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
import { documentStub, resetDocumentStub } from './document-stub.js';

import { readAppConfig } from '../config.js';
import { DEFAULT_CONFIG, mergeConfig } from '../settings.js';

test('readAppConfig returns an empty object when the configuration element is missing', () => {
  resetDocumentStub();
  assert.deepEqual(readAppConfig(), {});
});

test('readAppConfig returns an empty object when the attribute is empty', () => {
  resetDocumentStub();
  documentStub.setConfigElement({ getAttribute: () => '' });
  assert.deepEqual(readAppConfig(), {});
});

test('readAppConfig parses configuration JSON from the DOM attribute', () => {
  resetDocumentStub();
  const data = { refreshMs: 5000, chatEnabled: false };
  documentStub.setConfigElement({
    getAttribute: name => (name === 'data-app-config' ? JSON.stringify(data) : null)
  });
  assert.deepEqual(readAppConfig(), data);
});

test('readAppConfig returns an empty object and logs on parse failure', () => {
  resetDocumentStub();
  let called = false;
  const originalError = console.error;
  console.error = () => {
    called = true;
  };
  documentStub.setConfigElement({
    getAttribute: name => (name === 'data-app-config' ? 'not-json' : null)
  });

  assert.deepEqual(readAppConfig(), {});
  assert.equal(called, true);
  console.error = originalError;
});

test('mergeConfig applies default values when fields are missing', () => {
  const result = mergeConfig({});
  assert.deepEqual(result, {
    ...DEFAULT_CONFIG,
    mapCenter: { ...DEFAULT_CONFIG.mapCenter },
    tileFilters: { ...DEFAULT_CONFIG.tileFilters }
  });
});

test('mergeConfig coerces numeric values and nested objects', () => {
  const result = mergeConfig({
    refreshIntervalSeconds: '30',
    refreshMs: '45000',
    mapCenter: { lat: '10.5', lon: '20.1' },
    tileFilters: { dark: 'contrast(2)' },
    chatEnabled: 0,
    defaultChannel: '#Custom',
    defaultFrequency: '915MHz',
    maxNodeDistanceKm: '55.5'
  });

  assert.equal(result.refreshIntervalSeconds, 30);
  assert.equal(result.refreshMs, 45000);
  assert.deepEqual(result.mapCenter, { lat: 10.5, lon: 20.1 });
  assert.deepEqual(result.tileFilters, { light: DEFAULT_CONFIG.tileFilters.light, dark: 'contrast(2)' });
  assert.equal(result.chatEnabled, false);
  assert.equal(result.defaultChannel, '#Custom');
  assert.equal(result.defaultFrequency, '915MHz');
  assert.equal(result.maxNodeDistanceKm, 55.5);
});

test('mergeConfig falls back to defaults for invalid numeric values', () => {
  const result = mergeConfig({
    refreshIntervalSeconds: 'NaN',
    refreshMs: 'NaN',
    maxNodeDistanceKm: 'oops'
  });

  assert.equal(result.refreshIntervalSeconds, DEFAULT_CONFIG.refreshIntervalSeconds);
  assert.equal(result.refreshMs, DEFAULT_CONFIG.refreshMs);
  assert.equal(result.maxNodeDistanceKm, DEFAULT_CONFIG.maxNodeDistanceKm);
});
