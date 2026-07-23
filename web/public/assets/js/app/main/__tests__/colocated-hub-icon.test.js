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

// Regression guard for audit finding D-031 (SPEC UX11 / ACCEPTANCE UX-A9):
// the colocated-node hub keeps its 16 px glyph but grows a 32 px hit area.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COLOCATED_HUB_HIT_SIZE,
  colocatedHubIconDefinition,
} from '../colocated-hub-icon.js';

test('hub hit area is 32 px with a centered anchor', () => {
  assert.equal(COLOCATED_HUB_HIT_SIZE, 32);
  const definition = colocatedHubIconDefinition(4);
  assert.deepEqual(definition.iconSize, [32, 32]);
  assert.deepEqual(definition.iconAnchor, [16, 16]);
  assert.equal(definition.className, 'colocated-spider-hub');
});

test('hub html keeps the 16 px glyph with the group size', () => {
  const definition = colocatedHubIconDefinition(7);
  assert.ok(definition.html.includes('colocated-spider-hub__glyph'));
  assert.ok(definition.html.includes('*7'));
});
