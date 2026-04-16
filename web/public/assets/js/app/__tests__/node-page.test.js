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

import test from 'node:test';
import assert from 'node:assert/strict';

import { initializeNodeDetailPage, fetchNodeDetailHtml, __testUtils } from '../node-page.js';
import { getRoleColor, getRoleKey, translateRoleId } from '../role-helpers.js';

const {
  stringOrNull,
  numberOrNull,
  formatFrequency,
  formatBattery,
  formatVoltage,
  formatUptime,
  formatTimestamp,
  formatMessageTimestamp,
  formatHardwareModel,
  formatCoordinate,
  formatRelativeSeconds,
  formatDurationSeconds,
  formatSnr,
  padTwo,
  normalizeNodeId,
  cloneRoleIndex,
  registerRoleCandidate,
  lookupRole,
  lookupNeighborDetails,
  seedNeighborRoleIndex,
  buildNeighborRoleIndex,
  collectTraceNodeFetchMap,
  buildTraceRoleIndex,
  categoriseNeighbors,
  renderNeighborGroups,
  renderSingleNodeTable,
  classifySnapshot,
  renderTelemetryCharts,
  renderMessages,
  renderTraceroutes,
  renderTracePath,
  extractTracePath,
  normalizeTraceNodeRef,
  renderNodeDetailHtml,
  parseReferencePayload,
  resolveRenderShortHtml,
  fetchMessages,
  fetchTracesForNode,
} = __testUtils;

/**
 * Builds a node fixture whose telemetry comes from the aggregated API path
 * (node.rawSources.telemetry.snapshots). typeFilter is skipped for this path
 * so all series data is visible regardless of telemetry_type.
 * @param {object[]} snapshots
 */
// Shared time anchor used by most chart tests.  One fixed value lets Sonar
// identify the setup as a constant rather than repeated literal.
const CHART_NOW_MS = Date.UTC(2025, 0, 8, 12, 0, 0);
const CHART_NOW_SECONDS = Math.floor(CHART_NOW_MS / 1000);

function makeAggregatedNode(snapshots) {
  return { rawSources: { telemetry: { snapshots } } };
}

/**
 * Builds a node fixture whose telemetry comes from the per-packet history path
 * (node.rawSources.telemetrySnapshots). typeFilter IS applied for this path,
 * so device/power/environment rows are separated by chart.
 * @param {object[]} snapshots
 */
function makeHistoryNode(snapshots) {
  return { rawSources: { telemetrySnapshots: snapshots } };
}

test('format helpers normalise values as expected', () => {
  assert.equal(stringOrNull('  foo  '), 'foo');
  assert.equal(stringOrNull(''), null);
  assert.equal(numberOrNull('42'), 42);
  assert.equal(numberOrNull('abc'), null);
  assert.equal(formatFrequency(915), '915.000 MHz');
  assert.equal(formatFrequency('2400000'), '2.400 MHz');
  assert.equal(formatFrequency('custom'), 'custom');
  assert.equal(formatBattery(87.135), '87.1%');
  assert.equal(formatVoltage(4.105), '4.11 V');
  assert.equal(formatUptime(3661), '1h 1m 1s');
  assert.match(formatTimestamp(1_700_000_000), /T/);
  assert.equal(padTwo(3), '03');
  assert.equal(normalizeNodeId('!NODE'), '!node');
  const messageTimestamp = formatMessageTimestamp(1_700_000_000);
  assert.match(messageTimestamp, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});

test('role lookup helpers normalise identifiers and register candidates', () => {
  const index = { byId: new Map(), byNum: new Map() };
  registerRoleCandidate(index, {
    identifier: '!NODE',
    numericId: 77,
    role: 'ROUTER',
    shortName: 'NODE',
    longName: 'Node Long',
  });
  assert.equal(index.byId.get('!node'), 'ROUTER');
  assert.equal(index.byNum.get(77), 'ROUTER');
  assert.equal(lookupRole(index, { identifier: '!node' }), 'ROUTER');
  assert.equal(lookupRole(index, { identifier: '!NODE' }), 'ROUTER');
  assert.equal(lookupRole(index, { numericId: 77 }), 'ROUTER');
  assert.equal(lookupRole(index, { identifier: '!missing' }), null);
  const metadata = lookupNeighborDetails(index, { identifier: '!node', numericId: 77 });
  assert.deepEqual(metadata, { role: 'ROUTER', shortName: 'NODE', longName: 'Node Long' });
});

test('numeric role identifiers resolve to canonical labels and colours', () => {
  assert.equal(translateRoleId(12), 'CLIENT_BASE');
  assert.equal(getRoleKey(12), 'CLIENT_BASE');
  assert.equal(getRoleKey('2'), 'ROUTER');
  assert.equal(getRoleColor(2), getRoleColor('ROUTER'));
  assert.equal(getRoleColor(11), getRoleColor('ROUTER_LATE'));
});

test('seedNeighborRoleIndex captures known roles and missing identifiers', () => {
  const index = { byId: new Map(), byNum: new Map() };
  const missing = seedNeighborRoleIndex(index, [
    { neighbor_id: '!ALLY', neighbor_role: 'CLIENT', neighbor_short_name: 'ALLY' },
    { node_id: '!self', node_role: 'ROUTER' },
    { neighbor_id: '!unknown' },
  ]);
  assert.equal(index.byId.get('!ally'), 'CLIENT');
  assert.equal(index.byId.get('!self'), 'ROUTER');
  assert.equal(missing.has('!unknown'), true);
  const allyDetails = lookupNeighborDetails(index, { identifier: '!ally' });
  assert.equal(allyDetails.shortName, 'ALLY');
});

test('additional format helpers provide table friendly output', () => {
  assert.equal(formatHardwareModel('UNSET'), '');
  assert.equal(formatHardwareModel('T-Beam'), 'T-Beam');
  assert.equal(formatCoordinate(52.123456), '52.12346');
  assert.equal(formatCoordinate(null), '');
  assert.equal(formatRelativeSeconds(1_000, 1_060), '1m');
  assert.equal(formatRelativeSeconds(1_000, 1_120), '2m');
  assert.equal(formatRelativeSeconds(1_000, 1_000 + 3_700), '1h 1m');
  assert.equal(formatRelativeSeconds(1_000, 1_000 + 90_000).startsWith('1d'), true);
  assert.equal(formatDurationSeconds(59), '59s');
  assert.equal(formatDurationSeconds(61), '1m 1s');
  assert.equal(formatDurationSeconds(3_661), '1h 1m');
  assert.equal(formatDurationSeconds(172_800), '2d');
  assert.equal(formatSnr(12.345), '12.3 dB');
  assert.equal(formatSnr(null), '');

  const renderShortHtml = (short, role) => `<span class="short-name" data-role="${role}">${short}</span>`;
  const nodeContext = {
    shortName: 'NODE',
    longName: 'Node Long',
    role: 'CLIENT',
    nodeId: '!node',
    nodeNum: 77,
    rawSources: { node: { node_id: '!node', role: 'CLIENT', short_name: 'NODE' } },
  };
  const messagesHtml = renderMessages(
    [
      {
        text: 'hello',
        rx_time: 1_700_000_400,
        region_frequency: 868,
        modem_preset: 'MediumFast',
        channel_name: 'Primary',
        node: { short_name: 'SRCE', role: 'ROUTER', node_id: '!src' },
      },
      { text: ' GAA= ', encrypted: true, rx_time: 1_700_000_405 },
      { emoji: '😊', rx_time: 1_700_000_401 },
    ],
    renderShortHtml,
    nodeContext,
  );
  assert.equal(messagesHtml.includes('hello'), true);
  assert.equal(messagesHtml.includes('GAA='), false);
  assert.equal(messagesHtml.includes('😊'), true);
  assert.match(messagesHtml, /\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\]\[868\]/);
  assert.equal(messagesHtml.includes('[868]'), true);
  assert.equal(messagesHtml.includes('[MF]'), true);
  assert.equal(messagesHtml.includes('[Primary]'), true);
  assert.equal(messagesHtml.includes('data-role="ROUTER"'), true);
  assert.equal(messagesHtml.includes('&nbsp;&nbsp;&nbsp;'), true);
  assert.equal(messagesHtml.includes('&nbsp;&nbsp;'), true);
  assert.equal(messagesHtml.includes('data-role="CLIENT"'), true);
  assert.equal(messagesHtml.includes(', hello'), false);
});

test('categoriseNeighbors splits inbound and outbound records', () => {
  const node = { nodeId: '!self', nodeNum: 42 };
  const neighbors = [
    { node_id: '!self', neighbor_id: '!ally-one' },
    { node_id: '!peer', neighbor_id: '!SELF' },
    { node_num: 42, neighbor_id: '!ally-two' },
    { node_id: '!friend', neighbor_num: 42 },
    null,
  ];
  const { heardBy, weHear } = categoriseNeighbors(node, neighbors);
  assert.equal(heardBy.length, 2);
  assert.equal(weHear.length, 2);
});

test('renderNeighborGroups renders grouped neighbour lists', () => {
  const node = { nodeId: '!self', nodeNum: 77 };
  const neighbors = [
    {
      node_id: '!peer',
      node_short_name: 'PEER',
      neighbor_id: '!self',
      snr: 9.5,
      node: { short_name: 'PEER', role: 'ROUTER' },
    },
    {
      node_id: '!self',
      neighbor_id: '!ally',
      neighbor_short_name: 'ALLY',
      snr: 5.25,
      neighbor: { short_name: 'ALLY', role: 'REPEATER' },
    },
  ];
  const html = renderNeighborGroups(
    node,
    neighbors,
    (short, role) => `<span class="badge" data-role="${role}">${short}</span>`,
  );
  assert.equal(html.includes('Neighbors'), true);
  assert.equal(html.includes('Heard by'), true);
  assert.equal(html.includes('We hear'), true);
  assert.equal(html.includes('PEER'), true);
  assert.equal(html.includes('ALLY'), true);
  assert.equal(html.includes('9.5 dB'), true);
  assert.equal(html.includes('5.3 dB'), true);
  assert.equal(html.includes('data-role="ROUTER"'), true);
  assert.equal(html.includes('data-role="REPEATER"'), true);
});

test('buildNeighborRoleIndex fetches missing neighbor metadata from the API', async () => {
  const neighbors = [
    { neighbor_id: '!ally', neighbor_short_name: 'ALLY' },
  ];
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    return {
      status: 200,
      ok: true,
      json: async () => ({ node_id: '!ally', role: 'ROUTER', node_num: 99, short_name: 'ALLY-API' }),
    };
  };
  const index = await buildNeighborRoleIndex({ nodeId: '!self', role: 'CLIENT' }, neighbors, { fetchImpl });
  assert.equal(index.byId.get('!self'), 'CLIENT');
  assert.equal(index.byId.get('!ally'), 'ROUTER');
  assert.equal(index.byNum.get(99), 'ROUTER');
  assert.equal(calls.some(url => url.startsWith('/api/nodes/')), true);
  const allyMetadata = lookupNeighborDetails(index, { identifier: '!ally', numericId: 99 });
  assert.equal(allyMetadata.shortName, 'ALLY-API');
});

test('buildTraceRoleIndex hydrates hop metadata using node lookups', async () => {
  const traces = [{ src: '!src', hops: [42], dest: '!dest' }];
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    if (url.includes('0000002a')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { node_id: '!hop', node_num: 42, short_name: 'HOPR', long_name: 'Hop Route', role: 'ROUTER' };
        },
      };
    }
    if (url.includes('/api/nodes/!dest')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { node_id: '!dest', short_name: 'DESTN', long_name: 'Destination', role: 'CLIENT' };
        },
      };
    }
    return { ok: false, status: 404, async json() { return {}; } };
  };
  const baseIndex = cloneRoleIndex({
    byId: new Map([['!src', 'CLIENT']]),
    byNum: new Map(),
    detailsById: new Map([['!src', { shortName: 'SRC1', role: 'CLIENT' }]]),
    detailsByNum: new Map(),
  });
  const fetchMap = collectTraceNodeFetchMap(traces, baseIndex);
  assert.equal(fetchMap.size, 2);
  const roleIndex = await buildTraceRoleIndex(traces, baseIndex, { fetchImpl });
  const hopDetails = lookupNeighborDetails(roleIndex, { numericId: 42 });
  const destDetails = lookupNeighborDetails(roleIndex, { identifier: '!dest' });
  assert.equal(hopDetails.shortName, 'HOPR');
  assert.equal(hopDetails.longName, 'Hop Route');
  assert.equal(destDetails.shortName, 'DESTN');
  assert.equal(destDetails.longName, 'Destination');
  assert.equal(calls.some(url => url.includes('%21src')), false);
});

test('cloneRoleIndex builds isolated maps and collectTraceNodeFetchMap handles numeric placeholders', () => {
  const baseIndex = {
    byId: new Map([['!known', 'CLIENT']]),
    byNum: new Map([[7, 'ROUTER']]),
    detailsById: new Map([['!known', { shortName: 'KNWN' }]]),
    detailsByNum: new Map([[7, { shortName: 'SEVN' }]]),
  };
  const clone = cloneRoleIndex(baseIndex);
  assert.notStrictEqual(clone.byId, baseIndex.byId);
  assert.notStrictEqual(clone.byNum, baseIndex.byNum);
  assert.notStrictEqual(clone.detailsById, baseIndex.detailsById);
  assert.notStrictEqual(clone.detailsByNum, baseIndex.detailsByNum);

  const fetchMap = collectTraceNodeFetchMap([{ src: 7, hops: [88], dest: null }], clone);
  assert.equal(fetchMap.has('!00000058'), true);
  assert.equal(fetchMap.get('!00000058'), '!00000058');
  assert.equal(fetchMap.has('!known'), false);
});

test('renderSingleNodeTable renders a condensed table for the node', () => {
  const node = {
    shortName: 'NODE',
    longName: 'Example Node',
    nodeId: '!abcd',
    role: 'CLIENT',
    hwModel: 'T-Beam',
    battery: 66,
    voltage: 4.12,
    uptime: 3_700,
    channel_utilization: 1.23,
    airUtil: 0.45,
    temperature: 22.5,
    humidity: 55.5,
    pressure: 1_013.2,
    latitude: 52.52,
    longitude: 13.405,
    altitude: 40,
    lastHeard: 9_900,
    positionTime: 9_850,
    rawSources: { node: { node_id: '!abcd', role: 'CLIENT' } },
  };
  const html = renderSingleNodeTable(
    node,
    (short, role) => `<span class="short-name" data-role="${role}">${short}</span>`,
    10_000,
  );
  assert.equal(html.includes('<table'), true);
  assert.ok(!html.includes('meshtastic.svg'), 'absent protocol should show no meshtastic icon in long name link');
  assert.match(html, /<a class="node-long-link" href="\/nodes\/!abcd" data-node-detail-link="true" data-node-id="!abcd">.*Example Node<\/a>/s);
  assert.equal(html.includes('66.0%'), true);
  assert.equal(html.includes('1.230%'), true);
  assert.equal(html.includes('52.52000'), true);
  assert.equal(html.includes('1m 40s'), true);
  assert.equal(html.includes('2m 30s'), true);
});

test('renderTelemetryCharts renders condensed scatter charts when telemetry exists', () => {
  const nowMs = CHART_NOW_MS;
  const nowSeconds = CHART_NOW_SECONDS;
  const node = makeAggregatedNode([
    {
      rx_time: nowSeconds - 60,
      telemetry_type: 'device',
      battery_level: 80,
      voltage: 4.1,
      channel_utilization: 40,
      air_util_tx: 22,
    },
    {
      rx_time: nowSeconds - 3_600,
      telemetry_type: 'environment',
      temperature: 18.4,
      relative_humidity: 52,
      barometric_pressure: 1000,
      gas_resistance: 2000,
      iaq: 88,
    },
  ]);
  const html = renderTelemetryCharts(node, { nowMs });
  const fmt = new Date(nowMs);
  const expectedDate = String(fmt.getDate()).padStart(2, '0');
  assert.equal(html.includes('node-detail__charts'), true);
  assert.equal(html.includes('Device health'), true);
  assert.equal(html.includes('Environmental telemetry'), true);
  assert.equal(html.includes('Battery (%)'), true);
  assert.equal(html.includes('Voltage (V)'), true);
  assert.equal(html.includes('Channel utilization (%)'), true);
  assert.equal(html.includes('Air util TX (%)'), true);
  assert.equal(html.includes('Utilization (%)'), true);
  assert.equal(html.includes('Gas resistance (\u03a9)'), true);
  assert.equal(html.includes('Air quality'), true);
  assert.equal(html.includes('IAQ index'), true);
  assert.equal(html.includes('Temperature (\u00b0C)'), true);
  assert.equal(html.includes(expectedDate), true);
  assert.equal(html.includes('node-detail__chart-point'), true);
});

test('renderTelemetryCharts expands upper bounds when overflow metrics exceed defaults', () => {
  const nowMs = CHART_NOW_MS;
  const nowSeconds = CHART_NOW_SECONDS;
  const node = makeAggregatedNode([
    {
      rx_time: nowSeconds - 120,
      telemetry_type: 'device',
      battery_level: 90,
      voltage: 7.2,
      channel_utilization: 45,
      air_util_tx: 18,
    },
    {
      rx_time: nowSeconds - 180,
      telemetry_type: 'environment',
      temperature: 45,
      relative_humidity: 48,
      barometric_pressure: 1250,
      gas_resistance: 1200,
      iaq: 650,
    },
  ]);
  const html = renderTelemetryCharts(node, { nowMs });
  assert.match(html, />7\.2<\/text>/);
  assert.match(html, />45<\/text>/);
  assert.match(html, />650<\/text>/);
  assert.match(html, />1100<\/text>/);
});

test('renderTelemetryCharts keeps default bounds when metrics stay within limits', () => {
  const nowMs = CHART_NOW_MS;
  const nowSeconds = CHART_NOW_SECONDS;
  const node = makeAggregatedNode([
    {
      rx_time: nowSeconds - 180,
      telemetry_type: 'device',
      battery_level: 70,
      voltage: 4.5,
      channel_utilization: 35,
      air_util_tx: 15,
    },
    {
      rx_time: nowSeconds - 240,
      telemetry_type: 'environment',
      temperature: 25,
      relative_humidity: 50,
      barometric_pressure: 1015,
      gas_resistance: 1500,
      iaq: 200,
    },
  ]);
  const html = renderTelemetryCharts(node, { nowMs });
  assert.match(html, />6\.0<\/text>/);
  assert.match(html, />40<\/text>/);
  assert.match(html, />500<\/text>/);
});

test('classifySnapshot returns stored telemetry_type when present', () => {
  assert.equal(classifySnapshot({ telemetry_type: 'device' }), 'device');
  assert.equal(classifySnapshot({ telemetry_type: 'environment' }), 'environment');
  assert.equal(classifySnapshot({ telemetry_type: 'power' }), 'power');
  assert.equal(classifySnapshot({ telemetry_type: 'air_quality' }), 'air_quality');
});

test('classifySnapshot falls back to field-presence heuristics for legacy rows', () => {
  // Flat battery field → device
  assert.equal(classifySnapshot({ battery_level: 80 }), 'device');
  // channel_utilization → device
  assert.equal(classifySnapshot({ channel_utilization: 40 }), 'device');
  // Nested device_metrics shape → device
  assert.equal(classifySnapshot({ device_metrics: { battery_level: 80 } }), 'device');
  // Nested camelCase shape → device
  assert.equal(classifySnapshot({ deviceMetrics: { batteryLevel: 78 } }), 'device');
  // Flat temperature → environment
  assert.equal(classifySnapshot({ temperature: 21.5 }), 'environment');
  // Nested environment_metrics → environment
  assert.equal(classifySnapshot({ environment_metrics: { temperature: 20 } }), 'environment');
  // voltage+current with no battery → power
  assert.equal(classifySnapshot({ current: 0.5, voltage: 5.0 }), 'power');
  // Empty or null → unknown
  assert.equal(classifySnapshot({}), 'unknown');
  assert.equal(classifySnapshot(null), 'unknown');
  assert.equal(classifySnapshot(undefined), 'unknown');
});

test('renderTelemetryCharts shows device-health chart for device snapshots and power-sensor chart for power snapshots', () => {
  const nowMs = CHART_NOW_MS;
  const nowSeconds = CHART_NOW_SECONDS;
  const node = makeHistoryNode([
    {
      rx_time: nowSeconds - 60,
      telemetry_type: 'device',
      battery_level: 80,
      voltage: 4.1,
      channel_utilization: 40,
    },
    {
      rx_time: nowSeconds - 120,
      telemetry_type: 'power',
      voltage: 5.0,
      current: 0.5,
    },
  ]);
  const html = renderTelemetryCharts(node, { nowMs });
  assert.equal(html.includes('Device health'), true, 'Device health chart should render');
  assert.equal(html.includes('Battery (%)'), true, 'Battery series label from device chart');
  assert.equal(html.includes('Power sensor'), true, 'Power sensor chart should render');
  assert.equal(html.includes('Current (A)'), true, 'Current series label from power chart');
});

test('renderTelemetryCharts backward compat: old rows without telemetry_type render via heuristics', () => {
  const nowMs = CHART_NOW_MS;
  const nowSeconds = CHART_NOW_SECONDS;
  const node = makeHistoryNode([
    {
      rx_time: nowSeconds - 60,
      battery_level: 75,
      voltage: 4.08,
      channel_utilization: 30,
    },
  ]);
  const html = renderTelemetryCharts(node, { nowMs });
  assert.equal(html.includes('Device health'), true, 'Device health renders via battery_level heuristic');
  assert.equal(html.includes('Battery (%)'), true, 'Battery series present');
});

test('renderTelemetryCharts power-sensor chart does not include device snapshots (per-packet history)', () => {
  const nowMs = CHART_NOW_MS;
  const nowSeconds = CHART_NOW_SECONDS;
  // Per-packet history path: typeFilter IS applied, so device rows are excluded from power-sensor chart
  const node = makeHistoryNode([
    {
      rx_time: nowSeconds - 60,
      telemetry_type: 'device',
      battery_level: 80,
      voltage: 4.1,
    },
  ]);
  const html = renderTelemetryCharts(node, { nowMs });
  assert.equal(html.includes('Device health'), true, 'Device health renders');
  assert.equal(html.includes('Power sensor'), false, 'Power sensor should not render with only device snapshots');
});

test('renderTelemetryCharts aggregated mixed-bucket without telemetry_type shows all series', () => {
  const nowMs = CHART_NOW_MS;
  const nowSeconds = CHART_NOW_SECONDS;
  // Aggregated path: typeFilter is skipped; a bucket combining battery + temperature shows both charts
  const node = makeAggregatedNode([
    {
      rx_time: nowSeconds - 60,
      battery_level: 80,
      voltage: 4.1,
      channel_utilization: 30,
      temperature: 21.5,
      relative_humidity: 55,
    },
  ]);
  const html = renderTelemetryCharts(node, { nowMs });
  assert.equal(html.includes('Device health'), true, 'Device health renders from battery field');
  assert.equal(html.includes('Environmental telemetry'), true, 'Environment renders from temperature field');
});

test('renderNodeDetailHtml composes the table, neighbors, and messages', () => {
  const html = renderNodeDetailHtml(
    {
      shortName: 'NODE',
      longName: 'Example Node',
      nodeId: '!abcd',
      nodeNum: 77,
      role: 'CLIENT',
      battery: 60,
      voltage: 4.1,
      uptime: 1_000,
      latitude: 52.5,
      longitude: 13.4,
      altitude: 40,
    },
    {
      neighbors: [
        { node_id: '!peer', node_short_name: 'PEER', neighbor_id: '!abcd', snr: 7.5 },
        { node_id: '!abcd', neighbor_id: '!ally', neighbor_short_name: 'ALLY', snr: 5.1 },
      ],
      messages: [{ text: 'Hello', rx_time: 1_700_000_111 }],
      traces: [
        { src: '!abcd', hops: ['!beef'], dest: '!ally' },
      ],
      renderShortHtml: (short, role) => `<span class="short-name" data-role="${role}">${short}</span>`,
    },
  );
  assert.equal(html.includes('node-detail__table'), true);
  assert.equal(html.includes('Neighbors'), true);
  assert.equal(html.includes('Heard by'), true);
  assert.equal(html.includes('We hear'), true);
  assert.equal(html.includes('Messages'), true);
  assert.ok(!html.includes('meshtastic.svg'), 'absent protocol should show no meshtastic icon in heading and table');
  assert.match(html, /<a class="node-long-link" href="\/nodes\/!abcd" data-node-detail-link="true" data-node-id="!abcd">.*Example Node<\/a>/s);
  assert.equal(html.includes('PEER'), true);
  assert.equal(html.includes('ALLY'), true);
  assert.equal(html.includes('Traceroutes'), true);
  assert.match(html, /&rarr;/);
  assert.match(html, /\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\]\[/);
  assert.equal(html.includes('data-role="CLIENT"'), true);
});

test('renderNodeDetailHtml embeds telemetry charts when snapshots are present', () => {
  const nowMs = Date.UTC(2025, 0, 8, 7, 0, 0);
  const node = {
    shortName: 'NODE',
    nodeId: '!abcd',
    role: 'CLIENT',
    rawSources: {
      node: { node_id: '!abcd', role: 'CLIENT', short_name: 'NODE' },
      ...makeAggregatedNode([
        {
          rx_time: Math.floor(nowMs / 1000) - 120,
          telemetry_type: 'device',
          battery_level: 75,
          voltage: 4.08,
          channel_utilization: 30,
        },
        {
          rx_time: Math.floor(nowMs / 1000) - 180,
          telemetry_type: 'environment',
          temperature: 20,
          relative_humidity: 45,
          barometric_pressure: 990,
          gas_resistance: 1800,
        },
      ]).rawSources,
    },
  };
  const html = renderNodeDetailHtml(node, {
    renderShortHtml: short => `<span class="short-name">${short}</span>`,
    chartNowMs: nowMs,
  });
  assert.equal(html.includes('node-detail__charts'), true);
  assert.equal(html.includes('Device health'), true);
  assert.equal(html.includes('Air quality'), true);
});

// --- Protocol icon in renderSingleNodeTable ---

test('renderSingleNodeTable shows meshtastic icon for meshtastic protocol in long name link', () => {
  const node = {
    shortName: 'A',
    longName: 'Alice',
    nodeId: '!aa',
    role: 'CLIENT',
    protocol: 'meshtastic',
    rawSources: { node: { node_id: '!aa', role: 'CLIENT' } },
  };
  const html = renderSingleNodeTable(node, (short, role) => `<span data-role="${role}">${short}</span>`, 0);
  assert.ok(html.includes('meshtastic.svg'), 'meshtastic protocol should show icon in long name link');
});

test('renderSingleNodeTable shows no protocol icon when protocol is absent in long name link', () => {
  const node = {
    shortName: 'A',
    longName: 'Alice',
    nodeId: '!aa',
    role: 'CLIENT',
    rawSources: { node: { node_id: '!aa', role: 'CLIENT' } },
  };
  const html = renderSingleNodeTable(node, (short, role) => `<span data-role="${role}">${short}</span>`, 0);
  assert.ok(!html.includes('meshtastic.svg'), 'absent protocol should show no meshtastic icon in long name link');
  assert.ok(!html.includes('meshcore.svg'), 'absent protocol should show no meshcore icon in long name link');
});

test('renderSingleNodeTable omits meshtastic icon for meshcore protocol in long name link', () => {
  const node = {
    shortName: 'M',
    longName: 'MeshCore Node',
    nodeId: '!mc',
    role: 'REPEATER',
    protocol: 'meshcore',
    rawSources: { node: { node_id: '!mc', role: 'REPEATER' } },
  };
  const html = renderSingleNodeTable(node, (short, role) => `<span data-role="${role}">${short}</span>`, 0);
  assert.ok(!html.includes('meshtastic.svg'), 'meshcore protocol should not show meshtastic icon in long name link');
});

// --- Protocol icon in renderNodeDetailHtml heading ---

test('renderNodeDetailHtml shows meshtastic icon in heading for meshtastic protocol', () => {
  const html = renderNodeDetailHtml(
    { shortName: 'A', longName: 'Alice', nodeId: '!aa', role: 'CLIENT', protocol: 'meshtastic' },
    { renderShortHtml: short => `<span>${short}</span>` },
  );
  assert.ok(html.includes('meshtastic.svg'), 'meshtastic protocol should show icon in heading');
});

test('renderNodeDetailHtml shows no protocol icon in heading when protocol is absent', () => {
  const html = renderNodeDetailHtml(
    { shortName: 'A', longName: 'Alice', nodeId: '!aa', role: 'CLIENT' },
    { renderShortHtml: short => `<span>${short}</span>` },
  );
  assert.ok(!html.includes('meshtastic.svg'), 'absent protocol should show no meshtastic icon in heading');
  assert.ok(!html.includes('meshcore.svg'), 'absent protocol should show no meshcore icon in heading');
});

test('renderNodeDetailHtml omits meshtastic icon in heading for meshcore protocol', () => {
  const html = renderNodeDetailHtml(
    { shortName: 'M', longName: 'MeshCore Node', nodeId: '!mc', role: 'REPEATER', protocol: 'meshcore' },
    { renderShortHtml: short => `<span>${short}</span>` },
  );
  assert.ok(!html.includes('meshtastic.svg'), 'meshcore protocol should not show icon in heading');
});

// --- Protocol icon in renderMessages chat ---

test('renderMessages prefixes meshtastic icon for meshtastic node protocol', () => {
  const nodeContext = {
    shortName: 'SRC',
    longName: 'Source',
    role: 'CLIENT',
    nodeId: '!src',
    nodeNum: 1,
    rawSources: { node: { node_id: '!src', role: 'CLIENT', short_name: 'SRC' } },
    protocol: 'meshtastic',
  };
  const html = renderMessages(
    [{ text: 'hello', rx_time: 1_700_000_000, node: { short_name: 'SRC', role: 'CLIENT', protocol: 'meshtastic' } }],
    (short, role) => `<span data-role="${role}">${short}</span>`,
    nodeContext,
  );
  assert.ok(html.includes('meshtastic.svg'), 'meshtastic node chat entry should show icon');
});

test('renderMessages shows no protocol icon when node protocol is absent', () => {
  const nodeContext = {
    shortName: 'SRC',
    longName: 'Source',
    role: 'CLIENT',
    nodeId: '!src',
    nodeNum: 1,
    rawSources: { node: { node_id: '!src', role: 'CLIENT', short_name: 'SRC' } },
  };
  const html = renderMessages(
    [{ text: 'hello', rx_time: 1_700_000_000, node: { short_name: 'SRC', role: 'CLIENT' } }],
    (short, role) => `<span data-role="${role}">${short}</span>`,
    nodeContext,
  );
  assert.ok(!html.includes('meshtastic.svg'), 'absent node protocol chat entry should show no meshtastic icon');
  assert.ok(!html.includes('meshcore.svg'), 'absent node protocol chat entry should show no meshcore icon');
});

test('renderMessages: channel name fallback uses message.channel_label when metadata is empty (#727 coverage)', () => {
  // Exercises the ``fallbackChannel`` branch in renderMessages: when
  // extractChatMessageMetadata does not return a channelName (because the
  // message has neither ``channel_name`` nor ``channelName``) but does
  // carry a legacy ``channel_label`` field, that string is promoted into
  // the metadata object so the channel tag still renders.
  const renderShortHtml = (short) => `<span class="short-name">${short}</span>`;
  const html = renderMessages(
    [{ text: 'hi', rx_time: 1_700_000_000, channel_label: 'legacy-label' }],
    renderShortHtml,
    { node_id: '!self', short_name: 'NODE', long_name: 'Node', role: 'CLIENT' },
  );
  assert.ok(html.includes('[legacy-label]'), 'channel_label fallback should appear in tag');
});

test('renderMessages: channel name fallback uses numeric message.channel when no string label exists (#727 coverage)', () => {
  // Exercises the ``numberOrNull(message.channel)`` branch: a numeric
  // channel index without an associated channel_name is stringified into
  // the channel tag.
  const renderShortHtml = (short) => `<span class="short-name">${short}</span>`;
  const html = renderMessages(
    [{ text: 'hi', rx_time: 1_700_000_000, channel: 7 }],
    renderShortHtml,
    { node_id: '!self', short_name: 'NODE', long_name: 'Node', role: 'CLIENT' },
  );
  assert.ok(html.includes('[7]'), 'numeric channel fallback should appear in tag');
});

test('renderMessages: channel name fallback uses string message.channel when neither label nor number is present (#727 coverage)', () => {
  // Exercises the final ``stringOrNull(message.channel)`` branch.  This
  // covers the path where ``channel`` is a non-numeric string label that
  // ``numberOrNull`` rejects but ``stringOrNull`` accepts.
  const renderShortHtml = (short) => `<span class="short-name">${short}</span>`;
  const html = renderMessages(
    [{ text: 'hi', rx_time: 1_700_000_000, channel: 'alpha' }],
    renderShortHtml,
    { node_id: '!self', short_name: 'NODE', long_name: 'Node', role: 'CLIENT' },
  );
  assert.ok(html.includes('[alpha]'), 'string channel fallback should appear in tag');
});

test('renderMessages: skips invalid entries in the global node registry (#727 coverage)', () => {
  // Covers the ``if (id && node && typeof node === 'object')`` guard inside
  // buildNodesById.  Bad entries (null values, non-id keys) must be ignored
  // without breaking the registry build.
  const renderShortHtml = (short) => `<span class="short-name">${short}</span>`;
  const globalNodesById = new Map([
    ['', { node_id: '', short_name: 'EMPTY' }],   // empty-id entry — skipped
    ['!ok', { node_id: '!ok', short_name: 'OK', long_name: 'OK Node' }],
    ['!bad', null],                                // null value — skipped
  ]);
  const html = renderMessages(
    [{ text: '@[OK Node] hi', rx_time: 1_700_000_000, protocol: 'meshcore', to_id: '^all' }],
    renderShortHtml,
    { node_id: '!self', short_name: 'NODE', long_name: 'Node', role: 'CLIENT' },
    globalNodesById,
  );
  // The mention should resolve via the surviving entry, demonstrating the
  // registry build skipped the bad ones without throwing.
  assert.ok(html.includes('OK'), 'valid registry entry should still resolve mention');
});

test('renderMessages omits meshtastic icon for meshcore node protocol', () => {
  const nodeContext = {
    shortName: 'MC',
    longName: 'MeshCore',
    role: 'REPEATER',
    nodeId: '!mc',
    nodeNum: 2,
    rawSources: { node: { node_id: '!mc', role: 'REPEATER', short_name: 'MC' } },
    protocol: 'meshcore',
  };
  const html = renderMessages(
    [{ text: 'test', rx_time: 1_700_000_000, node: { short_name: 'MC', role: 'REPEATER', protocol: 'meshcore' } }],
    (short, role) => `<span data-role="${role}">${short}</span>`,
    nodeContext,
  );
  assert.ok(!html.includes('meshtastic.svg'), 'meshcore node chat entry should not show meshtastic icon');
});

test('fetchNodeDetailHtml renders the node layout for overlays', async () => {
  const reference = { nodeId: '!alpha' };
  const calledUrls = [];
  const fetchImpl = async url => {
    calledUrls.push(url);
    if (url.startsWith('/api/messages/')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return [{ text: 'Overlay hello', rx_time: 1_700_000_000 }];
        },
      };
    }
    if (url.startsWith('/api/traces/')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return [{ src: '!alpha', dest: '!bravo', hops: [] }];
        },
      };
    }
    return {
      ok: false,
      status: 404,
      async json() { return []; },
    };
  };
  const refreshImpl = async () => ({
    nodeId: '!alpha',
    nodeNum: 1,
    shortName: 'ALPH',
    longName: 'Example Alpha',
    role: 'CLIENT',
    neighbors: [],
    rawSources: { node: { node_id: '!alpha', role: 'CLIENT', short_name: 'ALPH' } },
  });
  const html = await fetchNodeDetailHtml(reference, {
    refreshImpl,
    fetchImpl,
    renderShortHtml: short => `<span class="short-name">${short}</span>`,
  });
  assert.equal(calledUrls.some(url => url.includes('/api/messages/!alpha')), true);
  assert.equal(calledUrls.some(url => url.includes('/api/traces/!alpha')), true);
  assert.equal(html.includes('Example Alpha'), true);
  assert.equal(html.includes('Overlay hello'), true);
  assert.equal(html.includes('Traceroutes'), true);
  assert.equal(html.includes('node-detail__table'), true);
});

test('fetchNodeDetailHtml hydrates traceroute nodes with API metadata', async () => {
  const reference = { nodeId: '!origin' };
  const calledUrls = [];
  const fetchImpl = async url => {
    calledUrls.push(url);
    if (url.startsWith('/api/messages/')) {
      return { ok: true, status: 200, async json() { return []; } };
    }
    if (url.startsWith('/api/traces/')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return [{ src: '!origin', hops: ['!relay'], dest: '!target' }];
        },
      };
    }
    if (url.includes('/api/nodes/!relay')) {
      return { ok: true, status: 200, async json() { return { node_id: '!relay', short_name: 'RLY1', role: 'REPEATER' }; } };
    }
    if (url.includes('/api/nodes/!target')) {
      return { ok: true, status: 200, async json() { return { node_id: '!target', short_name: 'TGT1', long_name: 'Trace Target', role: 'CLIENT' }; } };
    }
    return { ok: true, status: 200, async json() { return { node_id: '!origin', short_name: 'ORIG', role: 'CLIENT' }; } };
  };
  const refreshImpl = async () => ({
    nodeId: '!origin',
    nodeNum: 7,
    shortName: 'ORIG',
    longName: 'Origin Node',
    role: 'CLIENT',
    neighbors: [],
    rawSources: { node: { node_id: '!origin', role: 'CLIENT', short_name: 'ORIG' } },
  });

  const html = await fetchNodeDetailHtml(reference, {
    refreshImpl,
    fetchImpl,
    renderShortHtml: short => `<span class="short-name">${short}</span>`,
  });

  assert.equal(calledUrls.some(url => url.includes('/api/nodes/!relay')), true);
  assert.equal(calledUrls.some(url => url.includes('/api/nodes/!target')), true);
  assert.equal(html.includes('RLY1'), true);
  assert.equal(html.includes('TGT1'), true);
});

test('fetchNodeDetailHtml requires a node identifier reference', async () => {
  await assert.rejects(
    () => fetchNodeDetailHtml({}, { refreshImpl: async () => ({}) }),
    /identifier/i,
  );
});

test('parseReferencePayload returns null for invalid JSON', () => {
  assert.equal(parseReferencePayload('{'), null);
  assert.deepEqual(parseReferencePayload('{"nodeId":"!abc"}'), { nodeId: '!abc' });
});

test('resolveRenderShortHtml prefers global implementation when available', async () => {
  const original = globalThis.PotatoMesh;
  try {
    globalThis.PotatoMesh = { renderShortHtml: () => '<span>ok</span>' };
    const fn = await resolveRenderShortHtml();
    assert.equal(fn('X'), '<span>ok</span>');
  } finally {
    globalThis.PotatoMesh = original;
  }
});

test('resolveRenderShortHtml falls back when no implementation is exposed', async () => {
  const original = globalThis.PotatoMesh;
  try {
    delete globalThis.PotatoMesh;
    const fn = await resolveRenderShortHtml();
    assert.equal(typeof fn, 'function');
    assert.equal(fn('AB'), '<span class="short-name">AB</span>');
  } finally {
    globalThis.PotatoMesh = original;
  }
});

test('fetchMessages handles HTTP responses and uses defaults', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return {
      status: 200,
      ok: true,
      json: async () => [{ text: 'hi', rx_time: 1 }],
    };
  };
  const messages = await fetchMessages('!node', { fetchImpl });
  assert.equal(messages.length, 1);
  assert.equal(calls[0].options.cache, 'default');
});

test('fetchMessages returns an empty list when the endpoint is missing', async () => {
  const fetchImpl = async () => ({ status: 404, ok: false, json: async () => ({}) });
  const messages = await fetchMessages('!node', { fetchImpl });
  assert.deepEqual(messages, []);
});

test('normalizeTraceNodeRef canonicalizes references and renderTracePath builds arrowed output', () => {
  const ref = normalizeTraceNodeRef(1234);
  assert.deepEqual(ref, { identifier: '!000004d2', numericId: 1234 });
  const roleIndex = {
    byId: new Map([['!000004d2', 'CLIENT']]),
    byNum: new Map(),
    detailsById: new Map([['!000004d2', { shortName: 'NODE', role: 'ROUTER' }]]),
    detailsByNum: new Map(),
  };
  const path = extractTracePath({ src: 1234, hops: [0xbeef], dest: '!ally' });
  const html = renderTracePath(path, (short, role) => `<span data-role="${role}">${short}</span>`, {
    roleIndex,
    node: { nodeId: '!000004d2', shortName: 'NODE', role: 'ROUTER' },
  });
  assert.notEqual(html, '');
  assert.match(html, /data-role="ROUTER"/);
  assert.match(html, /&rarr;/);
});

test('renderTraceroutes lists traceroute paths with badges', () => {
  const traces = [
    { src: '!one', hops: ['!two'], dest: '!three' },
  ];
  const html = renderTraceroutes(traces, short => `<span class="short-name">${short}</span>`, {
    roleIndex: null,
  });
  assert.equal(html.includes('Traceroutes'), true);
  assert.equal(html.includes('short-name'), true);
});

test('renderTraceroutes skips empty or single-hop paths and renderTracePath uses node metadata', () => {
  const pathHtml = renderTracePath([{ identifier: '!self', numericId: 1 }], short => `<b>${short}</b>`, {
    roleIndex: null,
    node: { nodeId: '!self', shortName: 'SELF', role: 'ROUTER' },
  });
  assert.equal(pathHtml, '');

  const html = renderTraceroutes(
    [{ src: '!self', hops: [], dest: '!peer' }],
    (short, role) => `<span data-role="${role}">${short}</span>`,
    {
      roleIndex: {
        detailsById: new Map([['!self', { shortName: 'SELF', role: 'CLIENT' }]]),
        detailsByNum: new Map(),
        byId: new Map([['!peer', 'ROUTER']]),
        byNum: new Map(),
      },
      node: { nodeId: '!self', shortName: 'SELF', role: 'ADMIN' },
    },
  );
  assert.equal(html.includes('Traceroutes'), true);
  assert.match(html, /data-role="ADMIN"/);
});

test('renderTrace helpers normalise references and short-circuit when traces are empty', () => {
  assert.deepEqual(normalizeTraceNodeRef('!abcd'), { identifier: '!abcd', numericId: null });
  assert.equal(extractTracePath(null).length, 0);
  const html = renderTraceroutes([], () => '', { roleIndex: null });
  assert.equal(html, '');
});

test('fetchTracesForNode requests traceroutes for the node', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return {
      status: 200,
      ok: true,
      json: async () => [{ src: '!abc', dest: '!def', hops: [] }],
    };
  };
  const traces = await fetchTracesForNode('!abc', { fetchImpl });
  assert.equal(traces.length, 1);
  assert.equal(calls[0].url.includes('/api/traces/!abc'), true);
  assert.equal(calls[0].options.cache, 'default');
});

test('fetchTracesForNode returns empty when identifier is missing', async () => {
  const traces = await fetchTracesForNode(null, { fetchImpl: () => { throw new Error('should not run'); } });
  assert.deepEqual(traces, []);
});

test('fetchTracesForNode throws on HTTP error', async () => {
  await assert.rejects(
    () => fetchTracesForNode('!err', {
      fetchImpl: async () => ({ status: 500, ok: false, json: async () => ({}) }),
    }),
    /Failed to load traceroutes/,
  );
});

test('initializeNodeDetailPage hydrates the container with node data', async () => {
  const element = {
    dataset: {
      nodeReference: JSON.stringify({ nodeId: '!node', fallback: { short_name: 'NODE' } }),
      privateMode: 'false',
    },
    innerHTML: '',
  };
  const documentStub = {
    querySelector: selector => (selector === '#nodeDetail' ? element : null),
  };
  const refreshImpl = async reference => {
    assert.equal(reference.nodeId, '!node');
    return {
      shortName: 'NODE',
      longName: 'Node Long',
      nodeId: '!node',
      role: 'CLIENT',
      modemPreset: 'LongFast',
      loraFreq: 915,
      battery: 66,
      voltage: 4.1,
      uptime: 100,
      latitude: 52.5,
      longitude: 13.4,
      altitude: 42,
      neighbors: [{ node_id: '!node', neighbor_id: '!ally', snr: 5.5 }],
      rawSources: { node: { node_id: '!node', role: 'CLIENT' } },
    };
  };
  const fetchImpl = async url => {
    if (url.startsWith('/api/messages/')) {
      return {
        status: 200,
        ok: true,
        json: async () => [{ text: 'hello', rx_time: 1_700_000_222 }],
      };
    }
    if (url.startsWith('/api/nodes/')) {
      return {
        status: 200,
        ok: true,
        json: async () => ({ node_id: '!ally', role: 'ROUTER', short_name: 'ALLY-API' }),
      };
    }
    return { status: 404, ok: false, json: async () => ({}) };
  };
  const renderShortHtml = short => `<span class="short-name">${short}</span>`;
  const result = await initializeNodeDetailPage({
    document: documentStub,
    refreshImpl,
    fetchImpl,
    renderShortHtml,
  });
  assert.equal(result, true);
  assert.equal(element.innerHTML.includes('Node Long'), true);
  assert.equal(element.innerHTML.includes('node-detail__table'), true);
  assert.equal(element.innerHTML.includes('Neighbors'), true);
  assert.equal(element.innerHTML.includes('Messages'), true);
  assert.equal(element.innerHTML.includes('ALLY-API'), true);
});

test('initializeNodeDetailPage removes legacy filter controls when supported', async () => {
  const element = {
    dataset: {
      nodeReference: JSON.stringify({ nodeId: '!node', fallback: { short_name: 'NODE' } }),
      privateMode: 'false',
    },
    innerHTML: '',
  };
  const filterContainer = {
    removed: false,
    remove() {
      this.removed = true;
    },
  };
  const documentStub = {
    querySelector: selector => {
      if (selector === '#nodeDetail') return element;
      if (selector === '.filter-input') return filterContainer;
      return null;
    },
  };
  const refreshImpl = async () => ({
    shortName: 'NODE',
    nodeId: '!node',
    role: 'CLIENT',
    neighbors: [],
    rawSources: { node: { node_id: '!node', role: 'CLIENT' } },
  });
  const fetchImpl = async () => ({ status: 404, ok: false });
  const renderShortHtml = short => `<span class="short-name">${short}</span>`;
  const result = await initializeNodeDetailPage({
    document: documentStub,
    refreshImpl,
    fetchImpl,
    renderShortHtml,
  });
  assert.equal(result, true);
  assert.equal(filterContainer.removed, true);
});

test('initializeNodeDetailPage hides legacy filter controls when removal is unavailable', async () => {
  const element = {
    dataset: {
      nodeReference: JSON.stringify({ nodeId: '!node', fallback: { short_name: 'NODE' } }),
      privateMode: 'false',
    },
    innerHTML: '',
  };
  const filterContainer = { hidden: false };
  const documentStub = {
    querySelector: selector => {
      if (selector === '#nodeDetail') return element;
      if (selector === '.filter-input') return filterContainer;
      return null;
    },
  };
  const refreshImpl = async () => ({
    shortName: 'NODE',
    nodeId: '!node',
    role: 'CLIENT',
    neighbors: [],
    rawSources: { node: { node_id: '!node', role: 'CLIENT' } },
  });
  const fetchImpl = async () => ({ status: 404, ok: false });
  const renderShortHtml = short => `<span class="short-name">${short}</span>`;
  const result = await initializeNodeDetailPage({
    document: documentStub,
    refreshImpl,
    fetchImpl,
    renderShortHtml,
  });
  assert.equal(result, true);
  assert.equal(filterContainer.hidden, true);
});

test('initializeNodeDetailPage reports an error when refresh fails', async () => {
  const element = {
    dataset: {
      nodeReference: JSON.stringify({ nodeId: '!missing' }),
      privateMode: 'false',
    },
    innerHTML: '',
  };
  const documentStub = { querySelector: () => element };
  const refreshImpl = async () => {
    throw new Error('boom');
  };
  const renderShortHtml = short => `<span>${short}</span>`;
  const originalError = console.error;
  console.error = () => {};
  try {
    const result = await initializeNodeDetailPage({
      document: documentStub,
      refreshImpl,
      renderShortHtml,
    });
    assert.equal(result, false);
    assert.equal(element.innerHTML.includes('Failed to load'), true);
  } finally {
    console.error = originalError;
  }
});

test('initializeNodeDetailPage handles missing reference payloads', async () => {
  const element = {
    dataset: {},
    innerHTML: '',
  };
  const documentStub = { querySelector: () => element };
  const renderShortHtml = short => `<span>${short}</span>`;
  const result = await initializeNodeDetailPage({ document: documentStub, renderShortHtml });
  assert.equal(result, false);
  assert.equal(element.innerHTML.includes('Node reference unavailable'), true);
});
