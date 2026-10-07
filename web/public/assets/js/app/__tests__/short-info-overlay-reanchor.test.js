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

/**
 * A re-anchored overlay still receives answers addressed to its old anchor
 * (#881). A badge's details fetch captures the badge element; when a live
 * refresh rebuilds the badge's row, the overlay moves to the new badge
 * (LD-A3 pattern), and the answer must land there instead of leaving the
 * overlay at "Loading…".
 *
 * @module app/__tests__/short-info-overlay-reanchor
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createLiveDocument } from './live-dom-model.js';
import { createShortInfoOverlayStack } from '../short-info-overlay-manager.js';

/**
 * An overlay stack over a live document, with two badges in the body.
 *
 * @returns {Object} Handles: stack, body, badges `a` and `b`, `overlays()`.
 */
function stackWithBadges() {
  const live = createLiveDocument();
  live.window.requestAnimationFrame = callback => callback();
  const stack = createShortInfoOverlayStack({ document: live.document, window: live.window, template: null });
  /**
   * Append a fresh badge to the body.
   *
   * @returns {Object} The badge element.
   */
  const badge = () => {
    const span = live.document.createElement('span');
    live.body.appendChild(span);
    return span;
  };
  return {
    stack,
    a: badge(),
    b: badge(),
    badge,
    overlays: () => live.body.querySelectorAll('.short-info-overlay'),
  };
}

test('a request made before a reanchor still lands on the moved overlay', () => {
  const { stack, a, b, overlays } = stackWithBadges();
  stack.render(a, 'Loading…');
  const token = stack.incrementRequestToken(a);
  assert.equal(stack.reanchor(a, b), true);
  a.remove();

  assert.equal(stack.isTokenCurrent(a, token), true, 'the old anchor still answers for its request');
  stack.render(a, 'Details');
  assert.equal(overlays().length, 1, 'no second overlay on the detached badge');
  assert.equal(overlays()[0].querySelector('.short-info-content').textContent, 'Details');
  assert.equal(stack.isOpen(a), false, 'isOpen answers for the anchor hosting the overlay now');
  assert.equal(stack.isOpen(b), true);
});

test('replacements chain, and an anchor moved back resolves to itself', () => {
  const { stack, a, b, badge, overlays } = stackWithBadges();
  const c = badge();
  stack.render(a, 'one');
  stack.reanchor(a, b);
  stack.reanchor(b, c);
  stack.render(a, 'two');
  assert.equal(overlays().length, 1);
  assert.ok(stack.getOpenOverlays()[0].anchor === c, 'two hops land on the current badge');

  stack.reanchor(c, a);
  stack.render(c, 'three');
  stack.render(a, 'four');
  assert.equal(overlays().length, 1, 'moving back leaves no loop and no duplicate');
  assert.ok(stack.getOpenOverlays()[0].anchor === a);
  assert.equal(overlays()[0].querySelector('.short-info-content').textContent, 'four');
});

test('the overlay\'s own close button still closes it after a reanchor', () => {
  const { stack, a, b, overlays } = stackWithBadges();
  stack.render(a, 'Details');
  stack.reanchor(a, b);
  a.remove();
  overlays()[0].querySelector('.short-info-close').click();
  assert.equal(overlays().length, 0, 'the × closes the overlay it sits in');
  assert.equal(stack.isOpen(b), false);
});

test('a closed overlay is not revived by a stale token', () => {
  const { stack, a, b, overlays } = stackWithBadges();
  stack.render(a, 'Loading…');
  const token = stack.incrementRequestToken(a);
  stack.reanchor(a, b);
  stack.close(b);
  assert.equal(stack.isTokenCurrent(a, token), false);
  assert.equal(overlays().length, 0);
});
