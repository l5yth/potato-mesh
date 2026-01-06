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
  const mapPanel = createElement('div', 'mapPanel');
  mapPanel.dataset.legendCollapsed = 'true';
  registerElement('mapPanel', mapPanel);
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
  } catch (error) {
    console.error('federation sorting test error', error);
    throw error;
  } finally {
    cleanup();
  }
});

test('federation table sorting, contact rendering, and legend creation', async () => {
  const env = createDomEnvironment({ includeBody: true, bodyHasDarkClass: false });
  const { document, createElement, registerElement, cleanup } = env;

  const mapEl = createElement('div', 'map');
  registerElement('map', mapEl);
  const statusEl = createElement('div', 'status');
  registerElement('status', statusEl);

  const tableEl = createElement('table', 'instances');
  const tbodyEl = createElement('tbody');
  registerElement('instances', tableEl);
  tableEl.appendChild(tbodyEl);

  const headerNameTh = createElement('th');
  const headerName = createElement('span');
  headerName.classList.add('sort-header');
  headerName.dataset.sortKey = 'name';
  headerName.dataset.sortLabel = 'Name';
  headerNameTh.appendChild(headerName);

  const headerDomainTh = createElement('th');
  const headerDomain = createElement('span');
  headerDomain.classList.add('sort-header');
  headerDomain.dataset.sortKey = 'domain';
  headerDomain.dataset.sortLabel = 'Domain';
  headerDomainTh.appendChild(headerDomain);

  const ths = [headerNameTh, headerDomainTh];
  const headers = [headerName, headerDomain];
  const headerHandlers = new Map();
  headers.forEach(header => {
    header.addEventListener = (event, handler) => {
      const existing = headerHandlers.get(header) || {};
      existing[event] = handler;
      headerHandlers.set(header, existing);
    };
    header.closest = () => ths.find(th => th.childNodes.includes(header));
    header.querySelector = selector => {
      if (selector === '.sort-indicator') {
        const span = createElement('span');
        span.classList.add('sort-indicator');
        return span;
      }
      return null;
    };
  });

  tableEl.querySelectorAll = selector => {
    if (selector === 'thead .sort-header[data-sort-key]') return headers;
    if (selector === 'thead th') return ths;
    return [];
  };

  const configPayload = {
    mapCenter: { lat: 0, lon: 0 },
    mapZoom: 3,
    tileFilters: { light: 'none', dark: 'invert(1)' }
  };
  const configEl = createElement('div');
  configEl.setAttribute('data-app-config', JSON.stringify(configPayload));

  document.querySelector = selector => {
    if (selector === '[data-app-config]') return configEl;
    if (selector === '#instances tbody') return tbodyEl;
    return null;
  };

  const legendContainers = [];
  const mapSetViewCalls = [];
  const mapFitBoundsCalls = [];
  const circleMarkerCalls = [];

  const DomUtil = {
    create(tag, className, parent) {
      const el = {
        tagName: tag,
        className,
        children: [],
        style: {},
        textContent: '',
        setAttribute() {},
        appendChild(child) {
          this.children.push(child);
          return child;
        },
      };
      if (parent && parent.appendChild) parent.appendChild(el);
      return el;
    }
  };

  const controlStub = () => {
    const ctrl = {
      onAdd: null,
      container: null,
      addTo(map) {
        this.container = this.onAdd ? this.onAdd(map) : null;
        legendContainers.push(this.container);
        return this;
      },
      getContainer() {
        return this.container;
      }
    };
    return ctrl;
  };

  const markersLayer = {
    layers: [],
    addLayer(marker) {
      this.layers.push(marker);
      return marker;
    },
    addTo() {
      return this;
    }
  };

  const mapStub = {
    addedControls: [],
    setView(...args) {
      mapSetViewCalls.push(args);
    },
    on() {},
    fitBounds(...args) {
      mapFitBoundsCalls.push(args);
    },
    addLayer(layer) {
      this.addedControls.push(layer);
      return layer;
    }
  };

  const leafletStub = {
    map() {
      return mapStub;
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
      return markersLayer;
    },
    circleMarker(latlng, options) {
      circleMarkerCalls.push({ latlng, options });
      return {
        bindPopup() {
          return this;
        },
        addTo() {
          return this;
        }
      };
    },
    control: controlStub,
    DomUtil
  };

  const now = Math.floor(Date.now() / 1000);
  const fetchImpl = async () => ({
    ok: true,
    json: async () => [
      {
        domain: 'c.mesh',
        name: 'Charlie',
        contactLink: 'https://charlie.example\nmatrix:#c:mesh',
        version: '3.0.0',
        latitude: 1,
        longitude: 1,
        lastUpdateTime: now - 10,
        nodesCount: 0
      },
      {
        domain: 'b.mesh',
        contactLink: '',
        version: '2.0.0',
        latitude: 2,
        longitude: 2,
        lastUpdateTime: now - 60,
        nodesCount: 650
      },
      {
        domain: 'a.mesh',
        name: 'Alpha',
        contactLink: 'mailto:alpha@mesh',
        version: '1.0.0',
        latitude: 3,
        longitude: 3,
        lastUpdateTime: now - 30,
        nodesCount: 5
      }
    ]
  });

  try {
    await initializeFederationPage({ config: configPayload, fetchImpl, leaflet: leafletStub });

    const rows = tbodyEl.childNodes.map(node => String(node.childNodes[0]));
    assert.match(rows[0], /c\.mesh/);
    assert.match(rows[0], /0</);
    assert.match(rows[0], /https:\/\/charlie\.example/);
    assert.match(rows[0], /matrix:#c:mesh/);
    assert.match(rows[1], /a\.mesh/);
    assert.match(rows[2], /b\.mesh/);

    const nameHandlers = headerHandlers.get(headerName);
    nameHandlers.click();
    const afterNameSort = tbodyEl.childNodes.map(node => String(node.childNodes[0]));
    assert.match(afterNameSort[0], /a\.mesh/);
    assert.match(afterNameSort[1], /c\.mesh/);
    assert.match(afterNameSort[2], /b\.mesh/);

    nameHandlers.click();
    const descSort = tbodyEl.childNodes.map(node => String(node.childNodes[0]));
    assert.match(descSort[0], /c\.mesh/);
    assert.match(descSort[1], /a\.mesh/);
    assert.match(descSort[2], /b\.mesh/);
    assert.equal(headerName.closest().attributes.get('aria-sort'), 'descending');

    assert.equal(circleMarkerCalls[0].options.fillColor, roleColors.CLIENT_HIDDEN);
    assert.equal(circleMarkerCalls[1].options.fillColor, roleColors.REPEATER);

    assert.deepEqual(mapSetViewCalls[0], [[0, 0], 3]);
    assert.equal(mapFitBoundsCalls[0][0].length, 3);

    assert.equal(legendContainers.length, 2);
    const legend = legendContainers.find(container => container.className.includes('legend--instances'));
    assert.ok(legend);
    assert.ok(legend.className.includes('legend-hidden'));
    const legendHeader = legend.children.find(child => child.className === 'legend-header');
    const legendTitle = legendHeader && Array.isArray(legendHeader.children)
      ? legendHeader.children.find(child => child.className === 'legend-title')
      : null;
    assert.ok(legendTitle);
    assert.equal(legendTitle.textContent, 'Active nodes');
    const legendToggle = legendContainers.find(container => container.className.includes('legend-toggle'));
    assert.ok(legendToggle);
  } finally {
    cleanup();
  }
});

test('federation legend toggle respects media query changes', async () => {
  const env = createDomEnvironment({ includeBody: true, bodyHasDarkClass: false });
  const { document, createElement, registerElement, cleanup } = env;

  const mapEl = createElement('div', 'map');
  registerElement('map', mapEl);
  const mapPanel = createElement('div', 'mapPanel');
  mapPanel.setAttribute('data-legend-collapsed', 'false');
  registerElement('mapPanel', mapPanel);
  const statusEl = createElement('div', 'status');
  registerElement('status', statusEl);

  const tableEl = createElement('table', 'instances');
  const tbodyEl = createElement('tbody');
  registerElement('instances', tableEl);
  tableEl.appendChild(tbodyEl);

  const configPayload = {
    mapCenter: { lat: 0, lon: 0 },
    mapZoom: 3,
    tileFilters: { light: 'none', dark: 'invert(1)' }
  };
  const configEl = createElement('div');
  configEl.setAttribute('data-app-config', JSON.stringify(configPayload));

  document.querySelector = selector => {
    if (selector === '[data-app-config]') return configEl;
    if (selector === '#instances tbody') return tbodyEl;
    return null;
  };

  let mediaQueryHandler = null;
  window.matchMedia = () => ({
    matches: false,
    addListener(handler) {
      mediaQueryHandler = handler;
    }
  });

  const legendContainers = [];
  const legendButtons = [];

  const DomUtil = {
    create(tag, className, parent) {
      const classSet = new Set(className ? className.split(/\s+/).filter(Boolean) : []);
      const el = {
        tagName: tag,
        className,
        classList: {
          toggle(name, force) {
            const shouldAdd = typeof force === 'boolean' ? force : !classSet.has(name);
            if (shouldAdd) {
              classSet.add(name);
            } else {
              classSet.delete(name);
            }
            el.className = Array.from(classSet).join(' ');
          }
        },
        children: [],
        style: {},
        textContent: '',
        attributes: new Map(),
        setAttribute(name, value) {
          this.attributes.set(name, String(value));
        },
        appendChild(child) {
          this.children.push(child);
          return child;
        },
        addEventListener(event, handler) {
          if (event === 'click') {
            this._clickHandler = handler;
          }
        },
        querySelector() {
          return null;
        }
      };
      if (parent && parent.appendChild) parent.appendChild(el);
      if (className && className.includes('legend-toggle-button')) {
        legendButtons.push(el);
      }
      return el;
    }
  };

  const controlStub = () => {
    const ctrl = {
      onAdd: null,
      container: null,
      addTo(map) {
        this.container = this.onAdd ? this.onAdd(map) : null;
        legendContainers.push(this.container);
        return this;
      },
      getContainer() {
        return this.container;
      }
    };
    return ctrl;
  };

  const markersLayer = {
    addLayer() {
      return null;
    },
    addTo() {
      return this;
    }
  };

  const leafletStub = {
    map() {
      return {
        setView() {},
        on() {},
        fitBounds() {}
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
      return markersLayer;
    },
    circleMarker() {
      return {
        bindPopup() {
          return this;
        }
      };
    },
    control: controlStub,
    DomUtil,
    DomEvent: {
      disableClickPropagation() {},
      disableScrollPropagation() {}
    }
  };

  const fetchImpl = async () => ({
    ok: true,
    json: async () => []
  });

  try {
    await initializeFederationPage({ config: configPayload, fetchImpl, leaflet: leafletStub });

    const legend = legendContainers.find(container => container.className.includes('legend--instances'));
    assert.ok(legend);
    assert.ok(!legend.className.includes('legend-hidden'));

    assert.equal(legendButtons.length, 1);
    legendButtons[0]._clickHandler?.({ preventDefault() {}, stopPropagation() {} });
    assert.ok(legend.className.includes('legend-hidden'));

    if (mediaQueryHandler) {
      mediaQueryHandler({ matches: false });
      assert.ok(!legend.className.includes('legend-hidden'));
    }
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
