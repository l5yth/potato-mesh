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
  'use strict';

  /**
   * Resolve the background colour that should be applied to the document.
   *
   * @returns {?string} CSS colour string or ``null`` if resolution fails.
   */
  function resolveBackgroundColor() {
    if (!document.body) {
      return null;
    }

    var color = '';
    try {
      var styles = window.getComputedStyle(document.body);
      if (styles) {
        color = styles.getPropertyValue('--bg');
        if (color) {
          color = color.trim();
        }
      }
    } catch (err) {
      color = '';
    }

    if (!color) {
      color = document.body.classList.contains('dark') ? '#0e1418' : '#f6f3ee';
    }

    return color;
  }

  /**
   * Apply the resolved background colour to the page root elements.
   *
   * @returns {void}
   */
  function applyBackground() {
    var color = resolveBackgroundColor();
    if (!color) {
      return;
    }

    document.documentElement.style.backgroundColor = color;
    document.documentElement.style.backgroundImage = 'none';
    document.body.style.backgroundColor = color;
    document.body.style.backgroundImage = 'none';
  }

  /**
   * Initialize the background helper once the DOM is ready.
   *
   * @returns {void}
   */
  function init() {
    applyBackground();
  }

  function bootstrap() {
    document.removeEventListener('DOMContentLoaded', init);
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }

  bootstrap();

  window.addEventListener('themechange', applyBackground);

  /**
   * Testing hooks exposing background helpers.
   *
   * @type {{
   *   applyBackground: function(): void,
   *   resolveBackgroundColor: function(): (?string),
   *   __testHooks: {
   *     bootstrap: function(): void,
   *     init: function(): void
   *   }
   * }}
   */
  window.__potatoBackground = {
    applyBackground: applyBackground,
    resolveBackgroundColor: resolveBackgroundColor,
    __testHooks: {
      bootstrap: bootstrap,
      init: init
    }
  };
})();
