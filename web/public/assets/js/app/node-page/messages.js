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
 * Render the chat-style message log for a node detail page.
 *
 * @module node-page/messages
 */

import { escapeHtml } from '../utils.js';
import { protocolIconPrefixHtml } from '../protocol-helpers.js';
import {
  extractChatMessageMetadata,
  formatChatChannelTag,
  formatChatMessagePrefix,
  formatChatPresetTag,
} from '../chat-format.js';
import { buildMessageIndex } from '../message-replies.js';
import { renderChatEntryContent } from '../chat-entry-renderer.js';
import { formatMessageTimestamp } from '../node-page-charts.js';
import { numberOrNull, stringOrNull } from '../value-helpers.js';
import { renderRoleAwareBadge } from './neighbor-rendering.js';

/**
 * Render the emoji HTML fragment used by the chat entry renderer.
 *
 * Matches the markup emitted by the dashboard chat panel so that both the
 * node detail page and the dashboard use identical emoji styling.
 *
 * @param {string} symbol Emoji character.
 * @returns {string} HTML fragment wrapping the emoji in a chat-entry span.
 */
export function renderNodeChatEmojiHtml(symbol) {
  const trimmed = String(symbol ?? '').trim();
  if (!trimmed) return '';
  return `<span class="chat-entry-emoji" aria-hidden="true">${escapeHtml(trimmed)}</span>`;
}

/**
 * Build a ``nodesById`` Map for chat-entry rendering.
 *
 * Layered sources, in priority order:
 *
 *   1. The global node registry fetched via ``fetchNodesById`` (the same
 *      data the dashboard uses).  This is what allows MeshCore mentions
 *      like ``@[Some Other Node]`` to resolve to a badge instead of
 *      degrading to plain ``@[Name]`` text on the node detail page.
 *   2. Hydrated ``message.node`` objects on the loaded messages — used as
 *      a fallback for senders that may not be in the global registry.
 *   3. The current page's own node, ensuring self-references and the
 *      sender badge resolve even when neither of the above contains it.
 *
 * Known tradeoff: reply targets whose source message lies outside the
 * loaded message window will not resolve via {@link resolveReplyPrefix},
 * so the rendered ``[in reply to ...]`` prefix silently degrades to the
 * empty string for those rows.
 *
 * @param {Array<Object>} messages Message records.
 * @param {?Object} fallbackNode Current page node.
 * @param {?Map<string, Object>} globalNodesById Global node registry.
 * @returns {Map<string, Object>} Lookup map keyed by node identifier.
 */
export function buildNodesById(messages, fallbackNode, globalNodesById) {
  const map = new Map();
  if (globalNodesById instanceof Map) {
    for (const [id, node] of globalNodesById.entries()) {
      if (id && node && typeof node === 'object') map.set(id, node);
    }
  }
  const register = (node) => {
    if (!node || typeof node !== 'object') return;
    const id = node.node_id ?? node.nodeId ?? null;
    if (!id) return;
    if (!map.has(id)) map.set(id, node);
  };
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (!message || typeof message !== 'object') continue;
      register(message.node);
    }
  }
  register(fallbackNode);
  return map;
}

/**
 * Render a message list using structured metadata formatting.
 *
 * Each entry is rendered through the shared {@link renderChatEntryContent}
 * helper so the node detail page mirrors the dashboard chat panel —
 * mentions resolve to badges, MeshCore leading-mention replies surface as
 * an ``[in reply to]`` prefix, emoji are wrapped in ``chat-entry-emoji``
 * spans, and URLs are linkified.
 *
 * @param {Array<Object>} messages Message records.
 * @param {Function} renderShortHtml Badge rendering implementation.
 * @param {Object} node Node context used when message metadata is incomplete.
 * @param {?Map<string, Object>} [globalNodesById] Optional global node
 *   registry used for mention/reply resolution; falls back to message-derived
 *   sender nodes when omitted.
 * @returns {string} HTML string for the messages section.
 */
export function renderMessages(messages, renderShortHtml, node, globalNodesById = null) {
  if (!Array.isArray(messages) || messages.length === 0) return '';

  const fallbackNode = node && typeof node === 'object' ? node : null;
  const nodesById = buildNodesById(messages, fallbackNode, globalNodesById);
  const messagesById = buildMessageIndex(messages);

  const items = messages
    .map(message => {
      if (!message || typeof message !== 'object') return null;
      const hasBody = stringOrNull(message.text) || stringOrNull(message.emoji);
      if (!hasBody) return null;
      // Filter out the canonical empty-payload encrypted marker.  This keeps
      // the original semantics of falling back to ``message.emoji`` when the
      // text field is null (some encrypted packets carry the marker only in
      // the emoji slot).
      if (message.encrypted && String(hasBody).trim() === 'GAA=') {
        return null;
      }

      const timestamp = formatMessageTimestamp(message.rx_time, message.rx_iso);
      const metadata = extractChatMessageMetadata(message);
      if (!metadata.channelName) {
        const fallbackChannel = stringOrNull(
          message.channel_name
            ?? message.channelName
            ?? message.channel_label
            ?? null,
        );
        if (fallbackChannel) {
          metadata.channelName = fallbackChannel;
        } else {
          const numericChannel = numberOrNull(message.channel);
          if (numericChannel != null) {
            metadata.channelName = String(numericChannel);
          } else if (stringOrNull(message.channel)) {
            metadata.channelName = stringOrNull(message.channel);
          }
        }
      }

      const prefix = formatChatMessagePrefix({
        timestamp: escapeHtml(timestamp ?? ''),
        frequency: metadata.frequency ? escapeHtml(metadata.frequency) : null,
      });
      const presetTag = formatChatPresetTag({ presetCode: metadata.presetCode });
      const channelTag = formatChatChannelTag({ channelName: metadata.channelName });

      // Render the message body through the shared chat-entry renderer so
      // the node page matches the dashboard in mention/reply/emoji handling.
      const { html: bodyHtml, meshcoreSenderNode } = renderChatEntryContent({
        message,
        nodesById,
        messagesById,
        renderShortHtml,
        escapeHtml,
        renderEmojiHtml: renderNodeChatEmojiHtml,
      });

      // Resolve the sender badge.  When the ingestor could not hydrate
      // ``message.node`` for a MeshCore channel message, fall back to the
      // node resolved by the shared renderer via the sender-prefix lookup.
      const senderNode = message.node && typeof message.node === 'object'
        ? message.node
        : (meshcoreSenderNode && typeof meshcoreSenderNode === 'object' ? meshcoreSenderNode : null);
      const messageProtocol = stringOrNull(senderNode?.protocol ?? fallbackNode?.protocol) ?? null;
      const protocolIconHtml = protocolIconPrefixHtml(messageProtocol);
      const badgeHtml = renderRoleAwareBadge(renderShortHtml, {
        shortName: senderNode?.short_name ?? senderNode?.shortName ?? fallbackNode?.shortName ?? fallbackNode?.short_name,
        longName: senderNode?.long_name ?? senderNode?.longName ?? fallbackNode?.longName ?? fallbackNode?.long_name,
        role: senderNode?.role ?? fallbackNode?.role ?? null,
        identifier:
          message.node_id
            ?? message.nodeId
            ?? message.from_id
            ?? message.fromId
            ?? senderNode?.node_id
            ?? senderNode?.nodeId
            ?? fallbackNode?.nodeId
            ?? fallbackNode?.node_id
            ?? null,
        numericId:
          message.node_num
            ?? message.nodeNum
            ?? message.from_num
            ?? message.fromNum
            ?? senderNode?.node_num
            ?? senderNode?.nodeNum
            ?? fallbackNode?.nodeNum
            ?? fallbackNode?.node_num
            ?? null,
        source: senderNode ?? fallbackNode?.rawSources?.node ?? fallbackNode,
      });

      return `<div class="chat-entry-msg">${prefix}${presetTag}${channelTag} ${protocolIconHtml}${badgeHtml} ${bodyHtml}</div>`;
    })
    .filter(item => item != null);
  if (items.length === 0) return '';
  // Wrap entries in the same chat-panel chrome the dashboard and chat sub
  // pages use so this section visually matches a real chat panel rather
  // than a plain bullet list.  ``chat-tabpanel`` provides the scrollable
  // padded inner container; ``chat-panel--node-detail`` is a hook for any
  // node-page-specific overrides (height, border behaviour) that we want
  // distinct from the dashboard's 60vh default.
  return (
    '<div class="chat-panel chat-panel--node-detail" aria-label="Chat log">'
    + '<div class="chat-tabpanel">'
    + items.join('')
    + '</div>'
    + '</div>'
  );
}
