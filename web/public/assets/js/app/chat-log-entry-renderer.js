/*
 * Copyright (C) 2025 l5yth
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
 * Human-readable labels describing mesh broadcast events rendered within the
 * chat log.
 *
 * @type {Record<'telemetry' | 'position' | 'neighbor', string>}
 */
export const EVENT_LABELS = {
  telemetry: 'broadcasted telemetry',
  position: 'broadcasted position info',
  neighbor: 'broadcasted neighbor info'
};

/**
 * Construct a DOM node representing a broadcast event entry within the chat
 * panel.
 *
 * @param {{
 *   document: Document,
 *   logEntry: {
 *     ts: number,
 *     kind: 'telemetry' | 'position' | 'neighbor',
 *     node?: ?Object,
 *     entry: Object
 *   },
 *   renderShortHtml: Function,
 *   extractChatMessageMetadata: Function,
 *   formatNodeAnnouncementPrefix: Function,
 *   escapeHtml: Function,
 *   formatTime: Function
 * }} params Rendering dependencies and log entry metadata.
 * @returns {?HTMLElement} Constructed element or ``null`` when rendering is not
 *   possible.
 */
export function createBroadcastLogEntryElement({
  document,
  logEntry,
  renderShortHtml,
  extractChatMessageMetadata,
  formatNodeAnnouncementPrefix,
  escapeHtml,
  formatTime
}) {
  if (!document || !logEntry || typeof logEntry !== 'object') {
    return null;
  }
  const label = EVENT_LABELS[logEntry.kind];
  if (!label) {
    return null;
  }
  const container = document.createElement('div');
  container.className = `chat-entry-event chat-entry-${logEntry.kind}`;

  const tsSeconds = Number.isFinite(logEntry.ts) ? logEntry.ts : null;
  const tsString = tsSeconds != null ? formatTime(new Date(tsSeconds * 1000)) : '--:--:--';

  const badgeSource = selectBadgeSource(logEntry);
  const shortHtml = renderShortHtml(
    badgeSource.shortName,
    badgeSource.role,
    badgeSource.longName,
    badgeSource.nodePayload
  );

  const frequency = resolveFrequency({ logEntry, extractChatMessageMetadata });
  const prefix = formatNodeAnnouncementPrefix({
    timestamp: escapeHtml(tsString),
    frequency: frequency ? escapeHtml(frequency) : ''
  });

  container.innerHTML = `${prefix} ${shortHtml} ${escapeHtml(label)}`;
  return container;
}

/**
 * Derive the metadata required to render a short-name badge for the log entry.
 *
 * @param {{ logEntry: Object }} ctx Wrapper containing the log entry.
 * @returns {{
 *   shortName: ?string,
 *   role: ?string,
 *   longName: ?string,
 *   nodePayload: ?Object
 * }} Badge rendering metadata.
 */
function selectBadgeSource(logEntry) {
  const nodeCandidate = logEntry.node && typeof logEntry.node === 'object' ? logEntry.node : null;
  const entryCandidate = logEntry.entry && typeof logEntry.entry === 'object' ? logEntry.entry : null;
  const source = nodeCandidate || entryCandidate || {};
  const shortName = source.short_name ?? source.shortName ?? null;
  const role = source.role ?? null;
  const longName = source.long_name ?? source.longName ?? '';
  return {
    shortName,
    role,
    longName,
    nodePayload: source
  };
}

/**
 * Determine the most relevant frequency value for the broadcast entry.
 *
 * @param {{
 *   logEntry: Object,
 *   extractChatMessageMetadata: Function
 * }} params Frequency derivation dependencies.
 * @returns {?string} Frequency string when discovered.
 */
function resolveFrequency({ logEntry, extractChatMessageMetadata }) {
  const candidates = [logEntry.entry, logEntry.node];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') {
      continue;
    }
    const metadata = extractChatMessageMetadata(candidate);
    if (metadata && metadata.frequency) {
      return metadata.frequency;
    }
  }
  return null;
}

export const __test__ = {
  selectBadgeSource,
  resolveFrequency
};
