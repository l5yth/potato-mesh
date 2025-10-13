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

/**
 * Build an overlay controller that renders node pages inside an iframe.
 *
 * The controller dynamically injects DOM elements when a compatible document is
 * provided. In non-browser environments the returned object degrades
 * gracefully, exposing no-op methods so tests using minimal stubs do not fail.
 *
 * @param {{ document?: Document, window?: Window }} env Browser primitives.
 * @returns {{
 *   attach: (HTMLAnchorElement) => void,
 *   attachAll: (Iterable<HTMLElement|HTMLAnchorElement>) => void,
 *   open: (string, HTMLElement?) => void,
 *   close: () => void,
 *   isOpen: () => boolean
 * }} Overlay controller API.
 */
export function createNodeOverlayController(env = {}) {
  const { document } = env;
  if (!document || !document.body || typeof document.createElement !== 'function') {
    return {
      attach: () => {},
      attachAll: () => {},
      open: () => {},
      close: () => {},
      isOpen: () => false
    };
  }

  const overlay = document.createElement('div');
  overlay.className = 'node-overlay';
  overlay.hidden = true;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-hidden', 'true');

  const dialog = document.createElement('div');
  dialog.className = 'node-overlay__dialog';
  dialog.setAttribute('role', 'document');

  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'node-overlay__close';
  closeButton.setAttribute('aria-label', 'Close node view');
  closeButton.textContent = '×';

  const iframe = document.createElement('iframe');
  iframe.className = 'node-overlay__frame';
  iframe.setAttribute('title', 'Node details');
  iframe.setAttribute('loading', 'lazy');

  dialog.appendChild(closeButton);
  dialog.appendChild(iframe);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  let lastFocused = null;

  /**
   * Determine whether the overlay is currently visible.
   *
   * @returns {boolean} True when the overlay is displayed.
   */
  function isOpen() {
    return !overlay.hidden;
  }

  /**
   * Close the overlay and restore focus to the previously active element.
   *
   * @returns {void}
   */
  function close() {
    if (overlay.hidden) return;
    overlay.hidden = true;
    overlay.setAttribute('aria-hidden', 'true');
    iframe.src = 'about:blank';
    if (document.body && document.body.classList) {
      document.body.classList.remove('node-overlay-open');
    }
    if (lastFocused && typeof lastFocused.focus === 'function') {
      try {
        lastFocused.focus();
      } catch (err) {
        // Ignore focus errors in test environments lacking full DOM APIs.
      }
    }
    lastFocused = null;
  }

  /**
   * Open the overlay for the supplied URL.
   *
   * @param {string} url Node detail URL.
   * @param {?HTMLElement} trigger Element that initiated the open action.
   * @returns {void}
   */
  function open(url, trigger = null) {
    if (!url) return;
    lastFocused = trigger || document.activeElement || null;
    overlay.hidden = false;
    overlay.setAttribute('aria-hidden', 'false');
    iframe.src = url;
    if (document.body && document.body.classList) {
      document.body.classList.add('node-overlay-open');
    }
    if (typeof closeButton.focus === 'function') {
      closeButton.focus();
    }
  }

  closeButton.addEventListener('click', event => {
    event.preventDefault();
    close();
  });

  overlay.addEventListener('click', event => {
    if (event.target === overlay) {
      close();
    }
  });

  if (document.addEventListener) {
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && isOpen()) {
        close();
      }
    });
  }

  /**
   * Attach overlay behaviour to a link element.
   *
   * @param {HTMLAnchorElement} link Anchor element representing a node.
   * @returns {void}
   */
  function attach(link) {
    if (!link || link.dataset.nodeOverlayBound === 'true') {
      return;
    }
    link.dataset.nodeOverlayBound = 'true';
    link.addEventListener('click', event => {
      if (event.defaultPrevented) return;
      if (event.button !== undefined && event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      event.preventDefault();
      const href = link.href;
      open(href, link);
    });
  }

  /**
   * Attach overlay behaviour to every element in the collection.
   *
   * @param {Iterable<HTMLElement|HTMLAnchorElement>} elements Iterable of anchors.
   * @returns {void}
   */
  function attachAll(elements) {
    if (!elements) return;
    for (const el of elements) {
      attach(el);
    }
  }

  return {
    attach,
    attachAll,
    open,
    close,
    isOpen
  };
}
