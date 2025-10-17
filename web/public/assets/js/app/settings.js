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

/**
 * Default configuration values applied when the server omits a field.
 *
 * @type {{
 *   refreshMs: number,
 *   refreshIntervalSeconds: number,
 *   chatEnabled: boolean,
 *   channel: string,
 *   frequency: string,
 *   contactLink: string,
 *   contactLinkUrl: string | null,
 *   mapCenter: { lat: number, lon: number },
 *   maxDistanceKm: number,
 *   tileFilters: { light: string, dark: string },
 *   instanceDomain: string,
 *   privateMode: boolean,
 *   federationEnabled: boolean
 * }}
 */
export const DEFAULT_CONFIG = {
  refreshMs: 60_000,
  refreshIntervalSeconds: 60,
  chatEnabled: true,
  channel: '#LongFast',
  frequency: '915MHz',
  contactLink: '#potatomesh:dod.ngo',
  contactLinkUrl: 'https://matrix.to/#/#potatomesh:dod.ngo',
  mapCenter: { lat: 38.761944, lon: -27.090833 },
  maxDistanceKm: 42,
  tileFilters: {
    light: 'grayscale(1) saturate(0) brightness(0.92) contrast(1.05)',
    dark: 'grayscale(1) invert(1) brightness(0.9) contrast(1.08)'
  },
  instanceDomain: '',
  privateMode: false,
  federationEnabled: true
};

/**
 * Merge raw configuration data from the DOM with the defaults.
 *
 * @param {Object<string, *>} raw Partial configuration read from ``readAppConfig``.
 * @returns {typeof DEFAULT_CONFIG} Fully populated configuration object.
 */
export function mergeConfig(raw) {
  const config = { ...DEFAULT_CONFIG, ...(raw || {}) };
  config.mapCenter = {
    lat: Number(raw?.mapCenter?.lat ?? DEFAULT_CONFIG.mapCenter.lat),
    lon: Number(raw?.mapCenter?.lon ?? DEFAULT_CONFIG.mapCenter.lon)
  };
  config.tileFilters = {
    light: raw?.tileFilters?.light || DEFAULT_CONFIG.tileFilters.light,
    dark: raw?.tileFilters?.dark || DEFAULT_CONFIG.tileFilters.dark
  };
  const refreshIntervalSeconds = Number(
    raw?.refreshIntervalSeconds ?? DEFAULT_CONFIG.refreshIntervalSeconds
  );
  config.refreshIntervalSeconds = Number.isFinite(refreshIntervalSeconds)
    ? refreshIntervalSeconds
    : DEFAULT_CONFIG.refreshIntervalSeconds;
  const refreshMs = Number(raw?.refreshMs ?? config.refreshIntervalSeconds * 1000);
  config.refreshMs = Number.isFinite(refreshMs) ? refreshMs : DEFAULT_CONFIG.refreshMs;
  config.chatEnabled = Boolean(raw?.chatEnabled ?? DEFAULT_CONFIG.chatEnabled);
  config.channel = raw?.channel || DEFAULT_CONFIG.channel;
  config.frequency = raw?.frequency || DEFAULT_CONFIG.frequency;
  config.contactLink = raw?.contactLink || DEFAULT_CONFIG.contactLink;
  config.contactLinkUrl = raw?.contactLinkUrl ?? DEFAULT_CONFIG.contactLinkUrl;
  const maxDistance = Number(raw?.maxDistanceKm ?? DEFAULT_CONFIG.maxDistanceKm);
  config.maxDistanceKm = Number.isFinite(maxDistance)
    ? maxDistance
    : DEFAULT_CONFIG.maxDistanceKm;
  config.instanceDomain = typeof raw?.instanceDomain === 'string'
    ? raw.instanceDomain
    : DEFAULT_CONFIG.instanceDomain;
  config.privateMode = Boolean(raw?.privateMode ?? DEFAULT_CONFIG.privateMode);
  config.federationEnabled = Boolean(
    raw?.federationEnabled ?? DEFAULT_CONFIG.federationEnabled
  );
  return config;
}
