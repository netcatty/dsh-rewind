import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createArchive } from '../lib/store.js';

async function seeded() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rewind-integrity-'));
  const archiveDir = join(dir, 'archive');
  const archive = createArchive({ directory: archiveDir });
  const file = join(dir, 'notes.txt');
  writeFileSync(file, 'before\n');
  await archive.record({ sessionId: 's1', turn: 1, cwd: dir, absolute: file, displayPath: 'notes.txt' });
  await archive.quarantine({
    sessionId: 's1',
    turn: 1,
    path: file,
    displayPath: 'notes.txt',
    bytes: Buffer.from('displaced\n'),
    reason: 'replaced',
  });
  return { dir, archiveDir, archive, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a healthy archive reports no issues', async () => {
  const { archive, cleanup } = await seeded();
  try {
    const report = archive.integrity();
    assert.equal(report.ok, true);
    assert.equal(report.missingBlobs, 0);
    assert.equal(report.orphanBlobs, 0);
    assert.equal(report.quarantineMissing, 0);
    assert.equal(report.corruptManifestLines, 0);
  } finally {
    await archive.close();
    cleanup();
  }
});

test('a missing snapshot blob is reported with a sample', async () => {
  const { archive, archiveDir, cleanup } = await seeded();
  try {
    const turn = archive.get('s1', 1);
    const blob = join(archiveDir, 'blobs', turn.files[0].blob);
    unlinkSync(blob);
    const report = archive.integrity();
    assert.equal(report.ok, false);
    assert.equal(report.missingBlobs, 1);
    assert.equal(report.samples.length, 1);
    assert.equal(report.samples[0].path, 'notes.txt');
  } finally {
    await archive.close();
    cleanup();
  }
});

test('an unreferenced blob is reported as orphan', async () => {
  const { archive, archiveDir, cleanup } = await seeded();
  try {
    writeFileSync(join(archiveDir, 'blobs', `${'0'.repeat(64)}.bin`), 'orphan');
    const report = archive.integrity();
    assert.equal(report.orphanBlobs, 1);
    assert.equal(report.ok, false);
  } finally {
    await archive.close();
    cleanup();
  }
});

test('a torn quarantine manifest line is reported', async () => {
  const { archive, archiveDir, cleanup } = await seeded();
  try {
    appendFileSync(join(archiveDir, 'quarantine', 'manifest.jsonl'), '{"broken": \n');
    const report = archive.integrity();
    assert.equal(report.corruptManifestLines, 1);
    assert.equal(report.ok, false);
    assert.equal(readFileSync(join(archiveDir, 'quarantine', 'manifest.jsonl'), 'utf8').includes('broken'), true);
  } finally {
    await archive.close();
    cleanup();
  }
});
