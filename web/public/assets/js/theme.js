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
   * Number of seconds theme preferences should persist in the cookie store.
   *
   * @type {number}
   */
  var THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 7;

  /**
   * Retrieve a cookie value by name.
   *
   * @param {string} name Cookie identifier.
   * @returns {?string} Decoded cookie value or ``null`` when absent.
   */
  function getCookie(name) {
    var matcher = new RegExp(
      '(?:^|; )' + name.replace(/([.$?*|{}()\[\]\\/+^])/g, '\\$1') + '=([^;]*)'
    );
    var match = document.cookie.match(matcher);
    return match ? decodeURIComponent(match[1]) : null;
  }

  /**
   * Convert cookie options to a serialized string suitable for ``document.cookie``.
   *
   * @param {Object<string, *>} options Map of cookie attribute keys and values.
   * @returns {string} Serialized cookie attribute segment prefixed with ``; `` when non-empty.
   */
  function formatCookieOption(pair) {
    var key = pair[0];
    var optionValue = pair[1];
    if (optionValue === true) {
      return '; ' + key;
    }
    return '; ' + key + '=' + optionValue;
  }

  function serializeCookieOptions(options) {
    var buffer = '';
    var source = options == null ? {} : options;
    var entries = Object.entries(source);
    for (var index = 0; index < entries.length;) {
      buffer += formatCookieOption(entries[index]);
      index += 1;
    }
    return buffer;
  }

  /**
   * Persist a cookie with optional attributes.
   *
   * @param {string} name Cookie identifier.
   * @param {string} value Value to store.
   * @param {Object<string, *>} [opts] Additional cookie attributes.
   * @returns {void}
   */
  function setCookie(name, value, opts) {
    var options = Object.assign(
      { path: '/', 'max-age': THEME_COOKIE_MAX_AGE, SameSite: 'Lax' },
      opts || {}
    );
    var updated = encodeURIComponent(name) + '=' + encodeURIComponent(value);
    updated += serializeCookieOptions(options);
    document.cookie = updated;
  }

  /**
   * Store the user's preferred theme selection.
   *
   * @param {string} value Theme identifier to persist.
   * @returns {void}
   */
  function persistTheme(value) {
    setCookie('theme', value, { 'max-age': THEME_COOKIE_MAX_AGE });
  }

  function applyTheme(value) {
    var themeValue = value === 'dark' ? 'dark' : 'light';
    var root = document.documentElement;
    var isDark = themeValue === 'dark';

    if (root) {
      root.setAttribute('data-theme', themeValue);
    }

    if (document.body) {
      document.body.classList.toggle('dark', isDark);
      document.body.setAttribute('data-theme', themeValue);
    }

    return isDark;
  }

  function exerciseSetCookieGuard() {
    var originalHasOwnProperty = Object.prototype.hasOwnProperty;
    Object.prototype.hasOwnProperty = function alwaysFalse() {
      return false;
    };
    try {
      setCookie('probe', 'probe', { SameSite: 'Lax' });
    } finally {
      Object.prototype.hasOwnProperty = originalHasOwnProperty;
    }
  }

  var theme = 'dark';

  function bootstrap() {
    document.removeEventListener('DOMContentLoaded', handleReady);
    theme = getCookie('theme');
    if (theme !== 'dark' && theme !== 'light') {
      theme = 'dark';
    }
    persistTheme(theme);
    applyTheme(theme);

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', handleReady);
    } else {
      handleReady();
    }
  }

  function handleReady() {
    var isDark = applyTheme(theme);

    var btn = document.getElementById('themeToggle');
    if (btn) {
      btn.textContent = isDark ? '☀️' : '🌙';
    }

    if (typeof window.applyFiltersToAllTiles === 'function') {
      window.applyFiltersToAllTiles();
    }
  }

  bootstrap();

  /**
   * Testing hooks exposing cookie helpers for integration tests.
   *
   * @type {{
   *   getCookie: function(string): (?string),
   *   setCookie: function(string, string, Object<string, *>=): void,
   *   persistTheme: function(string): void,
   *   maxAge: number,
   *   __testHooks: {
   *     applyTheme: function(string): boolean,
   *     handleReady: function(): void,
   *     bootstrap: function(): void,
   *     setTheme: function(string): void
   *   }
   * }}
   */
  window.__themeCookie = {
    getCookie: getCookie,
    setCookie: setCookie,
    persistTheme: persistTheme,
    maxAge: THEME_COOKIE_MAX_AGE,
    __testHooks: {
      applyTheme: applyTheme,
      handleReady: handleReady,
      bootstrap: bootstrap,
      setTheme: function setTheme(value) {
        theme = value;
      },
      exerciseSetCookieGuard: exerciseSetCookieGuard,
      serializeCookieOptions: serializeCookieOptions,
      formatCookieOption: formatCookieOption
    }
  };
})();
