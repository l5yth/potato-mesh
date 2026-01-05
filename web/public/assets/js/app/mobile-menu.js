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

const MOBILE_MENU_MEDIA_QUERY = '(max-width: 900px)';
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(', ');

/**
 * Collect the elements that can receive focus within a container.
 *
 * @param {?Element} container DOM node hosting focusable descendants.
 * @returns {Array<Element>} Ordered list of focusable elements.
 */
function resolveFocusableElements(container) {
  if (!container || typeof container.querySelectorAll !== 'function') {
    return [];
  }
  const candidates = Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR));
  return candidates.filter(candidate => {
    if (!candidate || typeof candidate.getAttribute !== 'function') {
      return false;
    }
    return candidate.getAttribute('aria-hidden') !== 'true';
  });
}

/**
 * Build a menu controller for handling toggle state, focus trapping, and
 * responsive layout swapping.
 *
 * @param {{
 *   documentObject?: Document,
 *   windowObject?: Window
 * }} [options]
 * @returns {{
 *   initialize: () => void,
 *   openMenu: () => void,
 *   closeMenu: () => void,
 *   syncLayout: () => void
 * }}
 */
function createMobileMenuController(options = {}) {
  const documentObject = options.documentObject || document;
  const windowObject = options.windowObject || window;
  const menuToggle = documentObject.getElementById('mobileMenuToggle');
  const menu = documentObject.getElementById('mobileMenu');
  const menuPanel = menu ? menu.querySelector('.mobile-menu__panel') : null;
  const closeTriggers = menu ? Array.from(menu.querySelectorAll('[data-mobile-menu-close]')) : [];
  const menuLinks = menu ? Array.from(menu.querySelectorAll('a')) : [];
  const body = documentObject.body;
  const mediaQuery = windowObject.matchMedia
    ? windowObject.matchMedia(MOBILE_MENU_MEDIA_QUERY)
    : null;
  let isOpen = false;
  let lastActive = null;

  /**
   * Toggle the ``aria-expanded`` state on the menu trigger.
   *
   * @param {boolean} expanded Whether the menu is open.
   * @returns {void}
   */
  function setExpandedState(expanded) {
    if (!menuToggle || typeof menuToggle.setAttribute !== 'function') {
      return;
    }
    menuToggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  }

  /**
   * Synchronize the meta row placement based on the active media query.
   *
   * @returns {void}
   */
  function syncLayout() {
    return;
  }

  /**
   * Open the slide-in menu and trap focus within the panel.
   *
   * @returns {void}
   */
  function openMenu() {
    if (!menu || !menuToggle || !menuPanel) {
      return;
    }
    syncLayout();
    menu.hidden = false;
    menu.classList.add('is-open');
    if (body && body.classList) {
      body.classList.add('menu-open');
    }
    setExpandedState(true);
    isOpen = true;
    lastActive = documentObject.activeElement || null;
    const focusables = resolveFocusableElements(menuPanel);
    const focusTarget = focusables[0] || menuPanel;
    if (focusTarget && typeof focusTarget.focus === 'function') {
      focusTarget.focus();
    }
  }

  /**
   * Close the menu and restore focus to the trigger.
   *
   * @returns {void}
   */
  function closeMenu() {
    if (!menu || !menuToggle) {
      return;
    }
    menu.classList.remove('is-open');
    menu.hidden = true;
    if (body && body.classList) {
      body.classList.remove('menu-open');
    }
    setExpandedState(false);
    isOpen = false;
    if (lastActive && typeof lastActive.focus === 'function') {
      lastActive.focus();
    }
  }

  /**
   * Toggle open or closed based on the trigger interaction.
   *
   * @param {Event} event Click event originating from the trigger.
   * @returns {void}
   */
  function handleToggleClick(event) {
    if (event && typeof event.preventDefault === 'function') {
      event.preventDefault();
    }
    if (isOpen) {
      closeMenu();
    } else {
      openMenu();
    }
  }

  /**
   * Trap tab focus within the menu panel while open.
   *
   * @param {KeyboardEvent} event Keydown event from the panel.
   * @returns {void}
   */
  function handleKeydown(event) {
    if (!isOpen || !event) {
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      closeMenu();
      return;
    }
    if (event.key !== 'Tab') {
      return;
    }
    const focusables = resolveFocusableElements(menuPanel);
    if (!focusables.length) {
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = documentObject.activeElement;
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  /**
   * Close the menu when navigation state changes.
   *
   * @returns {void}
   */
  function handleRouteChange() {
    if (isOpen) {
      closeMenu();
    }
  }

  /**
   * Attach event listeners and sync initial layout.
   *
   * @returns {void}
   */
  function initialize() {
    if (!menuToggle || !menu) {
      return;
    }
    menuToggle.addEventListener('click', handleToggleClick);
    closeTriggers.forEach(trigger => {
      trigger.addEventListener('click', closeMenu);
    });
    menuLinks.forEach(link => {
      link.addEventListener('click', closeMenu);
    });
    if (menuPanel && typeof menuPanel.addEventListener === 'function') {
      menuPanel.addEventListener('keydown', handleKeydown);
    }
    if (mediaQuery) {
      if (typeof mediaQuery.addEventListener === 'function') {
        mediaQuery.addEventListener('change', syncLayout);
      } else if (typeof mediaQuery.addListener === 'function') {
        mediaQuery.addListener(syncLayout);
      }
    }
    if (windowObject && typeof windowObject.addEventListener === 'function') {
      windowObject.addEventListener('hashchange', handleRouteChange);
      windowObject.addEventListener('popstate', handleRouteChange);
    }
    syncLayout();
    setExpandedState(false);
  }

  return {
    initialize,
    openMenu,
    closeMenu,
    syncLayout,
  };
}

/**
 * Initialize the mobile menu using the live DOM environment.
 *
 * @param {{
 *   documentObject?: Document,
 *   windowObject?: Window
 * }} [options]
 * @returns {{
 *   initialize: () => void,
 *   openMenu: () => void,
 *   closeMenu: () => void,
 *   syncLayout: () => void
 * }}
 */
export function initializeMobileMenu(options = {}) {
  const controller = createMobileMenuController(options);
  controller.initialize();
  return controller;
}

export const __test__ = {
  createMobileMenuController,
  resolveFocusableElements,
};
