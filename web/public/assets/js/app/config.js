/**
 * CSS selector used to locate the embedded configuration element.
 *
 * @type {string}
 */
const CONFIG_SELECTOR = '[data-app-config]';

/**
 * Read and parse the serialized application configuration from the DOM.
 *
 * @returns {Object<string, *>} Parsed configuration object or an empty object when unavailable.
 */
export function readAppConfig() {
  const el = document.querySelector(CONFIG_SELECTOR);
  if (!el) {
    return {};
  }
  const raw = el.getAttribute('data-app-config') || '';
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch (err) {
    console.error('Failed to parse application configuration', err);
    return {};
  }
}
