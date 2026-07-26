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
 * "Mesh activity" map-overlay card (SPEC MA-F1…MA-F6).
 *
 * Renders the mesh-wide packets/hour rate — the total and its per-protocol
 * split — as a small card pinned to the map's bottom-left corner (mirroring the
 * roles legend bottom-right). The figures come from ``/api/stats``'s
 * ``<scope>.packets.hour`` metric (parsed by {@link module:stats}); this module
 * only turns a ``{total, meshcore, meshtastic}`` rate bag plus the current
 * hidden-protocol set into DOM.
 *
 * Behaviour:
 * - ``reticulum`` is never rendered — only ``meshtastic`` and ``meshcore`` have
 *   rows (MA-F2).
 * - The card hides entirely when the visible total is 0, or when the payload
 *   carries no packet rates (MA-F3).
 * - A protocol hidden via the meta-row toggle (``hiddenProtocols``) drops its
 *   row and rebases the displayed total to the sum of the *visible* protocols,
 *   identically for both protocols (MA-F4, Invariant IV parity).
 * - The 24-hour sparkline is an explicit **placeholder** (a deterministic
 *   illustrative curve carrying ``data-placeholder="true"``), pending the
 *   ``ingestor_activity`` time-series endpoint (SPEC MA-F5 / follow-up F2). It
 *   never claims to be live history.
 *
 * @module map-activity-card
 */

import { MESHTASTIC_ICON_SRC, MESHCORE_ICON_SRC } from './protocol-helpers.js';

/**
 * Protocols rendered as rows, in display order (Meshtastic above MeshCore).
 * ``reticulum`` is deliberately absent — it is a forward-looking zero stub and
 * is never shown (SPEC MA-F2 / S6).
 *
 * @type {ReadonlyArray<{protocol: string, label: string, iconSrc: string}>}
 */
const PROTOCOL_ROWS = Object.freeze([
  Object.freeze({ protocol: 'meshtastic', label: 'Meshtastic', iconSrc: MESHTASTIC_ICON_SRC }),
  Object.freeze({ protocol: 'meshcore', label: 'MeshCore', iconSrc: MESHCORE_ICON_SRC }),
]);

/**
 * Normalised daily activity curve (24 samples, 0..1) for the placeholder
 * sparkline. A fixed array keeps the rendered path deterministic — this is
 * illustrative chrome, not data (SPEC MA-F5).
 *
 * @type {ReadonlyArray<number>}
 */
const PLACEHOLDER_SERIES = Object.freeze([
  0.34, 0.3, 0.27, 0.25, 0.29, 0.4, 0.55, 0.63, 0.7, 0.67, 0.73, 0.81, 0.86,
  0.78, 0.74, 0.83, 0.9, 0.85, 0.69, 0.59, 0.52, 0.47, 0.41, 0.37,
]);

/**
 * Round a number to two decimals for compact, stable SVG path output.
 *
 * @param {number} value Raw coordinate.
 * @returns {number} Value rounded to 2 decimal places.
 */
function round2(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Build the placeholder sparkline path strings from {@link PLACEHOLDER_SERIES}.
 *
 * The paths map the fixed series across a ``0 0 158 26`` viewBox (1 px inset on
 * the left, 2 px top / 24 px bottom band). Deterministic, so unit tests can
 * assert the exact output.
 *
 * @returns {{line: string, area: string}} The open line path and the closed
 *   area path (line + baseline) for the two ``<path>`` elements.
 */
export function placeholderSparklinePaths() {
  const width = 156;
  const left = 1;
  const top = 2;
  const bottom = 24;
  const last = PLACEHOLDER_SERIES.length - 1;
  const points = PLACEHOLDER_SERIES.map((value, index) => {
    const x = round2(left + (index * width) / last);
    const y = round2(bottom - value * (bottom - top));
    return { x, y };
  });
  const line = points
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x} ${point.y}`)
    .join(' ');
  const area = `${line} L157 26 L1 26 Z`;
  return { line, area };
}

/**
 * Coerce a candidate packets/hour rate to a non-negative integer, or null.
 *
 * @param {*} value Candidate rate.
 * @returns {number|null} Truncated non-negative rate, or null when unusable.
 */
function coerceRate(value) {
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate < 0) return null;
  return Math.trunc(rate);
}

/**
 * Derive the render model from the packet rates and the hidden-protocol set.
 *
 * Only ``meshtastic``/``meshcore`` are considered (reticulum is never shown);
 * a protocol that is hidden or carries no finite rate is dropped. The displayed
 * total is the **sum of the visible protocol rates** (so a toggled-off protocol
 * rebases it, MA-F4), and each row's bar is sized relative to the busiest
 * visible protocol. The card is visible only when at least one protocol row
 * survives and the total is greater than 0 (MA-F3).
 *
 * @param {?{total?: number, meshcore?: number, meshtastic?: number}} packets
 *   Per-scope packets/hour rates from ``/api/stats`` (``stats.packets``).
 * @param {?Set<string>} hiddenProtocols Protocols the user has toggled off.
 * @returns {{visible: boolean, total: number, rows: Array<{label: string, iconSrc: string, rate: number, barPct: number}>}}
 *   The render model.
 */
export function buildMeshActivityModel(packets, hiddenProtocols) {
  const hidden = hiddenProtocols instanceof Set ? hiddenProtocols : new Set();
  const rates = packets && typeof packets === 'object' ? packets : {};
  const visible = [];
  for (const entry of PROTOCOL_ROWS) {
    if (hidden.has(entry.protocol)) continue;
    const rate = coerceRate(rates[entry.protocol]);
    if (rate === null) continue;
    visible.push({ label: entry.label, iconSrc: entry.iconSrc, rate });
  }
  const total = visible.reduce((sum, row) => sum + row.rate, 0);
  const maxRate = visible.reduce((max, row) => Math.max(max, row.rate), 0);
  const rows = visible.map(row => ({
    ...row,
    barPct: maxRate > 0 ? Math.round((row.rate / maxRate) * 100) : 0,
  }));
  return { visible: rows.length > 0 && total > 0, total, rows };
}

/**
 * Render the card interior to an HTML string from a model.
 *
 * Every interpolated value is a static label, a constant icon URL, or a
 * number-coerced rate/percentage, so the markup needs no escaping (mirrors the
 * ``formatActiveNodeStatsHtml`` convention in {@link module:stats}).
 *
 * @param {{total: number, rows: Array<{label: string, iconSrc: string, rate: number, barPct: number}>}} model
 *   Render model from {@link buildMeshActivityModel}.
 * @returns {string} Inner HTML for the card element.
 */
export function renderMeshActivityCardHtml(model) {
  const rowsHtml = model.rows
    .map(row =>
      '<div class="map-activity-card__row">' +
        `<img class="map-activity-card__row-icon" src="${row.iconSrc}" alt="" width="12" height="12" aria-hidden="true" />` +
        `<span class="map-activity-card__row-name">${row.label}</span>` +
        '<span class="map-activity-card__row-bar">' +
          `<span class="map-activity-card__row-bar-fill" style="width:${row.barPct}%"></span>` +
        '</span>' +
        `<span class="map-activity-card__row-rate">${row.rate}</span>` +
      '</div>'
    )
    .join('');
  const spark = placeholderSparklinePaths();
  return (
    '<div class="map-activity-card__header">' +
      '<span class="map-activity-card__pulse" aria-hidden="true"></span>' +
      '<span class="map-activity-card__title">Mesh activity</span>' +
    '</div>' +
    '<div class="map-activity-card__total">' +
      `<span class="map-activity-card__total-value">${model.total}</span>` +
      '<span class="map-activity-card__total-unit">packets/h</span>' +
    '</div>' +
    '<svg class="map-activity-card__spark" data-placeholder="true" viewBox="0 0 158 26" ' +
      'width="158" height="26" aria-hidden="true" focusable="false">' +
      `<path class="map-activity-card__spark-area" d="${spark.area}"></path>` +
      `<path class="map-activity-card__spark-line" d="${spark.line}" fill="none"></path>` +
    '</svg>' +
    `<div class="map-activity-card__rows">${rowsHtml}</div>`
  );
}

/**
 * Create the Mesh-activity card controller.
 *
 * Builds the root ``.map-activity-card`` element once and returns a
 * {@link render} closure that updates it in place. The caller mounts
 * {@link MeshActivityCard#element} (e.g. inside a Leaflet ``bottomleft``
 * control) and calls {@link MeshActivityCard#render} whenever fresh stats or a
 * protocol-toggle change arrives.
 *
 * @param {Document} [doc] DOM document (defaults to the global ``document``).
 * @returns {{element: HTMLElement, render: (data: {packets: ?Object, hiddenProtocols: ?Set<string>}) => boolean}}
 *   The card controller. ``render`` returns whether the card is visible.
 */
export function createMeshActivityCard(doc = globalThis.document) {
  if (!doc || typeof doc.createElement !== 'function') {
    throw new Error('createMeshActivityCard requires a document');
  }
  const element = doc.createElement('div');
  element.classList.add('map-activity-card');

  /**
   * Toggle the card's hidden state (class + ``hidden``/``aria-hidden``).
   *
   * @param {boolean} hidden Whether the card should be hidden.
   * @returns {void}
   */
  function setHidden(hidden) {
    if (hidden) {
      element.classList.add('map-activity-card--hidden');
      element.setAttribute('hidden', 'hidden');
      element.setAttribute('aria-hidden', 'true');
    } else {
      element.classList.remove('map-activity-card--hidden');
      element.removeAttribute('hidden');
      element.removeAttribute('aria-hidden');
    }
  }

  setHidden(true);

  /**
   * Update the card from the latest packet rates and hidden-protocol set.
   *
   * @param {{packets: ?Object, hiddenProtocols: ?Set<string>}} [data] Render input.
   * @returns {boolean} Whether the card is visible after the update.
   */
  function render(data = {}) {
    const model = buildMeshActivityModel(data.packets, data.hiddenProtocols);
    if (!model.visible) {
      element.innerHTML = '';
      setHidden(true);
      return false;
    }
    element.setAttribute('aria-label', `Mesh activity: ${model.total} packets per hour`);
    element.innerHTML = renderMeshActivityCardHtml(model);
    setHidden(false);
    return true;
  }

  return { element, render };
}
