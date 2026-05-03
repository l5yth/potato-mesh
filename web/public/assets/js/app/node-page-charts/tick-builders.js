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
 * Tick generators for telemetry chart X and Y axes.
 *
 * @module node-page-charts/tick-builders
 */

import { DAY_MS, HOUR_MS, TELEMETRY_WINDOW_MS } from './constants.js';

/**
 * Build midnight tick timestamps covering the rolling telemetry window.
 *
 * Walks backwards from ``nowMs`` by one day until the domain start is
 * reached, then reverses the array for chronological order.
 *
 * @param {number} nowMs Reference timestamp in milliseconds.
 * @param {number} [windowMs=TELEMETRY_WINDOW_MS] Window size in milliseconds.
 * @returns {Array<number>} Midnight timestamps within the window.
 */
export function buildMidnightTicks(nowMs, windowMs = TELEMETRY_WINDOW_MS) {
  const ticks = [];
  const safeWindow = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : TELEMETRY_WINDOW_MS;
  const domainStart = nowMs - safeWindow;
  const cursor = new Date(nowMs);
  cursor.setHours(0, 0, 0, 0);
  for (let ts = cursor.getTime(); ts >= domainStart; ts -= DAY_MS) {
    ticks.push(ts);
  }
  return ticks.reverse();
}

/**
 * Build hourly tick timestamps across the provided window.
 *
 * @param {number} nowMs Reference timestamp in milliseconds.
 * @param {number} [windowMs=DAY_MS] Window size in milliseconds.
 * @returns {Array<number>} Hourly tick timestamps in chronological order.
 */
export function buildHourlyTicks(nowMs, windowMs = DAY_MS) {
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

/**
 * Build evenly spaced ticks for linear axes.
 *
 * @param {number} min Axis minimum.
 * @param {number} max Axis maximum.
 * @param {number} [count=4] Number of tick segments (produces count+1 values).
 * @returns {Array<number>} Tick values including both extrema.
 */
export function buildLinearTicks(min, max, count = 4) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (max <= min) return [min];
  const segments = Math.max(1, Math.floor(count));
  const step = (max - min) / segments;
  const ticks = [];
  for (let idx = 0; idx <= segments; idx += 1) {
    ticks.push(min + step * idx);
  }
  return ticks;
}

/**
 * Build base-10 ticks for logarithmic axes.
 *
 * Returns one tick per order of magnitude between ``min`` and ``max``,
 * plus the raw min/max values when they are not already included.
 *
 * @param {number} min Minimum domain value (must be > 0).
 * @param {number} max Maximum domain value.
 * @returns {Array<number>} Tick values distributed across powers of ten.
 */
export function buildLogTicks(min, max) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max <= min) {
    return [];
  }
  const ticks = [];
  const minExp = Math.ceil(Math.log10(min));
  const maxExp = Math.floor(Math.log10(max));
  for (let exp = minExp; exp <= maxExp; exp += 1) {
    ticks.push(10 ** exp);
  }
  if (!ticks.includes(min)) ticks.unshift(min);
  if (!ticks.includes(max)) ticks.push(max);
  return ticks;
}
