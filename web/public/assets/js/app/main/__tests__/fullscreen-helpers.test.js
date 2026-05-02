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

import test from 'node:test';
import assert from 'node:assert/strict';

import { getActiveFullscreenElement, legendClickHandler } from '../fullscreen-helpers.js';

// ---------------------------------------------------------------------------
// getActiveFullscreenElement
// ---------------------------------------------------------------------------

test('getActiveFullscreenElement returns null when document is undefined', () => {
  const previousDoc = globalThis.document;
  // Node has no document by default, but other tests in the suite may have
  // assigned one — clear it explicitly for this case.
  delete globalThis.document;
  try {
    assert.equal(getActiveFullscreenElement(), null);
  } finally {
    if (previousDoc !== undefined) {
      globalThis.document = previousDoc;
    }
  }
});

test('getActiveFullscreenElement prefers fullscreenElement', () => {
  const dummy = { tag: 'std' };
  const previousDoc = globalThis.document;
  globalThis.document = {
    fullscreenElement: dummy,
    webkitFullscreenElement: { tag: 'webkit' },
    msFullscreenElement: { tag: 'ms' },
  };
  try {
    assert.equal(getActiveFullscreenElement(), dummy);
  } finally {
    if (previousDoc === undefined) {
      delete globalThis.document;
    } else {
      globalThis.document = previousDoc;
    }
  }
});

test('getActiveFullscreenElement falls back to webkit prefix', () => {
  const dummy = { tag: 'webkit' };
  const previousDoc = globalThis.document;
  globalThis.document = {
    fullscreenElement: null,
    webkitFullscreenElement: dummy,
    msFullscreenElement: null,
  };
  try {
    assert.equal(getActiveFullscreenElement(), dummy);
  } finally {
    if (previousDoc === undefined) {
      delete globalThis.document;
    } else {
      globalThis.document = previousDoc;
    }
  }
});

test('getActiveFullscreenElement falls back to ms prefix', () => {
  const dummy = { tag: 'ms' };
  const previousDoc = globalThis.document;
  globalThis.document = {
    fullscreenElement: null,
    webkitFullscreenElement: null,
    msFullscreenElement: dummy,
  };
  try {
    assert.equal(getActiveFullscreenElement(), dummy);
  } finally {
    if (previousDoc === undefined) {
      delete globalThis.document;
    } else {
      globalThis.document = previousDoc;
    }
  }
});

test('getActiveFullscreenElement returns null when no fullscreen owner is set', () => {
  const previousDoc = globalThis.document;
  globalThis.document = {
    fullscreenElement: null,
    webkitFullscreenElement: null,
    msFullscreenElement: null,
  };
  try {
    assert.equal(getActiveFullscreenElement(), null);
  } finally {
    if (previousDoc === undefined) {
      delete globalThis.document;
    } else {
      globalThis.document = previousDoc;
    }
  }
});

// ---------------------------------------------------------------------------
// legendClickHandler
// ---------------------------------------------------------------------------

test('legendClickHandler always calls preventDefault and stopPropagation', () => {
  let preventCalls = 0;
  let stopCalls = 0;
  let bodyCalls = 0;
  const handler = legendClickHandler(() => {
    bodyCalls += 1;
  });
  const fakeEvent = {
    preventDefault: () => {
      preventCalls += 1;
    },
    stopPropagation: () => {
      stopCalls += 1;
    },
  };
  handler(fakeEvent);
  assert.equal(preventCalls, 1);
  assert.equal(stopCalls, 1);
  assert.equal(bodyCalls, 1);
});

test('legendClickHandler forwards the event object to the body', () => {
  let received = null;
  const handler = legendClickHandler(event => {
    received = event;
  });
  const fakeEvent = {
    preventDefault() {},
    stopPropagation() {},
    payload: 'forwarded',
  };
  handler(fakeEvent);
  assert.equal(received, fakeEvent);
});
