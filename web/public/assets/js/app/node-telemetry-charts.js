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

const SECONDS_IN_DAY = 86_400;
const LOOKBACK_SECONDS = SECONDS_IN_DAY * 7;
const DEFAULT_WIDTH = 640;
const DEFAULT_HEIGHT = 280;
const DEFAULT_MARGIN = Object.freeze({ top: 24, right: 72, bottom: 56, left: 72 });
const POINT_RADIUS = 2;
const TIME_TICK_COUNT = 6;
const VALUE_TICK_COUNT = 5;

const numberFormatter = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 2,
  minimumFractionDigits: 0,
});

const timeFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

/**
 * Safely escape HTML-sensitive characters.
 *
 * @param {string} input Raw string.
 * @returns {string} Escaped representation safe for embedding in HTML.
 */
function escapeHtml(input) {
  const value = input == null ? '' : String(input);
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Coerce a candidate into a finite numeric value.
 *
 * @param {*} value Raw value from a telemetry record.
 * @returns {number|null} Finite number or ``null`` when parsing fails.
 */
function toFiniteNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Normalise a telemetry entry into a structured point suitable for charting.
 *
 * @param {*} entry Raw telemetry record.
 * @param {number} minTimestamp Minimum inclusive timestamp threshold in seconds.
 * @returns {Object|null} Normalised point or ``null`` when invalid.
 */
function normaliseTelemetryEntry(entry, minTimestamp) {
  if (!entry || typeof entry !== 'object') return null;
  const rxTime = toFiniteNumber(entry.rx_time ?? entry.rxTime);
  const telemetryTime = toFiniteNumber(entry.telemetry_time ?? entry.telemetryTime);
  const timestamp = rxTime ?? telemetryTime;
  if (timestamp == null || timestamp < minTimestamp) {
    return null;
  }

  return {
    time: timestamp,
    iso: typeof entry.rx_iso === 'string' && entry.rx_iso.trim() ? entry.rx_iso : null,
    battery: toFiniteNumber(entry.battery_level ?? entry.batteryLevel),
    voltage: toFiniteNumber(entry.voltage),
    channelUtilization: toFiniteNumber(entry.channel_utilization ?? entry.channelUtilization),
    airUtilTx: toFiniteNumber(entry.air_util_tx ?? entry.airUtilTx),
    temperature: toFiniteNumber(entry.temperature),
    humidity: toFiniteNumber(entry.relative_humidity ?? entry.relativeHumidity),
    pressure: toFiniteNumber(entry.barometric_pressure ?? entry.barometricPressure),
  };
}

/**
 * Normalise telemetry data into a sorted collection of points within the lookback window.
 *
 * @param {Array<Object>} records Telemetry records returned by the API.
 * @param {{ now?: number }} [options] Optional overrides such as the reference timestamp.
 * @returns {Array<Object>} Sorted telemetry points within the seven-day window.
 */
export function normalizeTelemetryRecords(records, { now = Date.now() } = {}) {
  const nowSeconds = Math.floor(now / 1_000);
  const minTimestamp = nowSeconds - LOOKBACK_SECONDS;
  const input = Array.isArray(records) ? records : [];
  return input
    .map(entry => normaliseTelemetryEntry(entry, minTimestamp))
    .filter(point => point != null)
    .sort((a, b) => a.time - b.time);
}

/**
 * Compute an inclusive domain for the provided values with a small padding.
 *
 * @param {Array<number>} values Numeric values.
 * @returns {{ min: number, max: number }|null} Inclusive domain or ``null`` when unavailable.
 */
function computeDomain(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }
  const finiteValues = values.filter(value => Number.isFinite(value));
  if (finiteValues.length === 0) return null;
  let min = Math.min(...finiteValues);
  let max = Math.max(...finiteValues);
  if (min === max) {
    const delta = Math.abs(min) || 1;
    min -= delta * 0.5;
    max += delta * 0.5;
  } else {
    const padding = (max - min) * 0.05;
    min -= padding;
    max += padding;
  }
  return { min, max };
}

/**
 * Create a linear scaling function between the specified domain and range.
 *
 * @param {{ min: number, max: number }} domain Domain in source units.
 * @param {{ min: number, max: number }} range Range in target units.
 * @returns {(value: number) => number} Scaling function.
 */
function scaleLinear(domain, range) {
  const domainSpan = domain.max - domain.min;
  if (!Number.isFinite(domainSpan) || domainSpan === 0) {
    const midpoint = (range.min + range.max) / 2;
    return () => midpoint;
  }
  const rangeSpan = range.max - range.min;
  const factor = rangeSpan / domainSpan;
  return value => range.min + (value - domain.min) * factor;
}

/**
 * Generate evenly spaced numeric ticks with formatted labels.
 *
 * @param {number} min Minimum value.
 * @param {number} max Maximum value.
 * @param {number} count Desired tick count.
 * @param {(value: number) => string} formatter Tick label formatter.
 * @returns {Array<{ value: number, label: string }>} Tick descriptors.
 */
function generateNumericTicks(min, max, count, formatter) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (count <= 1 || min === max) {
    return [
      {
        value: min,
        label: formatter(min),
      },
    ];
  }
  const step = (max - min) / (count - 1);
  const ticks = [];
  for (let index = 0; index < count; index += 1) {
    const value = min + step * index;
    ticks.push({ value, label: formatter(value) });
  }
  return ticks;
}

/**
 * Generate evenly spaced time ticks across the supplied domain.
 *
 * @param {number} min Minimum timestamp in seconds.
 * @param {number} max Maximum timestamp in seconds.
 * @param {number} count Desired tick count.
 * @returns {Array<{ value: number, label: string }>} Tick descriptors.
 */
function generateTimeTicks(min, max, count) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (count <= 1 || min === max) {
    return [
      {
        value: min,
        label: timeFormatter.format(new Date(min * 1_000)),
      },
    ];
  }
  const span = max - min;
  const step = span / (count - 1);
  const ticks = [];
  for (let index = 0; index < count; index += 1) {
    const value = min + step * index;
    ticks.push({ value, label: timeFormatter.format(new Date(value * 1_000)) });
  }
  return ticks;
}

/**
 * Compose legend markup for the supplied series.
 *
 * @param {Array<Object>} series Chart series definitions.
 * @returns {string} HTML string representing the legend.
 */
function renderLegend(series) {
  const entries = series
    .filter(item => Array.isArray(item.points) && item.points.length > 0)
    .map(item => {
      const label = escapeHtml(item.label);
      return `
        <li class="telemetry-chart__legend-item" data-series="${escapeHtml(item.id)}">
          <span class="telemetry-chart__legend-swatch" style="--series-color: ${item.color}"></span>
          <span class="telemetry-chart__legend-label">${label}</span>
        </li>
      `;
    })
    .join('');
  if (!entries) return '';
  return `<ul class="telemetry-chart__legend">${entries}</ul>`;
}

/**
 * Render a scatter plot with optional dual y-axes.
 *
 * @param {{
 *   id: string,
 *   description: string,
 *   xLabel: string,
 *   leftLabel?: string,
 *   rightLabel?: string,
 *   series: Array<{
 *     id: string,
 *     label: string,
 *     color: string,
 *     axis: 'left'|'right',
 *     points: Array<{ time: number, value: number, iso?: string|null }>,
 *   }>,
 *   width?: number,
 *   height?: number,
 *   margin?: { top: number, right: number, bottom: number, left: number },
 *   leftTickFormatter?: (value: number) => string,
 *   rightTickFormatter?: (value: number) => string,
 * }} config Scatter plot configuration.
 * @returns {string} SVG markup or an empty string when insufficient data is available.
 */
function createScatterChart(config) {
  const {
    id,
    description,
    xLabel,
    leftLabel = '',
    rightLabel = '',
    series = [],
    width = DEFAULT_WIDTH,
    height = DEFAULT_HEIGHT,
    margin = DEFAULT_MARGIN,
    leftTickFormatter = value => numberFormatter.format(value),
    rightTickFormatter = value => numberFormatter.format(value),
  } = config;

  const activeSeries = series.filter(item => Array.isArray(item.points) && item.points.length > 0);
  if (activeSeries.length === 0) return '';

  const xValues = activeSeries.flatMap(item => item.points.map(point => point.time));
  const xDomain = computeDomain(xValues);
  if (!xDomain) return '';

  const leftSeries = activeSeries.filter(item => item.axis === 'left');
  const rightSeries = activeSeries.filter(item => item.axis === 'right');

  const leftDomain = leftSeries.length > 0
    ? computeDomain(leftSeries.flatMap(item => item.points.map(point => point.value)))
    : null;
  const rightDomain = rightSeries.length > 0
    ? computeDomain(rightSeries.flatMap(item => item.points.map(point => point.value)))
    : null;

  const xScale = scaleLinear(xDomain, { min: margin.left, max: width - margin.right });
  const yLeftScale = leftDomain
    ? scaleLinear(leftDomain, { min: height - margin.bottom, max: margin.top })
    : null;
  const yRightScale = rightDomain
    ? scaleLinear(rightDomain, { min: height - margin.bottom, max: margin.top })
    : null;

  const xAxisY = height - margin.bottom;
  const xTicks = generateTimeTicks(xDomain.min, xDomain.max, TIME_TICK_COUNT);
  const leftTicks = leftDomain ? generateNumericTicks(leftDomain.min, leftDomain.max, VALUE_TICK_COUNT, leftTickFormatter) : [];
  const rightTicks = rightDomain
    ? generateNumericTicks(rightDomain.min, rightDomain.max, VALUE_TICK_COUNT, rightTickFormatter)
    : [];

  const circles = activeSeries
    .map(seriesEntry => {
      const scale = seriesEntry.axis === 'left' ? yLeftScale : yRightScale;
      if (!scale) return '';
      return seriesEntry.points
        .map(point => {
          const cx = xScale(point.time);
          const cy = scale(point.value);
          if (!Number.isFinite(cx) || !Number.isFinite(cy)) {
            return '';
          }
          const isoAttr = point.iso ? ` data-iso="${escapeHtml(point.iso)}"` : '';
          return `<circle cx="${cx}" cy="${cy}" r="${POINT_RADIUS}" fill="${seriesEntry.color}" stroke="none" data-series="${escapeHtml(seriesEntry.id)}"${isoAttr}></circle>`;
        })
        .join('');
    })
    .join('');

  if (!circles.trim()) return '';

  const leftAxisLine = yLeftScale
    ? `<line x1="${margin.left}" x2="${margin.left}" y1="${margin.top}" y2="${height - margin.bottom}" class="telemetry-chart__axis-line"></line>`
    : '';
  const rightAxisLine = yRightScale
    ? `<line x1="${width - margin.right}" x2="${width - margin.right}" y1="${margin.top}" y2="${height - margin.bottom}" class="telemetry-chart__axis-line"></line>`
    : '';

  const xTickMarkup = xTicks
    .map(tick => {
      const x = xScale(tick.value);
      if (!Number.isFinite(x)) return '';
      return `
        <line x1="${x}" x2="${x}" y1="${margin.top}" y2="${height - margin.bottom}" class="telemetry-chart__grid-line"></line>
        <text class="telemetry-chart__tick telemetry-chart__tick--x" x="${x}" y="${xAxisY + 24}" text-anchor="middle">${escapeHtml(tick.label)}</text>
      `;
    })
    .join('');

  const leftTickMarkup = leftTicks
    .map(tick => {
      if (!yLeftScale) return '';
      const y = yLeftScale(tick.value);
      if (!Number.isFinite(y)) return '';
      return `
        <line x1="${margin.left}" x2="${width - margin.right}" y1="${y}" y2="${y}" class="telemetry-chart__grid-line telemetry-chart__grid-line--horizontal"></line>
        <text class="telemetry-chart__tick telemetry-chart__tick--y" x="${margin.left - 8}" y="${y}" text-anchor="end" dominant-baseline="middle">${escapeHtml(tick.label)}</text>
      `;
    })
    .join('');

  const rightTickMarkup = rightTicks
    .map(tick => {
      if (!yRightScale) return '';
      const y = yRightScale(tick.value);
      if (!Number.isFinite(y)) return '';
      return `
        <text class="telemetry-chart__tick telemetry-chart__tick--y" x="${width - margin.right + 8}" y="${y}" text-anchor="start" dominant-baseline="middle">${escapeHtml(tick.label)}</text>
      `;
    })
    .join('');

  const leftLabelMarkup = yLeftScale
    ? `<text class="telemetry-chart__axis-label telemetry-chart__axis-label--left" x="${margin.left - 48}" y="${margin.top + (height - margin.top - margin.bottom) / 2}" dominant-baseline="middle">${escapeHtml(leftLabel)}</text>`
    : '';
  const rightLabelMarkup = yRightScale
    ? `<text class="telemetry-chart__axis-label telemetry-chart__axis-label--right" x="${width - margin.right + 48}" y="${margin.top + (height - margin.top - margin.bottom) / 2}" dominant-baseline="middle">${escapeHtml(rightLabel)}</text>`
    : '';
  const bottomLabelMarkup = `<text class="telemetry-chart__axis-label telemetry-chart__axis-label--bottom" x="${margin.left + (width - margin.left - margin.right) / 2}" y="${height - margin.bottom + 44}" text-anchor="middle">${escapeHtml(xLabel)}</text>`;

  const svg = `
    <svg
      class="telemetry-chart__svg"
      viewBox="0 0 ${width} ${height}"
      role="img"
      aria-describedby="${escapeHtml(id)}-description"
    >
      <title>${escapeHtml(description)}</title>
      <desc id="${escapeHtml(id)}-description">${escapeHtml(description)}</desc>
      <rect x="0" y="0" width="${width}" height="${height}" fill="none"></rect>
      <line x1="${margin.left}" x2="${width - margin.right}" y1="${xAxisY}" y2="${xAxisY}" class="telemetry-chart__axis-line"></line>
      ${leftAxisLine}
      ${rightAxisLine}
      ${leftTickMarkup}
      ${rightTickMarkup}
      ${xTickMarkup}
      ${leftLabelMarkup}
      ${rightLabelMarkup}
      ${bottomLabelMarkup}
      ${circles}
    </svg>
  `;
  return svg;
}

/**
 * Render a telemetry chart section combining a heading, scatter plot, and legend.
 *
 * @param {{
 *   id: string,
 *   title: string,
 *   description: string,
 *   xLabel: string,
 *   leftLabel?: string,
 *   rightLabel?: string,
 *   series: Array<{
 *     id: string,
 *     label: string,
 *     color: string,
 *     axis: 'left'|'right',
 *     points: Array<{ time: number, value: number, iso?: string|null }>,
 *   }>,
 *   leftTickFormatter?: (value: number) => string,
 *   rightTickFormatter?: (value: number) => string,
 * }} definition Chart definition.
 * @returns {string|null} Section markup or ``null`` when the chart has no data.
 */
function renderChartSection(definition) {
  const svg = createScatterChart(definition);
  if (!svg) return null;
  const legend = renderLegend(definition.series);
  return `
    <section class="node-detail__section node-detail__chart" data-chart="${escapeHtml(definition.id)}">
      <h3>${escapeHtml(definition.title)}</h3>
      <figure class="telemetry-chart" aria-label="${escapeHtml(definition.description)}">
        ${svg}
        ${legend}
        <figcaption class="telemetry-chart__caption">${escapeHtml(definition.description)}</figcaption>
      </figure>
    </section>
  `;
}

/**
 * Render telemetry chart sections for the supplied telemetry history.
 *
 * @param {Array<Object>} records Telemetry history records.
 * @param {{ now?: number }} [options] Optional overrides such as the reference timestamp.
 * @returns {Array<string>} Rendered telemetry sections.
 */
export function renderTelemetryChartSections(records, options = {}) {
  const points = normalizeTelemetryRecords(records, options);
  if (points.length === 0) return [];

  const powerSeries = [
    {
      id: 'battery',
      label: 'Battery level',
      color: '#8856a7',
      axis: 'left',
      points: points
        .filter(point => point.battery != null)
        .map(point => ({ time: point.time, value: point.battery, iso: point.iso })),
    },
    {
      id: 'voltage',
      label: 'Voltage',
      color: '#9ebcda',
      axis: 'right',
      points: points
        .filter(point => point.voltage != null)
        .map(point => ({ time: point.time, value: point.voltage, iso: point.iso })),
    },
  ];

  const channelSeries = [
    {
      id: 'channel-utilization',
      label: 'Channel utilisation',
      color: '#2ca25f',
      axis: 'left',
      points: points
        .filter(point => point.channelUtilization != null)
        .map(point => ({ time: point.time, value: point.channelUtilization, iso: point.iso })),
    },
    {
      id: 'air-util-tx',
      label: 'Air utilisation (TX)',
      color: '#99d8c9',
      axis: 'right',
      points: points
        .filter(point => point.airUtilTx != null)
        .map(point => ({ time: point.time, value: point.airUtilTx, iso: point.iso })),
    },
  ];

  const environmentSeries = [
    {
      id: 'temperature',
      label: 'Temperature',
      color: '#fc8d59',
      axis: 'left',
      points: points
        .filter(point => point.temperature != null)
        .map(point => ({ time: point.time, value: point.temperature, iso: point.iso })),
    },
    {
      id: 'humidity',
      label: 'Humidity',
      color: '#91bfdb',
      axis: 'left',
      points: points
        .filter(point => point.humidity != null)
        .map(point => ({ time: point.time, value: point.humidity, iso: point.iso })),
    },
    {
      id: 'pressure',
      label: 'Pressure',
      color: '#ffffbf',
      axis: 'right',
      points: points
        .filter(point => point.pressure != null)
        .map(point => ({ time: point.time, value: point.pressure, iso: point.iso })),
    },
  ];

  const sections = [];

  const powerSection = renderChartSection({
    id: 'power',
    title: 'Power metrics',
    description: 'Battery level and voltage readings from the last seven days.',
    xLabel: 'Time',
    leftLabel: 'Battery level (%)',
    rightLabel: 'Voltage (V)',
    series: powerSeries,
    leftTickFormatter: value => value.toFixed(1),
    rightTickFormatter: value => value.toFixed(2),
  });
  if (powerSection) {
    sections.push(powerSection);
  }

  const channelSection = renderChartSection({
    id: 'channel',
    title: 'Channel utilisation',
    description: 'Channel and air utilisation for the last seven days.',
    xLabel: 'Time',
    leftLabel: 'Channel utilisation (%)',
    rightLabel: 'Air utilisation (TX)',
    series: channelSeries,
    leftTickFormatter: value => value.toFixed(1),
    rightTickFormatter: value => value.toFixed(2),
  });
  if (channelSection) {
    sections.push(channelSection);
  }

  const environmentSection = renderChartSection({
    id: 'environment',
    title: 'Environmental metrics',
    description: 'Temperature, humidity, and pressure over the last seven days.',
    xLabel: 'Time',
    leftLabel: 'Temperature (°C) / Humidity (%)',
    rightLabel: 'Pressure (hPa)',
    series: environmentSeries,
    leftTickFormatter: value => value.toFixed(1),
    rightTickFormatter: value => value.toFixed(0),
  });
  if (environmentSection) {
    sections.push(environmentSection);
  }

  return sections;
}

export const __testUtils = {
  toFiniteNumber,
  normaliseTelemetryEntry,
  normalizeTelemetryRecords,
  computeDomain,
  scaleLinear,
  generateNumericTicks,
  generateTimeTicks,
  createScatterChart,
  renderChartSection,
};

