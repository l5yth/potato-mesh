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

import { initializeNodeDetailPage, __testUtils } from '../node-page.js';

const {
  stringOrNull,
  numberOrNull,
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
});

test('buildConfigurationEntries collects modem and role details', () => {
  const entries = buildConfigurationEntries({
    modemPreset: 'LongFast',
    loraFreq: 915,
    role: 'ROUTER',
    hwModel: 'T-Beam',
    nodeNum: 7,
    snr: 9.42,
    lastHeard: 1_700_000_001,
  });
  assert.deepEqual(entries.map(entry => entry.label), [
    'Modem preset',
    'LoRa frequency',
    'Role',
    'Hardware model',
    'Node number',
    'SNR',
    'Last heard',
  ]);
});

test('buildTelemetryEntries merges additional metrics', () => {
  const entries = buildTelemetryEntries({
    battery: 75.2,
    voltage: 4.12,
    uptime: 12_345,
    channel: 1.23,
    airUtil: 0.45,
    temperature: 21.5,
    humidity: 55.5,
    pressure: 1013.4,
    telemetry: {
      current: 0.53,
      gas_resistance: 10_000,
      iaq: 42,
      distance: 1.23,
      lux: 35,
      uv_lux: 3.5,
      wind_direction: 180,
      wind_speed: 2.5,
      wind_gust: 4.1,
      rainfall_1h: 0.12,
      rainfall_24h: 1.02,
      telemetry_time: 1_700_000_123,
    },
  });
  const labels = entries.map(entry => entry.label);
  assert.ok(labels.includes('Battery'));
  assert.ok(labels.includes('Voltage'));
  assert.ok(labels.includes('Uptime'));
  assert.ok(labels.includes('Channel utilisation'));
  assert.ok(labels.includes('Air util (TX)'));
  assert.ok(labels.includes('Temperature'));
  assert.ok(labels.includes('Humidity'));
  assert.ok(labels.includes('Pressure'));
  assert.ok(labels.includes('Current'));
  assert.ok(labels.includes('Gas resistance'));
  assert.ok(labels.includes('IAQ'));
  assert.ok(labels.includes('Distance'));
  assert.ok(labels.includes('Lux'));
  assert.ok(labels.includes('UV index'));
  assert.ok(labels.includes('Wind direction'));
  assert.ok(labels.includes('Wind speed'));
  assert.ok(labels.includes('Wind gust'));
  assert.ok(labels.includes('Rainfall (1h)'));
  assert.ok(labels.includes('Rainfall (24h)'));
  assert.ok(labels.includes('Telemetry time'));
});

test('buildPositionEntries includes precision metadata', () => {
  const entries = buildPositionEntries({
    latitude: 52.52,
    longitude: 13.405,
    altitude: 42,
    position: {
      sats_in_view: 12,
      precision_bits: 7,
      location_source: 'GPS',
      position_time: 1_700_000_050,
      rx_time: 1_700_000_055,
    },
  });
  const labels = entries.map(entry => entry.label);
  assert.ok(labels.includes('Latitude'));
  assert.ok(labels.includes('Longitude'));
  assert.ok(labels.includes('Altitude'));
  assert.ok(labels.includes('Satellites'));
  assert.ok(labels.includes('Precision bits'));
  assert.ok(labels.includes('Location source'));
  assert.ok(labels.includes('Position time'));
  assert.ok(labels.includes('RX time'));
});

test('render helpers ignore empty values', () => {
  const listHtml = renderDefinitionList([
    { label: 'Valid', value: 'ok' },
    { label: 'Empty', value: '' },
  ]);
  assert.equal(listHtml.includes('Valid'), true);
  assert.equal(listHtml.includes('Empty'), false);

  const neighborsHtml = renderNeighbors([
    { neighbor_id: '!ally', snr: 9.5, rx_time: 1_700_000_321 },
    null,
  ]);
  assert.equal(neighborsHtml.includes('!ally'), true);

  const messagesHtml = renderMessages([
    { text: 'hello', rx_time: 1_700_000_400, from_id: '!src', to_id: '!dst' },
    { emoji: '😊', rx_time: 1_700_000_401 },
  ]);
  assert.equal(messagesHtml.includes('hello'), true);
  assert.equal(messagesHtml.includes('😊'), true);
});

test('renderNodeDetailHtml composes sections when data exists', () => {
  const html = renderNodeDetailHtml(
    {
      shortName: 'NODE',
      longName: 'Example Node',
      nodeId: '!abcd',
      role: 'CLIENT',
      modemPreset: 'LongFast',
      loraFreq: 915,
      battery: 60,
      voltage: 4.1,
      uptime: 1_000,
      temperature: 22,
      humidity: 50,
      pressure: 1005,
      latitude: 52.5,
      longitude: 13.4,
      altitude: 40,
    },
    {
      neighbors: [{ neighbor_id: '!ally', snr: 7.5 }],
      messages: [{ text: 'Hello', rx_time: 1_700_000_111 }],
      renderShortHtml: (short, role) => `<span class="short-name" data-role="${role}">${short}</span>`,
    },
  );
  assert.equal(html.includes('Configuration'), true);
  assert.equal(html.includes('Telemetry'), true);
  assert.equal(html.includes('Position'), true);
  assert.equal(html.includes('Neighbors'), true);
  assert.equal(html.includes('Messages'), true);
  assert.equal(html.includes('Example Node'), true);
  assert.equal(html.includes('!ally'), true);
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
      neighbors: [{ neighbor_id: '!ally', snr: 5.5 }],
      rawSources: { node: { node_id: '!node', role: 'CLIENT' } },
    };
  };
  const fetchImpl = async () => ({
    status: 200,
    ok: true,
    json: async () => [{ text: 'hello', rx_time: 1_700_000_222 }],
  });
  const renderShortHtml = short => `<span class="short-name">${short}</span>`;
  const result = await initializeNodeDetailPage({
    document: documentStub,
    refreshImpl,
    fetchImpl,
    renderShortHtml,
  });
  assert.equal(result, true);
  assert.equal(element.innerHTML.includes('Node Long'), true);
  assert.equal(element.innerHTML.includes('Neighbors'), true);
  assert.equal(element.innerHTML.includes('Messages'), true);
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
