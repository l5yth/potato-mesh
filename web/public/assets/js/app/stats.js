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
 * Compute active-node counts from a local node array, including per-protocol
 * breakdowns for meshcore and meshtastic.
 *
 * @param {Array<Object>} nodes Node payloads.
 * @param {number} nowSeconds Reference timestamp (Unix seconds).
 * @returns {{hour: number, day: number, week: number, month: number, sampled: boolean, meshcore?: Object, meshtastic?: Object}} Local count snapshot.
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
  const meshcore = {};
  const meshtastic = {};
  for (const window of windows) {
    const active = safeNodes.filter(node => {
      const lastHeard = Number(node?.last_heard);
      return Number.isFinite(lastHeard) && referenceNow - lastHeard <= window.secs;
    });
    counts[window.key] = active.length;
    meshcore[window.key] = active.filter(n => n.protocol === 'meshcore').length;
    meshtastic[window.key] = active.filter(n => n.protocol !== 'meshcore').length;
  }
  counts.meshcore = meshcore;
  counts.meshtastic = meshtastic;
  return counts;
}

/**
 * Normalise a per-protocol bucket ({hour, day, week, month}) from the payload.
 *
 * @param {*} bucket Candidate object.
 * @returns {{hour: number, day: number, week: number, month: number}|null} Normalized bucket or null.
 */
function normaliseProtocolBucket(bucket) {
  if (!bucket || typeof bucket !== 'object') return null;
  const hour = Number(bucket.hour);
  const day = Number(bucket.day);
  const week = Number(bucket.week);
  const month = Number(bucket.month);
  if (![hour, day, week, month].every(Number.isFinite)) return null;
  return {
    hour: Math.max(0, Math.trunc(hour)),
    day: Math.max(0, Math.trunc(day)),
    week: Math.max(0, Math.trunc(week)),
    month: Math.max(0, Math.trunc(month)),
  };
}

/**
 * Parse and validate the ``/api/stats`` payload (0.7.0 scope → metric → window
 * shape) into the flat node-count snapshot the dashboard renders.
 *
 * Node counts are read from ``total.nodes`` and the per-protocol
 * ``<protocol>.nodes`` sub-buckets; the other metrics (messages/telemetry) are
 * not surfaced in the header. The browser only ever calls its own same-version
 * instance, so only the current shape is parsed.
 *
 * @param {*} payload Candidate JSON object from the stats endpoint.
 * @returns {{hour: number, day: number, week: number, month: number, sampled: boolean, meshcore?: Object, meshtastic?: Object}|null} Normalized stats or null.
 */
export function normaliseActiveNodeStatsPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const nodes = normaliseProtocolBucket(payload.total?.nodes);
  if (!nodes) {
    return null;
  }
  const result = {
    ...nodes,
    sampled: Boolean(payload.sampled)
  };
  const meshcore = normaliseProtocolBucket(payload.meshcore?.nodes);
  const meshtastic = normaliseProtocolBucket(payload.meshtastic?.nodes);
  if (meshcore) result.meshcore = meshcore;
  if (meshtastic) result.meshtastic = meshtastic;
  return result;
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
    const response = await fetchImpl('/api/stats', { cache: 'default' });
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
 * Format the active-node counts for display in the footer.
 *
 * @param {{stats: {day:number,week:number,month:number,sampled:boolean}}} params Formatting data.
 * @returns {string} Compact user-visible string, e.g. ``"569/day · 729/week · 1168/month"``.
 */
export function formatActiveNodeStatsText({ stats }) {
  const day = Number(stats?.day) || 0;
  const week = Number(stats?.week) || 0;
  return `${day} nodes today · ${week} this week`;
}

/**
 * Render the active-node vital sign as markup with the day figure promoted.
 *
 * The day count is the page's proof of life (SPEC UX11, audit D-026): it is
 * wrapped in a styleable ``<strong>`` so CSS can lift it to ``--fg`` while
 * the week figure stays muted. Counts are numeric-coerced, so the markup
 * needs no escaping.
 *
 * @param {{stats: ?{day: number, week: number}}} params Active node stats.
 * @returns {string} HTML for the meta-row vital-sign line.
 */
export function formatActiveNodeStatsHtml({ stats }) {
  const day = Number(stats?.day) || 0;
  const week = Number(stats?.week) || 0;
  return (
    `<strong class="meta-active-nodes__today">${day} nodes today</strong>` +
    ` · ${week} this week`
  );
}
