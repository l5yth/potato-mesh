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
 * Stable numeric limits shared between ``main.js`` and the helpers extracted
 * into ``main/`` submodules.
 *
 * @module main/constants
 */

import { SNAPSHOT_WINDOW } from '../snapshot-aggregator.js';

/** Maximum number of node rows requested from the API. */
export const NODE_LIMIT = 1000;

/** Maximum number of trace rows requested from the API. */
export const TRACE_LIMIT = 200;

/** Maximum age (seconds) for traces displayed on the map. */
export const TRACE_MAX_AGE_SECONDS = 28 * 24 * 60 * 60;

/** Snapshot multiplier — how many rows we ask for to build a richer aggregate. */
export const SNAPSHOT_LIMIT = SNAPSHOT_WINDOW;
