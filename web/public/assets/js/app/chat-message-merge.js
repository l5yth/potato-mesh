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
 * Resolve the most stable identity available for a message entry.
 *
 * The identifier prioritises the explicit {@link message.id} property and
 * falls back to a composite signature assembled from the timestamp and node
 * addressing metadata.
 *
 * @param {object|null|undefined} message Message payload emitted by the API.
 * @returns {string|null} Canonical identity token or {@code null} when the
 * identifier cannot be derived.
 */
function computeMessageIdentity(message) {
  if (!message || typeof message !== 'object') {
    return null;
  }

  const candidateId = selectFirstTruthy([
    message.id,
    message.message_id,
    message.messageId,
    message.packet_id,
    message.packetId
  ]);
  if (candidateId != null) {
    const trimmed = String(candidateId).trim();
    if (trimmed.length > 0) {
      return `id:${trimmed}`;
    }
  }

  const rxTime = selectFirstTruthy([
    message.rx_time,
    message.rxTime,
    message.rx_timestamp,
    message.rxTimestamp
  ]);
  const fromId = selectFirstTruthy([
    message.from_id,
    message.fromId,
    message.node_id,
    message.nodeId
  ]);
  const toId = selectFirstTruthy([
    message.to_id,
    message.toId
  ]);
  const channel = selectFirstTruthy([
    message.channel,
    message.channel_index,
    message.channelIndex
  ]);
  const portnum = selectFirstTruthy([
    message.portnum,
    message.portNum
  ]);
  const replyId = selectFirstTruthy([
    message.reply_id,
    message.replyId
  ]);
  const emoji = selectFirstTruthy([
    message.emoji
  ]);

  const signatureParts = [rxTime, fromId, toId, channel, portnum, replyId, emoji]
    .map(value => (value == null ? '' : String(value).trim()));
  const hasSignature = signatureParts.some(part => part.length > 0);
  if (!hasSignature) {
    return null;
  }

  return `tuple:${signatureParts.join('|')}`;
}

/**
 * Append a message to the target collection if it has not been registered yet.
 *
 * @param {object|null|undefined} message Candidate message payload.
 * @param {Array<object>} target Aggregated output collection.
 * @param {Set<string>} seen Identity registry used for de-duplication.
 * @returns {void}
 */
function appendUniqueMessage(message, target, seen) {
  if (!message || typeof message !== 'object') {
    return;
  }
  if (!Array.isArray(target) || !(seen instanceof Set)) {
    return;
  }

  const identity = computeMessageIdentity(message);
  if (identity && seen.has(identity)) {
    return;
  }

  if (identity) {
    seen.add(identity);
  }
  target.push(message);
}

/**
 * Select the first candidate value that is neither {@code null} nor
 * {@code undefined}.
 *
 * @param {Array<*>} candidates Potential values ordered by priority.
 * @returns {*} First usable value or {@code null} when no candidates match.
 */
function selectFirstTruthy(candidates) {
  if (!Array.isArray(candidates)) {
    return null;
  }
  for (const candidate of candidates) {
    if (candidate != null) {
      return candidate;
    }
  }
  return null;
}

/**
 * Merge decrypted and encrypted chat message responses into a unified list.
 *
 * The resulting array preserves the order of the primary message feed while
 * appending encrypted-only entries that were absent from the base query. Any
 * overlapping packets are de-duplicated using their message identifiers.
 *
 * @param {Array<object>|null|undefined} normalMessages Primary message feed
 * retrieved without encrypted payloads.
 * @param {Array<object>|null|undefined} encryptedMessages Supplemental feed
 * retrieved with encrypted payloads enabled.
 * @returns {Array<object>} Stable collection containing each message exactly
 * once.
 */
export function mergeChatMessages(normalMessages, encryptedMessages) {
  const safeNormal = Array.isArray(normalMessages) ? normalMessages : [];
  const safeEncrypted = Array.isArray(encryptedMessages) ? encryptedMessages : [];

  if (safeEncrypted.length === 0) {
    return safeNormal.slice();
  }

  const seen = new Set();
  const merged = [];
  for (const message of safeNormal) {
    appendUniqueMessage(message, merged, seen);
  }
  for (const message of safeEncrypted) {
    appendUniqueMessage(message, merged, seen);
  }
  return merged;
}

export const __test__ = {
  computeMessageIdentity,
  appendUniqueMessage,
  selectFirstTruthy
};
