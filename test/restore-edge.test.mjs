import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createArchive } from '../lib/store.js';
import { collectRestorePlan, restorePlan } from '../lib/restore.js';

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rewind-edge-'));
  const archive = createArchive({ directory: join(dir, 'archive') });
  return { dir, archive, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a target that became a symlink is skipped, not followed', async () => {
  const { dir, archive, cleanup } = workspace();
  try {
    const real = join(dir, 'real.txt');
    const link = join(dir, 'link.txt');
    writeFileSync(real, 'original\n');
    writeFileSync(link, 'original\n');
    await archive.record({ sessionId: 's1', turn: 1, cwd: dir, absolute: link, displayPath: 'link.txt' });
    rmSync(link);
    symlinkSync(real, link);
    writeFileSync(real, 'changed through the link\n');

    const plan = collectRestorePlan(archive.turnsFrom('s1', 1));
    const summary = await restorePlan({ plan, archive, sessionId: 's1' });
    assert.equal(summary.skipped, 1);
    assert.equal(summary.restored, 0);
    assert.equal(readFileSync(real, 'utf8'), 'changed through the link\n', 'the link target is untouched');
    assert.equal(readFileSync(link, 'utf8'), 'changed through the link\n');
  } finally {
    await archive.close();
    cleanup();
  }
});

test('binary pre-images are written back byte for byte', async () => {
  const { dir, archive, cleanup } = workspace();
  try {
    const file = join(dir, 'blob.bin');
    const original = Buffer.from([0, 1, 2, 255, 254, 0, 7]);
    writeFileSync(file, original);
    const captured = await archive.record({ sessionId: 's1', turn: 1, cwd: dir, absolute: file, displayPath: 'blob.bin' });
    assert.equal(captured.text, false);
    writeFileSync(file, Buffer.from([9, 9, 9]));

    const plan = collectRestorePlan(archive.turnsFrom('s1', 1));
    const summary = await restorePlan({ plan, archive, sessionId: 's1' });
    assert.equal(summary.restored, 1);
    assert.deepEqual(readFileSync(file), original);
  } finally {
    await archive.close();
    cleanup();
  }
});

test('an empty file is restored as empty', async () => {
  const { dir, archive, cleanup } = workspace();
  try {
    const file = join(dir, 'empty.txt');
    writeFileSync(file, '');
    const captured = await archive.record({ sessionId: 's1', turn: 1, cwd: dir, absolute: file, displayPath: 'empty.txt' });
    assert.equal(captured.existed, true);
    writeFileSync(file, 'no longer empty\n');
    const plan = collectRestorePlan(archive.turnsFrom('s1', 1));
    const summary = await restorePlan({ plan, archive, sessionId: 's1' });
    assert.equal(summary.restored, 1);
    assert.equal(readFileSync(file, 'utf8'), '');
  } finally {
    await archive.close();
    cleanup();
  }
});

test('a directory target is never recorded', async () => {
  const { dir, archive, cleanup } = workspace();
  try {
    const captured = await archive.record({ sessionId: 's1', turn: 1, cwd: dir, absolute: dir, displayPath: 'dir' });
    assert.equal(captured, null);
  } finally {
    await archive.close();
    cleanup();
  }
});
