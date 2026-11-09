import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createArchive } from '../lib/store.js';
import { collectRestorePlan, restorePlan } from '../lib/restore.js';

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rewind-restore-'));
  const archive = createArchive({ directory: join(dir, 'archive') });
  return { dir, archive, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a restore only touches the selected files', async () => {
  const { dir, archive, cleanup } = workspace();
  try {
    const a = join(dir, 'a.txt');
    const b = join(dir, 'b.txt');
    writeFileSync(a, 'before-a\n');
    writeFileSync(b, 'before-b\n');
    await archive.record({ sessionId: 's1', turn: 1, cwd: dir, absolute: a, displayPath: 'a.txt' });
    await archive.record({ sessionId: 's1', turn: 1, cwd: dir, absolute: b, displayPath: 'b.txt' });
    writeFileSync(a, 'after-a\n');
    writeFileSync(b, 'after-b\n');

    const plan = collectRestorePlan(archive.turnsFrom('s1', 1));
    const onlyA = plan.filter((entry) => entry.file.path === a);
    const summary = await restorePlan({ plan: onlyA, archive, sessionId: 's1' });
    assert.equal(summary.restored, 1);
    assert.equal(readFileSync(a, 'utf8'), 'before-a\n');
    assert.equal(readFileSync(b, 'utf8'), 'after-b\n', 'an unselected file keeps its edit');
  } finally {
    await archive.close();
    cleanup();
  }
});

test('a file already at its recorded state is unchanged, not rewritten', async () => {
  const { dir, archive, cleanup } = workspace();
  try {
    const file = join(dir, 'notes.txt');
    writeFileSync(file, 'same\n');
    await archive.record({ sessionId: 's1', turn: 1, cwd: dir, absolute: file, displayPath: 'notes.txt' });
    const plan = collectRestorePlan(archive.turnsFrom('s1', 1));
    const summary = await restorePlan({ plan, archive, sessionId: 's1' });
    assert.equal(summary.unchanged, 1);
    assert.equal(summary.restored, 0);
  } finally {
    await archive.close();
    cleanup();
  }
});

test('a file created during the Turn is removed again', async () => {
  const { dir, archive, cleanup } = workspace();
  try {
    const file = join(dir, 'created.txt');
    await archive.record({ sessionId: 's1', turn: 2, cwd: dir, absolute: file, displayPath: 'created.txt' });
    writeFileSync(file, 'written by the turn\n');
    const plan = collectRestorePlan(archive.turnsFrom('s1', 2));
    const summary = await restorePlan({ plan, archive, sessionId: 's1' });
    assert.equal(summary.deleted, 1);
    assert.throws(() => readFileSync(file), /ENOENT/);
  } finally {
    await archive.close();
    cleanup();
  }
});

test('the earliest pre-image wins across several Turns', async () => {
  const { dir, archive, cleanup } = workspace();
  try {
    const file = join(dir, 'story.txt');
    writeFileSync(file, 'v0\n');
    await archive.record({ sessionId: 's1', turn: 1, cwd: dir, absolute: file, displayPath: 'story.txt' });
    writeFileSync(file, 'v1\n');
    await archive.record({ sessionId: 's1', turn: 2, cwd: dir, absolute: file, displayPath: 'story.txt' });
    writeFileSync(file, 'v2\n');
    const plan = collectRestorePlan(archive.turnsFrom('s1', 1));
    assert.equal(plan.length, 1);
    assert.equal(plan[0].turn, 1);
    await restorePlan({ plan, archive, sessionId: 's1' });
    assert.equal(readFileSync(file, 'utf8'), 'v0\n');
  } finally {
    await archive.close();
    cleanup();
  }
});
