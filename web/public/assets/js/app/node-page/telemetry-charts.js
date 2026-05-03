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
 * Wrapper that renders the node-detail telemetry chart grid.
 *
 * @module node-page/telemetry-charts
 */

import {
  TELEMETRY_CHART_SPECS,
  TELEMETRY_WINDOW_MS,
  renderTelemetryChart,
  resolveSnapshotTimestamp,
} from '../node-page-charts.js';
import { stringOrNull } from '../value-helpers.js';

/**
 * Render the telemetry charts for the supplied node when telemetry snapshots
 * exist.
 *
 * @param {Object} node Normalised node payload.
 * @param {{ nowMs?: number, chartOptions?: Object }} [options] Rendering options.
 * @returns {string} Chart grid markup or an empty string.
 */
export function renderTelemetryCharts(node, { nowMs = Date.now(), chartOptions = {} } = {}) {
  const telemetrySource = node?.rawSources?.telemetry;
  const snapshotHistory = Array.isArray(node?.rawSources?.telemetrySnapshots) && node.rawSources.telemetrySnapshots.length > 0
    ? node.rawSources.telemetrySnapshots
    : null;
  const aggregatedSnapshots = Array.isArray(telemetrySource?.snapshots)
    ? telemetrySource.snapshots
    : null;
  const rawSnapshots = snapshotHistory ?? aggregatedSnapshots;
  if (!Array.isArray(rawSnapshots) || rawSnapshots.length === 0) {
    return '';
  }
  const entries = rawSnapshots
    .map(snapshot => {
      const timestamp = resolveSnapshotTimestamp(snapshot);
      if (timestamp == null) return null;
      return { timestamp, snapshot };
    })
    .filter(entry => entry != null && entry.timestamp >= nowMs - TELEMETRY_WINDOW_MS && entry.timestamp <= nowMs)
    .sort((a, b) => a.timestamp - b.timestamp);
  if (entries.length === 0) {
    return '';
  }
  const isAggregated = snapshotHistory == null && aggregatedSnapshots != null;
  const charts = TELEMETRY_CHART_SPECS
    .map(spec => renderTelemetryChart(spec, entries, nowMs, { ...chartOptions, isAggregated }))
    .filter(chart => stringOrNull(chart));
  if (charts.length === 0) {
    return '';
  }
  return `
    <section class="node-detail__charts">
      <div class="node-detail__charts-grid">
        ${charts.join('')}
      </div>
    </section>
  `;
}
