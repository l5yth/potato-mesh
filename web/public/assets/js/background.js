(function () {
  function xmur3(str) {
    var h = 1779033703 ^ str.length;
    for (var i = 0; i < str.length; i += 1) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return function () {
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      return (h ^ (h >>> 16)) >>> 0;
    };
  }

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      var t = Math.imul(a ^ (a >>> 15), a | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function genBackground(theme) {
    var seedInput = location.hostname + '::' + theme;
    var seed = xmur3(seedInput)();
    var rnd = mulberry32(seed);
    var width = 1400;
    var height = 900;
    var canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    var ctx = canvas.getContext('2d');

    var gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, theme === 'dark' ? '#171F2A' : '#f9f3ec');
    gradient.addColorStop(1, theme === 'dark' ? '#10161D' : '#ebe3dd');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    for (var i = 0; i < 120; i += 1) {
      var x = Math.floor(rnd() * width);
      var y = Math.floor(rnd() * height);
      var radius = Math.floor(rnd() * 160) + 40;
      var radial = ctx.createRadialGradient(x, y, 0, x, y, radius);
      radial.addColorStop(0, theme === 'dark' ? 'rgba(34,60,99,0.45)' : 'rgba(255,255,255,0.75)');
      radial.addColorStop(1, 'rgba(255,255,255,0.0)');
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = radial;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2, false);
      ctx.fill();
    }

    ctx.globalAlpha = 1;
    var overlay = ctx.createLinearGradient(0, 0, width, 0);
    overlay.addColorStop(0, theme === 'dark' ? 'rgba(13,26,46,0.45)' : 'rgba(255,255,255,0.35)');
    overlay.addColorStop(1, theme === 'dark' ? 'rgba(13,26,46,0.1)' : 'rgba(255,255,255,0.1)');
    ctx.fillStyle = overlay;
    ctx.fillRect(0, 0, width, height);

    var gridSize = 140;
    ctx.globalAlpha = theme === 'dark' ? 0.14 : 0.12;
    ctx.lineWidth = 1;
    ctx.strokeStyle = theme === 'dark' ? '#24344a' : '#d6cfc4';

    for (var gx = 0; gx <= width; gx += gridSize) {
      ctx.beginPath();
      ctx.moveTo(gx, 0);
      ctx.lineTo(gx, height);
      ctx.stroke();
    }
    for (var gy = 0; gy <= height; gy += gridSize) {
      ctx.beginPath();
      ctx.moveTo(0, gy);
      ctx.lineTo(width, gy);
      ctx.stroke();
    }

    var radial = ctx.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, Math.max(width, height));
    radial.addColorStop(0, 'rgba(255,255,255,0)');
    radial.addColorStop(1, 'rgba(255,255,255,0.22)');
    ctx.globalAlpha = 1;
    ctx.fillStyle = radial;
    ctx.fillRect(0, 0, width, height);

    var url = canvas.toDataURL('image/png');
    document.documentElement.style.setProperty('--bg-image', 'url(' + url + ')');
  }

  function currentTheme() {
    return document.body.classList.contains('dark') ? 'dark' : 'light';
  }

  document.addEventListener('DOMContentLoaded', function () {
    genBackground(currentTheme());
  });

  window.addEventListener('themechange', function (event) {
    var theme = (event.detail && event.detail.theme) || currentTheme();
    genBackground(theme);
  });
})();
