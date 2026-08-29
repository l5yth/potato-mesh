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
  defaultRoleFor,
  getRoleColor,
  getRoleFlashColor,
  hexToRgba,
  getRoleKey,
  getRoleRenderPriority,
  getRoleColors,
  getRoleTextColor,
  getContrastTextColor,
  meshcoreRoleColors,
  meshcoreRoleRenderOrder,
  reticulumRoleColors,
  reticulumRoleRenderOrder,
  meshtasticRoleRenderOrder,
  roleColors,
  normalizeRole,
  translateRoleId,
} from '../role-helpers.js';

/**
 * WCAG 2.x contrast ratio between two hex colours.
 *
 * Reimplemented here because `role-helpers.js` keeps `contrastRatio` private
 * and exports only the pass/fail pick, {@link getContrastTextColor}.
 *
 * @param {string} a First hex colour.
 * @param {string} b Second hex colour.
 * @returns {number} Contrast ratio, 1-21.
 */
function contrastRatio(a, b) {
  const luminance = hex => {
    const channels = [1, 3, 5]
      .map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map(c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

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
  // 'reticulum' used to land here; it has its own ramp since SPEC RD5, so this
  // guards the genuine fallback rather than a protocol that now has a palette.
  assert.equal(getRoleColors('zigbee'), roleColors);
  assert.equal(getRoleColors(undefined), roleColors);
});

test('reticulum roles stack above the fall-through floor (RD5/RD6)', () => {
  // Without a Reticulum branch every RNS role returns 0 and draws beneath
  // every Meshtastic node, CLIENT_HIDDEN (1) included.
  for (const role of Object.keys(reticulumRoleColors)) {
    assert.ok(getRoleRenderPriority(role, 'reticulum') > 1, role);
  }
  // Ordered by how infrastructural the node is, mirroring the ramp.
  const order = ['PEER', 'NODE', 'TRANSPORT', 'PROPAGATION'].map(r =>
    getRoleRenderPriority(r, 'reticulum'),
  );
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.deepEqual(Object.keys(reticulumRoleRenderOrder), Object.keys(reticulumRoleColors));
});

test('getRoleColors returns the violet ramp for reticulum (RD5)', () => {
  assert.equal(getRoleColors('reticulum'), reticulumRoleColors);
  assert.deepEqual(Object.keys(reticulumRoleColors), [
    'PEER',
    'NODE',
    'TRANSPORT',
    'PROPAGATION',
  ]);
});

test('every reticulum role badge clears the 4.5:1 floor (RD5 / UX2)', () => {
  // The ramp is tied to the #7b61ff tile, so each step has to be checked
  // against the text colour the badge will actually use.
  for (const [role, fill] of Object.entries(reticulumRoleColors)) {
    const ratio = contrastRatio(getContrastTextColor(fill), fill);
    assert.ok(ratio >= 4.5, `${role} ${fill} scored ${ratio.toFixed(2)}, below 4.5:1`);
  }
});

test('the tile colour itself fails as a badge fill, which is why the ramp differs (RD5)', () => {
  // #7b61ff measures 4.39:1 — pinning the failure keeps a future "just use the
  // tile colour" simplification from silently breaking UX2.
  const tile = '#7b61ff';
  assert.ok(contrastRatio(getContrastTextColor(tile), tile) < 4.5);
  assert.notEqual(reticulumRoleColors.TRANSPORT, tile);
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

test('an unknown role falls back within its own protocol palette (SPEC RA9)', () => {
  // Previously every unknown role took the Meshtastic CLIENT colour, so a
  // Meshcore node was painted as something Meshcore has no concept of. Each
  // protocol now falls back to its own base role.
  assert.equal(getRoleColor('UNKNOWN_ROLE', 'meshcore'), meshcoreRoleColors.COMPANION);
  assert.equal(getRoleColor('UNKNOWN_ROLE', 'reticulum'), reticulumRoleColors.PEER);
  assert.equal(getRoleColor('UNKNOWN_ROLE', 'meshtastic'), roleColors.CLIENT);
});

test('defaultRoleFor names each protocol base role (SPEC RA9)', () => {
  assert.equal(defaultRoleFor('meshtastic'), 'CLIENT');
  assert.equal(defaultRoleFor('meshcore'), 'COMPANION');
  assert.equal(defaultRoleFor('reticulum'), 'PEER');
  // An unknown or absent protocol keeps the historical Meshtastic default.
  assert.equal(defaultRoleFor(null), 'CLIENT');
  assert.equal(defaultRoleFor('nonsense'), 'CLIENT');
});

test('normalizeRole applies the protocol base role when none is reported', () => {
  assert.equal(normalizeRole(null, 'meshcore'), 'COMPANION');
  assert.equal(normalizeRole('', 'reticulum'), 'PEER');
  assert.equal(normalizeRole(null), 'CLIENT');
  // A reported role is never overridden by the fallback.
  assert.equal(normalizeRole('REPEATER', 'meshcore'), 'REPEATER');
});

// SPEC UX2 (audit D-008): text colour is computed from the badge background's
// luminance — light text on dark fills, dark text on light fills — for every
// role of both palettes (the old one-role COMPANION override is gone).
test('getRoleTextColor picks light text for dark meshcore fills', () => {
  assert.equal(getRoleTextColor('COMPANION', 'meshcore'), '#ffffff');
  assert.equal(getRoleTextColor('SENSOR', 'meshcore'), '#ffffff');
});

test('getRoleTextColor picks dark text for light fills', () => {
  assert.equal(getRoleTextColor('REPEATER', 'meshcore'), '#111418');
  assert.equal(getRoleTextColor('CLIENT', 'meshtastic'), '#111418');
});

test('getRoleTextColor always returns a colour (never null)', () => {
  assert.equal(typeof getRoleTextColor('ROUTER', null), 'string');
  assert.equal(typeof getRoleTextColor('ROOM_SERVER', 'meshcore'), 'string');
});

test('getContrastTextColor flips at the luminance midpoint', () => {
  assert.equal(getContrastTextColor('#ffffff'), '#111418');
  assert.equal(getContrastTextColor('#000000'), '#ffffff');
});


test('hexToRgba converts 6- and 3-digit hex to rgba', () => {
  assert.equal(hexToRgba('#f3ef74', 0.55), 'rgba(243, 239, 116, 0.55)');
  assert.equal(hexToRgba('#abc', 1), 'rgba(170, 187, 204, 1)');
  assert.equal(hexToRgba('ff0019', 0.5), 'rgba(255, 0, 25, 0.5)');
});

test('hexToRgba clamps an out-of-range alpha to 1 and rejects non-hex', () => {
  assert.equal(hexToRgba('#ffffff', 5), 'rgba(255, 255, 255, 1)');
  assert.equal(hexToRgba('#ffffff', -1), 'rgba(255, 255, 255, 1)');
  assert.equal(hexToRgba('#ffffff', 'x'), 'rgba(255, 255, 255, 1)'); // non-number alpha -> 1
  assert.equal(hexToRgba('not-a-color', 0.5), null);
  assert.equal(hexToRgba('#12', 0.5), null);
  assert.equal(hexToRgba(123, 0.5), null);
});

test('getRoleFlashColor returns the role colour at the given alpha (LV3)', () => {
  assert.equal(getRoleFlashColor('CLIENT'), 'rgba(243, 239, 116, 0.55)');
  assert.equal(getRoleFlashColor('ROUTER', null, 0.8), 'rgba(255, 0, 25, 0.8)');
  // Unknown role falls back to the CLIENT colour via getRoleColor.
  assert.equal(getRoleFlashColor('NOPE'), 'rgba(243, 239, 116, 0.55)');
});
