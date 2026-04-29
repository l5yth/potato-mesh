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
 * SVG renderers for telemetry series, axes, and full chart figures.
 *
 * @module node-page-charts/svg-renderers
 */

import { stringOrNull } from '../value-helpers.js';
import { escapeHtml } from '../utils.js';
import { TELEMETRY_WINDOW_MS } from './constants.js';
import {
  formatAxisTick,
  formatCompactDate,
  formatSeriesPointValue,
  hexToRgba,
} from './format-utils.js';
import { createChartDimensions, resolveAxisX, scaleTimestamp, scaleValueToAxis } from './layout.js';
import { buildLinearTicks, buildLogTicks, buildMidnightTicks } from './tick-builders.js';
import {
  buildSeriesPoints,
  classifySnapshot,
  resolveAxisMax,
} from './snapshot-data.js';

/**
 * Render a telemetry series as SVG circles with an optional translucent
 * guide line.
 *
 * An optional ``lineReducer`` can be supplied to down-sample the point set
 * used for the path (the full set is always used for circles).
 *
 * @param {Object} seriesConfig Series metadata.
 * @param {Array<{timestamp: number, value: number}>} points Series data points.
 * @param {Object} axis Axis descriptor.
 * @param {Object} dims Chart dimensions.
 * @param {number} domainStart Window start timestamp.
 * @param {number} domainEnd Window end timestamp.
 * @param {{ lineReducer?: Function }} [options] Optional rendering overrides.
 * @returns {string} SVG markup for the series.
 */
export function renderTelemetrySeries(seriesConfig, points, axis, dims, domainStart, domainEnd, { lineReducer } = {}) {
  if (!Array.isArray(points) || points.length === 0) {
    return '';
  }
  const convertPoint = point => {
    const cx = scaleTimestamp(point.timestamp, domainStart, domainEnd, dims);
    const cy = scaleValueToAxis(point.value, axis, dims);
    return { cx, cy, value: point.value };
  };
  // Build circle elements — one per data point.
  const circleEntries = points.map(point => {
    const coords = convertPoint(point);
    const tooltip = formatSeriesPointValue(seriesConfig, point.value);
    const titleMarkup = tooltip ? `<title>${escapeHtml(tooltip)}</title>` : '';
    return `<circle class="node-detail__chart-point" cx="${coords.cx.toFixed(2)}" cy="${coords.cy.toFixed(2)}" r="3.2" fill="${seriesConfig.color}" aria-hidden="true">${titleMarkup}</circle>`;
  });
  // Allow a custom reducer to thin the line path (e.g. LTTB).
  const lineSource = typeof lineReducer === 'function' ? lineReducer(points) : points;
  const linePoints = Array.isArray(lineSource) && lineSource.length > 0 ? lineSource : points;
  const coordinates = linePoints.map(convertPoint);
  let line = '';
  if (coordinates.length > 1) {
    // Build a straight-line interpolation between consecutive data points.
    // The path uses full opacity on the circles but 50% opacity on the trend
    // line so individual readings remain visually dominant over the guide.
    const path = coordinates
      .map((coord, idx) => `${idx === 0 ? 'M' : 'L'}${coord.cx.toFixed(2)} ${coord.cy.toFixed(2)}`)
      .join(' ');
    line = `<path class="node-detail__chart-trend" d="${path}" fill="none" stroke="${hexToRgba(seriesConfig.color, 0.5)}" stroke-width="1.5" aria-hidden="true"></path>`;
  }
  // Render the path before the circles so circles sit on top of the line.
  return `${line}${circleEntries.join('')}`;
}

/**
 * Render a vertical axis with tick marks and a rotated axis label.
 *
 * Returns an empty string when ``axis.visible === false``.
 *
 * @param {Object} axis Axis descriptor.
 * @param {Object} dims Chart dimensions.
 * @returns {string} SVG markup for the Y axis, or empty string.
 */
export function renderYAxis(axis, dims) {
  if (!axis || axis.visible === false) {
    return '';
  }
  const x = resolveAxisX(axis.position, dims);
  const ticks = axis.scale === 'log'
    ? buildLogTicks(axis.min, axis.max)
    : buildLinearTicks(axis.min, axis.max, axis.ticks);
  const tickElements = ticks
    .map(value => {
      const y = scaleValueToAxis(value, axis, dims);
      const tickLength = axis.position === 'left' || axis.position === 'leftSecondary' ? -4 : 4;
      const textAnchor = axis.position === 'left' || axis.position === 'leftSecondary' ? 'end' : 'start';
      const textOffset = axis.position === 'left' || axis.position === 'leftSecondary' ? -6 : 6;
      return `
        <g class="node-detail__chart-tick" aria-hidden="true">
          <line x1="${x}" y1="${y.toFixed(2)}" x2="${(x + tickLength).toFixed(2)}" y2="${y.toFixed(2)}"></line>
          <text x="${(x + textOffset).toFixed(2)}" y="${(y + 3).toFixed(2)}" text-anchor="${textAnchor}" dominant-baseline="middle">${escapeHtml(formatAxisTick(value, axis))}</text>
        </g>
      `;
    })
    .join('');
  const labelPadding = axis.position === 'left' || axis.position === 'leftSecondary' ? -56 : 56;
  const labelX = x + labelPadding;
  const labelY = (dims.chartTop + dims.chartBottom) / 2;
  const labelTransform = `rotate(-90 ${labelX.toFixed(2)} ${labelY.toFixed(2)})`;
  return `
    <g class="node-detail__chart-axis node-detail__chart-axis--y" aria-hidden="true">
      <line x1="${x}" y1="${dims.chartTop}" x2="${x}" y2="${dims.chartBottom}"></line>
      ${tickElements}
      <text class="node-detail__chart-axis-label" x="${labelX.toFixed(2)}" y="${labelY.toFixed(2)}" text-anchor="middle" dominant-baseline="middle" transform="${labelTransform}">${escapeHtml(axis.label)}</text>
    </g>
  `;
}

/**
 * Render the horizontal time axis with grid lines and date tick labels.
 *
 * @param {Object} dims Chart dimensions.
 * @param {number} domainStart Window start timestamp in milliseconds.
 * @param {number} domainEnd Window end timestamp in milliseconds.
 * @param {Array<number>} tickTimestamps Tick timestamps to label.
 * @param {{ labelFormatter?: Function }} [options] Optional tick label override.
 * @returns {string} SVG markup for the X axis.
 */
export function renderXAxis(dims, domainStart, domainEnd, tickTimestamps, { labelFormatter = formatCompactDate } = {}) {
  const y = dims.chartBottom;
  const ticks = tickTimestamps
    .map(ts => {
      const x = scaleTimestamp(ts, domainStart, domainEnd, dims);
      const labelY = y + 18;
      const xStr = x.toFixed(2);
      const yStr = labelY.toFixed(2);
      const label = labelFormatter(ts);
      return `
        <g class="node-detail__chart-tick" aria-hidden="true">
          <line class="node-detail__chart-grid-line" x1="${xStr}" y1="${dims.chartTop}" x2="${xStr}" y2="${dims.chartBottom}"></line>
          <text x="${xStr}" y="${yStr}" text-anchor="end" dominant-baseline="central" transform="rotate(-90 ${xStr} ${yStr})">${escapeHtml(label)}</text>
        </g>
      `;
    })
    .join('');
  return `
    <g class="node-detail__chart-axis node-detail__chart-axis--x" aria-hidden="true">
      <line x1="${dims.margin.left}" y1="${y}" x2="${dims.width - dims.margin.right}" y2="${y}"></line>
      ${ticks}
    </g>
  `;
}

/**
 * Render a single telemetry chart defined by ``spec``.
 *
 * Returns an empty string when no series data falls within the time window.
 * Supports an optional ``chartOptions`` bag for custom window sizes, tick
 * builders, tick formatters, line reducers, and aggregation flags.
 *
 * @param {Object} spec Chart specification from {@link TELEMETRY_CHART_SPECS}.
 * @param {Array<{timestamp: number, snapshot: Object}>} entries Telemetry entries.
 * @param {number} nowMs Reference timestamp in milliseconds.
 * @param {Object} [chartOptions] Optional rendering overrides.
 * @returns {string} Rendered chart HTML/SVG markup or empty string.
 */
export function renderTelemetryChart(spec, entries, nowMs, chartOptions = {}) {
  const windowMs = Number.isFinite(chartOptions.windowMs) && chartOptions.windowMs > 0 ? chartOptions.windowMs : TELEMETRY_WINDOW_MS;
  const timeRangeLabel = stringOrNull(chartOptions.timeRangeLabel) ?? 'Last 7 days';
  const domainEnd = nowMs;
  const domainStart = nowMs - windowMs;
  // When not in aggregated mode, filter entries by the chart's typeFilter.
  const effectiveEntries = Array.isArray(spec.typeFilter) && !chartOptions.isAggregated
    ? entries.filter(e => spec.typeFilter.includes(classifySnapshot(e.snapshot)))
    : entries;
  const dims = createChartDimensions(spec);
  const seriesEntries = spec.series
    .map(series => {
      const points = buildSeriesPoints(effectiveEntries, series.fields, domainStart, domainEnd);
      if (points.length === 0) return null;
      return { config: series, axisId: series.axis, points };
    })
    .filter(entry => entry != null);
  if (seriesEntries.length === 0) {
    return '';
  }
  // Apply allowUpperOverflow adjustments to each axis.
  const adjustedAxes = spec.axes.map(axis => {
    const resolvedMax = resolveAxisMax(axis, seriesEntries);
    if (resolvedMax != null && resolvedMax !== axis.max) {
      return { ...axis, max: resolvedMax };
    }
    return axis;
  });
  const axisMap = new Map(adjustedAxes.map(axis => [axis.id, axis]));
  const plottedSeries = seriesEntries
    .map(series => {
      const axis = axisMap.get(series.axisId);
      if (!axis) return null;
      return { config: series.config, axis, points: series.points };
    })
    .filter(entry => entry != null);
  if (plottedSeries.length === 0) {
    return '';
  }
  const axesMarkup = adjustedAxes.map(axis => renderYAxis(axis, dims)).join('');
  // Allow caller to supply a custom tick builder (e.g. hourly ticks for short windows).
  const tickBuilder = typeof chartOptions.xAxisTickBuilder === 'function' ? chartOptions.xAxisTickBuilder : buildMidnightTicks;
  const tickFormatter = typeof chartOptions.xAxisTickFormatter === 'function' ? chartOptions.xAxisTickFormatter : formatCompactDate;
  const ticks = tickBuilder(nowMs, windowMs);
  const xAxisMarkup = renderXAxis(dims, domainStart, domainEnd, ticks, { labelFormatter: tickFormatter });

  const seriesMarkup = plottedSeries
    .map(series =>
      renderTelemetrySeries(series.config, series.points, series.axis, dims, domainStart, domainEnd, {
        lineReducer: chartOptions.lineReducer,
      }),
    )
    .join('');
  const legendItems = plottedSeries
    .map(series => {
      const legendLabel = stringOrNull(series.config.legend) ?? series.config.label;
      return `
        <span class="node-detail__chart-legend-item">
          <span class="node-detail__chart-legend-swatch" style="background:${series.config.color}"></span>
          <span class="node-detail__chart-legend-text">${escapeHtml(legendLabel)}</span>
        </span>
      `;
    })
    .join('');
  const legendMarkup = legendItems
    ? `<div class="node-detail__chart-legend" aria-hidden="true">${legendItems}</div>`
    : '';
  return `
    <figure class="node-detail__chart">
      <figcaption class="node-detail__chart-header">
        <h4>${escapeHtml(spec.title)}</h4>
        <span>${escapeHtml(timeRangeLabel)}</span>
      </figcaption>
      <svg viewBox="0 0 ${dims.width} ${dims.height}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${escapeHtml(`${spec.title} over last seven days`)}">
        ${axesMarkup}
        ${xAxisMarkup}
        ${seriesMarkup}
      </svg>
      ${legendMarkup}
    </figure>
  `;
}
