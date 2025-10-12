/*
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
 * Minimal document implementation that exposes the subset of behaviour needed
 * by the front-end modules during unit tests.
 */
class DocumentStub {
  /**
   * Instantiate a new stub with a clean internal state.
   */
  constructor() {
    this.reset();
  }

  /**
   * Clear tracked configuration elements and registered event listeners.
   *
   * @returns {void}
   */
  reset() {
    this.configElement = null;
    this.listeners = new Map();
  }

  /**
   * Provide an element that will be returned by ``querySelector`` when the
   * configuration selector is requested.
   *
   * @param {?Element} element DOM node exposing ``getAttribute``.
   * @returns {void}
   */
  setConfigElement(element) {
    this.configElement = element;
  }

  /**
   * Return the registered configuration element when the matching selector is
   * provided.
   *
   * @param {string} selector CSS selector requested by the module under test.
   * @returns {?Element} Config element or ``null`` when unavailable.
   */
  querySelector(selector) {
    if (selector === '[data-app-config]') {
      return this.configElement;
    }
    return null;
  }

  /**
   * Register an event handler, mirroring the DOM ``addEventListener`` API.
   *
   * @param {string} event Event identifier.
   * @param {Function} handler Callback invoked when ``dispatchEvent`` is
   *   called.
   * @returns {void}
   */
  addEventListener(event, handler) {
    this.listeners.set(event, handler);
  }

  /**
   * Trigger a previously registered listener.
   *
   * @param {string} event Event identifier used when registering the handler.
   * @returns {void}
   */
  dispatchEvent(event) {
    const handler = this.listeners.get(event);
    if (handler) {
      handler();
    }
  }
}

export const documentStub = new DocumentStub();

/**
 * Reset the shared stub between test cases to avoid state bleed.
 *
 * @returns {void}
 */
export function resetDocumentStub() {
  documentStub.reset();
}

globalThis.document = documentStub;
