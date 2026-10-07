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
 * Keyboard focus across a chat refresh (#881, SPEC DR1).
 *
 * A refresh keeps every unchanged chat element, but it can still move a kept
 * one (a channel tab overtakes another) or replace an entry whose content
 * changed with a rebuilt node. A browser drops focus from an element that
 * leaves the document, even for the instant of a move, and focus falls back
 * to ``<body>``. {@link captureChatFocus} records the focused control before
 * the refresh; {@link restoreChatFocus} afterwards hands focus back to it, or
 * to the same control inside the node that replaced its entry.
 *
 * @module chat-focus
 */

/**
 * The focused control and where it sat, as recorded before a refresh.
 *
 * @typedef {Object} ChatFocusSnapshot
 * @property {Element} element The focused element.
 * @property {Array<Element>} chain ``element`` and its ancestors below the
 *   container, innermost first.
 * @property {Array<number>} path ``path[i]`` is the index of ``chain[i]``
 *   among the element children of ``chain[i + 1]``.
 */

/**
 * ``element`` and its ancestors below ``container``, innermost first.
 *
 * @param {Node} element Node to start from.
 * @param {Node} container Ancestor to stop at (excluded).
 * @returns {?Array<Node>} The chain, or ``null`` when ``element`` is not
 *   inside ``container`` (detached, or elsewhere in the document).
 */
function chainBelow(element, container) {
  const chain = [];
  for (let node = element; node; node = node.parentNode) {
    if (node === container) {
      return chain;
    }
    chain.push(node);
  }
  return null;
}

/**
 * Index of ``node`` among the element children of ``parent``.
 *
 * @param {Node} parent Parent element.
 * @param {Node} node Child element.
 * @returns {number} Zero-based index, or ``-1``.
 */
function childIndex(parent, node) {
  return Array.prototype.indexOf.call(parent.children || [], node);
}

/**
 * Record the focused element when it is inside ``container``.
 *
 * @param {?Document} document Active document.
 * @param {Node} container The chat container.
 * @returns {?ChatFocusSnapshot} Snapshot, or ``null`` when focus is elsewhere.
 */
export function captureChatFocus(document, container) {
  const element = document ? document.activeElement : null;
  if (!element || element === container) {
    return null;
  }
  const chain = chainBelow(element, container);
  if (!chain) {
    return null;
  }
  const path = chain.slice(0, -1).map((node, index) => childIndex(chain[index + 1], node));
  return { element, chain, path };
}

/**
 * Follow the first ``depth`` steps of a captured path down from ``root``, the
 * replacement of ``chain[depth]``, to the control matching ``chain[0]``.
 *
 * @param {Element} root Replacement node.
 * @param {Array<number>} path Captured child indices (see {@link ChatFocusSnapshot}).
 * @param {number} depth How far below ``root`` the focused element sat.
 * @returns {?Element} The matching element, or ``null`` when the replacement
 *   has a different shape.
 */
function descend(root, path, depth) {
  let node = root;
  for (let index = depth - 1; index >= 0 && node; index -= 1) {
    node = node.children ? node.children[path[index]] : null;
  }
  return node || null;
}

/**
 * Give focus back after a refresh: to the captured element when it is still
 * in ``container`` but lost focus (it was moved), else to the same control in
 * the node that replaced one of its ancestors. The control must have the same
 * tag name, so a replacement with a different shape takes no focus. Focusing
 * never scrolls.
 *
 * @param {?Document} document Active document.
 * @param {Node} container The chat container.
 * @param {?ChatFocusSnapshot} snapshot What {@link captureChatFocus} recorded.
 * @param {?function(Node): ?Node} [replacementOf] Maps a node the refresh
 *   replaced to its replacement (the chat entry cache knows entries).
 * @returns {boolean} ``true`` when focus was handed back.
 */
export function restoreChatFocus(document, container, snapshot, replacementOf = null) {
  if (!snapshot || document.activeElement === snapshot.element) {
    return false;
  }
  let target = null;
  if (chainBelow(snapshot.element, container)) {
    target = snapshot.element;
  } else if (typeof replacementOf === 'function') {
    for (let depth = 0; depth < snapshot.chain.length && !target; depth += 1) {
      const replacement = replacementOf(snapshot.chain[depth]);
      if (replacement && chainBelow(replacement, container)) {
        target = descend(replacement, snapshot.path, depth);
      }
    }
  }
  if (!target || target.tagName !== snapshot.element.tagName || typeof target.focus !== 'function') {
    return false;
  }
  target.focus({ preventScroll: true });
  return true;
}
