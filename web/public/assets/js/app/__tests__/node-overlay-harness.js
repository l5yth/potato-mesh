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
 * Shared node-detail overlay harness for the ``initializeApp`` suites that
 * open the overlay from a ``.node-long-link`` click.
 *
 * @module app/__tests__/node-overlay-harness
 */

/**
 * Register a minimal but functional ``#nodeDetailOverlay`` so the lazily
 * imported factory returns a real manager (mirrors node-detail-overlay.test.js).
 *
 * @param {{ registerElement: Function }} env DOM environment from
 *   ``createDomEnvironment``.
 * @returns {{ overlay: Object, content: { innerHTML: string } }} The overlay
 *   root and the content element the manager writes the rendered node into.
 */
export function registerNodeDetailOverlay(env) {
  const noop = () => {};
  const dialog = { focus: noop, addEventListener: noop, setAttribute: noop, removeAttribute: noop };
  const closeButton = { addEventListener: noop };
  const content = { innerHTML: '', addEventListener: noop, replaceChildren: noop };
  const overlay = {
    hidden: true,
    style: { removeProperty: noop },
    addEventListener: noop,
    setAttribute: noop,
    removeAttribute: noop,
    querySelector(selector) {
      if (selector === '.node-detail-overlay__dialog') return dialog;
      if (selector === '.node-detail-overlay__close') return closeButton;
      if (selector === '.node-detail-overlay__content') return content;
      return null;
    },
  };
  env.registerElement('nodeDetailOverlay', overlay);
  return { overlay, content };
}

/**
 * Dispatch the click a ``.node-long-link`` for ``nodeId`` receives, the way
 * the dashboard's delegated document listener sees it.
 *
 * @param {string} nodeId Canonical node id the link names.
 * @param {string} [label] Link text, used for the overlay's loading status.
 * @returns {void}
 */
export function clickNodeLongLink(nodeId, label = nodeId) {
  const link = {
    dataset: { nodeId },
    textContent: label,
    closest(selector) {
      return selector === '.node-long-link' ? this : null;
    },
  };
  globalThis.document.dispatchEvent({
    type: 'click',
    target: link,
    preventDefault() {},
    stopPropagation() {},
  });
}
