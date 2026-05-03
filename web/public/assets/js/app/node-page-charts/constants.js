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
 * Time-window and layout constants used by the node detail telemetry charts.
 *
 * @module node-page-charts/constants
 */

/** One day expressed in milliseconds. */
export const DAY_MS = 86_400_000;

/** One hour expressed in milliseconds. */
export const HOUR_MS = 3_600_000;

/** Rolling telemetry display window: seven days in milliseconds. */
export const TELEMETRY_WINDOW_MS = DAY_MS * 7;

/**
 * Default SVG viewport dimensions (pixels) for telemetry charts.
 *
 * @type {Readonly<{width: number, height: number}>}
 */
export const DEFAULT_CHART_DIMENSIONS = Object.freeze({ width: 660, height: 360 });

/**
 * Default inner margin (pixels) applied to every telemetry chart.
 *
 * Extra room for secondary axes is added dynamically in
 * {@link createChartDimensions}.
 *
 * @type {Readonly<{top: number, right: number, bottom: number, left: number}>}
 */
export const DEFAULT_CHART_MARGIN = Object.freeze({ top: 28, right: 80, bottom: 64, left: 80 });
