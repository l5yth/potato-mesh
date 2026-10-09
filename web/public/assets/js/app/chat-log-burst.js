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
 * Folded bursts in the Log view (SPEC LA4).
 *
 * A node that wakes up sends its node info, position and telemetry within
 * seconds, and the Log showed them as three lines with one badge and one
 * time. {@link foldChatLogBursts} folds a node's `node-info`, `position` and
 * `telemetry` entries that arrive within {@link CHAT_LOG_BURST_WINDOW_SECONDS}
 * of a burst's first entry into one entry of type {@link CHAT_LOG_BURST_TYPE},
 * at the first entry's place and time. A burst holds one part per kind: a
 * second part of a kind it already holds starts a new burst. Entries of other
 * nodes or kinds in between do not break it.
 *
 * Only the Log view folds. The model `buildChatTabModel` returns, the search,
 * the channel tabs and the flash read the raw entries, and the fold copies
 * nothing: a part is the raw entry itself. The folded entry is keyed by its
 * first entry's key (`chatLogEntryKey`), so the row that showed the first
 * part alone is the row the burst updates as later parts arrive.
 *
 * @module chat-log-burst
 */

import { CHAT_LOG_ENTRY_TYPES } from './chat-log-tabs.js';

/**
 * Type of a folded burst in the Log view.
 *
 * @type {string}
 */
export const CHAT_LOG_BURST_TYPE = 'node-burst';

/**
 * A part joins a burst when it arrives at most this many seconds after the
 * burst's first entry.
 *
 * @type {number}
 */
export const CHAT_LOG_BURST_WINDOW_SECONDS = 60;

/**
 * Entry types that fold into a burst.
 *
 * @type {ReadonlySet<string>}
 */
export const CHAT_LOG_BURST_KINDS = new Set([
  CHAT_LOG_ENTRY_TYPES.NODE_INFO,
  CHAT_LOG_ENTRY_TYPES.POSITION,
  CHAT_LOG_ENTRY_TYPES.TELEMETRY,
]);

/**
 * A folded burst.
 *
 * @typedef {Object} ChatLogBurst
 * @property {string} type {@link CHAT_LOG_BURST_TYPE}.
 * @property {number} ts The first part's time.
 * @property {string} nodeId The node all parts belong to.
 * @property {Array<Object>} parts The raw entries, in arrival order; two or
 *   more, one per kind.
 */

/**
 * Fold the bursts of a chronological Log (see the module notes). An entry
 * that folds with nothing passes through as itself.
 *
 * @param {Array<Object>} entries Log entries, oldest first.
 * @param {{ windowSeconds?: number }} [options] Burst window in seconds; a
 *   window of 0 or less folds nothing, not even entries of one second.
 * @returns {Array<Object|ChatLogBurst>} The Log view, oldest first.
 */
export function foldChatLogBursts(entries, { windowSeconds = CHAT_LOG_BURST_WINDOW_SECONDS } = {}) {
  const view = [];
  const bursts = [];
  const open = new Map();
  for (const entry of entries) {
    const nodeId = entry && CHAT_LOG_BURST_KINDS.has(entry.type) ? entry.nodeId : null;
    if (typeof nodeId !== 'string' || !nodeId) {
      view.push(entry);
      continue;
    }
    const burst = open.get(nodeId);
    if (burst && windowSeconds > 0 && entry.ts - burst.parts[0].ts <= windowSeconds && !burst.kinds.has(entry.type)) {
      burst.parts.push(entry);
      burst.kinds.add(entry.type);
      continue;
    }
    const started = { index: view.length, parts: [entry], kinds: new Set([entry.type]) };
    open.set(nodeId, started);
    bursts.push(started);
    view.push(entry);
  }
  for (const { index, parts } of bursts) {
    if (parts.length > 1) {
      view[index] = { type: CHAT_LOG_BURST_TYPE, ts: parts[0].ts, nodeId: parts[0].nodeId, parts };
    }
  }
  return view;
}
