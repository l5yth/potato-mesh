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
 * Numeric values above 127 are treated as Unicode codepoints and converted to
 * the corresponding character (e.g. ``128077`` → ``"👍"``).  Small values
 * (≤ 127) are kept as digit strings so that slot markers like ``"1"`` pass
 * through unchanged.
 *
 * @param {*} value Emoji candidate.
 * @returns {?string} Emoji string when valid.
 */
export function normaliseEmojiValue(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d+$/.test(trimmed)) {
      const cp = Number(trimmed);
      if (cp > 127 && Number.isFinite(cp)) {
        try { return String.fromCodePoint(cp); } catch { /* fall through */ }
      }
    }
    return trimmed;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    if (value > 127) {
      try { return String.fromCodePoint(value); } catch { /* fall through */ }
    }
    return String(value);
  }
  const str = String(value).trim();
  return str.length > 0 ? str : null;
}

/**
 * Maximum Unicode codepoint length for text that may still qualify as a
 * reaction placeholder.  A bare emoji (single grapheme) is at most 2
 * codepoints — base character plus an optional variation selector
 * (U+FE0F).  Multi-codepoint ZWJ families (👨‍👩‍👧, 🏳️‍🌈) are intentionally
 * NOT accepted here: matching them would also let through short CJK
 * messages like "你好世界吗" (5 codepoints, no ASCII letters), causing real
 * prose to be misclassified as a reaction.
 *
 * MUST stay aligned with the Python ingestor's
 * ``_REACTION_PLACEHOLDER_MAX_CODEPOINTS`` (``handlers/generic.py``);
 * changing one side without the other re-introduces ingest/render
 * disagreement (a packet stored as a reaction but rendered as text, or
 * vice versa).
 *
 * @type {number}
 */
const REACTION_PLACEHOLDER_MAX_CODEPOINTS = 2;

/**
 * Return whether ``text`` looks like a reaction placeholder rather than
 * substantive message content.
 *
 * Reaction packets carry either no text, a small numeric count/slot marker
 * (e.g. ``"1"``, ``"3"``), or occasionally a bare emoji.  Anything that reads
 * as real prose should cause the message to be classified as a regular text
 * message, not a reaction.
 *
 * @param {?string} text Trimmed message text (may be ``null``).
 * @returns {boolean} ``true`` when *text* is absent or a placeholder.
 */
function isReactionPlaceholderText(text) {
  if (!text) return true;
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (/^\d+$/.test(trimmed)) return true;
  // Bare emoji heuristic — see REACTION_PLACEHOLDER_MAX_CODEPOINTS.
  if ([...trimmed].length <= REACTION_PLACEHOLDER_MAX_CODEPOINTS && !/[a-zA-Z]/.test(trimmed)) {
    return true;
  }
  return false;
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
  const reactionPort = portnum && portnum.toUpperCase() === 'REACTION_APP';
  if (reactionPort) {
    return true;
  }
  const hasEmoji = !!normaliseEmojiValue(message.emoji);
  if (!hasEmoji) {
    return false;
  }
  const hasReplyId = message.reply_id != null || message.replyId != null;
  if (!hasReplyId) {
    return false;
  }
  const text = toTrimmedString(message.text);
  return isReactionPlaceholderText(text);
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
 * Regex with a single capturing group that matches http:// and https:// URLs.
 * Used by {@link renderLiteralWithLinks} to split text into URL and non-URL
 * segments while preserving the matched URL in the resulting array.
 * @type {RegExp}
 */
const URL_SPLIT_PATTERN = /(https?:\/\/[^\s<>"'[\]]{1,2048})/;

/**
 * Strip trailing punctuation characters that are typically sentence
 * delimiters rather than part of a URL (e.g. a period at end of sentence).
 *
 * @param {string} url Raw URL candidate.
 * @returns {string} URL with trailing punctuation trimmed.
 */
function trimUrlTrailingPunctuation(url) {
  return url.replace(/[.,;!?)]+$/, '');
}

/**
 * Render a single raw text segment, converting any ``http://`` or
 * ``https://`` URLs into ``<a>`` elements that open in a new tab.
 * Non-URL text is passed through ``escapeHtml`` unchanged.
 *
 * @param {string} text Raw (unescaped) literal text.
 * @param {Function} escapeHtml HTML-escape function.
 * @returns {string} Safe HTML with URLs wrapped in anchor elements.
 */
export function renderLiteralWithLinks(text, escapeHtml) {
  // split() with a capturing group interleaves plain text (even indices)
  // and matched URLs (odd indices): ["before", "https://x", " after", ...]
  const parts = text.split(URL_SPLIT_PATTERN);
  return parts.map((part, i) => {
    if (i % 2 === 0) {
      return part ? escapeHtml(part) : '';
    }
    // URL segment — strip trailing punctuation then linkify.
    const url = trimUrlTrailingPunctuation(part);
    const trailing = part.slice(url.length);
    return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>${trailing ? escapeHtml(trailing) : ''}`;
  }).join('');
}

/**
 * Render a text segment, replacing ``@[Name]`` mention patterns with the
 * output of ``renderMentionHtml`` when provided.  Literal text segments are
 * passed through {@link renderLiteralWithLinks} so that URLs become clickable.
 *
 * When ``renderMentionHtml`` is ``null`` the function is equivalent to
 * calling {@link renderLiteralWithLinks} on the whole string.
 *
 * @param {string} text Raw message text segment.
 * @param {Function} escapeHtml HTML-escape function.
 * @param {Function|null} renderMentionHtml Called with the mention name (the
 *   string between ``@[`` and ``]``); should return an HTML snippet.
 * @returns {string} HTML string safe for insertion into the DOM.
 */
function renderTextWithMentions(text, escapeHtml, renderMentionHtml) {
  if (typeof renderMentionHtml !== 'function') return renderLiteralWithLinks(text, escapeHtml);
  // split() with a capturing group interleaves literal segments (even indices)
  // and captured mention names (odd indices): ["before", "Alice", "after", ...]
  const parts = text.split(/@\[([^\]]+)\]/);
  return parts.map((part, i) => {
    // Mention names are trimmed before being passed to the callback so that
    // captures like "@[ Timo +]" or "@[T-deck NK ]" (with stray whitespace)
    // resolve against the registry; the callback is responsible for falling
    // back to a plain-text rendering when the name does not match.
    if (i % 2 === 1) return renderMentionHtml(part.trim());
    // Empty literal segments (e.g. when a mention is at the start or end) can
    // be skipped to avoid unnecessary renderLiteralWithLinks calls.
    return part ? renderLiteralWithLinks(part, escapeHtml) : '';
  }).join('');
}

/**
 * Build the rendered message body containing text and optional emoji.
 * ``http://`` and ``https://`` URLs in the message text are automatically
 * converted to ``<a>`` elements that open in a new tab.
 *
 * @param {{
 *   message: Object,
 *   escapeHtml: Function,
 *   renderEmojiHtml: Function,
 *   renderMentionHtml?: Function|null
 * }} params Rendering dependencies.  When ``renderMentionHtml`` is provided it
 *   is called for each ``@[Name]`` mention found in the message text so the
 *   caller can substitute a badge or link in place of the raw mention string.
 * @returns {string} HTML snippet describing the message body.
 */
export function buildMessageBody({ message, escapeHtml, renderEmojiHtml, renderMentionHtml = null }) {
  if (typeof escapeHtml !== 'function') {
    throw new TypeError('escapeHtml must be a function');
  }
  if (typeof renderEmojiHtml !== 'function') {
    throw new TypeError('renderEmojiHtml must be a function');
  }
  if (renderMentionHtml !== null && typeof renderMentionHtml !== 'function') {
    throw new TypeError('renderMentionHtml must be a function when provided');
  }
  if (!message || typeof message !== 'object') {
    return '';
  }

  const segments = [];
  const reaction = isReactionMessage(message);
  const textSegment = resolveMessageTextSegment(message, reaction);
  const reactionCount = reaction && textSegment && /^×\d+$/.test(textSegment) ? textSegment : null;
  const emoji = normaliseEmojiValue(message.emoji);
  const emojiIsNumericPlaceholder = reaction && emoji && /^\d+$/.test(emoji);
  let reactionEmoji = reaction && !emojiIsNumericPlaceholder ? emoji : null;

  if (!reaction && textSegment) {
    segments.push(renderTextWithMentions(textSegment, escapeHtml, renderMentionHtml));
  }

  if (reaction) {
    if (!reactionEmoji && textSegment && !reactionCount) {
      reactionEmoji = textSegment;
    }
    if (reactionEmoji) {
      segments.push(renderEmojiHtml(reactionEmoji));
    } else if (textSegment && !reactionCount) {
      segments.push(escapeHtml(textSegment));
    }
    if (reactionCount) {
      segments.push(escapeHtml(reactionCount));
    }
  } else if (emoji) {
    segments.push(renderEmojiHtml(emoji));
  }

  if (segments.length === 0) {
    return '';
  }
  return segments.join(' ');
}
