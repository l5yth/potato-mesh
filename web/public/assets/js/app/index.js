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
