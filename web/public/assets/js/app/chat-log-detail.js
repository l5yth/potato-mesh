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
 * The words of a Log line (SPEC LA2, LA3): every announcement reads
 * `BADGE kind · detail`.
 *
 * A lowercase kind word in `<span class="chat-entry-kind">` follows the
 * badge where a colour emoji used to lead the copy, then one middle dot and
 * the detail. This module renders the kind and the detail of each entry type
 * as a *part* ({@link ChatLogPart}); `main.js` frames the parts with the
 * line's time, radio code and badge. A folded burst (SPEC LA4,
 * `chat-log-burst.js`) lists several parts on one line.
 *
 * Telemetry shows at most three values, as units without labels, in one
 * fixed order ({@link TELEMETRY_LOG_ORDER}): the values that changed since
 * the node's earlier telemetry in the Log, all of them on its first line.
 * The full set goes in the part's title.
 *
 * @module chat-log-detail
 */

import { CHAT_LOG_ENTRY_TYPES } from './chat-log-tabs.js';
import { CHAT_LOG_BURST_TYPE } from './chat-log-burst.js';
import { formatPositionHighlights, resolvePositionCoordinates } from './chat-log-highlights.js';
import { TELEMETRY_FIELDS, collectTelemetryMetrics } from './short-info-telemetry.js';
import { FALLBACK_GLYPH, waypointGlyph } from './main/waypoint-layer.js';
import { formatTime, pickFirstProperty, timeHum, toFiniteNumber } from './main/format-utils.js';
import { escapeHtml } from './utils.js';

/**
 * The kind word of each Log entry type (SPEC LA2). It replaces the colour
 * emoji that led the copy (☀️ 💾 🔋 📍 🏘️ 📌 👣 🔒).
 *
 * @type {Readonly<Record<string, string>>}
 */
export const CHAT_LOG_KIND_WORDS = Object.freeze({
  [CHAT_LOG_ENTRY_TYPES.NODE_NEW]: 'new node',
  [CHAT_LOG_ENTRY_TYPES.NODE_INFO]: 'node info',
  [CHAT_LOG_ENTRY_TYPES.TELEMETRY]: 'telemetry',
  [CHAT_LOG_ENTRY_TYPES.POSITION]: 'position',
  [CHAT_LOG_ENTRY_TYPES.NEIGHBOR]: 'neighbor',
  [CHAT_LOG_ENTRY_TYPES.WAYPOINT]: 'waypoint',
  [CHAT_LOG_ENTRY_TYPES.TRACE]: 'trace',
  [CHAT_LOG_ENTRY_TYPES.MESSAGE_ENCRYPTED]: 'encrypted',
});

/**
 * Separator between a kind and its detail, between telemetry values, and
 * between the parts of a folded burst: the middle dot of the route chip.
 *
 * @type {string}
 */
export const CHAT_LOG_SEPARATOR = ' · ';

/**
 * One kind and its detail, as a Log line or a folded burst lists it.
 *
 * @typedef {Object} ChatLogPart
 * @property {string} kind Kind word, from {@link CHAT_LOG_KIND_WORDS}.
 * @property {string} [detailHtml] Detail, HTML-safe; empty for none.
 * @property {string} [detailText] The detail as plain text, for the search
 *   (SPEC LA3); parts whose detail ``main.js`` renders (a link, badges) have
 *   none and the search reads their entry instead.
 * @property {string} [title] Raw (unescaped) tooltip text: what the detail
 *   leaves out. Empty for none.
 * @property {string} [time] Raw `HH:MM:SS` of the part; a folded burst puts
 *   it at the start of the part's title.
 */

/**
 * Render a kind word (SPEC LA2).
 *
 * @param {string} kind Kind word.
 * @returns {string} `<span class="chat-entry-kind">` HTML.
 */
export function formatChatKind(kind) {
  return `<span class="chat-entry-kind">${escapeHtml(kind)}</span>`;
}

/**
 * Render the parts of one Log line. A single part reads `kind · detail`. A
 * folded burst (`folded`) reads `kind · detail · kind detail · kind detail`:
 * the dot joins the first kind to its detail and then separates the parts,
 * and each part's title starts with its own time (SPEC LA4).
 *
 * @param {Array<ChatLogPart>} parts Parts in arrival order.
 * @param {{ folded?: boolean }} [options] Whether the line folds a burst.
 * @returns {string} The parts' HTML, each in a `<span class="chat-entry-part">`.
 */
export function formatChatLogParts(parts, { folded = false } = {}) {
  return parts
    .map((part, index) => {
      const title = [folded ? part.time : '', part.title || ''].filter(Boolean).join(CHAT_LOG_SEPARATOR);
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
      const body = joinKindAndDetail(formatChatKind(part.kind), part.detailHtml, folded, index);
      return `<span class="chat-entry-part"${titleAttr}>${body}</span>`;
    })
    .join(CHAT_LOG_SEPARATOR);
}

/**
 * Join a part's kind and detail as a line shows them: one middle dot, or in a
 * folded burst's later parts a space (see {@link formatChatLogParts}).
 *
 * @param {string} kind The kind, as HTML or text.
 * @param {string} [detail] The detail, alike; none leaves the kind alone.
 * @param {boolean} folded Whether the part belongs to a folded burst.
 * @param {number} index The part's place on its line.
 * @returns {string} Kind and detail.
 */
function joinKindAndDetail(kind, detail, folded, index) {
  if (!detail) return kind;
  return `${kind}${folded && index > 0 ? ' ' : CHAT_LOG_SEPARATOR}${detail}`;
}

/**
 * The words of a line's parts as plain text, joined as
 * {@link formatChatLogParts} joins them: `node info · advert · position
 * 38.0249, -123.0132` (SPEC LA3, LA4). The search matches it.
 *
 * @param {Array<{ kind: string, detailText?: string }>} parts Parts in order.
 * @param {{ folded?: boolean }} [options] Whether the line folds a burst.
 * @returns {string} The text.
 */
export function formatChatLogText(parts, { folded = false } = {}) {
  return parts.map((part, index) => joinKindAndDetail(part.kind, part.detailText, folded, index)).join(CHAT_LOG_SEPARATOR);
}

/**
 * Telemetry values that lead a Log line, in this order (SPEC LA3).
 *
 * @type {ReadonlyArray<string>}
 */
const TELEMETRY_LOG_LEAD = Object.freeze(['battery', 'voltage', 'channel', 'airUtil']);

/**
 * Telemetry values the Log never shows: uptime grows with every packet, so
 * it would always count as changed.
 *
 * @type {ReadonlySet<string>}
 */
const TELEMETRY_LOG_SKIPPED = new Set(['uptime']);

/**
 * The order of telemetry values on a Log line (SPEC LA3): battery, voltage,
 * channel util and air util, then every other {@link TELEMETRY_FIELDS} value
 * in that table's order (current, then the environment values: temperature,
 * humidity, pressure, gas resistance, IAQ, …). Uptime is left out.
 *
 * @type {ReadonlyArray<string>}
 */
export const TELEMETRY_LOG_ORDER = Object.freeze([
  ...TELEMETRY_LOG_LEAD,
  ...TELEMETRY_FIELDS.map(field => field.key).filter(
    key => !TELEMETRY_LOG_LEAD.includes(key) && !TELEMETRY_LOG_SKIPPED.has(key),
  ),
]);

/**
 * The word before a value whose unit alone does not name it, such as a
 * second percentage beside the battery's (SPEC LA3): `util 0.2%`.
 *
 * @type {Readonly<Record<string, string>>}
 */
const TELEMETRY_LOG_QUALIFIERS = Object.freeze({
  channel: 'util',
  airUtil: 'air util',
  iaq: 'IAQ',
  whiteLux: 'white',
  irLux: 'IR',
  uvLux: 'UV',
  windDirection: 'wind',
  windSpeed: 'wind',
  windGust: 'gust',
  windLull: 'lull',
  rainfall1h: 'rain 1h',
  rainfall24h: 'rain 24h',
  soilMoisture: 'soil',
  soilTemperature: 'soil',
});

/**
 * The unit symbol after a percentage that is not a charge level.
 *
 * @type {Readonly<Record<string, string>>}
 */
const TELEMETRY_LOG_SUFFIXES = Object.freeze({ humidity: ' RH' });

/** @type {ReadonlyMap<string, Object>} {@link TELEMETRY_FIELDS} by key. */
const TELEMETRY_FIELD_BY_KEY = new Map(TELEMETRY_FIELDS.map(field => [field.key, field]));

/**
 * Put a space between a number and the volt or degree-Celsius symbol, as
 * the other units already have (`3.84V` reads `3.84 V`, `14.2°C` `14.2 °C`).
 *
 * @param {string} text Value as {@link TELEMETRY_FIELDS} formats it.
 * @returns {string} The spaced value.
 */
function spaceUnit(text) {
  return text.replace(/(\d)(V|°C)$/, '$1 $2');
}

/**
 * One telemetry value of a Log line.
 *
 * @typedef {Object} TelemetryLogValue
 * @property {string} key {@link TELEMETRY_FIELDS} key.
 * @property {string} text The value as the line shows it: `3.84 V`.
 * @property {string} label The value with its label, for the title:
 *   `Voltage: 3.84 V`.
 */

/**
 * {@link telemetryLogValues} by snapshot. A snapshot is a row of the
 * telemetry collection, which no refresh rewrites in place, and the Log reads
 * every one on every render, twice (its history and its line).
 *
 * @type {WeakMap<Object, Array<TelemetryLogValue>>}
 */
const telemetryLogValuesBySnapshot = new WeakMap();

/**
 * The telemetry values of one snapshot, in {@link TELEMETRY_LOG_ORDER},
 * memoised per snapshot object. `collectTelemetryMetrics` keeps finite numbers
 * only, and every {@link TELEMETRY_FIELDS} formatter but uptime's renders a
 * finite number.
 *
 * @param {*} telemetry Telemetry snapshot.
 * @returns {ReadonlyArray<TelemetryLogValue>} Values the snapshot reports.
 */
export function telemetryLogValues(telemetry) {
  const cacheable = telemetry !== null && typeof telemetry === 'object';
  const cached = cacheable ? telemetryLogValuesBySnapshot.get(telemetry) : undefined;
  if (cached) return cached;
  const metrics = collectTelemetryMetrics(telemetry);
  const values = [];
  for (const key of TELEMETRY_LOG_ORDER) {
    if (!Object.hasOwn(metrics, key)) continue;
    const field = TELEMETRY_FIELD_BY_KEY.get(key);
    const spaced = spaceUnit(String(field.formatter(metrics[key], {})));
    const qualifier = TELEMETRY_LOG_QUALIFIERS[key];
    const text = `${qualifier ? `${qualifier} ` : ''}${spaced}${TELEMETRY_LOG_SUFFIXES[key] || ''}`;
    values.push({ key, text, label: `${field.label}: ${spaced}` });
  }
  if (cacheable) telemetryLogValuesBySnapshot.set(telemetry, Object.freeze(values));
  return values;
}

/**
 * Most values a telemetry line shows (SPEC LA3).
 *
 * @type {number}
 */
export const TELEMETRY_LOG_MAX_VALUES = 3;

/**
 * The telemetry part of a Log line (SPEC LA3). The detail lists, in
 * {@link TELEMETRY_LOG_ORDER}, at most three values that differ from the
 * value the node last reported for the same metric earlier in the Log; a
 * value no earlier line reported counts as changed, so a node's first line
 * lists its first three values. No changed value leaves the detail empty.
 * The title lists the full set with labels.
 *
 * @param {*} telemetry Telemetry snapshot.
 * @param {?Map<string, string>} [previous] The node's earlier values by key,
 *   from {@link attachTelemetryHistory}; none on its first line.
 * @returns {ChatLogPart} The part.
 */
export function formatTelemetryLogPart(telemetry, previous = null) {
  const values = telemetryLogValues(telemetry);
  const changed = values.filter(value => !(previous instanceof Map) || previous.get(value.key) !== value.text);
  const detailText = changed.slice(0, TELEMETRY_LOG_MAX_VALUES).map(value => value.text).join(CHAT_LOG_SEPARATOR);
  return {
    kind: CHAT_LOG_KIND_WORDS[CHAT_LOG_ENTRY_TYPES.TELEMETRY],
    detailHtml: escapeHtml(detailText),
    detailText,
    title: values.map(value => value.label).join(CHAT_LOG_SEPARATOR),
  };
}

/**
 * The node an entry belongs to, as a history key.
 *
 * @param {Object} entry Log entry.
 * @returns {?string} `id:<node id>`, `num:<node num>`, or `null`.
 */
function historyKey(entry) {
  if (typeof entry.nodeId === 'string' && entry.nodeId) return `id:${entry.nodeId}`;
  return Number.isFinite(entry.nodeNum) ? `num:${entry.nodeNum}` : null;
}

/**
 * Give every telemetry entry of a chronological Log the values its node
 * reported earlier in the same Log, one per metric, as
 * `previousTelemetryValues` (SPEC LA3). Run it on the whole Log, before the
 * search and protocol filters, so a line's detail depends on entry data
 * alone. The entry is copied; the entries passed in are left as they are. A
 * node's first telemetry entry, and one without a node, gets `null`.
 *
 * @param {Array<Object>} entries Log entries, oldest first.
 * @returns {Array<Object>} The entries, telemetry entries copied.
 */
export function attachTelemetryHistory(entries) {
  const latest = new Map();
  return entries.map(entry => {
    if (!entry || entry.type !== CHAT_LOG_ENTRY_TYPES.TELEMETRY) return entry;
    const key = historyKey(entry);
    const known = key ? latest.get(key) : null;
    const annotated = { ...entry, previousTelemetryValues: known ? new Map(known) : null };
    if (key) {
      const values = known || new Map();
      for (const value of telemetryLogValues(entry.telemetry)) values.set(value.key, value.text);
      latest.set(key, values);
    }
    return annotated;
  });
}

/**
 * Decimal places of a Log position (SPEC LA3).
 *
 * @type {number}
 */
const POSITION_LOG_DECIMALS = 4;

/**
 * The position part of a Log line (SPEC LA3): `lat, lon` at four decimals;
 * the other values (altitude, accuracy, speed, heading, satellites) go in the
 * title.
 *
 * @param {*} position Position snapshot.
 * @returns {ChatLogPart} The part.
 */
export function formatPositionLogPart(position) {
  const { latitude, longitude } = resolvePositionCoordinates(position);
  const coordinates = [latitude, longitude]
    .filter(value => value != null)
    .map(value => value.toFixed(POSITION_LOG_DECIMALS));
  const rest = formatPositionHighlights(position)
    .filter(entry => entry.label !== 'Lat' && entry.label !== 'Lon')
    .map(entry => `${entry.label}: ${entry.value}`);
  const detailText = coordinates.join(', ');
  return {
    kind: CHAT_LOG_KIND_WORDS[CHAT_LOG_ENTRY_TYPES.POSITION],
    detailHtml: escapeHtml(detailText),
    detailText,
    title: rest.join(CHAT_LOG_SEPARATOR),
  };
}

/**
 * The node-info part of a Log line (SPEC LA3): `node info · <reason>`, such
 * as `advert` or `message`; no reason, no detail.
 *
 * @param {*} reason Reason the node record updated.
 * @returns {ChatLogPart} The part.
 */
export function formatNodeInfoLogPart(reason) {
  const text = typeof reason === 'string' ? reason.trim() : '';
  return { kind: CHAT_LOG_KIND_WORDS[CHAT_LOG_ENTRY_TYPES.NODE_INFO], detailHtml: escapeHtml(text), detailText: text };
}

/**
 * The part of an entry of a foldable kind (SPEC LA4): node info, position,
 * or telemetry, the third kind.
 *
 * @param {Object} entry Log entry of type `node-info`, `position` or
 *   `telemetry`; a telemetry entry may carry `previousTelemetryValues`.
 * @returns {ChatLogPart} The part.
 */
export function formatEntryLogPart(entry) {
  if (entry.type === CHAT_LOG_ENTRY_TYPES.NODE_INFO) return formatNodeInfoLogPart(entry.reason);
  if (entry.type === CHAT_LOG_ENTRY_TYPES.POSITION) return formatPositionLogPart(entry.position);
  return formatTelemetryLogPart(entry.telemetry, entry.previousTelemetryValues);
}

/**
 * Render the parts of a folded burst (SPEC LA4), each titled with its own
 * `HH:MM:SS`: `node info · advert · position 38.0249, -123.0132 · telemetry
 * 61% · 3.84 V · util 0.2%`.
 *
 * @param {Array<Object>} parts The burst's entries, in arrival order.
 * @returns {string} The parts' HTML.
 */
export function formatBurstLogParts(parts) {
  return formatChatLogParts(
    parts.map(entry => ({ ...formatEntryLogPart(entry), time: formatTime(new Date(entry.ts * 1000)) })),
    { folded: true },
  );
}

/**
 * A part whose detail the caller renders: the new node's long-name link,
 * the neighbour's badge, or the trace hops' badges.
 *
 * @param {string} type Entry type, from `CHAT_LOG_ENTRY_TYPES`.
 * @param {string} detailHtml HTML-safe detail.
 * @returns {ChatLogPart} The part.
 */
export function formatRenderedLogPart(type, detailHtml) {
  return { kind: CHAT_LOG_KIND_WORDS[type], detailHtml };
}

/**
 * Separator between the hops of a trace (SPEC LA3).
 *
 * @type {string}
 */
export const TRACE_HOP_SEPARATOR = ' → ';

/**
 * Whether a waypoint carries a glyph of its own. Without one the map draws
 * the 📌 fallback, which the Log leaves out: only the user's glyph is data.
 *
 * @param {*} icon Raw `icon` codepoint.
 * @returns {boolean} Whether {@link waypointGlyph} shows the waypoint's own glyph.
 */
function hasOwnWaypointGlyph(icon) {
  const code = toFiniteNumber(icon);
  return waypointGlyph(icon) !== FALLBACK_GLYPH || Math.floor(code) === FALLBACK_GLYPH.codePointAt(0);
}

/**
 * The waypoint part of a Log line (SPEC LA3, W7): `<glyph> <name> · expires
 * <remaining>`, `expires never` or `expired`; latitude and longitude go in
 * the title. The glyph is the waypoint's own and the description never shows.
 *
 * @param {Object} waypoint Waypoint row (without its description).
 * @param {{ nowSeconds: number }} options Render time, unix seconds.
 * @returns {ChatLogPart} The part.
 */
export function formatWaypointLogPart(waypoint, { nowSeconds }) {
  const glyph = hasOwnWaypointGlyph(waypoint.icon) ? `${waypointGlyph(waypoint.icon)} ` : '';
  const name = waypoint.name != null && String(waypoint.name).trim().length > 0 ? String(waypoint.name).trim() : 'Waypoint';
  const expire = toFiniteNumber(waypoint.expire);
  let expires = 'expires never';
  if (expire != null && expire > 0) {
    const remaining = Math.floor(expire - nowSeconds);
    // The Log keeps expired broadcasts as history (W7); label them honestly.
    expires = remaining > 0 ? `expires ${timeHum(remaining)}` : 'expired';
  }
  const lat = toFiniteNumber(waypoint.latitude);
  const lon = toFiniteNumber(waypoint.longitude);
  const title = [lat != null ? `Lat: ${lat.toFixed(5)}` : '', lon != null ? `Lon: ${lon.toFixed(5)}` : '']
    .filter(Boolean)
    .join(CHAT_LOG_SEPARATOR);
  const detailText = `${glyph}${name}${CHAT_LOG_SEPARATOR}${expires}`;
  return {
    kind: CHAT_LOG_KIND_WORDS[CHAT_LOG_ENTRY_TYPES.WAYPOINT],
    detailHtml: escapeHtml(detailText),
    detailText,
    title,
  };
}

/**
 * The text of an encrypted message's line (SPEC LA2): `encrypted · channel
 * <label>`, `encrypted · to <badge>` for a direct message, or `encrypted ·
 * unknown channel`.
 *
 * @param {{ channelLabel?: ?string, recipientHtml?: ?string }} target The
 *   raw channel label, or the HTML-safe recipient (a badge, or its escaped
 *   id).
 * @returns {string} HTML for the line's text slot.
 */
export function formatEncryptedLogNotice({ channelLabel = null, recipientHtml = null }) {
  let detail = 'unknown channel';
  if (recipientHtml) {
    detail = `to ${recipientHtml}`;
  } else if (channelLabel) {
    detail = `channel ${escapeHtml(channelLabel)}`;
  }
  return `${formatChatKind(CHAT_LOG_KIND_WORDS[CHAT_LOG_ENTRY_TYPES.MESSAGE_ENCRYPTED])}${CHAT_LOG_SEPARATOR}${detail}`;
}

/**
 * Whom an encrypted message's line names (SPEC LA2): the recipient of a
 * direct message, else its channel, as a number when it is one, else the
 * channel name.
 *
 * @param {?Object} message Raw message payload.
 * @returns {{ recipient: ?string, channelLabel: ?string }} The recipient's id
 *   for a direct message; otherwise the channel label, or `null` for none.
 */
export function encryptedNoticeTarget(message) {
  const recipient = pickFirstProperty([message], ['to_id', 'toId']);
  const recipientText = recipient != null ? String(recipient).trim() : '';
  if (recipientText && recipientText.toLowerCase() !== '^all') {
    return { recipient: recipientText, channelLabel: null };
  }
  const channel = pickFirstProperty([message], ['channel', 'channel_index', 'channelIndex']);
  let channelLabel = null;
  if (typeof channel === 'number' && Number.isFinite(channel)) {
    channelLabel = String(Math.round(channel));
  } else if (channel != null) {
    const text = String(channel).trim();
    const numeric = Number(text);
    channelLabel = Number.isFinite(numeric) ? String(Math.round(numeric)) : text;
  }
  return { recipient: null, channelLabel: channelLabel ?? pickFirstProperty([message], ['channel_name', 'channelName']) };
}

/**
 * The kind and plain-text detail of any Log entry, as its line shows them,
 * for the search (SPEC LA3). The new node's long name, the neighbour's badge
 * and the trace hops' badges come from the context `main.js` attaches
 * (`node`, `neighborNode`, `hopLabels`), with the ids as fallback.
 *
 * @param {Object} entry Log entry.
 * @param {number} nowSeconds Clock for a waypoint's expiry, unix seconds.
 * @returns {?{ kind: string, detailText: string }} The part, or `null` for an
 *   entry of no Log kind.
 */
function entryTextPart(entry, nowSeconds) {
  const kind = CHAT_LOG_KIND_WORDS[entry.type];
  switch (entry.type) {
    case CHAT_LOG_ENTRY_TYPES.NODE_INFO:
    case CHAT_LOG_ENTRY_TYPES.POSITION:
    case CHAT_LOG_ENTRY_TYPES.TELEMETRY:
      return formatEntryLogPart(entry);
    case CHAT_LOG_ENTRY_TYPES.NODE_NEW:
      return { kind, detailText: String(pickFirstProperty([entry.node], ['long_name', 'longName']) ?? entry.nodeId ?? '') };
    case CHAT_LOG_ENTRY_TYPES.NEIGHBOR:
      return { kind, detailText: String(pickFirstProperty([entry.neighborNode], ['short_name', 'shortName']) ?? entry.neighborId ?? '') };
    case CHAT_LOG_ENTRY_TYPES.WAYPOINT:
      return formatWaypointLogPart(entry.waypoint || {}, { nowSeconds });
    case CHAT_LOG_ENTRY_TYPES.TRACE:
      return { kind, detailText: (entry.hopLabels || entry.traceLabels || []).join(TRACE_HOP_SEPARATOR) };
    case CHAT_LOG_ENTRY_TYPES.MESSAGE_ENCRYPTED: {
      const { recipient, channelLabel } = encryptedNoticeTarget(entry.message);
      let detailText = 'unknown channel';
      if (recipient) detailText = `to ${recipient}`;
      else if (channelLabel) detailText = `channel ${channelLabel}`;
      return { kind, detailText };
    }
    default:
      return null;
  }
}

/**
 * The words a Log line shows after its badge, as plain text: its kind words
 * and details, every part of a folded burst included, joined as the line
 * joins them (SPEC LA3, LA4). The search matches it.
 *
 * @param {Object} entry Log entry or folded burst.
 * @param {{ nowSeconds?: number }} [options] Clock, unix seconds.
 * @returns {string} The text; empty for an entry of no Log kind.
 */
export function chatLogEntryText(entry, { nowSeconds = Date.now() / 1000 } = {}) {
  if (entry.type === CHAT_LOG_BURST_TYPE) {
    return formatChatLogText(entry.parts.map(part => entryTextPart(part, nowSeconds)), { folded: true });
  }
  const part = entryTextPart(entry, nowSeconds);
  return part ? formatChatLogText([part]) : '';
}
