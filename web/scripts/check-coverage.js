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
 * Coverage floor of the frontend suite (SPEC CV3).
 *
 * `npm test` runs Node's test runner with coverage of the app's own sources,
 * `public/assets/js` without its `__tests__` directories, and writes that
 * coverage as an lcov report. This script reads the report and exits 1 when
 * line or branch coverage falls below the floor given on the command line.
 * V8 reports only files a test imported, so every source no test loaded
 * counts here with all of its lines uncovered. The floors sit 0.1 point
 * below the lowest measured figures and only rise, until coverage reaches
 * 100% (SPEC CV1).
 *
 * Usage, from `web/`:
 * `node scripts/check-coverage.js <lcov> --lines <pct> --branches <pct> [--source-root <dir>]`
 *
 * @module scripts/check-coverage
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

/**
 * Directory, relative to `web/`, whose JavaScript the floor measures: the
 * app's shipped sources. `web/scripts`, CI tooling such as this check and the
 * istanbul exporter, is left out (SPEC CV7).
 */
export const DEFAULT_SOURCE_ROOT = 'public/assets/js';

/** The metrics the floor applies to, in report order. */
const METRICS = ['lines', 'branches'];

/**
 * Line and branch hit counts of one source file.
 *
 * @typedef {Object} CoverageRecord
 * @property {Map<number, number>} lines Hits per line number.
 * @property {Map<string, number>} branches Hits per `line,block,branch` key.
 */

/**
 * Covered and total counts of one metric.
 *
 * @typedef {Object} Count
 * @property {number} covered Items hit at least once.
 * @property {number} total All items.
 */

/**
 * Parse an lcov report into per-file line and branch hit counts.
 *
 * Only `SF`, `DA`, `BRDA` and `end_of_record` matter; summary records are
 * recomputed. Records repeated for one file merge by the higher count, and a
 * `-` branch (its block never ran) counts as not taken.
 *
 * @param {string} text The lcov report.
 * @returns {Map<string, CoverageRecord>} Records keyed by the `SF` path.
 */
export function parseLcov(text) {
  const records = new Map();
  let current = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('SF:')) {
      const file = line.slice(3);
      current = records.get(file) ?? { lines: new Map(), branches: new Map() };
      records.set(file, current);
      continue;
    }
    if (line === 'end_of_record') {
      current = null;
      continue;
    }
    if (!current) continue;
    if (line.startsWith('DA:')) {
      const [lineNumber, hits] = line.slice(3).split(',');
      mergeMax(current.lines, Number(lineNumber), Number(hits));
    } else if (line.startsWith('BRDA:')) {
      const [lineNumber, block, branch, taken] = line.slice(5).split(',');
      mergeMax(current.branches, `${lineNumber},${block},${branch}`, taken === '-' ? 0 : Number(taken));
    }
  }
  return records;
}

/**
 * Store `value` under `key` unless a higher count is already there.
 *
 * @param {Map<*, number>} map Counts to update.
 * @param {*} key Line number or branch key.
 * @param {number} value Hit count.
 * @returns {void}
 */
function mergeMax(map, key, value) {
  map.set(key, Math.max(map.get(key) ?? 0, value));
}

/**
 * Number of lines Node's coverage reports for a file: every line ending in
 * a newline, plus a last line without one.
 *
 * @param {string} source File content.
 * @returns {number} The line count.
 */
export function countLines(source) {
  if (source.length === 0) return 0;
  const breaks = source.split('\n').length - 1;
  return source.endsWith('\n') ? breaks : breaks + 1;
}

/**
 * List the JavaScript files under `root`, skipping `__tests__` directories.
 *
 * @param {string} root Directory to walk.
 * @returns {Promise<string[]>} Paths joined onto `root`, sorted.
 */
export async function listSources(root) {
  const found = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') found.push(...(await listSources(full)));
    } else if (entry.name.endsWith('.js')) {
      found.push(full);
    }
  }
  return found.sort();
}

/**
 * Line and branch totals over the measured records, with the lines of every
 * source no test loaded added as uncovered.
 *
 * @param {Map<string, CoverageRecord>} records Records of loaded sources.
 * @param {Array<{file: string, lines: number}>} unloaded Sources no test loaded.
 * @returns {{lines: Count, branches: Count}} The totals.
 */
export function summarise(records, unloaded) {
  const totals = { lines: { covered: 0, total: 0 }, branches: { covered: 0, total: 0 } };
  for (const { lines, branches } of records.values()) {
    addCounts(totals.lines, lines);
    addCounts(totals.branches, branches);
  }
  for (const { lines } of unloaded) totals.lines.total += lines;
  return totals;
}

/**
 * Add each hit count to a running total.
 *
 * @param {Count} target Totals to update.
 * @param {Map<*, number>} hits Hit counts.
 * @returns {void}
 */
function addCounts(target, hits) {
  for (const count of hits.values()) {
    target.total += 1;
    if (count > 0) target.covered += 1;
  }
}

/**
 * Percentage covered; an empty total counts as fully covered.
 *
 * @param {Count} count Covered and total.
 * @returns {number} Percentage from 0 to 100.
 */
export function percent({ covered, total }) {
  return total === 0 ? 100 : (covered / total) * 100;
}

/**
 * Compare the totals with the floors, unrounded.
 *
 * @param {{lines: Count, branches: Count}} totals Measured totals.
 * @param {{lines: number, branches: number}} floors Minimum percentages.
 * @returns {string[]} One message per metric below its floor.
 */
export function belowFloors(totals, floors) {
  const failures = [];
  for (const metric of METRICS) {
    const actual = percent(totals[metric]);
    if (actual < floors[metric]) failures.push(`${metric} ${actual.toFixed(3)}% < ${floors[metric]}%`);
  }
  return failures;
}

/**
 * Parse the command line.
 *
 * @param {string[]} argv Arguments after the script path.
 * @returns {{lcovPath: string, sourceRoot: string, floors: {lines: number, branches: number}}}
 *   The report path, the measured directory and both floors.
 * @throws {Error} When an argument is missing, unknown or malformed.
 */
export function parseArgs(argv) {
  const options = { sourceRoot: DEFAULT_SOURCE_ROOT, floors: {} };
  const rest = [...argv];
  while (rest.length > 0) {
    const arg = rest.shift();
    if (arg === '--lines' || arg === '--branches') {
      options.floors[arg.slice(2)] = parseFloor(arg, rest.shift());
    } else if (arg === '--source-root') {
      options.sourceRoot = requireValue(arg, rest.shift());
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option ${arg}`);
    } else if (options.lcovPath) {
      throw new Error(`unexpected argument ${arg}`);
    } else {
      options.lcovPath = arg;
    }
  }
  if (!options.lcovPath) throw new Error('missing lcov report path');
  for (const metric of METRICS) {
    if (options.floors[metric] === undefined) throw new Error(`missing --${metric} floor`);
  }
  return options;
}

/**
 * Read a floor percentage.
 *
 * @param {string} flag Option name, for messages.
 * @param {string | undefined} value The option's value.
 * @returns {number} The floor.
 * @throws {Error} When the value is missing or not a percentage.
 */
function parseFloor(flag, value) {
  const floor = Number(requireValue(flag, value));
  if (!Number.isFinite(floor) || floor < 0 || floor > 100) {
    throw new Error(`${flag} needs a percentage from 0 to 100`);
  }
  return floor;
}

/**
 * Require an option value that is not the next option.
 *
 * @param {string} flag Option name, for messages.
 * @param {string | undefined} value The option's value.
 * @returns {string} The value.
 * @throws {Error} When the value is missing.
 */
function requireValue(flag, value) {
  if (value === undefined || value === '' || value.startsWith('--')) {
    throw new Error(`${flag} needs a value`);
  }
  return value;
}

/**
 * Turn an lcov `SF` path into a path relative to `cwd`.
 *
 * @param {string} file The path as the report names it.
 * @param {string} cwd Directory the report's relative paths start from.
 * @returns {string} The relative path.
 */
function relativeTo(file, cwd) {
  return path.isAbsolute(file) ? path.relative(cwd, file) : file;
}

/**
 * Check the coverage report against the floors.
 *
 * @param {string[]} argv Arguments after the script path.
 * @param {{cwd?: string, stdout?: {write: function(string): *}, stderr?: {write: function(string): *}}} [io]
 *   Working directory and output streams; the process's own by default.
 * @returns {Promise<number>} 0 at or above both floors, 1 below one, 2 on
 *   bad arguments or an unreadable report or source root.
 */
export async function main(argv, { cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr } = {}) {
  let options;
  let text;
  let sources;
  try {
    options = parseArgs(argv);
  } catch (error) {
    stderr.write(`check-coverage: ${error.message}\n`);
    return 2;
  }
  try {
    text = await fs.readFile(path.resolve(cwd, options.lcovPath), 'utf8');
  } catch (error) {
    stderr.write(`check-coverage: cannot read ${options.lcovPath}: ${error.message}\n`);
    return 2;
  }
  try {
    sources = (await listSources(path.resolve(cwd, options.sourceRoot))).map(file => path.relative(cwd, file));
  } catch (error) {
    stderr.write(`check-coverage: cannot list ${options.sourceRoot}: ${error.message}\n`);
    return 2;
  }

  // Only the sources count: a report entry for a test file, a helper or a
  // deleted file is left out, whatever the runner's coverage filters were.
  const reported = new Map();
  for (const [file, record] of parseLcov(text)) reported.set(relativeTo(file, cwd), record);
  const measured = new Map();
  const unloaded = [];
  for (const file of sources) {
    if (reported.has(file)) {
      measured.set(file, reported.get(file));
    } else {
      unloaded.push({ file, lines: countLines(await fs.readFile(path.resolve(cwd, file), 'utf8')) });
    }
  }

  const totals = summarise(measured, unloaded);
  const parts = METRICS.map(metric => {
    const { covered, total } = totals[metric];
    return `${metric} ${percent(totals[metric]).toFixed(3)}% (${covered}/${total}, floor ${options.floors[metric]}%)`;
  });
  stdout.write(`Coverage of ${options.sourceRoot}: ${parts.join(', ')}\n`);
  if (unloaded.length > 0) {
    stdout.write(`Never loaded by a test, counted as uncovered lines: ${unloaded.map(entry => entry.file).join(', ')}\n`);
  }
  const failures = belowFloors(totals, options.floors);
  if (failures.length > 0) {
    stderr.write(`check-coverage: below the floor: ${failures.join('; ')}\n`);
    return 1;
  }
  return 0;
}

// Run when executed as a script, not when a test imports the module.
if (import.meta.url === pathToFileURL(path.resolve(String(process.argv[1]))).href) {
  process.exitCode = await main(process.argv.slice(2));
}
