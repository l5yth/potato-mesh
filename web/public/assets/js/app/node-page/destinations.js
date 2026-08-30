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
 * Destinations section and identity summary for the node page (SPEC RA5).
 *
 * `/nodes/:id` is the identity page: one identity, its destinations listed in
 * full.  This is the **only** place the complete 32-hex destination hashes are
 * shown, because they are what a reader needs to actually message the peer —
 * everywhere else a truncated `!xxxxxxxx` identifies the row.
 *
 * The identity's own hash and interface are read from the destination rows
 * rather than the node: `/api/nodes` deliberately does not serve
 * `identity_hash` (CONTRACTS), so `/api/destinations` is the one source, and
 * deriving both here keeps the page read-side.
 *
 * @module node-page/destinations
 */

import { escapeHtml } from '../utils.js';
import { EMPTY_CELL_HTML } from '../main/table-cell-format.js';
import { formatRelativeSeconds } from '../node-page-charts.js';
import { sortDestinations, aspectLabel } from '../main/identity-groups.js';

/**
 * Render an em-dash for an absent value, matching the sheet's voice.
 *
 * @param {*} value Candidate display value.
 * @returns {string} Escaped value, or the muted dash.
 */
function cell(value) {
  const text = value == null ? '' : String(value).trim();
  // `.cell-empty` is the repo's muted-dash class; `.muted` is only a custom
  // property (--muted) and matches no selector, so those dashes rendered at
  // full foreground weight.
  return text ? escapeHtml(text) : EMPTY_CELL_HTML;
}

/**
 * Summarise the identity behind a set of destinations (SPEC RA5).
 *
 * Every destination of one identity carries the same `identity_hash`, so the
 * first usable one identifies the peer.  The interface is the first a
 * destination reports: a stack can in principle hear one identity over several,
 * and naming one is more useful than naming none, so ties are not agonised over.
 *
 * @param {Array<Object>} destinations Destination rows for one identity.
 * @returns {{identityHash: ?string, count: number, interface: ?string}}
 *   Identity summary; `count` is 0 and the rest `null` when there is nothing.
 */
export function identitySummary(destinations) {
  const rows = Array.isArray(destinations) ? destinations : [];
  let identityHash = null;
  let iface = null;
  for (const row of rows) {
    if (!identityHash && typeof row?.identity_hash === 'string' && row.identity_hash.trim()) {
      identityHash = row.identity_hash.trim();
    }
    if (!iface && typeof row?.interface === 'string' && row.interface.trim()) {
      iface = row.interface.trim();
    }
  }
  return { identityHash, count: rows.length, interface: iface };
}

/**
 * Render the node page's Destinations section.
 *
 * Returns `''` for an empty set so the section is simply absent — the same
 * contract every other node-page section follows, and what keeps this invisible
 * for Meshtastic and Meshcore nodes (Invariant IV).
 *
 * Rows are ordered by aspect precedence (SPEC RE10), so the aspect that named
 * the identity leads, matching the chip order the nodes table shows.
 *
 * @param {Array<Object>} destinations Destination rows from
 *   `GET /api/destinations?node_id=`.
 * @param {{ nowSeconds?: number }} [options] Clock override (tests).
 * @returns {string} HTML fragment, or `''` when there is nothing to show.
 */
export function renderDestinationsSection(destinations, { nowSeconds = Date.now() / 1000 } = {}) {
  const rows = sortDestinations(destinations);
  if (rows.length === 0) return '';
  const body = rows.map(row => {
    const label = aspectLabel(row?.aspect);
    const id = typeof row?.id === 'string' ? row.id.trim() : '';
    // The anchor a destination link targets, so arriving from a sub-row lands
    // on the row it names rather than the top of the table.
    const anchor = id ? ` id="dest-${escapeHtml(id.slice(0, 8))}"` : '';
    return (
      `<tr${anchor}>` +
      `<td class="destinations__aspect">${label ? escapeHtml(label) : EMPTY_CELL_HTML}</td>` +
      // The full hash, deliberately: this is the one view that shows it.
      // The full hash links to its own /nodes/!<short>, which canonicalises
      // back to this page and lands on this row's anchor (SPEC RL5).
      `<td class="destinations__id mono">${
        id
          ? `<a href="/nodes/!${escapeHtml(id.slice(0, 8))}">${escapeHtml(id)}</a>`
          : EMPTY_CELL_HTML
      }</td>` +
      `<td class="destinations__name">${cell(row?.name)}</td>` +
      `<td class="destinations__role">${cell(row?.role)}</td>` +
      `<td class="destinations__interface">${cell(row?.interface)}</td>` +
      `<td class="destinations__first num">${cell(formatRelativeSeconds(row?.first_heard, nowSeconds))}</td>` +
      `<td class="destinations__last num">${cell(formatRelativeSeconds(row?.last_heard, nowSeconds))}</td>` +
      '</tr>'
    );
  }).join('');
  return (
    '<section class="node-detail__section node-detail__destinations">' +
    '<h3>Destinations</h3>' +
    '<table class="destinations"><thead><tr>' +
    '<th>Aspect</th><th>Destination</th><th>Name</th><th>Role</th>' +
    '<th>Interface</th><th>First Heard</th><th>Last Heard</th>' +
    '</tr></thead><tbody>' + body + '</tbody></table>' +
    '</section>'
  );
}
