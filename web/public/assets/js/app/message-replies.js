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
 * Convert a value into a trimmed string or return ``null`` for blank inputs.
 *
 * @param {*} value Arbitrary input value.
 * @returns {?string} Trimmed string when present, otherwise ``null``.
 */
function toTrimmedString(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return String(value);
  }
  const str = String(value).trim();
  return str.length > 0 ? str : null;
}

/**
 * Normalise a message identifier to a stable string key.
 *
 * @param {*} value Identifier candidate.
 * @returns {?string} Canonical identifier.
 */
export function normaliseMessageId(value) {
  const str = toTrimmedString(value);
  if (!str) return null;
  if (/^-?\d+$/.test(str)) {
    const parsed = Number.parseInt(str, 10);
    if (Number.isFinite(parsed)) {
      return String(parsed);
    }
  }
  return str;
}

/**
 * Build a map of message identifiers to their payload objects.
 *
 * Duplicate identifiers retain the first occurrence encountered, mirroring the
 * ingestion pipeline that treats message IDs as unique keys.
 *
 * @param {?Array<Object>} messages Message collection.
 * @returns {Map<string, Object>} Identifier lookup.
 */
export function buildMessageIndex(messages) {
  const index = new Map();
  if (!Array.isArray(messages)) {
    return index;
  }
  for (const message of messages) {
    if (!message || typeof message !== 'object') {
      continue;
    }
    const idValue = message.id ?? message.packet_id ?? message.packetId;
    const key = normaliseMessageId(idValue);
    if (!key || index.has(key)) {
      continue;
    }
    index.set(key, message);
  }
  return index;
}

/**
 * Return the list of identifier candidates associated with ``message``.
 *
 * @param {?Object} message Message payload.
 * @returns {Array<string>} Identifier candidates.
 */
function candidateMessageIdentifiers(message) {
  if (!message || typeof message !== 'object') {
    return [];
  }
  const candidates = [
    message.node_id ?? message.nodeId,
    message.from_id ?? message.fromId,
  ];
  const unique = [];
  for (const candidate of candidates) {
    const trimmed = toTrimmedString(candidate);
    if (!trimmed || unique.includes(trimmed)) {
      continue;
    }
    unique.push(trimmed);
  }
  return unique;
}

/**
 * Resolve the node metadata associated with ``message``.
 *
 * @param {?Object} message Message payload.
 * @param {?Map<string, Object>} nodesById Node lookup table.
 * @returns {?Object} Node object when available.
 */
function deriveMessageNode(message, nodesById) {
  if (message && typeof message === 'object' && message.node && typeof message.node === 'object') {
    return message.node;
  }
  if (!(nodesById instanceof Map)) {
    return null;
  }
  for (const identifier of candidateMessageIdentifiers(message)) {
    if (nodesById.has(identifier)) {
      return nodesById.get(identifier);
    }
  }
  return null;
}

/**
 * Generate a short name fallback derived from a node identifier.
 *
 * @param {string} identifier Node identifier string.
 * @returns {?string} Short name fallback.
 */
function fallbackShortFromIdentifier(identifier) {
  const trimmed = toTrimmedString(identifier);
  if (!trimmed) return null;
  const core = trimmed.replace(/^!+/, '');
  if (core.length >= 4) {
    return core.slice(-4).toUpperCase();
  }
  if (trimmed.length >= 4) {
    return trimmed.slice(-4).toUpperCase();
  }
  return trimmed.toUpperCase();
}

/**
 * Determine the preferred short name for a reply badge.
 *
 * @param {?Object} message Message payload.
 * @param {?Object} node Node metadata.
 * @returns {?string} Short name candidate.
 */
function deriveShortCandidate(message, node) {
  const candidates = [
    node?.short_name,
    node?.shortName,
    message?.node?.short_name,
    message?.node?.shortName,
  ];
  for (const candidate of candidates) {
    const trimmed = toTrimmedString(candidate);
    if (trimmed) return trimmed;
  }
  for (const identifier of candidateMessageIdentifiers(message)) {
    const fallback = fallbackShortFromIdentifier(identifier);
    if (fallback) return fallback;
  }
  return null;
}

/**
 * Determine the preferred long name for a reply badge tooltip.
 *
 * @param {?Object} message Message payload.
 * @param {?Object} node Node metadata.
 * @returns {?string} Long name candidate.
 */
function deriveLongCandidate(message, node) {
  const candidates = [
    node?.long_name,
    node?.longName,
    message?.node?.long_name,
    message?.node?.longName,
  ];
  for (const candidate of candidates) {
    const trimmed = toTrimmedString(candidate);
    if (trimmed) return trimmed;
  }
  return null;
}

/**
 * Determine the preferred role for the reply badge.
 *
 * @param {?Object} message Message payload.
 * @param {?Object} node Node metadata.
 * @returns {?string} Role candidate.
 */
function deriveRoleCandidate(message, node) {
  const candidates = [
    node?.role,
    message?.node?.role,
  ];
  for (const candidate of candidates) {
    const trimmed = toTrimmedString(candidate);
    if (trimmed) return trimmed;
  }
  return null;
}

/**
 * Render the reply prefix for a message when the parent is known.
 *
 * @param {{
 *   message: Object,
 *   messagesById: Map<string, Object>,
 *   nodesById: Map<string, Object>,
 *   renderShortHtml: Function,
 *   escapeHtml: Function
 * }} params Rendering dependencies.
 * @returns {string} HTML snippet or empty string when unavailable.
 */
export function resolveReplyPrefix({
  message,
  messagesById,
  nodesById,
  renderShortHtml,
  escapeHtml
}) {
  if (!message || typeof message !== 'object') {
    return '';
  }
  const hasLookup = messagesById instanceof Map;
  if (!hasLookup) {
    return '';
  }
  const replyKey = normaliseMessageId(message.reply_id ?? message.replyId);
  if (!replyKey || !messagesById.has(replyKey)) {
    return '';
  }
  if (typeof renderShortHtml !== 'function' || typeof escapeHtml !== 'function') {
    return '';
  }

  const parent = messagesById.get(replyKey);
  const node = deriveMessageNode(parent, nodesById);
  const shortName = deriveShortCandidate(parent, node);
  const longName = deriveLongCandidate(parent, node);
  const role = deriveRoleCandidate(parent, node);
  const badgeSource = node || (parent && typeof parent === 'object' ? parent.node : null) || null;
  const shortHtml = renderShortHtml(shortName, role, longName, badgeSource);
  if (typeof shortHtml !== 'string' || shortHtml.length === 0) {
    return '';
  }
  const label = escapeHtml('in reply to');
  return `<span class="chat-entry-reply">[${label} ${shortHtml}]</span>`;
}

/**
 * Normalise an emoji candidate into a trimmed string.
 *
 * @param {*} value Emoji candidate.
 * @returns {?string} Emoji string when valid.
 */
function normaliseEmojiValue(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return String(value);
  }
  const str = String(value).trim();
  return str.length > 0 ? str : null;
}

/**
 * Identify whether ``message`` represents a reaction payload.
 *
 * @param {?Object} message Message payload.
 * @returns {boolean} True when the payload is a reaction.
 */
function isReactionMessage(message) {
  if (!message || typeof message !== 'object') {
    return false;
  }
  const portnum = toTrimmedString(message.portnum ?? message.portNum);
  if (portnum && portnum.toUpperCase() === 'REACTION_APP') {
    return true;
  }
  const hasEmoji = !!normaliseEmojiValue(message.emoji);
  if (!hasEmoji) {
    return false;
  }
  return message.reply_id != null || message.replyId != null || !!portnum;
}

/**
 * Derive the message text segment, suppressing reaction placeholders.
 *
 * @param {?Object} message Message payload.
 * @param {boolean} isReaction Whether the payload is a reaction.
 * @returns {?string} Text segment to render.
 */
function resolveMessageTextSegment(message, isReaction) {
  if (!message || typeof message !== 'object') {
    return null;
  }
  if (message.text == null) {
    return null;
  }
  const textString = String(message.text);
  if (textString.length === 0) {
    return null;
  }
  if (!isReaction) {
    return textString;
  }

  const trimmed = textString.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (Number.isFinite(parsed)) {
    if (parsed <= 1) {
      return null;
    }
    return `×${parsed}`;
  }
  return trimmed;
}

/**
 * Build the rendered message body containing text and optional emoji.
 *
 * @param {{
 *   message: Object,
 *   escapeHtml: Function,
 *   renderEmojiHtml: Function
 * }} params Rendering dependencies.
 * @returns {string} HTML snippet describing the message body.
 */
export function buildMessageBody({ message, escapeHtml, renderEmojiHtml }) {
  if (typeof escapeHtml !== 'function') {
    throw new TypeError('escapeHtml must be a function');
  }
  if (typeof renderEmojiHtml !== 'function') {
    throw new TypeError('renderEmojiHtml must be a function');
  }
  if (!message || typeof message !== 'object') {
    return '';
  }

  const segments = [];
  const reaction = isReactionMessage(message);
  const emoji = normaliseEmojiValue(message.emoji);
  const textSegment = resolveMessageTextSegment(message, reaction);
  if (textSegment && textSegment!==emoji) {
      segments.push(escapeHtml(textSegment));
  } else if (emoji) {
      segments.push(renderEmojiHtml(emoji));
  }
  if (segments.length === 0) {
    return '';
  }
  return segments.join(' ');
}
