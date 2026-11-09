import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createArchive } from '../lib/store.js';
import { collectRestorePlan, restorePlan } from '../lib/restore.js';

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rewind-quarantine-'));
  const archiveDir = join(dir, 'archive');
  const archive = createArchive({ directory: archiveDir });
  return { dir, archiveDir, archive, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a restore keeps the displaced content in quarantine', async () => {
  const { dir, archiveDir, archive, cleanup } = workspace();
  try {
    const file = join(dir, 'notes.txt');
    writeFileSync(file, 'original\n');
    await archive.record({ sessionId: 's1', turn: 1, cwd: dir, absolute: file, displayPath: 'notes.txt' });
    writeFileSync(file, 'external edit\n');

    assert.equal(archive.stats().quarantine.entries, 0);
    const plan = collectRestorePlan(archive.turnsFrom('s1', 1));
    await restorePlan({ plan, archive, sessionId: 's1' });

    assert.equal(readFileSync(file, 'utf8'), 'original\n');
    const stats = archive.stats().quarantine;
    assert.equal(stats.entries, 1);
    assert.equal(stats.bytes, 'external edit\n'.length);

    const manifest = readFileSync(join(archiveDir, 'quarantine', 'manifest.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(manifest.length, 1);
    assert.equal(manifest[0].path, file);
    assert.equal(manifest[0].reason, 'replaced');
    assert.equal(readFileSync(join(archiveDir, 'quarantine', manifest[0].blob), 'utf8'), 'external edit\n');
  } finally {
    await archive.close();
    cleanup();
  }
});

test('deleting a file the Turn created quarantines the deleted bytes', async () => {
  const { dir, archiveDir, archive, cleanup } = workspace();
  try {
    const file = join(dir, 'created.txt');
    await archive.record({ sessionId: 's1', turn: 2, cwd: dir, absolute: file, displayPath: 'created.txt' });
    writeFileSync(file, 'written after\n');
    const plan = collectRestorePlan(archive.turnsFrom('s1', 2));
    await restorePlan({ plan, archive, sessionId: 's1' });
    assert.equal(existsSync(file), false);
    const manifest = readFileSync(join(archiveDir, 'quarantine', 'manifest.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(manifest[0].reason, 'deleted');
    assert.equal(readFileSync(join(archiveDir, 'quarantine', manifest[0].blob), 'utf8'), 'written after\n');
  } finally {
    await archive.close();
    cleanup();
  }
});

test('unchanged content is not quarantined', async () => {
  const { dir, archive, cleanup } = workspace();
  try {
    const file = join(dir, 'same.txt');
    writeFileSync(file, 'same\n');
    await archive.record({ sessionId: 's1', turn: 1, cwd: dir, absolute: file, displayPath: 'same.txt' });
    const plan = collectRestorePlan(archive.turnsFrom('s1', 1));
    await restorePlan({ plan, archive, sessionId: 's1' });
    assert.equal(archive.stats().quarantine.entries, 0);
  } finally {
    await archive.close();
    cleanup();
  }
});

test('clearQuarantine removes the blobs and the manifest rows', async () => {
  const { dir, archiveDir, archive, cleanup } = workspace();
  try {
    const file = join(dir, 'gone.txt');
    writeFileSync(file, 'old\n');
    await archive.record({ sessionId: 's1', turn: 1, cwd: dir, absolute: file, displayPath: 'gone.txt' });
    writeFileSync(file, 'new\n');
    await restorePlan({ plan: collectRestorePlan(archive.turnsFrom('s1', 1)), archive, sessionId: 's1' });
    assert.equal(archive.stats().quarantine.entries, 1);
    await archive.clearQuarantine();
    assert.equal(archive.stats().quarantine.entries, 0);
    assert.equal(readFileSync(join(archiveDir, 'quarantine', 'manifest.jsonl'), 'utf8'), '');
  } finally {
    await archive.close();
    cleanup();
  }
});
