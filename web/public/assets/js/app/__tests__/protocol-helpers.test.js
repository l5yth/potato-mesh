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
  isMeshtasticProtocol,
  meshtasticIconHtml,
  isMeshcoreProtocol,
  meshcoreIconHtml,
  MESHTASTIC_ICON_SRC,
  MESHCORE_ICON_SRC,
  protocolIconPrefixHtml,
} from '../protocol-helpers.js';

// ---------------------------------------------------------------------------
// isMeshtasticProtocol — only matches the explicit string "meshtastic"
// ---------------------------------------------------------------------------

test('isMeshtasticProtocol — "meshtastic" is Meshtastic', () => {
  assert.equal(isMeshtasticProtocol('meshtastic'), true);
});

test('isMeshtasticProtocol — null is not Meshtastic (no default)', () => {
  assert.equal(isMeshtasticProtocol(null), false);
});

test('isMeshtasticProtocol — undefined is not Meshtastic (no default)', () => {
  assert.equal(isMeshtasticProtocol(undefined), false);
});

test('isMeshtasticProtocol — empty string is not Meshtastic', () => {
  assert.equal(isMeshtasticProtocol(''), false);
});

test('isMeshtasticProtocol — whitespace-only string is not Meshtastic', () => {
  assert.equal(isMeshtasticProtocol('   '), false);
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

test('MESHTASTIC_ICON_SRC is referenced by meshtasticIconHtml', () => {
  assert.ok(meshtasticIconHtml().includes(MESHTASTIC_ICON_SRC), 'icon HTML must embed the src constant');
});

test('MESHCORE_ICON_SRC is referenced by meshcoreIconHtml', () => {
  assert.ok(meshcoreIconHtml().includes(MESHCORE_ICON_SRC), 'icon HTML must embed the src constant');
});

// ---------------------------------------------------------------------------
// protocolIconPrefixHtml
// ---------------------------------------------------------------------------

test('protocolIconPrefixHtml — null yields empty string (no default)', () => {
  assert.equal(protocolIconPrefixHtml(null), '');
});

test('protocolIconPrefixHtml — undefined yields empty string (no default)', () => {
  assert.equal(protocolIconPrefixHtml(undefined), '');
});

test('protocolIconPrefixHtml — empty string yields empty string', () => {
  assert.equal(protocolIconPrefixHtml(''), '');
});

test('protocolIconPrefixHtml — "meshtastic" yields meshtastic icon prefix', () => {
  const result = protocolIconPrefixHtml('meshtastic');
  assert.ok(result.includes('meshtastic.svg'), '"meshtastic" should produce the meshtastic icon');
  assert.ok(!result.includes('meshcore.svg'), '"meshtastic" must not produce the meshcore icon');
  assert.ok(result.endsWith(' '), 'prefix must end with a trailing space');
});

test('protocolIconPrefixHtml — "meshcore" yields meshcore icon prefix', () => {
  const result = protocolIconPrefixHtml('meshcore');
  assert.ok(result.includes('meshcore.svg'), '"meshcore" should produce the meshcore icon');
  assert.ok(!result.includes('meshtastic.svg'), '"meshcore" must not produce the meshtastic icon');
  assert.ok(result.endsWith(' '), 'prefix must end with a trailing space');
});

test('protocolIconPrefixHtml — unknown protocol yields empty string', () => {
  assert.equal(protocolIconPrefixHtml('reticulum'), '', 'unknown protocol should produce no prefix');
  assert.equal(protocolIconPrefixHtml('LoRa'), '', 'unknown protocol should produce no prefix');
});
