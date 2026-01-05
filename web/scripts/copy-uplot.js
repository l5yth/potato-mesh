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

import { mkdir, copyFile, access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolve an absolute path relative to this script location.
 *
 * @param {string[]} segments Path segments to append.
 * @returns {string} Absolute path resolved from this script.
 */
function resolvePath(...segments) {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(scriptDir, ...segments);
}

/**
 * Ensure the uPlot assets are available within the public asset tree.
 *
 * @returns {Promise<void>} Resolves once files have been copied.
 */
async function copyUPlotAssets() {
  const sourceDir = resolvePath('..', 'node_modules', 'uplot', 'dist');
  const targetDir = resolvePath('..', 'public', 'assets', 'vendor', 'uplot');
  const assets = ['uPlot.iife.min.js', 'uPlot.min.css'];

  await access(sourceDir, fsConstants.R_OK);
  await mkdir(targetDir, { recursive: true });

  await Promise.all(
    assets.map(async asset => {
      const source = path.join(sourceDir, asset);
      const target = path.join(targetDir, asset);
      await copyFile(source, target);
    }),
  );
}

await copyUPlotAssets();
