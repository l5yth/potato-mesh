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

const TELEMETRY_BUCKET_SECONDS = 60 * 60;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const CHART_WINDOW_MS = 7 * DAY_MS;

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

function buildMidnightTickList(nowMs, windowMs = CHART_WINDOW_MS) {
  const ticks = [];
  const safeWindow = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : CHART_WINDOW_MS;
  const domainStart = nowMs - safeWindow;
  const cursor = new Date(nowMs);
  cursor.setHours(0, 0, 0, 0);
  for (let ts = cursor.getTime(); ts >= domainStart; ts -= DAY_MS) {
    ticks.push(ts);
  }
  return ticks.reverse();
}

function formatDayOfMonthLabel(timestampMs) {
  const date = new Date(timestampMs);
  if (Number.isNaN(date.getTime())) return '';
  return padTwo(date.getDate());
}

function normalizeAggregatedSnapshot(bucket) {
  if (!bucket || typeof bucket !== 'object') {
    return null;
  }
  const timestamp =
    Number.isFinite(bucket.timestamp) ? bucket.timestamp
      : Number.isFinite(bucket.bucket_start) ? bucket.bucket_start
        : Number.isFinite(bucket.bucketStart) ? bucket.bucketStart
          : null;
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  const bucketSecondsCandidate =
    Number.isFinite(bucket.bucket_seconds) ? bucket.bucket_seconds
      : Number.isFinite(bucket.bucketSeconds) ? bucket.bucketSeconds
        : TELEMETRY_BUCKET_SECONDS;
  const bucketSeconds = bucketSecondsCandidate > 0 ? bucketSecondsCandidate : TELEMETRY_BUCKET_SECONDS;
  const timestampIso =
    typeof bucket.timestamp_iso === 'string' ? bucket.timestamp_iso
      : typeof bucket.timestampIso === 'string' ? bucket.timestampIso
        : typeof bucket.bucket_start_iso === 'string' ? bucket.bucket_start_iso
          : typeof bucket.bucketStartIso === 'string' ? bucket.bucketStartIso
            : null;
  const snapshot = {
    rx_time: Number.isFinite(bucket.rx_time) ? bucket.rx_time : timestamp,
    telemetry_time: Number.isFinite(bucket.telemetry_time) ? bucket.telemetry_time : timestamp,
    rx_iso: typeof bucket.rx_iso === 'string' ? bucket.rx_iso : timestampIso,
    telemetry_time_iso:
      typeof bucket.telemetry_time_iso === 'string'
        ? bucket.telemetry_time_iso
        : timestampIso,
    timestamp,
    timestampIso,
    bucket_seconds: bucketSeconds,
    bucket_start: Number.isFinite(bucket.bucket_start) ? bucket.bucket_start : timestamp,
    bucket_start_iso:
      typeof bucket.bucket_start_iso === 'string'
        ? bucket.bucket_start_iso
        : timestampIso,
    bucket_end: Number.isFinite(bucket.bucket_end) ? bucket.bucket_end : timestamp + bucketSeconds,
    bucket_end_iso: typeof bucket.bucket_end_iso === 'string' ? bucket.bucket_end_iso : null,
    sample_count:
      Number.isFinite(bucket.sample_count)
        ? bucket.sample_count
        : Number.isFinite(bucket.sampleCount)
          ? bucket.sampleCount
          : null,
  };
  const aggregates = bucket.aggregates && typeof bucket.aggregates === 'object' ? bucket.aggregates : null;
  if (aggregates) {
    snapshot.aggregates = aggregates;
    for (const [field, stats] of Object.entries(aggregates)) {
      if (!stats || typeof stats !== 'object') {
        continue;
      }
      const avg = Number.isFinite(stats.avg) ? stats.avg : null;
      const min = Number.isFinite(stats.min) ? stats.min : null;
      const max = Number.isFinite(stats.max) ? stats.max : null;
      if (avg != null) {
        snapshot[field] = avg;
        snapshot[`${field}_avg`] = avg;
      }
      if (min != null) {
        snapshot[`${field}_min`] = min;
      }
      if (max != null) {
        snapshot[`${field}_max`] = max;
      }
    }
  }
  if (!snapshot.bucket_end_iso && Number.isFinite(snapshot.bucket_end)) {
    snapshot.bucket_end_iso = new Date(snapshot.bucket_end * 1000).toISOString();
  }
  return snapshot;
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

export async function fetchAggregatedTelemetry({
  fetchImpl = globalThis.fetch,
  windowMs = CHART_WINDOW_MS,
  bucketSeconds = TELEMETRY_BUCKET_SECONDS,
} = {}) {
  const fetchFn = typeof fetchImpl === 'function' ? fetchImpl : null;
  if (!fetchFn) {
    throw new TypeError('A fetch implementation is required to load telemetry');
  }
  const windowSecondsCandidate =
    Number.isFinite(windowMs) ? Math.floor(windowMs / 1000) : Math.floor(CHART_WINDOW_MS / 1000);
  const windowSeconds = windowSecondsCandidate > 0 ? windowSecondsCandidate : Math.floor(CHART_WINDOW_MS / 1000);
  const bucketSecondsCandidate = Number.isFinite(bucketSeconds) ? Math.floor(bucketSeconds) : TELEMETRY_BUCKET_SECONDS;
  const bucketSecondsSafe = bucketSecondsCandidate > 0 ? bucketSecondsCandidate : TELEMETRY_BUCKET_SECONDS;
  const response = await fetchFn(
    `/api/telemetry/aggregated?windowSeconds=${windowSeconds}&bucketSeconds=${bucketSecondsSafe}`,
    { cache: 'no-store' },
  );
  if (!response.ok) {
    throw new Error(`Failed to fetch aggregated telemetry (HTTP ${response.status})`);
  }
  const payload = await response.json();
  if (!Array.isArray(payload)) {
    return [];
  }
  return payload
    .map(bucket => normalizeAggregatedSnapshot(bucket))
    .filter(snapshot => snapshot != null);
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
  const bucketSeconds = options.bucketSeconds ?? TELEMETRY_BUCKET_SECONDS;
  const windowMs = options.windowMs ?? CHART_WINDOW_MS;

  container.innerHTML = renderStatus('Loading aggregated telemetry charts…');

  try {
    const snapshots = await fetchAggregatedTelemetry({ fetchImpl, bucketSeconds, windowMs });
    if (!Array.isArray(snapshots) || snapshots.length === 0) {
      container.innerHTML = renderStatus('Telemetry snapshots are unavailable.');
      return true;
    }
    const node = { rawSources: { telemetry: { snapshots } } };
    const chartsHtml = renderCharts(node, {
      nowMs: Date.now(),
      chartOptions: {
        windowMs,
        timeRangeLabel: 'Last 7 days',
        xAxisTickBuilder: buildMidnightTickList,
        xAxisTickFormatter: formatDayOfMonthLabel,
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
