import assert from 'node:assert/strict';
import test from 'node:test';
import { diffLines } from '../lib/diff.js';

test('identical text produces no change rows', () => {
  const result = diffLines('a\nb\nc\n', 'a\nb\nc\n');
  assert.equal(result.added, 0);
  assert.equal(result.removed, 0);
  assert.equal(result.rows.filter((row) => row.type !== 'context').length, 0);
});

test('a changed line is reported as one removal and one addition', () => {
  const result = diffLines('a\nold\nc\n', 'a\nnew\nc\n');
  assert.equal(result.removed, 1);
  assert.equal(result.added, 1);
  const changed = result.rows.filter((row) => row.type !== 'context');
  assert.deepEqual(changed.map((row) => row.type), ['del', 'add']);
  assert.equal(changed[0].text, 'old');
  assert.equal(changed[1].text, 'new');
});

test('rows keep only the changed neighbourhood', () => {
  const before = ['line1', 'line2', 'line3', 'line4', 'target', 'line6', 'line7', 'line8', 'line9'].join('\n');
  const after = before.replace('target', 'changed');
  const result = diffLines(before, after);
  assert.ok(result.rows.length < 9);
  assert.ok(result.rows.some((row) => row.text === '… 3 行未变化 …' || row.text.includes('未变化')));
});

test('an added file shows the added lines', () => {
  const result = diffLines('', 'hello\nworld\n');
  assert.equal(result.added >= 2, true);
  assert.ok(result.rows.some((row) => row.type === 'add' && row.text === 'hello'));
});

test('oversized inputs are reported as truncated instead of diffed', () => {
  const big = Array.from({ length: 40 }, (_, index) => `line-${index}`).join('\n');
  const result = diffLines(big, `${big}\nmore`, { maxLines: 10 });
  assert.equal(result.truncated, true);
  assert.deepEqual(result.rows, []);
});

test('row output is capped', () => {
  const before = Array.from({ length: 60 }, (_, index) => `a-${index}`).join('\n');
  const after = Array.from({ length: 60 }, (_, index) => `b-${index}`).join('\n');
  const result = diffLines(before, after, { maxRows: 10 });
  assert.equal(result.truncated, true);
  assert.equal(result.rows.length, 10);
});
