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

  // Wrapper holds the scroll buttons + the tab list so the border-bottom
  // spans the full width including the arrow buttons.
  const tabListWrapper = document.createElement('div');
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
  const tabSelect = document.createElement('select');
  tabSelect.className = 'chat-tab-select';
  tabSelect.setAttribute('aria-label', 'Jump to channel');

  const tabList = document.createElement('div');
  tabList.className = 'chat-tablist';
  tabList.setAttribute('role', 'tablist');

  tabListWrapper.appendChild(prevBtn);
  tabListWrapper.appendChild(tabList);
  tabListWrapper.appendChild(nextBtn);
  tabListWrapper.appendChild(tabSelect);

  const panelWrapper = document.createElement('div');
  panelWrapper.className = 'chat-tabpanels';

  fragment.appendChild(tabListWrapper);
  fragment.appendChild(panelWrapper);

  const tabElements = [];
  const existingActive = container.dataset?.activeTab || null;
  // Preserve the channel-tab list's horizontal scroll across the full-subtree
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
    const option = document.createElement('option');
    option.value = uniqueId;
    option.textContent = tab.label || uniqueId;
    tabSelect.appendChild(option);
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

  if (typeof container.replaceChildren === 'function') {
    container.replaceChildren(fragment);
  } else {
    container.innerHTML = '';
    container.appendChild(fragment);
  }

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
    // the entire DOM subtree on each call, so the previous tabList element is
    // detached and the observer will not fire again after that point.
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

  // Initial arrow state after the DOM is in place.
  updateArrows();

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
        tabSelect.value = newId;
        if (typeof entry.panel.scrollHeight === 'number' && typeof entry.panel.scrollTop === 'number') {
          entry.panel.scrollTop = entry.panel.scrollHeight;
        }
        // Scroll the active tab button into view within the overflow tab list,
        // but only on an explicit user tab switch (item 5): a passive re-render
        // keeps the user's current horizontal scroll instead of yanking it.
        if (scrollActiveIntoView && typeof entry.button.scrollIntoView === 'function') {
          entry.button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
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

  // Restore the horizontal scroll captured before the rebuild so a live
  // refresh does not reset the channel-tab list to the first tab (item 5).
  // Applied after setActiveTab, which no longer force-scrolls on a passive
  // render, so the restored position is authoritative.
  if (previousScrollLeft > 0 && typeof tabList.scrollLeft === 'number') {
    tabList.scrollLeft = previousScrollLeft;
    updateArrows();
  }

  for (const entry of tabElements) {
    entry.button.addEventListener('click', () => {
      setActiveTab(entry.id, { scrollActiveIntoView: true });
    });
  }

  // Jump to the chosen channel when the dropdown selection changes (LV8).
  tabSelect.addEventListener('change', () => {
    setActiveTab(tabSelect.value, { scrollActiveIntoView: true });
  });

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

export const __test__ = { createFragment };
