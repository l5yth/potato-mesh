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
    for (var k in options) {
      if (!Object.prototype.hasOwnProperty.call(options, k)) continue;
      updated += '; ' + k + (options[k] === true ? '' : '=' + options[k]);
    }
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

  var theme = getCookie('theme');
  if (theme !== 'dark' && theme !== 'light') {
    theme = 'dark';
  }
  persistTheme(theme);

  applyTheme(theme);

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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', handleReady);
  } else {
    handleReady();
  }

  /**
   * Testing hooks exposing cookie helpers for integration tests.
   *
   * @type {{
   *   getCookie: function(string): (?string),
   *   setCookie: function(string, string, Object<string, *>=): void,
   *   persistTheme: function(string): void,
   *   maxAge: number
   * }}
   */
  window.__themeCookie = {
    getCookie: getCookie,
    setCookie: setCookie,
    persistTheme: persistTheme,
    maxAge: THEME_COOKIE_MAX_AGE
  };
})();
