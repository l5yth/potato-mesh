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

class DocumentStub {
  constructor() {
    this.reset();
  }

  reset() {
    this.configElement = null;
    this.listeners = new Map();
  }

  setConfigElement(element) {
    this.configElement = element;
  }

  querySelector(selector) {
    if (selector === '[data-app-config]') {
      return this.configElement;
    }
    return null;
  }

  addEventListener(event, handler) {
    this.listeners.set(event, handler);
  }

  dispatchEvent(event) {
    const handler = this.listeners.get(event);
    if (handler) {
      handler();
    }
  }
}

export const documentStub = new DocumentStub();
export function resetDocumentStub() {
  documentStub.reset();
}

globalThis.document = documentStub;
