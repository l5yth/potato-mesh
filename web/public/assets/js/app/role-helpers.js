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

import { isMeshcoreProtocol } from './protocol-helpers.js';

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

/**
 * Meshtastic role colour palette — broad-spectrum blue-green-yellow-red gradient
 * with a distinctive lavender accent for {@link LOST_AND_FOUND}.  Adopted from
 * the meshenvy fork to keep visual consistency across instances.
 *
 * The cool-blue low end is differentiated from the MeshCore steel-grey palette
 * by saturation (51 %+ here vs 18 % for MeshCore) and an 8-degree hue offset.
 *
 * Firmware 2.7.10 / Android 2.7.0 roles (see issue #177).
 *
 * @type {Readonly<Record<string, string>>}
 */
export const roleColors = Object.freeze({
  CLIENT_HIDDEN: '#A9CBE8',
  SENSOR: '#A8D5BA',
  TRACKER: '#99e67f',
  CLIENT_MUTE: '#bcef75',
  CLIENT: '#f3ef74',
  CLIENT_BASE: '#fdbf79',
  REPEATER: '#fa997b',
  ROUTER_LATE: '#ff5061',
  ROUTER: '#ff0019',
  LOST_AND_FOUND: '#C3A8E8',
});

/**
 * MeshCore role colour palette — cool grey-blue gradient used to distinguish
 * MeshCore nodes from Meshtastic nodes in future protocol-aware views.
 *
 * These colours are defined now for completeness but are not yet applied to
 * live UI surfaces — see the protocol-aware legend work that will follow once
 * MeshCore ingest is implemented.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const meshcoreRoleColors = Object.freeze({
  REPEATER: '#B8C4D4',
  ROOM_SERVER: '#7A9EBC',
  SENSOR: '#40749E',
  COMPANION: '#164A88',
});

/**
 * MeshCore role text colour overrides — only populated for roles whose
 * background is dark enough that the default (near-black) text becomes
 * illegible.  Roles absent from this map inherit the page default.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const meshcoreRoleTextColors = Object.freeze({
  COMPANION: '#e0e0e0',
});

/**
 * Return the foreground text colour for a role badge, or ``null`` when the
 * page default is acceptable.
 *
 * @param {*} role Raw role value from the API.
 * @param {string|null|undefined} [protocol] Protocol string from the API.
 * @returns {string|null} CSS colour string, or ``null`` to inherit.
 */
export function getRoleTextColor(role, protocol = null) {
  if (isMeshcoreProtocol(protocol)) {
    const key = getRoleKey(role);
    return meshcoreRoleTextColors[key] ?? null;
  }
  return null;
}

/**
 * Return the role colour palette appropriate for the given protocol.
 *
 * Defaults to {@link roleColors} (Meshtastic) for absent or unrecognised
 * protocol values so existing callers are unaffected when MeshCore ingest
 * is not yet active.
 *
 * @param {string|null|undefined} protocol Protocol string from the API.
 * @returns {Readonly<Record<string, string>>} Role colour map.
 */
export function getRoleColors(protocol) {
  return isMeshcoreProtocol(protocol) ? meshcoreRoleColors : roleColors;
}

/**
 * Meshtastic-specific render priority order for map marker stacking.
 * Higher numbers render above lower ones (LOST_AND_FOUND on top).
 *
 * @type {Readonly<Record<string, number>>}
 */
export const meshtasticRoleRenderOrder = Object.freeze({
  CLIENT_HIDDEN: 1,
  SENSOR: 2,
  TRACKER: 4,
  CLIENT_MUTE: 5,
  CLIENT: 6,
  CLIENT_BASE: 8,
  ROUTER_LATE: 10,
  REPEATER: 11,
  ROUTER: 13,
  LOST_AND_FOUND: 14,
});

/**
 * MeshCore-specific render priority overrides.  Bottom-up stacking order:
 * REPEATER → ROOM_SERVER → SENSOR → COMPANION (top), so companion nodes
 * are always visible above infrastructure roles.
 *
 * @type {Readonly<Record<string, number>>}
 */
export const meshcoreRoleRenderOrder = Object.freeze({
  REPEATER: 3,
  ROOM_SERVER: 7,
  SENSOR: 9,
  COMPANION: 12,
});

/**
 * Backward-compatible alias kept for any code that still imports
 * ``roleRenderOrder`` by name.
 *
 * @deprecated Use {@link meshtasticRoleRenderOrder} directly.
 * @type {Readonly<Record<string, number>>}
 */
export const roleRenderOrder = meshtasticRoleRenderOrder;

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
 * Pass the node's ``protocol`` field to select the correct palette: MeshCore
 * roles are looked up in {@link meshcoreRoleColors}; everything else falls
 * back to the Meshtastic {@link roleColors} palette.
 *
 * @param {*} role Raw role value.
 * @param {string|null|undefined} [protocol] Protocol string from the API.
 * @returns {string} CSS colour string.
 */
export function getRoleColor(role, protocol = null) {
  const colors = getRoleColors(protocol);
  const key = getRoleKey(role);
  return colors[key] || roleColors.CLIENT || '#3388ff';
}

/**
 * Determine the render priority that decides marker stacking order.
 *
 * MeshCore nodes use {@link meshcoreRoleRenderOrder} for roles that differ
 * from Meshtastic; everything else falls back to
 * {@link meshtasticRoleRenderOrder}.
 *
 * @param {*} role Raw role value.
 * @param {string|null|undefined} [protocol] Protocol string from the API.
 * @returns {number} Higher numbers render above lower ones.
 */
export function getRoleRenderPriority(role, protocol = null) {
  const key = getRoleKey(role);
  if (isMeshcoreProtocol(protocol)) {
    const mc = meshcoreRoleRenderOrder[key];
    if (typeof mc === 'number') return mc;
  }
  const priority = meshtasticRoleRenderOrder[key];
  return typeof priority === 'number' ? priority : 0;
}
