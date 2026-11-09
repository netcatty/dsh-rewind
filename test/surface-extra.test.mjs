import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MARKER_SOURCE_KIND, listCandidates, planRewind, turnIndex, withdrawnTurns,
} from '../lib/surface.js';

const user = (seq, text, turn = 1, source = 'user') => ({
  seq,
  time: 1_700_000_000_000 + seq,
  type: 'user/message',
  data: { role: 'user', id: `u${seq}`, content: [{ type: 'text', text }], source: { kind: source } },
  surfaceOp: 'append',
});

const marker = (seq, startSeq, endSeq) => ({
  seq,
  time: 1_700_000_000_000 + seq,
  type: 'user/message',
  data: { role: 'user', id: `m${seq}`, content: [{ type: 'text', text: '(dsh-rewind)' }], source: { kind: MARKER_SOURCE_KIND } },
  surfaceOp: { op: 'replace', startSeq, endSeq },
  sourceEventSeqs: [startSeq, endSeq],
});

const start = (seq, turn) => ({ seq, time: seq, type: 'turn/start', data: { turn } });
const end = (seq, turn) => ({ seq, time: seq, type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });

test('an empty session has no candidates and cannot be planned', () => {
  assert.deepEqual(listCandidates([], []), []);
  assert.throws(() => planRewind([], [], 1), (error) => error.code === 'no-user-messages');
});

test('rewinding the last surface node shadows exactly one node', () => {
  const events = [start(0, 1), user(1, 'hi'), end(2, 1)];
  const plan = planRewind(events, [1], 1);
  assert.deepEqual(plan.shadowedSeqs, [1]);
  assert.equal(plan.surfaceStart, 1);
  assert.equal(plan.surfaceEnd, 1);
  assert.equal(plan.turn, 1);
});

test('a message outside any Turn has a null turn', () => {
  const events = [user(1, 'outside')];
  assert.equal(turnIndex(events).get(1), undefined);
  const plan = planRewind(events, [1], 1);
  assert.equal(plan.turn, null);
});

test('a marker before any turn withdraws nothing', () => {
  const events = [marker(0, 5, 6), start(1, 1), user(2, 'hi'), end(3, 1)];
  assert.deepEqual(withdrawnTurns(events), []);
});

test('candidates respect the limit and stay newest first', () => {
  const events = [
    start(0, 1), user(1, 'one'), end(2, 1),
    start(3, 2), user(4, 'two'), end(5, 2),
    start(6, 3), user(7, 'three'), end(8, 3),
  ];
  const surface = [1, 4, 7];
  assert.deepEqual(listCandidates(events, surface, 2).map((row) => row.seq), [7, 4]);
  assert.deepEqual(listCandidates(events, surface).map((row) => row.turn), [3, 2, 1]);
});

test('a marker that starts inside a turn hides that turn', () => {
  const events = [
    start(0, 1), user(1, 'one'), end(2, 1),
    start(3, 2), user(4, 'two'), marker(5, 4, 4), end(6, 2),
  ];
  assert.deepEqual(withdrawnTurns(events), [2]);
});
