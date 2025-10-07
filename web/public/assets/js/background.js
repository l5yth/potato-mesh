(function () {
  'use strict';

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

  function init() {
    applyBackground();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.addEventListener('themechange', applyBackground);

  window.__potatoBackground = {
    applyBackground: applyBackground,
    resolveBackgroundColor: resolveBackgroundColor
  };
})();
