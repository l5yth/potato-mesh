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
 * Slack (px) within which the active panel counts as scrolled to the bottom.
 * A reader inside this band is treated as "pinned" and kept pinned across a
 * passive re-render (tail-follow); anyone scrolled further up keeps their exact
 * position. Small enough to ignore sub-pixel rounding, large enough to survive a
 * one-line layout jitter.
 * @type {number}
 */
const SCROLL_PIN_TOLERANCE_PX = 4;

/**
 * Capture the active panel's vertical scroll state before the subtree rebuild,
 * so a passive re-render can restore it instead of yanking the reader to the
 * bottom on every live update (bugfix B). ``renderChatTabs`` replaces the whole
 * panel subtree, so the post-render panel is a fresh element with ``scrollTop``
 * 0; without this capture the reader's position is lost on every refresh.
 *
 * @param {HTMLElement} container Chat container holding the *previous* render.
 * @returns {?{ top: number, pinned: boolean }} The active panel's scroll offset
 *   and whether it was at the bottom, or ``null`` when there is no prior panel
 *   (initial render) — in which case the caller pins to the bottom.
 */
function capturePreviousActivePanelScroll(container) {
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
 * Apply the captured vertical scroll to the freshly-rendered active panel.
 * A reader that was pinned to the bottom (or an initial render with no prior
 * panel, ``previous == null``) is scrolled to the new bottom so freshly-arrived
 * entries stay visible (tail-follow); otherwise the reader's exact offset is
 * restored (bugfix B).
 *
 * @param {?HTMLElement} panel The active panel after the rebuild.
 * @param {?{ top: number, pinned: boolean }} previous Captured scroll state.
 * @returns {void}
 */
function applyActivePanelScroll(panel, previous) {
  if (!panel) {
    return;
  }
  if (!previous || previous.pinned) {
    panel.scrollTop = panel.scrollHeight;
  } else {
    panel.scrollTop = previous.top;
  }
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
 * Find the tab bar a previous render built, so a re-render can keep its
 * channel select in the document. A native select whose picker is open loses
 * the pick when the element is removed (the picker closes, or commits to the
 * detached element), and at ≤ 900 px it is the only channel control (UX11), so
 * a passive refresh must never remove it (#882).
 *
 * @param {HTMLElement} container Chat container holding the previous render.
 * @returns {?{ wrapper: HTMLElement, select: HTMLSelectElement, panelWrapper: HTMLElement }}
 *   The live tab bar, its select and the panel wrapper, or ``null`` when there
 *   is none to reuse (initial render, emptied tabs, or foreign markup).
 */
function findPersistentTabBar(container) {
  const [wrapper, panelWrapper] = container.children || [];
  const select = wrapper && wrapper.children ? wrapper.children[3] : null;
  // Only a select this module created and activated counts, and swapping the
  // rebuilt parts in needs ``replaceChild`` (absent from some test mocks).
  if (!panelWrapper || !tabSelectActivators.has(select) || typeof container.replaceChild !== 'function') {
    return null;
  }
  return { wrapper, select, panelWrapper };
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
 * not available.
 *
 * The tab bar wrapper and its channel ``<select>`` (LV8) are built on the
 * first call and stay in the document on later calls (#882): a re-render
 * swaps a freshly built tab strip, scroll buttons and panels in around the
 * select, so a native picker the user has open survives a live refresh.
 *
 * @param {{
 *   document: Document,
 *   container: HTMLElement,
 *   tabs: Array<{ id: string, label: string, iconSrc?: string|null, content: Node|null }>,
 *   previousActiveTabId?: string|null,
 *   defaultActiveTabId?: string|null
 * }} options Rendering parameters.
 * @returns {?string} Identifier of the active tab after rendering.
 */
export function renderChatTabs({
  document,
  container,
  tabs,
  previousActiveTabId = null,
  defaultActiveTabId = null
}) {
  if (!container || !document) {
    return null;
  }
  const validTabs = Array.isArray(tabs) ? tabs.filter(Boolean) : [];
  if (validTabs.length === 0) {
    if (typeof container.replaceChildren === 'function') {
      container.replaceChildren();
    } else {
      container.innerHTML = '';
    }
    container.dataset.activeTab = '';
    return null;
  }

  const fragment = createFragment(document);
  // Reuse the live tab bar when a previous render left one (#882).
  const persistentTabBar = findPersistentTabBar(container);

  // Wrapper holds the scroll buttons + the tab list so the border-bottom
  // spans the full width including the arrow buttons.
  const tabListWrapper = persistentTabBar ? persistentTabBar.wrapper : document.createElement('div');
  tabListWrapper.className = 'chat-tablist-wrapper';

  const prevBtn = document.createElement('button');
  prevBtn.type = 'button';
  prevBtn.className = 'chat-tab-scroll-btn chat-tab-scroll-btn--prev';
  prevBtn.setAttribute('aria-hidden', 'true');
  prevBtn.setAttribute('tabindex', '-1');
  prevBtn.textContent = '◀';
  prevBtn.hidden = true;

  const nextBtn = document.createElement('button');
  nextBtn.type = 'button';
  nextBtn.className = 'chat-tab-scroll-btn chat-tab-scroll-btn--next';
  nextBtn.setAttribute('aria-hidden', 'true');
  nextBtn.setAttribute('tabindex', '-1');
  nextBtn.textContent = '▶';
  nextBtn.hidden = true;

  // Channel dropdown selector (LV8): a native <select> listing every tab so
  // the user can jump to a channel regardless of the horizontal scroll
  // position (the native control supplies the downward-triangle affordance).
  // Built once, then reused, so it never leaves the document (#882).
  const tabSelect = persistentTabBar ? persistentTabBar.select : createTabSelect(document);
  const selectOptions = [];

  const tabList = document.createElement('div');
  tabList.className = 'chat-tablist';
  tabList.setAttribute('role', 'tablist');

  const panelWrapper = document.createElement('div');
  panelWrapper.className = 'chat-tabpanels';

  if (!persistentTabBar) {
    // Initial render: assemble the bar in the fragment. A re-render swaps the
    // rebuilt parts into the live bar instead (see below).
    tabListWrapper.appendChild(prevBtn);
    tabListWrapper.appendChild(tabList);
    tabListWrapper.appendChild(nextBtn);
    tabListWrapper.appendChild(tabSelect);
    fragment.appendChild(tabListWrapper);
    fragment.appendChild(panelWrapper);
  }

  const tabElements = [];
  const existingActive = container.dataset?.activeTab || null;
  // Preserve the channel-tab list's horizontal scroll across the tab-list
  // rebuild below (item 5): without this, every live refresh resets scrollLeft
  // to 0 and yanks the user back to the first tab. The previous render's tab
  // list is the second child of the first wrapper (see the structure built
  // below); guard defensively in case the container held no prior tab list.
  const previousTabListWrapper = container.children && container.children[0];
  const previousTabList =
    previousTabListWrapper && previousTabListWrapper.children
      ? previousTabListWrapper.children[1]
      : null;
  const previousScrollLeft =
    previousTabList &&
    previousTabList.className === 'chat-tablist' &&
    typeof previousTabList.scrollLeft === 'number'
      ? previousTabList.scrollLeft
      : 0;
  // Capture the active panel's VERTICAL scroll before the rebuild so a passive
  // refresh restores it rather than snapping the reader to the bottom (bugfix B).
  const previousActivePanelScroll = capturePreviousActivePanelScroll(container);
  const activeCandidateOrder = [existingActive, previousActiveTabId, defaultActiveTabId];
  let activeTabId = null;

  const idSet = new Set();
  for (const tab of validTabs) {
    if (!tab || typeof tab.id !== 'string' || tab.id.length === 0) {
      continue;
    }
    const uniqueId = tab.id;
    if (idSet.has(uniqueId)) {
      continue;
    }
    idSet.add(uniqueId);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chat-tab';
    button.classList.add('chat-tab');
    button.setAttribute('role', 'tab');
    button.setAttribute('id', `chat-tab-${uniqueId}`);
    button.dataset.tabId = uniqueId;
    if (tab.iconSrc) {
      const icon = document.createElement('img');
      icon.setAttribute('src', tab.iconSrc);
      icon.setAttribute('alt', '');
      icon.setAttribute('width', '12');
      icon.setAttribute('height', '12');
      icon.setAttribute('aria-hidden', 'true');
      icon.setAttribute('loading', 'lazy');
      icon.setAttribute('decoding', 'async');
      icon.className = 'protocol-icon';
      button.appendChild(icon);
      button.appendChild(document.createTextNode(tab.label || ''));
    } else {
      button.textContent = tab.label || '';
    }
    button.setAttribute('aria-selected', 'false');
    button.setAttribute('tabindex', '-1');

    const panel = document.createElement('div');
    panel.className = 'chat-tabpanel';
    panel.classList.add('chat-tabpanel');
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('id', `chat-panel-${uniqueId}`);
    panel.setAttribute('aria-labelledby', button.getAttribute('id'));
    panel.hidden = true;

    if (tab.content) {
      panel.appendChild(tab.content);
    }

    tabList.appendChild(button);
    panelWrapper.appendChild(panel);
    selectOptions.push({ id: uniqueId, label: tab.label || uniqueId });
    tabElements.push({ id: uniqueId, button, panel });
  }

  if (tabElements.length === 0) {
    if (typeof container.replaceChildren === 'function') {
      container.replaceChildren();
    } else {
      container.innerHTML = '';
    }
    container.dataset.activeTab = '';
    return null;
  }

  for (const candidate of activeCandidateOrder) {
    if (candidate && tabElements.some(entry => entry.id === candidate)) {
      activeTabId = candidate;
      break;
    }
  }
  if (!activeTabId) {
    activeTabId = tabElements[0].id;
  }

  if (persistentTabBar) {
    // Swap the rebuilt strip, arrows and panels into the live bar around the
    // select, which never leaves the document (#882).
    const [oldPrevBtn, oldTabList, oldNextBtn] = tabListWrapper.children;
    tabListWrapper.replaceChild(prevBtn, oldPrevBtn);
    tabListWrapper.replaceChild(tabList, oldTabList);
    tabListWrapper.replaceChild(nextBtn, oldNextBtn);
    container.replaceChild(panelWrapper, persistentTabBar.panelWrapper);
  } else if (typeof container.replaceChildren === 'function') {
    container.replaceChildren(fragment);
  } else {
    container.innerHTML = '';
    container.appendChild(fragment);
  }
  syncTabSelectOptions(document, tabSelect, selectOptions);

  /**
   * Refresh the hidden state of the scroll arrow buttons based on the
   * current scroll position of the tab list.
   */
  const updateArrows = () => {
    const scrollLeft = tabList.scrollLeft || 0;
    const clientWidth = tabList.clientWidth || 0;
    const scrollWidth = tabList.scrollWidth || 0;
    prevBtn.hidden = scrollLeft <= 0;
    // Allow 1 px rounding tolerance.
    nextBtn.hidden = scrollLeft + clientWidth >= scrollWidth - 1;
  };

  // Recalculate arrow visibility on scroll and on container resize.
  if (typeof tabList.addEventListener === 'function') {
    tabList.addEventListener('scroll', updateArrows);
  }
  if (typeof globalThis !== 'undefined' && typeof globalThis.ResizeObserver === 'function') {
    // The observer is intentionally not disconnected: renderChatTabs replaces
    // the tab list on each call (only the bar wrapper and its select persist,
    // #882), so the previous tabList element is detached and the observer will
    // not fire again after that point.
    const ro = new globalThis.ResizeObserver(updateArrows);
    ro.observe(tabList);
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

  const setActiveTab = (newId, { scrollActiveIntoView = false } = {}) => {
    if (!newId) return;
    let matched = false;
    for (const entry of tabElements) {
      const isActive = entry.id === newId;
      entry.button.setAttribute('aria-selected', isActive ? 'true' : 'false');
      entry.button.setAttribute('tabindex', isActive ? '0' : '-1');
      if (isActive) {
        entry.button.classList.add('is-active');
        entry.panel.hidden = false;
        matched = true;
        container.dataset.activeTab = newId;
        // Write only on a change, so an idle re-render leaves an open picker alone (#882).
        if (tabSelect.value !== newId) {
          tabSelect.value = newId;
        }
        // An explicit tab switch (click / dropdown) jumps to the newest entry and
        // scrolls the chosen tab into view. A passive re-render does NEITHER: the
        // reader's vertical scroll is restored by the caller below, and the
        // horizontal tab scroll is left untouched (bugfix B / LD-A2).
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

  // Restore the active panel's vertical scroll captured before the rebuild: a
  // reader pinned to the bottom stays pinned (tail-follow), anyone scrolled up
  // keeps their place, and an initial render (no prior panel) pins to the
  // bottom so the newest entries show (bugfix B).
  // ``activeTabId`` is always one of ``tabElements`` (chosen from them above), so
  // the entry resolves; ``applyActivePanelScroll`` still guards a missing panel.
  const restoredActiveEntry = tabElements.find(entry => entry.id === activeTabId);
  applyActivePanelScroll(restoredActiveEntry.panel, previousActivePanelScroll);

  // Restore the horizontal scroll captured before the rebuild so a live
  // refresh does not reset the channel-tab list to the first tab (item 5).
  // Applied after setActiveTab, which no longer force-scrolls on a passive
  // render, so the restored position is authoritative.
  if (previousScrollLeft > 0 && typeof tabList.scrollLeft === 'number') {
    tabList.scrollLeft = previousScrollLeft;
  }

  // Single arrow-visibility pass, after every structural + scroll write above.
  // Reading the tab list geometry here — rather than also right after the subtree
  // rebuild, before setActiveTab un-hides the active panel — collapses a live
  // refresh from multiple forced synchronous reflows to one: the earlier read's
  // layout was thrown away by the un-hide anyway (frontend perf: the chat-tabs
  // `refresh` forced-reflow hotspot).
  updateArrows();

  for (const entry of tabElements) {
    entry.button.addEventListener('click', () => {
      setActiveTab(entry.id, { scrollActiveIntoView: true });
    });
  }

  // Jump to the chosen channel when the dropdown selection changes (LV8). The
  // select's one listener was bound at creation; point it at this render (#882).
  tabSelectActivators.set(tabSelect, id => setActiveTab(id, { scrollActiveIntoView: true }));

  return container.dataset.activeTab || null;
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
  createTabSelect,
  findPersistentTabBar,
  syncTabSelectOptions
};
