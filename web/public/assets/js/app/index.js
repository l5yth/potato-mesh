import { readAppConfig } from './config.js';
import { initializeApp } from './main.js';

const DEFAULT_CONFIG = {
  refreshMs: 60_000,
  refreshIntervalSeconds: 60,
  chatEnabled: true,
  defaultChannel: '#MediumFast',
  defaultFrequency: '868MHz',
  mapCenter: { lat: 52.502889, lon: 13.404194 },
  maxNodeDistanceKm: 137,
  tileFilters: {
    light: 'grayscale(1) saturate(0) brightness(0.92) contrast(1.05)',
    dark: 'grayscale(1) invert(1) brightness(0.9) contrast(1.08)'
  }
};

function mergeConfig(raw) {
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

document.addEventListener('DOMContentLoaded', () => {
  const rawConfig = readAppConfig();
  const config = mergeConfig(rawConfig);
  initializeApp(config);
});
