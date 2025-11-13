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
const DEFAULT_WIDTH = 480;
const DEFAULT_HEIGHT = 320;
const DEFAULT_MARGIN = Object.freeze({ top: 16, right: 64, bottom: 48, left: 64 });
const POINT_RADIUS = 2;
const TIME_TICK_COUNT = 5;
const VALUE_TICK_COUNT = 5;

const numberFormatter = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 2,
  minimumFractionDigits: 0,
});

const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
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
        label: dateFormatter.format(new Date(min * 1_000)),
      },
    ];
  }
  const span = max - min;
  const step = span / (count - 1);
  const ticks = [];
  for (let index = 0; index < count; index += 1) {
    const value = min + step * index;
    ticks.push({ value, label: dateFormatter.format(new Date(value * 1_000)) });
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
 * Render a scatter plot with support for multiple y-axes.
 *
 * @param {{
 *   id: string,
 *   description: string,
 *   xLabel: string,
 *   series: Array<{
 *     id: string,
 *     label: string,
 *     color: string,
 *     axis: string,
 *     points: Array<{ time: number, value: number, iso?: string|null }>,
 *     line?: { opacity?: number, width?: number },
 *   }>,
 *   axes?: Array<{
 *     id: string,
 *     position: 'left'|'right',
 *     label?: string,
 *     formatter?: (value: number) => string,
 *     offset?: number,
 *     tickPadding?: number,
 *     labelOffset?: number,
 *     textAnchor?: 'start'|'middle'|'end',
 *     drawGridLines?: boolean,
 *     showAxisLine?: boolean,
 *   }>,
 *   leftLabel?: string,
 *   rightLabel?: string,
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
    series = [],
    axes = [],
    leftLabel = '',
    rightLabel = '',
    width = DEFAULT_WIDTH,
    height = DEFAULT_HEIGHT,
    margin = DEFAULT_MARGIN,
    leftTickFormatter = value => numberFormatter.format(value),
    rightTickFormatter = value => numberFormatter.format(value),
  } = config;

  const activeSeries = series.filter(item => Array.isArray(item.points) && item.points.length > 0);
  if (activeSeries.length === 0) return '';

  const xValues = [];
  for (const seriesEntry of activeSeries) {
    if (!seriesEntry || !Array.isArray(seriesEntry.points)) continue;
    for (const point of seriesEntry.points) {
      xValues.push(point.time);
    }
  }
  const xDomain = computeDomain(xValues);
  if (!xDomain) return '';

  const axisDefinitions = [];
  if (Array.isArray(axes) && axes.length > 0) {
    for (const axis of axes) {
      if (!axis || typeof axis !== 'object' || !axis.id) continue;
      axisDefinitions.push({
        id: axis.id,
        position: axis.position === 'right' ? 'right' : 'left',
        label: axis.label ?? '',
        formatter: typeof axis.formatter === 'function' ? axis.formatter : null,
        offset: Number.isFinite(axis.offset) ? axis.offset : 0,
        tickPadding: Number.isFinite(axis.tickPadding) ? axis.tickPadding : undefined,
        labelOffset: Number.isFinite(axis.labelOffset) ? axis.labelOffset : undefined,
        textAnchor: axis.textAnchor === 'middle' ? 'middle' : axis.textAnchor === 'start' ? 'start' : axis.textAnchor === 'end' ? 'end' : undefined,
        drawGridLines: axis.drawGridLines !== false,
        showAxisLine: axis.showAxisLine !== false,
      });
    }
  } else {
    axisDefinitions.push({
      id: 'left',
      position: 'left',
      label: leftLabel,
      formatter: leftTickFormatter,
      offset: 0,
      drawGridLines: true,
      showAxisLine: true,
    });
    const hasRightSeries = activeSeries.some(item => item.axis === 'right');
    if (hasRightSeries) {
      axisDefinitions.push({
        id: 'right',
        position: 'right',
        label: rightLabel,
        formatter: rightTickFormatter,
        offset: 0,
        drawGridLines: false,
        showAxisLine: true,
      });
    }
  }

  const axisMap = new Map();
  for (const axis of axisDefinitions) {
    axisMap.set(axis.id, { definition: axis, series: [] });
  }

  for (const seriesEntry of activeSeries) {
    const fallbackAxisId = axisDefinitions.length > 0 ? axisDefinitions[0].id : null;
    const axisId = seriesEntry.axis ?? fallbackAxisId;
    const targetAxis = axisMap.get(axisId);
    if (targetAxis) {
      targetAxis.series.push(seriesEntry);
    }
  }

  const resolvedAxes = [];
  for (const axis of axisMap.values()) {
    if (axis.series.length > 0) {
      resolvedAxes.push(axis);
    }
  }
  if (resolvedAxes.length === 0) return '';

  const axisScales = new Map();
  const axisTicks = [];
  const axisLines = [];
  const axisLabels = [];
  const horizontalLines = [];
  const horizontalLineKeys = new Set();

  for (const axis of resolvedAxes) {
    const { definition, series: axisSeries } = axis;
    const values = [];
    for (const seriesEntry of axisSeries) {
      if (!seriesEntry || !Array.isArray(seriesEntry.points)) continue;
      for (const point of seriesEntry.points) {
        values.push(point.value);
      }
    }
    const domain = computeDomain(values);
    if (!domain) {
      continue;
    }
    const scale = scaleLinear(domain, { min: height - margin.bottom, max: margin.top });
    axisScales.set(definition.id, scale);

    const axisX = definition.position === 'right'
      ? width - margin.right + (definition.offset ?? 0)
      : margin.left + (definition.offset ?? 0);
    const tickFormatter = definition.formatter
      || (definition.position === 'right' ? rightTickFormatter : leftTickFormatter);
    const ticks = generateNumericTicks(domain.min, domain.max, VALUE_TICK_COUNT, tickFormatter);
    const tickPadding = Number.isFinite(definition.tickPadding) ? definition.tickPadding : 8;
    const labelOffset = Number.isFinite(definition.labelOffset) ? definition.labelOffset : 36;
    const textAnchor = definition.textAnchor
      || (definition.position === 'right' ? 'start' : 'end');

    if (definition.showAxisLine) {
      axisLines.push(
        `<line x1="${axisX}" x2="${axisX}" y1="${margin.top}" y2="${height - margin.bottom}" class="telemetry-chart__axis-line"></line>`,
      );
    }

    for (const tick of ticks) {
      const y = scale(tick.value);
      if (!Number.isFinite(y)) continue;
      if (definition.drawGridLines) {
        const key = y.toFixed(2);
        if (!horizontalLineKeys.has(key)) {
          horizontalLineKeys.add(key);
          horizontalLines.push(
            `<line x1="${margin.left}" x2="${width - margin.right}" y1="${y}" y2="${y}" class="telemetry-chart__grid-line telemetry-chart__grid-line--horizontal"></line>`,
          );
        }
      }
      const tickX = definition.position === 'right' ? axisX + tickPadding : axisX - tickPadding;
      axisTicks.push(
        `<text class="telemetry-chart__tick telemetry-chart__tick--y" x="${tickX}" y="${y}" text-anchor="${textAnchor}" dominant-baseline="middle">${escapeHtml(tick.label)}</text>`,
      );
    }

    if (definition.label && definition.label.trim()) {
      const labelX = definition.position === 'right'
        ? axisX + labelOffset
        : axisX - labelOffset;
      const labelClass = definition.position === 'right'
        ? 'telemetry-chart__axis-label telemetry-chart__axis-label--right'
        : 'telemetry-chart__axis-label telemetry-chart__axis-label--left';
      axisLabels.push(
        `<text class="${labelClass}" x="${labelX}" y="${margin.top + (height - margin.top - margin.bottom) / 2}" dominant-baseline="middle">${escapeHtml(definition.label)}</text>`,
      );
    }
  }

  if (axisScales.size === 0) return '';

  const xScale = scaleLinear(xDomain, { min: margin.left, max: width - margin.right });
  const xAxisY = height - margin.bottom;
  const xTicks = generateTimeTicks(xDomain.min, xDomain.max, TIME_TICK_COUNT);
  const xTickMarkup = xTicks
    .map(tick => {
      const x = xScale(tick.value);
      if (!Number.isFinite(x)) return '';
      return `
        <line x1="${x}" x2="${x}" y1="${margin.top}" y2="${height - margin.bottom}" class="telemetry-chart__grid-line"></line>
        <text class="telemetry-chart__tick telemetry-chart__tick--x" x="${x}" y="${xAxisY + 20}" text-anchor="middle">${escapeHtml(tick.label)}</text>
      `;
    })
    .join('');

  const lineMarkup = [];
  for (const seriesEntry of activeSeries) {
    if (!seriesEntry.line) continue;
    const scale = axisScales.get(seriesEntry.axis);
    if (!scale) continue;
    const pathPoints = [];
    for (const point of seriesEntry.points) {
      const cx = xScale(point.time);
      const cy = scale(point.value);
      if (Number.isFinite(cx) && Number.isFinite(cy)) {
        pathPoints.push({ x: cx, y: cy });
      }
    }
    if (pathPoints.length >= 2) {
      const strokeOpacity = Number.isFinite(seriesEntry.line.opacity)
        ? seriesEntry.line.opacity
        : 0.5;
      const strokeWidth = Number.isFinite(seriesEntry.line.width)
        ? seriesEntry.line.width
        : 1;
      const path = pathPoints
        .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x} ${point.y}`)
        .join(' ');
      lineMarkup.push(
        `<path d="${path}" fill="none" stroke="${seriesEntry.color}" stroke-opacity="${strokeOpacity}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" data-series="${escapeHtml(seriesEntry.id)}"></path>`,
      );
    }
  }

  const circles = activeSeries
    .map(seriesEntry => {
      const scale = axisScales.get(seriesEntry.axis);
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

  if (!circles.trim() && lineMarkup.length === 0) return '';

  const bottomLabelMarkup = `<text class="telemetry-chart__axis-label telemetry-chart__axis-label--bottom" x="${margin.left + (width - margin.left - margin.right) / 2}" y="${height - margin.bottom + 32}" text-anchor="middle">${escapeHtml(xLabel)}</text>`;

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
      ${axisLines.join('')}
      ${horizontalLines.join('')}
      ${axisTicks.join('')}
      ${xTickMarkup}
      ${axisLabels.join('')}
      ${bottomLabelMarkup}
      ${lineMarkup.join('')}
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
 *   series: Array<{
 *     id: string,
 *     label: string,
 *     color: string,
 *     axis: string,
 *     points: Array<{ time: number, value: number, iso?: string|null }>,
 *   }>,
 *   axes?: Array<{
 *     id: string,
 *     position: 'left'|'right',
 *     label?: string,
 *     formatter?: (value: number) => string,
 *     offset?: number,
 *     tickPadding?: number,
 *     labelOffset?: number,
 *     textAnchor?: 'start'|'middle'|'end',
 *     drawGridLines?: boolean,
 *     showAxisLine?: boolean,
 *   }>,
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
      axis: 'power-battery',
      line: { opacity: 0.5, width: 1 },
      points: points
        .filter(point => point.battery != null)
        .map(point => ({ time: point.time, value: point.battery, iso: point.iso })),
    },
    {
      id: 'voltage',
      label: 'Voltage',
      color: '#9ebcda',
      axis: 'power-voltage',
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
      axis: 'channel-utilisation',
      points: points
        .filter(point => point.channelUtilization != null)
        .map(point => ({ time: point.time, value: point.channelUtilization, iso: point.iso })),
    },
    {
      id: 'air-util-tx',
      label: 'Air utilisation (TX)',
      color: '#99d8c9',
      axis: 'channel-utilisation',
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
      axis: 'environment-temperature',
      line: { opacity: 0.5, width: 1 },
      points: points
        .filter(point => point.temperature != null)
        .map(point => ({ time: point.time, value: point.temperature, iso: point.iso })),
    },
    {
      id: 'humidity',
      label: 'Humidity',
      color: '#91bfdb',
      axis: 'environment-humidity',
      line: { opacity: 0.5, width: 1 },
      points: points
        .filter(point => point.humidity != null)
        .map(point => ({ time: point.time, value: point.humidity, iso: point.iso })),
    },
    {
      id: 'pressure',
      label: 'Pressure',
      color: '#ffffbf',
      axis: 'environment-pressure',
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
    xLabel: 'Date',
    series: powerSeries,
    axes: [
      {
        id: 'power-battery',
        position: 'left',
        label: 'Battery level (%)',
        formatter: value => value.toFixed(1),
        drawGridLines: true,
      },
      {
        id: 'power-voltage',
        position: 'right',
        label: 'Voltage (V)',
        formatter: value => value.toFixed(2),
        drawGridLines: false,
      },
    ],
  });
  if (powerSection) {
    sections.push(powerSection);
  }

  const channelSection = renderChartSection({
    id: 'channel',
    title: 'Channel utilisation',
    description: 'Channel and air utilisation for the last seven days.',
    xLabel: 'Date',
    series: channelSeries,
    axes: [
      {
        id: 'channel-utilisation',
        position: 'left',
        label: 'Utilisation (%)',
        formatter: value => value.toFixed(1),
        drawGridLines: true,
      },
    ],
  });
  if (channelSection) {
    sections.push(channelSection);
  }

  const environmentSection = renderChartSection({
    id: 'environment',
    title: 'Environmental metrics',
    description: 'Temperature, humidity, and pressure over the last seven days.',
    xLabel: 'Date',
    series: environmentSeries,
    axes: [
      {
        id: 'environment-temperature',
        position: 'left',
        label: 'Temperature (°C)',
        formatter: value => value.toFixed(1),
        drawGridLines: true,
      },
      {
        id: 'environment-humidity',
        position: 'right',
        offset: -48,
        label: 'Humidity (%)',
        formatter: value => value.toFixed(0),
        tickPadding: -6,
        labelOffset: -28,
        textAnchor: 'end',
        drawGridLines: false,
        showAxisLine: false,
      },
      {
        id: 'environment-pressure',
        position: 'right',
        label: 'Pressure (hPa)',
        formatter: value => value.toFixed(0),
        drawGridLines: false,
      },
    ],
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

