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
 * A fake mesh API for the dashboard's collection GETs, over rows the test
 * holds. Like the server it serves each collection newest first by the
 * route's sort column, caps `limit` at 1000, keeps `since` inclusive and
 * floored at the route's window (7 days, 28 for neighbours and traces), keeps
 * `before` inclusive (SPEC BP1-BP3, C4), and answers `encrypted=true` from the
 * encrypted rows. Every other route answers `[]`. Each response carries fresh
 * copies, as parsed JSON does.
 *
 * @module __tests__/fake-mesh-api
 */

/** Seconds in a day. */
export const DAY = 24 * 60 * 60;

/** The routes' sort column, window and row key per collection. */
const ROUTES = Object.freeze({
  nodes: { cursor: 'last_heard', window: 7 * DAY, key: row => row.node_id },
  messages: { cursor: 'rx_time', window: 7 * DAY, key: row => String(row.id) },
  encrypted: { cursor: 'rx_time', window: 7 * DAY, key: row => String(row.id) },
  positions: { cursor: 'rx_time', window: 7 * DAY, key: row => String(row.id) },
  telemetry: { cursor: 'rx_time', window: 7 * DAY, key: row => String(row.id) },
  neighbors: { cursor: 'rx_time', window: 28 * DAY, key: row => `${row.node_id}|${row.neighbor_id}` },
  traces: { cursor: 'rx_time', window: 28 * DAY, key: row => String(row.id) },
  waypoints: { cursor: 'rx_time', window: 7 * DAY, key: row => `${row.protocol}|${row.id}` },
});

/** The API's row cap per request (MAX_QUERY_LIMIT). */
const MAX_LIMIT = 1000;

/** The collection routes this fake serves. */
const COLLECTION_PATH = /^\/api\/(nodes|messages|positions|telemetry|neighbors|traces|waypoints)$/;

/**
 * Create a fake mesh API.
 *
 * @param {{ now?: () => number }} [options] Server clock in unix seconds
 *   (defaults to `Date.now()`), used for the window floors.
 * @returns {{
 *   rows: Object<string, Array<Object>>,
 *   calls: Array<{ url: string, name: string, since: number, before: number, limit: number, served: number }>,
 *   fetch: (url: string) => Promise<Object>,
 *   upsert: (name: string, list: Array<Object>) => void,
 *   serve: (url: string) => Array<Object>,
 * }} `rows` holds the server's rows per collection; `upsert` adds rows or
 *   replaces the row with the same key; `calls` records every collection GET;
 *   `fetch` is assignable to `globalThis.fetch`; `serve` answers one URL.
 */
export function createFakeMeshApi({ now = () => Math.floor(Date.now() / 1000) } = {}) {
  const rows = Object.fromEntries(Object.keys(ROUTES).map(name => [name, []]));
  const calls = [];

  /**
   * Answer one GET.
   *
   * @param {string} url Request URL (path and query).
   * @returns {Array<Object>} The page, as fresh copies.
   */
  function serve(url) {
    const parsed = new URL(url, 'http://fake-mesh.test');
    const match = parsed.pathname.match(COLLECTION_PATH);
    if (!match) return [];
    const params = parsed.searchParams;
    const name = match[1] === 'messages' && params.get('encrypted') === 'true' ? 'encrypted' : match[1];
    const route = ROUTES[name];
    const limit = Math.min(Number(params.get('limit')) || 200, MAX_LIMIT);
    const since = Number(params.get('since')) || 0;
    const before = Number(params.get('before')) || 0;
    const floor = Math.max(since, now() - route.window);
    const page = rows[name]
      .filter(row => row[route.cursor] >= floor && (before <= 0 || row[route.cursor] <= before))
      // Newest first; ties in a stable order, as SQLite's index scan gives.
      .sort((a, b) => b[route.cursor] - a[route.cursor] || (route.key(a) < route.key(b) ? 1 : -1))
      .slice(0, limit);
    calls.push({ url, name, since, before, limit, served: page.length });
    return page.map(row => JSON.parse(JSON.stringify(row)));
  }

  return {
    rows,
    calls,
    serve,
    fetch(url) {
      const body = serve(url);
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    },
    upsert(name, list) {
      const route = ROUTES[name];
      const index = new Map(rows[name].map((row, i) => [route.key(row), i]));
      for (const row of list) {
        const at = index.get(route.key(row));
        if (at === undefined) {
          index.set(route.key(row), rows[name].length);
          rows[name].push(row);
        } else {
          rows[name][at] = row;
        }
      }
    },
  };
}

/**
 * Format an integer as a canonical `!%08x` node id.
 *
 * @param {number} n Node number.
 * @returns {string} Node id.
 */
export const nodeId = n => `!${n.toString(16).padStart(8, '0')}`;

/**
 * Rows of one collection, newest first: row `i` has its sort column at
 * `newest - i * step`.
 *
 * @param {string} name Collection name.
 * @param {{ count: number, newest: number, step: number, first?: number }} shape
 *   How many rows, the newest cursor, the spacing in seconds, and the first
 *   row number (ids and node numbers count up from it).
 * @returns {Array<Object>} The rows.
 */
export function makeRows(name, { count, newest, step, first = 0 }) {
  return Array.from({ length: count }, (_, k) => {
    const i = first + k;
    const t = newest - k * step;
    const node = nodeId(0x10000 + (i % 400));
    switch (name) {
      case 'nodes':
        return {
          node_id: nodeId(0x20000 + i), num: 0x20000 + i, short_name: `N${i}`, long_name: `Node ${i}`,
          role: 'CLIENT', protocol: 'meshtastic', last_heard: t,
        };
      case 'messages':
        return { id: 1_000_000 + i, rx_time: t, from_id: node, to_id: '^all', channel: 0, text: `m${i}`, protocol: 'meshtastic' };
      case 'positions':
        return { id: 2_000_000 + i, node_id: node, rx_time: t, position_time: t, latitude: 52.5, longitude: 13.4 };
      case 'telemetry':
        return { id: 3_000_000 + i, node_id: node, rx_time: t, battery_level: 50 + (i % 50) };
      case 'neighbors':
        return { node_id: nodeId(0x30000 + i), neighbor_id: node, rx_time: t, snr: 5 };
      case 'traces':
        return { id: 4_000_000 + i, rx_time: t, from_id: node, to_id: nodeId(0x10001) };
      case 'waypoints':
        return {
          id: 5_000_000 + i, protocol: 'meshtastic', node_id: node, rx_time: t, expire: t + 7 * DAY,
          latitude: 52.5, longitude: 13.4, name: `W${i}`,
        };
      default:
        throw new Error(`no rows for ${name}`);
    }
  });
}
