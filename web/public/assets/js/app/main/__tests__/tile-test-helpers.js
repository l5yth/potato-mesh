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
 * Shared test doubles for the basemap tile layers.
 *
 * Deduplicates the fake ``<img>`` tile, the minimal Leaflet ``TileLayer`` stub,
 * and the ``document`` stub used by both ``fallback-tile-layer.test.js`` and
 * ``basemap-config.test.js`` (this file is not itself a test — it carries no
 * ``.test.js`` suffix, so ``node --test`` ignores it).
 *
 * @module main/__tests__/tile-test-helpers
 */

/**
 * Build a fake tile element satisfying the small DOM contract the fallback tile
 * layer touches: ``classList``, ``addEventListener`` / ``removeEventListener``,
 * ``setAttribute``, and the ``src`` / ``alt`` / ``crossOrigin`` properties. The
 * extra ``dispatch`` and ``listenerCount`` helpers let a test simulate ``load`` /
 * ``error`` events and assert listener bookkeeping.
 *
 * @param {{withClassList?: boolean}} [options] When ``withClassList`` is ``false``
 *   the tile omits ``classList`` (exercises the no-classList guard).
 * @returns {Object} A fake tile element.
 */
export function makeFakeTile({ withClassList = true } = {}) {
  const listeners = new Map();
  const tile = {
    tag: 'img',
    src: '',
    alt: undefined,
    crossOrigin: undefined,
    _attrs: {},
    setAttribute(name, value) {
      this._attrs[name] = value;
    },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    removeEventListener(type, handler) {
      if (listeners.has(type)) {
        listeners.set(
          type,
          listeners.get(type).filter((registered) => registered !== handler)
        );
      }
    },
    dispatch(type, event) {
      (listeners.get(type) || []).slice().forEach((handler) => handler(event));
    },
    listenerCount(type) {
      return (listeners.get(type) || []).length;
    },
  };
  if (withClassList) {
    const classes = new Set();
    tile.classList = {
      add(name) {
        classes.add(name);
      },
      remove(name) {
        classes.delete(name);
      },
      contains(name) {
        return classes.has(name);
      },
    };
  }
  return tile;
}

/**
 * Build a minimal Leaflet stub exposing ``TileLayer`` with the ``extend`` and
 * ``getTileUrl`` behaviour ``createFallbackTileLayer`` relies on.
 *
 * ``getTileUrl`` mirrors Leaflet's subdomain rotation (``(x + y) % length``) and
 * template substitution closely enough for URL assertions.
 *
 * @returns {{TileLayer: Function}} The Leaflet-compatible stub.
 */
export function makeLeafletTileLayerStub() {
  /**
   * @param {string} url Tile URL template.
   * @param {Object} options Layer options.
   */
  function TileLayer(url, options) {
    this._url = url;
    this.options = options || {};
  }
  /**
   * @param {{x: number, y: number, z: number}} coords Tile coordinate.
   * @returns {string} The substituted tile URL.
   */
  TileLayer.prototype.getTileUrl = function getTileUrl(coords) {
    const subdomains = this.options.subdomains || 'abc';
    const index = Math.abs((coords.x || 0) + (coords.y || 0)) % subdomains.length;
    return this._url
      .replace('{s}', subdomains.charAt(index))
      .replace('{r}', '')
      .replace('{z}', String(coords.z))
      .replace('{x}', String(coords.x))
      .replace('{y}', String(coords.y));
  };
  /**
   * @param {Object} proto Prototype members to mix into the subclass.
   * @returns {Function} The subclass constructor.
   */
  TileLayer.extend = function extend(proto) {
    /**
     * @param {string} url Tile URL template.
     * @param {Object} options Layer options.
     */
    function Sub(url, options) {
      TileLayer.call(this, url, options);
    }
    Sub.prototype = Object.create(TileLayer.prototype);
    Sub.prototype.constructor = Sub;
    Object.assign(Sub.prototype, proto);
    return Sub;
  };
  return { TileLayer };
}

/**
 * Install a ``document`` stub whose ``createElement`` returns fake tiles.
 *
 * @param {{tileFactory?: function(): Object}} [options] Optional custom tile factory
 *   (defaults to {@link makeFakeTile}); use it to produce tiles without ``classList``.
 * @returns {{created: Object[], restore: function(): void}} The captured tiles and a teardown handle.
 */
export function withImgDocument({ tileFactory } = {}) {
  const previousDocument = globalThis.document;
  const created = [];
  globalThis.document = {
    createElement(tag) {
      const element = tileFactory ? tileFactory() : makeFakeTile();
      element.tag = tag;
      created.push(element);
      return element;
    },
  };
  return {
    created,
    restore() {
      if (previousDocument === undefined) {
        delete globalThis.document;
      } else {
        globalThis.document = previousDocument;
      }
    },
  };
}
