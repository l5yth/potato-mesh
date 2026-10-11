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
 * A counting stand-in for ``Intl.Segmenter`` (SPEC MT2): tests see how many
 * grapheme segmenters the badge renderer builds and how many names it
 * segments, and so how many non-ASCII badges a render built.
 *
 * @module __tests__/segmenter-spy
 */

/**
 * Counters of a {@link installSegmenterSpy} spy.
 *
 * @typedef {Object} SegmenterCounts
 * @property {number} constructed Segmenters constructed since the install.
 * @property {number} segmented ``segment()`` calls since the install.
 */

/**
 * Replace ``Intl.Segmenter`` with a subclass of the native one that counts
 * its constructions and ``segment()`` calls.
 *
 * Install it before the first badge renders: the renderer builds its shared
 * segmenter on first use, and that instance keeps counting into the same
 * ``counts`` after ``restore()``.
 *
 * @returns {{ counts: SegmenterCounts, Native: Function, restore: () => void }}
 *   The live counters, the native constructor (for oracles that must not be
 *   counted) and a function putting the native constructor back.
 */
export function installSegmenterSpy() {
  const Native = Intl.Segmenter;
  const counts = { constructed: 0, segmented: 0 };

  /** ``Intl.Segmenter`` that counts what the code under test does with it. */
  class CountingSegmenter extends Native {
    /** @param {...*} args Locale and options, as for ``Intl.Segmenter``. */
    constructor(...args) {
      super(...args);
      counts.constructed += 1;
    }

    /**
     * @param {string} text Text to segment.
     * @returns {Object} The native ``Segments`` object.
     */
    segment(text) {
      counts.segmented += 1;
      return super.segment(text);
    }
  }

  Intl.Segmenter = CountingSegmenter;
  return {
    counts,
    Native,
    restore() {
      Intl.Segmenter = Native;
    },
  };
}
