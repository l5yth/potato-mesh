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
 * Look up a node in the provided ``nodesById`` Map by its long name.
 *
 * The comparison is case-sensitive because both the ingestor and the MeshCore
 * firmware emit the name verbatim; normalising case would risk false matches
 * between nodes whose names differ only in capitalisation.
 *
 * Both the snake_case (``long_name``) and camelCase (``longName``) property
 * variants are checked to accommodate different serialisation paths.
 *
 * This is an O(n) scan over all nodes. For the typical node counts seen in
 * practice (hundreds) this is negligible; a long-name index is not maintained
 * in the client-side Map because insertions and lookups occur at different
 * phases of the rendering pipeline.
 *
 * @param {string} longName Long name to search for.
 * @param {Map<string, object>} nodesById Loaded node registry keyed by node ID.
 * @returns {object|null} The first matching node, or ``null`` when not found.
 */
export function findNodeByLongName(longName, nodesById) {
  if (!longName || typeof longName !== 'string') return null;
  if (!(nodesById instanceof Map)) return null;
  for (const node of nodesById.values()) {
    const candidate = node.long_name ?? node.longName;
    if (typeof candidate === 'string' && candidate === longName) return node;
  }
  return null;
}
