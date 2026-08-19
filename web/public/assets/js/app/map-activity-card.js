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
 * "Mesh activity" map-overlay card (SPEC MA-F1…MA-F6, F2-4).
 *
 * Renders the mesh-wide packets/hour rate — the total and its per-protocol
 * split — as a small card pinned to the map's bottom-left corner (mirroring the
 * roles legend bottom-right). The live figures come from ``/api/stats``'s
 * ``<scope>.packets.hour`` metric; the 24-hour sparkline comes from the
 * ``/api/stats/activity`` time-series (SPEC F2). This module turns those two
 * inputs into DOM.
 *
 * Behaviour:
 * - ``meshtastic``, ``meshcore``, and ``reticulum`` each render a row
 *   (MA-F2, extended by #888 when the Reticulum ingestor went live).
 * - The card hides entirely when the visible total is 0 or the payload carries
 *   no packet rates (MA-F3).
 * - A protocol hidden via the meta-row toggle (``hiddenProtocols``) drops its
 *   row and rebases the displayed total to the sum of the *visible* protocols
 *   (MA-F4, Invariant IV parity).
 * - The sparkline is drawn from the real 24-hour ``total`` series when present
 *   (SPEC F2-4); when the series is absent or too short it is simply omitted —
 *   the card never falls back to a fake curve. The sparkline shows the overall
 *   total-activity trend and is not rebased by the protocol toggles.
 *
 * The controller is stateful: {@link MeshActivityCard#render} updates the live
 * rates and {@link MeshActivityCard#setSeries} updates the sparkline series
 * independently, each repainting from the last-known other.
 *
 * @module map-activity-card
 */

import { MESHTASTIC_ICON_SRC, MESHCORE_ICON_SRC, RETICULUM_ICON_SRC } from './protocol-helpers.js';

/**
 * Protocols rendered as rows, in display order (Meshtastic, MeshCore,
 * Reticulum).  ``reticulum`` went live with the Reticulum ingestor
 * (#888); it was a deliberately-hidden zero stub before that (SPEC
 * MA-F2 / S6).
 *
 * @type {ReadonlyArray<{protocol: string, label: string, iconSrc: string}>}
 */
const PROTOCOL_ROWS = Object.freeze([
  Object.freeze({ protocol: 'meshtastic', label: 'Meshtastic', iconSrc: MESHTASTIC_ICON_SRC }),
  Object.freeze({ protocol: 'meshcore', label: 'MeshCore', iconSrc: MESHCORE_ICON_SRC }),
  Object.freeze({ protocol: 'reticulum', label: 'Reticulum', iconSrc: RETICULUM_ICON_SRC }),
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
 * Build the sparkline path strings from a series of per-bucket totals.
 *
 * Maps the totals across a ``0 0 158 26`` viewBox (1 px left inset, 2 px top /
 * 24 px bottom band), scaled to the series maximum. Returns null when there are
 * fewer than two points (nothing to draw) so the caller omits the sparkline
 * rather than inventing one (SPEC F2-4).
 *
 * @param {?Array<number>} totals Per-bucket total packets/hour, oldest first.
 * @returns {{line: string, area: string}|null} The open line path and closed
 *   area path, or null when the series is unusable.
 */
export function sparklinePathsFromSeries(totals) {
  if (!Array.isArray(totals) || totals.length < 2) return null;
  const width = 156;
  const left = 1;
  const top = 2;
  const bottom = 24;
  // 15% headroom above the series max so the busiest hour's vertex sits below
  // the top edge and the 1.5px stroke is never clipped (F2 review).
  const max = totals.reduce((peak, value) => Math.max(peak, value), 0) * 1.15;
  const last = totals.length - 1;
  const points = totals.map((value, index) => {
    const x = round2(left + (index * width) / last);
    const norm = max > 0 ? value / max : 0;
    const y = round2(bottom - norm * (bottom - top));
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
 * Sum the **visible** protocols' packets/hour in each sparkline bucket, so the
 * curve rebases with the meta-row toggles exactly like the headline total does
 * (F2 review — otherwise the number and the curve measure different things once
 * a protocol is toggled off).
 *
 * @param {?Array<{meshcore?: number, meshtastic?: number}>} series Per-bucket
 *   per-protocol rates from ``/api/stats/activity``.
 * @param {Set<string>} hidden Protocols the user has toggled off.
 * @returns {Array<number>|null} Per-bucket visible totals, or null.
 */
function visibleSeriesTotals(series, hidden) {
  if (!Array.isArray(series)) return null;
  return series.map(bucket => {
    let sum = 0;
    for (const entry of PROTOCOL_ROWS) {
      if (hidden.has(entry.protocol)) continue;
      const value = Number(bucket?.[entry.protocol]);
      if (Number.isFinite(value) && value >= 0) sum += value;
    }
    return sum;
  });
}

/**
 * Derive the render model from the packet rates, hidden-protocol set, and the
 * sparkline series.
 *
 * Every {@link PROTOCOL_ROWS} protocol is considered; a
 * protocol that is hidden or carries no finite rate is dropped. The displayed
 * total is the sum of the visible protocol rates (so a toggled-off protocol
 * rebases it, MA-F4), and each row's bar is sized relative to the busiest
 * visible protocol. The card is visible only when at least one protocol row
 * survives and the total is greater than 0 (MA-F3). ``spark`` is the sparkline
 * paths over the **visible** protocols' per-bucket sum, or null when absent
 * (F2-4) — so the curve rebases with the toggles just like the total.
 *
 * @param {?{total?: number, meshcore?: number, meshtastic?: number}} packets
 *   Per-scope packets/hour rates from ``/api/stats`` (``stats.packets``).
 * @param {?Set<string>} hiddenProtocols Protocols the user has toggled off.
 * @param {?Array<{meshcore?: number, meshtastic?: number}>} series Per-bucket
 *   per-protocol packets/hour for the sparkline.
 * @returns {{visible: boolean, total: number, rows: Array<{label: string, iconSrc: string, rate: number, barPct: number}>, spark: ({line: string, area: string}|null)}}
 *   The render model.
 */
export function buildMeshActivityModel(packets, hiddenProtocols, series) {
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
  return {
    visible: rows.length > 0 && total > 0,
    total,
    rows,
    spark: sparklinePathsFromSeries(visibleSeriesTotals(series, hidden)),
  };
}

/**
 * Render the card interior to an HTML string from a model.
 *
 * Every interpolated value is a static label, a constant icon URL, or a
 * number-coerced rate/percentage/coordinate, so the markup needs no escaping
 * (mirrors the ``formatActiveNodeStatsHtml`` convention in {@link module:stats}).
 * The sparkline SVG is emitted only when ``model.spark`` is present (F2-4).
 *
 * @param {{total: number, rows: Array<{label: string, iconSrc: string, rate: number, barPct: number}>, spark: ({line: string, area: string}|null)}} model
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
  const sparkHtml = model.spark
    ? '<svg class="map-activity-card__spark" viewBox="0 0 158 26" width="158" height="26" ' +
        'aria-hidden="true" focusable="false">' +
        `<path class="map-activity-card__spark-area" d="${model.spark.area}"></path>` +
        `<path class="map-activity-card__spark-line" d="${model.spark.line}" fill="none"></path>` +
      '</svg>'
    : '';
  return (
    '<div class="map-activity-card__header">' +
      '<span class="map-activity-card__pulse" aria-hidden="true"></span>' +
      '<span class="map-activity-card__title">Mesh activity</span>' +
    '</div>' +
    '<div class="map-activity-card__total">' +
      `<span class="map-activity-card__total-value">${model.total}</span>` +
      '<span class="map-activity-card__total-unit">packets/h</span>' +
    '</div>' +
    sparkHtml +
    `<div class="map-activity-card__rows">${rowsHtml}</div>`
  );
}

/**
 * Create the Mesh-activity card controller.
 *
 * Builds the root ``.map-activity-card`` element once and returns a stateful
 * controller. {@link MeshActivityCard#render} updates the live rates (from
 * ``/api/stats``) and {@link MeshActivityCard#setSeries} updates the sparkline
 * series (from ``/api/stats/activity``); each repaints from the last-known
 * other, so the two data sources can arrive independently.
 *
 * @param {Document} [doc] DOM document (defaults to the global ``document``).
 * @returns {{element: HTMLElement, render: (data: {packets: ?Object, hiddenProtocols: ?Set<string>}) => boolean, setSeries: (series: ?Array<number>) => boolean}}
 *   The card controller. ``render``/``setSeries`` return whether the card is visible.
 */
export function createMeshActivityCard(doc = globalThis.document) {
  if (!doc || typeof doc.createElement !== 'function') {
    throw new Error('createMeshActivityCard requires a document');
  }
  const element = doc.createElement('div');
  element.classList.add('map-activity-card');
  // A labelled `group` so the aria-label is announced (a bare div's label is
  // not); children stay readable, unlike role="img" (F2 review).
  element.setAttribute('role', 'group');

  let lastPackets = null;
  let lastHidden = null;
  let lastSeries = null;

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
   * Repaint the card from the last-known rates and series.
   *
   * @returns {boolean} Whether the card is visible after the repaint.
   */
  function paint() {
    const model = buildMeshActivityModel(lastPackets, lastHidden, lastSeries);
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

  /**
   * Update the live packet rates and hidden-protocol set, then repaint.
   *
   * @param {{packets: ?Object, hiddenProtocols: ?Set<string>}} [data] Render input.
   * @returns {boolean} Whether the card is visible after the update.
   */
  function render(data = {}) {
    lastPackets = data.packets;
    lastHidden = data.hiddenProtocols;
    return paint();
  }

  /**
   * Update the sparkline total series, then repaint.
   *
   * @param {?Array<number>} series Per-bucket total packets/hour (oldest first).
   * @returns {boolean} Whether the card is visible after the update.
   */
  function setSeries(series) {
    lastSeries = series;
    return paint();
  }

  return { element, render, setSeries };
}
