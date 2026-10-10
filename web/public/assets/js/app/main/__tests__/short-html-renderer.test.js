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
 * SPEC MT2: every badge shares one ``Intl.Segmenter``, ASCII names without a
 * CR skip segmentation, and the label of every badge is the one a fresh
 * segmenter per call gave: padded with one space on each side below four
 * grapheme clusters, as it was.
 *
 * @module main/__tests__/short-html-renderer
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { installSegmenterSpy } from '../../__tests__/segmenter-spy.js';
import { escapeHtml } from '../../utils.js';
import { renderShortHtml } from '../short-html-renderer.js';

// Installed before the first badge renders (importing renders none), so the
// renderer's segmenter is the spy's; node --test runs each file in its own
// process, and the native constructor is put back when the file ends.
const spy = installSegmenterSpy();
after(() => spy.restore());

/**
 * The label a badge carried before SPEC MT2: the grapheme count of a fresh
 * ``Intl.Segmenter`` per call, padding below four, spaces as ``&nbsp;``.
 *
 * @param {*} name Short name as passed to ``renderShortHtml``.
 * @returns {string} Label HTML.
 */
function referenceLabel(name) {
  const raw = String(name);
  const graphemeCount = [...new spy.Native().segment(raw)].length;
  return escapeHtml(graphemeCount >= 4 ? raw : ` ${raw} `).replace(/ /g, '&nbsp;');
}

/**
 * The label of a rendered badge: the text between its opening tag (whose
 * attribute values are escaped, so hold no ``>``) and the closing tag.
 *
 * @param {string} html Badge HTML.
 * @returns {string} Label HTML.
 */
function labelOf(html) {
  return html.slice(html.indexOf('>') + 1, html.lastIndexOf('</span>'));
}

/**
 * Pieces that stress the UAX #29 grapheme rules, each one string.
 *
 * @type {Array<string>}
 */
const PIECES = [
  // ASCII letters, digits, space and the characters escapeHtml rewrites.
  'a', 'Z', '0', ' ', '!', '~', '&', '<', '>', '"', "'", '\\',
  // ASCII controls; CR LF is the one ASCII pair that forms one cluster (GB3).
  '\t', '\n', '\r', '\r\n', '\0', '\x1b', '\x7f',
  // Latin-1 and Latin Extended, precomposed and decomposed.
  'é', 'e\u0301', 'ß', 'Ä', 'ø', '\u00a0', '\u00ad',
  // Combining marks, alone and stacked.
  '\u0300', '\u0301\u0302\u0303', '\u20dd', '\u0489',
  // ZWSP, ZWNJ, ZWJ, BOM, LINE SEPARATOR, RLO.
  '\u200b', '\u200c', '\u200d', '\ufeff', '\u2028', '\u202e',
  // Emoji: text and emoji presentation, a skin tone, ZWJ sequences, flags,
  // a lone regional indicator, keycaps and a tag sequence.
  '\u26a1', '\u26a1\ufe0f', '\u2764\ufe0e', '\u{1f643}', '\u{1f44d}\u{1f3fd}',
  '\u{1f469}\u200d\u{1f469}\u200d\u{1f467}\u200d\u{1f466}', '\u{1f3c3}\u200d\u2642\ufe0f',
  '\u{1f3f3}\ufe0f\u200d\u{1f308}', '\u{1f1e9}\u{1f1ea}', '\u{1f1e9}', '1\ufe0f\u20e3', '#\u20e3',
  '\u{1f3f4}\u{e0067}\u{e0062}\u{e0073}\u{e0063}\u{e0074}\u{e007f}',
  // A Hangul syllable and conjoining jamo (L, V, T).
  '\ud55c', '\u1112', '\u1161', '\u11ab',
  // A Devanagari conjunct and spacing mark, a virama alone, Thai, an Arabic
  // prepended concatenation mark.
  '\u0915\u094d\u0937', '\u0928\u093f', '\u0915\u094d', '\u0e01', '\u0e33', '\u0600',
  // CJK, supplementary letters, variation selectors, private use,
  // noncharacters, right-to-left letters.
  '\u4e2d', '\u{20000}', '\u{1d49c}', '\ufe0f', '\u{e0100}', '\ue000', '\uffff', '\u05e9', '\u0639',
  // Lone and reversed surrogates.
  '\ud83d', '\ude43', '\ude43\ud83d',
];

/**
 * A seeded 32-bit generator (mulberry32), so the corpus is the same on
 * every run.
 *
 * @param {number} seed Seed.
 * @returns {() => number} Uniform numbers in [0, 1).
 */
function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Every string of ``length`` characters over ``alphabet``.
 *
 * @param {Array<string>} alphabet Characters.
 * @param {number} length String length.
 * @returns {Array<string>} All combinations.
 */
function allStrings(alphabet, length) {
  if (length === 0) return [''];
  return allStrings(alphabet, length - 1).flatMap(prefix => alphabet.map(char => prefix + char));
}

/**
 * The names the byte-identity test renders: every piece, every pair of
 * pieces, 4,000 seeded strings of three to six pieces, every ASCII string of
 * one to four characters over letters, space, CR, LF, tab and ``&``, every
 * five-character string over ``a``, CR and LF, and truthy names that are no
 * string (a falsy name renders the ``?`` badge, which has no label to pad).
 *
 * @returns {Array<*>} Short names.
 */
function buildCorpus() {
  const corpus = [...PIECES];
  for (const first of PIECES) {
    for (const second of PIECES) corpus.push(first + second);
  }
  const random = seededRandom(0x4d54);
  for (let i = 0; i < 4000; i += 1) {
    const count = 3 + Math.floor(random() * 4);
    let name = '';
    for (let j = 0; j < count; j += 1) name += PIECES[Math.floor(random() * PIECES.length)];
    corpus.push(name);
  }
  const asciiAlphabet = ['a', 'Z', ' ', '\r', '\n', '\t', '&'];
  for (let length = 1; length <= 4; length += 1) corpus.push(...allStrings(asciiAlphabet, length));
  corpus.push(...allStrings(['a', '\r', '\n'], 5));
  corpus.push(7, 1234, 12345, -1, 0.5, Infinity, true, { toString: () => '\u{1f643}\u{1f643}' });
  return corpus;
}

test('every badge shares one Intl.Segmenter (SPEC MT2)', () => {
  const names = ['Ä1', '\u26a1', '\u65e5\u672c', '\u{1f643}\u{1f643}', '\u0915\u094d\u0937', 'e\u0301e\u0301', '\u{1f1e9}\u{1f1ea}A', 'Øl'];
  for (let round = 0; round < 8; round += 1) {
    for (const name of names) renderShortHtml(name, 'CLIENT', `Long ${name}`, { node_id: '!a', protocol: 'meshtastic' });
  }
  assert.equal(spy.counts.constructed, 1, 'one segmenter for 64 non-ASCII badges');
});

test('ASCII names without a CR skip segmentation; every other name is segmented once (SPEC MT2)', () => {
  const ascii = ['A', 'ab', 'abc', '0ac7', 'N042', 'LongName!', 'a b', '<&>', '\t', 'x\ny', '~~~~~', '\x7f\0'];
  let before = spy.counts.segmented;
  for (const name of ascii) renderShortHtml(name, 'CLIENT');
  assert.equal(spy.counts.segmented - before, 0, 'no ASCII name was segmented');

  // A CR may join the LF after it, and any other character may join its
  // neighbours: those names are segmented, once per badge.
  const others = ['a\r\nb', '\r', 'é', '\u26a11', '\u00a0', 'abc\u0301'];
  before = spy.counts.segmented;
  for (const name of others) renderShortHtml(name, 'CLIENT');
  assert.equal(spy.counts.segmented - before, others.length);
});

test('every label matches a fresh segmenter per call over a broad corpus (SPEC MT2)', () => {
  const corpus = buildCorpus();
  assert.ok(corpus.length > 10000, `corpus of ${corpus.length} names`);
  for (const name of corpus) {
    const html = renderShortHtml(name, 'CLIENT', 'Long', { node_id: '!a', protocol: 'meshtastic' });
    assert.equal(labelOf(html), referenceLabel(name), `label of ${JSON.stringify(String(name))}`);
  }
});

test('without Intl.Segmenter a label counts UTF-16 code units, as before (SPEC MT2)', () => {
  const installed = Intl.Segmenter;
  const cases = [
    ['\u{1f643}', '&nbsp;\u{1f643}&nbsp;'],
    ['\u{1f643}\u{1f643}', '\u{1f643}\u{1f643}'],
    ['a\r\nb', 'a\r\nb'],
    ['abc', '&nbsp;abc&nbsp;'],
  ];
  try {
    Intl.Segmenter = undefined;
    for (const [name, label] of cases) assert.equal(labelOf(renderShortHtml(name, 'CLIENT')), label, `no Intl.Segmenter: ${name}`);
    const savedIntl = globalThis.Intl;
    try {
      globalThis.Intl = undefined;
      for (const [name, label] of cases) assert.equal(labelOf(renderShortHtml(name, 'CLIENT')), label, `no Intl: ${name}`);
    } finally {
      globalThis.Intl = savedIntl;
    }
  } finally {
    Intl.Segmenter = installed;
  }
});
