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

import { renderTelemetryCharts } from './node-page.js';

const TELEMETRY_AGGREGATE_LIMIT = 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderStatus(message, { error = false } = {}) {
  const errorClass = error ? ' charts-page__status--error' : '';
  return `<p class="charts-page__status${errorClass}">${escapeHtml(message)}</p>`;
}

function padTwo(value) {
  const num = Number(value);
  if (Number.isNaN(num)) return '00';
  return num < 10 ? `0${Math.trunc(num)}` : String(Math.trunc(num));
}

function buildHourlyTickList(nowMs, windowMs = DAY_MS) {
  const ticks = [];
  const safeWindow = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : DAY_MS;
  const domainStart = nowMs - safeWindow;
  const cursor = new Date(nowMs);
  cursor.setMinutes(0, 0, 0);
  for (let ts = cursor.getTime(); ts >= domainStart; ts -= HOUR_MS) {
    ticks.push(ts);
  }
  return ticks.reverse();
}

function formatHourLabel(timestampMs) {
  const date = new Date(timestampMs);
  if (Number.isNaN(date.getTime())) return '';
  return padTwo(date.getHours());
}

export function buildMovingAverageSeries(points, windowMs = HOUR_MS) {
  if (!Array.isArray(points) || points.length === 0) {
    return [];
  }
  const safeWindow = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : HOUR_MS;
  const window = [];
  let sum = 0;
  const averages = [];
  for (const point of points) {
    if (!point || typeof point.timestamp !== 'number' || typeof point.value !== 'number') {
      continue;
    }
    window.push(point);
    sum += point.value;
    while (window.length && point.timestamp - window[0].timestamp > safeWindow) {
      const removed = window.shift();
      sum -= removed.value;
    }
    if (window.length > 0) {
      averages.push({
        timestamp: point.timestamp,
        value: sum / window.length,
      });
    }
  }
  return averages;
}

export async function fetchAggregatedTelemetry({ fetchImpl = globalThis.fetch, limit = TELEMETRY_AGGREGATE_LIMIT } = {}) {
  const fetchFn = typeof fetchImpl === 'function' ? fetchImpl : null;
  if (!fetchFn) {
    throw new TypeError('A fetch implementation is required to load telemetry');
  }
  const effectiveLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : TELEMETRY_AGGREGATE_LIMIT;
  const response = await fetchFn(`/api/telemetry?limit=${effectiveLimit}`, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Failed to fetch telemetry (HTTP ${response.status})`);
  }
  const payload = await response.json();
  return Array.isArray(payload) ? payload : [];
}

export async function initializeChartsPage(options = {}) {
  const documentRef = options.document ?? globalThis.document;
  if (!documentRef || typeof documentRef.getElementById !== 'function') {
    throw new TypeError('A document with getElementById support is required');
  }
  const rootId = options.rootId ?? 'chartsPage';
  const container = documentRef.getElementById(rootId);
  if (!container) {
    return false;
  }

  const renderCharts = typeof options.renderCharts === 'function' ? options.renderCharts : renderTelemetryCharts;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const limit = options.limit ?? TELEMETRY_AGGREGATE_LIMIT;

  container.innerHTML = renderStatus('Loading aggregated telemetry charts…');

  try {
    const snapshots = await fetchAggregatedTelemetry({ fetchImpl, limit });
    if (!Array.isArray(snapshots) || snapshots.length === 0) {
      container.innerHTML = renderStatus('Telemetry snapshots are unavailable.');
      return true;
    }
    const node = { rawSources: { telemetry: { snapshots } } };
    const chartsHtml = renderCharts(node, {
      nowMs: Date.now(),
      chartOptions: {
        windowMs: DAY_MS,
        timeRangeLabel: 'Last 24 hours',
        xAxisTickBuilder: buildHourlyTickList,
        xAxisTickFormatter: formatHourLabel,
        lineReducer: points => buildMovingAverageSeries(points, HOUR_MS),
      },
    });
    if (!chartsHtml) {
      container.innerHTML = renderStatus('Telemetry snapshots are unavailable.');
      return true;
    }
    container.innerHTML = chartsHtml;
    return true;
  } catch (error) {
    console.error('Failed to render aggregated telemetry charts', error);
    container.innerHTML = renderStatus('Failed to load telemetry charts.', { error: true });
    return false;
  }
}
