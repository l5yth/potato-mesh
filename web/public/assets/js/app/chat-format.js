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
 * Extract channel metadata from a message payload for chat display.
 *
 * @param {Object} message Raw message payload from the API.
 * @returns {{
 *   frequency: string|null,
 *   channelName: string|null,
 *   presetCode: string|null,
 *   presetName: string|null
 * }} Normalized metadata values. ``presetCode`` is the two-character slot,
 *   ``presetName`` the preset as people read it (``MediumFast``, ``EU/UK
 *   Narrow``), shown in the line's time title (SPEC CD1).
 */
export function extractChatMessageMetadata(message) {
  if (!message || typeof message !== 'object') {
    return { frequency: null, channelName: null, presetCode: null, presetName: null };
  }

  const frequency = normalizeFrequency(
    firstNonNull(
      message.region_frequency,
      message.regionFrequency,
      message.lora_freq,
      message.loraFreq,
      message.frequency
    )
  );

  const channelName = normalizeString(
    firstNonNull(message.channel_name, message.channelName)
  );

  const modemPreset = normalizePresetString(resolveModemPresetCandidate(message));
  const numericFreq = frequency != null ? Number(frequency) : null;
  const presetCode = modemPreset ? abbreviatePreset(modemPreset, numericFreq) : null;
  const presetName = modemPreset ? formatPresetDisplay(modemPreset, numericFreq) : null;

  return { frequency, channelName, presetCode, presetName };
}

/**
 * Render the channel tag that follows the short name in a chat message entry.
 *
 * Empty channel names remain blank within the brackets, mirroring the original
 * UI behaviour that reserves the slot without introducing placeholder text.
 *
 * The channel name originates from untrusted, attacker-controllable data (a
 * MeshCore/Meshtastic channel name can be set to arbitrary text by any radio
 * on the mesh), so it is escaped here before being embedded in the returned
 * HTML string. Callers must pass the *raw* channel name — pre-escaping it
 * before calling this function would cause double-escaping.
 *
 * @param {{ channelName: string|null }} params Raw (unescaped) channel name.
 * @returns {string} Channel tag suitable for HTML insertion.
 */
export function formatChatChannelTag({ channelName }) {
  const channel = typeof channelName === 'string' ? channelName : channelName == null ? '' : String(channelName);
  return `[${escapeHtml(channel)}]`;
}

/**
 * Render the preset hint bracket of the node page's `[freq][preset]` tag.
 *
 * @param {{ presetCode: string|null }} params Normalized preset abbreviation.
 * @returns {string} HTML-ready bracket slot.
 */
export function formatChatPresetTag({ presetCode }) {
  const slot = normalizePresetSlot(presetCode);
  return `[${slot}]`;
}

/**
 * Render the time slot that leads a chat message line, the first column of
 * its grid (SPEC CD1). Both values are escaped here.
 *
 * @param {string} text Visible time: the dashboard's ``08:01``, or the node
 *   page's date-bearing ``[2026-10-08 08:01]``.
 * @param {string} [title=''] Tooltip; none when empty.
 * @returns {string} ``<span class="chat-entry-time">`` HTML.
 */
export function formatChatTimeSlot(text, title = '') {
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
  return `<span class="chat-entry-time"${titleAttr}>${escapeHtml(text)}</span>`;
}

/**
 * Render the time slot of a dashboard chat line (SPEC CD1, LA1): ``HH:MM``,
 * with the full ``HH:MM:SS``, the frequency and the preset in its title, for
 * messages and Log announcements alike. A value the line does not know is
 * left out of the title.
 *
 * @param {{ timestamp: string, frequency?: ?string, preset?: ?string }} params
 *   Raw (unescaped) ``HH:MM:SS`` time (``--:--:--`` when unknown), frequency
 *   in MHz and preset name.
 * @returns {string} ``<span class="chat-entry-time">`` HTML.
 */
export function formatChatEntryTime({ timestamp, frequency = null, preset = null }) {
  const details = [timestamp, frequency ? `${frequency} MHz` : null, preset].filter(Boolean).join(' · ');
  return formatChatTimeSlot(timestamp.slice(0, 5), details);
}

/**
 * Render the frequency and preset slots of a node-page chat line, such as
 * ``[869][MF]`` (SPEC CD1). A missing value keeps its slot, filled with
 * non-breaking spaces. The dashboard chat shows {@link formatChatRadioCode}
 * instead (SPEC LA5).
 *
 * @param {{ frequency: ?string, presetCode: ?string }} params Raw (unescaped)
 *   frequency and preset abbreviation, as {@link extractChatMessageMetadata}
 *   returns them.
 * @returns {string} HTML-ready slots; the frequency is escaped here.
 */
export function formatChatRadioTag({ frequency, presetCode }) {
  const freq = frequency ? escapeHtml(frequency) : FREQUENCY_PLACEHOLDER;
  return `[${freq}]${formatChatPresetTag({ presetCode })}`;
}

/**
 * Display names of the protocols, for the radio code's title.
 *
 * @type {Readonly<Record<string, string>>}
 */
const PROTOCOL_LABELS = Object.freeze({ meshtastic: 'Meshtastic', meshcore: 'MeshCore', reticulum: 'Reticulum' });

/**
 * Render the radio tag of a dashboard chat line that needs one (SPEC LA5,
 * CD2): the preset code alone, such as ``MF`` or ``NA``, in
 * ``<span class="chat-entry-radio">``, titled with the frequency, the preset
 * name and the protocol (``869 MHz · MediumFast · Meshtastic``). A title
 * leaves out a value the line does not know; a radio without a preset code
 * gets no tag.
 *
 * @param {{ frequency: ?string, presetCode: ?string, presetName?: ?string }} metadata
 *   Raw (unescaped) values, as {@link extractChatMessageMetadata} returns them.
 * @param {?string} [protocol] The line's protocol.
 * @returns {string} The tag's HTML, or ``''``.
 */
export function formatChatRadioCode({ frequency, presetCode, presetName = null }, protocol = null) {
  const code = normalizePresetSlot(presetCode);
  if (code === PRESET_PLACEHOLDER) return '';
  const protocolKey = normalizeString(protocol);
  // Own keys only: `constructor` is inherited by every plain object.
  const protocolLabel = protocolKey && Object.hasOwn(PROTOCOL_LABELS, protocolKey.toLowerCase())
    ? PROTOCOL_LABELS[protocolKey.toLowerCase()]
    : protocolKey;
  const title = [frequency ? `${frequency} MHz` : null, presetName, protocolLabel].filter(Boolean).join(' · ');
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
  return `<span class="chat-entry-radio"${titleAttr}>${escapeHtml(code)}</span>`;
}

/**
 * Lay out a chat message line (SPEC CD1): the time slot, then the rest of the
 * line in one ``.chat-entry-body`` span, the grid's second column, so wrapped
 * lines land under the body.
 *
 * @param {string} timeHtml Time slot from {@link formatChatEntryTime} or
 *   {@link formatChatTimeSlot}.
 * @param {string} bodyHtml The rest of the line.
 * @returns {string} The line's inner HTML.
 */
export function formatChatLine(timeHtml, bodyHtml) {
  return `${timeHtml} <span class="chat-entry-body">${bodyHtml}</span>`;
}

/**
 * Key of the radio tag a chat line renders (SPEC CD2, LA1): what the tag
 * shows, its preset code and its protocol. The frequency only titles the
 * code, so a line without a frequency of its own, which takes its node's
 * preset, keys like the lines that have one. Lines with one key render the
 * same tag, so a tab whose lines all share a key can drop it. A line without
 * a preset code renders no code and has no key, such as a placeholder node
 * the server made for an unheard hop.
 *
 * @param {?Object} message Message payload, or the node record or snapshot
 *   a Log announcement takes its radio from.
 * @param {?string} [protocol] The line's protocol; by default the message's,
 *   else its node's.
 * @returns {?string} The key, or ``null`` for a line that renders no code.
 */
export function chatRadioKey(message, protocol = messageProtocol(message)) {
  const slot = normalizePresetSlot(extractChatMessageMetadata(message).presetCode);
  if (slot === PRESET_PLACEHOLDER) return null;
  return JSON.stringify([slot, normalizeString(protocol)]);
}

/**
 * Whether no two items render different radio tags (SPEC CD2, LA1): a tab or
 * the Log drops the radio tag of its lines when they do not. An item whose
 * key is ``null`` renders no code and does not count.
 *
 * @param {Iterable<*>} items Lines, entries or messages.
 * @param {function(*): ?string} keyOf Radio key of an item, such as
 *   {@link chatRadioKey}.
 * @returns {boolean} `false` when two items have different keys, else `true`.
 */
export function sharesOneRadio(items, keyOf) {
  let first = null;
  for (const item of items) {
    const key = keyOf(item);
    if (key === null) continue;
    if (first === null) {
      first = key;
    } else if (key !== first) {
      return false;
    }
  }
  return true;
}

/**
 * Protocol of a chat line: the message's own, else its node's, trimmed, as
 * the dashboard picks it for the line's radio code title.
 *
 * @param {?Object} message Message payload.
 * @returns {?string} The protocol, or ``null`` when neither names one.
 */
function messageProtocol(message) {
  for (const source of [message, message?.node]) {
    const protocol = normalizeString(source?.protocol);
    if (protocol) return protocol;
  }
  return null;
}

/**
 * HTML entity sequence inserted when a frequency is unavailable.
 *
 * Three non-breaking spaces are used rather than a dash or empty string so
 * the bracket slot keeps its fixed width in monospaced log displays.  This
 * value is inserted directly into HTML; it must never be HTML-escaped again.
 * @type {string}
 */
const FREQUENCY_PLACEHOLDER = '&nbsp;&nbsp;&nbsp;';

/**
 * HTML placeholder for missing preset abbreviations.
 *
 * Two non-breaking spaces preserve the two-character column width expected
 * by operators reading the chat log.  Like FREQUENCY_PLACEHOLDER, this value
 * is already an HTML entity string and must not be escaped a second time.
 * @type {string}
 */
const PRESET_PLACEHOLDER = '&nbsp;&nbsp;';

/**
 * Canonical preset abbreviations keyed by a normalized preset token.
 *
 * Keys are lowercased, non-alphabetic characters stripped so the lookup is
 * insensitive to casing and delimiter differences (e.g. ``"LONG_FAST"``
 * and ``"LongFast"`` both resolve to ``"LF"``).  Unmapped presets fall
 * back to {@link derivePresetInitials}.
 * @type {Record<string, string>}
 */
const PRESET_ABBREVIATIONS = {
  verylongslow: 'VL',
  longslow: 'LS',
  longmoderate: 'LM',
  longfast: 'LF',
  mediumslow: 'MS',
  mediumfast: 'MF',
  shortslow: 'SS',
  shortfast: 'SF',
  shortturbo: 'ST',
};

/**
 * Return the first value in ``candidates`` that is not ``null`` or ``undefined``.
 *
 * @param {...*} candidates Candidate values.
 * @returns {*} First present value or ``null`` when missing.
 */
function firstNonNull(...candidates) {
  for (const value of candidates) {
    if (value !== null && value !== undefined) {
      return value;
    }
  }
  return null;
}

// normalizeString and escapeHtml are the canonical implementations in
// utils.js; imported here so callers of chat-format.js that use them
// directly continue to work.
import { normalizeString, escapeHtml } from './utils.js';
import { formatPresetDisplay, resolveMeshcorePresetDisplay } from './node-modem-metadata.js';

/**
 * Convert various frequency representations into clean strings.
 *
 * @param {*} value Raw frequency value.
 * @returns {string|null} Frequency in MHz as a string, when available.
 */
function normalizeFrequency(value) {
  if (value == null) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) {
      return null;
    }
    return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const numericMatch = trimmed.match(/\d+(?:\.\d+)?/);
    if (numericMatch) {
      const parsed = Number(numericMatch[0]);
      if (Number.isFinite(parsed) && parsed > 0) {
        return Number.isInteger(parsed) ? String(Math.trunc(parsed)) : String(parsed);
      }
    }
    return trimmed;
  }
  return null;
}

/**
 * Resolve a modem preset candidate from the provided source object.
 *
 * @param {*} source Source payload potentially containing modem metadata.
 * @param {Set<object>} [visited] Visited references to avoid recursion loops.
 * @returns {*|null} Raw modem preset candidate.
 */
function resolveModemPresetCandidate(source, visited = new Set()) {
  if (!source || typeof source !== 'object') {
    return null;
  }
  if (visited.has(source)) {
    return null;
  }
  visited.add(source);

  const candidate = firstNonNull(
    source.modemPreset,
    source.modem_preset,
    source.modempreset,
    source.ModemPreset
  );
  if (candidate != null) {
    return candidate;
  }

  if (source.node && typeof source.node === 'object') {
    const nested = resolveModemPresetCandidate(source.node, visited);
    if (nested != null) {
      return nested;
    }
  }

  return null;
}

/**
 * Convert arbitrary preset input to a trimmed string.
 *
 * @param {*} value Raw preset candidate.
 * @returns {string|null} Clean preset string.
 */
function normalizePresetString(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number') {
    return String(value);
  }
  return null;
}

/**
 * Produce a two-character abbreviation for a modem preset.
 *
 * SF/BW/CR preset strings (MeshCore) are resolved via
 * {@link resolveMeshcorePresetDisplay} so they bypass the Meshtastic
 * initials-derivation path entirely.  Meshtastic named presets (e.g.
 * ``"MediumFast"``) are unaffected.
 *
 * @param {string} preset Normalized preset string.
 * @param {number|null} [freqMHz] Frequency in MHz, used for frequency-gated lookups.
 * @returns {string|null} Uppercase abbreviation or ``null``.
 */
function abbreviatePreset(preset, freqMHz = null) {
  if (!preset) {
    return null;
  }
  // MeshCore SF/BW/CR presets take priority over the Meshtastic lookup table.
  const resolved = resolveMeshcorePresetDisplay(preset, freqMHz);
  if (resolved !== null) {
    return resolved.shortCode;
  }
  const token = preset.replace(/[^A-Za-z]/g, '').toLowerCase();
  // Own keys only: `constructor` is inherited by every plain object.
  if (token && Object.hasOwn(PRESET_ABBREVIATIONS, token)) {
    return PRESET_ABBREVIATIONS[token];
  }
  return derivePresetInitials(preset);
}

/**
 * Generate fallback initials for unmapped presets.
 *
 * @param {string} preset Raw preset string.
 * @returns {string|null} Derived initials.
 */
function derivePresetInitials(preset) {
  if (!preset) {
    return null;
  }
  const spaced = preset.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  const tokens = spaced
    .split(/[\s_-]+/)
    .map(part => part.replace(/[^A-Za-z]/g, ''))
    .filter(Boolean);
  if (tokens.length === 0) {
    return null;
  }
  if (tokens.length === 1) {
    const upper = tokens[0].toUpperCase();
    if (upper.length >= 2) {
      return upper.slice(0, 2);
    }
    if (upper.length === 1) {
      return `${upper}?`;
    }
    return null;
  }
  const initials = tokens.map(part => part[0].toUpperCase());
  if (initials.length >= 2) {
    return `${initials[0]}${initials[1]}`;
  }
  return null;
}

/**
 * Normalise the preset slot contents for the bracket display.
 *
 * @param {*} value Raw preset code.
 * @returns {string} HTML-ready preset slot.
 */
function normalizePresetSlot(value) {
  if (value == null) {
    return PRESET_PLACEHOLDER;
  }
  const trimmed = String(value).trim().toUpperCase();
  return trimmed.length > 0 ? trimmed.slice(0, 2) : PRESET_PLACEHOLDER;
}

export const __test__ = {
  firstNonNull,
  normalizeString,
  normalizeFrequency,
  FREQUENCY_PLACEHOLDER,
  formatChatChannelTag,
  resolveModemPresetCandidate,
  normalizePresetString,
  abbreviatePreset,
  derivePresetInitials,
  normalizePresetSlot,
  PRESET_PLACEHOLDER
};
