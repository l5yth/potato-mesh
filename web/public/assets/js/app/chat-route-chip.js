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
 * Route chip for chat lines (SPEC SC7, #765).
 *
 * A message carrying a ``hops`` count gets a small chip after its sender
 * badge: the hop count, then the MeshCore flood-scope label. Its ``title``
 * and ``aria-label`` list the repeater path hashes in travel order, then the
 * SNR and RSSI. The dashboard chat and the node page share it. Any protocol
 * with ``hops`` gets one, Meshtastic included; path hashes are shown as
 * received, never resolved to node names.
 *
 * @module chat-route-chip
 */

import { escapeHtml } from './utils.js';

/**
 * ``scope`` of a message delivered by a plain, unscoped MeshCore flood. Shown
 * with no label.
 *
 * @type {string}
 */
export const SCOPE_UNSCOPED = '*';

/**
 * Reserved ``scope`` of a scoped flood whose region the ingestor could not
 * name.
 *
 * @type {string}
 */
export const SCOPE_UNKNOWN = '?';

/**
 * Label shown for {@link SCOPE_UNKNOWN}.
 *
 * @type {string}
 */
export const SCOPE_UNKNOWN_LABEL = 'scoped';

/**
 * Read a hop count: a non-negative integer, or ``null``.
 *
 * @param {*} value Raw ``hops`` field.
 * @returns {?number} The hop count, or ``null`` when absent or invalid.
 */
export function routeHopCount(value) {
  if (value == null || value === '' || typeof value === 'boolean') return null;
  const hops = Number(value);
  return Number.isInteger(hops) && hops >= 0 ? hops : null;
}

/**
 * Map a message ``scope`` to its chip label.
 *
 * @param {*} scope Raw ``scope`` field.
 * @returns {?string} The region name, ``"scoped"`` for the reserved unknown
 *   value, or ``null`` for an unscoped flood or an absent scope.
 */
export function routeScopeLabel(scope) {
  if (typeof scope !== 'string' || scope === '' || scope === SCOPE_UNSCOPED) {
    return null;
  }
  return scope === SCOPE_UNKNOWN ? SCOPE_UNKNOWN_LABEL : scope;
}

/**
 * Split a hop-hash route into its per-repeater hashes.
 *
 * The route is the repeater hashes concatenated in travel order; each hash is
 * ``path.length / 2 / hops`` bytes. A route that does not divide evenly, or
 * is not hex, is returned whole.
 *
 * @param {*} path Raw ``path`` field (lowercase hex).
 * @param {?number} hops Hop count of the same message.
 * @returns {Array<string>} Hashes in travel order; empty when absent.
 */
export function splitRoutePath(path, hops) {
  if (typeof path !== 'string' || path === '') return [];
  // Hex characters per hash; at least one byte, whole bytes only.
  const width = hops > 0 ? path.length / hops : 0;
  if (width < 2 || !Number.isInteger(width) || width % 2 !== 0 || !/^[0-9a-f]+$/i.test(path)) {
    return [path];
  }
  const hashes = [];
  for (let offset = 0; offset < path.length; offset += width) {
    hashes.push(path.slice(offset, offset + width));
  }
  return hashes;
}

/**
 * Format a signal value for the chip details.
 *
 * @param {*} value Raw ``snr``/``rssi`` field.
 * @returns {?string} The value with at most two decimals, or ``null``.
 */
function formatSignal(value) {
  if (value == null || value === '' || typeof value === 'boolean') return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return String(Math.round(num * 100) / 100);
}

/**
 * Describe a message's route for the chip's ``title`` and ``aria-label``:
 * the path hashes in travel order, then SNR and RSSI.
 *
 * @param {?Object} message Message payload.
 * @returns {string} Plain text such as ``"Path f0 → bf → 44 · SNR 10 dB ·
 *   RSSI -96 dBm"``; empty when the message carries none of them.
 */
export function formatRouteDetails(message) {
  if (!message || typeof message !== 'object') return '';
  const parts = [];
  const hashes = splitRoutePath(message.path, routeHopCount(message.hops));
  if (hashes.length > 0) parts.push(`Path ${hashes.join(' → ')}`);
  const snr = formatSignal(message.snr);
  if (snr != null) parts.push(`SNR ${snr} dB`);
  const rssi = formatSignal(message.rssi);
  if (rssi != null) parts.push(`RSSI ${rssi} dBm`);
  return parts.join(' · ');
}

/**
 * Render the route chip of a chat line, placed right after the sender badge
 * and outside the 19ch prefix (FU9).
 *
 * @param {?Object} message Message payload.
 * @returns {string} HTML for the chip with a leading space, or ``''`` when the
 *   message has no hop count. Every value is escaped.
 */
export function formatChatRouteChip(message) {
  const hops = routeHopCount(message?.hops);
  if (hops == null) return '';
  const label = routeScopeLabel(message.scope);
  const text = `${hops} ${hops === 1 ? 'hop' : 'hops'}${label ? ` · ${label}` : ''}`;
  const details = formatRouteDetails(message);
  // A labelled group announces the details and keeps the visible text
  // readable to assistive technology (unlike role="img").
  const attrs = details
    ? ` role="group" title="${escapeHtml(details)}" aria-label="${escapeHtml(details)}"`
    : '';
  return ` <span class="chat-route-chip"${attrs}>${escapeHtml(text)}</span>`;
}
