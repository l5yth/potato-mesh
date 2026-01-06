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

import { __testUtils } from '../node-page.js';
import { buildMovingAverageSeries } from '../charts-page.js';

const {
  createTelemetryCharts,
  buildUPlotChartConfig,
  mountTelemetryCharts,
  mountTelemetryChartsWithRetry,
} = __testUtils;

test('uPlot chart config preserves axes, colors, and tick labels for node telemetry', () => {
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
              current: 0.75,
            },
          },
          {
            rx_time: nowSeconds - 3_600,
            device_metrics: {
              battery_level: 78,
              voltage: 4.05,
              current: 0.65,
            },
          },
        ],
      },
    },
  };
  const { chartModels } = createTelemetryCharts(node, {
    nowMs,
    chartOptions: {
      xAxisTickBuilder: () => [nowMs],
      xAxisTickFormatter: () => '08',
    },
  });
  const powerChart = chartModels.find(model => model.id === 'power');
  const { options, data } = buildUPlotChartConfig(powerChart);

  assert.deepEqual(options.scales.battery.range(), [0, 100]);
  assert.deepEqual(options.scales.voltage.range(), [0, 6]);
  assert.deepEqual(options.scales.current.range(), [0, 3]);
  assert.equal(options.series[1].stroke, '#8856a7');
  assert.equal(options.series[2].stroke, '#9ebcda');
  assert.equal(options.series[3].stroke, '#3182bd');
  assert.deepEqual(options.axes[0].values(null, [nowMs]), ['08']);
  assert.equal(options.axes[0].stroke, '#5c6773');

  assert.deepEqual(data[0].slice(0, 2), [nowMs - 3_600_000, nowMs - 60_000]);
  assert.deepEqual(data[1].slice(0, 2), [78, 80]);
});

test('uPlot chart config maps moving averages and raw points for aggregated telemetry', () => {
  const nowMs = Date.UTC(2025, 0, 8, 12, 0, 0);
  const nowSeconds = Math.floor(nowMs / 1000);
  const snapshots = [
    {
      rx_time: nowSeconds - 3_600,
      device_metrics: { battery_level: 10 },
    },
    {
      rx_time: nowSeconds - 1_800,
      device_metrics: { battery_level: 20 },
    },
  ];
  const node = { rawSources: { telemetry: { snapshots } } };
  const { chartModels } = createTelemetryCharts(node, {
    nowMs,
    chartOptions: {
      lineReducer: points => buildMovingAverageSeries(points, 3_600_000),
    },
  });
  const powerChart = chartModels.find(model => model.id === 'power');
  const { options, data } = buildUPlotChartConfig(powerChart);

  assert.equal(options.series.length, 3);
  assert.equal(options.series[1].stroke.startsWith('rgba('), true);
  assert.equal(options.series[2].stroke, '#8856a7');
  assert.deepEqual(data[1].slice(0, 2), [10, 15]);
  assert.deepEqual(data[2].slice(0, 2), [10, 20]);
});

test('buildUPlotChartConfig applies axis color overrides', () => {
  const nowMs = Date.UTC(2025, 0, 8, 12, 0, 0);
  const nowSeconds = Math.floor(nowMs / 1000);
  const node = {
    rawSources: {
      telemetry: {
        snapshots: [
          {
            rx_time: nowSeconds - 60,
            device_metrics: { battery_level: 80 },
          },
        ],
      },
    },
  };
  const { chartModels } = createTelemetryCharts(node, { nowMs });
  const powerChart = chartModels.find(model => model.id === 'power');
  const { options } = buildUPlotChartConfig(powerChart, {
    axisColor: '#ffffff',
    gridColor: '#222222',
  });
  assert.equal(options.axes[0].stroke, '#ffffff');
  assert.equal(options.axes[0].grid.stroke, '#222222');
});

test('environment chart renders humidity axis on the right side', () => {
  const nowMs = Date.UTC(2025, 0, 8, 12, 0, 0);
  const nowSeconds = Math.floor(nowMs / 1000);
  const node = {
    rawSources: {
      telemetry: {
        snapshots: [
          {
            rx_time: nowSeconds - 60,
            environment_metrics: {
              temperature: 19.5,
              relative_humidity: 55,
            },
          },
        ],
      },
    },
  };
  const { chartModels } = createTelemetryCharts(node, { nowMs });
  const envChart = chartModels.find(model => model.id === 'environment');
  const { options } = buildUPlotChartConfig(envChart);
  const humidityAxis = options.axes.find(axis => axis.scale === 'humidity');
  assert.ok(humidityAxis);
  assert.equal(humidityAxis.side, 1);
  assert.equal(humidityAxis.show, true);
});

test('channel utilization chart includes a right-side utilization axis', () => {
  const nowMs = Date.UTC(2025, 0, 8, 12, 0, 0);
  const nowSeconds = Math.floor(nowMs / 1000);
  const node = {
    rawSources: {
      telemetry: {
        snapshots: [
          {
            rx_time: nowSeconds - 60,
            device_metrics: {
              channel_utilization: 40,
              air_util_tx: 22,
            },
          },
        ],
      },
    },
  };
  const { chartModels } = createTelemetryCharts(node, { nowMs });
  const channelChart = chartModels.find(model => model.id === 'channel');
  const { options } = buildUPlotChartConfig(channelChart);
  const rightAxis = options.axes.find(axis => axis.scale === 'channelSecondary');
  assert.ok(rightAxis);
  assert.equal(rightAxis.side, 1);
  assert.equal(rightAxis.show, true);
});

test('createTelemetryCharts returns empty markup when snapshots are missing', () => {
  const { chartsHtml, chartModels } = createTelemetryCharts({ rawSources: { telemetry: { snapshots: [] } } });
  assert.equal(chartsHtml, '');
  assert.equal(chartModels.length, 0);
});

test('mountTelemetryCharts instantiates uPlot for chart containers', () => {
  const nowMs = Date.UTC(2025, 0, 8, 12, 0, 0);
  const nowSeconds = Math.floor(nowMs / 1000);
  const node = {
    rawSources: {
      telemetry: {
        snapshots: [
          {
            rx_time: nowSeconds - 60,
            device_metrics: { battery_level: 80 },
          },
        ],
      },
    },
  };
  const { chartModels } = createTelemetryCharts(node, { nowMs });
  const [model] = chartModels;
  const plotRoot = { innerHTML: 'placeholder' };
  const chartContainer = {
    querySelector(selector) {
      return selector === '[data-telemetry-plot]' ? plotRoot : null;
    },
  };
  const root = {
    querySelector(selector) {
      return selector === `[data-telemetry-chart-id="${model.id}"]` ? chartContainer : null;
    },
  };
  class UPlotStub {
    constructor(options, data, container) {
      this.options = options;
      this.data = data;
      this.container = container;
    }
  }
  const instances = mountTelemetryCharts(chartModels, { root, uPlotImpl: UPlotStub });
  assert.equal(plotRoot.innerHTML, '');
  assert.equal(instances.length, 1);
  assert.equal(instances[0].container, plotRoot);
});

test('mountTelemetryCharts responds to window resize events', async () => {
  const nowMs = Date.UTC(2025, 0, 8, 12, 0, 0);
  const nowSeconds = Math.floor(nowMs / 1000);
  const node = {
    rawSources: {
      telemetry: {
        snapshots: [
          {
            rx_time: nowSeconds - 60,
            device_metrics: { battery_level: 80 },
          },
        ],
      },
    },
  };
  const { chartModels } = createTelemetryCharts(node, { nowMs });
  const [model] = chartModels;
  const plotRoot = {
    innerHTML: '',
    clientWidth: 320,
    clientHeight: 180,
    getBoundingClientRect() {
      return { width: this.clientWidth, height: this.clientHeight };
    },
  };
  const chartContainer = {
    querySelector(selector) {
      return selector === '[data-telemetry-plot]' ? plotRoot : null;
    },
  };
  const root = {
    querySelector(selector) {
      return selector === `[data-telemetry-chart-id="${model.id}"]` ? chartContainer : null;
    },
  };
  const previousResizeObserver = globalThis.ResizeObserver;
  const previousAddEventListener = globalThis.addEventListener;
  let resizeHandler = null;
  globalThis.ResizeObserver = undefined;
  globalThis.addEventListener = (event, handler) => {
    if (event === 'resize') {
      resizeHandler = handler;
    }
  };
  const sizeCalls = [];
  class UPlotStub {
    constructor(options, data, container) {
      this.options = options;
      this.data = data;
      this.container = container;
      this.root = container;
    }
    setSize(size) {
      sizeCalls.push(size);
    }
  }
  mountTelemetryCharts(chartModels, { root, uPlotImpl: UPlotStub });
  assert.ok(resizeHandler);
  plotRoot.clientWidth = 480;
  plotRoot.clientHeight = 240;
  resizeHandler();
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(sizeCalls.length >= 1, true);
  assert.deepEqual(sizeCalls[sizeCalls.length - 1], { width: 480, height: 240 });
  globalThis.ResizeObserver = previousResizeObserver;
  globalThis.addEventListener = previousAddEventListener;
});

test('mountTelemetryChartsWithRetry loads uPlot when missing', async () => {
  const nowMs = Date.UTC(2025, 0, 8, 12, 0, 0);
  const nowSeconds = Math.floor(nowMs / 1000);
  const node = {
    rawSources: {
      telemetry: {
        snapshots: [
          {
            rx_time: nowSeconds - 60,
            device_metrics: { battery_level: 80 },
          },
        ],
      },
    },
  };
  const { chartModels } = createTelemetryCharts(node, { nowMs });
  const [model] = chartModels;
  const plotRoot = { innerHTML: '', clientWidth: 400, clientHeight: 200 };
  const chartContainer = {
    querySelector(selector) {
      return selector === '[data-telemetry-plot]' ? plotRoot : null;
    },
  };
  const root = {
    ownerDocument: {
      body: {},
      querySelector: () => null,
    },
    querySelector(selector) {
      return selector === `[data-telemetry-chart-id="${model.id}"]` ? chartContainer : null;
    },
  };
  const previousUPlot = globalThis.uPlot;
  const instances = [];
  class UPlotStub {
    constructor(options, data, container) {
      this.options = options;
      this.data = data;
      this.container = container;
      instances.push(this);
    }
  }
  let loadCalled = false;
  const loadUPlot = ({ onLoad }) => {
    loadCalled = true;
    globalThis.uPlot = UPlotStub;
    if (typeof onLoad === 'function') {
      onLoad();
    }
    return true;
  };
  mountTelemetryChartsWithRetry(chartModels, { root, loadUPlot });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(loadCalled, true);
  assert.equal(instances.length, 1);
  globalThis.uPlot = previousUPlot;
});
