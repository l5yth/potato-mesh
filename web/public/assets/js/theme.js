(function () {
  var THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 7;

  function getCookie(name) {
    var matcher = new RegExp(
      '(?:^|; )' + name.replace(/([.$?*|{}()\[\]\\/+^])/g, '\\$1') + '=([^;]*)'
    );
    var match = document.cookie.match(matcher);
    return match ? decodeURIComponent(match[1]) : null;
  }

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

  function persistTheme(value) {
    setCookie('theme', value, { 'max-age': THEME_COOKIE_MAX_AGE });
  }

  var theme = getCookie('theme');
  if (theme !== 'dark' && theme !== 'light') {
    theme = 'dark';
  }
  persistTheme(theme);

  document.addEventListener('DOMContentLoaded', function () {
    if (theme === 'dark') {
      document.body.classList.add('dark');
    } else {
      document.body.classList.remove('dark');
    }

    var btn = document.getElementById('themeToggle');
    if (btn) {
      btn.textContent = document.body.classList.contains('dark') ? '☀️' : '🌙';
    }

    if (typeof window.applyFiltersToAllTiles === 'function') {
      window.applyFiltersToAllTiles();
    }
  });

  window.__themeCookie = {
    getCookie: getCookie,
    setCookie: setCookie,
    persistTheme: persistTheme,
    maxAge: THEME_COOKIE_MAX_AGE
  };
})();
