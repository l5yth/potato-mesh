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
 * Chart layout helpers — dimensions, axis positioning, and value scaling.
 *
 * @module node-page-charts/layout
 */

import { DEFAULT_CHART_DIMENSIONS, DEFAULT_CHART_MARGIN } from './constants.js';
import { clamp } from './format-utils.js';

/**
 * Compute the layout metrics for the supplied chart specification.
 *
 * Automatically widens the left/right margins when the spec requests
 * secondary axes.
 *
 * @param {Object} spec Chart specification (must include an ``axes`` array).
 * @returns {{
 *   width: number,
 *   height: number,
 *   margin: {top: number, right: number, bottom: number, left: number},
 *   innerWidth: number,
 *   innerHeight: number,
 *   chartTop: number,
 *   chartBottom: number,
 * }} Computed chart dimensions.
 */
export function createChartDimensions(spec) {
  const margin = { ...DEFAULT_CHART_MARGIN };
  // Widen the left margin when a secondary left axis is present.
  if (spec.axes.some(axis => axis.position === 'leftSecondary')) {
    margin.left += 36;
  }
  // Widen the right margin when a secondary right axis is present.
  if (spec.axes.some(axis => axis.position === 'rightSecondary')) {
    margin.right += 40;
  }
  const width = DEFAULT_CHART_DIMENSIONS.width;
  const height = DEFAULT_CHART_DIMENSIONS.height;
  const innerWidth = Math.max(1, width - margin.left - margin.right);
  const innerHeight = Math.max(1, height - margin.top - margin.bottom);
  return {
    width,
    height,
    margin,
    innerWidth,
    innerHeight,
    chartTop: margin.top,
    chartBottom: height - margin.bottom,
  };
}

/**
 * Compute the horizontal drawing position for an axis descriptor.
 *
 * Maps position keywords to their SVG X coordinates relative to the chart
 * viewport.
 *
 * @param {string} position Axis position keyword.
 * @param {Object} dims Chart dimensions returned by {@link createChartDimensions}.
 * @returns {number} X coordinate for the axis baseline.
 */
export function resolveAxisX(position, dims) {
  switch (position) {
    case 'leftSecondary':
      return dims.margin.left - 32;
    case 'right':
      return dims.width - dims.margin.right;
    case 'rightSecondary':
      return dims.width - dims.margin.right + 32;
    case 'left':
    default:
      return dims.margin.left;
  }
}

/**
 * Compute the X coordinate for a timestamp constrained to the rolling window.
 *
 * Linear interpolation between ``domainStart`` and ``domainEnd``, clamped so
 * points never fall outside the chart frame.
 *
 * @param {number} timestamp Timestamp in milliseconds.
 * @param {number} domainStart Start of the window in milliseconds.
 * @param {number} domainEnd End of the window in milliseconds.
 * @param {Object} dims Chart dimensions.
 * @returns {number} X coordinate inside the SVG viewport.
 */
export function scaleTimestamp(timestamp, domainStart, domainEnd, dims) {
  const safeStart = Math.min(domainStart, domainEnd);
  const safeEnd = Math.max(domainStart, domainEnd);
  const span = Math.max(1, safeEnd - safeStart);
  const clamped = clamp(timestamp, safeStart, safeEnd);
  const ratio = (clamped - safeStart) / span;
  return dims.margin.left + ratio * dims.innerWidth;
}

/**
 * Convert a value bound to a specific axis into a Y coordinate.
 *
 * Supports both linear and logarithmic (``scale: 'log'``) axes.
 *
 * @param {number} value Series value.
 * @param {Object} axis Axis descriptor.
 * @param {Object} dims Chart dimensions.
 * @returns {number} Y coordinate (higher values map to lower Y numbers).
 */
export function scaleValueToAxis(value, axis, dims) {
  if (!axis) return dims.chartBottom;
  if (axis.scale === 'log') {
    // Logarithmic scale: map log10(value) linearly between log10(min) and
    // log10(max) so each order of magnitude occupies the same pixel height.
    const minLog = Math.log10(axis.min);
    const maxLog = Math.log10(axis.max);
    const safe = clamp(value, axis.min, axis.max);
    const ratio = (Math.log10(safe) - minLog) / (maxLog - minLog);
    return dims.chartBottom - ratio * dims.innerHeight;
  }
  // Linear scale: ratio grows from 0 at axis.min to 1 at axis.max.
  // Subtracting from chartBottom inverts the Y axis so higher values appear
  // nearer the top of the SVG viewport (lower Y coordinate).
  const safe = clamp(value, axis.min, axis.max);
  const ratio = (safe - axis.min) / (axis.max - axis.min || 1);
  return dims.chartBottom - ratio * dims.innerHeight;
}
