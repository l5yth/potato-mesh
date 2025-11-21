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
  getRoleColor,
  getRoleKey,
  getRoleRenderPriority,
  normalizeRole,
  translateRoleId,
} from '../role-helpers.js';

test('translateRoleId maps numeric inputs and leaves unknowns unchanged', () => {
  assert.equal(translateRoleId(0), 'CLIENT');
  assert.equal(translateRoleId(' 11 '), 'ROUTER_LATE');
  assert.equal(translateRoleId('0'), 'CLIENT');
  assert.equal(translateRoleId('99'), '99');
  assert.equal(translateRoleId(''), '');
  assert.equal(translateRoleId(null), null);
});

test('normalizeRole enforces a non-empty canonical string', () => {
  assert.equal(normalizeRole('client'), 'client');
  assert.equal(normalizeRole(' CLIENT_MUTE '), 'CLIENT_MUTE');
  assert.equal(normalizeRole(''), 'CLIENT');
  assert.equal(normalizeRole(undefined), 'CLIENT');
});

test('role key and color lookups prefer known values with uppercase fallback', () => {
  assert.equal(getRoleKey('client'), 'CLIENT');
  assert.equal(getRoleColor('client'), getRoleColor('CLIENT'));
  assert.equal(getRoleKey('custom-role'), 'custom-role');
  assert.equal(getRoleColor('custom-role'), getRoleColor('CLIENT'));
});

test('render priority uses canonical role keys and defaults to zero for unknowns', () => {
  assert.equal(getRoleRenderPriority('ROUTER'), getRoleRenderPriority(2));
  assert.equal(getRoleRenderPriority('custom-role'), 0);
});
