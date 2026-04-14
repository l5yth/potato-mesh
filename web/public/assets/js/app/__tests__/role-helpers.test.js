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
  getRoleColors,
  getRoleTextColor,
  meshcoreRoleColors,
  meshcoreRoleTextColors,
  meshcoreRoleRenderOrder,
  meshtasticRoleRenderOrder,
  roleColors,
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
  // translateRoleId(2) → 'ROUTER', so both should resolve to the same priority
  assert.equal(getRoleRenderPriority('ROUTER'), getRoleRenderPriority(2));
  assert.equal(getRoleRenderPriority('custom-role'), 0);
});

test('render priority is protocol-aware for shared roles', () => {
  // SENSOR: meshtastic=2, meshcore=9
  assert.equal(getRoleRenderPriority('SENSOR', 'meshtastic'), 2);
  assert.equal(getRoleRenderPriority('SENSOR', 'meshcore'), 9);
  assert.ok(getRoleRenderPriority('SENSOR', 'meshcore') > getRoleRenderPriority('SENSOR', 'meshtastic'));
  // REPEATER: meshtastic=11, meshcore=3
  assert.equal(getRoleRenderPriority('REPEATER', 'meshtastic'), 11);
  assert.equal(getRoleRenderPriority('REPEATER', 'meshcore'), 3);
  assert.ok(getRoleRenderPriority('REPEATER', 'meshtastic') > getRoleRenderPriority('REPEATER', 'meshcore'));
});

test('render priority meshcore-exclusive roles have defined priorities', () => {
  assert.equal(getRoleRenderPriority('COMPANION', 'meshcore'), 12);
  assert.equal(getRoleRenderPriority('ROOM_SERVER', 'meshcore'), 7);
});

test('render priority respects the full bottom-to-top order', () => {
  const order = [
    ['CLIENT_HIDDEN', null],
    ['SENSOR', 'meshtastic'],
    ['REPEATER', 'meshcore'],
    ['TRACKER', null],
    ['CLIENT_MUTE', null],
    ['CLIENT', null],
    ['ROOM_SERVER', 'meshcore'],
    ['CLIENT_BASE', null],
    ['SENSOR', 'meshcore'],
    ['ROUTER_LATE', null],
    ['REPEATER', 'meshtastic'],
    ['COMPANION', 'meshcore'],
    ['ROUTER', null],
    ['LOST_AND_FOUND', null],
  ];
  for (let i = 1; i < order.length; i++) {
    const [roleA, protoA] = order[i - 1];
    const [roleB, protoB] = order[i];
    const pA = getRoleRenderPriority(roleA, protoA);
    const pB = getRoleRenderPriority(roleB, protoB);
    assert.ok(pA < pB, `Expected ${roleA}/${protoA} (${pA}) < ${roleB}/${protoB} (${pB})`);
  }
});

test('getRoleColors returns Meshtastic palette for null/undefined/meshtastic', () => {
  assert.equal(getRoleColors(null), roleColors);
  assert.equal(getRoleColors(undefined), roleColors);
  assert.equal(getRoleColors('meshtastic'), roleColors);
  assert.equal(getRoleColors(''), roleColors);
});

test('getRoleColors returns MeshCore palette for meshcore protocol', () => {
  assert.equal(getRoleColors('meshcore'), meshcoreRoleColors);
});

test('getRoleColors returns Meshtastic palette for unknown protocols', () => {
  assert.equal(getRoleColors('reticulum'), roleColors);
});

test('getRoleColor uses meshcore palette when protocol is meshcore', () => {
  assert.equal(getRoleColor('COMPANION', 'meshcore'), meshcoreRoleColors.COMPANION);
  assert.equal(getRoleColor('REPEATER', 'meshcore'), meshcoreRoleColors.REPEATER);
  assert.equal(getRoleColor('ROOM_SERVER', 'meshcore'), meshcoreRoleColors.ROOM_SERVER);
  assert.equal(getRoleColor('SENSOR', 'meshcore'), meshcoreRoleColors.SENSOR);
});

test('getRoleColor uses meshtastic palette when protocol is null', () => {
  assert.equal(getRoleColor('ROUTER', null), roleColors.ROUTER);
  assert.equal(getRoleColor('CLIENT', null), roleColors.CLIENT);
});

test('getRoleColor falls back to CLIENT color for unknown meshcore role', () => {
  assert.equal(getRoleColor('UNKNOWN_ROLE', 'meshcore'), roleColors.CLIENT);
});

test('getRoleTextColor returns light grey for meshcore COMPANION', () => {
  assert.equal(getRoleTextColor('COMPANION', 'meshcore'), meshcoreRoleTextColors.COMPANION);
});

test('getRoleTextColor returns null for meshcore roles without override', () => {
  assert.equal(getRoleTextColor('REPEATER', 'meshcore'), null);
  assert.equal(getRoleTextColor('ROOM_SERVER', 'meshcore'), null);
  assert.equal(getRoleTextColor('SENSOR', 'meshcore'), null);
});

test('getRoleTextColor returns null for meshtastic roles', () => {
  assert.equal(getRoleTextColor('CLIENT', 'meshtastic'), null);
  assert.equal(getRoleTextColor('ROUTER', null), null);
});
