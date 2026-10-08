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
 * Sender marker for chat lines (SPEC SV3, amended 2026-10-08).
 *
 * A MeshCore channel message names its sender only in the ``Name:`` prefix of
 * its text, which no key backs. The web app serves such a row with
 * ``sender_verified: false`` (SPEC SV2). The dashboard chat and the node page
 * keep an "unverified" element, titled "Sender not verified", right after the
 * sender badge of such a line, but with the ``hidden`` attribute: its class
 * and title stay in the DOM for inspection, while nothing shows and nothing
 * takes space. A row served with ``sender_verified: true`` gets a small
 * visible "verified" tag in the same place instead. The API sends no such
 * row today, so no tag shows yet. A row without the key gets nothing.
 *
 * @module chat-sender-marker
 */

/**
 * Title of the marker, kept for inspection while the marker is hidden.
 *
 * @type {string}
 */
export const SENDER_UNVERIFIED_LABEL = 'Sender not verified';

/**
 * Text of the marker, kept for inspection while the marker is hidden.
 *
 * @type {string}
 */
export const SENDER_UNVERIFIED_TEXT = 'unverified';

/**
 * Tooltip of the verified tag.
 *
 * @type {string}
 */
export const SENDER_VERIFIED_LABEL = 'Sender verified';

/**
 * Visible text of the verified tag.
 *
 * @type {string}
 */
export const SENDER_VERIFIED_TEXT = 'verified';

/**
 * Whether a chat line's sender was attributed by name rather than by an id
 * the packet carries.
 *
 * @param {?Object} message Message payload.
 * @param {{ senderFromText?: boolean }} [options] ``senderFromText``: the
 *   renderer named the sender badge from the line's ``Name:`` prefix itself,
 *   which it does for a MeshCore channel line that came with no sender id
 *   (posted by an ingestor before 0.6.0).
 * @returns {boolean} ``true`` when the row carries ``sender_verified: false``
 *   or the badge was named from the text.
 */
export function isSenderUnverified(message, { senderFromText = false } = {}) {
  if (senderFromText === true) return true;
  return message != null && typeof message === 'object' && message.sender_verified === false;
}

/**
 * Render the sender marker of a chat line, placed right after the sender
 * badge and outside the 19ch prefix (FU9).
 *
 * An unverified sender ({@link isSenderUnverified}) gets the "unverified"
 * marker with the ``hidden`` attribute and no leading space, so the line
 * reads and spaces exactly as without it. A row with ``sender_verified:
 * true`` gets the visible "verified" tag, unless the badge was named from the
 * text: such a sender is unverified whatever the row says.
 *
 * @param {?Object} message Message payload.
 * @param {{ senderFromText?: boolean }} [options] See
 *   {@link isSenderUnverified}.
 * @returns {string} HTML for the hidden marker, the verified tag with a
 *   leading space, or ``''`` for a row without the key.
 */
export function formatChatSenderMarker(message, options = {}) {
  if (isSenderUnverified(message, options)) {
    return `<span class="chat-sender-unverified" title="${SENDER_UNVERIFIED_LABEL}" hidden>${SENDER_UNVERIFIED_TEXT}</span>`;
  }
  // Only the literal true counts; the API serves no such value yet (SPEC SV2).
  if (message?.sender_verified !== true) return '';
  return ` <span class="chat-sender-verified" title="${SENDER_VERIFIED_LABEL}">${SENDER_VERIFIED_TEXT}</span>`;
}
