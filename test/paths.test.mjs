import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import test from 'node:test';
import { defaultArchiveDir, expandPath, dshHome } from '../lib/paths.js';

test('a tilde expands to the home directory', () => {
  assert.equal(expandPath('~/snapshots'), join(homedir(), 'snapshots'));
  assert.equal(expandPath('~'), homedir());
  assert.equal(expandPath(`~${sep}snapshots`), join(homedir(), 'snapshots'));
});

test('the default archive directory sits under the application directory', () => {
  assert.equal(defaultArchiveDir(), join(dshHome(), 'dsh-plugins', 'dsh-rewind', 'archive'));
});

test('an absolute path is kept absolute', () => {
  const absolute = join(sep, 'var', 'lib', 'snapshots');
  assert.equal(expandPath(absolute), absolute);
});

test('a relative path resolves against the current directory', () => {
  assert.equal(expandPath('snapshots'), resolve(process.cwd(), 'snapshots'));
  assert.equal(expandPath('  snapshots  '), resolve(process.cwd(), 'snapshots'));
});

test('blank values are reported as unset', () => {
  assert.equal(expandPath(''), '');
  assert.equal(expandPath('   '), '');
  assert.equal(expandPath(undefined), '');
});
