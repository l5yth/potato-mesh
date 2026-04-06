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

(function () {
  /**
   * Apply the dark theme to the root HTML and body elements.
   *
   * @returns {void}
   */
  function applyTheme() {
    var root = document.documentElement;
    if (root) {
      root.setAttribute('data-theme', 'dark');
    }

    if (document.body) {
      document.body.classList.add('dark');
      document.body.setAttribute('data-theme', 'dark');
    }
  }

  /**
   * Initialise theme state on page load and register the ready handler.
   *
   * @returns {void}
   */
  function bootstrap() {
    document.removeEventListener('DOMContentLoaded', handleReady);
    applyTheme();

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', handleReady);
    } else {
      handleReady();
    }
  }

  /**
   * Update UI elements once the DOM is ready.
   *
   * @returns {void}
   */
  function handleReady() {
    applyTheme();

    if (typeof window.applyFiltersToAllTiles === 'function') {
      window.applyFiltersToAllTiles();
    }
  }

  bootstrap();

  /**
   * Testing hooks exposing internal helpers for integration tests.
   *
   * @type {{
   *   __testHooks: {
   *     applyTheme: function(): void,
   *     handleReady: function(): void,
   *     bootstrap: function(): void
   *   }
   * }}
   */
  window.__themeCookie = {
    __testHooks: {
      applyTheme: applyTheme,
      handleReady: handleReady,
      bootstrap: bootstrap
    }
  };
})();
