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

import {
  filterDisplayableFederationInstances,
  isSuppressedFederationSiteName,
  resolveFederationInstanceLabel,
  resolveFederationSiteNameForDisplay,
  shouldDisplayFederationInstance,
  truncateFederationSiteName
} from '../federation-instance-display.js';

test('isSuppressedFederationSiteName detects URL-like advertising names', () => {
  assert.equal(isSuppressedFederationSiteName('http://spam.example offer'), true);
  assert.equal(isSuppressedFederationSiteName('Visit www.spam.example today'), true);
  assert.equal(isSuppressedFederationSiteName('Mesh Collective'), false);
  assert.equal(isSuppressedFederationSiteName(''), false);
  assert.equal(isSuppressedFederationSiteName(null), false);
});

test('truncateFederationSiteName shortens names longer than 32 characters', () => {
  assert.equal(truncateFederationSiteName('Short Mesh'), 'Short Mesh');
  assert.equal(
    truncateFederationSiteName('abcdefghijklmnopqrstuvwxyz1234567890'),
    'abcdefghijklmnopqrstuvwxyz12345...'
  );
  assert.equal(truncateFederationSiteName(null), '');
});

test('display helpers filter suppressed names and preserve original domains', () => {
  const entries = [
    { name: 'Normal Mesh', domain: 'normal.mesh' },
    { name: 'https://spam.example promo', domain: 'spam.mesh' },
    { domain: 'unnamed.mesh' }
  ];

  assert.equal(shouldDisplayFederationInstance(entries[0]), true);
  assert.equal(shouldDisplayFederationInstance(entries[1]), false);
  assert.deepEqual(filterDisplayableFederationInstances(entries), [
    { name: 'Normal Mesh', domain: 'normal.mesh' },
    { domain: 'unnamed.mesh' }
  ]);
  assert.equal(resolveFederationSiteNameForDisplay(entries[0]), 'Normal Mesh');
  assert.equal(resolveFederationInstanceLabel(entries[2]), 'unnamed.mesh');
});
