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

import { buildMessageBody, resolveReplyPrefix } from './message-replies.js';
import {
  extractLeadingMentionAsReply,
  findNodeByLongName,
  parseMeshcoreSenderPrefix,
} from './meshcore-chat-helpers.js';
import { isMeshcoreProtocol } from './protocol-helpers.js';

/**
 * Pick the first defined property value from a list of candidate objects.
 *
 * Used to resolve protocol from either the message itself or its hydrated
 * node, whichever is populated first.
 *
 * @param {Array<?Object>} sources Objects to probe in order.
 * @param {string} key Property name to read.
 * @returns {*} The first non-nullish value or ``undefined``.
 */
function pickFirst(sources, key) {
  for (const source of sources) {
    if (source && typeof source === 'object') {
      const value = source[key];
      if (value != null) return value;
    }
  }
  return undefined;
}

/**
 * Render the shared badge HTML for a node, tolerant of both snake_case and
 * camelCase property names.
 *
 * @param {Function} renderShortHtml Badge renderer.
 * @param {Object} node Node record.
 * @returns {string} HTML fragment.
 */
function renderNodeBadge(renderShortHtml, node) {
  return renderShortHtml(
    node.short_name ?? node.shortName,
    node.role,
    node.long_name ?? node.longName,
    node,
  );
}

/**
 * Build a reply prefix HTML fragment for a resolved reply target node.
 *
 * @param {string} label Label text (already raw, will be escaped).
 * @param {string} badgeHtml Rendered badge for the reply target.
 * @param {Function} escapeHtml HTML-escape helper.
 * @returns {string} ``<span class="chat-entry-reply">...</span>`` HTML.
 */
function formatReplyPrefixHtml(label, badgeHtml, escapeHtml) {
  return `<span class="chat-entry-reply">[${escapeHtml(label)} ${badgeHtml}]</span>`;
}

/**
 * Render the text content of a chat entry (reply prefix + body) using shared
 * message formatting helpers.
 *
 * This extracts the rendering pipeline that lives inside the dashboard chat
 * panel so that both the dashboard (``main.js``) and the node detail page
 * (``node-page.js``) produce identical message bodies.
 *
 * The function performs:
 *
 *   1. Resolution of the standard ``reply_id``-based reply prefix.
 *   2. MeshCore ``"SenderName: body"`` prefix parsing for channel messages.
 *   3. MeshCore leading-``@[Name]`` detection, surfacing it as an ``[in reply
 *      to BADGE]`` prefix when no structured reply is already present.
 *   4. Mention rendering for MeshCore messages, mapping ``@[Name]`` to either
 *      a badge (when the named node is known) or an escaped literal fallback.
 *   5. ``buildMessageBody()`` invocation, which handles URL linkification,
 *      emoji rendering, and reaction detection.
 *   6. Encrypted-message notices when available from the caller.
 *
 * The returned ``meshcoreSenderNode`` lets callers render the sender badge
 * correctly when the ingestor could not resolve ``m.node`` for a MeshCore
 * channel message.
 *
 * @param {{
 *   message: Object,
 *   nodesById: ?Map<string, Object>,
 *   messagesById: ?Map<string, Object>,
 *   renderShortHtml: Function,
 *   escapeHtml: Function,
 *   renderEmojiHtml: Function,
 *   formatEncryptedMessageNotice?: ?Function,
 * }} params Rendering dependencies.
 * @returns {{
 *   html: string,
 *   parsedMeshcorePrefix: ?{ senderName: string, bodyText: string },
 *   meshcoreSenderNode: ?Object
 * }} Rendered HTML plus MeshCore metadata for caller-side badge fallbacks.
 */
export function renderChatEntryContent({
  message,
  nodesById,
  messagesById,
  renderShortHtml,
  escapeHtml,
  renderEmojiHtml,
  formatEncryptedMessageNotice = null,
}) {
  if (typeof escapeHtml !== 'function') {
    throw new TypeError('escapeHtml must be a function');
  }
  if (typeof renderEmojiHtml !== 'function') {
    throw new TypeError('renderEmojiHtml must be a function');
  }
  if (typeof renderShortHtml !== 'function') {
    throw new TypeError('renderShortHtml must be a function');
  }
  if (!message || typeof message !== 'object') {
    return { html: '', parsedMeshcorePrefix: null, meshcoreSenderNode: null };
  }

  const protocol = pickFirst([message, message.node], 'protocol');
  const isMeshcore = isMeshcoreProtocol(protocol);
  const toId = message.to_id ?? message.toId;
  const isMeshcoreChannelMsg = isMeshcore && toId === '^all';

  // ------------------------------------------------------------------
  // MeshCore sender prefix (channel messages only)
  // ------------------------------------------------------------------
  let parsedMeshcorePrefix = null;
  let meshcoreSenderNode = null;
  if (isMeshcoreChannelMsg && typeof message.text === 'string') {
    parsedMeshcorePrefix = parseMeshcoreSenderPrefix(message.text);
    if (parsedMeshcorePrefix && !message.node) {
      meshcoreSenderNode = findNodeByLongName(parsedMeshcorePrefix.senderName, nodesById);
    }
  }

  // ------------------------------------------------------------------
  // Encrypted messages take precedence over body rendering
  // ------------------------------------------------------------------
  if (message.encrypted) {
    let bodyHtml = '';
    if (typeof formatEncryptedMessageNotice === 'function') {
      const notice = formatEncryptedMessageNotice(message);
      if (notice && typeof notice === 'object') {
        const content = notice.content ?? '';
        bodyHtml = notice.isHtml ? content : escapeHtml(content);
      }
    }
    return { html: bodyHtml, parsedMeshcorePrefix, meshcoreSenderNode };
  }

  // ------------------------------------------------------------------
  // Structured reply_id prefix (Meshtastic style)
  // ------------------------------------------------------------------
  const replyPrefix = resolveReplyPrefix({
    message,
    messagesById,
    nodesById,
    renderShortHtml,
    escapeHtml,
  });

  // ------------------------------------------------------------------
  // MeshCore leading @[Name] as reply (substitute when no reply_id)
  // ------------------------------------------------------------------
  let meshcoreReplyPrefix = '';
  // The text we actually hand to ``buildMessageBody``; starts as the body
  // text from the sender prefix (when present) and is further stripped if
  // a leading-mention-as-reply is detected.
  let effectiveBodyText = parsedMeshcorePrefix
    ? parsedMeshcorePrefix.bodyText
    : (typeof message.text === 'string' ? message.text : null);

  if (!replyPrefix && isMeshcore && effectiveBodyText) {
    const leading = extractLeadingMentionAsReply(effectiveBodyText);
    if (leading) {
      const replyNode = findNodeByLongName(leading.mentionName, nodesById);
      let badgeHtml = '';
      if (replyNode) {
        badgeHtml = renderNodeBadge(renderShortHtml, replyNode);
      }
      // Graceful degradation: when the registry doesn't contain the
      // mention target (common on large deployments where ``/api/nodes``
      // caps at 1000 entries by recency), still surface the leading
      // mention as a reply prefix using the raw name.  Without this
      // fallback the body would render as bare ``@[Name] body...`` which
      // looks like an unresolved mention link to the user.
      if (typeof badgeHtml !== 'string' || badgeHtml.length === 0) {
        badgeHtml = `<span class="short-name">${escapeHtml(leading.mentionName)}</span>`;
      }
      meshcoreReplyPrefix = formatReplyPrefixHtml('in reply to', badgeHtml, escapeHtml);
      effectiveBodyText = leading.remainingText ?? '';
    }
  }

  // ------------------------------------------------------------------
  // Mention rendering for MeshCore messages
  // ------------------------------------------------------------------
  const renderMentionHtml = isMeshcore
    ? (mentionedName) => {
        const mentionNode = findNodeByLongName(mentionedName, nodesById);
        if (mentionNode) {
          return renderNodeBadge(renderShortHtml, mentionNode);
        }
        return `@[${escapeHtml(mentionedName)}]`;
      }
    : null;

  // ------------------------------------------------------------------
  // Build body HTML via the shared buildMessageBody helper
  // ------------------------------------------------------------------
  const bodyMsg = (parsedMeshcorePrefix || effectiveBodyText !== message.text)
    ? { ...message, text: effectiveBodyText }
    : message;

  const bodyHtml = buildMessageBody({
    message: bodyMsg,
    escapeHtml,
    renderEmojiHtml,
    renderMentionHtml,
  });

  // ------------------------------------------------------------------
  // Combine prefix + body
  // ------------------------------------------------------------------
  const segments = [];
  const prefix = replyPrefix || meshcoreReplyPrefix;
  if (prefix) segments.push(prefix);
  if (bodyHtml) segments.push(bodyHtml);
  return {
    html: segments.join(' '),
    parsedMeshcorePrefix,
    meshcoreSenderNode,
  };
}
