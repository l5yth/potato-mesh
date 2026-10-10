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
 * SPEC MT1: the map binds every neighbour-line and trace-line tooltip as
 * content Leaflet builds when the tooltip opens, so neither the page load nor
 * a repaint builds one; each opening builds it once, with the HTML the eager
 * builders render.
 *
 * The nodes carry non-ASCII short names, so every badge the renderer builds
 * runs one grapheme segmentation that the segmenter spy counts. A map-only
 * repaint renders no other badge (markers and pins carry none), so the
 * spy's count over that repaint is the number of tooltip badges it built.
 * The live-map harness keeps each bound tooltip's content and, as Leaflet
 * 1.9.4 does, calls a content function on every ``openTooltip()``, an open
 * tooltip's included.
 *
 * @module app/__tests__/main-map-lazy-tooltips
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { NOW, clickLayer, drawnLines, runMapApp } from './live-map-harness.js';
import { installSegmenterSpy } from './segmenter-spy.js';
import { buildNeighborTooltipHtml, buildTraceTooltipHtml } from '../main/tooltip-html.js';

// Installed before any badge renders; node --test runs each file in its own
// process, and the native constructor is put back when the file ends.
const spy = installSegmenterSpy();
after(() => spy.restore());

const NEIGHBOR_LINE = 'neighbor-connection-line';
const TRACE_LINE = 'neighbor-connection-line trace-connection-line';

/**
 * Four positioned nodes with non-ASCII short names (and one blank one), three
 * neighbour links and a trace A → C → B.
 *
 * @returns {Object<string, *>} Stub-fetch responses a test may edit.
 */
function mapResponses() {
  return {
    'encrypted=true': [],
    '/api/nodes': [
      { node_id: '!a', short_name: 'Ä1', long_name: 'Node A', role: 'CLIENT', protocol: 'meshtastic', last_heard: NOW - 30, latitude: 52.5, longitude: 13.4 },
      { node_id: '!b', short_name: '⚡', long_name: 'Node B', role: 'ROUTER', protocol: 'meshtastic', last_heard: NOW - 60, latitude: 52.51, longitude: 13.42 },
      { node_id: '!c', short_name: '日本', long_name: 'Node C', role: 'COMPANION', protocol: 'meshcore', last_heard: NOW - 90, latitude: 52.52, longitude: 13.44 },
      // A blank short name: the eager builder returned '' for its line.
      { node_id: '!d', short_name: '   ', long_name: 'Node D', role: 'CLIENT', protocol: 'meshtastic', last_heard: NOW - 120, latitude: 52.49, longitude: 13.38 },
    ],
    '/api/messages': [],
    '/api/neighbors': [
      { node_id: '!a', neighbor_id: '!b', snr: 6.5, rx_time: NOW - 40 },
      { node_id: '!b', neighbor_id: '!c', snr: 2.5, rx_time: NOW - 41 },
      { node_id: '!a', neighbor_id: '!d', snr: 1.5, rx_time: NOW - 42 },
    ],
    '/api/traces': [{ id: 77, src: '!a', hops: ['!c'], dest: '!b', rx_time: NOW - 50 }],
    '/api/waypoints': [],
  };
}

/**
 * The fixture node with ``nodeId``.
 *
 * @param {Object<string, *>} responses Stub-fetch responses.
 * @param {string} nodeId Node id.
 * @returns {Object} The node record the stub serves.
 */
function fixtureNode(responses, nodeId) {
  return responses['/api/nodes'].find(node => node.node_id === nodeId);
}

/**
 * The drawn line from ``from`` to ``to``.
 *
 * @param {Object} leaflet Leaflet stub.
 * @param {string} className Exact class list of the line.
 * @param {Object} from Start node record.
 * @param {Object} to End node record.
 * @returns {Object} Stub polyline.
 */
function lineBetween(leaflet, className, from, to) {
  const line = drawnLines(leaflet, className).find(candidate => {
    const [[lat0, lon0], [lat1, lon1]] = candidate._latLngs;
    return lat0 === from.latitude && lon0 === from.longitude && lat1 === to.latitude && lon1 === to.longitude;
  });
  assert.ok(line, `a ${className} from ${from.node_id} to ${to.node_id} is drawn`);
  return line;
}

/**
 * The tooltip HTML today's eager builder renders for a neighbour line.
 *
 * @param {Object} source Source node record.
 * @param {Object} target Target node record.
 * @returns {string} Tooltip HTML.
 */
function neighborHtml(source, target) {
  return buildNeighborTooltipHtml({
    sourceShortName: source.short_name,
    sourceRole: source.role,
    sourceNode: source,
    targetShortName: target.short_name,
    targetRole: target.role,
    targetNode: target,
  });
}

/**
 * Every drawn neighbour and trace line that has a tooltip bound.
 *
 * @param {Object} leaflet Leaflet stub.
 * @returns {Array<Object>} Stub polylines.
 */
function linesWithTooltips(leaflet) {
  return [...drawnLines(leaflet, NEIGHBOR_LINE), ...drawnLines(leaflet, TRACE_LINE)].filter(line => line.getTooltip());
}

test('a map repaint builds no line tooltip: each is content built when it opens (SPEC MT1)', async () => {
  await runMapApp({ responses: mapResponses() }, async ctx => {
    const before = linesWithTooltips(ctx.leaflet);
    const segmentedBefore = spy.counts.segmented;
    ctx.testUtils.rerenderMapForFiltering();
    assert.equal(spy.counts.segmented - segmentedBefore, 0, 'the map repaint rendered no tooltip badge');

    const rebuilt = linesWithTooltips(ctx.leaflet);
    assert.equal(rebuilt.length, 4, 'tooltips on the A-B and B-C lines and on both trace hops');
    assert.ok(rebuilt.every(line => !before.includes(line)), 'the repaint drew new lines');
    for (const line of [...before, ...rebuilt]) {
      assert.equal(typeof line.getTooltip().content, 'function', 'the tooltip is content built on open');
      assert.equal(line.getTooltip().builds, 0, 'and nothing built it before it opened');
    }
  });
});

test('each opening builds a line tooltip once, with the eager builders\' HTML (SPEC MT1)', async () => {
  const responses = mapResponses();
  const [a, b, c] = ['!a', '!b', '!c'].map(id => fixtureNode(responses, id));
  await runMapApp({ responses }, async ctx => {
    const line = lineBetween(ctx.leaflet, NEIGHBOR_LINE, a, b);
    const expected = neighborHtml(a, b);
    const segmentedBefore = spy.counts.segmented;
    line.openTooltip();
    assert.equal(line.getTooltip().builds, 1, 'opening the tooltip built it once');
    assert.equal(spy.counts.segmented - segmentedBefore, 2, 'with its two badges');
    assert.equal(line.getTooltip().html, expected);
    // Leaflet 1.9.4 fills an open tooltip again on openTooltip().
    line.openTooltip();
    assert.equal(line.getTooltip().builds, 2, 'an opening of the open tooltip builds it once more');
    line.closeTooltip();
    line.openTooltip();
    assert.equal(line.getTooltip().builds, 3, 'and so does reopening it');
    assert.equal(spy.counts.segmented - segmentedBefore, 6, 'two badges per opening');
    assert.equal(line.getTooltip().html, expected);

    assert.equal(lineBetween(ctx.leaflet, NEIGHBOR_LINE, b, c).getTooltip().builds, 0, 'the other lines stay unbuilt');
    const hops = [lineBetween(ctx.leaflet, TRACE_LINE, a, c), lineBetween(ctx.leaflet, TRACE_LINE, c, b)];
    for (const hop of hops) {
      hop.openTooltip();
      assert.equal(hop.getTooltip().builds, 1);
      assert.equal(hop.getTooltip().html, buildTraceTooltipHtml([a, c, b]), 'each hop shows the whole path');
    }
  });
});

test('a tooltip open across a rebuild is built on the rebuilt line from the new data (DR2, SPEC MT1)', async () => {
  const responses = mapResponses();
  await runMapApp({ responses }, async ctx => {
    const a = fixtureNode(responses, '!a');
    const line = lineBetween(ctx.leaflet, NEIGHBOR_LINE, a, fixtureNode(responses, '!b'));
    clickLayer(line);
    assert.equal(line.isTooltipOpen(), true, 'a click opens the tooltip');
    assert.equal(line.getTooltip().builds, 1);

    responses['/api/nodes'][1] = { ...responses['/api/nodes'][1], battery_level: 55 };
    await ctx.ping('nodes');
    const b = fixtureNode(responses, '!b');
    const rebuilt = lineBetween(ctx.leaflet, NEIGHBOR_LINE, a, b);
    assert.notEqual(rebuilt, line, 'the map rebuilt the line');
    assert.equal(rebuilt.isTooltipOpen(), true, 'the tooltip reopened on the rebuilt line (DR2)');
    assert.equal(rebuilt.getTooltip().builds, 1, 'built once as it reopened');
    assert.equal(rebuilt.getTooltip().html, neighborHtml(a, b), 'from the rebuilt node records');
    assert.notEqual(rebuilt.getTooltip().html, line.getTooltip().html, 'which changed');
    const others = linesWithTooltips(ctx.leaflet).filter(other => other !== rebuilt);
    assert.equal(others.length, 3);
    assert.ok(others.every(other => other.getTooltip().builds === 0), 'the refresh built no other tooltip');
  });
});

test('a line whose eager tooltip was empty still binds none (SPEC MT1)', async () => {
  const responses = mapResponses();
  await runMapApp({ responses }, async ctx => {
    const line = lineBetween(ctx.leaflet, NEIGHBOR_LINE, fixtureNode(responses, '!a'), fixtureNode(responses, '!d'));
    assert.equal(line.getTooltip(), undefined, 'no tooltip on the line to the blank short name');
  });
});

test('the live-map harness shows string tooltip content as given, as Leaflet does', async () => {
  await runMapApp({ responses: mapResponses() }, async ctx => {
    const line = ctx.leaflet.polyline([[52.5, 13.4], [52.6, 13.5]], { className: 'harness-line' });
    line.bindTooltip('<b>as given</b>', {});
    assert.equal(line.getTooltip().html, null, 'nothing shown before it opens');
    line.openTooltip();
    line.openTooltip();
    assert.equal(line.getTooltip().html, '<b>as given</b>');
    assert.equal(line.getTooltip().builds, 0, 'a string is no content function to call');
  });
});
