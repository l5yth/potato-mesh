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
 * Active-node statistics helpers for the dashboard header.
 *
 * Provides both a local computation path (counts from the cached node
 * snapshot) and a remote fetch path (``/api/stats`` with short-lived caching).
 * {@link fetchActiveNodeStats} selects the remote result when available and
 * falls back to the local count automatically.
 *
 * @module stats
 */

/**
 * Compute active-node counts from a local node array.
 *
 * @param {Array<Object>} nodes Node payloads.
 * @param {number} nowSeconds Reference timestamp (Unix seconds).
 * @returns {{hour: number, day: number, week: number, month: number, sampled: boolean}} Local count snapshot.
 */
export function computeLocalActiveNodeStats(nodes, nowSeconds) {
  const safeNodes = Array.isArray(nodes) ? nodes : [];
  const referenceNow = Number.isFinite(nowSeconds) ? nowSeconds : Date.now() / 1000;
  const windows = [
    { key: 'hour', secs: 3600 },
    { key: 'day', secs: 86_400 },
    { key: 'week', secs: 7 * 86_400 },
    { key: 'month', secs: 30 * 86_400 }
  ];
  const counts = { sampled: true };
  for (const window of windows) {
    counts[window.key] = safeNodes.filter(node => {
      const lastHeard = Number(node?.last_heard);
      return Number.isFinite(lastHeard) && referenceNow - lastHeard <= window.secs;
    }).length;
  }
  return counts;
}

/**
 * Parse and validate the ``/api/stats`` payload.
 *
 * @param {*} payload Candidate JSON object from the stats endpoint.
 * @returns {{hour: number, day: number, week: number, month: number, sampled: boolean}|null} Normalized stats or null.
 */
export function normaliseActiveNodeStatsPayload(payload) {
  const activeNodes = payload && typeof payload === 'object' ? payload.active_nodes : null;
  if (!activeNodes || typeof activeNodes !== 'object') {
    return null;
  }
  const hour = Number(activeNodes.hour);
  const day = Number(activeNodes.day);
  const week = Number(activeNodes.week);
  const month = Number(activeNodes.month);
  if (![hour, day, week, month].every(Number.isFinite)) {
    return null;
  }
  return {
    hour: Math.max(0, Math.trunc(hour)),
    day: Math.max(0, Math.trunc(day)),
    week: Math.max(0, Math.trunc(week)),
    month: Math.max(0, Math.trunc(month)),
    sampled: Boolean(payload.sampled)
  };
}

// Module-level cache state for the remote stats endpoint.
const ACTIVE_NODE_STATS_CACHE_TTL_MS = 30_000;
let activeNodeStatsCache = null;
let activeNodeStatsFetchPromise = null;
let activeNodeStatsFetchImpl = null;

/**
 * Fetch active-node stats from ``/api/stats`` with short-lived caching.
 *
 * The cache TTL is {@link ACTIVE_NODE_STATS_CACHE_TTL_MS}. Concurrent callers
 * share a single in-flight request via promise coalescing.
 *
 * @param {Function} fetchImpl Fetch implementation (typically the global ``fetch``).
 * @returns {Promise<{hour: number, day: number, week: number, month: number, sampled: boolean} | null>} Normalized stats or null on error.
 */
async function fetchRemoteActiveNodeStats(fetchImpl) {
  const nowMs = Date.now();
  if (activeNodeStatsCache?.fetchImpl === fetchImpl && activeNodeStatsCache.expiresAt > nowMs) {
    return activeNodeStatsCache.stats;
  }
  if (activeNodeStatsFetchPromise && activeNodeStatsFetchImpl === fetchImpl) {
    return activeNodeStatsFetchPromise;
  }

  activeNodeStatsFetchImpl = fetchImpl;
  activeNodeStatsFetchPromise = (async () => {
    const response = await fetchImpl('/api/stats', { cache: 'no-store' });
    if (!response?.ok) {
      throw new Error(`stats HTTP ${response?.status ?? 'unknown'}`);
    }
    const payload = await response.json();
    const normalized = normaliseActiveNodeStatsPayload(payload);
    if (!normalized) {
      throw new Error('invalid stats payload');
    }
    activeNodeStatsCache = {
      fetchImpl,
      expiresAt: Date.now() + ACTIVE_NODE_STATS_CACHE_TTL_MS,
      stats: normalized
    };
    return normalized;
  })();

  try {
    return await activeNodeStatsFetchPromise;
  } finally {
    activeNodeStatsFetchPromise = null;
    activeNodeStatsFetchImpl = null;
  }
}

/**
 * Fetch active-node stats from the dedicated API endpoint with local fallback.
 *
 * Attempts the remote endpoint first; on any error falls back to
 * {@link computeLocalActiveNodeStats} using the provided ``nodes`` snapshot.
 *
 * @param {{
 *   nodes: Array<Object>,
 *   nowSeconds: number,
 *   fetchImpl?: Function
 * }} params Fetch parameters.
 * @returns {Promise<{hour: number, day: number, week: number, month: number, sampled: boolean}>} Stats snapshot.
 */
export async function fetchActiveNodeStats({ nodes, nowSeconds, fetchImpl = fetch }) {
  try {
    const normalized = await fetchRemoteActiveNodeStats(fetchImpl);
    if (normalized) return normalized;
    throw new Error('invalid stats payload');
  } catch (error) {
    console.debug('Failed to fetch /api/stats; using local active-node counts.', error);
    return computeLocalActiveNodeStats(nodes, nowSeconds);
  }
}

/**
 * Format the dashboard refresh-info sentence for active-node counts.
 *
 * @param {{channel: string, frequency: string, stats: {hour:number,day:number,week:number,month:number,sampled:boolean}}} params Formatting data.
 * @returns {string} User-visible sentence for the dashboard header.
 */
export function formatActiveNodeStatsText({ channel, frequency, stats }) {
  const parts = [
    `${Number(stats?.hour) || 0}/hour`,
    `${Number(stats?.day) || 0}/day`,
    `${Number(stats?.week) || 0}/week`,
    `${Number(stats?.month) || 0}/month`
  ];
  const suffix = stats?.sampled ? ' (sampled)' : '';
  return `${channel} (${frequency}) — active nodes: ${parts.join(', ')}${suffix}.`;
}
