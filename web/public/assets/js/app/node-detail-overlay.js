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

import { fetchNodeDetailHtml } from './node-page.js';

/**
 * Escape a string for safe HTML injection.
 *
 * @param {*} value Raw input value.
 * @returns {string} Escaped string.
 */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Normalise a candidate label by trimming whitespace.
 *
 * @param {*} value Raw label value.
 * @returns {string} Trimmed label or ``''``.
 */
function normaliseLabel(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length ? trimmed : '';
}

/**
 * Determine whether the supplied reference contains either a node identifier or number.
 *
 * @param {*} reference Candidate node reference.
 * @returns {boolean} ``true`` when the reference is usable.
 */
function hasValidReference(reference) {
  if (!reference || typeof reference !== 'object') {
    return false;
  }
  const explicitId = reference.nodeId ?? reference.node_id;
  const explicitNum = reference.nodeNum ?? reference.node_num ?? reference.num;
  return (explicitId != null && String(explicitId).trim().length > 0) || explicitNum != null;
}

/**
 * Create a controller that renders the node detail page inside a modal overlay.
 *
 * @param {{
 *   document?: Document,
 *   overlayId?: string,
 *   fetchNodeDetail?: Function,
 *   fetchImpl?: Function,
 *   refreshImpl?: Function,
 *   renderShortHtml?: Function,
 *   privateMode?: boolean,
 *   logger?: Console
 * }} [options] Behaviour overrides.
 * @returns {{
 *   open: (reference: Object, config?: { trigger?: Element, label?: string }) => Promise<void>,
 *   close: () => void,
 *   isOpen: () => boolean,
 *   getActiveTrigger: () => ?Element
 * }|null} Overlay controller or ``null`` when markup is unavailable.
 */
export function createNodeDetailOverlayManager(options = {}) {
  const documentRef = options.document ?? globalThis.document;
  if (!documentRef || typeof documentRef.getElementById !== 'function') {
    throw new TypeError('A document with getElementById support is required');
  }
  const overlayId = options.overlayId ?? 'nodeDetailOverlay';
  const overlay = documentRef.getElementById(overlayId);
  if (!overlay || typeof overlay.querySelector !== 'function') {
    return null;
  }
  const dialog = overlay.querySelector('.node-detail-overlay__dialog');
  const closeButton = overlay.querySelector('.node-detail-overlay__close');
  const content = overlay.querySelector('.node-detail-overlay__content');
  if (!dialog || !closeButton || !content) {
    return null;
  }

  const fetchDetail = typeof options.fetchNodeDetail === 'function' ? options.fetchNodeDetail : fetchNodeDetailHtml;
  const logger = options.logger ?? console;
  const privateMode = options.privateMode === true;
  const fetchImpl = options.fetchImpl;
  const refreshImpl = options.refreshImpl;
  const renderShortHtml = options.renderShortHtml;

  let requestToken = 0;
  let lastTrigger = null;
  let isVisible = false;
  let keydownHandler = null;

  function lockBodyScroll(lock) {
    if (!documentRef.body || !documentRef.body.style) {
      return;
    }
    if (lock) {
      documentRef.body.style.overflow = 'hidden';
    } else {
      documentRef.body.style.removeProperty('overflow');
    }
  }

  function setStatus(message, { isError = false } = {}) {
    const safe = escapeHtml(message || 'Loading node details…');
    const errorClass = isError ? ' node-detail-overlay__status--error' : '';
    content.innerHTML = `<p class="node-detail-overlay__status${errorClass}">${safe}</p>`;
  }

  function attachKeydown() {
    if (keydownHandler || typeof documentRef.addEventListener !== 'function') {
      return;
    }
    keydownHandler = event => {
      if (event && event.key === 'Escape') {
        if (typeof event.preventDefault === 'function') {
          event.preventDefault();
        }
        close();
      }
    };
    documentRef.addEventListener('keydown', keydownHandler);
  }

  function detachKeydown() {
    if (!keydownHandler || typeof documentRef.removeEventListener !== 'function') {
      return;
    }
    documentRef.removeEventListener('keydown', keydownHandler);
    keydownHandler = null;
  }

  function close() {
    if (!isVisible) return;
    isVisible = false;
    overlay.hidden = true;
    lockBodyScroll(false);
    detachKeydown();
    requestToken += 1;
    const trigger = lastTrigger;
    lastTrigger = null;
    if (trigger && typeof trigger.focus === 'function') {
      trigger.focus();
    }
  }

  if (typeof closeButton.addEventListener === 'function') {
    closeButton.addEventListener('click', event => {
      if (event && typeof event.preventDefault === 'function') {
        event.preventDefault();
      }
      close();
    });
  }

  if (typeof overlay.addEventListener === 'function') {
    overlay.addEventListener('click', event => {
      if (event && event.target === overlay) {
        close();
      }
    });
  }

  async function open(reference, { trigger, label } = {}) {
    if (!hasValidReference(reference)) {
      throw new TypeError('A node identifier is required to open the detail overlay');
    }
    lastTrigger = trigger ?? null;
    const loadingLabel = normaliseLabel(label);
    overlay.hidden = false;
    isVisible = true;
    lockBodyScroll(true);
    attachKeydown();
    if (typeof dialog.focus === 'function') {
      dialog.focus();
    }
    if (loadingLabel) {
      setStatus(`Loading ${loadingLabel}…`);
    } else {
      setStatus('Loading node details…');
    }
    const currentToken = ++requestToken;
    try {
      const html = await fetchDetail(reference, {
        fetchImpl,
        refreshImpl,
        renderShortHtml,
        privateMode,
      });
      if (currentToken !== requestToken) {
        return;
      }
      content.innerHTML = html;
      if (typeof closeButton.focus === 'function') {
        closeButton.focus();
      }
    } catch (error) {
      if (logger && typeof logger.error === 'function') {
        logger.error('Failed to render node detail overlay', error);
      }
      if (currentToken !== requestToken) {
        return;
      }
      setStatus('Failed to load node details.', { isError: true });
      if (typeof closeButton.focus === 'function') {
        closeButton.focus();
      }
    }
  }

  return {
    open,
    close,
    isOpen: () => isVisible && !overlay.hidden,
    getActiveTrigger: () => lastTrigger,
  };
}
