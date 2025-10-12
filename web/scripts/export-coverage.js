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

const coverageDir = 'coverage';
const reportsDir = 'reports';
const outputPath = path.join(reportsDir, 'javascript-coverage.json');

async function ensureReportsDir() {
  try {
    await fs.mkdir(reportsDir, { recursive: true });
  } catch (error) {
    console.error('Failed to ensure reports directory', error);
    process.exit(1);
  }
}

async function copyLatestCoverage() {
  let entries;
  try {
    entries = await fs.readdir(coverageDir);
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.warn('Coverage directory not found; skipping export.');
      return;
    }
    throw error;
  }

  const coverageFiles = entries.filter(name => name.endsWith('.json'));
  if (!coverageFiles.length) {
    console.warn('No coverage files generated; skipping export.');
    return;
  }

  // Sort to pick the most recent entry deterministically.
  coverageFiles.sort();
  const latest = coverageFiles[coverageFiles.length - 1];
  const source = path.join(coverageDir, latest);

  await fs.copyFile(source, outputPath);
  console.log(`Copied coverage report to ${outputPath}`);
}

await ensureReportsDir();
await copyLatestCoverage();
