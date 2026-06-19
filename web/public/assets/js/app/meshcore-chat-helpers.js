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

import { isMeshcoreProtocol } from './protocol-helpers.js';

/**
 * Parse the ``"SenderName: body"`` prefix that MeshCore embeds in channel
 * message text.  MeshCore channel messages do not carry a sender node ID, so
 * the ingestor stores ``from_id = null`` and encodes the sender long name as
 * the leading ``"SenderName: "`` prefix of the message text.
 *
 * Only the first colon is treated as the separator; colons that appear in the
 * body are preserved unchanged.
 *
 * @param {string|null|undefined} text Raw message text from the database.
 * @returns {{ senderName: string, bodyText: string }|null} Parsed components,
 *   or ``null`` when the text does not match the expected format.
 */
export function parseMeshcoreSenderPrefix(text) {
  if (text == null || typeof text !== 'string') return null;
  const colonIdx = text.indexOf(':');
  if (colonIdx < 0) return null;
  const senderName = text.slice(0, colonIdx).trim();
  if (!senderName) return null;
  const bodyText = text.slice(colonIdx + 1).trim();
  return { senderName, bodyText };
}

/**
 * Whether a candidate node belongs to the same protocol as the message that
 * referenced it.  Node and message protocols are reduced to the two canonical
 * values (anything not explicitly MeshCore — including absent/unknown — is the
 * Meshtastic default), so a MeshCore message never matches a Meshtastic (or
 * unstamped) node and vice-versa.  A ``null`` requested protocol disables the
 * filter, preserving the original protocol-agnostic behaviour for callers that
 * have no protocol context.
 *
 * @param {Object} node Candidate node record.
 * @param {string|null|undefined} protocol Protocol of the referencing message.
 * @returns {boolean} Whether the node may be matched for this protocol.
 */
function nodeMatchesProtocol(node, protocol) {
  if (protocol == null) return true;
  return isMeshcoreProtocol(protocol) === isMeshcoreProtocol(node && node.protocol);
}

/**
 * Look up a node in the provided ``nodesById`` Map by its long name.
 *
 * The comparison is case-sensitive because both the ingestor and the MeshCore
 * firmware emit the name verbatim; normalising case would risk false matches
 * between nodes whose names differ only in capitalisation.
 *
 * Both the snake_case (``long_name``) and camelCase (``longName``) property
 * variants are checked to accommodate different serialisation paths.
 *
 * When ``protocol`` is supplied, only nodes of that protocol are eligible.
 * Long names collide across protocols (a MeshCore and a Meshtastic node can
 * both be called "Timo"), so without this filter the scan would return whichever
 * node happens to come first in insertion order — letting a MeshCore message
 * quote a Meshtastic node.  Filtering by the referencing message's protocol is
 * what keeps chat resolution protocol-correct.
 *
 * This is an O(n) scan over all nodes. For the typical node counts seen in
 * practice (hundreds) this is negligible; a long-name index is not maintained
 * in the client-side Map because insertions and lookups occur at different
 * phases of the rendering pipeline.
 *
 * @param {string} longName Long name to search for.
 * @param {Map<string, object>} nodesById Loaded node registry keyed by node ID.
 * @param {string|null} [protocol] Protocol the matched node must belong to;
 *   ``null``/omitted matches any protocol (legacy behaviour).
 * @returns {object|null} The first matching node of the requested protocol, or
 *   ``null`` when not found.
 */
export function findNodeByLongName(longName, nodesById, protocol = null) {
  if (!longName || typeof longName !== 'string') return null;
  if (!(nodesById instanceof Map)) return null;
  const trimmed = longName.trim();
  if (!trimmed) return null;

  // Two-pass scan: O(2N) worst case (no match found).  Fine for typical
  // mesh sizes (hundreds of nodes); if registries grow into the thousands
  // and lookup becomes hot, consider building a normalised long-name index
  // alongside the id-keyed map at hydration time.

  // First pass: exact match on trimmed candidate long names.
  for (const node of nodesById.values()) {
    if (!nodeMatchesProtocol(node, protocol)) continue;
    const raw = node.long_name ?? node.longName;
    if (typeof raw !== 'string') continue;
    if (raw.trim() === trimmed) return node;
  }

  // Second pass: fallback match after stripping leading non-letter/non-digit
  // characters (emoji, punctuation, spaces) from the candidate.  Handles
  // messages that reference a node by its semantic name without the emoji
  // prefix the node carries in the registry — e.g. @[Timo +] matching
  // a node whose long_name is "📺 Timo +".
  for (const node of nodesById.values()) {
    if (!nodeMatchesProtocol(node, protocol)) continue;
    const raw = node.long_name ?? node.longName;
    if (typeof raw !== 'string') continue;
    const stripped = raw.replace(/^[^\p{L}\p{N}]+/u, '').trim();
    if (stripped && stripped === trimmed) return node;
  }

  return null;
}

/**
 * Build a synthetic stand-in node for a chat name reference that no
 * same-protocol registry node matched.
 *
 * Carrying the referencing message's protocol keeps the rendered badge's colour
 * palette and protocol icon correct and — crucially — guarantees a MeshCore
 * message renders a MeshCore-stamped badge instead of borrowing a colliding
 * node from another protocol.  This mirrors the protocol-stamped placeholder
 * the message hydrator builds for unknown senders
 * (``message-node-hydrator``), but is keyed on the visible name rather than a
 * node id because mentions/quotes reference nodes by name.
 *
 * The visible name is used as both the short and long name so the badge stays
 * legible (a bare ``long_name`` would render as a ``?`` placeholder).
 *
 * @param {string} name Visible name parsed from the message (mention/sender).
 * @param {string|null|undefined} protocol Protocol of the referencing message.
 * @returns {{short_name: string, long_name: string, protocol?: string}}
 *   Synthetic node ready for badge rendering.
 */
export function buildSyntheticChatNode(name, protocol) {
  const node = { short_name: name, long_name: name };
  if (protocol != null) node.protocol = protocol;
  return node;
}

/**
 * Extract a leading ``@[Name]`` mention from text if it looks like a reply.
 *
 * MeshCore does not carry a structured ``reply_id`` on replies; instead, the
 * sender's client prepends ``@[Author]`` to the body when quoting a previous
 * message.  When the body starts with exactly one mention and no other
 * mentions appear in the text, we treat that as a reply and surface it as an
 * ``[in reply to BADGE]`` prefix, similar to Meshtastic's reply rendering.
 *
 * Names captured from ``@[...]`` are trimmed so that ``@[ Timo +]`` or
 * ``@[T-deck NK ]`` resolve correctly against the registry.
 *
 * @param {?string} text Message text to inspect.
 * @returns {{ mentionName: string, remainingText: ?string }|null}
 *   Parsed components, or ``null`` when the text does not begin with a single
 *   mention.
 */
export function extractLeadingMentionAsReply(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith('@[')) return null;

  // Total mention count must be exactly one for the message to qualify as a
  // single-mention reply (multiple mentions are ambiguous — treat as regular
  // mentions instead).
  const allMentions = trimmed.match(/@\[[^\]]+\]/g);
  if (!allMentions || allMentions.length !== 1) return null;

  const match = trimmed.match(/^@\[([^\]]+)\]\s*([\s\S]*)$/);
  if (!match) return null;
  const mentionName = match[1].trim();
  if (!mentionName) return null;
  const rest = match[2].trim();
  return { mentionName, remainingText: rest.length > 0 ? rest : null };
}
