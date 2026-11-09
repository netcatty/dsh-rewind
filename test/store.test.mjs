import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createArchive, isInsideGitMetadata, turnKey } from '../lib/store.js';

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rewind-store-'));
  const archiveDir = join(dir, 'archive');
  const file = join(dir, 'notes.txt');
  writeFileSync(file, 'before\n');
  const archive = createArchive({ directory: archiveDir });
  return { dir, archiveDir, file, archive, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a pre-image is captured once per Turn and file', async () => {
  const { dir, file, archive, cleanup } = workspace();
  try {
    const first = await archive.record({ sessionId: 's1', turn: 1, cwd: dir, absolute: file, displayPath: 'notes.txt' });
    assert.equal(first.existed, true);
    assert.equal(first.text, true);
    writeFileSync(file, 'after\n');
    const second = await archive.record({ sessionId: 's1', turn: 1, cwd: dir, absolute: file, displayPath: 'notes.txt' });
    assert.equal(second, null, 'the first pre-image of a Turn wins');
    const turn = archive.get('s1', 1);
    assert.equal(turn.files.length, 1);
    assert.equal(archive.readBlob(turn.files[0].blob).toString('utf8'), 'before\n');
    assert.equal(archive.stats().turns, 1);
    assert.equal(archive.stats().files, 1);
  } finally {
    await archive.close();
    cleanup();
  }
});

test('a file created during the Turn is recorded as absent', async () => {
  const { dir, archive, cleanup } = workspace();
  try {
    const missing = join(dir, 'created.txt');
    const captured = await archive.record({ sessionId: 's1', turn: 2, cwd: dir, absolute: missing, displayPath: 'created.txt' });
    assert.equal(captured.existed, false);
    assert.equal(captured.blob, null);
  } finally {
    await archive.close();
    cleanup();
  }
});

test('turnsFrom returns oldest first and stays per session', async () => {
  const { dir, file, archive, cleanup } = workspace();
  try {
    await archive.record({ sessionId: 's1', turn: 3, cwd: dir, absolute: file, displayPath: 'a.txt' });
    await archive.record({ sessionId: 's1', turn: 1, cwd: dir, absolute: file, displayPath: 'a.txt' });
    await archive.record({ sessionId: 's2', turn: 2, cwd: dir, absolute: file, displayPath: 'a.txt' });
    assert.deepEqual(archive.turnsFrom('s1', 2).map((turn) => turn.turn), [3]);
    assert.deepEqual(archive.turnsFrom('s1', 1).map((turn) => turn.turn), [1, 3]);
    assert.deepEqual(archive.sessionTurns('s1').map((turn) => turn.turn), [3, 1]);
  } finally {
    await archive.close();
    cleanup();
  }
});

test('git metadata is never archived', async () => {
  const { dir, archive, cleanup } = workspace();
  try {
    const gitFile = join(dir, '.git', 'HEAD');
    assert.equal(isInsideGitMetadata(gitFile), true);
    assert.equal(isInsideGitMetadata(join(dir, 'src', 'main.js')), false);
    const captured = await archive.record({ sessionId: 's1', turn: 1, cwd: dir, absolute: gitFile, displayPath: '.git/HEAD' });
    assert.equal(captured, null);
  } finally {
    await archive.close();
    cleanup();
  }
});

test('too-large files keep metadata only and are reported', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rewind-large-'));
  try {
    const file = join(dir, 'big.bin');
    writeFileSync(file, Buffer.alloc(4096, 7));
    const archive = createArchive({ directory: join(dir, 'archive'), maxFileBytes: 1024 });
    const captured = await archive.record({ sessionId: 's1', turn: 1, cwd: dir, absolute: file, displayPath: 'big.bin' });
    assert.equal(captured.existed, true);
    assert.equal(captured.blob, null);
    assert.equal(captured.reason, 'too-large');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the index survives a reopen and clear removes referenced blobs', async () => {
  const { dir, file, archiveDir, archive, cleanup } = workspace();
  try {
    await archive.record({ sessionId: 's1', turn: 1, cwd: dir, absolute: file, displayPath: 'notes.txt' });
    await archive.close();
    const reopened = createArchive({ directory: archiveDir });
    assert.equal(reopened.get('s1', 1).files.length, 1);
    await reopened.clear();
    assert.deepEqual(reopened.stats().turns, 0);
    const index = JSON.parse(readFileSync(join(archiveDir, 'index.json'), 'utf8'));
    assert.deepEqual(Object.keys(index.turns), []);
  } finally {
    cleanup();
  }
});

test('turn keys are stable', () => {
  assert.equal(turnKey('session-1', 4), 'session-1|4');
});
