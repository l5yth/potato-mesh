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
 * Keyed chat tab elements (#881, SPEC DR1).
 *
 * Every chat tab owns one button in the tab strip and one panel. Both are
 * created the first time a tab id renders and kept for as long as the id does,
 * so a live refresh leaves the button a reader focused and the panel they
 * scrolled in place. A refresh writes only what changed: an unchanged label
 * writes nothing, and a new message count rewrites the label text alone.
 *
 * The button and panel markup matches what {@link module:chat-tabs} built
 * before tabs were keyed, so styles and selectors are unaffected.
 *
 * @module chat-tab-elements
 */

/**
 * ``nodeType`` of a ``DocumentFragment``.
 * @type {number}
 */
const DOCUMENT_FRAGMENT_NODE = 11;

/**
 * One chat tab's elements and the label state last written to its button.
 *
 * @typedef {Object} ChatTabRecord
 * @property {string} id Tab identifier.
 * @property {HTMLButtonElement} button Tab button (``.chat-tab``, ``data-tab-id``).
 * @property {HTMLElement} panel Tab panel (``.chat-tabpanel``).
 * @property {?string} label Label last written, ``null`` before the first write.
 * @property {?string} iconSrc Icon URL last written, ``null`` for none.
 * @property {?Node} labelNode Text node holding the label beside the icon.
 * @property {boolean} created Whether the current render created the record.
 */

/**
 * Build the protocol icon shown before a tab label. The URL becomes an
 * ``<img>`` attribute, never markup, so tab data cannot inject HTML.
 *
 * @param {Document} document Active document.
 * @param {string} src Icon URL.
 * @returns {HTMLImageElement} Decorative icon element.
 */
function createTabIcon(document, src) {
  const icon = document.createElement('img');
  icon.setAttribute('src', src);
  icon.setAttribute('alt', '');
  icon.setAttribute('width', '12');
  icon.setAttribute('height', '12');
  icon.setAttribute('aria-hidden', 'true');
  icon.setAttribute('loading', 'lazy');
  icon.setAttribute('decoding', 'async');
  icon.className = 'protocol-icon';
  return icon;
}

/**
 * Write a tab's label, and its icon when it has one, onto its button. Nothing
 * is written when both are unchanged since the last call; a changed label next
 * to an unchanged icon rewrites only the text node, so the icon element stays.
 *
 * @param {Document} document Active document.
 * @param {ChatTabRecord} record Tab record to update.
 * @param {string} label Label text.
 * @param {?string} iconSrc Icon URL, or ``null`` for a text-only tab.
 * @returns {boolean} ``true`` when the button was written to.
 */
export function writeTabLabel(document, record, label, iconSrc) {
  if (record.label === label && record.iconSrc === iconSrc) {
    return false;
  }
  const { button } = record;
  if (iconSrc && iconSrc === record.iconSrc && record.labelNode && typeof record.labelNode === 'object') {
    record.labelNode.textContent = label;
  } else if (iconSrc) {
    record.labelNode = document.createTextNode(label);
    button.replaceChildren(createTabIcon(document, iconSrc), record.labelNode);
  } else {
    if (record.iconSrc) {
      // The tab lost its icon: drop it before the text replaces the label.
      button.replaceChildren();
    }
    button.textContent = label;
    record.labelNode = null;
  }
  record.label = label;
  record.iconSrc = iconSrc;
  return true;
}

/**
 * Create the button and panel of a new tab. The button gets its one ``click``
 * listener here, for its whole lifetime; ``onActivate`` must route to the
 * current render, so refreshes never stack listeners (as for the channel
 * select, SPEC MS2).
 *
 * @param {Document} document Active document.
 * @param {string} id Tab identifier.
 * @param {function(string): void} onActivate Called with ``id`` on a click.
 * @returns {ChatTabRecord} New record, label not yet written.
 */
export function createTabRecord(document, id, onActivate) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'chat-tab';
  button.classList.add('chat-tab');
  button.setAttribute('role', 'tab');
  button.setAttribute('id', `chat-tab-${id}`);
  button.dataset.tabId = id;
  button.setAttribute('aria-selected', 'false');
  button.setAttribute('tabindex', '-1');
  button.addEventListener('click', () => onActivate(id));

  const panel = document.createElement('div');
  panel.className = 'chat-tabpanel';
  panel.classList.add('chat-tabpanel');
  panel.setAttribute('role', 'tabpanel');
  panel.setAttribute('id', `chat-panel-${id}`);
  panel.setAttribute('aria-labelledby', `chat-tab-${id}`);
  panel.hidden = true;

  return { id, button, panel, label: null, iconSrc: null, labelNode: null, created: true };
}

/**
 * Bring ``records`` in line with one render's tabs: reuse the record of every
 * id seen before, create one for each new id, write the labels that changed,
 * and forget ids that are no longer rendered.
 *
 * @param {Document} document Active document.
 * @param {Map<string, ChatTabRecord>} records Tab id to record, kept across renders.
 * @param {Array<{ id: string, label?: string, iconSrc?: ?string }>} specs This
 *   render's tabs, in order, with distinct non-empty ids.
 * @param {function(string): void} onActivate Click handler for new buttons
 *   (see {@link createTabRecord}).
 * @returns {Array<ChatTabRecord>} Records in tab order; ``created`` is ``true``
 *   only for records this call made.
 */
export function syncTabRecords(document, records, specs, onActivate) {
  const ordered = specs.map(spec => {
    let record = records.get(spec.id);
    if (record) {
      record.created = false;
    } else {
      record = createTabRecord(document, spec.id, onActivate);
      records.set(spec.id, record);
    }
    writeTabLabel(document, record, spec.label || '', spec.iconSrc || null);
    return record;
  });
  const rendered = new Set(specs.map(spec => spec.id));
  for (const id of [...records.keys()]) {
    if (!rendered.has(id)) {
      records.delete(id);
    }
  }
  return ordered;
}

/**
 * The nodes a tab's panel should hold, from the ``content`` its caller passed:
 * an array of nodes the caller reuses across renders (the keyed form), a
 * ``DocumentFragment`` (its children), a single node, or nothing.
 *
 * @param {?(Node|Array<Node>)} content Tab content.
 * @returns {Array<Node>} Wanted panel children, in order.
 */
export function contentNodesOf(content) {
  if (!content) {
    return [];
  }
  if (Array.isArray(content)) {
    return content;
  }
  if (content.nodeType === DOCUMENT_FRAGMENT_NODE) {
    return Array.from(content.childNodes);
  }
  return [content];
}
