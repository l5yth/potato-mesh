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

import { createDomEnvironment } from './dom-environment.js';
import { initializeFederationPage } from '../federation-page.js';
import { roleColors } from '../role-helpers.js';

test('federation map centers on configured coordinates and follows theme filters', async () => {
  const env = createDomEnvironment({ includeBody: true, bodyHasDarkClass: true });
  const { document, window, createElement, registerElement, cleanup } = env;

  const mapEl = createElement('div', 'map');
  registerElement('map', mapEl);
  const statusEl = createElement('div', 'status');
  registerElement('status', statusEl);
  const tableEl = createElement('table', 'instances');
  const tbodyEl = createElement('tbody');
  registerElement('instances', tableEl);

  const configPayload = {
    mapCenter: { lat: 10, lon: 20 },
    mapZoom: 7,
    tileFilters: { light: 'brightness(1)', dark: 'invert(1)' }
  };
  const configEl = createElement('div');
  configEl.setAttribute('data-app-config', JSON.stringify(configPayload));

  document.querySelector = selector => {
    if (selector === '[data-app-config]') return configEl;
    if (selector === '#instances tbody') return tbodyEl;
    return null;
  };

  const tileContainer = createElement('div');
  const tilePane = createElement('div');
  const tileImage = createElement('img');
  tileImage.classList.add('leaflet-tile');
  tileContainer.appendChild(tileImage);
  tilePane.appendChild(tileImage);
  const mapSetViewCalls = [];
  const mapFitBoundsCalls = [];
  const circleMarkerCalls = [];
  const tileLayerStub = {
    addTo() {
      return this;
    },
    getContainer() {
      return tileContainer;
    },
    on(event, handler) {
      if (event === 'load') {
        this._onLoad = handler;
      }
    }
  };
  const mapStub = {
    setView(...args) {
      mapSetViewCalls.push(args);
    },
    on() {},
    getPane(name) {
      return name === 'tilePane' ? tilePane : null;
    },
    fitBounds(...args) {
      mapFitBoundsCalls.push(args);
    }
  };
  const leafletStub = {
    map() {
      return mapStub;
    },
    tileLayer() {
      return tileLayerStub;
    },
    layerGroup() {
      return {
        addLayer() {},
        addTo() {
          return this;
        }
      };
    },
    circleMarker(latlng, options) {
      circleMarkerCalls.push({ latlng, options });
      return {
        bindPopup() {
          return this;
        }
      };
    }
  };

const fetchImpl = async () => ({
  ok: true,
  json: async () => [
    {
      domain: 'alpha.mesh',
      contactLink: 'https://chat.alpha',
      version: '1.0.0',
      latitude: 10.12345,
      longitude: -20.98765,
      lastUpdateTime: Math.floor(Date.now() / 1000) - 90,
      nodesCount: 12
    },
    {
      domain: 'bravo.mesh',
      contactLink: null,
      version: '2.0.0',
      lastUpdateTime: Math.floor(Date.now() / 1000) - (2 * 86400),
      nodesCount: 2
    }
  ]
});

  try {
    await initializeFederationPage({ config: configPayload, fetchImpl, leaflet: leafletStub });

    assert.deepEqual(mapSetViewCalls[0], [[10, 20], 7]);
    assert.equal(tileContainer.style.filter, 'invert(1)');
    assert.equal(tilePane.style.filter, 'invert(1)');
    assert.equal(tileImage.style.filter, 'invert(1)');

    document.body.classList.remove('dark');
    document.documentElement.setAttribute('data-theme', 'light');
    window.dispatchEvent({ type: 'themechange', detail: { theme: 'light' } });
    assert.equal(tileContainer.style.filter, 'brightness(1)');
    assert.equal(tilePane.style.filter, 'brightness(1)');
    assert.equal(tileImage.style.filter, 'brightness(1)');

    document.documentElement.removeAttribute('data-theme');
    document.body.classList.remove('dark');
    window.dispatchEvent({ type: 'themechange', detail: { theme: null } });
    assert.equal(tileContainer.style.filter, 'invert(1)');

    const rows = tbodyEl.childNodes;
    assert.equal(rows.length, 2);
    const firstRowHtml = rows[0].innerHTML;
    assert.match(firstRowHtml, /alpha\.mesh/);
    assert.match(firstRowHtml, /https:\/\/chat\.alpha/);
    assert.match(firstRowHtml, /10\.12345/);
    assert.match(firstRowHtml, /-20\.98765/);
    assert.match(firstRowHtml, />12</);
    assert.match(firstRowHtml, /ago/);

    const secondRowHtml = rows[1].innerHTML;
    assert.match(secondRowHtml, /bravo\.mesh/);
    assert.match(secondRowHtml, /<em>—<\/em>/); // no contact link
    assert.match(secondRowHtml, /2\.0\.0/);
    assert.match(secondRowHtml, />2</);
    assert.match(secondRowHtml, /d ago/);
    assert.deepEqual(mapFitBoundsCalls[0][0], [[10.12345, -20.98765]]);
    assert.equal(circleMarkerCalls[0].options.fillColor, roleColors.CLIENT_HIDDEN);
  } finally {
    cleanup();
  }
});

test('federation page tolerates fetch failures', async () => {
  const env = createDomEnvironment({ includeBody: true, bodyHasDarkClass: false });
  const { document, createElement, registerElement, cleanup } = env;

  const mapEl = createElement('div', 'map');
  registerElement('map', mapEl);
  const statusEl = createElement('div', 'status');
  registerElement('status', statusEl);
  const tableEl = createElement('table', 'instances');
  const tbodyEl = createElement('tbody');
  registerElement('instances', tableEl);
  const configEl = createElement('div');
  configEl.setAttribute('data-app-config', JSON.stringify({}));
  document.querySelector = selector => {
    if (selector === '[data-app-config]') return configEl;
    if (selector === '#instances tbody') return tbodyEl;
    return null;
  };

  const leafletStub = {
    map() {
      return {
        setView() {},
        on() {},
        getPane() {
          return null;
        }
      };
    },
    tileLayer() {
      return {
        addTo() {
          return this;
        },
        getContainer() {
          return null;
        },
        on() {}
      };
    },
    layerGroup() {
      return { addLayer() {}, addTo() { return this; } };
    },
    circleMarker() {
      return { bindPopup() { return this; } };
    }
  };

  const fetchImpl = async () => {
    throw new Error('boom');
  };

  await initializeFederationPage({ config: {}, fetchImpl, leaflet: leafletStub });
  cleanup();
});
