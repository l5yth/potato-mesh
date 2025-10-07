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
