import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { normalizeSettings, readSettingsFile, resolveLimits, writeSettingsFile } from '../lib/settings.js';

test('missing values fall back to the built-in defaults', () => {
  assert.deepEqual(normalizeSettings(undefined), {
    maxFileBytes: 2 * 1024 * 1024,
    maxFilesPerTurn: 200,
    maxTurns: 500,
  });
});

test('out-of-range values keep the previous value instead of disabling pruning', () => {
  const previous = { maxTurns: 300 };
  const settings = normalizeSettings({ maxTurns: 0, maxFilesPerTurn: 50 }, previous);
  assert.equal(settings.maxTurns, 300);
  assert.equal(settings.maxFilesPerTurn, 50);
});

test('unknown keys are dropped', () => {
  const settings = normalizeSettings({ maxTurns: 10, nonsense: true });
  assert.deepEqual(Object.keys(settings).sort(), ['maxFileBytes', 'maxFilesPerTurn', 'maxTurns']);
});

test('settings win over the plugin row, which wins over the default', () => {
  const resolved = resolveLimits({ maxTurns: 10 }, { maxTurns: 20, maxFilesPerTurn: 30 });
  assert.equal(resolved.maxTurns, 10);
  assert.equal(resolved.maxFilesPerTurn, 30);
  assert.equal(resolved.maxFileBytes, 2 * 1024 * 1024);
});

test('a settings file round-trips and a corrupt file reads as absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rewind-settings-'));
  try {
    const written = writeSettingsFile(dir, { maxTurns: 42, maxFilesPerTurn: 7 });
    assert.equal(written.maxTurns, 42);
    assert.deepEqual(readSettingsFile(dir), written);
    writeFileSync(join(dir, 'settings.json'), '{broken');
    assert.equal(readSettingsFile(dir), null);
    const text = readFileSync(join(dir, 'settings.json'), 'utf8');
    assert.equal(text.startsWith('{broken'), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the archive switch is a boolean and defaults to the plugin row', () => {
  assert.equal(normalizeSettings({ archiveFiles: false }).archiveFiles, false);
  assert.equal(resolveLimits({ archiveFiles: false }, { archiveFiles: true }).archiveFiles, false);
  assert.equal(resolveLimits({}, { archiveFiles: false }).archiveFiles, false);
  assert.equal(resolveLimits({}, {}).archiveFiles, true);
});
