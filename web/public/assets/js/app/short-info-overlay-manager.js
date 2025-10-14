/*
 * Copyright (C) 2025 l5yth
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

const DEFAULT_TEMPLATE_ID = 'shortInfoOverlayTemplate';
const FULLSCREEN_CHANGE_EVENTS = [
  'fullscreenchange',
  'webkitfullscreenchange',
  'mozfullscreenchange',
  'MSFullscreenChange',
];

/**
 * Resolve the element currently presented in fullscreen mode.
 *
 * @param {Document} doc Host document reference.
 * @returns {?Element} Fullscreen element or ``null`` when fullscreen is inactive.
 */
function getFullscreenElement(doc) {
  if (!doc) return null;
  return (
    doc.fullscreenElement ||
    doc.webkitFullscreenElement ||
    doc.mozFullScreenElement ||
    doc.msFullscreenElement ||
    null
  );
}

/**
 * Determine the container that should host overlays.
 *
 * @param {Document} doc Host document reference.
 * @returns {?Element} Preferred overlay host element.
 */
function resolveOverlayHost(doc) {
  const fullscreenElement = getFullscreenElement(doc);
  if (fullscreenElement && typeof fullscreenElement.appendChild === 'function') {
    return fullscreenElement;
  }
  return doc && doc.body && typeof doc.body.appendChild === 'function' ? doc.body : null;
}

/**
 * Update overlay positioning mode based on fullscreen state.
 *
 * @param {Element} element Overlay DOM node.
 * @param {Document} doc Host document reference.
 * @returns {void}
 */
function applyOverlayPositioning(element, doc) {
  if (!element || !element.style) {
    return;
  }
  const fullscreenElement = getFullscreenElement(doc);
  const desired = fullscreenElement ? 'fixed' : 'absolute';
  if (element.style.position !== desired) {
    element.style.position = desired;
  }
}

/**
 * Determine whether a value behaves like a DOM element that can host overlays.
 *
 * @param {*} candidate Potential anchor element.
 * @returns {boolean} ``true`` when the candidate exposes the required DOM API.
 */
function isValidAnchor(candidate) {
  return (
    candidate != null &&
    typeof candidate === 'object' &&
    typeof candidate.getBoundingClientRect === 'function'
  );
}

/**
 * Create a factory that instantiates overlay DOM nodes.
 *
 * @param {Document} document Host document reference.
 * @param {?Element} template Template element cloned for each overlay.
 * @returns {Function} Factory generating overlay nodes with close/content refs.
 */
function createDefaultOverlayFactory(document, template) {
  const templateNode =
    template && template.content && template.content.firstElementChild
      ? template.content.firstElementChild
      : null;

  return () => {
    let overlay;
    if (templateNode && typeof templateNode.cloneNode === 'function') {
      overlay = templateNode.cloneNode(true);
    } else {
      overlay = document.createElement('div');
      overlay.className = 'short-info-overlay';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'false');
      const closeButton = document.createElement('button');
      closeButton.type = 'button';
      closeButton.className = 'short-info-close';
      closeButton.setAttribute('aria-label', 'Close node details');
      closeButton.textContent = '×';
      const content = document.createElement('div');
      content.className = 'short-info-content';
      overlay.appendChild(closeButton);
      overlay.appendChild(content);
    }

    const closeButton =
      typeof overlay.querySelector === 'function'
        ? overlay.querySelector('.short-info-close')
        : null;
    const content =
      typeof overlay.querySelector === 'function'
        ? overlay.querySelector('.short-info-content')
        : null;

    return { overlay, closeButton, content };
  };
}

/**
 * Create a no-op overlay stack used when the DOM primitives are unavailable.
 *
 * @returns {Object} Overlay stack interface with inert behaviour.
 */
function createNoopOverlayStack() {
  return {
    render() {},
    close() {},
    closeAll() {},
    isOpen() {
      return false;
    },
    containsNode() {
      return false;
    },
    positionAll() {},
    cleanupOrphans() {},
    incrementRequestToken() {
      return 0;
    },
    isTokenCurrent() {
      return false;
    },
    getOpenOverlays() {
      return [];
    },
  };
}

/**
 * Create a stack manager that renders and positions short-info overlays.
 *
 * @param {{
 *   document?: Document,
 *   window?: Window,
 *   templateId?: string,
 *   template?: Element,
 *   factory?: Function
 * }} [options] Overlay configuration and host references.
 * @returns {{
 *   render: (anchor: Element, html: string) => void,
 *   close: (anchor: Element) => void,
 *   closeAll: () => void,
 *   isOpen: (anchor: Element) => boolean,
 *   containsNode: (node: Node) => boolean,
 *   positionAll: () => void,
 *   cleanupOrphans: () => void,
 *   incrementRequestToken: (anchor: Element) => number,
 *   isTokenCurrent: (anchor: Element, token: number) => boolean,
 *   getOpenOverlays: () => Array<{ anchor: Element, element: Element }>
 * }} Overlay stack interface.
 */
export function createShortInfoOverlayStack(options = {}) {
  const doc = options.document || globalThis.document || null;
  const win = options.window || globalThis.window || null;

  if (!doc || !doc.body) {
    return createNoopOverlayStack();
  }

  const template =
    options.template !== undefined
      ? options.template
      : doc.getElementById(options.templateId || DEFAULT_TEMPLATE_ID);

  const overlayFactory =
    typeof options.factory === 'function'
      ? options.factory
      : createDefaultOverlayFactory(doc, template);

  const overlayStates = new Map();
  const overlayOrder = [];

  /**
   * Retrieve the active overlay host element.
   *
   * @returns {?Element} Host element capable of containing overlays.
   */
  function getOverlayHost() {
    return resolveOverlayHost(doc);
  }

  /**
   * Append ``element`` to the preferred overlay host when necessary.
   *
   * @param {Element} element Overlay root element.
   * @returns {void}
   */
  function ensureOverlayAttached(element) {
    if (!element) return;
    const host = getOverlayHost();
    if (!host) return;
    if (element.parentNode !== host) {
      host.appendChild(element);
    }
    applyOverlayPositioning(element, doc);
  }

  /**
   * React to fullscreen transitions by reattaching overlays to the active host.
   *
   * @returns {void}
   */
  function handleFullscreenChange() {
    for (const state of overlayStates.values()) {
      ensureOverlayAttached(state.element);
    }
    positionAll();
  }

  if (doc && typeof doc.addEventListener === 'function') {
    for (const eventName of FULLSCREEN_CHANGE_EVENTS) {
      doc.addEventListener(eventName, handleFullscreenChange);
    }
  }

  /**
   * Remove an overlay element from the DOM tree.
   *
   * @param {Element} element Overlay root element.
   * @returns {void}
   */
  function detachOverlayElement(element) {
    if (!element) return;
    if (typeof element.remove === 'function') {
      element.remove();
      return;
    }
    if (element.parentNode && typeof element.parentNode.removeChild === 'function') {
      element.parentNode.removeChild(element);
    }
  }

  /**
   * Create or retrieve the overlay state associated with ``anchor``.
   *
   * @param {Element} anchor Anchor element.
   * @returns {{
   *   anchor: Element,
   *   element: Element,
   *   content: Element,
   *   closeButton: Element,
   *   requestToken: number
   * }|null} Overlay state or ``null`` when creation fails.
   */
  function ensureState(anchor) {
    if (!isValidAnchor(anchor)) {
      return null;
    }
    let state = overlayStates.get(anchor);
    if (state) {
      return state;
    }

    const created = overlayFactory();
    if (!created || !created.overlay || !created.content) {
      return null;
    }

    const overlayEl = created.overlay;
    const closeButton = created.closeButton || null;
    const contentEl = created.content;

    if (typeof overlayEl.setAttribute === 'function') {
      overlayEl.setAttribute('data-short-info-overlay', '');
    }

    if (closeButton && typeof closeButton.addEventListener === 'function') {
      closeButton.addEventListener('click', event => {
        if (event) {
          if (typeof event.preventDefault === 'function') {
            event.preventDefault();
          }
          if (typeof event.stopPropagation === 'function') {
            event.stopPropagation();
          }
        }
        close(anchor);
      });
    }

    ensureOverlayAttached(overlayEl);

    state = {
      anchor,
      element: overlayEl,
      content: contentEl,
      closeButton,
      requestToken: 0,
    };
    overlayStates.set(anchor, state);
    overlayOrder.push(state);
    return state;
  }

  /**
   * Remove the overlay state associated with ``anchor``.
   *
   * @param {Element} anchor Anchor element.
   * @returns {void}
   */
  function removeState(anchor) {
    const state = overlayStates.get(anchor);
    if (!state) return;
    overlayStates.delete(anchor);
    const index = overlayOrder.indexOf(state);
    if (index >= 0) {
      overlayOrder.splice(index, 1);
    }
    detachOverlayElement(state.element);
  }

  /**
   * Position an overlay relative to its anchor element.
   *
   * @param {{ anchor: Element, element: Element }} state Overlay state entry.
   * @returns {void}
   */
  function positionState(state) {
    if (!state || !state.anchor || !state.element) {
      return;
    }
    if (!doc.body.contains(state.anchor)) {
      close(state.anchor);
      return;
    }

    const rect = state.anchor.getBoundingClientRect();
    const overlayRect =
      typeof state.element.getBoundingClientRect === 'function'
        ? state.element.getBoundingClientRect()
        : { width: 0, height: 0 };
    const viewportWidth =
      (doc.documentElement && doc.documentElement.clientWidth) ||
      (win && typeof win.innerWidth === 'number' ? win.innerWidth : 0);
    const viewportHeight =
      (doc.documentElement && doc.documentElement.clientHeight) ||
      (win && typeof win.innerHeight === 'number' ? win.innerHeight : 0);
    const scrollX = (win && typeof win.scrollX === 'number' ? win.scrollX : 0) || 0;
    const scrollY = (win && typeof win.scrollY === 'number' ? win.scrollY : 0) || 0;
    const fullscreenElement = getFullscreenElement(doc);
    const offsetX = fullscreenElement ? 0 : scrollX;
    const offsetY = fullscreenElement ? 0 : scrollY;

    let left = rect.left + offsetX;
    let top = rect.top + offsetY;

    if (viewportWidth > 0) {
      const maxLeft = offsetX + viewportWidth - overlayRect.width - 8;
      left = Math.max(offsetX + 8, Math.min(left, maxLeft));
    }
    if (viewportHeight > 0) {
      const maxTop = offsetY + viewportHeight - overlayRect.height - 8;
      top = Math.max(offsetY + 8, Math.min(top, maxTop));
    }

    if (state.element.style) {
      applyOverlayPositioning(state.element, doc);
      state.element.style.left = `${left}px`;
      state.element.style.top = `${top}px`;
      state.element.style.visibility = 'visible';
    }
  }

  /**
   * Schedule positioning of an overlay for the next animation frame.
   *
   * @param {{ anchor: Element, element: Element }} state Overlay state entry.
   * @returns {void}
   */
  function schedulePosition(state) {
    if (!state || !state.element) return;
    if (state.element.style) {
      state.element.style.visibility = 'hidden';
    }
    const raf = (win && win.requestAnimationFrame) || globalThis.requestAnimationFrame;
    if (typeof raf === 'function') {
      raf(() => positionState(state));
    } else {
      setTimeout(() => positionState(state), 16);
    }
  }

  /**
   * Render overlay content anchored to the provided element.
   *
   * @param {Element} anchor Anchor element driving overlay placement.
   * @param {string} html Inner HTML displayed in the overlay body.
   * @returns {void}
   */
  function render(anchor, html) {
    const state = ensureState(anchor);
    if (!state) {
      return;
    }
    ensureOverlayAttached(state.element);
    if (state.content && typeof state.content.innerHTML === 'string') {
      state.content.innerHTML = html;
    }
    if (state.element && typeof state.element.removeAttribute === 'function') {
      state.element.removeAttribute('hidden');
    }
    schedulePosition(state);
  }

  /**
   * Close the overlay associated with ``anchor``.
   *
   * @param {Element} anchor Anchor element whose overlay should be removed.
   * @returns {void}
   */
  function close(anchor) {
    const state = overlayStates.get(anchor);
    if (!state) return;
    state.requestToken += 1;
    removeState(anchor);
  }

  /**
   * Determine whether an overlay for ``anchor`` is currently open.
   *
   * @param {Element} anchor Anchor element to test.
   * @returns {boolean} ``true`` when an overlay exists for the anchor.
   */
  function isOpen(anchor) {
    return overlayStates.has(anchor);
  }

  /**
   * Close every active overlay.
   *
   * @returns {void}
   */
  function closeAll() {
    const anchors = Array.from(overlayStates.keys());
    for (const anchor of anchors) {
      close(anchor);
    }
  }

  /**
   * Test whether the provided DOM node belongs to any overlay.
   *
   * @param {Node} node Candidate DOM node.
   * @returns {boolean} ``true`` when the node is inside an overlay.
   */
  function containsNode(node) {
    if (!node) return false;
    for (const state of overlayStates.values()) {
      if (state.element && typeof state.element.contains === 'function') {
        if (state.element.contains(node)) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Reposition all overlays based on the latest viewport metrics.
   *
   * @returns {void}
   */
  function positionAll() {
    for (const state of overlayStates.values()) {
      positionState(state);
    }
  }

  /**
   * Remove overlays whose anchors are no longer part of the document body.
   *
   * @returns {void}
   */
  function cleanupOrphans() {
    for (const state of Array.from(overlayStates.values())) {
      if (!doc.body.contains(state.anchor)) {
        close(state.anchor);
      }
    }
  }

  /**
   * Increment and return the request token for the provided anchor.
   *
   * @param {Element} anchor Anchor whose request token should be updated.
   * @returns {number} Updated token value.
   */
  function incrementRequestToken(anchor) {
    const state = ensureState(anchor);
    if (!state) {
      return 0;
    }
    state.requestToken += 1;
    return state.requestToken;
  }

  /**
   * Determine whether ``token`` is still current for ``anchor``.
   *
   * @param {Element} anchor Anchor element associated with the request.
   * @param {number} token Token obtained from ``incrementRequestToken``.
   * @returns {boolean} ``true`` when the token is current.
   */
  function isTokenCurrent(anchor, token) {
    const state = overlayStates.get(anchor);
    if (!state) {
      return false;
    }
    return state.requestToken === token;
  }

  /**
   * Retrieve diagnostic information about open overlays.
   *
   * @returns {Array<{ anchor: Element, element: Element }>}
   */
  function getOpenOverlays() {
    return overlayOrder.map(state => ({ anchor: state.anchor, element: state.element }));
  }

  return {
    render,
    close,
    closeAll,
    isOpen,
    containsNode,
    positionAll,
    cleanupOrphans,
    incrementRequestToken,
    isTokenCurrent,
    getOpenOverlays,
  };
}

export const __testUtils = {
  isValidAnchor,
  createDefaultOverlayFactory,
  createNoopOverlayStack,
};
