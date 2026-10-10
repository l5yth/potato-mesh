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
 * Entry module of the `/charts` view: starts the charts page when it loads.
 *
 * `views/charts.erb` loads it with `<script type="module" src>`, which the
 * Content-Security-Policy allows by origin, where an inline module would need
 * a hash (SPEC HD3). The import map versions it and `charts-page.js` (AV3).
 *
 * @module charts-page-boot
 */

import { initializeChartsPage } from './charts-page.js';

/**
 * The charts page initialisation, started when this module is evaluated.
 *
 * @type {Promise<boolean>}
 */
export const chartsPageReady = initializeChartsPage();
