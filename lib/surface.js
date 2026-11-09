// Pure rewind planning: candidates, the surface range one rewind shadows, and
// the visible turns a completed rewind withdraws. No I/O and no Cordis
// dependency, so every rule here is unit-testable from a plain event array.
//
// Semantics (shared by every in-place rewind implementation for DSH): the
// session log is append-only. A rewind appends ONE `user/message` whose
// `surfaceOp` is `{ op: 'replace', startSeq, endSeq }` covering the target user
// message and every surface node after it. The model then derives its context
// from before the target, while the log still holds everything for audit and
// the rendered transcript.

/** Producer kind carried by every marker this plugin appends. */
export const MARKER_SOURCE_KIND = 'dsh-rewind';

/**
 * Constant marker body. Must be non-empty: a strict OpenAI-compatible gateway
 * rejects an empty user message, and the marker derives to itself at the
 * surface tail.
 */
export const MARKER_TEXT = '(dsh-rewind)';

/** Longest candidate preview kept, in characters. */
export const PREVIEW_CHARS = 80;

/** Default number of candidates listed, newest first. */
export const DEFAULT_CANDIDATE_LIMIT = 100;

export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * A genuinely user-authored message. Runtime context, instruction files and
 * projected notes are also `user/message` events, but their source kind is not
 * `user`.
 */
export function isHumanUserMessage(event) {
  return isRecord(event)
    && event.type === 'user/message'
    && isRecord(event.data)
    && isRecord(event.data.source)
    && event.data.source.kind === 'user';
}

/** Join the text blocks of one message content array. */
export function textOf(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type !== undefined && block.type !== 'text') continue;
    if (typeof block.text === 'string' && block.text !== '') parts.push(block.text);
  }
  return parts.join('\n').trim();
}

/** Clip one line of text for a list row. */
export function clip(text, max = PREVIEW_CHARS) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(1, max - 1))}…`;
}

/** Map every event seq to the Turn that contains it (event-log order). */
export function turnIndex(events) {
  const turns = new Map();
  let current = null;
  for (const event of events) {
    if (!isRecord(event) || typeof event.seq !== 'number') continue;
    if (event.type === 'turn/start' && Number.isInteger(event.data?.turn)) current = event.data.turn;
    else if (event.type === 'turn/end') current = null;
    if (Number.isInteger(current)) turns.set(event.seq, current);
  }
  return turns;
}

/** The Turn that contains `seq`, or null. */
export function turnOf(events, seq) {
  let current = null;
  for (const event of events) {
    if (!isRecord(event) || typeof event.seq !== 'number') continue;
    if (event.seq > seq) break;
    if (event.type === 'turn/start' && Number.isInteger(event.data?.turn)) current = event.data.turn;
    else if (event.type === 'turn/end') current = null;
  }
  return Number.isInteger(current) ? current : null;
}

/**
 * Every user-authored message currently on the surface, newest first.
 * `index` is the 1-based recency rank the /rewind command accepts.
 */
export function listCandidates(events, surfaceSeqs, limit = DEFAULT_CANDIDATE_LIMIT) {
  const onSurface = new Set(Array.isArray(surfaceSeqs) ? surfaceSeqs : []);
  const turns = turnIndex(events);
  const ordered = [];
  for (const event of events) {
    if (!isHumanUserMessage(event)) continue;
    if (typeof event.seq !== 'number' || !onSurface.has(event.seq)) continue;
    ordered.push(event);
  }
  const result = [];
  for (let index = ordered.length - 1; index >= 0 && result.length < limit; index -= 1) {
    const event = ordered[index];
    result.push({
      seq: event.seq,
      time: typeof event.time === 'number' ? event.time : 0,
      turn: turns.get(event.seq) ?? null,
      preview: clip(textOf(event.data?.content)),
      index: result.length + 1,
    });
  }
  return result;
}

/**
 * Plan one rewind. `surfaceSeqs` is the current model surface in order; the
 * shadowed range ends at the LAST surface node, not at the target, because the
 * replacement hides everything the model still sees after the target too.
 */
export function planRewind(events, surfaceSeqs, seq) {
  const nodes = Array.isArray(surfaceSeqs) ? surfaceSeqs : [];
  if (nodes.length === 0) throw fail('no-user-messages', '这个会话还没有可回退的消息');
  const target = Array.isArray(events) ? events.find((event) => event?.seq === seq) : undefined;
  if (target === undefined) throw fail('not-a-user-message', '该消息不在这个会话里');
  if (!isHumanUserMessage(target)) throw fail('not-a-user-message', '只能回退到自己发送的消息');
  const index = nodes.indexOf(seq);
  if (index < 0) throw fail('not-on-surface', '该消息已不在模型上下文中');
  const shadowedSeqs = nodes.slice(index);
  return {
    targetSeq: seq,
    targetIndex: index,
    surfaceStart: shadowedSeqs[0],
    surfaceEnd: shadowedSeqs[shadowedSeqs.length - 1],
    shadowedSeqs,
    prompt: textOf(target.data?.content),
    turn: turnOf(events, seq),
  };
}

/** The marker payload appended for one executed rewind. */
export function markerPayload(id) {
  return {
    role: 'user',
    id,
    content: [{ type: 'text', text: MARKER_TEXT }],
    source: { kind: MARKER_SOURCE_KIND },
  };
}

/** Every executed rewind marker in this log. */
export function rewindMarkers(events) {
  const markers = [];
  for (const event of events) {
    if (!isRecord(event) || event.type !== 'user/message') continue;
    if (event.data?.source?.kind !== MARKER_SOURCE_KIND) continue;
    if (typeof event.seq !== 'number') continue;
    const op = event.surfaceOp;
    if (!isRecord(op) || op.op !== 'replace' || typeof op.startSeq !== 'number') continue;
    markers.push(event);
  }
  return markers;
}

/** Whether any rewind has been executed in this log. */
export function hasRewind(events) {
  return rewindMarkers(events).length > 0;
}

/**
 * Sequence every visible (append-origin) row of a withdrawn stretch starts at.
 * The Chat view renders append-origin nodes only, so a declared rewind does not
 * remove old rows by itself; the client hides the Turns computed here.
 */
export function withdrawnTurns(events) {
  const markers = rewindMarkers(events);
  if (markers.length === 0) return [];
  const spans = markers.map((marker) => ({ from: marker.surfaceOp.startSeq, before: marker.seq }));
  const turns = new Set();
  let current = null;
  for (const event of events) {
    if (!isRecord(event) || typeof event.seq !== 'number') continue;
    if (event.type === 'turn/start' && Number.isInteger(event.data?.turn)) current = event.data.turn;
    else if (event.type === 'turn/end') current = null;
    if (!Number.isInteger(current)) continue;
    for (const span of spans) {
      if (event.seq >= span.from && event.seq < span.before) {
        turns.add(current);
        break;
      }
    }
  }
  return [...turns].sort((left, right) => left - right);
}

/** Whether a marker row itself should be hidden from the transcript. */
export function isMarkerEvent(event) {
  return isRecord(event)
    && event.type === 'user/message'
    && event.data?.source?.kind === MARKER_SOURCE_KIND;
}
