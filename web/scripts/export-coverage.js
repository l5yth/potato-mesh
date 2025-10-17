/*
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

import { promises as fs } from 'node:fs';
import path from 'node:path';

import istanbulLibCoverage from 'istanbul-lib-coverage';
import istanbulLibReport from 'istanbul-lib-report';
import istanbulReports from 'istanbul-reports';
import v8toIstanbul from 'v8-to-istanbul';

const { createCoverageMap } = istanbulLibCoverage;
const { createContext } = istanbulLibReport;

const coverageDir = path.resolve('coverage');
const reportsDir = path.resolve('reports');
const jsonOutputName = 'javascript-coverage.json';
const lcovOutputName = 'javascript-coverage.lcov';
const projectRoot = process.cwd();

/**
 * Ensure the reports directory exists so that coverage artefacts can be written.
 *
 * @returns {Promise<void>} A promise that resolves when the directory is available.
 */
async function ensureReportsDir() {
  try {
    await fs.mkdir(reportsDir, { recursive: true });
  } catch (error) {
    console.error('Failed to ensure reports directory', error);
    process.exit(1);
  }
}

/**
 * Read the coverage directory and return a deterministically ordered list of JSON files.
 *
 * @returns {Promise<string[]>} The absolute paths of available coverage JSON artefacts.
 */
async function listCoverageFiles() {
  let entries;
  try {
    entries = await fs.readdir(coverageDir);
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.warn('Coverage directory not found; skipping export.');
      return [];
    }
    throw error;
  }

  const coverageFiles = entries
    .filter(name => name.endsWith('.json'))
    .map(name => path.join(coverageDir, name))
    .sort();

  if (!coverageFiles.length) {
    console.warn('No coverage files generated; skipping export.');
    return [];
  }

  return coverageFiles;
}

/**
 * Convert a V8 coverage URL to a project-local filesystem path.
 *
 * @param {string | undefined} url The coverage URL emitted by V8.
 * @returns {string | null} A normalised absolute path, or null when the URL should be ignored.
 */
function normaliseFileUrl(url) {
  if (!url || url.startsWith('node:')) {
    return null;
  }

  if (!url.startsWith('file://')) {
    return null;
  }

  let filePath;
  try {
    filePath = decodeURIComponent(new URL(url).pathname);
  } catch {
    return null;
  }

  if (!filePath.startsWith(projectRoot)) {
    return null;
  }

  if (filePath.includes('node_modules')) {
    return null;
  }

  return filePath;
}

/**
 * Transform the raw V8 coverage reports into an Istanbul coverage map.
 *
 * @param {string[]} coverageFiles A list of coverage artefacts to consume.
 * @returns {Promise<import('istanbul-lib-coverage').CoverageMap>} The aggregated coverage map.
 */
async function buildCoverageMap(coverageFiles) {
  const coverageMap = createCoverageMap({});

  for (const file of coverageFiles) {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    const entries = Array.isArray(parsed.result) ? parsed.result : [];

    for (const entry of entries) {
      const { url, functions } = entry;
      const filePath = normaliseFileUrl(url);
      if (!filePath) {
        continue;
      }

      try {
        const converter = v8toIstanbul(filePath, 0, {
          source: await fs.readFile(filePath, 'utf8'),
        });
        await converter.load();
        converter.applyCoverage(functions);
        const fileCoverages = converter.toIstanbul();
        for (const coverage of Object.values(fileCoverages)) {
          if (coverage.path) {
            const relativePath = path.relative(projectRoot, coverage.path);
            coverage.path = relativePath || coverage.path;
          }
          try {
            const existingCoverage = coverageMap.fileCoverageFor(coverage.path);
            existingCoverage.merge(coverage);
          } catch (error) {
            if (error && typeof error.message === 'string' && error.message.includes('No file coverage')) {
              coverageMap.addFileCoverage(coverage);
            } else {
              throw error;
            }
          }
        }
      } catch (error) {
        console.warn(`Failed to translate coverage for ${filePath}:`, error);
      }
    }
  }

  return coverageMap;
}

/**
 * Persist the Istanbul coverage map as JSON and LCOV artefacts for downstream tooling.
 *
 * @param {import('istanbul-lib-coverage').CoverageMap} coverageMap The populated coverage map.
 * @returns {Promise<void>} A promise that resolves when the outputs are written.
 */
async function writeCoverageOutputs(coverageMap) {
  const jsonOutputPath = path.join(reportsDir, jsonOutputName);
  const lcovOutputPath = path.join(reportsDir, lcovOutputName);

  await fs.writeFile(jsonOutputPath, `${JSON.stringify(coverageMap.toJSON(), null, 2)}\n`);

  const context = createContext({ dir: reportsDir, coverageMap });
  istanbulReports.create('lcovonly', { file: lcovOutputName }).execute(context);

  console.log(`Wrote coverage reports to ${jsonOutputPath} and ${lcovOutputPath}`);
}

await ensureReportsDir();
const coverageFiles = await listCoverageFiles();
if (!coverageFiles.length) {
  process.exit(0);
}

const coverageMap = await buildCoverageMap(coverageFiles);
if (!coverageMap.files().length) {
  console.warn('No project coverage entries were recognised; skipping export.');
  process.exit(0);
}

await writeCoverageOutputs(coverageMap);
