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

import { captureChatFocus, restoreChatFocus } from './chat-focus.js';
import { reconcileChildNodes } from './chat-reconcile.js';
import { contentNodesOf, syncTabRecords } from './chat-tab-elements.js';

/**
 * Slack (px) within which the active panel counts as scrolled to the bottom.
 * A reader inside this band is treated as "pinned" and kept pinned across a
 * passive re-render (tail-follow); anyone scrolled further up keeps their exact
 * position. Small enough to ignore sub-pixel rounding, large enough to survive a
 * one-line layout jitter.
 * @type {number}
 */
const SCROLL_PIN_TOLERANCE_PX = 4;

/**
 * Capture the active panel's vertical scroll state before a re-render, so a
 * passive refresh keeps the reader's place instead of yanking them to the
 * bottom on every live update (bugfix B), and a reader at the bottom keeps
 * following new entries (tail-follow).
 *
 * Call it before anything touches the panel's entries: a panel whose entries
 * were already moved out reads as empty, so a browser reports it scrolled to
 * the top of nothing, which counts as pinned (CL-A3, #881). ``renderChatLog``
 * therefore captures first and passes the result to {@link renderChatTabs}.
 *
 * @param {HTMLElement} container Chat container holding the *previous* render.
 * @returns {?{ top: number, pinned: boolean }} The active panel's scroll offset
 *   and whether it was at the bottom, or ``null`` when there is no prior panel
 *   (initial render) — in which case the caller pins to the bottom.
 */
export function capturePreviousActivePanelScroll(container) {
  const panelWrapper = container && container.children && container.children[1];
  const panels = panelWrapper && panelWrapper.children;
  if (!panels) {
    return null;
  }
  for (const panel of panels) {
    if (!panel || panel.hidden !== false) continue;
    const distanceFromBottom = panel.scrollHeight - panel.scrollTop - panel.clientHeight;
    return { top: panel.scrollTop, pinned: distanceFromBottom <= SCROLL_PIN_TOLERANCE_PX };
  }
  return null;
}

/**
 * Apply the captured vertical scroll to the active panel after a render.
 * A reader that was pinned to the bottom (or an initial render with no prior
 * panel, ``previous == null``) is scrolled to the new bottom so freshly-arrived
 * entries stay visible (tail-follow). A reader scrolled up in a panel the
 * render kept is left alone: the panel still holds their offset, and writing
 * the captured value back would undo the browser's scroll anchoring when old
 * entries leave above them (SPEC DR3, #881). Only a panel that is not the one
 * they scrolled in gets the captured offset (bugfix B).
 *
 * @param {?HTMLElement} panel The active panel after the render.
 * @param {?{ top: number, pinned: boolean }} previous Captured scroll state.
 * @param {boolean} [kept=false] Whether ``panel`` is the panel the state was
 *   captured from, kept by the render.
 * @returns {void}
 */
function applyActivePanelScroll(panel, previous, kept = false) {
  if (!panel) {
    return;
  }
  if (!previous || previous.pinned) {
    panel.scrollTop = panel.scrollHeight;
  } else if (!kept) {
    panel.scrollTop = previous.top;
  }
}

/**
 * Put the channel tab strip back at ``left`` without animating. The strip
 * scrolls smoothly in CSS (``scroll-behavior: smooth``), so a plain
 * ``scrollLeft`` write on a fresh strip slid it from the first tab to the
 * reader's place on every refresh; ``behavior: 'instant'`` overrides the CSS
 * for this one write (SPEC DR3, #881). A kept strip needs no restore at all.
 *
 * @param {HTMLElement} tabList The tab strip to scroll.
 * @param {number} left Horizontal offset to restore, in px.
 * @returns {void}
 */
function restoreTabStripScroll(tabList, left) {
  if (!(left > 0)) {
    return;
  }
  if (typeof tabList.scrollTo === 'function') {
    tabList.scrollTo({ left, behavior: 'instant' });
  } else {
    tabList.scrollLeft = left;
  }
}

/**
 * Horizontal offset of a tab strip this module cannot keep (markup it did not
 * build): the strip is the second child of the first wrapper.
 *
 * @param {HTMLElement} container Chat container holding the previous render.
 * @returns {number} The old strip's ``scrollLeft``, or ``0`` when there is none.
 */
function readPreviousTabStripScroll(container) {
  const previousTabListWrapper = container.children && container.children[0];
  const previousTabList =
    previousTabListWrapper && previousTabListWrapper.children ? previousTabListWrapper.children[1] : null;
  return previousTabList &&
    previousTabList.className === 'chat-tablist' &&
    typeof previousTabList.scrollLeft === 'number'
    ? previousTabList.scrollLeft
    : 0;
}

/**
 * Activation callback of each live channel ``<select>`` (LV8), keyed by the
 * element. The select outlives the render that created it (#882), so its one
 * ``change`` listener looks up the latest render's ``setActiveTab`` here
 * instead of closing over a render whose tab elements are gone.
 * @type {WeakMap<HTMLSelectElement, function(string): void>}
 */
const tabSelectActivators = new WeakMap();

/**
 * Create the channel dropdown (LV8) with its single ``change`` listener.
 *
 * @param {Document} document Active document instance.
 * @returns {HTMLSelectElement} The new, empty select.
 */
function createTabSelect(document) {
  const tabSelect = document.createElement('select');
  tabSelect.className = 'chat-tab-select';
  tabSelect.setAttribute('aria-label', 'Jump to channel');
  tabSelect.addEventListener('change', () => {
    const activate = tabSelectActivators.get(tabSelect);
    if (activate) {
      activate(tabSelect.value);
    }
  });
  return tabSelect;
}

/**
 * The parts of a chat tab bar that persist across renders, and its keyed tabs.
 *
 * @typedef {Object} ChatTabBar
 * @property {HTMLElement} wrapper ``.chat-tablist-wrapper``: arrows, strip, select.
 * @property {HTMLButtonElement} prevBtn ◀ scroll button.
 * @property {HTMLElement} tabList ``.chat-tablist``, the tab strip.
 * @property {HTMLButtonElement} nextBtn ▶ scroll button.
 * @property {HTMLSelectElement} select Channel dropdown (LV8).
 * @property {HTMLElement} panelWrapper ``.chat-tabpanels``.
 * @property {Map<string, import('./chat-tab-elements.js').ChatTabRecord>} tabs
 *   Tab id to its button and panel.
 * @property {?function(string, { scrollActiveIntoView?: boolean }=): void} activate
 *   The latest render's tab switch; tab clicks route through it.
 * @property {function(): void} updateArrows Show each arrow only while the
 *   strip can scroll that way, and the select only while the strip overflows
 *   (SPEC CD6).
 */

/**
 * Tab bars this module built, by wrapper element. Only a bar found here is
 * kept by a re-render (#881); anything else in the container is replaced.
 * @type {WeakMap<HTMLElement, ChatTabBar>}
 */
const tabBars = new WeakMap();

/**
 * Create one of the ◀ / ▶ buttons that scroll the tab strip. They are mouse
 * affordances only: hidden from assistive technology and out of the tab order.
 *
 * @param {Document} document Active document instance.
 * @param {'prev'|'next'} direction Which end of the strip the button sits at.
 * @param {string} glyph Button text.
 * @returns {HTMLButtonElement} The hidden button.
 */
function createScrollButton(document, direction, glyph) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `chat-tab-scroll-btn chat-tab-scroll-btn--${direction}`;
  button.setAttribute('aria-hidden', 'true');
  button.setAttribute('tabindex', '-1');
  button.textContent = glyph;
  button.hidden = true;
  return button;
}

/**
 * Build a tab bar and its panel wrapper, and bind their listeners. Everything
 * here happens once per bar: the strip, its arrows and the select stay in the
 * document across renders, so no listener or observer accumulates.
 *
 * @param {Document} document Active document instance.
 * @returns {ChatTabBar} The new bar, registered for later renders.
 */
function createTabBar(document) {
  // The wrapper holds the scroll buttons and the tab list so the border-bottom
  // spans the full width including the arrow buttons.
  const wrapper = document.createElement('div');
  wrapper.className = 'chat-tablist-wrapper';
  const prevBtn = createScrollButton(document, 'prev', '◀');
  const nextBtn = createScrollButton(document, 'next', '▶');
  const tabList = document.createElement('div');
  tabList.className = 'chat-tablist';
  tabList.setAttribute('role', 'tablist');
  // Channel dropdown selector (LV8): a native <select> listing every tab so
  // the user can jump to a channel regardless of the horizontal scroll
  // position (the native control supplies the downward-triangle affordance).
  // It shows only while the strip overflows (SPEC CD6, see updateArrows).
  const select = createTabSelect(document);
  const panelWrapper = document.createElement('div');
  panelWrapper.className = 'chat-tabpanels';
  wrapper.appendChild(prevBtn);
  wrapper.appendChild(tabList);
  wrapper.appendChild(nextBtn);
  wrapper.appendChild(select);

  /**
   * Refresh the hidden state of the scroll arrow buttons from the current
   * scroll position of the tab list, and of the select from whether the tabs
   * fit (SPEC CD6).
   *
   * @returns {void}
   */
  const updateArrows = () => {
    // Every width is read before anything is written: one layout per call (LR-A3).
    const scrollLeft = tabList.scrollLeft || 0;
    const clientWidth = tabList.clientWidth || 0;
    const scrollWidth = tabList.scrollWidth || 0;
    // The tabs fit when they are no wider than the whole bar, the strip's
    // width with no select and no arrow beside it. Measuring the strip itself
    // would flip: hiding the select widens it, showing the select narrows it.
    // A strip that is not laid out (≤ 900 px, UX11) never fits, so the select
    // stays the channel control there. Allow 1 px rounding tolerance.
    const fits = clientWidth > 0 && scrollWidth <= (wrapper.clientWidth || 0) + 1;
    prevBtn.hidden = fits || scrollLeft <= 0;
    nextBtn.hidden = fits || scrollLeft + clientWidth >= scrollWidth - 1;
    // Written only on a change, so an idle render leaves the select alone (MS3).
    if (select.hidden !== fits) {
      select.hidden = fits;
    }
  };
  // Recalculate arrow visibility on scroll and on container resize.
  if (typeof tabList.addEventListener === 'function') {
    tabList.addEventListener('scroll', updateArrows);
  }
  if (typeof globalThis.ResizeObserver === 'function') {
    // Never disconnected: the observer lives exactly as long as the strip.
    new globalThis.ResizeObserver(updateArrows).observe(tabList);
  }
  prevBtn.addEventListener('click', () => {
    if (typeof tabList.scrollBy === 'function') {
      tabList.scrollBy({ left: -150, behavior: 'smooth' });
    }
  });
  nextBtn.addEventListener('click', () => {
    if (typeof tabList.scrollBy === 'function') {
      tabList.scrollBy({ left: 150, behavior: 'smooth' });
    }
  });

  const bar = { wrapper, prevBtn, tabList, nextBtn, select, panelWrapper, tabs: new Map(), activate: null, updateArrows };
  tabBars.set(wrapper, bar);
  return bar;
}

/**
 * Put a new bar into ``container`` in place of whatever it held.
 *
 * @param {Document} document Active document instance.
 * @param {HTMLElement} container Chat container.
 * @param {ChatTabBar} bar Bar from {@link createTabBar}.
 * @returns {void}
 */
function mountTabBar(document, container, bar) {
  const fragment = createFragment(document);
  fragment.appendChild(bar.wrapper);
  fragment.appendChild(bar.panelWrapper);
  if (typeof container.replaceChildren === 'function') {
    container.replaceChildren(fragment);
  } else {
    container.innerHTML = '';
    container.appendChild(fragment);
  }
}

/**
 * Find the tab bar a previous render built, so a re-render keeps it and its
 * tabs (#881) and above all its channel select (#882): a native select whose
 * picker is open loses the pick when the element is removed, and at ≤ 900 px it
 * is the only channel control (UX11).
 *
 * @param {HTMLElement} container Chat container holding the previous render.
 * @returns {?ChatTabBar} The live bar, or ``null`` when there is none to keep
 *   (initial render, emptied tabs, foreign markup, or a panel wrapper that is
 *   not the bar's own).
 */
function findPersistentTabBar(container) {
  const [wrapper, panelWrapper] = container.children || [];
  const bar = wrapper ? tabBars.get(wrapper) : undefined;
  return bar && bar.panelWrapper === panelWrapper ? bar : null;
}

/**
 * Bring the select's options in line with the tab list without touching the
 * select itself. When the id sequence is unchanged only labels that differ
 * (message counts) are rewritten, on the same option nodes; otherwise the
 * options, never the select, are rebuilt.
 *
 * @param {Document} document Active document instance.
 * @param {HTMLSelectElement} select Channel select kept across renders.
 * @param {Array<{ id: string, label: string }>} entries Wanted options, in tab order.
 * @returns {void}
 */
function syncTabSelectOptions(document, select, entries) {
  const options = select.children;
  const sameIds =
    options.length === entries.length && entries.every((entry, index) => options[index].value === entry.id);
  if (sameIds) {
    entries.forEach((entry, index) => {
      if (options[index].textContent !== entry.label) {
        options[index].textContent = entry.label;
      }
    });
    return;
  }
  const rebuilt = entries.map(entry => {
    const option = document.createElement('option');
    option.value = entry.id;
    option.textContent = entry.label;
    return option;
  });
  select.replaceChildren(...rebuilt);
}

/**
 * The tabs to render: falsy entries, empty or non-string ids and repeated ids
 * are dropped, keeping the first tab of each id.
 *
 * @param {*} tabs Caller's tab list.
 * @returns {Array<Object>} Tabs with distinct non-empty ids, in order.
 */
function uniqueTabSpecs(tabs) {
  const seen = new Set();
  const specs = [];
  for (const tab of Array.isArray(tabs) ? tabs : []) {
    if (!tab || typeof tab.id !== 'string' || tab.id.length === 0 || seen.has(tab.id)) {
      continue;
    }
    seen.add(tab.id);
    specs.push(tab);
  }
  return specs;
}

/**
 * Empty the chat container; the next render starts a fresh bar.
 *
 * @param {HTMLElement} container Chat container.
 * @returns {void}
 */
function clearChatContainer(container) {
  if (typeof container.replaceChildren === 'function') {
    container.replaceChildren();
  } else {
    container.innerHTML = '';
  }
  container.dataset.activeTab = '';
}

/**
 * Render an accessible tab interface within ``container``.
 *
 * When a tab carries an ``iconSrc`` URL the icon is rendered as an
 * {@code <img>} element built entirely via DOM APIs — no ``innerHTML`` is
 * involved so the value is safe even if it originates from user-controlled
 * data (img src does not execute script).  The ``label`` field is always
 * inserted as a text node.
 *
 * When the tab list overflows its container, ◀ / ▶ scroll buttons are
 * rendered on either side of the list.  They are hidden via the
 * {@code hidden} attribute while the corresponding scroll direction is
 * not available. The channel ``<select>`` is hidden the same way while the
 * tabs fit the bar without it (SPEC CD6).
 *
 * The first call builds the tab bar; later calls update it in place (SPEC
 * DR1, #881). The bar wrapper, the arrows, the tab strip, the channel
 * ``<select>`` (LV8, kept since #882) and the panel wrapper stay in the
 * document. Each tab id keeps its button and panel while it is rendered; a
 * changed label rewrites the text alone. Each panel's children are brought in
 * line with the tab's ``content`` without moving the nodes that stay, so a
 * refresh keeps focus, a text selection and the scroll offsets where the
 * reader left them. A focused control that a refresh moves or replaces gets
 * focus back (see {@link module:chat-focus}).
 *
 * @param {{
 *   document: Document,
 *   container: HTMLElement,
 *   tabs: Array<{ id: string, label: string, iconSrc?: string|null, content: ?(Node|Array<Node>) }>,
 *   previousActiveTabId?: string|null,
 *   defaultActiveTabId?: string|null,
 *   previousPanelScroll?: ?{ top: number, pinned: boolean },
 *   replacementOf?: ?function(Node): ?Node
 * }} options Rendering parameters. A tab's ``content`` is the panel's wanted
 *   children: an array of nodes reused across renders (keyed), a fragment, a
 *   node, or nothing. ``previousPanelScroll`` is the reader's place as
 *   {@link capturePreviousActivePanelScroll} read it before the caller built
 *   ``tabs`` (``null``: no panel was shown); omit it to read the container
 *   here instead. ``replacementOf`` maps a content node a previous render
 *   placed to the node that replaces it, so focus inside a rebuilt entry
 *   moves to the same control of the rebuilt one.
 * @returns {?string} Identifier of the active tab after rendering.
 */
export function renderChatTabs({
  document,
  container,
  tabs,
  previousActiveTabId = null,
  defaultActiveTabId = null,
  previousPanelScroll = undefined,
  replacementOf = null
}) {
  if (!container || !document) {
    return null;
  }
  const specs = uniqueTabSpecs(tabs);
  if (specs.length === 0) {
    clearChatContainer(container);
    return null;
  }

  const existingActive = container.dataset?.activeTab || null;
  // Read the reader's place and focus before anything below touches the DOM.
  // A caller that moves entry nodes while building ``tabs`` passes the place it
  // read beforehand; this panel may already be empty by now (CL-A3, #881).
  const panelScroll =
    previousPanelScroll === undefined ? capturePreviousActivePanelScroll(container) : previousPanelScroll;
  const focus = captureChatFocus(document, container);

  let bar = findPersistentTabBar(container);
  let previousScrollLeft = 0;
  if (!bar) {
    // First render, or markup this module did not build: start a bar, and
    // carry over the scroll of a strip it replaces (item 5, LD-A2).
    previousScrollLeft = readPreviousTabStripScroll(container);
    bar = createTabBar(document);
    mountTabBar(document, container, bar);
  }
  const tabBar = bar;
  const records = syncTabRecords(document, tabBar.tabs, specs, id => {
    if (tabBar.activate) {
      tabBar.activate(id, { scrollActiveIntoView: true });
    }
  });
  records.forEach((record, index) => reconcileChildNodes(record.panel, contentNodesOf(specs[index].content)));
  reconcileChildNodes(tabBar.tabList, records.map(record => record.button));
  reconcileChildNodes(tabBar.panelWrapper, records.map(record => record.panel));
  syncTabSelectOptions(
    document,
    tabBar.select,
    specs.map(spec => ({ id: spec.id, label: spec.label || spec.id }))
  );

  const activeTabId =
    [existingActive, previousActiveTabId, defaultActiveTabId].find(id => id && tabBar.tabs.has(id)) ||
    records[0].id;
  const activeRecord = tabBar.tabs.get(activeTabId);
  // Read before setActiveTab: is this the panel the reader was scrolled in?
  const keptActivePanel = !activeRecord.created && activeRecord.panel.hidden === false;

  /**
   * Show the panel of ``newId`` and mark its button active, hiding the rest.
   * Tab clicks and the dropdown call it with ``scrollActiveIntoView`` (an
   * explicit switch); a render calls it without (passive).
   *
   * @param {string} newId Tab to activate; an id no tab has clears the marker.
   * @param {{ scrollActiveIntoView?: boolean }} [options] Explicit-switch flag.
   * @returns {void}
   */
  const setActiveTab = (newId, { scrollActiveIntoView = false } = {}) => {
    if (!newId) return;
    let matched = false;
    for (const entry of records) {
      const isActive = entry.id === newId;
      entry.button.setAttribute('aria-selected', isActive ? 'true' : 'false');
      entry.button.setAttribute('tabindex', isActive ? '0' : '-1');
      if (isActive) {
        entry.button.classList.add('is-active');
        entry.panel.hidden = false;
        matched = true;
        container.dataset.activeTab = newId;
        // Write only on a change, so an idle re-render leaves an open picker alone (#882).
        if (tabBar.select.value !== newId) {
          tabBar.select.value = newId;
        }
        // An explicit tab switch (click / dropdown) jumps to the newest entry and
        // scrolls the chosen tab into view. A passive re-render does NEITHER: the
        // reader's vertical scroll is handled after the render's switch below,
        // and the horizontal tab scroll is left untouched (bugfix B / LD-A2).
        if (scrollActiveIntoView) {
          if (typeof entry.panel.scrollHeight === 'number' && typeof entry.panel.scrollTop === 'number') {
            entry.panel.scrollTop = entry.panel.scrollHeight;
          }
          if (typeof entry.button.scrollIntoView === 'function') {
            entry.button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          }
        }
      } else {
        entry.button.classList.remove('is-active');
        entry.panel.hidden = true;
      }
    }
    if (!matched) {
      container.dataset.activeTab = '';
    }
  };

  setActiveTab(activeTabId);
  // Tail-follow a reader at the bottom, pin an initial render to the newest
  // entry, and leave a scrolled-up reader in their kept panel alone (DR3).
  applyActivePanelScroll(activeRecord.panel, panelScroll, keptActivePanel);
  // Only a strip that replaced another is scrolled, instantly (DR3).
  restoreTabStripScroll(tabBar.tabList, previousScrollLeft);
  restoreChatFocus(document, container, focus, replacementOf);

  // Single arrow-visibility pass, after every structural + scroll write above.
  // Reading the tab list geometry here, and not also before setActiveTab
  // un-hides the active panel, keeps a live refresh at one forced reflow
  // (frontend perf: the chat-tabs `refresh` forced-reflow hotspot, LR-A3).
  tabBar.updateArrows();

  // Tab clicks and the dropdown (LV8) drive this render from now on; each
  // element's one listener looks the current switch up (#882).
  tabBar.activate = setActiveTab;
  tabSelectActivators.set(tabBar.select, id => setActiveTab(id, { scrollActiveIntoView: true }));

  return activeTabId;
}

/**
 * Create a DOM fragment with a graceful fallback for test environments.
 *
 * @param {Document} document Active document instance.
 * @returns {{ appendChild: Function }} Fragment-like node.
 */
function createFragment(document) {
  if (document && typeof document.createDocumentFragment === 'function') {
    return document.createDocumentFragment();
  }
  const nodes = [];
  return {
    childNodes: nodes,
    appendChild(node) {
      nodes.push(node);
      return node;
    }
  };
}

export const __test__ = {
  createFragment,
  SCROLL_PIN_TOLERANCE_PX,
  capturePreviousActivePanelScroll,
  applyActivePanelScroll,
  restoreTabStripScroll,
  readPreviousTabStripScroll,
  createTabSelect,
  createTabBar,
  findPersistentTabBar,
  syncTabSelectOptions,
  uniqueTabSpecs
};
