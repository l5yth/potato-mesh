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
 * Mesh-activity `/charts` figure (SPEC F2-5): packets/hour **per protocol** over
 * the last 7 days. Built with the shared telemetry-chart helpers so it matches
 * the surrounding chart chrome; `/charts` injects it between the
 * channel-utilization and environmental figures. Data comes from the
 * `/api/stats/activity` time-series (SPEC F2-1).
 *
 * @module mesh-activity-chart
 */

import { escapeHtml } from './utils.js';
import { createChartDimensions } from './node-page-charts/layout.js';
import {
  renderYAxis,
  renderXAxis,
  renderTelemetrySeries,
} from './node-page-charts/svg-renderers.js';
import { buildMidnightTicks } from './node-page-charts/tick-builders.js';

const ACTIVITY_CHART_WINDOW_SECONDS = 7 * 24 * 3600; // 7 days
const ACTIVITY_CHART_BUCKET_SECONDS = 2 * 3600; // 2-hour buckets
const ACTIVITY_CHART_WINDOW_MS = ACTIVITY_CHART_WINDOW_SECONDS * 1000;

/**
 * Per-protocol lines, in draw/legend order. Colours match the design (option
 * 1c): Meshtastic purple, MeshCore blue.
 *
 * @type {ReadonlyArray<{protocol: string, label: string, color: string}>}
 */
const ACTIVITY_CHART_LINES = Object.freeze([
  Object.freeze({ protocol: 'meshtastic', label: 'Meshtastic', color: '#8856a7' }),
  Object.freeze({ protocol: 'meshcore', label: 'MeshCore', color: '#3182bd' }),
]);

/**
 * Fetch the per-protocol activity buckets for the `/charts` figure (7 d / 2 h).
 * Fails soft to an empty array so the figure is simply omitted on any error.
 *
 * @param {{fetchImpl?: Function}} [params] Fetch parameters.
 * @returns {Promise<Array<Object>>} Ascending bucket objects, or `[]`.
 */
export async function fetchActivityChartBuckets({ fetchImpl = fetch } = {}) {
  try {
    const url =
      `/api/stats/activity?window_seconds=${ACTIVITY_CHART_WINDOW_SECONDS}` +
      `&bucket_seconds=${ACTIVITY_CHART_BUCKET_SECONDS}`;
    const response = await fetchImpl(url, { cache: 'default' });
    if (!response?.ok) {
      return [];
    }
    const payload = await response.json();
    return Array.isArray(payload) ? payload : [];
  } catch (error) {
    console.debug('Failed to fetch /api/stats/activity for /charts', error);
    return [];
  }
}

/**
 * Build a `{timestamp, value}` point list for one protocol from the buckets.
 *
 * @param {Array<Object>} buckets Bucket objects from the activity endpoint.
 * @param {string} protocol Protocol key (`meshtastic` / `meshcore`).
 * @returns {Array<{timestamp: number, value: number}>} Chart points (ms).
 */
function pointsForProtocol(buckets, protocol) {
  const points = [];
  for (const bucket of buckets) {
    const start = Number(bucket?.bucket_start);
    const value = Number(bucket?.[protocol]);
    if (Number.isFinite(start) && Number.isFinite(value)) {
      points.push({ timestamp: start * 1000, value: Math.max(0, value) });
    }
  }
  return points;
}

/**
 * Render the mesh-activity `/charts` figure (SPEC F2-5).
 *
 * @param {Array<Object>} buckets Per-protocol activity buckets (7 d / 2 h).
 * @param {number} [nowMs] Reference timestamp in milliseconds.
 * @returns {string} Figure markup, or an empty string when there is no data.
 */
export function renderMeshActivityChart(buckets, nowMs = Date.now()) {
  if (!Array.isArray(buckets) || buckets.length === 0) {
    return '';
  }
  const lines = ACTIVITY_CHART_LINES.map(line => ({
    ...line,
    points: pointsForProtocol(buckets, line.protocol),
  })).filter(line => line.points.length > 0);
  if (lines.length === 0) {
    return '';
  }

  const domainEnd = nowMs;
  const domainStart = nowMs - ACTIVITY_CHART_WINDOW_MS;
  const maxValue = lines.reduce(
    (peak, line) => line.points.reduce((max, point) => Math.max(max, point.value), peak),
    0
  );
  const dims = createChartDimensions({ axes: [{ position: 'left' }] });
  const axis = {
    position: 'left',
    scale: 'linear',
    min: 0,
    max: maxValue > 0 ? maxValue : 1,
    ticks: 5,
    label: 'Activity (pkt/h)',
    visible: true,
  };

  const yAxisMarkup = renderYAxis(axis, dims);
  const xAxisMarkup = renderXAxis(
    dims,
    domainStart,
    domainEnd,
    buildMidnightTicks(nowMs, ACTIVITY_CHART_WINDOW_MS)
  );
  const seriesMarkup = lines
    .map(line =>
      renderTelemetrySeries(
        { color: line.color, valueFormatter: value => `${value} pkt/h` },
        line.points,
        axis,
        dims,
        domainStart,
        domainEnd
      )
    )
    .join('');
  const legendMarkup = lines
    .map(line =>
      '<span class="node-detail__chart-legend-item">' +
        `<span class="node-detail__chart-legend-swatch" style="background:${line.color}"></span>` +
        `<span class="node-detail__chart-legend-text">${escapeHtml(line.label)}</span>` +
      '</span>'
    )
    .join('');
  return `
    <figure class="node-detail__chart">
      <figcaption class="node-detail__chart-header">
        <h4>Mesh activity</h4>
        <span>Last 7 days</span>
      </figcaption>
      <svg viewBox="0 0 ${dims.width} ${dims.height}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Mesh activity packets per hour per protocol over the last seven days">
        ${yAxisMarkup}
        ${xAxisMarkup}
        ${seriesMarkup}
      </svg>
      <div class="node-detail__chart-legend" aria-hidden="true">${legendMarkup}</div>
    </figure>
  `;
}
