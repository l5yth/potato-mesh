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

import {
  LIVE_COLLECTIONS,
  parseChangeEvent,
  createEventStream,
} from '../event-stream.js';

// A fresh fake EventSource class per test, recording listeners + instances so
// the test can dispatch events and assert teardown.
function makeFakeFactory() {
  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.listeners = {};
      this.closed = false;
      FakeEventSource.instances.push(this);
    }

    addEventListener(type, fn) {
      (this.listeners[type] = this.listeners[type] || []).push(fn);
    }

    close() {
      this.closed = true;
    }

    dispatch(type, event) {
      (this.listeners[type] || []).forEach((fn) => fn(event));
    }
  }
  FakeEventSource.instances = [];
  return FakeEventSource;
}

// ---------------------------------------------------------------------------
// parseChangeEvent
// ---------------------------------------------------------------------------

test('LIVE_COLLECTIONS lists the six dashboard collections', () => {
  assert.deepEqual([...LIVE_COLLECTIONS], [
    'nodes',
    'messages',
    'positions',
    'telemetry',
    'neighbors',
    'traces',
  ]);
});

test('parseChangeEvent returns collection with a null hint when absent', () => {
  assert.deepEqual(parseChangeEvent('{"collection":"messages"}'), {
    collection: 'messages',
    hint: null,
  });
});

test('parseChangeEvent keeps a numeric hint', () => {
  assert.deepEqual(parseChangeEvent('{"collection":"nodes","hint":42}'), {
    collection: 'nodes',
    hint: 42,
  });
});

test('parseChangeEvent drops a non-numeric hint to null', () => {
  assert.deepEqual(parseChangeEvent('{"collection":"nodes","hint":"x"}'), {
    collection: 'nodes',
    hint: null,
  });
});

test('parseChangeEvent rejects an unknown collection', () => {
  assert.equal(parseChangeEvent('{"collection":"bogus"}'), null);
});

test('parseChangeEvent rejects a non-string collection', () => {
  assert.equal(parseChangeEvent('{"collection":5}'), null);
});

test('parseChangeEvent rejects non-object payloads', () => {
  assert.equal(parseChangeEvent('123'), null);
  assert.equal(parseChangeEvent('null'), null);
});

test('parseChangeEvent rejects malformed JSON', () => {
  assert.equal(parseChangeEvent('not json'), null);
});

// ---------------------------------------------------------------------------
// createEventStream — fallback / construction
// ---------------------------------------------------------------------------

test('createEventStream() tolerates no options and reports inactive', () => {
  const original = globalThis.EventSource;
  delete globalThis.EventSource;
  try {
    const stream = createEventStream();
    assert.equal(stream.start(), false);
    assert.equal(stream.isActive(), false);
  } finally {
    if (original !== undefined) globalThis.EventSource = original;
  }
});

test('start() returns false when EventSource is unavailable', () => {
  const original = globalThis.EventSource;
  delete globalThis.EventSource;
  try {
    const stream = createEventStream({ path: '/api/events', onChange() {} });
    assert.equal(stream.start(), false);
    assert.equal(stream.isActive(), false);
  } finally {
    if (original !== undefined) globalThis.EventSource = original;
  }
});

test('start() uses globalThis.EventSource when no factory is supplied', () => {
  const FakeEventSource = makeFakeFactory();
  const original = globalThis.EventSource;
  globalThis.EventSource = FakeEventSource;
  try {
    const stream = createEventStream({ path: '/api/events', onChange() {} });
    assert.equal(stream.start(), true);
    assert.equal(FakeEventSource.instances.length, 1);
    assert.equal(FakeEventSource.instances[0].url, '/api/events');
  } finally {
    if (original === undefined) delete globalThis.EventSource;
    else globalThis.EventSource = original;
  }
});

test('start() returns false when the path is empty', () => {
  const FakeEventSource = makeFakeFactory();
  const stream = createEventStream({
    path: '',
    onChange() {},
    eventSourceFactory: FakeEventSource,
  });
  assert.equal(stream.start(), false);
});

test('start() returns false when the path is missing', () => {
  const FakeEventSource = makeFakeFactory();
  const stream = createEventStream({ onChange() {}, eventSourceFactory: FakeEventSource });
  assert.equal(stream.start(), false);
});

test('start() returns false and reports when construction throws', () => {
  const errors = [];
  const throwingFactory = function ThrowingEventSource() {
    throw new Error('boom');
  };
  const stream = createEventStream({
    path: '/api/events',
    onChange() {},
    onError: (message) => errors.push(message),
    eventSourceFactory: throwingFactory,
  });
  assert.equal(stream.start(), false);
  assert.equal(stream.isActive(), false);
  assert.ok(errors.some((message) => message.includes('failed to open')));
});

test('start() is idempotent — a second call opens no new stream', () => {
  const FakeEventSource = makeFakeFactory();
  const stream = createEventStream({
    path: '/api/events',
    onChange() {},
    eventSourceFactory: FakeEventSource,
  });
  assert.equal(stream.start(), true);
  assert.equal(stream.start(), true);
  assert.equal(FakeEventSource.instances.length, 1);
});

// ---------------------------------------------------------------------------
// createEventStream — event handling
// ---------------------------------------------------------------------------

test('a (re)connect triggers onResync', () => {
  const FakeEventSource = makeFakeFactory();
  let resyncs = 0;
  const stream = createEventStream({
    path: '/api/events',
    onChange() {},
    onResync: () => {
      resyncs += 1;
    },
    eventSourceFactory: FakeEventSource,
  });
  stream.start();
  FakeEventSource.instances[0].dispatch('open', {});
  FakeEventSource.instances[0].dispatch('open', {});
  assert.equal(resyncs, 2);
});

test('an open event without onResync does not throw', () => {
  const FakeEventSource = makeFakeFactory();
  const stream = createEventStream({
    path: '/api/events',
    onChange() {},
    eventSourceFactory: FakeEventSource,
  });
  stream.start();
  assert.doesNotThrow(() => FakeEventSource.instances[0].dispatch('open', {}));
});

test('a valid change event invokes onChange with collection and hint', () => {
  const FakeEventSource = makeFakeFactory();
  const changes = [];
  const stream = createEventStream({
    path: '/api/events',
    onChange: (collection, hint) => changes.push([collection, hint]),
    eventSourceFactory: FakeEventSource,
  });
  stream.start();
  FakeEventSource.instances[0].dispatch('change', {
    data: JSON.stringify({ collection: 'messages', hint: 7 }),
  });
  assert.deepEqual(changes, [['messages', 7]]);
});

test('a malformed change event is discarded and reported', () => {
  const FakeEventSource = makeFakeFactory();
  const changes = [];
  const errors = [];
  const stream = createEventStream({
    path: '/api/events',
    onChange: (collection, hint) => changes.push([collection, hint]),
    onError: (message) => errors.push(message),
    eventSourceFactory: FakeEventSource,
  });
  stream.start();
  FakeEventSource.instances[0].dispatch('change', { data: 'garbage' });
  assert.equal(changes.length, 0);
  assert.ok(errors.some((message) => message.includes('malformed')));
});

test('a valid change event without an onChange callback does not throw', () => {
  const FakeEventSource = makeFakeFactory();
  const stream = createEventStream({
    path: '/api/events',
    eventSourceFactory: FakeEventSource,
  });
  stream.start();
  assert.doesNotThrow(() =>
    FakeEventSource.instances[0].dispatch('change', {
      data: JSON.stringify({ collection: 'nodes' }),
    }),
  );
});

test('a stream error is reported via onError', () => {
  const FakeEventSource = makeFakeFactory();
  const errors = [];
  const stream = createEventStream({
    path: '/api/events',
    onChange() {},
    onError: (message) => errors.push(message),
    eventSourceFactory: FakeEventSource,
  });
  stream.start();
  FakeEventSource.instances[0].dispatch('error', {});
  assert.ok(errors.some((message) => message.includes('connection error')));
});

test('a stream error without onError does not throw', () => {
  const FakeEventSource = makeFakeFactory();
  const stream = createEventStream({
    path: '/api/events',
    onChange() {},
    eventSourceFactory: FakeEventSource,
  });
  stream.start();
  assert.doesNotThrow(() => FakeEventSource.instances[0].dispatch('error', {}));
});

// ---------------------------------------------------------------------------
// createEventStream — teardown
// ---------------------------------------------------------------------------

test('stop() closes the stream and is safe to call twice', () => {
  const FakeEventSource = makeFakeFactory();
  const stream = createEventStream({
    path: '/api/events',
    onChange() {},
    eventSourceFactory: FakeEventSource,
  });
  stream.start();
  const instance = FakeEventSource.instances[0];
  stream.stop();
  assert.equal(instance.closed, true);
  assert.equal(stream.isActive(), false);
  assert.doesNotThrow(() => stream.stop());
});
