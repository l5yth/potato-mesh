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

// Regression guard for audit findings D-006/D-007/D-017/D-023 (SPEC UX9 /
// ACCEPTANCE UX-A7): grouped headers that track the responsive tiers, the
// mobile disclosure row, whole-row activation, and the numeric column set.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NODES_TABLE_COLUMN_GROUPS,
  NODES_TABLE_HIDE_TIERS,
  NODES_TABLE_TOTAL_COLUMNS,
  NUMERIC_COLUMN_CLASSES,
  computeGroupColspans,
  hiddenColumnsForWidth,
  syncGroupHeaderColspans,
  buildNodeExtraRowHtml,
  nodeExtraRowParts,
  isReportedField,
  filterReportedFields,
  rowActivationHref,
} from '../nodes-table-ia.js';

test('column groups cover all 21 data columns exactly once, in order', () => {
  const columns = NODES_TABLE_COLUMN_GROUPS.flatMap(group => group.columns);
  assert.equal(columns.length, 21);
  assert.equal(new Set(columns).size, 21, 'no column sits in two groups');
  assert.equal(columns[0], 'nodes-col--protocol');
  assert.equal(columns[columns.length - 1], 'nodes-col--last-position');
  const labels = NODES_TABLE_COLUMN_GROUPS.map(group => group.label);
  assert.deepEqual(labels, [
    'Identity',
    'Radio',
    'Activity',
    'Health',
    'Utilization',
    'Environment',
    'Position',
  ]);
});

test('group colspans shrink with hidden columns and drop empty groups', () => {
  const hidden = new Set(['nodes-col--frequency', 'nodes-col--modem-preset']);
  const spans = computeGroupColspans(NODES_TABLE_COLUMN_GROUPS, cls => !hidden.has(cls));
  assert.ok(!spans.some(span => span.label === 'Radio'), 'a fully hidden group is omitted');
  const identity = spans.find(span => span.label === 'Identity');
  assert.equal(identity.colspan, 4);
});

test('numeric column set matches the 12 measurement columns', () => {
  assert.deepEqual(
    [...NUMERIC_COLUMN_CLASSES].sort(),
    [
      'nodes-col--air-util-tx',
      'nodes-col--altitude',
      'nodes-col--battery',
      'nodes-col--channel-util',
      'nodes-col--frequency',
      'nodes-col--humidity',
      'nodes-col--latitude',
      'nodes-col--longitude',
      'nodes-col--pressure',
      'nodes-col--temperature',
      'nodes-col--uptime',
      'nodes-col--voltage',
    ],
  );
});

test('the disclosure row renders hidden fields as a definition list', () => {
  const html = buildNodeExtraRowHtml(
    [
      { label: 'Battery', valueHtml: '83%' },
      { label: 'Voltage', valueHtml: '3.9V' },
    ],
    22,
  );
  assert.ok(html.includes('node-extra'));
  assert.ok(html.includes('colspan="22"'));
  assert.ok(html.includes('<dl'));
  assert.ok(html.includes('<dt>Battery</dt>'));
  assert.ok(html.includes('<dd>83%</dd>'));
  assert.ok(html.includes('<dd>3.9V</dd>'));
});

test('isReportedField keeps real readings and honest zeros, drops blanks/dashes', () => {
  // Real readings, including honest zeros (audit follow-up 07 decision: a 0%
  // channel util or 0 V is a genuine reading, not an absence).
  assert.equal(isReportedField({ label: 'Battery', valueHtml: '83%' }), true);
  assert.equal(isReportedField({ label: 'Channel Util', valueHtml: '0.0%' }), true);
  assert.equal(isReportedField({ label: 'Voltage', valueHtml: '0 V' }), true);
  assert.equal(isReportedField({ label: 'Altitude', valueHtml: '<span>0 m</span>' }), true);
  // Absences: empty string and the muted em-dash placeholder, with or without tags.
  assert.equal(isReportedField({ label: 'Uptime', valueHtml: '' }), false);
  assert.equal(
    isReportedField({ label: 'Uptime', valueHtml: '<span class="cell-empty">—</span>' }),
    false,
  );
  assert.equal(isReportedField({ label: 'Uptime', valueHtml: '  —  ' }), false);
  assert.equal(
    isReportedField({ label: 'Uptime', valueHtml: '&mdash;' }),
    false,
    'the HTML-entity em-dash is also treated as absent',
  );
  assert.equal(isReportedField({}), false, 'a missing value is unreported');
  assert.equal(isReportedField(null), false, 'a null entry is unreported');
  assert.equal(isReportedField(undefined), false, 'an undefined entry is unreported');
});

test('isReportedField classifies without stripping tags (CodeQL sanitization guard)', () => {
  // Regression guard for CodeQL js/incomplete-multi-character-sanitization: the
  // classifier must NOT run a single-pass `/<[^>]*>/` tag strip (which can leave
  // a bare `<script`). It compares against the absent marker directly, so
  // markup-only content classifies as reported instead of collapsing to empty —
  // if a strip were reintroduced this would flip to false. The value is only
  // classified here, never rendered; callers escape valueHtml before the DOM.
  assert.equal(isReportedField({ valueHtml: '<span></span>' }), true);
});

test('filterReportedFields keeps only the fields that reported', () => {
  const kept = filterReportedFields([
    { label: 'Voltage', valueHtml: '4.02 V' },
    { label: 'Uptime', valueHtml: '<span class="cell-empty">—</span>' },
    { label: 'Channel Util', valueHtml: '0.0%' },
  ]);
  assert.deepEqual(
    kept.map(entry => entry.label),
    ['Voltage', 'Channel Util'],
    'dashes drop out, honest zeros stay',
  );
  assert.deepEqual(filterReportedFields(null), [], 'non-arrays yield an empty list');
});

test('the disclosure row falls back to one muted line when nothing reported', () => {
  const parts = nodeExtraRowParts([], 22);
  assert.ok(parts.innerHtml.includes('colspan="22"'));
  assert.ok(!parts.innerHtml.includes('<dl'), 'no empty definition list is emitted');
  assert.ok(parts.innerHtml.includes('node-extra__empty'));
  assert.ok(parts.innerHtml.includes('No additional fields reported.'));
});

/**
 * Element stub with closest()/querySelector() sufficient for row activation.
 *
 * @param {Object} spec Behaviour spec.
 * @returns {Object} stub element.
 */
function targetStub({ interactive }) {
  return {
    closest: selector => {
      if (selector.includes('a') && interactive) return {};
      return null;
    },
  };
}

test('row activation resolves the long-name href for plain cells', () => {
  const row = {
    querySelector: selector =>
      selector.includes('long-name')
        ? { getAttribute: name => (name === 'href' ? '/nodes/!abcdef01' : null) }
        : null,
  };
  assert.equal(rowActivationHref(row, targetStub({ interactive: false })), '/nodes/!abcdef01');
});

test('row activation yields null for clicks on interactive elements', () => {
  const row = {
    querySelector: () => ({ getAttribute: () => '/nodes/!abcdef01' }),
  };
  assert.equal(rowActivationHref(row, targetStub({ interactive: true })), null);
});

test('row activation yields null when the row has no long-name link', () => {
  const row = { querySelector: () => null };
  assert.equal(rowActivationHref(row, targetStub({ interactive: false })), null);
  assert.equal(rowActivationHref(null, targetStub({ interactive: false })), null);
});

test('row activation copes with odd targets and blank hrefs', () => {
  const row = {
    querySelector: () => ({ getAttribute: () => '/nodes/!feed' }),
  };
  assert.equal(rowActivationHref(row, null), '/nodes/!feed', 'no target still resolves the link');
  assert.equal(rowActivationHref(row, {}), '/nodes/!feed', 'target without closest resolves too');
  const blankRow = { querySelector: () => ({ getAttribute: () => '' }) };
  assert.equal(rowActivationHref(blankRow, null), null, 'a blank href never navigates');
  const brokenLinkRow = { querySelector: () => ({}) };
  assert.equal(rowActivationHref(brokenLinkRow, null), null, 'a link without getAttribute is ignored');
});

test('the total column count is the 21 data columns plus the disclosure cell', () => {
  const dataColumns = NODES_TABLE_COLUMN_GROUPS.flatMap(group => group.columns).length;
  assert.equal(NODES_TABLE_TOTAL_COLUMNS, dataColumns + 1);
});

test('hiddenColumnsForWidth mirrors the responsive tiers', () => {
  assert.equal(hiddenColumnsForWidth(1920).size, 0, 'full width hides nothing');
  const mobile = hiddenColumnsForWidth(375);
  assert.ok(mobile.has('nodes-col--role'), 'Role hides at mobile (UX9 tier swap)');
  assert.ok(!mobile.has('nodes-col--battery'), 'Battery survives at mobile');
  assert.ok(!mobile.has('nodes-col--last-seen'));
  assert.ok(!mobile.has('nodes-col--protocol'));
  const tierColumns = NODES_TABLE_HIDE_TIERS.flatMap(tier => tier.columns);
  for (const column of tierColumns) {
    assert.ok(mobile.has(column), `${column} hidden at the smallest tier`);
  }
});

test('nodeExtraRowParts and buildNodeExtraRowHtml agree', () => {
  const entries = [{ label: 'Battery', valueHtml: '83%' }];
  const parts = nodeExtraRowParts(entries, 22);
  assert.equal(parts.className, 'node-extra');
  assert.ok(parts.innerHtml.startsWith('<td colspan="22">'));
  assert.ok(buildNodeExtraRowHtml(entries, 22).includes(parts.innerHtml));
});

/**
 * Header-cell stub tracking colspan/hidden mutations for the sync helper.
 *
 * @param {string} group Group label bound via `data-group`.
 * @param {?string} colspan Initial colspan attribute value.
 * @returns {Object} th stub.
 */
function groupCellStub(group, colspan) {
  const attrs = { 'data-group': group, colspan };
  return {
    hidden: false,
    getAttribute: name => (name in attrs ? attrs[name] : null),
    setAttribute: (name, value) => {
      attrs[name] = String(value);
    },
    attrs,
  };
}

test('syncGroupHeaderColspans rewrites colspans and hides empty groups', () => {
  const identity = groupCellStub('Identity', '4');
  const radio = groupCellStub('Radio', '2');
  const stray = groupCellStub('Nonexistent', '1');
  const row = { querySelectorAll: () => [identity, radio, stray] };
  const hidden = new Set(['nodes-col--frequency', 'nodes-col--modem-preset', 'nodes-col--node-id']);
  syncGroupHeaderColspans(row, NODES_TABLE_COLUMN_GROUPS, cls => !hidden.has(cls));
  assert.equal(identity.attrs.colspan, '3', 'Identity shrinks with its hidden column');
  assert.equal(radio.hidden, true, 'a fully hidden group hides its header');
  assert.equal(stray.attrs.colspan, '1', 'unknown groups are left alone');
  // Restoring visibility un-hides and re-spans.
  syncGroupHeaderColspans(row, NODES_TABLE_COLUMN_GROUPS, () => true);
  assert.equal(radio.hidden, false);
  assert.equal(radio.attrs.colspan, '2');
  assert.doesNotThrow(() => syncGroupHeaderColspans(null, NODES_TABLE_COLUMN_GROUPS, () => true));
});
