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
 * SPEC CV3: the frontend coverage floor check that `npm test` runs.
 *
 * File-system tests work in a fresh temporary directory laid out like
 * `web/`, with a `public/assets/js` source root and an lcov report.
 *
 * @module scripts/__tests__/check-coverage
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_SOURCE_ROOT,
  belowFloors,
  countLines,
  listSources,
  main,
  parseArgs,
  parseLcov,
  percent,
  summarise
} from '../check-coverage.js';

const SCRIPT = fileURLToPath(new URL('../check-coverage.js', import.meta.url));

/**
 * Create a temporary `web/`-like directory, removed after the test.
 *
 * @param {import('node:test').TestContext} t Running test, for cleanup.
 * @param {Object<string, string>} files Relative path to file content.
 * @returns {string} The directory.
 */
function tempTree(t, files) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'check-coverage-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(dir, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

/**
 * Collect what a {@link main} run writes to one stream.
 *
 * @returns {{write: function(string): void, text: string}} Writable stand-in.
 */
function sink() {
  return {
    text: '',
    write(chunk) {
      this.text += chunk;
    }
  };
}

/** lcov for one loaded source: two of three lines and one of two branches hit. */
const LOADED_LCOV = [
  'TN:',
  'SF:public/assets/js/app/a.js',
  'DA:1,1',
  'DA:2,4',
  'DA:3,0',
  'BRDA:2,0,0,4',
  'BRDA:2,0,1,0',
  'LF:3',
  'LH:2',
  'end_of_record',
  ''
].join('\n');

test('parseLcov reads line and branch hits per source file', () => {
  const records = parseLcov(LOADED_LCOV);
  assert.deepEqual([...records.keys()], ['public/assets/js/app/a.js']);
  const record = records.get('public/assets/js/app/a.js');
  assert.deepEqual([...record.lines], [[1, 1], [2, 4], [3, 0]]);
  assert.deepEqual([...record.branches], [['2,0,0', 4], ['2,0,1', 0]]);
});

test('parseLcov counts a "-" branch as not taken and merges repeated records by the higher count', () => {
  const text = [
    'DA:9,9',
    'SF:x.js',
    'DA:1,0',
    'BRDA:1,0,0,-',
    'end_of_record',
    'DA:8,8',
    'SF:x.js',
    'DA:1,2',
    'DA:2,0',
    'BRDA:1,0,0,3',
    'BRDA:1,0,1,-',
    'end_of_record'
  ].join('\n');
  const record = parseLcov(text).get('x.js');
  assert.deepEqual([...record.lines], [[1, 2], [2, 0]]);
  assert.deepEqual([...record.branches], [['1,0,0', 3], ['1,0,1', 0]]);
});

test('countLines counts lines as Node coverage reports them', () => {
  assert.equal(countLines(''), 0);
  assert.equal(countLines('a\n'), 1);
  assert.equal(countLines('a\nb'), 2);
  assert.equal(countLines('a\nb\n'), 2);
});

test('listSources finds JavaScript files outside __tests__ directories', async t => {
  const dir = tempTree(t, {
    'root/b.js': '',
    'root/a.js': '',
    'root/notes.md': '',
    'root/sub/c.js': '',
    'root/__tests__/a.test.js': '',
    'root/sub/__tests__/helper.js': ''
  });
  const root = path.join(dir, 'root');
  assert.deepEqual(await listSources(root), [
    path.join(root, 'a.js'),
    path.join(root, 'b.js'),
    path.join(root, 'sub', 'c.js')
  ]);
});

test('summarise adds the lines of sources no test loaded as uncovered', () => {
  const totals = summarise(parseLcov(LOADED_LCOV), [{ file: 'public/assets/js/app/b.js', lines: 5 }]);
  assert.deepEqual(totals, {
    lines: { covered: 2, total: 8 },
    branches: { covered: 1, total: 2 }
  });
});

test('percent treats an empty total as fully covered', () => {
  assert.equal(percent({ covered: 0, total: 0 }), 100);
  assert.equal(percent({ covered: 1, total: 4 }), 25);
});

test('belowFloors passes at the floor and names each metric below it', () => {
  const totals = { lines: { covered: 3, total: 4 }, branches: { covered: 1, total: 2 } };
  assert.deepEqual(belowFloors(totals, { lines: 75, branches: 50 }), []);
  assert.deepEqual(belowFloors(totals, { lines: 75.001, branches: 50.5 }), [
    'lines 75.000% < 75.001%',
    'branches 50.000% < 50.5%'
  ]);
});

test('parseArgs reads the report path, both floors and the source root', () => {
  assert.deepEqual(parseArgs(['r.lcov', '--lines', '97.5', '--branches', '0']), {
    lcovPath: 'r.lcov',
    sourceRoot: DEFAULT_SOURCE_ROOT,
    floors: { lines: 97.5, branches: 0 }
  });
  assert.equal(
    parseArgs(['--source-root', 'src', '--lines', '1', '--branches', '100', 'r.lcov']).sourceRoot,
    'src'
  );
});

test('parseArgs rejects incomplete or malformed arguments', () => {
  const cases = [
    [['--lines', '1', '--branches', '1'], /missing lcov report path/],
    [['r.lcov', '--branches', '1'], /missing --lines floor/],
    [['r.lcov', '--lines', '1'], /missing --branches floor/],
    [['r.lcov', 'other.lcov'], /unexpected argument other\.lcov/],
    [['r.lcov', '--functions', '1'], /unknown option --functions/],
    [['r.lcov', '--lines'], /--lines needs a value/],
    [['r.lcov', '--lines', ''], /--lines needs a value/],
    [['r.lcov', '--lines', '--branches', '1'], /--lines needs a value/],
    [['r.lcov', '--lines', 'many', '--branches', '1'], /--lines needs a percentage from 0 to 100/],
    [['r.lcov', '--lines', '-1', '--branches', '1'], /--lines needs a percentage from 0 to 100/],
    [['r.lcov', '--lines', '1', '--branches', '100.5'], /--branches needs a percentage from 0 to 100/],
    [['r.lcov', '--source-root'], /--source-root needs a value/]
  ];
  for (const [argv, message] of cases) {
    assert.throws(() => parseArgs(argv), message, argv.join(' '));
  }
});

test('main passes at the floor and reports sources no test loaded', async t => {
  const dir = tempTree(t, {
    'public/assets/js/app/a.js': 'one\ntwo\nthree\n',
    'public/assets/js/app/b.js': 'one\ntwo\n',
    'public/assets/js/app/__tests__/a.test.js': 'test\n',
    'reports/node.lcov': `${LOADED_LCOV}SF:public/assets/js/app/__tests__/a.test.js\nDA:1,1\nend_of_record\n`
  });
  const stdout = sink();
  const stderr = sink();
  const code = await main(['reports/node.lcov', '--lines', '40', '--branches', '50'], { cwd: dir, stdout, stderr });
  assert.equal(code, 0);
  assert.equal(stderr.text, '');
  assert.equal(
    stdout.text,
    'Coverage of public/assets/js: lines 40.000% (2/5, floor 40%), branches 50.000% (1/2, floor 50%)\n' +
      'Never loaded by a test, counted as uncovered lines: public/assets/js/app/b.js\n'
  );
});

test('main reads absolute report paths and fails below a floor', async t => {
  const dir = tempTree(t, { 'public/assets/js/app/a.js': 'one\ntwo\nthree\n' });
  writeFileSync(path.join(dir, 'abs.lcov'), LOADED_LCOV.replace('SF:', `SF:${dir}${path.sep}`));
  const stdout = sink();
  const stderr = sink();
  const code = await main(['abs.lcov', '--lines', '66.667', '--branches', '50'], { cwd: dir, stdout, stderr });
  assert.equal(code, 1);
  assert.equal(stdout.text, 'Coverage of public/assets/js: lines 66.667% (2/3, floor 66.667%), branches 50.000% (1/2, floor 50%)\n');
  assert.equal(stderr.text, 'check-coverage: below the floor: lines 66.667% < 66.667%\n');
});

test('main exits 2 on bad arguments, a missing report or a missing source root', async t => {
  const dir = tempTree(t, { 'reports/node.lcov': LOADED_LCOV });
  const run = async argv => {
    const stderr = sink();
    const code = await main(argv, { cwd: dir, stdout: sink(), stderr });
    return [code, stderr.text];
  };
  assert.deepEqual(await run(['--lines', '1']), [2, 'check-coverage: missing lcov report path\n']);
  const [missingReport, missingReportText] = await run(['none.lcov', '--lines', '1', '--branches', '1']);
  assert.equal(missingReport, 2);
  assert.match(missingReportText, /^check-coverage: cannot read none\.lcov: /);
  const [missingRoot, missingRootText] = await run(['reports/node.lcov', '--lines', '1', '--branches', '1']);
  assert.equal(missingRoot, 2);
  assert.match(missingRootText, /^check-coverage: cannot list public\/assets\/js: /);
});

test('the script run from the command line sets its exit code', t => {
  const dir = tempTree(t, {
    'public/assets/js/app/a.js': 'one\ntwo\nthree\n',
    'reports/node.lcov': LOADED_LCOV
  });
  const run = floor => {
    try {
      return [0, execFileSync(process.execPath, [SCRIPT, 'reports/node.lcov', '--lines', floor, '--branches', '0'], { cwd: dir, encoding: 'utf8', stdio: 'pipe' })];
    } catch (error) {
      return [error.status, error.stderr];
    }
  };
  assert.deepEqual(run('60'), [0, 'Coverage of public/assets/js: lines 66.667% (2/3, floor 60%), branches 50.000% (1/2, floor 0%)\n']);
  assert.deepEqual(run('70'), [1, 'check-coverage: below the floor: lines 66.667% < 70%\n']);
});
