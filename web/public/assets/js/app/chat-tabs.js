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
 * Render an accessible tab interface within ``container``.
 *
 * @param {{
 *   document: Document,
 *   container: HTMLElement,
 *   tabs: Array<{ id: string, label: string, content: Node|null }>,
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
  const tabList = document.createElement('div');
  tabList.className = 'chat-tablist';
  tabList.setAttribute('role', 'tablist');

  const panelWrapper = document.createElement('div');
  panelWrapper.className = 'chat-tabpanels';

  fragment.appendChild(tabList);
  fragment.appendChild(panelWrapper);

  const tabElements = [];
  const existingActive = container.dataset?.activeTab || null;
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
    button.textContent = tab.label || '';
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

  const setActiveTab = newId => {
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
        if (typeof entry.panel.scrollHeight === 'number' && typeof entry.panel.scrollTop === 'number') {
          entry.panel.scrollTop = entry.panel.scrollHeight;
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

  for (const entry of tabElements) {
    entry.button.addEventListener('click', () => {
      setActiveTab(entry.id);
    });
  }

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
