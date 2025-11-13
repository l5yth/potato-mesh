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

import { refreshNodeInformation } from './node-details.js';
import {
  fmtAlt,
  fmtHumidity,
  fmtPressure,
  fmtTemperature,
  fmtTx,
} from './short-info-telemetry.js';

const DEFAULT_FETCH_OPTIONS = Object.freeze({ cache: 'no-store' });
const MESSAGE_LIMIT = 50;
const RENDER_WAIT_INTERVAL_MS = 20;
const RENDER_WAIT_TIMEOUT_MS = 500;

/**
 * Convert a candidate value into a trimmed string.
 *
 * @param {*} value Raw value.
 * @returns {string|null} Trimmed string or ``null``.
 */
function stringOrNull(value) {
  if (value == null) return null;
  const str = String(value).trim();
  return str.length === 0 ? null : str;
}

/**
 * Attempt to coerce a value into a finite number.
 *
 * @param {*} value Raw value.
 * @returns {number|null} Finite number or ``null``.
 */
function numberOrNull(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (value == null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/**
 * Escape HTML sensitive characters from the provided string.
 *
 * @param {string} input Raw HTML string.
 * @returns {string} Escaped HTML representation.
 */
function escapeHtml(input) {
  const str = input == null ? '' : String(input);
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Format a frequency value using MHz units when a numeric reading is
 * available. Non-numeric input is passed through unchanged.
 *
 * @param {*} value Raw frequency value.
 * @returns {string|null} Formatted frequency string or ``null``.
 */
function formatFrequency(value) {
  if (value == null || value === '') return null;
  const numeric = numberOrNull(value);
  if (numeric == null) {
    return stringOrNull(value);
  }
  const abs = Math.abs(numeric);
  if (abs >= 1_000_000) {
    return `${(numeric / 1_000_000).toFixed(3)} MHz`;
  }
  if (abs >= 1_000) {
    return `${(numeric / 1_000).toFixed(3)} MHz`;
  }
  return `${numeric.toFixed(3)} MHz`;
}

/**
 * Format a battery reading as a percentage with a single decimal place.
 *
 * @param {*} value Raw battery value.
 * @returns {string|null} Formatted percentage or ``null``.
 */
function formatBattery(value) {
  const numeric = numberOrNull(value);
  if (numeric == null) return null;
  return `${numeric.toFixed(1)}%`;
}

/**
 * Format a voltage reading with two decimal places.
 *
 * @param {*} value Raw voltage value.
 * @returns {string|null} Formatted voltage string.
 */
function formatVoltage(value) {
  const numeric = numberOrNull(value);
  if (numeric == null) return null;
  return `${numeric.toFixed(2)} V`;
}

/**
 * Convert an uptime reading in seconds to a concise human-readable string.
 *
 * @param {*} value Raw uptime value.
 * @returns {string|null} Formatted uptime string or ``null`` when invalid.
 */
function formatUptime(value) {
  const numeric = numberOrNull(value);
  if (numeric == null) return null;
  const seconds = Math.floor(numeric);
  const parts = [];
  const days = Math.floor(seconds / 86_400);
  if (days > 0) parts.push(`${days}d`);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  if (hours > 0) parts.push(`${hours}h`);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (minutes > 0) parts.push(`${minutes}m`);
  const remainSeconds = seconds % 60;
  if (parts.length === 0 || remainSeconds > 0) {
    parts.push(`${remainSeconds}s`);
  }
  return parts.join(' ');
}

/**
 * Format a numeric timestamp expressed in seconds since the epoch.
 *
 * @param {*} value Raw timestamp value.
 * @param {string|null} isoFallback ISO formatted string to prefer.
 * @returns {string|null} ISO timestamp string.
 */
function formatTimestamp(value, isoFallback = null) {
  const iso = stringOrNull(isoFallback);
  if (iso) return iso;
  const numeric = numberOrNull(value);
  if (numeric == null) return null;
  try {
    return new Date(numeric * 1000).toISOString();
  } catch (error) {
    return null;
  }
}

/**
/**
 * Format a hardware model string while hiding unset placeholders.
 *
 * @param {*} value Raw hardware model value.
 * @returns {string} Sanitised hardware model string.
 */
function formatHardwareModel(value) {
  const text = stringOrNull(value);
  if (!text || text.toUpperCase() === 'UNSET') {
    return '';
  }
  return text;
}

/**
 * Format a coordinate with consistent precision.
 *
 * @param {*} value Raw coordinate value.
 * @param {number} [precision=5] Decimal precision applied to the coordinate.
 * @returns {string} Formatted coordinate string.
 */
function formatCoordinate(value, precision = 5) {
  const numeric = numberOrNull(value);
  if (numeric == null) return '';
  return numeric.toFixed(precision);
}

/**
 * Convert an absolute timestamp into a relative time description.
 *
 * @param {*} value Raw timestamp expressed in seconds since the epoch.
 * @param {number} [referenceSeconds] Optional reference timestamp in seconds.
 * @returns {string} Relative time string or an empty string when unavailable.
 */
function formatRelativeSeconds(value, referenceSeconds = Date.now() / 1000) {
  const numeric = numberOrNull(value);
  if (numeric == null) return '';
  const reference = numberOrNull(referenceSeconds);
  const base = reference != null ? reference : Date.now() / 1000;
  const diff = Math.floor(base - numeric);
  const safeDiff = Number.isFinite(diff) ? Math.max(diff, 0) : 0;
  if (safeDiff < 60) return `${safeDiff}s`;
  if (safeDiff < 3_600) {
    const minutes = Math.floor(safeDiff / 60);
    const seconds = safeDiff % 60;
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  if (safeDiff < 86_400) {
    const hours = Math.floor(safeDiff / 3_600);
    const minutes = Math.floor((safeDiff % 3_600) / 60);
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  const days = Math.floor(safeDiff / 86_400);
  const hours = Math.floor((safeDiff % 86_400) / 3_600);
  return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
}

/**
 * Format a duration expressed in seconds using a compact human readable form.
 *
 * @param {*} value Raw duration in seconds.
 * @returns {string} Human readable duration string or an empty string.
 */
function formatDurationSeconds(value) {
  const numeric = numberOrNull(value);
  if (numeric == null) return '';
  const duration = Math.max(Math.floor(numeric), 0);
  if (duration < 60) return `${duration}s`;
  if (duration < 3_600) {
    const minutes = Math.floor(duration / 60);
    const seconds = duration % 60;
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  if (duration < 86_400) {
    const hours = Math.floor(duration / 3_600);
    const minutes = Math.floor((duration % 3_600) / 60);
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  const days = Math.floor(duration / 86_400);
  const hours = Math.floor((duration % 86_400) / 3_600);
  return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
}

/**
 * Format an SNR reading with a decibel suffix.
 *
 * @param {*} value Raw SNR value.
 * @returns {string} Formatted SNR string or an empty string.
 */
function formatSnr(value) {
  const numeric = numberOrNull(value);
  if (numeric == null) return '';
  return `${numeric.toFixed(1)} dB`;
}

/**
 * Determine whether a neighbour record references the current node.
 *
 * @param {Object} entry Raw neighbour entry.
 * @param {string|null} ourId Canonical identifier for the current node.
 * @param {number|null} ourNum Canonical numeric identifier for the current node.
 * @param {Array<string>} idKeys Candidate identifier property names.
 * @param {Array<string>} numKeys Candidate numeric identifier property names.
 * @returns {boolean} ``true`` when the neighbour refers to the current node.
 */
function neighborMatches(entry, ourId, ourNum, idKeys, numKeys) {
  if (!entry || typeof entry !== 'object') return false;
  const ids = idKeys
    .map(key => stringOrNull(entry[key]))
    .filter(candidate => candidate != null)
    .map(candidate => candidate.toLowerCase());
  if (ourId && ids.includes(ourId.toLowerCase())) {
    return true;
  }
  if (ourNum == null) return false;
  return numKeys
    .map(key => numberOrNull(entry[key]))
    .some(candidate => candidate != null && candidate === ourNum);
}

/**
 * Categorise neighbour entries by their relationship to the current node.
 *
 * @param {Object} node Normalised node payload.
 * @param {Array<Object>} neighbors Raw neighbour entries.
 * @returns {{heardBy: Array<Object>, weHear: Array<Object>}} Categorised neighbours.
 */
function categoriseNeighbors(node, neighbors) {
  const heardBy = [];
  const weHear = [];
  if (!Array.isArray(neighbors) || neighbors.length === 0) {
    return { heardBy, weHear };
  }
  const ourId = stringOrNull(node?.nodeId ?? node?.node_id) ?? null;
  const ourNum = numberOrNull(node?.nodeNum ?? node?.node_num ?? node?.num);
  neighbors.forEach(entry => {
    if (!entry || typeof entry !== 'object') {
      return;
    }
    const matchesNeighbor = neighborMatches(entry, ourId, ourNum, ['neighbor_id', 'neighborId'], ['neighbor_num', 'neighborNum']);
    const matchesNode = neighborMatches(entry, ourId, ourNum, ['node_id', 'nodeId'], ['node_num', 'nodeNum']);
    if (matchesNeighbor) {
      heardBy.push(entry);
    }
    if (matchesNode) {
      weHear.push(entry);
    }
  });
  return { heardBy, weHear };
}

/**
 * Render a short-name badge with consistent role-aware styling.
 *
 * @param {Function} renderShortHtml Badge rendering implementation.
 * @param {{
 *   shortName?: string|null,
 *   longName?: string|null,
 *   role?: string|null,
 *   identifier?: string|null,
 *   numericId?: number|null,
 *   source?: Object|null,
 * }} payload Badge rendering payload.
 * @returns {string} HTML snippet describing the badge.
 */
function renderRoleAwareBadge(renderShortHtml, {
  shortName = null,
  longName = null,
  role = null,
  identifier = null,
  numericId = null,
  source = null,
} = {}) {
  const resolvedIdentifier = stringOrNull(identifier);
  let resolvedShort = stringOrNull(shortName);
  const resolvedLong = stringOrNull(longName);
  const resolvedRole = stringOrNull(role) ?? 'CLIENT';
  const resolvedNumericId = numberOrNull(numericId);
  let fallbackShort = resolvedShort;
  if (!fallbackShort && resolvedIdentifier) {
    const trimmed = resolvedIdentifier.replace(/^!+/, '');
    fallbackShort = trimmed.slice(-4).toUpperCase();
  }
  if (!fallbackShort) {
    fallbackShort = '?';
  }

  const badgeSource = source && typeof source === 'object' ? { ...source } : {};
  if (resolvedIdentifier) {
    if (!badgeSource.node_id) badgeSource.node_id = resolvedIdentifier;
    if (!badgeSource.nodeId) badgeSource.nodeId = resolvedIdentifier;
  }
  if (resolvedNumericId != null) {
    if (!badgeSource.node_num) badgeSource.node_num = resolvedNumericId;
    if (!badgeSource.nodeNum) badgeSource.nodeNum = resolvedNumericId;
  }
  if (resolvedShort) {
    if (!badgeSource.short_name) badgeSource.short_name = resolvedShort;
    if (!badgeSource.shortName) badgeSource.shortName = resolvedShort;
  }
  if (resolvedLong) {
    if (!badgeSource.long_name) badgeSource.long_name = resolvedLong;
    if (!badgeSource.longName) badgeSource.longName = resolvedLong;
  }
  badgeSource.role = badgeSource.role ?? resolvedRole;

  if (typeof renderShortHtml === 'function') {
    return renderShortHtml(resolvedShort ?? fallbackShort, resolvedRole, resolvedLong, badgeSource);
  }
  return `<span class="short-name">${escapeHtml(resolvedShort ?? fallbackShort)}</span>`;
}

/**
 * Generate a badge HTML fragment for a neighbour entry.
 *
 * @param {Object} entry Raw neighbour entry.
 * @param {'heardBy'|'weHear'} perspective Group perspective describing the relation.
 * @param {Function} renderShortHtml Badge rendering implementation.
 * @returns {string} HTML snippet for the badge or an empty string.
 */
function renderNeighborBadge(entry, perspective, renderShortHtml) {
  if (!entry || typeof entry !== 'object' || typeof renderShortHtml !== 'function') {
    return '';
  }
  const idKeys = perspective === 'heardBy'
    ? ['node_id', 'nodeId', 'id']
    : ['neighbor_id', 'neighborId', 'id'];
  const numKeys = perspective === 'heardBy'
    ? ['node_num', 'nodeNum']
    : ['neighbor_num', 'neighborNum'];
  const shortKeys = perspective === 'heardBy'
    ? ['node_short_name', 'nodeShortName', 'short_name', 'shortName']
    : ['neighbor_short_name', 'neighborShortName', 'short_name', 'shortName'];
  const longKeys = perspective === 'heardBy'
    ? ['node_long_name', 'nodeLongName', 'long_name', 'longName']
    : ['neighbor_long_name', 'neighborLongName', 'long_name', 'longName'];
  const roleKeys = perspective === 'heardBy'
    ? ['node_role', 'nodeRole', 'role']
    : ['neighbor_role', 'neighborRole', 'role'];

  const identifier = idKeys.map(key => stringOrNull(entry[key])).find(value => value != null);
  if (!identifier) return '';
  const numericId = numKeys.map(key => numberOrNull(entry[key])).find(value => value != null) ?? null;
  let shortName = shortKeys.map(key => stringOrNull(entry[key])).find(value => value != null) ?? null;
  const longName = longKeys.map(key => stringOrNull(entry[key])).find(value => value != null) ?? null;
  let role = roleKeys.map(key => stringOrNull(entry[key])).find(value => value != null) ?? null;
  if (!shortName) {
    const trimmed = identifier.replace(/^!+/, '');
    shortName = trimmed.slice(-4).toUpperCase();
  }

  const source = perspective === 'heardBy' ? entry.node : entry.neighbor;
  if (!role && source && typeof source === 'object') {
    role = stringOrNull(
      source.role
        ?? source.node_role
        ?? source.nodeRole
        ?? source.neighbor_role
        ?? source.neighborRole
        ?? source.roleName
        ?? null,
    );
  }

  return renderRoleAwareBadge(renderShortHtml, {
    shortName,
    longName,
    role: role ?? 'CLIENT',
    identifier,
    numericId,
    source,
  });
}

/**
 * Render a neighbour group as a titled list.
 *
 * @param {string} title Section title for the group.
 * @param {Array<Object>} entries Neighbour entries included in the group.
 * @param {'heardBy'|'weHear'} perspective Group perspective.
 * @param {Function} renderShortHtml Badge rendering implementation.
 * @returns {string} HTML markup or an empty string when no entries render.
 */
function renderNeighborGroup(title, entries, perspective, renderShortHtml) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return '';
  }
  const items = entries
    .map(entry => {
      const badgeHtml = renderNeighborBadge(entry, perspective, renderShortHtml);
      if (!badgeHtml) {
        return null;
      }
      const snrDisplay = formatSnr(entry?.snr);
      const snrHtml = snrDisplay ? `<span class="node-detail__neighbor-snr">(${escapeHtml(snrDisplay)})</span>` : '';
      return `<li>${badgeHtml}${snrHtml}</li>`;
    })
    .filter(item => item != null);
  if (items.length === 0) return '';
  return `
    <div class="node-detail__neighbors-group">
      <h4 class="node-detail__neighbors-title">${escapeHtml(title)}</h4>
      <ul class="node-detail__neighbors-list">${items.join('')}</ul>
    </div>
  `;
}

/**
 * Render neighbour information grouped by signal direction.
 *
 * @param {Object} node Normalised node payload.
 * @param {Array<Object>} neighbors Raw neighbour entries.
 * @param {Function} renderShortHtml Badge rendering implementation.
 * @returns {string} HTML markup for the neighbour section.
 */
function renderNeighborGroups(node, neighbors, renderShortHtml) {
  const { heardBy, weHear } = categoriseNeighbors(node, neighbors);
  const heardByHtml = renderNeighborGroup('Heard by', heardBy, 'heardBy', renderShortHtml);
  const weHearHtml = renderNeighborGroup('We hear', weHear, 'weHear', renderShortHtml);
  const groups = [heardByHtml, weHearHtml].filter(section => stringOrNull(section));
  if (groups.length === 0) {
    return '';
  }
  return `
    <section class="node-detail__section node-detail__neighbors">
      <h3>Neighbors</h3>
      <div class="node-detail__neighbors-grid">${groups.join('')}</div>
    </section>
  `;
}

/**
 * Render a condensed node table containing a single entry.
 *
 * @param {Object} node Normalised node payload.
 * @param {Function} renderShortHtml Badge rendering implementation.
 * @param {number} [referenceSeconds] Optional reference timestamp for relative metrics.
 * @returns {string} HTML markup for the node table or an empty string.
 */
function renderSingleNodeTable(node, renderShortHtml, referenceSeconds = Date.now() / 1000) {
  if (!node || typeof node !== 'object' || typeof renderShortHtml !== 'function') {
    return '';
  }
  const nodeId = stringOrNull(node.nodeId ?? node.node_id) ?? '';
  const shortName = stringOrNull(node.shortName ?? node.short_name) ?? null;
  const longName = stringOrNull(node.longName ?? node.long_name) ?? '';
  const role = stringOrNull(node.role) ?? 'CLIENT';
  const numericId = numberOrNull(node.nodeNum ?? node.node_num ?? node.num);
  const badgeSource = node.rawSources?.node && typeof node.rawSources.node === 'object'
    ? node.rawSources.node
    : node;
  const badgeHtml = renderRoleAwareBadge(renderShortHtml, {
    shortName,
    longName,
    role,
    identifier: nodeId || null,
    numericId,
    source: badgeSource,
  });
  const hardware = formatHardwareModel(node.hwModel ?? node.hw_model);
  const battery = formatBattery(node.battery ?? node.battery_level);
  const voltage = formatVoltage(node.voltage ?? node.voltageReading);
  const uptime = formatDurationSeconds(node.uptime ?? node.uptime_seconds ?? node.uptimeSeconds);
  const channel = fmtTx(node.channel ?? node.channel_utilization ?? node.channelUtilization ?? null, 3);
  const airUtil = fmtTx(node.airUtil ?? node.air_util_tx ?? node.airUtilTx ?? null, 3);
  const temperature = fmtTemperature(node.temperature ?? node.temp);
  const humidity = fmtHumidity(node.humidity ?? node.relative_humidity ?? node.relativeHumidity);
  const pressure = fmtPressure(node.pressure ?? node.barometric_pressure ?? node.barometricPressure);
  const latitude = formatCoordinate(node.latitude ?? node.lat);
  const longitude = formatCoordinate(node.longitude ?? node.lon);
  const altitude = fmtAlt(node.altitude ?? node.alt, 'm');
  const lastSeen = formatRelativeSeconds(node.lastHeard ?? node.last_heard, referenceSeconds);
  const lastPosition = formatRelativeSeconds(node.positionTime ?? node.position_time, referenceSeconds);

  return `
    <div class="nodes-table-wrapper">
      <table class="nodes-detail-table" aria-label="Selected node details">
        <thead>
          <tr>
            <th class="nodes-col nodes-col--node-id">Node ID</th>
            <th class="nodes-col nodes-col--short-name">Short</th>
            <th class="nodes-col nodes-col--long-name">Long Name</th>
            <th class="nodes-col nodes-col--last-seen">Last Seen</th>
            <th class="nodes-col nodes-col--role">Role</th>
            <th class="nodes-col nodes-col--hw-model">HW Model</th>
            <th class="nodes-col nodes-col--battery">Battery</th>
            <th class="nodes-col nodes-col--voltage">Voltage</th>
            <th class="nodes-col nodes-col--uptime">Uptime</th>
            <th class="nodes-col nodes-col--channel-util">Channel Util</th>
            <th class="nodes-col nodes-col--air-util-tx">Air Util Tx</th>
            <th class="nodes-col nodes-col--temperature">Temperature</th>
            <th class="nodes-col nodes-col--humidity">Humidity</th>
            <th class="nodes-col nodes-col--pressure">Pressure</th>
            <th class="nodes-col nodes-col--latitude">Latitude</th>
            <th class="nodes-col nodes-col--longitude">Longitude</th>
            <th class="nodes-col nodes-col--altitude">Altitude</th>
            <th class="nodes-col nodes-col--last-position">Last Position</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td class="mono nodes-col nodes-col--node-id">${escapeHtml(nodeId)}</td>
            <td class="nodes-col nodes-col--short-name">${badgeHtml}</td>
            <td class="nodes-col nodes-col--long-name">${escapeHtml(longName)}</td>
            <td class="nodes-col nodes-col--last-seen">${escapeHtml(lastSeen)}</td>
            <td class="nodes-col nodes-col--role">${escapeHtml(role)}</td>
            <td class="nodes-col nodes-col--hw-model">${escapeHtml(hardware)}</td>
            <td class="nodes-col nodes-col--battery">${escapeHtml(battery ?? '')}</td>
            <td class="nodes-col nodes-col--voltage">${escapeHtml(voltage ?? '')}</td>
            <td class="nodes-col nodes-col--uptime">${escapeHtml(uptime)}</td>
            <td class="nodes-col nodes-col--channel-util">${escapeHtml(channel ?? '')}</td>
            <td class="nodes-col nodes-col--air-util-tx">${escapeHtml(airUtil ?? '')}</td>
            <td class="nodes-col nodes-col--temperature">${escapeHtml(temperature ?? '')}</td>
            <td class="nodes-col nodes-col--humidity">${escapeHtml(humidity ?? '')}</td>
            <td class="nodes-col nodes-col--pressure">${escapeHtml(pressure ?? '')}</td>
            <td class="nodes-col nodes-col--latitude">${escapeHtml(latitude)}</td>
            <td class="nodes-col nodes-col--longitude">${escapeHtml(longitude)}</td>
            <td class="nodes-col nodes-col--altitude">${escapeHtml(altitude ?? '')}</td>
            <td class="mono nodes-col nodes-col--last-position">${escapeHtml(lastPosition)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  `;
}

/**
 * Render a message list using structured metadata formatting.
 *
 * @param {Array<Object>} messages Message records.
 * @param {Function} renderShortHtml Badge rendering implementation.
 * @param {Object} node Node context used when message metadata is incomplete.
 * @returns {string} HTML string for the messages section.
 */
function renderMessages(messages, renderShortHtml, node) {
  if (!Array.isArray(messages) || messages.length === 0) return '';

  const fallbackNode = node && typeof node === 'object' ? node : null;

  const items = messages
    .map(message => {
      if (!message || typeof message !== 'object') return null;
      const text = stringOrNull(message.text) || stringOrNull(message.emoji);
      if (!text) return null;

      const timestamp = stringOrNull(formatTimestamp(message.rx_time, message.rx_iso));
      const frequency = stringOrNull(
        formatFrequency(message.lora_freq ?? message.loraFreq ?? message.frequency ?? message.loraFrequency),
      );
      const preset = stringOrNull(
        message.modem_preset ?? message.modemPreset ?? message.preset ?? message.modemPresetCode ?? null,
      );
      let channel = stringOrNull(message.channel_name ?? message.channelName ?? message.channel_label ?? null);
      if (!channel) {
        const numericChannel = numberOrNull(message.channel);
        if (numericChannel != null) {
          channel = String(numericChannel);
        } else {
          channel = stringOrNull(message.channel);
        }
      }

      const metadataSegments = [timestamp, frequency, preset, channel]
        .map(value => `[${value ? escapeHtml(value) : '—'}]`)
        .join('');

      const messageNode = message.node && typeof message.node === 'object' ? message.node : null;
      const badgeHtml = renderRoleAwareBadge(renderShortHtml, {
        shortName: messageNode?.short_name ?? messageNode?.shortName ?? fallbackNode?.shortName ?? fallbackNode?.short_name,
        longName: messageNode?.long_name ?? messageNode?.longName ?? fallbackNode?.longName ?? fallbackNode?.long_name,
        role: messageNode?.role ?? fallbackNode?.role ?? null,
        identifier:
          message.node_id
            ?? message.nodeId
            ?? message.from_id
            ?? message.fromId
            ?? fallbackNode?.nodeId
            ?? fallbackNode?.node_id
            ?? null,
        numericId:
          message.node_num
            ?? message.nodeNum
            ?? message.from_num
            ?? message.fromNum
            ?? fallbackNode?.nodeNum
            ?? fallbackNode?.node_num
            ?? null,
        source: messageNode ?? fallbackNode?.rawSources?.node ?? fallbackNode,
      });

      return `<li>${metadataSegments} ${badgeHtml}, ${escapeHtml(text)}</li>`;
    })
    .filter(item => item != null);
  if (items.length === 0) return '';
  return `<ul class="node-detail__list">${items.join('')}</ul>`;
}

/**
 * Render the node detail layout to an HTML fragment.
 *
 * @param {Object} node Normalised node payload.
 * @param {{
 *   neighbors?: Array<Object>,
 *   messages?: Array<Object>,
 *   renderShortHtml: Function,
 * }} options Rendering options.
 * @returns {string} HTML fragment representing the detail view.
 */
function renderNodeDetailHtml(node, { neighbors = [], messages = [], renderShortHtml }) {
  const roleAwareBadge = renderRoleAwareBadge(renderShortHtml, {
    shortName: node.shortName ?? node.short_name,
    longName: node.longName ?? node.long_name,
    role: node.role,
    identifier: node.nodeId ?? node.node_id ?? null,
    numericId: node.nodeNum ?? node.node_num ?? node.num ?? null,
    source: node.rawSources?.node ?? node,
  });
  const longName = stringOrNull(node.longName ?? node.long_name);
  const identifier = stringOrNull(node.nodeId ?? node.node_id);
  const tableHtml = renderSingleNodeTable(node, renderShortHtml);
  const neighborsHtml = renderNeighborGroups(node, neighbors, renderShortHtml);
  const messagesHtml = renderMessages(messages, renderShortHtml, node);

  const sections = [];
  if (neighborsHtml) {
    sections.push(neighborsHtml);
  }
  if (Array.isArray(messages) && messages.length > 0 && messagesHtml) {
    sections.push(`<section class="node-detail__section"><h3>Messages</h3>${messagesHtml}</section>`);
  }

  const identifierHtml = identifier ? `<span class="node-detail__identifier">[${escapeHtml(identifier)}]</span>` : '';
  const nameHtml = longName ? `<span class="node-detail__name">${escapeHtml(longName)}</span>` : '';
  const badgeHtml = `<span class="node-detail__badge">${roleAwareBadge}</span>`;
  const tableSection = tableHtml ? `<div class="node-detail__table">${tableHtml}</div>` : '';
  const contentHtml = sections.length > 0 ? `<div class="node-detail__content">${sections.join('')}</div>` : '';

  return `
    <header class="node-detail__header">
      <h2 class="node-detail__title">${badgeHtml}${nameHtml}${identifierHtml}</h2>
    </header>
    ${tableSection}
    ${contentHtml}
  `;
}

/**
 * Parse the serialized reference payload embedded in the DOM.
 *
 * @param {string} raw Raw JSON string.
 * @returns {Object|null} Parsed object or ``null`` when invalid.
 */
function parseReferencePayload(raw) {
  const trimmed = stringOrNull(raw);
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (error) {
    console.warn('Failed to parse node reference payload', error);
    return null;
  }
}

/**
 * Resolve the canonical renderShortHtml implementation, waiting briefly for
 * the dashboard to expose it when necessary.
 *
 * @param {Function|undefined} override Explicit override supplied by tests.
 * @returns {Promise<Function>} Badge rendering implementation.
 */
async function resolveRenderShortHtml(override) {
  if (typeof override === 'function') return override;
  const deadline = Date.now() + RENDER_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const candidate = globalThis.PotatoMesh?.renderShortHtml;
    if (typeof candidate === 'function') {
      return candidate;
    }
    await new Promise(resolve => setTimeout(resolve, RENDER_WAIT_INTERVAL_MS));
  }
  return short => `<span class="short-name">${escapeHtml(short ?? '?')}</span>`;
}

/**
 * Fetch recent messages for a node. Private mode bypasses the request.
 *
 * @param {string} identifier Canonical node identifier.
 * @param {{fetchImpl?: Function, includeEncrypted?: boolean, privateMode?: boolean}} options Fetch options.
 * @returns {Promise<Array<Object>>} Resolved message collection.
 */
async function fetchMessages(identifier, { fetchImpl, includeEncrypted = false, privateMode = false } = {}) {
  if (privateMode) return [];
  const fetchFn = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    throw new TypeError('A fetch implementation is required to load node messages');
  }
  const encodedId = encodeURIComponent(String(identifier));
  const encryptedFlag = includeEncrypted ? '&encrypted=1' : '';
  const url = `/api/messages/${encodedId}?limit=${MESSAGE_LIMIT}${encryptedFlag}`;
  const response = await fetchFn(url, DEFAULT_FETCH_OPTIONS);
  if (response.status === 404) return [];
  if (!response.ok) {
    throw new Error(`Failed to load node messages (HTTP ${response.status})`);
  }
  const payload = await response.json();
  return Array.isArray(payload) ? payload : [];
}

/**
 * Initialise the node detail page by hydrating the DOM with fetched data.
 *
 * @param {{
 *   document?: Document,
 *   fetchImpl?: Function,
 *   refreshImpl?: Function,
 *   renderShortHtml?: Function,
 * }} options Optional overrides for testing.
 * @returns {Promise<boolean>} ``true`` when the node was rendered successfully.
 */
export async function initializeNodeDetailPage(options = {}) {
  const documentRef = options.document ?? globalThis.document;
  if (!documentRef || typeof documentRef.querySelector !== 'function') {
    throw new TypeError('A document with querySelector support is required');
  }
  const root = documentRef.querySelector('#nodeDetail');
  if (!root) return false;

  const filterContainer = typeof documentRef.querySelector === 'function'
    ? documentRef.querySelector('.filter-input')
    : null;
  if (filterContainer) {
    if (typeof filterContainer.remove === 'function') {
      filterContainer.remove();
    } else {
      filterContainer.hidden = true;
    }
  }

  const referenceData = parseReferencePayload(root.dataset?.nodeReference ?? null);
  if (!referenceData) {
    root.innerHTML = '<p class="node-detail__error">Node reference unavailable.</p>';
    return false;
  }

  const identifier = stringOrNull(referenceData.nodeId) ?? null;
  const nodeNum = numberOrNull(referenceData.nodeNum);
  if (!identifier && nodeNum == null) {
    root.innerHTML = '<p class="node-detail__error">Node identifier missing.</p>';
    return false;
  }

  const refreshImpl = typeof options.refreshImpl === 'function' ? options.refreshImpl : refreshNodeInformation;
  const renderShortHtml = await resolveRenderShortHtml(options.renderShortHtml);
  const privateMode = (root.dataset?.privateMode ?? '').toLowerCase() === 'true';

  try {
    const node = await refreshImpl(referenceData, { fetchImpl: options.fetchImpl });
    const messages = await fetchMessages(identifier ?? node.nodeId ?? node.node_id ?? nodeNum, {
      fetchImpl: options.fetchImpl,
      privateMode,
    });
    const html = renderNodeDetailHtml(node, {
      neighbors: node.neighbors,
      messages,
      renderShortHtml,
    });
    root.innerHTML = html;
    return true;
  } catch (error) {
    console.error('Failed to render node detail page', error);
    root.innerHTML = '<p class="node-detail__error">Failed to load node details.</p>';
    return false;
  }
}

export const __testUtils = {
  stringOrNull,
  numberOrNull,
  escapeHtml,
  formatFrequency,
  formatBattery,
  formatVoltage,
  formatUptime,
  formatTimestamp,
  formatHardwareModel,
  formatCoordinate,
  formatRelativeSeconds,
  formatDurationSeconds,
  formatSnr,
  categoriseNeighbors,
  renderNeighborGroups,
  renderSingleNodeTable,
  renderMessages,
  renderNodeDetailHtml,
  parseReferencePayload,
  resolveRenderShortHtml,
  fetchMessages,
};
