// Colour theme. The preference is 'auto' (follow the OS), 'light' or 'dark',
// stored in localStorage. The <html> element carries data-theme="light" or
// "dark" for a forced choice and no attribute for auto; style.css keys on it.
// index.html applies the stored attribute inline before first paint, so this
// module only has to keep it in sync afterwards. Nothing here touches the DOM
// at import time, so the pure helpers can be unit tested in Node.

export const THEMES = ['auto', 'light', 'dark'];
const STORAGE_KEY = 'theme';

export function normalizePreference(value) {
  return THEMES.includes(value) ? value : 'auto';
}

/** The theme actually shown for a preference, given the OS setting. */
export function resolveTheme(preference, prefersDark) {
  const p = normalizePreference(preference);
  if (p === 'auto') return prefersDark ? 'dark' : 'light';
  return p;
}

function storage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function getPreference() {
  return normalizePreference(storage()?.getItem(STORAGE_KEY));
}

function systemDark() {
  return window.matchMedia('(prefers-color-scheme: dark)');
}

export function currentTheme() {
  return resolveTheme(getPreference(), systemDark().matches);
}

function apply(preference) {
  const root = document.documentElement;
  if (preference === 'auto') delete root.dataset.theme;
  else root.dataset.theme = preference;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(root).getPropertyValue('--surface').trim();
}

/**
 * Apply the stored preference, and call onChange(theme) whenever the theme
 * actually shown changes, whether from a click or from the OS.
 */
export function initTheme({ onChange = () => {} } = {}) {
  let shown = currentTheme();
  const sync = () => {
    apply(getPreference());
    const next = currentTheme();
    if (next !== shown) {
      shown = next;
      onChange(shown);
    }
  };
  apply(getPreference());
  systemDark().addEventListener('change', sync);
  return {
    get preference() { return getPreference(); },
    get theme() { return shown; },
    set(preference) {
      const p = normalizePreference(preference);
      try {
        if (p === 'auto') storage()?.removeItem(STORAGE_KEY);
        else storage()?.setItem(STORAGE_KEY, p);
      } catch {
        // private mode or blocked storage: the choice still applies to this page
      }
      sync();
    },
  };
}
