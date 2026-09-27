import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrefs } from '../public/prefs.js';

function fakeStorage(init = {}) {
  const map = new Map(Object.entries(init));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

test('prefs returns the fallback when nothing is stored or the value is corrupt', () => {
  const prefs = createPrefs(fakeStorage({ 'prefs.treeDepth': '{not json' }));
  assert.equal(prefs.get('engineOn', true), true);
  assert.equal(prefs.get('treeDepth', 4), 4);
});

test('prefs round-trips JSON values under a namespaced key', () => {
  const storage = fakeStorage();
  const prefs = createPrefs(storage);
  prefs.set('treeDepth', 6);
  prefs.set('arrowsOn', false);
  assert.equal(prefs.get('treeDepth', 4), 6);
  assert.equal(prefs.get('arrowsOn', true), false);
  assert.deepEqual([...storage.map.keys()], ['prefs.treeDepth', 'prefs.arrowsOn']);
});

test('prefs keeps working when storage throws', () => {
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  const prefs = createPrefs(blocked);
  assert.equal(prefs.get('engineOn', true), true);
  assert.doesNotThrow(() => prefs.set('engineOn', false));
});
