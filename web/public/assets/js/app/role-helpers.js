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

/**
 * Mapping of numeric Meshtastic role identifiers to their canonical names.
 *
 * The mapping mirrors ``Config.DeviceConfig.Role`` enumeration values from
 * Meshtastic firmware and CLI tooling to ensure consistent colour and legend
 * lookups throughout the dashboard.
 *
 * @type {Readonly<Record<number, string>>}
 */
export const roleIdToName = Object.freeze({
  0: 'CLIENT',
  1: 'CLIENT_MUTE',
  2: 'ROUTER',
  3: 'ROUTER_CLIENT',
  4: 'REPEATER',
  5: 'TRACKER',
  6: 'SENSOR',
  7: 'TAK',
  8: 'CLIENT_HIDDEN',
  9: 'LOST_AND_FOUND',
  10: 'TAK_TRACKER',
  11: 'ROUTER_LATE',
  12: 'CLIENT_BASE',
});

// Firmware 2.7.10 / Android 2.7.0 roles and colors (see issue #177)
export const roleColors = Object.freeze({
  CLIENT_HIDDEN: '#A9CBE8',
  SENSOR: '#A8D5BA',
  TRACKER: '#B9DFAC',
  CLIENT_MUTE: '#CDE7A9',
  CLIENT: '#E8E6A1',
  CLIENT_BASE: '#F6D0A6',
  REPEATER: '#F7B7A3',
  ROUTER_LATE: '#F29AA3',
  ROUTER: '#E88B94',
  LOST_AND_FOUND: '#C3A8E8'
});

export const roleRenderOrder = Object.freeze({
  CLIENT_HIDDEN: 1,
  SENSOR: 2,
  TRACKER: 3,
  CLIENT_MUTE: 4,
  CLIENT: 5,
  CLIENT_BASE: 6,
  REPEATER: 7,
  ROUTER_LATE: 8,
  ROUTER: 9,
  LOST_AND_FOUND: 10
});

/**
 * Translate numeric identifiers or numeric strings into canonical role names.
 *
 * @param {*} role Raw role value, potentially numeric.
 * @returns {*} Canonical role name when recognised, otherwise the original value.
 */
export function translateRoleId(role) {
  const trimmed = typeof role === 'string' ? role.trim() : null;
  const numericCandidate = typeof role === 'number' ? role : (trimmed && trimmed !== '' ? Number(trimmed) : null);
  if (Number.isInteger(numericCandidate) && roleIdToName[numericCandidate] !== undefined) {
    return roleIdToName[numericCandidate];
  }
  return role;
}

/**
 * Normalise role strings so lookups remain consistent.
 *
 * @param {*} role Raw role value from the API.
 * @returns {string} Uppercase role identifier with a fallback of ``CLIENT``.
 */
export function normalizeRole(role) {
  const translated = translateRoleId(role);
  if (translated == null) return 'CLIENT';
  const str = String(translated).trim();
  return str.length ? str : 'CLIENT';
}

/**
 * Resolve the canonical role key used for colour lookup tables.
 *
 * @param {*} role Raw role value from the API.
 * @returns {string} Canonical role identifier.
 */
export function getRoleKey(role) {
  const normalized = normalizeRole(role);
  if (roleColors[normalized]) return normalized;
  const upper = normalized.toUpperCase();
  if (roleColors[upper]) return upper;
  return normalized;
}

/**
 * Determine the colour assigned to a role for legend badges.
 *
 * @param {*} role Raw role value.
 * @returns {string} CSS colour string.
 */
export function getRoleColor(role) {
  const key = getRoleKey(role);
  return roleColors[key] || roleColors.CLIENT || '#3388ff';
}

/**
 * Determine the render priority that decides marker stacking order.
 *
 * @param {*} role Raw role value.
 * @returns {number} Higher numbers render above lower ones.
 */
export function getRoleRenderPriority(role) {
  const key = getRoleKey(role);
  const priority = roleRenderOrder[key];
  return typeof priority === 'number' ? priority : 0;
}
