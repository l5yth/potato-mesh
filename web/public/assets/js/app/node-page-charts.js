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
 * Chart constants, pure formatting utilities, tick builders, and SVG renderers
 * used by the node detail telemetry charts.
 *
 * Acts as a thin barrel so consumers (``node-page.js`` and the chart unit
 * tests) can keep importing from ``./node-page-charts.js`` while the
 * implementation lives in focused submodules under ``./node-page-charts/``.
 *
 * @module node-page-charts
 */

export {
  DAY_MS,
  HOUR_MS,
  TELEMETRY_WINDOW_MS,
  DEFAULT_CHART_DIMENSIONS,
  DEFAULT_CHART_MARGIN,
} from './node-page-charts/constants.js';

export {
  clamp,
  hexToRgba,
  padTwo,
  formatCompactDate,
  formatGasResistance,
  formatSeriesPointValue,
  formatFrequency,
  formatBattery,
  formatVoltage,
  formatUptime,
  formatTimestamp,
  formatMessageTimestamp,
  formatHardwareModel,
  formatCoordinate,
  formatRelativeSeconds,
  formatDurationSeconds,
  formatSnr,
  toTimestampMs,
  resolveSnapshotTimestamp,
  formatAxisTick,
} from './node-page-charts/format-utils.js';

export {
  buildMidnightTicks,
  buildHourlyTicks,
  buildLinearTicks,
  buildLogTicks,
} from './node-page-charts/tick-builders.js';

export {
  createChartDimensions,
  resolveAxisX,
  scaleTimestamp,
  scaleValueToAxis,
} from './node-page-charts/layout.js';

export {
  collectSnapshotContainers,
  classifySnapshot,
  extractSnapshotValue,
  buildSeriesPoints,
  resolveAxisMax,
} from './node-page-charts/snapshot-data.js';

export {
  renderTelemetrySeries,
  renderYAxis,
  renderXAxis,
  renderTelemetryChart,
} from './node-page-charts/svg-renderers.js';

export { TELEMETRY_CHART_SPECS } from './node-page-charts/specs.js';
