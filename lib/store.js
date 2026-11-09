// Durable archive of the pre-Turn content of every file a Turn mutates.
//
// The Harness session log is append-only, so "put the files back the way they
// were before that Turn" needs its own record. This module owns it:
//
//   <dataDir>/archive/index.json          { version, turns: { "<session>|<turn>": Turn } }
//   <dataDir>/archive/blobs/<sha256>.bin  the bytes exactly as they were before the mutation
//
// A pre-image is taken BEFORE the mutation applies (the fs intent hook runs
// ahead of the write) and only the first pre-image of one Turn is kept: that is
// the state the Turn started from. Every failure is contained — losing one
// snapshot costs one restore, while throwing here would sit inside a write.

import { createHash } from 'node:crypto';
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';

export const ARCHIVE_VERSION = 1;
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_FILES_PER_TURN = 200;
export const MAX_TURNS = 500;
/** Quarantined byte-blobs kept before the oldest ones are dropped. */
export const MAX_QUARANTINE = 200;
/** Total quarantined bytes kept. */
export const MAX_QUARANTINE_BYTES = 128 * 1024 * 1024;

const BLOB_NAME = /^[0-9a-f]{64}\.bin$/u;
const PRUNE_EVERY = 20;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function turnKey(sessionId, turn) {
  return `${sessionId}|${turn}`;
}

/** `.git` metadata is never archived, so a restore can never corrupt Git. */
export function isInsideGitMetadata(path) {
  return typeof path === 'string' && /(?:^|[\\/])\.git(?:[\\/]|$)/u.test(path);
}

function normalizeFile(raw) {
  if (!isRecord(raw)) return null;
  if (typeof raw.path !== 'string' || raw.path === '') return null;
  const blob = typeof raw.blob === 'string' && BLOB_NAME.test(raw.blob) ? raw.blob : null;
  return {
    path: raw.path,
    displayPath: typeof raw.displayPath === 'string' && raw.displayPath !== '' ? raw.displayPath : raw.path,
    existed: raw.existed === true,
    text: raw.text === true,
    blob,
    size: Number.isFinite(raw.size) ? raw.size : 0,
    ...(typeof raw.reason === 'string' ? { reason: raw.reason } : {}),
  };
}

function normalizeTurn(raw) {
  if (!isRecord(raw)) return null;
  if (typeof raw.sessionId !== 'string' || raw.sessionId === '') return null;
  if (!Number.isInteger(raw.turn)) return null;
  const files = Array.isArray(raw.files) ? raw.files.map(normalizeFile).filter(Boolean) : [];
  return {
    sessionId: raw.sessionId,
    turn: raw.turn,
    at: Number.isFinite(raw.at) ? raw.at : 0,
    ...(typeof raw.cwd === 'string' && raw.cwd !== '' ? { cwd: raw.cwd } : {}),
    files,
    ...(Number.isFinite(raw.endedAt) ? { endedAt: raw.endedAt } : {}),
    ...(Number.isFinite(raw.restoredAt) ? { restoredAt: raw.restoredAt } : {}),
  };
}

function emptyIndex() {
  return { version: ARCHIVE_VERSION, turns: {} };
}

function parseIndex(text) {
  if (typeof text !== 'string' || text === '') return emptyIndex();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return emptyIndex();
  }
  if (!isRecord(parsed) || parsed.version !== ARCHIVE_VERSION || !isRecord(parsed.turns)) return emptyIndex();
  const turns = {};
  for (const [key, value] of Object.entries(parsed.turns)) {
    const turn = normalizeTurn(value);
    if (turn !== null) turns[key] = turn;
  }
  return { version: ARCHIVE_VERSION, turns };
}

function isUtf8Text(bytes) {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * Open (or create) one archive.
 *
 * @param {{
 *   directory: string,
 *   warn?: (error: unknown) => void,
 *   maxFileBytes?: number,
 *   maxFilesPerTurn?: number,
 *   maxTurns?: number,
 *   readStats?: (path: string) => { isFile(): boolean, size: number },
 *   readBytes?: (path: string) => Buffer,
 * }} options
 */
export function createArchive({
  directory,
  warn = () => {},
  maxFileBytes = MAX_FILE_BYTES,
  maxFilesPerTurn = MAX_FILES_PER_TURN,
  maxTurns = MAX_TURNS,
  maxQuarantine = MAX_QUARANTINE,
  maxQuarantineBytes = MAX_QUARANTINE_BYTES,
  readStats = (path) => statSync(path),
  readBytes = (path) => readFileSync(path),
}) {
  const indexPath = join(directory, 'index.json');
  const blobDir = join(directory, 'blobs');
  const quarantineDir = join(directory, 'quarantine');
  const manifestPath = join(quarantineDir, 'manifest.jsonl');

  let index;
  let quarantineRows;
  let queue = Promise.resolve();
  let writes = 0;
  let closed = false;

  const report = (error) => {
    try { warn(error); } catch { /* diagnostics never escalate */ }
  };

  const load = () => {
    if (index !== undefined) return index;
    try { mkdirSync(blobDir, { recursive: true, mode: 0o700 }); } catch (error) { report(error); }
    let text = '';
    if (existsSync(indexPath)) {
      try { text = readFileSync(indexPath, 'utf8'); } catch (error) { report(error); }
    }
    index = parseIndex(text);
    return index;
  };

  /** Rows of displaced content, oldest first; a torn last line is tolerated. */
  const loadQuarantine = () => {
    if (quarantineRows !== undefined) return quarantineRows;
    quarantineRows = [];
    try {
      for (const line of readFileSync(manifestPath, 'utf8').split('\n')) {
        if (line === '') continue;
        try {
          const row = JSON.parse(line);
          if (row !== null && typeof row === 'object' && typeof row.blob === 'string') quarantineRows.push(row);
        } catch { /* tolerate a torn append */ }
      }
    } catch { /* no quarantine yet */ }
    return quarantineRows;
  };

  const quarantineStats = () => {
    const rows = loadQuarantine();
    let bytes = 0;
    for (const row of rows) bytes += Number(row.size) || 0;
    return { entries: rows.length, bytes };
  };

  const pruneQuarantine = (rows) => {
    const overflow = rows.length > maxQuarantine
      || rows.reduce((sum, row) => sum + (Number(row.size) || 0), 0) > maxQuarantineBytes;
    if (!overflow) return rows;
    const kept = [];
    let bytes = 0;
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index];
      const size = Number(row.size) || 0;
      if (kept.length >= maxQuarantine || bytes + size > maxQuarantineBytes) {
        try { unlinkSync(join(quarantineDir, row.blob)); } catch { /* already gone */ }
        continue;
      }
      kept.unshift(row);
      bytes += size;
    }
    try {
      writeFileSync(manifestPath, kept.map((row) => JSON.stringify(row)).join('\n') + (kept.length === 0 ? '' : '\n'), { encoding: 'utf8', mode: 0o600 });
    } catch (error) {
      report(error);
    }
    return kept;
  };

  const writeIndex = (state) => {
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const temp = `${indexPath}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
      renameSync(temp, indexPath);
      return true;
    } catch (error) {
      report(error);
      return false;
    }
  };

  const collectBlobs = (state) => {
    const referenced = new Set();
    for (const turn of Object.values(state.turns)) {
      for (const file of turn.files) if (file.blob !== null) referenced.add(file.blob);
    }
    let names = [];
    try { names = readdirSync(blobDir); } catch { return; }
    for (const name of names) {
      if (!BLOB_NAME.test(name) || referenced.has(name)) continue;
      try { unlinkSync(join(blobDir, name)); } catch (error) { report(error); }
    }
  };

  const prune = (state) => {
    const keys = Object.keys(state.turns);
    if (keys.length <= maxTurns) return;
    keys.sort((left, right) => (state.turns[left].at ?? 0) - (state.turns[right].at ?? 0));
    for (const key of keys.slice(0, keys.length - maxTurns)) delete state.turns[key];
    writeIndex(state);
    collectBlobs(state);
  };

  const save = (state) => {
    if (!writeIndex(state)) return;
    writes += 1;
    if (writes % PRUNE_EVERY === 0) prune(state);
  };

  const readPreImage = (absolute, displayPath) => {
    let info;
    try {
      info = readStats(absolute);
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        return { path: absolute, displayPath, existed: false, text: false, blob: null, size: 0 };
      }
      report(error);
      return null;
    }
    if (typeof info?.isFile === 'function' && !info.isFile()) return null;
    const size = Number.isFinite(info?.size) ? info.size : 0;
    if (size > maxFileBytes) {
      return { path: absolute, displayPath, existed: true, text: false, blob: null, size, reason: 'too-large' };
    }
    let bytes;
    try {
      bytes = readBytes(absolute);
    } catch (error) {
      report(error);
      return { path: absolute, displayPath, existed: true, text: false, blob: null, size, reason: 'unreadable' };
    }
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const name = `${createHash('sha256').update(buffer).digest('hex')}.bin`;
    let blob = null;
    try {
      mkdirSync(blobDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(blobDir, name), buffer, { mode: 0o600 });
      blob = name;
    } catch (error) {
      report(error);
    }
    return {
      path: absolute,
      displayPath,
      existed: true,
      text: isUtf8Text(buffer),
      blob,
      size: buffer.byteLength,
      ...(blob === null ? { reason: 'unreadable' } : {}),
    };
  };

  const recordNow = ({ sessionId, turn, cwd, absolute, displayPath }) => {
    if (closed) return null;
    if (typeof sessionId !== 'string' || sessionId === '') return null;
    if (!Number.isInteger(turn)) return null;
    if (typeof absolute !== 'string' || absolute === '') return null;
    if (isInsideGitMetadata(absolute)) return null;
    const state = load();
    const key = turnKey(sessionId, turn);
    let entry = state.turns[key];
    if (entry === undefined) {
      entry = {
        sessionId,
        turn,
        at: Date.now(),
        ...(typeof cwd === 'string' && cwd !== '' ? { cwd } : {}),
        files: [],
      };
      state.turns[key] = entry;
    }
    if (entry.files.some((file) => file.path === absolute)) return null;
    if (entry.files.length >= maxFilesPerTurn) return null;
    const captured = readPreImage(absolute, displayPath);
    if (captured === null) return null;
    entry.files.push(captured);
    save(state);
    return captured;
  };

  /** One mutation at a time, so concurrent writes cannot interleave. */
  const serialize = (job) => {
    const run = queue.then(job, job);
    queue = run.then(() => undefined, () => undefined);
    return run;
  };

  return {
    directory,

    record(input) {
      return serialize(() => recordNow(input));
    },

    get(sessionId, turn) {
      if (closed) return null;
      const state = load();
      return state.turns[turnKey(sessionId, turn)] ?? null;
    },

    /** Every archived Turn at or after `fromTurn`, oldest first. */
    turnsFrom(sessionId, fromTurn) {
      if (closed) return [];
      const state = load();
      return Object.values(state.turns)
        .filter((turn) => turn.sessionId === sessionId && turn.turn >= fromTurn)
        .sort((left, right) => left.turn - right.turn);
    },

    /** Every Turn of one session, newest first. */
    sessionTurns(sessionId) {
      if (closed) return [];
      const state = load();
      return Object.values(state.turns)
        .filter((turn) => turn.sessionId === sessionId)
        .sort((left, right) => right.turn - left.turn);
    },

    /**
     * Keep the bytes a restore is about to overwrite or delete, so a mistaken
     * rewind stays recoverable. Content-addressed: the same displaced version is
     * stored once.
     */
    quarantine({ sessionId, turn, path, displayPath, bytes, reason }) {
      return serialize(() => {
        if (closed) return null;
        if (!Buffer.isBuffer(bytes) || bytes.length === 0) return null;
        const rows = loadQuarantine();
        const hash = createHash('sha256').update(bytes).digest('hex');
        const blob = `${hash.slice(0, 32)}.bin`;
        try {
          mkdirSync(quarantineDir, { recursive: true, mode: 0o700 });
          writeFileSync(join(quarantineDir, blob), bytes, { mode: 0o600 });
        } catch (error) {
          report(error);
          return null;
        }
        const row = {
          at: Date.now(),
          sessionId: typeof sessionId === 'string' ? sessionId : '',
          turn: Number.isInteger(turn) ? turn : -1,
          path: typeof path === 'string' ? path : '',
          displayPath: typeof displayPath === 'string' && displayPath !== '' ? displayPath : basename(path || ''),
          size: bytes.byteLength,
          blob,
          reason: reason === 'deleted' ? 'deleted' : 'replaced',
        };
        if (!rows.some((existing) => existing.blob === blob && existing.path === row.path)) {
          rows.push(row);
          try {
            appendFileSync(manifestPath, `${JSON.stringify(row)}\n`, { encoding: 'utf8', mode: 0o600 });
          } catch (error) {
            report(error);
          }
          const kept = pruneQuarantine(rows);
          quarantineRows = kept;
        }
        return row;
      });
    },

    quarantineStats,

    /**
     * Read-only health report: missing blobs, orphan blobs, missing quarantine
     * blobs and torn manifest lines. Nothing is repaired here — an operator
     * decides what to drop from the settings page.
     */
    integrity() {
      const state = load();
      const referenced = new Set();
      let files = 0;
      let missingBlobs = 0;
      const samples = [];
      for (const turn of Object.values(state.turns)) {
        for (const file of turn.files) {
          files += 1;
          if (file.blob === null) continue;
          referenced.add(file.blob);
          try {
            statSync(join(blobDir, file.blob));
          } catch {
            missingBlobs += 1;
            if (samples.length < 5) samples.push({ turn: turn.turn, path: file.displayPath || file.path });
          }
        }
      }
      let orphanBlobs = 0;
      try {
        for (const name of readdirSync(blobDir)) {
          if (BLOB_NAME.test(name) && !referenced.has(name)) orphanBlobs += 1;
        }
      } catch { /* no blob directory yet */ }
      const rows = loadQuarantine();
      let quarantineMissing = 0;
      for (const row of rows) {
        try {
          statSync(join(quarantineDir, row.blob));
        } catch {
          quarantineMissing += 1;
        }
      }
      let corruptManifestLines = 0;
      try {
        for (const line of readFileSync(manifestPath, 'utf8').split('\n')) {
          if (line === '') continue;
          try { JSON.parse(line); } catch { corruptManifestLines += 1; }
        }
      } catch { /* no manifest yet */ }
      const issues = missingBlobs + orphanBlobs + quarantineMissing + corruptManifestLines;
      return { files, missingBlobs, orphanBlobs, quarantineMissing, corruptManifestLines, samples, ok: issues === 0 };
    },

    /** Newest first, cloned so a caller cannot mutate the manifest cache. */
    quarantineRows() {
      return [...loadQuarantine()]
        .sort((left, right) => (right.at ?? 0) - (left.at ?? 0))
        .map((row) => ({ ...row }));
    },

    /** Bytes of one displaced blob, without removing its manifest row. */
    quarantineBlob(blob) {
      if (typeof blob !== 'string' || !/^[0-9a-f]{32}\.bin$/.test(blob)) return null;
      try {
        return readFileSync(join(quarantineDir, blob));
      } catch {
        return null;
      }
    },

    /** Drop one displaced blob and its manifest row. */
    discardQuarantine(blob) {
      return serialize(() => {
        if (typeof blob !== 'string' || blob === '') return false;
        const rows = loadQuarantine();
        const index = rows.findIndex((row) => row.blob === blob);
        if (index < 0) return false;
        const [row] = rows.splice(index, 1);
        try { unlinkSync(join(quarantineDir, row.blob)); } catch { /* already gone */ }
        try {
          writeFileSync(manifestPath, rows.map((item) => JSON.stringify(item)).join('\n') + (rows.length === 0 ? '' : '\n'), {
            encoding: 'utf8',
            mode: 0o600,
          });
        } catch (error) {
          report(error);
        }
        quarantineRows = rows;
        return true;
      });
    },

    clearQuarantine() {
      return serialize(() => {
        const rows = loadQuarantine();
        for (const row of rows) {
          try { unlinkSync(join(quarantineDir, row.blob)); } catch { /* already gone */ }
        }
        try { writeFileSync(manifestPath, '', { encoding: 'utf8', mode: 0o600 }); } catch (error) { report(error); }
        quarantineRows = [];
      });
    },

    readBlob(name) {
      if (typeof name !== 'string' || !BLOB_NAME.test(name)) return null;
      try { return readFileSync(join(blobDir, name)); } catch (error) { report(error); return null; }
    },

    /** Record when the Turn closed, so a restore can tell later edits apart. */
    markEnded(sessionId, turn, endedAt) {
      return serialize(() => {
        if (closed) return;
        const state = load();
        const entry = state.turns[turnKey(sessionId, turn)];
        if (entry === undefined) return;
        entry.endedAt = Number.isFinite(endedAt) ? endedAt : Date.now();
        save(state);
      });
    },

    markRestored(sessionId, turn) {
      return serialize(() => {
        if (closed) return;
        const state = load();
        const entry = state.turns[turnKey(sessionId, turn)];
        if (entry === undefined) return;
        entry.restoredAt = Date.now();
        save(state);
      });
    },

    stats() {
      const state = load();
      const turns = Object.values(state.turns);
      let files = 0;
      let bytes = 0;
      for (const turn of turns) {
        files += turn.files.length;
        for (const file of turn.files) bytes += file.size;
      }
      return { directory, turns: turns.length, files, bytes, quarantine: quarantineStats() };
    },

    clear() {
      return serialize(() => {
        const state = emptyIndex();
        writeIndex(state);
        collectBlobs(state);
        index = state;
      });
    },

    close() {
      closed = true;
      return queue.catch(() => undefined);
    },
  };
}
