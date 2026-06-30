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
 * Stable cache keys for chat-log entries.
 *
 * The incremental chat renderer ({@link module:main/chat-entry-cache}) keys
 * each entry's memoised DOM node by a string that uniquely and stably
 * identifies the underlying record across refresh ticks. These pure helpers
 * derive those keys.
 *
 * @module main/chat-entry-keys
 */

import { CHAT_LOG_ENTRY_TYPES } from '../chat-log-tabs.js';

/**
 * Derive a stable cache key for a chat message. Prefers the message ``id`` (the
 * server's primary key); falls back to a timestamp/sender/text composite for
 * id-less rows so distinct messages still get distinct keys.
 *
 * @param {?Object} message Message payload.
 * @returns {string} Stable per-message cache key.
 */
export function chatMessageEntryKey(message) {
  if (!message || typeof message !== 'object') return 'msg:';
  const id = message.id ?? message.message_id ?? message.messageId;
  if (id != null && id !== '') return `msg:${id}`;
  const ts = message.rx_time ?? message.rxTime ?? '';
  const from = message.from_id ?? message.fromId ?? '';
  const text = message.text ?? '';
  return `msg:${ts}:${from}:${text}`;
}

/**
 * Derive a stable cache key for a mixed-feed (Log tab) chat entry from its type
 * and identifying fields. Encrypted messages reuse the message key so they stay
 * stable across refreshes just like the channel-tab copy.
 *
 * @param {?Object} entry Structured chat-log entry.
 * @returns {string} Stable per-entry cache key.
 */
export function chatLogEntryKey(entry) {
  if (!entry || typeof entry !== 'object') return 'log:';
  if (entry.type === CHAT_LOG_ENTRY_TYPES.MESSAGE_ENCRYPTED && entry.message) {
    return `enc:${chatMessageEntryKey(entry.message)}`;
  }
  const type = entry.type ?? '';
  const nodeId = entry.nodeId ?? '';
  const ts = entry.ts ?? '';
  const neighborId = entry.neighborId ?? entry.neighbor?.neighbor_id ?? '';
  // ``reason`` is part of the key so two node-info entries that share a node and
  // timestamp but render differently — "(advert)" vs "(message)" — never collide
  // in the memoising render cache.
  const reason = entry.reason ?? '';
  return `log:${type}:${nodeId}:${ts}:${neighborId}:${reason}`;
}
