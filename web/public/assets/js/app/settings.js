/**
 * Default configuration values applied when the server omits a field.
 *
 * @type {{
 *   refreshMs: number,
 *   refreshIntervalSeconds: number,
 *   chatEnabled: boolean,
 *   defaultChannel: string,
 *   defaultFrequency: string,
 *   mapCenter: { lat: number, lon: number },
 *   maxNodeDistanceKm: number,
 *   tileFilters: { light: string, dark: string }
 * }}
 */
export const DEFAULT_CONFIG = {
  refreshMs: 60_000,
  refreshIntervalSeconds: 60,
  chatEnabled: true,
  defaultChannel: '#LongFast',
  defaultFrequency: '915MHz',
  mapCenter: { lat: 38.761944, lon: -27.090833 },
  maxNodeDistanceKm: 42,
  tileFilters: {
    light: 'grayscale(1) saturate(0) brightness(0.92) contrast(1.05)',
    dark: 'grayscale(1) invert(1) brightness(0.9) contrast(1.08)'
  }
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
  config.defaultChannel = raw?.defaultChannel || DEFAULT_CONFIG.defaultChannel;
  config.defaultFrequency = raw?.defaultFrequency || DEFAULT_CONFIG.defaultFrequency;
  const maxDistance = Number(raw?.maxNodeDistanceKm ?? DEFAULT_CONFIG.maxNodeDistanceKm);
  config.maxNodeDistanceKm = Number.isFinite(maxDistance)
    ? maxDistance
    : DEFAULT_CONFIG.maxNodeDistanceKm;
  return config;
}
