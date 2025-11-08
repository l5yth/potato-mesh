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

import { readAppConfig } from './config.js';
import { initializeApp } from './main.js';
import { DEFAULT_CONFIG, mergeConfig } from './settings.js';

export { DEFAULT_CONFIG, mergeConfig } from './settings.js';

/**
 * Bootstraps the application once the DOM is ready by reading configuration
 * data and delegating to ``initializeApp``.
 *
 * @returns {void}
 */
document.addEventListener('DOMContentLoaded', () => {
  const rawConfig = readAppConfig();
  const config = mergeConfig(rawConfig);
  initializeApp(config);
});
