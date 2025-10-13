/*
 * Copyright (C) 2025 l5yth
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

const DEFAULT_WIDTH = 960;
const DEFAULT_HEIGHT = 320;
const PADDING_LEFT = 72;
const PADDING_RIGHT = 28;
const PADDING_TOP = 32;
const PADDING_BOTTOM = 56;

const SERIES_DEFINITIONS = [
  {
    key: 'batteryLevel',
    label: 'Battery level',
    lightColor: '#2b6cb0',
    darkColor: '#5fa8ff'
  },
  {
    key: 'channelUtilization',
    label: 'Channel util.',
    lightColor: '#c05621',
    darkColor: '#f6ad55'
  },
  {
    key: 'airUtilTx',
    label: 'Air Tx util.',
    lightColor: '#2f855a',
    darkColor: '#68d391'
  }
];

/**
 * Clamp a numeric percentage to the ``0-100`` range.
 *
 * @param {number|null} value Candidate percentage.
 * @returns {number|null} Clamped percentage or ``null`` when invalid.
 */
function clampPercent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

/**
 * Create human readable tick labels along the X axis.
 *
 * @param {number} startMs Earliest timestamp in milliseconds.
 * @param {number} endMs Latest timestamp in milliseconds.
 * @returns {Array<{ position: number, label: string }>} Tick descriptors.
 */
function buildTimeTicks(startMs, endMs) {
  const duration = Math.max(endMs - startMs, 1);
  const tickCount = 4;
  const ticks = [];
  for (let i = 0; i <= tickCount; i += 1) {
    const ratio = i / tickCount;
    const timestamp = new Date(startMs + duration * ratio);
    const label = `${timestamp.getUTCMonth() + 1}/${timestamp.getUTCDate()} ${timestamp
      .getUTCHours()
      .toString()
      .padStart(2, '0')}:${timestamp.getUTCMinutes().toString().padStart(2, '0')} UTC`;
    ticks.push({ position: ratio, label });
  }
  return ticks;
}

/**
 * Build Y axis tick descriptors.
 *
 * @returns {Array<{ value: number, label: string }>} Tick descriptors.
 */
function buildPercentTicks() {
  return [0, 25, 50, 75, 100].map(value => ({ value, label: `${value}%` }));
}

/**
 * Construct the SVG markup representing the telemetry scatter plot.
 *
 * @param {Array<Object>} data Normalised telemetry records sorted oldest first.
 * @param {Object} [options] Rendering options.
 * @param {number} [options.width=960] Overall width of the SVG viewport.
 * @param {number} [options.height=320] Overall height of the SVG viewport.
 * @param {string} [options.theme='light'] Theme identifier controlling colour palette.
 * @returns {string} SVG markup string or fallback message HTML.
 */
export function renderTelemetrySvg(data, { width = DEFAULT_WIDTH, height = DEFAULT_HEIGHT, theme = 'light' } = {}) {
  const safeData = Array.isArray(data) ? data : [];
  if (safeData.length === 0) {
    return '<p class="node-view__plot-empty">No telemetry reported in the last 7 days.</p>';
  }

  const timestamps = safeData.map(entry => entry.timestampMs);
  const minTs = Math.min(...timestamps);
  const maxTs = Math.max(...timestamps);
  const rangeMs = Math.max(maxTs - minTs, 1);

  const innerWidth = Math.max(width - PADDING_LEFT - PADDING_RIGHT, 100);
  const innerHeight = Math.max(height - PADDING_TOP - PADDING_BOTTOM, 120);

  const timeTicks = buildTimeTicks(minTs, maxTs);
  const percentTicks = buildPercentTicks();

  const palette = SERIES_DEFINITIONS.map(def => ({
    ...def,
    color: theme === 'dark' ? def.darkColor : def.lightColor
  }));

  const circles = [];
  for (const def of palette) {
    for (const entry of safeData) {
      const value = clampPercent(entry[def.key]);
      if (value == null) continue;
      const xRatio = (entry.timestampMs - minTs) / rangeMs;
      const yRatio = value / 100;
      const cx = PADDING_LEFT + xRatio * innerWidth;
      const cy = PADDING_TOP + (1 - yRatio) * innerHeight;
      circles.push(
        `<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="5" fill="${def.color}" fill-opacity="0.82" stroke="${def.color}" stroke-opacity="0.9" stroke-width="1" aria-label="${def.label}: ${value.toFixed(1)}%" />`
      );
    }
  }

  const xAxis = timeTicks
    .map(tick => {
      const x = PADDING_LEFT + tick.position * innerWidth;
      return `
        <g transform="translate(${x.toFixed(2)}, ${PADDING_TOP + innerHeight})">
          <line x1="0" y1="0" x2="0" y2="8" stroke="currentColor" stroke-width="1" />
          <text x="0" y="22" text-anchor="middle" font-size="12" fill="currentColor">${tick.label}</text>
        </g>`;
    })
    .join('');

  const yAxis = percentTicks
    .map(tick => {
      const y = PADDING_TOP + (1 - tick.value / 100) * innerHeight;
      return `
        <g transform="translate(${PADDING_LEFT}, ${y.toFixed(2)})">
          <line x1="-8" y1="0" x2="0" y2="0" stroke="currentColor" stroke-width="1" />
          <text x="-12" y="4" text-anchor="end" font-size="12" fill="currentColor">${tick.label}</text>
          <line x1="0" y1="0" x2="${innerWidth}" y2="0" stroke="currentColor" stroke-opacity="0.12" stroke-width="1" />
        </g>`;
    })
    .join('');

  const legendItems = palette
    .map((def, index) => {
      const xOffset = index * 160;
      return `
        <g transform="translate(${xOffset}, 0)">
          <rect x="0" y="-12" width="18" height="18" rx="4" fill="${def.color}" fill-opacity="0.85" />
          <text x="26" y="2" font-size="13" fill="currentColor">${def.label}</text>
        </g>`;
    })
    .join('');

  return `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="telemetryChartTitle" xmlns="http://www.w3.org/2000/svg">
      <title id="telemetryChartTitle">Node telemetry over the last seven days</title>
      <rect x="0" y="0" width="${width}" height="${height}" fill="none" />
      <g class="telemetry-chart__axes" fill="none" stroke="currentColor" stroke-opacity="0.3">
        <line x1="${PADDING_LEFT}" y1="${PADDING_TOP + innerHeight}" x2="${PADDING_LEFT + innerWidth}" y2="${PADDING_TOP + innerHeight}" stroke-width="1.2" />
        <line x1="${PADDING_LEFT}" y1="${PADDING_TOP}" x2="${PADDING_LEFT}" y2="${PADDING_TOP + innerHeight}" stroke-width="1.2" />
      </g>
      <g class="telemetry-chart__y-axis" font-family="system-ui, sans-serif">${yAxis}
      </g>
      <g class="telemetry-chart__x-axis" font-family="system-ui, sans-serif">${xAxis}
      </g>
      <g class="telemetry-chart__points">${circles.join('\n')}
      </g>
      <g class="telemetry-chart__legend" transform="translate(${PADDING_LEFT}, ${height - 18})" font-family="system-ui, sans-serif">
        ${legendItems}
      </g>
    </svg>
  `;
}

/**
 * Render the telemetry SVG markup inside the supplied container element.
 *
 * @param {Element} container Target element that will host the plot.
 * @param {Array<Object>} data Normalised telemetry records.
 * @param {Object} [options] Rendering overrides passed to {@link renderTelemetrySvg}.
 * @returns {string} Rendered markup string.
 */
export function renderTelemetryPlot(container, data, options) {
  if (!container || typeof container !== 'object') {
    throw new TypeError('container element is required');
  }
  const markup = renderTelemetrySvg(data, options);
  container.innerHTML = markup;
  return markup;
}

export { clampPercent, SERIES_DEFINITIONS };
