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

const SVG_NS = 'http://www.w3.org/2000/svg';

/** @type {number} */
export const SEVEN_DAYS_SECONDS = 7 * 24 * 3600;

/**
 * Determine whether a value can be converted into a finite number.
 *
 * @param {*} value Raw candidate value.
 * @returns {number|null} Parsed finite number or null when conversion fails.
 */
export function toFiniteNumber(value) {
  if (value == null || value === '') {
    return null;
  }
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/**
 * Resolve the best-effort timestamp for a telemetry entry.
 *
 * @param {Record<string, *>} entry Telemetry payload.
 * @returns {number|null} Timestamp in seconds or null when not available.
 */
export function parseTimestampSeconds(entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  const rxTime = toFiniteNumber(entry.rx_time ?? entry.rxTime);
  if (rxTime != null) {
    return rxTime;
  }
  const telemetryTime = toFiniteNumber(entry.telemetry_time ?? entry.telemetryTime);
  if (telemetryTime != null) {
    return telemetryTime;
  }
  const isoValue = entry.rx_iso ?? entry.rxIso ?? entry.telemetry_time_iso ?? entry.telemetryTimeIso;
  if (typeof isoValue === 'string' && isoValue.length > 0) {
    const parsed = Date.parse(isoValue);
    if (Number.isFinite(parsed)) {
      return Math.floor(parsed / 1000);
    }
  }
  return null;
}

/**
 * Extract a telemetry metric using the provided property names.
 *
 * @param {Record<string, *>} entry Telemetry payload.
 * @param {Array<string>} fields Candidate property keys.
 * @returns {number|null} Numeric value or null when not found.
 */
export function extractMetricValue(entry, fields) {
  if (!entry || typeof entry !== 'object' || !Array.isArray(fields)) {
    return null;
  }
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(entry, field)) {
      const value = toFiniteNumber(entry[field]);
      if (value != null) {
        return value;
      }
    }
  }
  return null;
}

/**
 * Build a sorted series of telemetry samples for a metric.
 *
 * @param {Array<Record<string, *>>} entries Telemetry dataset.
 * @param {{ id: string, fields: Array<string> }} metric Metric definition.
 * @param {{ minTimestampSec: number, maxTimestampSec: number }} window Time window bounds.
 * @returns {Array<{ timestamp: number, value: number }>} Sorted samples.
 */
export function buildMetricSeries(entries, metric, window) {
  if (!Array.isArray(entries) || !metric || !Array.isArray(metric.fields)) {
    return [];
  }
  const minTs = toFiniteNumber(window?.minTimestampSec);
  const maxTs = toFiniteNumber(window?.maxTimestampSec);
  const samples = [];
  for (const entry of entries) {
    const timestamp = parseTimestampSeconds(entry);
    if (timestamp == null) {
      continue;
    }
    if (minTs != null && timestamp < minTs) {
      continue;
    }
    if (maxTs != null && timestamp > maxTs) {
      continue;
    }
    const value = extractMetricValue(entry, metric.fields);
    if (value == null) {
      continue;
    }
    samples.push({ timestamp, value });
  }
  samples.sort((a, b) => a.timestamp - b.timestamp);
  return samples;
}

/**
 * Compute the visual domain for an axis based on active series.
 *
 * @param {Array<{ metric: { axis: 'left' | 'right' }, points: Array<{ value: number }> }>} seriesList Series collection.
 * @param {{ defaultDomain?: [number, number], min?: number, max?: number, formatTick?: (value: number) => string }} axisConfig Axis configuration.
 * @param {'left'|'right'} axisName Axis identifier.
 * @returns {{ min: number, max: number }|null} Domain boundaries or null when unavailable.
 */
export function computeAxisDomain(seriesList, axisConfig, axisName) {
  if (!axisConfig) {
    return null;
  }
  const values = [];
  for (const series of seriesList) {
    if (!series || series.metric?.axis !== axisName) {
      continue;
    }
    for (const point of series.points || []) {
      if (point && typeof point.value === 'number' && Number.isFinite(point.value)) {
        values.push(point.value);
      }
    }
  }
  let minValue = values.length ? Math.min(...values) : null;
  let maxValue = values.length ? Math.max(...values) : null;
  if (Array.isArray(axisConfig.defaultDomain) && axisConfig.defaultDomain.length === 2) {
    const [defaultMin, defaultMax] = axisConfig.defaultDomain;
    if (minValue == null || defaultMin < minValue) {
      minValue = defaultMin;
    }
    if (maxValue == null || defaultMax > maxValue) {
      maxValue = defaultMax;
    }
  }
  if (axisConfig.min != null) {
    minValue = minValue == null ? axisConfig.min : Math.min(minValue, axisConfig.min);
  }
  if (axisConfig.max != null) {
    maxValue = maxValue == null ? axisConfig.max : Math.max(maxValue, axisConfig.max);
  }
  if (minValue == null || maxValue == null) {
    return null;
  }
  if (minValue === maxValue) {
    const delta = Math.abs(minValue) || 1;
    minValue -= delta * 0.1;
    maxValue += delta * 0.1;
  } else {
    const padding = Math.max((maxValue - minValue) * 0.05, 0.5);
    minValue -= padding;
    maxValue += padding;
  }
  return { min: minValue, max: maxValue };
}

/**
 * Create an SVG element within the current document namespace.
 *
 * @param {Document} document Owner document instance.
 * @param {string} tagName SVG element name.
 * @returns {SVGElement} Newly created element.
 */
function createSvgElement(document, tagName) {
  return document.createElementNS ? document.createElementNS(SVG_NS, tagName) : document.createElement(tagName);
}

/**
 * Locate a descendant element annotated with the provided data-role attribute.
 *
 * @param {Element|null} root Search root element.
 * @param {string} role Data role identifier.
 * @returns {Element|null} Matching element or null when absent.
 */
function findElementByDataRole(root, role) {
  if (!root || typeof role !== 'string' || !role.length) {
    return null;
  }
  const queue = [root];
  while (queue.length) {
    const node = queue.shift();
    if (!node) {
      continue;
    }
    if (typeof node.getAttribute === 'function') {
      const value = node.getAttribute('data-role');
      if (value === role) {
        return node;
      }
    }
    const children = node.children ? Array.from(node.children) : [];
    for (const child of children) {
      queue.push(child);
    }
  }
  return null;
}

/**
 * Generate a linear sequence of ticks covering the provided domain.
 *
 * @param {number} min Minimum domain value.
 * @param {number} max Maximum domain value.
 * @param {number} count Desired tick count.
 * @returns {Array<number>} Tick positions in ascending order.
 */
function generateLinearTicks(min, max, count) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || count <= 1) {
    return [min];
  }
  const span = max - min;
  if (span <= 0) {
    return [min];
  }
  const step = span / (count - 1);
  const ticks = [];
  for (let index = 0; index < count; index += 1) {
    ticks.push(min + step * index);
  }
  return ticks;
}

/**
 * Format a timestamp for display on the x-axis.
 *
 * @param {number} timestamp Timestamp in seconds.
 * @returns {string} Human friendly label.
 */
function formatTimeLabel(timestamp) {
  if (!Number.isFinite(timestamp)) {
    return '';
  }
  const date = new Date(timestamp * 1000);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${month}-${day} ${hours}:${minutes}`;
}

/**
 * Create a legend entry for the supplied metric definition.
 *
 * @param {Document} document Owner document instance.
 * @param {{ label: string, color: string }} metric Metric configuration.
 * @returns {HTMLElement} Legend list item element.
 */
function buildLegendItem(document, metric) {
  const item = document.createElement('li');
  item.setAttribute('class', 'nodes-chart__legend-item');
  const swatch = document.createElement('span');
  swatch.setAttribute('class', 'nodes-chart__legend-swatch');
  if (swatch.style && typeof swatch.style.setProperty === 'function') {
    swatch.style.setProperty('--legend-color', metric.color);
  } else {
    swatch.setAttribute('data-color', metric.color);
  }
  const label = document.createElement('span');
  label.textContent = metric.label;
  item.appendChild(swatch);
  item.appendChild(label);
  return item;
}

/**
 * Toggle the visibility of the plot and empty-state message.
 *
 * @param {Element|null} plot Plot container element.
 * @param {Element|null} empty Empty-state element.
 * @param {boolean} isEmpty Whether the chart lacks data.
 * @returns {void}
 */
function setEmptyState(plot, empty, isEmpty) {
  if (plot) {
    if (typeof plot.hidden === 'boolean') {
      plot.hidden = isEmpty;
    }
    if (typeof plot.setAttribute === 'function') {
      plot.setAttribute('aria-hidden', isEmpty ? 'true' : 'false');
    }
  }
  if (empty) {
    if (typeof empty.hidden === 'boolean') {
      empty.hidden = !isEmpty;
    }
    if (typeof empty.setAttribute === 'function') {
      empty.setAttribute('aria-hidden', isEmpty ? 'false' : 'true');
    }
  }
}

/**
 * Render the scatter chart using SVG primitives.
 *
 * @param {Document} document Owner document instance.
 * @param {SVGElement} svg Target SVG element.
 * @param {Array<{ metric: { axis: 'left'|'right', color: string }, points: Array<{ timestamp: number, value: number }> }>} seriesList Chart series collection.
 * @param {{ defaultDomain?: [number, number], min?: number, max?: number, formatTick?: (value: number) => string, label?: string }} leftAxis Left axis configuration.
 * @param {{ defaultDomain?: [number, number], min?: number, max?: number, formatTick?: (value: number) => string, label?: string }} rightAxis Right axis configuration.
 * @param {number} nowSec Reference timestamp in seconds.
 * @returns {void}
 */
function renderScatterPlot(document, svg, seriesList, leftAxis, rightAxis, nowSec) {
  svg.replaceChildren();
  const width = 800;
  const height = 320;
  const margin = { top: 24, right: 88, bottom: 48, left: 88 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('class', 'nodes-chart__svg');

  const windowStart = nowSec - SEVEN_DAYS_SECONDS;
  const xDomain = { min: windowStart, max: nowSec };
  const leftDomain = computeAxisDomain(seriesList, leftAxis, 'left');
  const rightDomain = computeAxisDomain(seriesList, rightAxis, 'right');

  const gridGroup = createSvgElement(document, 'g');
  gridGroup.setAttribute('class', 'nodes-chart__grid');
  const axesGroup = createSvgElement(document, 'g');
  axesGroup.setAttribute('class', 'nodes-chart__axes');
  const seriesGroup = createSvgElement(document, 'g');
  seriesGroup.setAttribute('class', 'nodes-chart__series');

  svg.appendChild(gridGroup);
  svg.appendChild(axesGroup);
  svg.appendChild(seriesGroup);

  const scaleX = value => {
    const span = xDomain.max - xDomain.min || 1;
    return margin.left + ((value - xDomain.min) / span) * innerWidth;
  };
  const scaleYLeft = value => {
    if (!leftDomain) {
      return margin.top + innerHeight;
    }
    const span = leftDomain.max - leftDomain.min || 1;
    return margin.top + innerHeight - ((value - leftDomain.min) / span) * innerHeight;
  };
  const scaleYRight = value => {
    if (!rightDomain) {
      return margin.top + innerHeight;
    }
    const span = rightDomain.max - rightDomain.min || 1;
    return margin.top + innerHeight - ((value - rightDomain.min) / span) * innerHeight;
  };

  const axisBottom = margin.top + innerHeight;
  const xAxisLine = createSvgElement(document, 'line');
  xAxisLine.setAttribute('x1', String(margin.left));
  xAxisLine.setAttribute('x2', String(margin.left + innerWidth));
  xAxisLine.setAttribute('y1', String(axisBottom));
  xAxisLine.setAttribute('y2', String(axisBottom));
  axesGroup.appendChild(xAxisLine);

  const xTicks = generateLinearTicks(xDomain.min, xDomain.max, 6);
  for (const tick of xTicks) {
    const x = scaleX(tick);
    const tickLine = createSvgElement(document, 'line');
    tickLine.setAttribute('x1', String(x));
    tickLine.setAttribute('x2', String(x));
    tickLine.setAttribute('y1', String(axisBottom));
    tickLine.setAttribute('y2', String(axisBottom + 8));
    axesGroup.appendChild(tickLine);

    const label = createSvgElement(document, 'text');
    label.setAttribute('class', 'nodes-chart__tick-label nodes-chart__tick-label--x');
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('x', String(x));
    label.setAttribute('y', String(axisBottom + 22));
    label.textContent = formatTimeLabel(tick);
    axesGroup.appendChild(label);
  }

  if (leftDomain) {
    const leftAxisLine = createSvgElement(document, 'line');
    leftAxisLine.setAttribute('x1', String(margin.left));
    leftAxisLine.setAttribute('x2', String(margin.left));
    leftAxisLine.setAttribute('y1', String(margin.top));
    leftAxisLine.setAttribute('y2', String(axisBottom));
    axesGroup.appendChild(leftAxisLine);

    const yTicks = generateLinearTicks(leftDomain.min, leftDomain.max, 6);
    for (const tick of yTicks) {
      const y = scaleYLeft(tick);
      const grid = createSvgElement(document, 'line');
      grid.setAttribute('class', 'nodes-chart__grid-line');
      grid.setAttribute('x1', String(margin.left));
      grid.setAttribute('x2', String(margin.left + innerWidth));
      grid.setAttribute('y1', String(y));
      grid.setAttribute('y2', String(y));
      gridGroup.appendChild(grid);

      const tickLabel = createSvgElement(document, 'text');
      tickLabel.setAttribute('class', 'nodes-chart__tick-label nodes-chart__tick-label--y');
      tickLabel.setAttribute('text-anchor', 'end');
      tickLabel.setAttribute('x', String(margin.left - 8));
      tickLabel.setAttribute('y', String(y + 4));
      const formatter = leftAxis?.formatTick ?? (value => value.toFixed(0));
      tickLabel.textContent = formatter(tick);
      axesGroup.appendChild(tickLabel);
    }

    if (leftAxis?.label) {
      const axisLabel = createSvgElement(document, 'text');
      axisLabel.setAttribute('class', 'nodes-chart__axis-label nodes-chart__axis-label--left');
      axisLabel.setAttribute('text-anchor', 'middle');
      axisLabel.setAttribute('transform', `translate(${margin.left - 56} ${margin.top + innerHeight / 2}) rotate(-90)`);
      axisLabel.textContent = leftAxis.label;
      axesGroup.appendChild(axisLabel);
    }
  }

  if (rightDomain) {
    const rightAxisLine = createSvgElement(document, 'line');
    const rightX = margin.left + innerWidth;
    rightAxisLine.setAttribute('x1', String(rightX));
    rightAxisLine.setAttribute('x2', String(rightX));
    rightAxisLine.setAttribute('y1', String(margin.top));
    rightAxisLine.setAttribute('y2', String(axisBottom));
    axesGroup.appendChild(rightAxisLine);

    const yTicks = generateLinearTicks(rightDomain.min, rightDomain.max, 6);
    for (const tick of yTicks) {
      const y = scaleYRight(tick);
      const tickLabel = createSvgElement(document, 'text');
      tickLabel.setAttribute('class', 'nodes-chart__tick-label nodes-chart__tick-label--y');
      tickLabel.setAttribute('text-anchor', 'start');
      tickLabel.setAttribute('x', String(rightX + 8));
      tickLabel.setAttribute('y', String(y + 4));
      const formatter = rightAxis?.formatTick ?? (value => value.toFixed(0));
      tickLabel.textContent = formatter(tick);
      axesGroup.appendChild(tickLabel);
    }

    if (rightAxis?.label) {
      const axisLabel = createSvgElement(document, 'text');
      axisLabel.setAttribute('class', 'nodes-chart__axis-label nodes-chart__axis-label--right');
      axisLabel.setAttribute('text-anchor', 'middle');
      axisLabel.setAttribute('transform', `translate(${rightX + 56} ${margin.top + innerHeight / 2}) rotate(90)`);
      axisLabel.textContent = rightAxis.label;
      axesGroup.appendChild(axisLabel);
    }
  }

  for (const series of seriesList) {
    const axis = series.metric.axis === 'right' ? 'right' : 'left';
    const domain = axis === 'right' ? rightDomain : leftDomain;
    if (!domain) {
      continue;
    }
    for (const point of series.points) {
      const circle = createSvgElement(document, 'circle');
      circle.setAttribute('class', 'nodes-chart__point');
      circle.setAttribute('cx', String(scaleX(point.timestamp)));
      const y = axis === 'right' ? scaleYRight(point.value) : scaleYLeft(point.value);
      circle.setAttribute('cy', String(y));
      circle.setAttribute('r', '4');
      circle.setAttribute('fill', series.metric.color);
      const title = createSvgElement(document, 'title');
      title.textContent = `${series.metric.label ?? series.metric.id}: ${point.value}`;
      circle.appendChild(title);
      seriesGroup.appendChild(circle);
    }
  }
}

/**
 * Build a scatter chart controller responsible for rendering a single plot.
 *
 * @param {Document} document Owner document instance.
 * @param {{ id: string, metrics: Array<Object>, leftAxis: Object, rightAxis: Object }} config Chart configuration.
 * @returns {{ update: (entries: Array<Record<string, *>>, window: { minTimestampSec: number, maxTimestampSec: number }, nowSec: number) => void }|null}
 *   Controller with an update method or null when the container is missing.
 */
function createScatterChart(document, config) {
  const container = document.getElementById ? document.getElementById(config.id) : null;
  if (!container) {
    return null;
  }
  const plot = findElementByDataRole(container, 'plot');
  const legend = findElementByDataRole(container, 'legend');
  const empty = findElementByDataRole(container, 'empty');
  const svg = createSvgElement(document, 'svg');
  if (plot) {
    plot.replaceChildren(svg);
  }
  if (legend) {
    legend.replaceChildren();
    for (const metric of config.metrics) {
      legend.appendChild(buildLegendItem(document, metric));
    }
  }
  setEmptyState(plot, empty, true);

  return {
    update(entries, window, nowSec) {
      const seriesList = config.metrics.map(metric => ({
        metric,
        points: buildMetricSeries(entries, metric, window)
      }));
      const hasData = seriesList.some(series => series.points.length > 0);
      if (!hasData) {
        svg.replaceChildren();
        setEmptyState(plot, empty, true);
        return;
      }
      setEmptyState(plot, empty, false);
      renderScatterPlot(document, svg, seriesList, config.leftAxis, config.rightAxis, nowSec);
    }
  };
}

/**
 * Initialise scatter charts on the nodes page if the containers are available.
 *
 * @param {{ document: Document, nowProvider?: () => number }} options Runtime dependencies.
 * @returns {{ update: (entries: Array<Record<string, *>>) => void }} Controller exposing an update hook.
 */
export function createNodesChartsController({ document, nowProvider = () => Date.now() }) {
  const root = document && document.getElementById ? document.getElementById('nodesCharts') : null;
  if (!root) {
    return {
      update() {}
    };
  }

  const chartConfigs = [
    {
      id: 'nodesChartPower',
      metrics: [
        {
          id: 'battery_level',
          label: 'Battery level (%)',
          color: '#2f855a',
          axis: 'left',
          fields: ['battery_level', 'batteryLevel']
        },
        {
          id: 'voltage',
          label: 'Voltage (V)',
          color: '#d97706',
          axis: 'right',
          fields: ['voltage']
        }
      ],
      leftAxis: {
        label: 'Battery level (%)',
        defaultDomain: [0, 100],
        min: 0,
        max: 100,
        formatTick: value => `${Math.round(value)}%`
      },
      rightAxis: {
        label: 'Voltage (V)',
        defaultDomain: [3, 6],
        formatTick: value => `${value.toFixed(2)}V`
      }
    },
    {
      id: 'nodesChartChannel',
      metrics: [
        {
          id: 'channel_utilization',
          label: 'Channel utilisation (%)',
          color: '#3182ce',
          axis: 'left',
          fields: ['channel_utilization', 'channelUtilization']
        },
        {
          id: 'air_util_tx',
          label: 'Air util Tx (%)',
          color: '#805ad5',
          axis: 'right',
          fields: ['air_util_tx', 'airUtilTx']
        }
      ],
      leftAxis: {
        label: 'Channel utilisation (%)',
        defaultDomain: [0, 100],
        min: 0,
        max: 100,
        formatTick: value => `${Math.round(value)}%`
      },
      rightAxis: {
        label: 'Air util Tx (%)',
        defaultDomain: [0, 100],
        min: 0,
        max: 100,
        formatTick: value => `${Math.round(value)}%`
      }
    },
    {
      id: 'nodesChartEnvironment',
      metrics: [
        {
          id: 'temperature',
          label: 'Temperature (°C)',
          color: '#e53e3e',
          axis: 'left',
          fields: ['temperature']
        },
        {
          id: 'relative_humidity',
          label: 'Humidity (%)',
          color: '#38b2ac',
          axis: 'left',
          fields: ['relative_humidity', 'relativeHumidity']
        },
        {
          id: 'barometric_pressure',
          label: 'Pressure (hPa)',
          color: '#dd6b20',
          axis: 'right',
          fields: ['barometric_pressure', 'barometricPressure']
        }
      ],
      leftAxis: {
        label: 'Temperature (°C) & Humidity (%)',
        defaultDomain: [-20, 100],
        formatTick: value => `${Math.round(value)}`
      },
      rightAxis: {
        label: 'Pressure (hPa)',
        defaultDomain: [900, 1100],
        formatTick: value => `${Math.round(value)} hPa`
      }
    }
  ];

  const charts = chartConfigs
    .map(config => createScatterChart(document, config))
    .filter(controller => controller != null);

  return {
    update(entries) {
      const safeEntries = Array.isArray(entries) ? entries : [];
      const now = Number(nowProvider()) || Date.now();
      const nowSec = Math.floor(now / 1000);
      const window = {
        minTimestampSec: nowSec - SEVEN_DAYS_SECONDS,
        maxTimestampSec: nowSec
      };
      for (const chart of charts) {
        chart.update(safeEntries, window, nowSec);
      }
    }
  };
}
