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
 * Stylesheet checks for the dashboard controls (design review rc3, SPEC
 * CT1-CT3): 44 px touch targets on coarse pointers, one accent focus ring for
 * every button without a ring of its own, and meta-row controls that honour
 * `hidden` in a row whose height is final at first paint.
 *
 * These read the rules, through the shared reader `base-css-rules.js` (SPEC
 * GF7), not the cascade. The rendered half is the browser probe of ACCEPTANCE
 * CT-A5, which also samples every hit box for what it takes from another
 * control or a node row: a mock DOM has no stylesheet, which is how the
 * `hidden` toggles of main-update-counts.test.js passed while the browser
 * painted every toggle. The Leaflet zoom and the mobile-menu links and close
 * are not listed: the map and menu rules size them.
 *
 * @module app/__tests__/controls-css
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { declarationsFor } from './base-css-rules.js';

/** The touch-target block. */
const COARSE = { media: '(pointer: coarse)' };

/** The phone layout. */
const PHONE = { media: '(max-width: 659px)' };

/** Standalone controls that grow to 44 x 44 px on coarse pointers. */
const GROWN_SQUARE = ['.icon-button:not(.mobile-menu__close)', '.map-toolbar button', '.node-detail-overlay__close'];

/** Standalone controls that grow to 44 px tall, border-box, on coarse pointers. */
const GROWN_TALL = ['.protocol-toggle-btn', '#autorefreshToggle', '.legend-toggle-button', '.chat-tab', '.chat-tab-select', '.filter-input input[type="text"]'];

/** The column header row, whose cells the sort buttons fill. */
const COLUMN_HEADER_CELL = '#nodes thead tr:not(.nodes-group-header) th';

/** The transparent hit boxes of CT1, each on a control that keeps its box. */
const HIT_BOXES = ['.filter-clear::after', '.short-info-overlay .short-info-close::after', '#nodes thead .sort-button::after'];

/**
 * A length in CSS px.
 *
 * @param {string} value Declared length, such as `6px`.
 * @returns {number} Its number of px.
 */
function px(value) {
  assert.match(value, /^-?\d+(\.\d+)?px$/, `${value} is a px length`);
  return Number.parseFloat(value);
}

/**
 * The `[selector, property, value]` rows whose coarse-pointer declaration
 * differs from `value`.
 *
 * @param {Array<Array<string>>} wanted Expected `[selector, property, value]` rows.
 * @returns {Array<Array<string>>} The rows base.css does not declare so.
 */
function coarseMismatches(wanted) {
  return wanted.filter(([selector, property, value]) => declarationsFor(selector, COARSE)[property] !== value);
}

test('coarse pointers grow the standalone controls to 44 px (CT1)', () => {
  const wanted = [
    ...GROWN_SQUARE.flatMap(selector => [[selector, 'min-width', '44px'], [selector, 'min-height', '44px']]),
    ...GROWN_TALL.flatMap(selector => [[selector, 'min-height', '44px'], [selector, 'box-sizing', 'border-box']]),
  ];
  assert.deepEqual(coarseMismatches(wanted), []);
});

test("the filter's × gets the chat badge's 44 px hit box, and the text stops short of it (CT1, FU11)", () => {
  const hitBox = {
    content: '""',
    position: 'absolute',
    top: '50%',
    left: '50%',
    width: '100%',
    height: '100%',
    'min-width': '44px',
    'min-height': '44px',
    transform: 'translate(-50%, -50%)',
  };
  assert.deepEqual(coarseMismatches(Object.entries(hitBox).map(([property, value]) => ['.filter-clear::after', property, value])), []);
  // Absolutely positioned already; relative would pull it into the flow.
  assert.equal(declarationsFor('.filter-clear').position, 'absolute');
  assert.equal(declarationsFor('.filter-clear', COARSE).position, undefined);
  // The hit box reaches its inset, half the ×, and half of 44 px in from the
  // box's right edge; the text's padding must cover that.
  const clear = declarationsFor('.filter-clear');
  const reach = px(clear.right) + px(clear.width) / 2 + 44 / 2;
  const padding = px(declarationsFor('.filter-input input[type="text"]', COARSE)['padding-right']);
  assert.ok(padding >= reach, `padding-right ${padding} px covers the hit box's ${reach} px`);
});

test("the short-info close's 44 px hit box grows from inside the popover's rounded corner (CT1)", () => {
  assert.deepEqual(coarseMismatches([
    ['.short-info-overlay .short-info-close::after', 'content', '""'],
    ['.short-info-overlay .short-info-close::after', 'position', 'absolute'],
    ['.short-info-overlay .short-info-close::after', 'width', '44px'],
    ['.short-info-overlay .short-info-close::after', 'height', '44px'],
  ]), []);
  const box = declarationsFor('.short-info-overlay .short-info-close::after', COARSE);
  const close = declarationsFor('.short-info-overlay .short-info-close');
  const overlay = declarationsFor('.short-info-overlay');
  const border = px(overlay.border.split(' ')[0]);
  const radius = px(overlay['border-radius']);
  for (const side of ['top', 'right']) {
    // How far inside the popover's outer edge the hit box starts.
    const inset = px(close[side]) + border + px(box[side]);
    assert.ok(inset >= 0, `${side}: the box starts ${inset} px inside the popover`);
    // The corner point at (inset, inset) lies inside the corner's rounding.
    assert.ok(Math.SQRT2 * (radius - inset) <= radius, `${side}: inside the ${radius} px rounding`);
  }
});

test('a sort button takes its whole header cell, which grows to a 44 px padding box (CT1)', () => {
  assert.deepEqual(coarseMismatches([
    ['#nodes thead .sort-button::after', 'content', '""'],
    ['#nodes thead .sort-button::after', 'position', 'absolute'],
    ['#nodes thead .sort-button::after', 'inset', '0'],
    [COLUMN_HEADER_CELL, 'box-sizing', 'border-box'],
    [COLUMN_HEADER_CELL, 'height', '45px'],
  ]), []);
  // The sticky cell is the hit box's containing block: the button itself
  // stays unpositioned at every pointer.
  assert.equal(declarationsFor('th').position, 'sticky');
  assert.equal(declarationsFor('.sort-button').position, undefined);
  assert.equal(declarationsFor('.sort-button', COARSE).position, undefined);
  // 45 px over the 1 px rule leaves a 44 px padding box.
  const rule = px(declarationsFor('thead th')['border-bottom'].split(' ')[0]);
  assert.equal(px(declarationsFor(COLUMN_HEADER_CELL, COARSE).height) - rule, 44);
});

test('legend chips keep their box: they touch, so a hit box would move each tap area onto a neighbour (CT1)', () => {
  for (const selector of ['.legend-item', 'button.legend-item', '.legend-item::after', 'button.legend-item::after']) {
    assert.deepEqual(declarationsFor(selector, COARSE), {}, selector);
  }
});

test('fine pointers keep the tight targets (CT1, FU11)', () => {
  const grown = [...GROWN_SQUARE, ...GROWN_TALL].filter(selector => declarationsFor(selector)['min-height'] === '44px');
  const hitBoxes = HIT_BOXES.filter(selector => declarationsFor(selector).content !== undefined);
  assert.deepEqual([...grown, ...hitBoxes], []);
  assert.equal(declarationsFor(COLUMN_HEADER_CELL).height, undefined);
  assert.equal(declarationsFor('.filter-input input[type="text"]')['padding-right'], '28px');
});

test('every button without a ring of its own draws the accent focus ring (CT2)', () => {
  for (const selector of ['button:focus-visible', '[role="button"]:focus-visible']) {
    const ring = declarationsFor(selector);
    assert.equal(ring.outline, '2px solid var(--accent)', selector);
    assert.equal(ring['outline-offset'], '2px', selector);
  }
  // The identity caret's own rule, at (0,2,0), outranks the button rule.
  assert.equal(declarationsFor('.identity-disclosure:focus-visible').outline, '2px solid var(--fg)');
});

test('chat tabs draw the ring inside the tab strip that clips it (CT2)', () => {
  assert.equal(declarationsFor('.chat-tab:focus-visible')['outline-offset'], '-2px');
});

test('hidden hides the controls that set their own display (CT3)', () => {
  const painted = ['.protocol-toggle-btn[hidden]', '.filter-clear[hidden]', '.header-federation[hidden]', '.map-toolbar button[hidden]']
    .filter(selector => declarationsFor(selector).display !== 'none');
  assert.deepEqual(painted, []);
});

test('the live toggle sits at the end of its row, so counts filling in never move it (CT3)', () => {
  assert.equal(declarationsFor('#autorefreshToggle')['margin-left'], 'auto');
});

test('on phones the vital-sign line owns a reserved row of its own (CT3)', () => {
  const line = declarationsFor('.meta-active-nodes', PHONE);
  const row = { order: line.order, 'flex-basis': line['flex-basis'], 'line-height': line['line-height'], 'min-height': line['min-height'] };
  assert.deepEqual(row, { order: '1', 'flex-basis': '100%', 'line-height': '1.4', 'min-height': '1.4em' });
});
