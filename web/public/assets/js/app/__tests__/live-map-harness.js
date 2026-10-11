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
 * Harness for the #881 map and refresh tests (SPEC DR2/DR4).
 *
 * Boots `initializeApp` over a fake `EventSource` and a stub `fetch` with the
 * three surfaces a refresh can repaint: a `#nodes tbody` that counts its
 * rebuilds, a `#chat` container, and a Leaflet stub whose markers, pins and
 * lines own element stand-ins that leave the document when their layer group
 * is cleared — the browser behaviour that closes an overlay anchored to them.
 * The overlay template yields tracked overlay elements, so a test sees which
 * short-info overlays are open and can press their close buttons.
 *
 * Kept beside the two suites that use it instead of widening the shared
 * `main-app-leaflet-stub.js` / `sse-app-harness.js` helpers, which it wraps.
 *
 * @module __tests__/live-map-harness
 */

import { createDomEnvironment } from './dom-environment.js';
import { makeLeafletStub } from './main-app-leaflet-stub.js';
import { SSE_BASE_CONFIG, makeFakeEventSource } from './sse-app-harness.js';
import { initializeApp } from '../main.js';

/** Unix seconds at module load; fixtures are stamped relative to it. */
export const NOW = Math.floor(Date.now() / 1000);

/**
 * Resolve after ``ms`` milliseconds, letting overlay positioning timers and
 * coalesced repaints run.
 *
 * @param {number} [ms=40] Delay.
 * @returns {Promise<void>}
 */
export function settle(ms = 40) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Give a Leaflet stub layer an element stand-in that counts as in the
 * document while the layer sits in a layer group (cleared groups detach it).
 *
 * @param {Object} layer Stub marker or polyline.
 * @returns {Object} The same layer.
 */
function attachElement(layer) {
  const element = {
    layer,
    getBoundingClientRect: () => ({ left: 10, top: 10, width: 8, height: 8 }),
    __connected: () => Boolean(layer._addedTo && layer._addedTo._layers.includes(layer)),
  };
  layer.getElement = () => element;
  // Leaflet 1.9's tooltip surface on a layer with no tooltip bound:
  // getTooltip() is undefined, openTooltip() is a no-op, and isTooltipOpen()
  // dereferences the missing tooltip and throws.
  layer.getTooltip = () => undefined;
  layer.openTooltip = () => layer;
  layer.isTooltipOpen = () => {
    throw new TypeError("Cannot read properties of undefined (reading 'isOpen')");
  };
  return layer;
}

/**
 * Give a stub polyline Leaflet's event and tooltip surface.
 *
 * The bound tooltip keeps its ``content``. As in Leaflet 1.9.4, every
 * ``openTooltip()`` fills it, an open one too (``_prepareOpen`` ends in
 * ``update()``): a content function, which the map binds (SPEC MT1), is
 * called with the layer, and a string is shown as given. ``html`` holds what
 * the tooltip shows (``null`` until it first opens) and ``builds`` counts the
 * content function's calls.
 *
 * @param {Object} line Stub polyline.
 * @returns {Object} The same line.
 */
function addLineSurface(line) {
  const handlers = new Map();
  let tooltip = null;
  line._eventHandlers = handlers;
  line.on = (event, handler) => {
    if (!handlers.has(event)) handlers.set(event, []);
    handlers.get(event).push(handler);
    return line;
  };
  line.bindTooltip = (content, options) => {
    tooltip = { content, options, open: false, latLng: null, html: null, builds: 0 };
    tooltip.getLatLng = () => tooltip.latLng;
    return line;
  };
  line.getTooltip = () => tooltip || undefined;
  // As in Leaflet, asking a line with no bound tooltip throws.
  line.isTooltipOpen = () => tooltip.open;
  line.openTooltip = latLng => {
    if (!tooltip) return line;
    if (typeof tooltip.content === 'function') {
      tooltip.builds += 1;
      tooltip.html = tooltip.content(line);
    } else {
      tooltip.html = tooltip.content;
    }
    tooltip.open = true;
    tooltip.latLng = latLng || { lat: 0, lng: 0, centre: true };
    return line;
  };
  line.closeTooltip = () => {
    tooltip.open = false;
    return line;
  };
  return line;
}

/**
 * Build a Leaflet stub whose layers carry elements and line tooltips.
 *
 * @returns {Object} Leaflet stub (``_recorded`` lists every created layer).
 */
function makeLiveLeaflet() {
  const leaflet = makeLeafletStub();
  const basePolyline = leaflet.polyline;
  const baseCircle = leaflet.circleMarker;
  const baseMarker = leaflet.marker;
  leaflet.polyline = (latLngs, options) => addLineSurface(attachElement(basePolyline(latLngs, options)));
  leaflet.circleMarker = (latLng, options) => attachElement(baseCircle(latLng, options));
  leaflet.marker = (latLng, options) => attachElement(baseMarker(latLng, options));
  return leaflet;
}

/**
 * Replace the overlay template with a factory of tracked overlay elements.
 *
 * @param {Object} env DOM environment from {@link createDomEnvironment}.
 * @returns {Array<Object>} Every overlay element created, in order.
 */
function installOverlayTemplate(env) {
  const body = env.document.body;
  const created = [];
  /**
   * One overlay element with a close button and a content node.
   *
   * @returns {Object} Overlay element stand-in.
   */
  function makeOverlay() {
    const closeButton = {
      listeners: [],
      addEventListener(type, handler) {
        if (type === 'click') closeButton.listeners.push(handler);
      },
    };
    const content = { innerHTML: '' };
    const overlay = {
      style: {},
      removed: false,
      parentNode: null,
      attributes: new Map(),
      closeButton,
      content,
      querySelector: selector => {
        if (selector === '.short-info-close') return closeButton;
        if (selector === '.short-info-content') return content;
        return null;
      },
      setAttribute(name, value) {
        overlay.attributes.set(name, String(value));
      },
      removeAttribute(name) {
        overlay.attributes.delete(name);
      },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 120, height: 60 }),
      contains: node => node === overlay || node === closeButton || node === content,
      remove() {
        overlay.removed = true;
        overlay.parentNode = null;
        const index = body.childNodes.indexOf(overlay);
        if (index >= 0) body.childNodes.splice(index, 1);
      },
    };
    created.push(overlay);
    return overlay;
  }
  env.registerElement('shortInfoOverlayTemplate', {
    content: { firstElementChild: { cloneNode: () => makeOverlay() } },
  });
  // Appending sets parentNode, as the DOM does, so the stack attaches once.
  const baseAppend = body.appendChild.bind(body);
  body.appendChild = node => {
    if (node && typeof node === 'object') node.parentNode = body;
    return baseAppend(node);
  };
  // A layer's element is in the document while its layer is on the map.
  body.contains = node => {
    if (!node) return false;
    if (typeof node.__connected === 'function') return node.__connected();
    return body.childNodes.includes(node);
  };
  return created;
}

/**
 * A stub ``fetch`` that answers from a URL-substring map and, like the
 * network, hands out a fresh parse of the body on every request: the shared
 * stub returns the body object itself, so a test editing a response would
 * edit the dashboard's merged state behind its back.
 *
 * @param {Object<string, *>} responses URL substring to JSON body, read at
 *   request time.
 * @param {?Function} fetchOverride Hook answering first when it returns a
 *   promise.
 * @returns {{ fetch: Function, calls: Array<{ url: string }> }} The stub and
 *   its request log.
 */
function buildCloningFetch(responses, fetchOverride) {
  const calls = [];
  /** @param {*} body JSON body. @returns {Promise<Object>} A 200 response parsing a fresh copy. */
  const respond = body => Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(JSON.parse(JSON.stringify(body))),
  });
  return {
    calls,
    fetch(url) {
      calls.push({ url });
      const answer = typeof fetchOverride === 'function' ? fetchOverride(url) : undefined;
      if (answer !== undefined) return answer;
      for (const [prefix, body] of Object.entries(responses)) {
        if (url.includes(prefix)) return respond(body);
      }
      return respond([]);
    },
  };
}

/**
 * The lines with ``className`` that the newest render drew, in drawing order:
 * a cleared layer group no longer lists the lines of earlier renders.
 *
 * @param {Object} leaflet Leaflet stub of {@link runMapApp}.
 * @param {string} className Exact class list of the line.
 * @returns {Array<Object>} Stub polylines.
 */
export function drawnLines(leaflet, className) {
  return leaflet._recorded.polylines.filter(
    line => line.options.className === className && line._addedTo && line._addedTo._layers.includes(line),
  );
}

/**
 * Invoke a stub Leaflet layer's ``click`` handlers with a Leaflet-shaped event.
 *
 * @param {Object} layer Marker or polyline from the stub.
 * @returns {number} How many handlers ran.
 */
export function clickLayer(layer) {
  const handlers = (layer._eventHandlers && layer._eventHandlers.get('click')) || [];
  const event = { originalEvent: { preventDefault() {}, stopPropagation() {}, target: null } };
  for (const handler of handlers) handler(event);
  return handlers.length;
}

/**
 * Boot the dashboard with a map, a nodes table and a chat, run ``fn``, then
 * tear everything down.
 *
 * @param {{
 *   responses: Object<string, *>,
 *   fetchOverride?: (url: string) => (Promise<Object>|undefined),
 *   configOverrides?: Object,
 *   beforeBoot?: (env: Object) => void,
 * }} options Stub-fetch payloads (URL substring to JSON body, read at request
 *   time so a test can edit them between refreshes), an optional fetch hook
 *   that answers first, config overrides, and a hook that registers extra
 *   elements before the app boots.
 * @param {(ctx: Object) => Promise<void>} fn Test body; receives ``testUtils``,
 *   ``leaflet``, ``tbody``, ``chat``, ``calls``, ``stream``, ``overlays()``
 *   (open overlay elements), ``tableRepaints()`` and ``ping(...collections)``.
 * @returns {Promise<void>}
 */
export async function runMapApp({ responses, fetchOverride, configOverrides = {}, beforeBoot }, fn) {
  const env = createDomEnvironment({ includeBody: true });
  env.window.matchMedia = () => ({ matches: false, media: '', addEventListener() {}, removeEventListener() {} });
  if (typeof beforeBoot === 'function') beforeBoot(env);
  const overlaysCreated = installOverlayTemplate(env);
  env.registerElement('map', env.createElement('div', 'map'));
  const chat = env.createElement('div', 'chat');
  env.registerElement('chat', chat);
  const tbody = env.document.createElement('tbody');
  let tableRepaints = 0;
  const baseReplace = tbody.replaceChildren.bind(tbody);
  tbody.replaceChildren = (...nodes) => {
    tableRepaints += 1;
    return baseReplace(...nodes);
  };
  const table = env.document.createElement('table');
  table.querySelector = selector => (selector === 'tbody' ? tbody : null);
  table.querySelectorAll = () => [];
  env.registerElement('nodes', table);
  env.document.querySelector = selector => (selector === '#nodes tbody' ? tbody : null);

  const leaflet = makeLiveLeaflet();
  const saved = {
    fetch: globalThis.fetch,
    EventSource: globalThis.EventSource,
    indexedDB: globalThis.indexedDB,
    L: globalThis.L,
  };
  const stub = buildCloningFetch(responses, fetchOverride);
  globalThis.fetch = stub.fetch;
  globalThis.indexedDB = undefined;
  const FakeEventSource = makeFakeEventSource();
  globalThis.EventSource = FakeEventSource;
  env.window.L = leaflet;
  globalThis.L = leaflet;
  let testUtils = null;
  try {
    ({ _testUtils: testUtils } = initializeApp({ ...SSE_BASE_CONFIG, ...configOverrides }));
    await testUtils.initialLoad;
    await testUtils.flushBackfill();
    await settle();
    const stream = FakeEventSource.instances[0];
    await fn({
      env,
      testUtils,
      leaflet,
      tbody,
      chat,
      stream,
      calls: stub.calls,
      overlays: () => overlaysCreated.filter(overlay => !overlay.removed),
      tableRepaints: () => tableRepaints,
      /**
       * Deliver SSE change pings and wait for their refresh and timers.
       *
       * @param {...string} collections Changed collection names.
       * @returns {Promise<void>}
       */
      async ping(...collections) {
        for (const collection of collections) {
          stream.dispatch('change', { data: JSON.stringify({ collection }) });
        }
        await testUtils.flushLiveRefresh();
        await settle();
      },
    });
  } finally {
    if (testUtils) {
      // Let fire-and-forget tails (the stats callback, the cache write) run
      // against the live DOM before it is torn down.
      await testUtils.flushCacheWrites();
      await settle(20);
      testUtils.stopAutoRefresh();
    }
    globalThis.fetch = saved.fetch;
    if (saved.EventSource === undefined) delete globalThis.EventSource;
    else globalThis.EventSource = saved.EventSource;
    globalThis.indexedDB = saved.indexedDB;
    if (saved.L === undefined) delete globalThis.L;
    else globalThis.L = saved.L;
    env.cleanup();
  }
}
