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
 * Telemetry chart specifications driving each node-detail chart.
 *
 * @module node-page-charts/specs
 */

import { fmtCurrent } from '../short-info-telemetry.js';
import { formatGasResistance } from './format-utils.js';

/**
 * Telemetry chart definitions describing axes and series metadata.
 *
 * Each entry drives a separate {@link renderTelemetryChart} call inside
 * {@link module:node-page}.renderTelemetryCharts.
 *
 * @type {ReadonlyArray<Object>}
 */
export const TELEMETRY_CHART_SPECS = Object.freeze([
  {
    id: 'device-health',
    title: 'Device health',
    typeFilter: ['device', 'unknown'],
    axes: [
      {
        id: 'battery',
        position: 'left',
        label: 'Battery (%)',
        min: 0,
        max: 100,
        ticks: 4,
        color: '#8856a7',
      },
      {
        id: 'voltage',
        position: 'right',
        label: 'Voltage (V)',
        min: 0,
        max: 6,
        ticks: 3,
        color: '#9ebcda',
        allowUpperOverflow: true,
      },
    ],
    series: [
      {
        id: 'battery',
        axis: 'battery',
        color: '#8856a7',
        label: 'Battery level',
        legend: 'Battery (%)',
        fields: ['battery', 'battery_level', 'batteryLevel'],
        valueFormatter: value => `${value.toFixed(1)}%`,
      },
      {
        id: 'voltage',
        axis: 'voltage',
        color: '#9ebcda',
        label: 'Voltage',
        legend: 'Voltage (V)',
        fields: ['voltage', 'voltageReading'],
        valueFormatter: value => `${value.toFixed(2)} V`,
      },
    ],
  },
  {
    id: 'power-sensor',
    title: 'Power sensor',
    typeFilter: ['power'],
    axes: [
      {
        id: 'voltage',
        position: 'left',
        label: 'Voltage (V)',
        min: 0,
        max: 6,
        ticks: 3,
        color: '#9ebcda',
        allowUpperOverflow: true,
      },
      {
        id: 'current',
        position: 'right',
        label: 'Current (A)',
        min: 0,
        max: 3,
        ticks: 3,
        color: '#3182bd',
        allowUpperOverflow: true,
      },
    ],
    series: [
      {
        id: 'voltage',
        axis: 'voltage',
        color: '#9ebcda',
        label: 'Voltage',
        legend: 'Voltage (V)',
        fields: ['voltage', 'voltageReading'],
        valueFormatter: value => `${value.toFixed(2)} V`,
      },
      {
        id: 'current',
        axis: 'current',
        color: '#3182bd',
        label: 'Current',
        legend: 'Current (A)',
        fields: ['current'],
        valueFormatter: value => fmtCurrent(value),
      },
    ],
  },
  {
    id: 'channel',
    title: 'Channel utilization',
    typeFilter: ['device', 'unknown'],
    axes: [
      {
        id: 'channel',
        position: 'left',
        label: 'Utilization (%)',
        min: 0,
        max: 100,
        ticks: 4,
        color: '#2ca25f',
      },
    ],
    series: [
      {
        id: 'channel',
        axis: 'channel',
        color: '#2ca25f',
        label: 'Channel util',
        legend: 'Channel utilization (%)',
        fields: ['channel_utilization', 'channelUtilization'],
        valueFormatter: value => `${value.toFixed(1)}%`,
      },
      {
        id: 'air',
        axis: 'channel',
        color: '#99d8c9',
        label: 'Air util tx',
        legend: 'Air util TX (%)',
        fields: ['airUtil', 'air_util_tx', 'airUtilTx'],
        valueFormatter: value => `${value.toFixed(1)}%`,
      },
    ],
  },
  {
    id: 'environment',
    title: 'Environmental telemetry',
    typeFilter: ['environment'],
    axes: [
      {
        id: 'temperature',
        position: 'left',
        label: 'Temperature (°C)',
        min: -20,
        max: 40,
        ticks: 4,
        color: '#fc8d59',
        allowUpperOverflow: true,
      },
      {
        id: 'humidity',
        position: 'left',
        label: 'Humidity (%)',
        min: 0,
        max: 100,
        ticks: 4,
        color: '#91bfdb',
        visible: false,
      },
    ],
    series: [
      {
        id: 'temperature',
        axis: 'temperature',
        color: '#fc8d59',
        label: 'Temperature',
        legend: 'Temperature (°C)',
        fields: ['temperature', 'temp'],
        valueFormatter: value => `${value.toFixed(1)}°C`,
      },
      {
        id: 'humidity',
        axis: 'humidity',
        color: '#91bfdb',
        label: 'Humidity',
        legend: 'Humidity (%)',
        fields: ['humidity', 'relative_humidity', 'relativeHumidity'],
        valueFormatter: value => `${value.toFixed(1)}%`,
      },
    ],
  },
  {
    id: 'airQuality',
    title: 'Air quality',
    typeFilter: ['environment', 'air_quality'],
    axes: [
      {
        id: 'pressure',
        position: 'left',
        label: 'Pressure (hPa)',
        min: 800,
        max: 1_100,
        ticks: 4,
        color: '#c51b8a',
      },
      {
        id: 'gas',
        position: 'right',
        label: 'Gas resistance (Ω)',
        min: 10,
        max: 100_000,
        ticks: 5,
        color: '#fa9fb5',
        scale: 'log',
      },
      {
        id: 'iaq',
        position: 'rightSecondary',
        label: 'IAQ index',
        min: 0,
        max: 500,
        ticks: 5,
        color: '#636363',
        allowUpperOverflow: true,
      },
    ],
    series: [
      {
        id: 'pressure',
        axis: 'pressure',
        color: '#c51b8a',
        label: 'Pressure',
        legend: 'Pressure (hPa)',
        fields: ['pressure', 'barometric_pressure', 'barometricPressure'],
        valueFormatter: value => `${value.toFixed(1)} hPa`,
      },
      {
        id: 'gas',
        axis: 'gas',
        color: '#fa9fb5',
        label: 'Gas resistance',
        legend: 'Gas resistance (Ω)',
        fields: ['gas_resistance', 'gasResistance'],
        valueFormatter: value => formatGasResistance(value),
      },
      {
        id: 'iaq',
        axis: 'iaq',
        color: '#636363',
        label: 'IAQ',
        legend: 'IAQ index',
        fields: ['iaq'],
        valueFormatter: value => value.toFixed(0),
      },
    ],
  },
]);
