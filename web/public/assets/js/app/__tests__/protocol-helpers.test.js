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

import { isMeshtasticProtocol, meshtasticIconHtml, isMeshcoreProtocol, meshcoreIconHtml } from '../protocol-helpers.js';

test('isMeshtasticProtocol — null is Meshtastic (default)', () => {
  assert.equal(isMeshtasticProtocol(null), true);
});

test('isMeshtasticProtocol — undefined is Meshtastic (default)', () => {
  assert.equal(isMeshtasticProtocol(undefined), true);
});

test('isMeshtasticProtocol — empty string is Meshtastic', () => {
  assert.equal(isMeshtasticProtocol(''), true);
});

test('isMeshtasticProtocol — whitespace-only string is Meshtastic', () => {
  assert.equal(isMeshtasticProtocol('   '), true);
});

test('isMeshtasticProtocol — "meshtastic" is Meshtastic', () => {
  assert.equal(isMeshtasticProtocol('meshtastic'), true);
});

test('isMeshtasticProtocol — "meshcore" is not Meshtastic', () => {
  assert.equal(isMeshtasticProtocol('meshcore'), false);
});

test('isMeshtasticProtocol — "reticulum" is not Meshtastic', () => {
  assert.equal(isMeshtasticProtocol('reticulum'), false);
});

test('isMeshtasticProtocol — case-sensitive: "Meshtastic" is not matched', () => {
  assert.equal(isMeshtasticProtocol('Meshtastic'), false);
});

test('meshtasticIconHtml — returns img element HTML', () => {
  const html = meshtasticIconHtml();
  assert.ok(html.startsWith('<img '), 'should start with <img');
  assert.ok(html.includes('meshtastic.svg'), 'should reference meshtastic.svg');
  assert.ok(html.includes('protocol-icon--meshtastic'), 'should carry CSS class');
  assert.ok(html.includes('aria-hidden="true"'), 'should be hidden from AT');
});

test('isMeshcoreProtocol — "meshcore" is MeshCore', () => {
  assert.equal(isMeshcoreProtocol('meshcore'), true);
});

test('isMeshcoreProtocol — null is not MeshCore', () => {
  assert.equal(isMeshcoreProtocol(null), false);
});

test('isMeshcoreProtocol — undefined is not MeshCore', () => {
  assert.equal(isMeshcoreProtocol(undefined), false);
});

test('isMeshcoreProtocol — "meshtastic" is not MeshCore', () => {
  assert.equal(isMeshcoreProtocol('meshtastic'), false);
});

test('isMeshcoreProtocol — empty string is not MeshCore', () => {
  assert.equal(isMeshcoreProtocol(''), false);
});

test('meshcoreIconHtml — returns img element HTML', () => {
  const html = meshcoreIconHtml();
  assert.ok(html.startsWith('<img '), 'should start with <img');
  assert.ok(html.includes('meshcore.svg'), 'should reference meshcore.svg');
  assert.ok(html.includes('protocol-icon--meshcore'), 'should carry CSS class');
  assert.ok(html.includes('aria-hidden="true"'), 'should be hidden from AT');
});
