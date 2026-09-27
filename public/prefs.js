// Small per-browser preferences (engine on/off, book arrows, tree depth) in
// localStorage. Every access is guarded: private windows and blocked storage
// must never break the page, they just forget between visits.

const PREFIX = 'prefs.';

function defaultStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function createPrefs(storage = defaultStorage()) {
  return {
    get(key, fallback) {
      try {
        const raw = storage?.getItem(PREFIX + key);
        return raw === null || raw === undefined ? fallback : JSON.parse(raw);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        storage?.setItem(PREFIX + key, JSON.stringify(value));
      } catch {
        // storage unavailable: keep going without persistence
      }
    },
  };
}
