import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTheme, normalizePreference, THEMES } from '../public/theme.js';

test('normalizePreference accepts light, dark and auto and falls back to auto', () => {
  assert.equal(normalizePreference('light'), 'light');
  assert.equal(normalizePreference('dark'), 'dark');
  assert.equal(normalizePreference('auto'), 'auto');
  assert.equal(normalizePreference(null), 'auto');
  assert.equal(normalizePreference('purple'), 'auto');
  assert.deepEqual(THEMES, ['auto', 'light', 'dark']);
});

test('resolveTheme follows the system only when the preference is auto', () => {
  assert.equal(resolveTheme('auto', true), 'dark');
  assert.equal(resolveTheme('auto', false), 'light');
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('dark', false), 'dark');
});
