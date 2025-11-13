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

import {
  buildMetricSeries,
  computeAxisDomain,
  createNodesChartsController,
  extractMetricValue,
  parseTimestampSeconds,
  SEVEN_DAYS_SECONDS,
  toFiniteNumber
} from '../nodes-charts.js';

/**
 * Minimal element implementation used to exercise DOM interactions without
 * relying on a browser environment.
 */
class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.hidden = false;
    this.textContent = '';
    this.parentNode = null;
    this.style = {
      values: new Map(),
      setProperty: (name, value) => {
        this.style.values.set(name, value);
      }
    };
  }

  appendChild(child) {
    this.children.push(child);
    child.parentNode = this;
    return child;
  }

  replaceChildren(...children) {
    this.children = [];
    for (const child of children) {
      this.appendChild(child);
    }
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'data-role') {
      this.dataset = this.dataset || {};
      this.dataset.role = String(value);
    }
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
}

/**
 * Minimal document abstraction that tracks elements by identifier.
 */
class FakeDocument {
  constructor() {
    this.elements = new Map();
  }

  registerElement(id, element) {
    element.setAttribute('id', id);
    this.elements.set(id, element);
  }

  getElementById(id) {
    return this.elements.get(id) || null;
  }

  createElement(tagName) {
    return new FakeElement(tagName);
  }

  createElementNS(_ns, tagName) {
    return new FakeElement(tagName);
  }
}

function buildTelemetryEntry(overrides = {}) {
  return {
    rx_time: overrides.rx_time ?? 1_000,
    battery_level: overrides.battery_level,
    voltage: overrides.voltage,
    channel_utilization: overrides.channel_utilization,
    air_util_tx: overrides.air_util_tx,
    temperature: overrides.temperature,
    relative_humidity: overrides.relative_humidity,
    barometric_pressure: overrides.barometric_pressure
  };
}

function createChartContainer(document, id) {
  const container = new FakeElement('article');
  const plot = new FakeElement('div');
  plot.setAttribute('data-role', 'plot');
  const legend = new FakeElement('ul');
  legend.setAttribute('data-role', 'legend');
  const empty = new FakeElement('p');
  empty.setAttribute('data-role', 'empty');
  container.appendChild(legend);
  container.appendChild(plot);
  container.appendChild(empty);
  document.registerElement(id, container);
  return { container, plot, legend, empty };
}

function registerCharts(document) {
  createChartContainer(document, 'nodesChartPower');
  createChartContainer(document, 'nodesChartChannel');
  createChartContainer(document, 'nodesChartEnvironment');
  const root = new FakeElement('section');
  document.registerElement('nodesCharts', root);
}

test('toFiniteNumber normalises diverse input', () => {
  assert.equal(toFiniteNumber('42'), 42);
  assert.equal(toFiniteNumber(5.5), 5.5);
  assert.equal(toFiniteNumber(null), null);
  assert.equal(toFiniteNumber('bad'), null);
});

test('parseTimestampSeconds prefers numeric values', () => {
  const entry = { rx_time: 1234, telemetry_time: 2000 };
  assert.equal(parseTimestampSeconds(entry), 1234);

  const iso = new Date(5000 * 1000).toISOString();
  assert.equal(parseTimestampSeconds({ rx_iso: iso }), 5000);
  assert.equal(parseTimestampSeconds({}), null);
});

test('extractMetricValue inspects multiple fields', () => {
  const entry = { battery_level: '90', batteryLevel: 20 };
  assert.equal(extractMetricValue(entry, ['missing', 'batteryLevel']), 20);
  assert.equal(extractMetricValue(entry, ['battery_level']), 90);
  assert.equal(extractMetricValue({}, ['x']), null);
});

test('buildMetricSeries filters entries outside the time window', () => {
  const now = 10_000;
  const entries = [
    { rx_time: now - 10, battery_level: 80 },
    { rx_time: now - SEVEN_DAYS_SECONDS - 10, battery_level: 60 },
    { rx_time: now - 5, battery_level: 90 }
  ];
  const window = { minTimestampSec: now - SEVEN_DAYS_SECONDS, maxTimestampSec: now };
  const series = buildMetricSeries(entries, { id: 'battery', fields: ['battery_level'] }, window);
  assert.deepEqual(series, [
    { timestamp: now - 10, value: 80 },
    { timestamp: now - 5, value: 90 }
  ]);
});

test('computeAxisDomain expands based on data and defaults', () => {
  const seriesList = [
    { metric: { axis: 'left' }, points: [{ value: 10 }, { value: 20 }] },
    { metric: { axis: 'right' }, points: [{ value: 5 }] }
  ];
  const leftConfig = { defaultDomain: [0, 30] };
  const domain = computeAxisDomain(seriesList, leftConfig, 'left');
  assert.ok(domain.min <= 0);
  assert.ok(domain.max >= 30);
});

test('createNodesChartsController renders scatter plots and toggles empty state', () => {
  const document = new FakeDocument();
  registerCharts(document);
  const controller = createNodesChartsController({ document, nowProvider: () => 10_000 * 1000 });
  const powerPlot = document.getElementById('nodesChartPower').children[1];
  const powerEmpty = document.getElementById('nodesChartPower').children[2];
  const powerLegend = document.getElementById('nodesChartPower').children[0];

  // Initially empty state is visible and plot hidden.
  assert.equal(powerPlot.hidden, true);
  assert.equal(powerEmpty.hidden, false);
  assert.equal(powerLegend.children.length, 2);
  const firstSwatch = powerLegend.children[0].children[0];
  assert.equal(firstSwatch.style.values.get('--legend-color'), '#2f855a');

  controller.update([
    buildTelemetryEntry({ rx_time: 10_000 - 60, battery_level: 70, voltage: 3.7 }),
    buildTelemetryEntry({ rx_time: 10_000 - 30, battery_level: 65, voltage: 3.8 })
  ]);

  assert.equal(powerPlot.hidden, false);
  assert.equal(powerEmpty.hidden, true);
  const svg = powerPlot.children[0];
  assert.ok(svg, 'expected svg element to be rendered');
  const seriesGroup = svg.children[2];
  const circles = seriesGroup.children.filter(child => child.tagName === 'CIRCLE');
  assert.equal(circles.length, 4, 'expected one circle per metric sample');
});

test('createNodesChartsController tolerates missing containers', () => {
  const document = new FakeDocument();
  const controller = createNodesChartsController({ document });
  assert.doesNotThrow(() => controller.update([]));
});
