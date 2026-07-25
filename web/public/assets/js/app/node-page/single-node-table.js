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
 * Render the selected node's metrics as a grouped spec sheet.
 *
 * @module node-page/single-node-table
 */

import { escapeHtml } from '../utils.js';
import {
  fmtAlt,
  fmtHumidity,
  fmtPressure,
  fmtTemperature,
  fmtTx,
} from '../short-info-telemetry.js';
import {
  formatBattery,
  formatCoordinate,
  formatDurationSeconds,
  formatHardwareModel,
  formatRelativeSeconds,
  formatVoltage,
} from '../node-page-charts.js';
import { numberOrNull, stringOrNull } from '../value-helpers.js';
import { formatTableCell } from '../main/table-cell-format.js';
import { tickAttributes, TICK_FORMAT_RELATIVE } from '../main/relative-time-ticker.js';

/**
 * Render one `<dt>/<dd>` field, substituting the muted dash for absent values
 * (SPEC PD1) and carrying optional live-tick attributes on the `<dd>`.
 *
 * @param {string} label Field label (already safe static text).
 * @param {*} value Formatted display value, or nullish/empty when absent.
 * @param {string} [ddAttrs] Extra attributes for the `<dd>` (e.g. tick hooks).
 * @returns {string} `<dt>…</dt><dd>…</dd>` markup.
 */
function specField(label, value, ddAttrs = '') {
  const valueHtml = formatTableCell(escapeHtml(value == null ? '' : String(value)));
  return `<dt>${label}</dt><dd${ddAttrs ? ' ' + ddAttrs : ''}>${valueHtml}</dd>`;
}

/**
 * Render the selected node's metrics as a grouped spec sheet.
 *
 * A single-record view is a spec sheet, not a table (SPEC PD1, Post-Deploy
 * review 01): the one-row 18-column table reused the `#nodes` responsive-hide
 * `.nodes-col--*` classes, so on smaller viewports columns were `display:none`'d
 * with no disclosure row to recover them — data loss on the page whose only job
 * is that node — and absent telemetry rendered as an indistinguishable blank.
 * The spec sheet groups every field as `<dt>/<dd>` (reusing `.node-detail__row`),
 * hides nothing, reflows to one column on mobile with no horizontal scroll, and
 * renders the muted dash for absent values. Identity and the long name live in
 * the page header (`detail-html.js`) and are not repeated here; Activity (Last
 * Seen, Role) stays because the header does not carry it.
 *
 * @param {Object} node Normalised node payload.
 * @param {Function} renderShortHtml Badge renderer (validated for the shared
 *   call signature; the badge itself now lives in the page header).
 * @param {number} [referenceSeconds] Optional reference timestamp for relative
 *   metrics.
 * @returns {string} HTML markup for the node spec sheet, or an empty string.
 */
export function renderSingleNodeTable(node, renderShortHtml, referenceSeconds = Date.now() / 1000) {
  if (!node || typeof node !== 'object' || typeof renderShortHtml !== 'function') {
    return '';
  }

  const role = stringOrNull(node.role) ?? 'CLIENT';
  const hardware = formatHardwareModel(node.hwModel ?? node.hw_model);
  const battery = formatBattery(node.battery ?? node.battery_level);
  const voltage = formatVoltage(node.voltage ?? node.voltageReading);
  const uptime = formatDurationSeconds(node.uptime ?? node.uptime_seconds ?? node.uptimeSeconds);
  const channel = fmtTx(node.channel_utilization ?? node.channelUtilization ?? null, 3);
  const airUtil = fmtTx(node.airUtil ?? node.air_util_tx ?? node.airUtilTx ?? null, 3);
  const temperature = fmtTemperature(node.temperature ?? node.temp);
  const humidity = fmtHumidity(node.humidity ?? node.relative_humidity ?? node.relativeHumidity);
  const pressure = fmtPressure(node.pressure ?? node.barometric_pressure ?? node.barometricPressure);
  const latitude = formatCoordinate(node.latitude ?? node.lat);
  const longitude = formatCoordinate(node.longitude ?? node.lon);
  const altitude = fmtAlt(node.altitude ?? node.alt, 'm');
  const lastSeenTs = numberOrNull(node.lastHeard ?? node.last_heard);
  const lastPositionTs = numberOrNull(node.positionTime ?? node.position_time);
  const lastSeen = formatRelativeSeconds(lastSeenTs, referenceSeconds);
  const lastPosition = formatRelativeSeconds(lastPositionTs, referenceSeconds);
  // Both timestamp fields opt into the shared live tick (SPEC RT1/RT2) with this
  // page's formatRelativeSeconds output preserved verbatim (RT4).
  const lastSeenAttrs = tickAttributes(lastSeenTs, TICK_FORMAT_RELATIVE);
  const lastPositionAttrs = tickAttributes(lastPositionTs, TICK_FORMAT_RELATIVE);

  // Grouped by the same seven groups the nodes table uses (SPEC UX9); Identity
  // and the long name are in the page header, so the sheet omits them.
  const groups = [
    ['Activity', [
      specField('Last Seen', lastSeen, lastSeenAttrs),
      specField('Role', role),
    ]],
    ['Health', [
      specField('Battery', battery),
      specField('Voltage', voltage),
      specField('Uptime', uptime),
      specField('HW Model', hardware),
    ]],
    ['Utilization', [
      specField('Channel Util', channel),
      specField('Air Util Tx', airUtil),
    ]],
    ['Environment', [
      specField('Temperature', temperature),
      specField('Humidity', humidity),
      specField('Pressure', pressure),
    ]],
    ['Position', [
      specField('Latitude', latitude),
      specField('Longitude', longitude),
      specField('Altitude', altitude),
      specField('Last Position', lastPosition, lastPositionAttrs),
    ]],
  ];

  const groupsHtml = groups
    .map(([title, fields]) =>
      `<section class="node-detail-sheet__group">` +
      `<h3 class="node-detail-sheet__group-title">${title}</h3>` +
      `<dl class="node-detail__row">${fields.join('')}</dl>` +
      `</section>`,
    )
    .join('');

  return `<div class="node-detail-sheet" aria-label="Selected node details">${groupsHtml}</div>`;
}
