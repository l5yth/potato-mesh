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
  fmtCurrent,
  fmtGasResistance,
  fmtDistance,
  fmtLux,
  fmtWindDirection,
  fmtWindSpeed,
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
 * Build the configuration definition list entries for the provided node.
 *
 * @param {Object} node Normalised node payload.
 * @returns {Array<{label: string, value: string}>} Configuration entries.
 */
function buildConfigurationEntries(node) {
  const entries = [];
  if (!node || typeof node !== 'object') return entries;
  const modem = stringOrNull(node.modemPreset ?? node.modem_preset);
  if (modem) entries.push({ label: 'Modem preset', value: modem });
  const freq = formatFrequency(node.loraFreq ?? node.lora_freq);
  if (freq) entries.push({ label: 'LoRa frequency', value: freq });
  const role = stringOrNull(node.role);
  if (role) entries.push({ label: 'Role', value: role });
  const hwModel = stringOrNull(node.hwModel ?? node.hw_model);
  if (hwModel) entries.push({ label: 'Hardware model', value: hwModel });
  const nodeNum = numberOrNull(node.nodeNum ?? node.node_num ?? node.num);
  if (nodeNum != null) entries.push({ label: 'Node number', value: String(nodeNum) });
  const snr = numberOrNull(node.snr);
  if (snr != null) entries.push({ label: 'SNR', value: `${snr.toFixed(1)} dB` });
  const lastSeen = formatTimestamp(node.lastHeard, node.lastSeenIso ?? node.last_seen_iso);
  if (lastSeen) entries.push({ label: 'Last heard', value: lastSeen });
  return entries;
}

/**
 * Build telemetry entries incorporating additional environmental metrics.
 *
 * @param {Object} node Normalised node payload.
 * @returns {Array<{label: string, value: string}>} Telemetry entries.
 */
function buildTelemetryEntries(node) {
  const entries = [];
  if (!node || typeof node !== 'object') return entries;
  const battery = formatBattery(node.battery ?? node.battery_level);
  if (battery) entries.push({ label: 'Battery', value: battery });
  const voltage = formatVoltage(node.voltage);
  if (voltage) entries.push({ label: 'Voltage', value: voltage });
  const uptime = formatUptime(node.uptime ?? node.uptime_seconds);
  if (uptime) entries.push({ label: 'Uptime', value: uptime });
  const channel = fmtTx(node.channel ?? node.channel_utilization ?? node.channelUtilization ?? null, 3);
  if (channel) entries.push({ label: 'Channel utilisation', value: channel });
  const airUtil = fmtTx(node.airUtil ?? node.air_util_tx ?? node.airUtilTx ?? null, 3);
  if (airUtil) entries.push({ label: 'Air util (TX)', value: airUtil });
  const temperature = fmtTemperature(node.temperature ?? node.temp);
  if (temperature) entries.push({ label: 'Temperature', value: temperature });
  const humidity = fmtHumidity(node.humidity ?? node.relative_humidity ?? node.relativeHumidity);
  if (humidity) entries.push({ label: 'Humidity', value: humidity });
  const pressure = fmtPressure(node.pressure ?? node.barometric_pressure ?? node.barometricPressure);
  if (pressure) entries.push({ label: 'Pressure', value: pressure });

  const telemetry = node.telemetry && typeof node.telemetry === 'object' ? node.telemetry : {};
  const current = fmtCurrent(telemetry.current);
  if (current) entries.push({ label: 'Current', value: current });
  const gas = fmtGasResistance(telemetry.gas_resistance ?? telemetry.gasResistance);
  if (gas) entries.push({ label: 'Gas resistance', value: gas });
  const iaq = numberOrNull(telemetry.iaq);
  if (iaq != null) entries.push({ label: 'IAQ', value: String(Math.round(iaq)) });
  const distance = fmtDistance(telemetry.distance);
  if (distance) entries.push({ label: 'Distance', value: distance });
  const lux = fmtLux(telemetry.lux);
  if (lux) entries.push({ label: 'Lux', value: lux });
  const uv = fmtLux(telemetry.uv_lux ?? telemetry.uvLux);
  if (uv) entries.push({ label: 'UV index', value: uv });
  const windDir = fmtWindDirection(telemetry.wind_direction ?? telemetry.windDirection);
  if (windDir) entries.push({ label: 'Wind direction', value: windDir });
  const windSpeed = fmtWindSpeed(telemetry.wind_speed ?? telemetry.windSpeed);
  if (windSpeed) entries.push({ label: 'Wind speed', value: windSpeed });
  const windGust = fmtWindSpeed(telemetry.wind_gust ?? telemetry.windGust);
  if (windGust) entries.push({ label: 'Wind gust', value: windGust });
  const rainfallHour = fmtDistance(telemetry.rainfall_1h ?? telemetry.rainfall1h);
  if (rainfallHour) entries.push({ label: 'Rainfall (1h)', value: rainfallHour });
  const rainfallDay = fmtDistance(telemetry.rainfall_24h ?? telemetry.rainfall24h);
  if (rainfallDay) entries.push({ label: 'Rainfall (24h)', value: rainfallDay });

  const telemetryTimestamp = formatTimestamp(
    telemetry.telemetry_time ?? node.telemetryTime,
    telemetry.telemetry_time_iso ?? node.telemetryTimeIso,
  );
  if (telemetryTimestamp) entries.push({ label: 'Telemetry time', value: telemetryTimestamp });

  return entries;
}

/**
 * Build the positional metadata entries for the provided node.
 *
 * @param {Object} node Normalised node payload.
 * @returns {Array<{label: string, value: string}>} Position entries.
 */
function buildPositionEntries(node) {
  const entries = [];
  if (!node || typeof node !== 'object') return entries;
  const latitude = numberOrNull(node.latitude ?? node.lat);
  if (latitude != null) entries.push({ label: 'Latitude', value: latitude.toFixed(6) });
  const longitude = numberOrNull(node.longitude ?? node.lon);
  if (longitude != null) entries.push({ label: 'Longitude', value: longitude.toFixed(6) });
  const altitude = fmtAlt(node.altitude ?? node.alt, ' m');
  if (altitude) entries.push({ label: 'Altitude', value: altitude });

  const position = node.position && typeof node.position === 'object' ? node.position : {};
  const sats = numberOrNull(position.sats_in_view ?? position.satsInView);
  if (sats != null) entries.push({ label: 'Satellites', value: String(sats) });
  const precision = numberOrNull(position.precision_bits ?? position.precisionBits);
  if (precision != null) entries.push({ label: 'Precision bits', value: String(precision) });
  const source = stringOrNull(position.location_source ?? position.locationSource);
  if (source) entries.push({ label: 'Location source', value: source });
  const positionTimestamp = formatTimestamp(
    node.positionTime ?? position.position_time,
    node.positionTimeIso ?? position.position_time_iso,
  );
  if (positionTimestamp) entries.push({ label: 'Position time', value: positionTimestamp });
  const rxTimestamp = formatTimestamp(position.rx_time, position.rx_iso);
  if (rxTimestamp) entries.push({ label: 'RX time', value: rxTimestamp });
  return entries;
}

/**
 * Render a definition list as HTML.
 *
 * @param {Array<{label: string, value: string}>} entries Definition entries.
 * @returns {string} HTML string for the definition list.
 */
function renderDefinitionList(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return '';
  }
  const rows = entries
    .filter(entry => stringOrNull(entry?.label) && stringOrNull(entry?.value))
    .map(entry =>
      `<div class="node-detail__row"><dt>${escapeHtml(entry.label)}</dt><dd>${escapeHtml(entry.value)}</dd></div>`,
    );
  if (rows.length === 0) return '';
  return `<dl class="node-detail__list">${rows.join('')}</dl>`;
}

/**
 * Render neighbor information as an unordered list.
 *
 * @param {Array<Object>} neighbors Neighbor records.
 * @returns {string} HTML string for the neighbor section.
 */
function renderNeighbors(neighbors) {
  if (!Array.isArray(neighbors) || neighbors.length === 0) return '';
  const items = neighbors
    .map(entry => {
      if (!entry || typeof entry !== 'object') return null;
      const neighborId = stringOrNull(entry.neighbor_id ?? entry.neighborId ?? entry.node_id ?? entry.nodeId);
      const snr = numberOrNull(entry.snr);
      const rx = formatTimestamp(entry.rx_time, entry.rx_iso);
      const parts = [];
      if (neighborId) parts.push(escapeHtml(neighborId));
      if (snr != null) parts.push(`${snr.toFixed(1)} dB`);
      if (rx) parts.push(escapeHtml(rx));
      if (parts.length === 0) return null;
      return `<li>${parts.join(' — ')}</li>`;
    })
    .filter(item => item != null);
  if (items.length === 0) return '';
  return `<ul class="node-detail__list">${items.join('')}</ul>`;
}

/**
 * Render a message list using basic formatting.
 *
 * @param {Array<Object>} messages Message records.
 * @returns {string} HTML string for the messages section.
 */
function renderMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  const items = messages
    .map(message => {
      if (!message || typeof message !== 'object') return null;
      const text = stringOrNull(message.text) || stringOrNull(message.emoji);
      if (!text) return null;
      const rx = formatTimestamp(message.rx_time, message.rx_iso);
      const fromId = stringOrNull(message.from_id ?? message.fromId);
      const toId = stringOrNull(message.to_id ?? message.toId);
      const parts = [];
      if (rx) parts.push(escapeHtml(rx));
      if (fromId || toId) {
        const route = [fromId, toId].filter(Boolean).map(escapeHtml).join(' → ');
        if (route) parts.push(route);
      }
      parts.push(escapeHtml(text));
      return `<li>${parts.join(' — ')}</li>`;
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
  const roleAwareBadge = typeof renderShortHtml === 'function'
    ? renderShortHtml(node.shortName ?? node.short_name, node.role, node.longName ?? node.long_name, node.rawSources?.node ?? node)
    : escapeHtml(node.shortName ?? node.short_name ?? '?');
  const longName = stringOrNull(node.longName ?? node.long_name);
  const identifier = stringOrNull(node.nodeId ?? node.node_id);

  const configHtml = renderDefinitionList(buildConfigurationEntries(node));
  const telemetryHtml = renderDefinitionList(buildTelemetryEntries(node));
  const positionHtml = renderDefinitionList(buildPositionEntries(node));
  const neighborsHtml = renderNeighbors(neighbors);
  const messagesHtml = renderMessages(messages);

  const sections = [];
  if (configHtml) {
    sections.push(`<section class="node-detail__section"><h3>Configuration</h3>${configHtml}</section>`);
  }
  if (telemetryHtml) {
    sections.push(`<section class="node-detail__section"><h3>Telemetry</h3>${telemetryHtml}</section>`);
  }
  if (positionHtml) {
    sections.push(`<section class="node-detail__section"><h3>Position</h3>${positionHtml}</section>`);
  }
  if (Array.isArray(neighbors) && neighbors.length > 0 && neighborsHtml) {
    sections.push(`<section class="node-detail__section"><h3>Neighbors</h3>${neighborsHtml}</section>`);
  }
  if (Array.isArray(messages) && messages.length > 0 && messagesHtml) {
    sections.push(`<section class="node-detail__section"><h3>Messages</h3>${messagesHtml}</section>`);
  }

  const identifierHtml = identifier ? `<span class="node-detail__identifier">[${escapeHtml(identifier)}]</span>` : '';
  const nameHtml = longName ? `<span class="node-detail__name">${escapeHtml(longName)}</span>` : '';

  return `
    <header class="node-detail__header">
      <h2 class="node-detail__title">${roleAwareBadge}${nameHtml}${identifierHtml}</h2>
    </header>
    <div class="node-detail__content">
      ${sections.join('')}
    </div>
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
  buildConfigurationEntries,
  buildTelemetryEntries,
  buildPositionEntries,
  renderDefinitionList,
  renderNeighbors,
  renderMessages,
  renderNodeDetailHtml,
  parseReferencePayload,
  resolveRenderShortHtml,
  fetchMessages,
};
