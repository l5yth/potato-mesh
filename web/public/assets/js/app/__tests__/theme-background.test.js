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

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

import { createDomEnvironment } from './dom-environment.js';

const themeModuleUrl = new URL('../../theme.js', import.meta.url);
const backgroundModuleUrl = new URL('../../background.js', import.meta.url);
const themeSource = await readFile(themeModuleUrl, 'utf8');
const backgroundSource = await readFile(backgroundModuleUrl, 'utf8');

/**
 * Evaluate a browser-oriented script within the provided DOM environment.
 *
 * @param {string} source Module source code to execute.
 * @param {URL} url Identifier for the executed script.
 * @param {ReturnType<typeof createDomEnvironment>} env Active DOM harness.
 * @returns {void}
 */
function executeInDom(source, url, env) {
  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval
  });
  context.window = env.window;
  context.document = env.document;
  context.global = context;
  context.globalThis = context;
  context.window.window = context.window;
  context.window.document = context.document;
  context.window.globalThis = context;
  context.window.console = console;

  vm.runInContext(source, context, { filename: url.pathname, displayErrors: true });
}

test('theme and background modules behave correctly across scenarios', async t => {
  const env = createDomEnvironment({ readyState: 'complete', cookie: '' });
  try {
    const toggle = env.createElement('button', 'themeToggle');
    env.registerElement('themeToggle', toggle);
    let filterInvocations = 0;
    env.window.applyFiltersToAllTiles = () => {
      filterInvocations += 1;
    };

    executeInDom(themeSource, themeModuleUrl, env);
    executeInDom(backgroundSource, backgroundModuleUrl, env);

    const themeHelpers = env.window.__themeCookie;
    const themeHooks = themeHelpers.__testHooks;
    const backgroundHelpers = env.window.__potatoBackground;
    const backgroundHooks = backgroundHelpers.__testHooks;

    await t.test('initialises with a dark theme and persists cookies', () => {
      assert.equal(env.document.documentElement.getAttribute('data-theme'), 'dark');
      assert.equal(env.document.body.classList.contains('dark'), true);
      assert.equal(toggle.textContent, '☀️');
      themeHelpers.persistTheme('light');
      themeHelpers.setCookie('bare', '1');
      themeHooks.exerciseSetCookieGuard();
      themeHelpers.setCookie('flag', 'true', { Secure: true });
      const cookieString = env.getCookieString();
      assert.equal(themeHelpers.getCookie('flag'), 'true');
      assert.equal(themeHelpers.getCookie('missing'), null);
      assert.match(cookieString, /theme=light/);
      assert.match(cookieString, /; path=\//);
      assert.match(cookieString, /; SameSite=Lax/);
      assert.match(cookieString, /; Secure/);
    });

    await t.test('serializeCookieOptions covers boolean and string attributes', () => {
      const withAttributes = themeHooks.serializeCookieOptions({ Secure: true, HttpOnly: '1' });
      assert.equal(withAttributes.includes('; Secure'), true);
      assert.equal(withAttributes.includes('; HttpOnly=1'), true);
      const secureOnly = themeHooks.serializeCookieOptions({ Secure: true });
      assert.equal(secureOnly.trim(), '; Secure');
      assert.equal(themeHooks.formatCookieOption(['HttpOnly', '1']), '; HttpOnly=1');
      assert.equal(themeHooks.formatCookieOption(['Secure', true]), '; Secure');
      assert.equal(themeHooks.serializeCookieOptions({}), '');
      assert.equal(themeHooks.serializeCookieOptions(), '');
    });

    await t.test('re-bootstrap handles DOMContentLoaded flow and filter hooks', () => {
      env.document.readyState = 'loading';
      filterInvocations = 0;
      env.setCookieString('theme=light');
      themeHooks.bootstrap();
      env.triggerDOMContentLoaded();
      assert.equal(env.document.documentElement.getAttribute('data-theme'), 'light');
      assert.equal(env.document.body.classList.contains('dark'), false);
      assert.equal(toggle.textContent, '🌙');
      assert.equal(filterInvocations, 1);
      env.document.removeEventListener('DOMContentLoaded', themeHooks.handleReady);
    });

    await t.test('handleReady tolerates missing toggle button', () => {
      env.registerElement('themeToggle', null);
      themeHooks.handleReady();
      env.registerElement('themeToggle', toggle);
    });

    await t.test('applyTheme copes with absent DOM nodes', () => {
      const originalBody = env.document.body;
      const originalRoot = env.document.documentElement;
      env.document.body = null;
      env.document.documentElement = null;
      assert.equal(themeHooks.applyTheme('dark'), true);
      env.document.body = originalBody;
      env.document.documentElement = originalRoot;
      assert.equal(themeHooks.applyTheme('light'), false);
    });

    await t.test('background bootstrap waits for DOM readiness', () => {
      env.setComputedStyleImplementation(() => ({ getPropertyValue: () => '  rgb(15, 15, 15)  ' }));
      env.document.readyState = 'loading';
      const previousColor = env.document.documentElement.style.backgroundColor;
      backgroundHooks.bootstrap();
      assert.equal(env.document.documentElement.style.backgroundColor, previousColor);
      env.triggerDOMContentLoaded();
      assert.equal(env.document.documentElement.style.backgroundColor.trim(), 'rgb(15, 15, 15)');
    });

    await t.test('background falls back to theme defaults when styles unavailable', () => {
      env.setComputedStyleImplementation(() => {
        throw new Error('no styles');
      });
      env.document.body.classList.add('dark');
      backgroundHelpers.applyBackground();
      assert.equal(env.document.documentElement.style.backgroundColor, '#0e1418');
      env.document.body.classList.remove('dark');
      backgroundHelpers.applyBackground();
      assert.equal(env.document.documentElement.style.backgroundColor, '#f6f3ee');
    });

    await t.test('background helper tolerates missing body elements', () => {
      const originalBody = env.document.body;
      env.document.body = null;
      backgroundHelpers.applyBackground();
      assert.equal(backgroundHelpers.resolveBackgroundColor(), null);
      env.document.body = originalBody;
    });

    await t.test('theme changes trigger background updates', () => {
      env.document.body.classList.remove('dark');
      themeHooks.setTheme('light');
      backgroundHooks.init();
      env.dispatchWindowEvent('themechange');
      assert.equal(env.document.documentElement.style.backgroundColor, '#f6f3ee');
    });

    env.window.removeEventListener('themechange', backgroundHelpers.applyBackground);
  } finally {
    env.cleanup();
  }
});

test('dom environment helpers mimic expected DOM behaviour', () => {
  const env = createDomEnvironment({ readyState: 'interactive', includeBody: false });
  try {
    const element = env.createElement('span');
    element.classList.add('foo');
    assert.equal(element.classList.contains('foo'), true);
    assert.equal(element.classList.toggle('foo'), false);
    assert.equal(element.classList.toggle('bar'), true);
    assert.equal(element.getAttribute('id'), null);
    element.setAttribute('data-test', 'ok');
    assert.equal(element.getAttribute('data-test'), 'ok');

    env.registerElement('sample', element);
    assert.equal(env.document.getElementById('sample'), element);
    assert.equal(env.document.querySelector('.missing'), null);

    let docEventFired = false;
    env.document.addEventListener('custom', () => {
      docEventFired = true;
    });
    env.document.dispatchEvent('custom');
    assert.equal(docEventFired, true);
    env.document.removeEventListener('custom');

    let winEventFired = false;
    env.window.addEventListener('global', () => {
      winEventFired = true;
    });
    env.window.dispatchEvent('global');
    assert.equal(winEventFired, true);
    env.window.removeEventListener('global');

    env.setCookieString('');
    env.document.cookie = 'foo=bar';
    assert.equal(env.getCookieString(), 'foo=bar');
  } finally {
    env.cleanup();
  }
});
