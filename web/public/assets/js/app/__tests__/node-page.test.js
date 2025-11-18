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
  registerRoleCandidate,
  lookupRole,
  lookupNeighborDetails,
  seedNeighborRoleIndex,
  buildNeighborRoleIndex,
  categoriseNeighbors,
  renderNeighborGroups,
  renderSingleNodeTable,
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
      { emoji: '😊', rx_time: 1_700_000_401 },
    ],
    renderShortHtml,
    nodeContext,
  );
  assert.equal(messagesHtml.includes('hello'), true);
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
  assert.match(html, /<a class="node-long-link" href="\/nodes\/!abcd" data-node-detail-link="true" data-node-id="!abcd">Example Node<\/a>/);
  assert.equal(html.includes('66.0%'), true);
  assert.equal(html.includes('1.230%'), true);
  assert.equal(html.includes('52.52000'), true);
  assert.equal(html.includes('1m 40s'), true);
  assert.equal(html.includes('2m 30s'), true);
});

test('renderTelemetryCharts renders condensed scatter charts when telemetry exists', () => {
  const nowMs = Date.UTC(2025, 0, 8, 12, 0, 0);
  const nowSeconds = Math.floor(nowMs / 1000);
  const node = {
    rawSources: {
      telemetry: {
        snapshots: [
          {
            rx_time: nowSeconds - 60,
            device_metrics: {
              battery_level: 80,
              voltage: 4.1,
              channel_utilization: 40,
              air_util_tx: 22,
            },
            environment_metrics: {
              temperature: 19.5,
              relative_humidity: 55,
              barometric_pressure: 995,
              gas_resistance: 1500,
            },
          },
          {
            rx_time: nowSeconds - 3_600,
            deviceMetrics: {
              batteryLevel: 78,
              voltage: 4.05,
              channelUtilization: 35,
              airUtilTx: 20,
            },
            environmentMetrics: {
              temperature: 18.4,
              relativeHumidity: 52,
              barometricPressure: 1000,
              gasResistance: 2000,
            },
          },
        ],
      },
    },
  };
  const html = renderTelemetryCharts(node, { nowMs });
  const fmt = new Date(nowMs);
  const expectedDate = String(fmt.getDate()).padStart(2, '0');
  assert.equal(html.includes('node-detail__charts'), true);
  assert.equal(html.includes('Power metrics'), true);
  assert.equal(html.includes('Environmental telemetry'), true);
  assert.equal(html.includes('Battery (0-100%)'), true);
  assert.equal(html.includes('Voltage (0-6V)'), true);
  assert.equal(html.includes('Channel utilization (%)'), true);
  assert.equal(html.includes('Air util TX (%)'), true);
  assert.equal(html.includes('Utilization (%)'), true);
  assert.equal(html.includes('Gas resistance (10-100k Ω)'), true);
  assert.equal(html.includes('Temperature (-20-40°C)'), true);
  assert.equal(html.includes(expectedDate), true);
  assert.equal(html.includes('node-detail__chart-point'), true);
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
  assert.match(html, /<a class="node-long-link" href="\/nodes\/!abcd" data-node-detail-link="true" data-node-id="!abcd">Example Node<\/a>/);
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
      telemetry: {
        snapshots: [
          {
            rx_time: Math.floor(nowMs / 1000) - 120,
            battery_level: 75,
            voltage: 4.08,
            channel_utilization: 30,
            temperature: 20,
            relative_humidity: 45,
            barometric_pressure: 990,
            gas_resistance: 1800,
          },
        ],
      },
    },
  };
  const html = renderNodeDetailHtml(node, {
    renderShortHtml: short => `<span class="short-name">${short}</span>`,
    chartNowMs: nowMs,
  });
  assert.equal(html.includes('node-detail__charts'), true);
  assert.equal(html.includes('Power metrics'), true);
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
  assert.equal(calls[0].options.cache, 'no-store');
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
  assert.equal(calls[0].options.cache, 'no-store');
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
  const result = await initializeNodeDetailPage({
    document: documentStub,
    refreshImpl,
    renderShortHtml,
  });
  assert.equal(result, false);
  assert.equal(element.innerHTML.includes('Failed to load'), true);
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
