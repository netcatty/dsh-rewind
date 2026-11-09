import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createArchive } from '../lib/store.js';

test('the index keeps at most maxTurns records', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rewind-limits-'));
  try {
    const archive = createArchive({ directory: join(dir, 'archive'), maxTurns: 3 });
    for (let index = 0; index < 40; index += 1) {
      const file = join(dir, `f-${index}.txt`);
      writeFileSync(file, `content-${index}\n`);
      await archive.record({ sessionId: 's1', turn: index, cwd: dir, absolute: file, displayPath: `f-${index}.txt` });
    }
    assert.ok(archive.stats().turns <= 3, `expected <= 3 turns, got ${archive.stats().turns}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the quarantine keeps at most maxQuarantine entries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rewind-qlimit-'));
  try {
    const archive = createArchive({ directory: join(dir, 'archive'), maxQuarantine: 2 });
    const manifestDir = join(dir, 'archive', 'quarantine');
    for (let index = 0; index < 4; index += 1) {
      await archive.quarantine({
        sessionId: 's1',
        turn: index,
        path: `/tmp/q-${index}.txt`,
        displayPath: `q-${index}.txt`,
        bytes: Buffer.from(`old-${index}-${'x'.repeat(index)}\n`),
        reason: 'replaced',
      });
    }
    assert.equal(archive.stats().quarantine.entries, 2);
    const blobs = readdirSync(manifestDir).filter((name) => name.endsWith('.bin'));
    assert.equal(blobs.length, 2, 'pruned rows leave no orphan blobs');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('identical content shares one blob', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rewind-dedupe-'));
  try {
    const archive = createArchive({ directory: join(dir, 'archive') });
    const a = join(dir, 'a.txt');
    const b = join(dir, 'b.txt');
    writeFileSync(a, 'same\n');
    writeFileSync(b, 'same\n');
    const first = await archive.record({ sessionId: 's1', turn: 1, cwd: dir, absolute: a, displayPath: 'a.txt' });
    const second = await archive.record({ sessionId: 's1', turn: 1, cwd: dir, absolute: b, displayPath: 'b.txt' });
    assert.equal(first.blob, second.blob);
    const blobs = readdirSync(join(dir, 'archive', 'blobs'));
    assert.equal(blobs.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
