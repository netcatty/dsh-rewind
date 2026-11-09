import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MARKER_SOURCE_KIND, hasRewind, isHumanUserMessage, listCandidates, markerPayload,
  planRewind, rewindMarkers, turnOf, withdrawnTurns,
} from '../lib/surface.js';

const user = (seq, text, turn = 1, source = 'user') => ({
  seq,
  time: 1_700_000_000_000 + seq,
  type: 'user/message',
  data: { role: 'user', id: `u${seq}`, content: [{ type: 'text', text }], source: { kind: source } },
  surfaceOp: 'append',
});

const assistant = (seq, turn = 1) => ({
  seq,
  time: 1_700_000_000_000 + seq,
  type: 'assistant/message',
  data: { role: 'assistant', turn, step: 1 },
  surfaceOp: 'append',
});

const boundary = (seq, type, turn) => ({
  seq,
  time: 1_700_000_000_000 + seq,
  type,
  data: type === 'turn/start' ? { turn } : { turn, reason: { kind: 'completed' } },
});

function sessionLog() {
  return [
    boundary(0, 'turn/start', 1),
    user(1, '第一问', 1),
    assistant(2, 1),
    boundary(3, 'turn/end', 1),
    boundary(4, 'turn/start', 2),
    user(5, '第二问', 2),
    assistant(6, 2),
    boundary(7, 'turn/end', 2),
  ];
}

test('only human user messages are rewind targets', () => {
  assert.equal(isHumanUserMessage(user(1, 'hi')), true);
  assert.equal(isHumanUserMessage(user(2, 'ctx', 1, 'system-prompt')), false);
  assert.equal(isHumanUserMessage(assistant(3)), false);
  assert.equal(isHumanUserMessage(null), false);
});

test('candidates are newest first with a 1-based recency index', () => {
  const events = sessionLog();
  const candidates = listCandidates(events, [1, 2, 5, 6]);
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].seq, 5);
  assert.equal(candidates[0].index, 1);
  assert.equal(candidates[0].turn, 2);
  assert.equal(candidates[0].preview, '第二问');
  assert.equal(candidates[1].seq, 1);
  assert.equal(candidates[1].index, 2);
});

test('a candidate leaves the list once it is off the surface', () => {
  const events = sessionLog();
  assert.deepEqual(listCandidates(events, [5, 6]).map((row) => row.seq), [5]);
});

test('a plan shadows the target and every later surface node', () => {
  const events = sessionLog();
  const plan = planRewind(events, [1, 2, 5, 6], 5);
  assert.equal(plan.surfaceStart, 5);
  assert.equal(plan.surfaceEnd, 6);
  assert.deepEqual(plan.shadowedSeqs, [5, 6]);
  assert.equal(plan.prompt, '第二问');
  assert.equal(plan.turn, 2);
});

test('a plan rejects non-user and off-surface targets', () => {
  const events = sessionLog();
  assert.throws(() => planRewind(events, [1, 2, 5, 6], 2), (error) => error.code === 'not-a-user-message');
  assert.throws(() => planRewind(events, [5, 6], 1), (error) => error.code === 'not-on-surface');
  assert.throws(() => planRewind(events, [], 1), (error) => error.code === 'no-user-messages');
  assert.throws(() => planRewind(events, [1, 2], 999), (error) => error.code === 'not-a-user-message');
});

test('the marker payload is a non-empty user message with its own source kind', () => {
  const payload = markerPayload('rewind-1');
  assert.equal(payload.role, 'user');
  assert.equal(payload.id, 'rewind-1');
  assert.deepEqual(payload.source, { kind: MARKER_SOURCE_KIND });
  assert.equal(payload.content[0].text.length > 0, true);
});

test('withdrawn turns follow every executed marker, not only the first', () => {
  const events = sessionLog();
  const first = {
    seq: 8,
    time: 1,
    type: 'user/message',
    data: { role: 'user', id: 'm1', content: [{ type: 'text', text: '(dsh-rewind)' }], source: { kind: MARKER_SOURCE_KIND } },
    surfaceOp: { op: 'replace', startSeq: 5, endSeq: 6 },
    sourceEventSeqs: [5, 6],
  };
  const afterFirst = [...events, first];
  assert.deepEqual(withdrawnTurns(afterFirst), [2]);
  assert.equal(hasRewind(afterFirst), true);
  assert.equal(rewindMarkers(afterFirst).length, 1);

  // A second, earlier cut withdraws turn 1 as well; the union must keep both.
  const second = {
    seq: 9,
    time: 2,
    type: 'user/message',
    data: { role: 'user', id: 'm2', content: [{ type: 'text', text: '(dsh-rewind)' }], source: { kind: MARKER_SOURCE_KIND } },
    surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 },
    sourceEventSeqs: [1, 2],
  };
  assert.deepEqual(withdrawnTurns([...afterFirst, second]), [1, 2]);
});

test('turnOf resolves the containing turn', () => {
  const events = sessionLog();
  assert.equal(turnOf(events, 1), 1);
  assert.equal(turnOf(events, 5), 2);
  assert.equal(turnOf(events, 7), null);
});
