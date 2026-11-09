// dsh-rewind host: in-place conversation rewind, the file pre-image archive
// behind "rewind the files too", the /rewind command and the loopback HTTP
// routes the Web Client half calls.
//
// Rewind semantics live in `surface.js`; nothing here rewrites or deletes a
// session log. One `user/message` marker is appended with a `replace`
// `surfaceOp`, which shadows the target message and every surface node after it
// for the model while the durable log keeps everything.

import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { createArchive } from './store.js';
import { LIMITS, normalizeSettings, readSettingsFile, resolveLimits, writeSettingsFile } from './settings.js';
import { defaultArchiveDir, expandPath, pluginDir } from './paths.js';
import {
  isRecord, listCandidates, markerPayload, planRewind, rewindMarkers, withdrawnTurns,
} from './surface.js';
import { collectRestorePlan, describePlan, restorePlan } from './restore.js';
import { diffLines } from './diff.js';

export const name = 'dsh-rewind';

/** Read the manifest version on demand: a linked checkout can change it. */
function readVersion() {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const API_PREFIX = '/api/dsh-rewind';
const BODY_LIMIT = 64 * 1024;
const IDLE_TIMEOUT_MS = 20_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(message, code = 'bad-request', status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function statusFor(error) {
  const status = Number(error?.status);
  if (Number.isInteger(status) && status >= 400 && status <= 599) return status;
  const code = typeof error?.code === 'string' ? error.code : '';
  if (code === 'bad-request') return 400;
  if (code === 'body-too-large') return 413;
  if (code === 'session-not-found' || code === 'session-unreadable') return 404;
  if (code === 'not-live' || code === 'busy' || code === 'not-on-surface' || code === 'subagent') return 409;
  if (code === 'no-user-messages' || code === 'not-a-user-message') return 400;
  return 500;
}

/**
 * @param {object} ctx Cordis context
 * @param {object} [config] row config from cordis.patch.yml
 */
export function apply(ctx, config = {}) {
  const archiveDir = typeof config.archiveDir === 'string' && config.archiveDir.trim() !== ''
    ? expandPath(config.archiveDir)
    : defaultArchiveDir();
  const userSettings = readSettingsFile(pluginDir()) ?? {};
  let limits = resolveLimits(userSettings, config);
  let archiveEnabled = limits.archiveFiles !== false;
  try { mkdirSync(pluginDir(), { recursive: true, mode: 0o700 }); } catch { /* best effort */ }
  try { mkdirSync(archiveDir, { recursive: true, mode: 0o700 }); } catch { /* best effort */ }

  const warn = (error) => {
    const message = error instanceof Error ? error.message : String(error);
    try { ctx.logger?.warn?.(`dsh-rewind: ${message}`); } catch { /* no logger */ }
    recentWarnings.push({ at: Date.now(), message });
    if (recentWarnings.length > 5) recentWarnings.shift();
  };

  let archive;
  if (archiveEnabled) {
    try {
      archive = createArchive({
        directory: archiveDir,
        warn,
        maxFileBytes: limits.maxFileBytes,
        maxFilesPerTurn: limits.maxFilesPerTurn,
        maxTurns: limits.maxTurns,
      });
    } catch (error) {
      warn(error);
      archive = undefined;
    }
  }

  const serviceOf = (serviceName) => {
    try { return ctx.get?.(serviceName); } catch { return undefined; }
  };

  /** Session id → the Turn currently open for that Session. */
  const openTurns = new Map();
  /** Tool execution → the Session that issued it. Weak, so it never leaks. */
  const actors = new WeakMap();
  /** Session id → the in-flight rewind promise (one per Session). */
  const inFlight = new Map();
  /** Session id → prompt a Host-side rewind wants the composer to show next. */
  const refills = new Map();
  /** Preview token → the file states that preview saw. */
  const plans = new Map();
  let planSeq = 0;
  const PLAN_TTL_MS = 5 * 60 * 1000;
  const PLAN_LIMIT = 20;
  let refillSeq = 0;
  const recentWarnings = [];
  /** What this Host actually wired up, reported by /selfcheck. */
  const capabilities = { webServer: false, commands: false, fs: false, intents: [] };

  /** Record what a preview saw, so an execute can refuse a stale plan. */
  const rememberPlan = (sessionId, seq, entries) => {
    planSeq += 1;
    const token = `plan-${planSeq}-${Date.now()}`;
    const files = new Map();
    for (const entry of entries) {
      let state;
      try {
        const info = statSync(entry.file.path);
        state = { size: info.size, mtimeMs: info.mtimeMs };
      } catch {
        state = { size: -1, mtimeMs: -1 };
      }
      files.set(entry.file.path, state);
    }
    plans.set(token, { sessionId, seq, at: Date.now(), files });
    for (const [key, value] of plans) {
      if (Date.now() - value.at > PLAN_TTL_MS) plans.delete(key);
    }
    while (plans.size > PLAN_LIMIT) plans.delete(plans.keys().next().value);
    return token;
  };

  /** Refuse an execute whose preview no longer matches the files on disk. */
  const verifyPlan = (token, sessionId, seq, entries) => {
    const plan = plans.get(token);
    if (plan === undefined) return { ok: false, reason: 'missing' };
    if (Date.now() - plan.at > PLAN_TTL_MS) {
      plans.delete(token);
      return { ok: false, reason: 'expired' };
    }
    if (plan.sessionId !== sessionId || plan.seq !== seq) return { ok: false, reason: 'mismatch' };
    const changed = [];
    for (const entry of entries) {
      const expected = plan.files.get(entry.file.path);
      let current;
      try {
        const info = statSync(entry.file.path);
        current = { size: info.size, mtimeMs: info.mtimeMs };
      } catch {
        current = { size: -1, mtimeMs: -1 };
      }
      if (expected === undefined || expected.size !== current.size || expected.mtimeMs !== current.mtimeMs) {
        changed.push(entry.file.displayPath || entry.file.path);
      }
    }
    return changed.length === 0 ? { ok: true } : { ok: false, reason: 'changed', changed };
  };

  const queueRefill = (sessionId, text) => {
    if (typeof text !== 'string' || text === '') return;
    refillSeq += 1;
    refills.set(sessionId, { token: `refill-${refillSeq}-${Date.now()}`, text, at: Date.now() });
  };

  const liveAgentOf = (sessionId) => {
    try {
      const agent = serviceOf('agents')?.get?.(sessionId);
      return isRecord(agent) ? agent : undefined;
    } catch {
      return undefined;
    }
  };

  const liveSessionOf = (sessionId) => {
    try {
      const session = serviceOf('sessions')?.get?.(sessionId);
      return session === undefined ? undefined : session;
    } catch {
      return undefined;
    }
  };

  const turnOfLiveSession = (session) => {
    try {
      const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : [];
      let current;
      for (const event of events) {
        if (event?.type === 'turn/start' && Number.isInteger(event.data?.turn)) current = event.data.turn;
        else if (event?.type === 'turn/end') current = undefined;
      }
      return current;
    } catch {
      return undefined;
    }
  };

  // ---------------------------------------------------------------------
  // Log and surface reads (live-preferred, backend-independent).
  // ---------------------------------------------------------------------

  async function readLog(sessionId) {
    const query = serviceOf('sessionQuery');
    if (query !== undefined && typeof query.readSession === 'function') {
      const snapshot = await query.readSession(sessionId);
      if (Array.isArray(snapshot?.events)) return { header: snapshot.session, events: snapshot.events };
    }
    const live = liveSessionOf(sessionId);
    if (live !== undefined) {
      const events = typeof live.snapshotEvents === 'function' ? live.snapshotEvents() : live.events;
      if (Array.isArray(events)) return { header: live.header, events: [...events] };
    }
    throw fail('无法读取这个会话的日志', 'session-unreadable', 404);
  }

  async function readSurfaceSeqs(sessionId) {
    const query = serviceOf('sessionQuery');
    if (query !== undefined && typeof query.readSurface === 'function') {
      const snapshot = await query.readSurface(sessionId);
      if (Array.isArray(snapshot?.events)) return snapshot.events.map((event) => event.seq);
    }
    const live = liveSessionOf(sessionId);
    if (live !== undefined && Array.isArray(live.surface?.nodes)) return [...live.surface.nodes];
    throw fail('无法读取这个会话的模型上下文', 'session-unreadable', 404);
  }

  async function describeSession(sessionId) {
    const { header, events } = await readLog(sessionId);
    const isSubagent = header?.parentSession !== undefined || header?.origin === 'subagent';
    const surfaceSeqs = await readSurfaceSeqs(sessionId);
    const agent = liveAgentOf(sessionId);
    const session = liveSessionOf(sessionId);
    const running = agent !== undefined && agent.status !== 'idle';
    const currentTurn = session !== undefined ? turnOfLiveSession(session) : undefined;
    const candidates = listCandidates(events, surfaceSeqs).map((candidate) => ({
      ...candidate,
      running: running === true
        && Number.isInteger(currentTurn)
        && candidate.turn === currentTurn,
    }));
    const markers = rewindMarkers(events);
    return {
      sessionId,
      live: agent !== undefined,
      isSubagent,
      running,
      candidates,
      rewound: markers.length > 0,
      markerSeqs: markers.map((marker) => marker.seq),
      hiddenTurns: withdrawnTurns(events),
      refill: refills.get(sessionId) ?? null,
      turns: archive === undefined ? [] : archive.sessionTurns(sessionId).map((turn) => ({
        turn: turn.turn,
        at: turn.at,
        files: turn.files.length,
        restoredAt: turn.restoredAt,
      })),
    };
  }

  // ---------------------------------------------------------------------
  // File pre-image capture.
  // ---------------------------------------------------------------------

  const recordEvent = (session, event) => {
    try {
      const sessionId = session?.id;
      if (typeof sessionId !== 'string' || sessionId === '') return;
      if (event?.type === 'turn/start' && Number.isInteger(event.data?.turn)) {
        openTurns.set(sessionId, event.data.turn);
        return;
      }
      if (event?.type === 'turn/end') {
        const turn = event.data?.turn;
        openTurns.delete(sessionId);
        if (Number.isInteger(turn) && archive !== undefined) {
          const endedAt = typeof event.time === 'number' ? event.time : Date.now();
          const written = archive.markEnded(sessionId, turn, endedAt);
          if (written !== undefined) written.catch(() => undefined);
        }
      }
    } catch { /* an unreadable event must never break the Turn */ }
  };

  try {
    ctx.on('session/event', recordEvent);
    ctx.on('session/disposed', (session) => {
      try {
        const sessionId = session?.id;
        if (typeof sessionId === 'string') openTurns.delete(sessionId);
      } catch { /* nothing to clean */ }
    });
    ctx.on('tools/pre-execute', async (exec, next) => {
      try {
        const session = exec?.agent?.session;
        const sessionId = session?.id;
        if (typeof sessionId === 'string' && sessionId !== '') {
          actors.set(exec, {
            sessionId,
            session,
            cwd: typeof session.header?.cwd === 'string' ? session.header.cwd : undefined,
          });
        }
      } catch { /* mapping is best-effort */ }
      return next();
    });
  } catch (error) {
    warn(error);
  }

  /** Parsed `.dsh-rewindignore` per workspace, refreshed when the file changes. */
  const ignoreCache = new Map();

  const ignorePatterns = (cwd) => {
    if (typeof cwd !== 'string' || cwd === '') return [];
    const file = join(cwd, '.dsh-rewindignore');
    let mtimeMs;
    try { mtimeMs = statSync(file).mtimeMs; } catch { return []; }
    const cached = ignoreCache.get(cwd);
    if (cached !== undefined && cached.mtimeMs === mtimeMs) return cached.patterns;
    let patterns = [];
    try {
      patterns = readFileSync(file, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.startsWith('#'))
        .slice(0, 200);
    } catch { patterns = []; }
    ignoreCache.set(cwd, { mtimeMs, patterns });
    return patterns;
  };

  const globOf = (pattern) => {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '\u0000')
      .replace(/\*/g, '[^/]*')
      .replace(/\u0000/g, '.*');
    return new RegExp(`^${escaped}$`);
  };

  const isIgnored = (cwd, absolute) => {
    const patterns = ignorePatterns(cwd);
    if (patterns.length === 0) return false;
    let rel;
    try { rel = relative(cwd, absolute).split(sep).join('/'); } catch { return false; }
    if (rel === '' || rel.startsWith('..')) return false;
    for (const pattern of patterns) {
      try {
        if (globOf(pattern).test(rel)) return true;
      } catch { /* a bad pattern never blocks the capture */ }
    }
    return false;
  };

  const capture = async (target, actor, fsService) => {
    if (archive === undefined) return;
    const owner = (isRecord(actor) || typeof actor === 'function') ? actors.get(actor) : undefined;
    if (owner === undefined) return;
    let turn = openTurns.get(owner.sessionId);
    if (!Number.isInteger(turn)) {
      turn = turnOfLiveSession(owner.session);
      if (!Number.isInteger(turn)) return;
      openTurns.set(owner.sessionId, turn);
    }
    let absolute;
    try { absolute = fsService.processPath(target); } catch { return; }
    if (typeof absolute !== 'string' || absolute === '') return;
    if (isIgnored(owner.cwd, absolute)) return;
    if (diskLow(archiveDir)) {
      const now = Date.now();
      if (now - diskWarnedAt > 60 * 60 * 1000) {
        diskWarnedAt = now;
        warn('磁盘剩余空间不足 200 MB，已暂停记录新的文件快照');
      }
      return;
    }
    await archive.record({
      sessionId: owner.sessionId,
      turn,
      cwd: owner.cwd,
      absolute,
      displayPath: isRecord(target) && typeof target.displayPath === 'string' && target.displayPath !== ''
        ? target.displayPath
        : absolute,
    });
  };

  try {
    ctx.inject(['fs'], (scope) => {
      const fsService = scope.fs;
      if (fsService === undefined) return;
      const listen = (eventName) => {
        scope.on(eventName, async (target, actor, next) => {
          const intent = await next();
          try {
            await capture(target, actor, fsService);
          } catch (error) {
            warn(error);
          }
          return intent;
        }, { prepend: true });
      };
      capabilities.fs = true;
      for (const eventName of ['fs/write-intent', 'fs/edit-intent', 'fs/delete-intent']) {
        try {
          listen(eventName);
          capabilities.intents.push(eventName);
        } catch (error) { warn(error); }
      }
    });
  } catch (error) {
    warn(error);
  }

  // ---------------------------------------------------------------------
  // Rewind planning and execution.
  // ---------------------------------------------------------------------

  const restoreEntries = (sessionId, fromTurn) => {
    if (archive === undefined || !Number.isInteger(fromTurn)) return [];
    return collectRestorePlan(archive.turnsFrom(sessionId, fromTurn));
  };

  /** Below this the plugin stops writing new snapshots instead of filling the disk. */
  const MIN_FREE_BYTES = 200 * 1024 * 1024;
  let diskWarnedAt = 0;

  const freeSpaceOf = (target) => {
    try {
      const stats = statfsSync(target);
      return Number(stats.bavail) * Number(stats.bsize);
    } catch {
      return undefined;
    }
  };

  const diskLow = (target) => {
    const free = freeSpaceOf(target);
    return free !== undefined && free < MIN_FREE_BYTES;
  };

  const MAX_DIFF_BYTES = 512 * 1024;
  const MAX_DIFF_FILES = 10;

  /** Current text → archived text, so − removes and + restores. */
  const diffOf = (entry) => {
    try {
      if (archive === undefined) return null;
      let archivedText = '';
      if (typeof entry.file.blob === 'string') {
        const archived = archive.readBlob(entry.file.blob);
        if (archived === null || archived.length > MAX_DIFF_BYTES) return null;
        archivedText = archived.toString('utf8');
      } else if (entry.file.existed === true) {
        // The pre-image could not be kept (too large or unreadable).
        return null;
      }
      let current = '';
      try {
        const info = statSync(entry.file.path);
        if (!info.isFile() || info.size > MAX_DIFF_BYTES) return null;
        current = readFileSync(entry.file.path, 'utf8');
      } catch {
        current = '';
      }
      if (entry.file.text !== true && typeof entry.file.blob === 'string') return null;
      return diffLines(current, archivedText);
    } catch {
      return null;
    }
  };

  /**
   * Compare one recorded file with what is on disk now. A file modified after
   * its Turn closed is not the file that Turn left behind, so a restore would
   * overwrite someone else's edit: the dialog labels it instead of guessing.
   */
  const describeCurrent = (entries) => entries.map((entry) => {
    let current;
    try {
      const info = statSync(entry.file.path);
      current = { exists: true, size: info.size, mtimeMs: info.mtimeMs };
    } catch {
      current = { exists: false };
    }
    const closedAt = Number.isFinite(entry.turnClosedAt) ? entry.turnClosedAt : undefined;
    const changedSince = current.exists === true
      && closedAt !== undefined
      && current.mtimeMs > closedAt + 2000
      && current.size !== entry.file.size;
    return { ...entry, current, changedSince };
  });

  /** Image/file blocks on the target message: rewind refills text only. */
  const attachmentsOf = (events, seq) => {
    const target = events.find((event) => event?.seq === seq);
    const content = target?.data?.content;
    return Array.isArray(content)
      ? content.filter((block) => block?.type === 'image' || block?.type === 'file').length
      : 0;
  };

  async function preview(sessionId, seq) {
    const { events } = await readLog(sessionId);
    const surfaceSeqs = await readSurfaceSeqs(sessionId);
    const plan = planRewind(events, surfaceSeqs, seq);
    const entries = describeCurrent(restoreEntries(sessionId, plan.turn).map((entry) => ({
      ...entry,
      turnClosedAt: archive?.get(sessionId, entry.turn)?.endedAt,
    })));
    return {
      live: liveAgentOf(sessionId) !== undefined,
      attachments: attachmentsOf(events, plan.targetSeq),
      planToken: rememberPlan(sessionId, plan.targetSeq, entries),
      target: {
        seq: plan.targetSeq,
        turn: plan.turn,
        prompt: plan.prompt,
        preview: plan.prompt.length > 200 ? `${plan.prompt.slice(0, 199)}…` : plan.prompt,
      },
      shadowed: plan.shadowedSeqs.length,
      files: describePlan(entries).map((file, index) => ({
        ...file,
        changedSince: entries[index]?.changedSince === true,
        currentExists: entries[index]?.current?.exists === true,
        diff: index < MAX_DIFF_FILES ? diffOf(entries[index]) : null,
      })),
      restorable: entries.length,
      archive: archive !== undefined,
    };
  }

  async function waitForIdle(agent, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (agent?.status === 'idle') return true;
      if (Date.now() >= deadline) return false;
      try {
        if (typeof agent?.whenIdle === 'function') {
          const settled = await Promise.race([
            Promise.resolve(agent.whenIdle()).then(() => true, () => true),
            sleep(Math.max(50, deadline - Date.now())).then(() => false),
          ]);
          if (settled === true && agent?.status === 'idle') return true;
          continue;
        }
      } catch { /* fall through to the poll */ }
      await sleep(150);
    }
  }

  /** Remove exactly one steering message, leaving the rest of the inbox alone. */
  const dropSteeringMessage = (agent, id) => {
    try {
      const inbox = agent?.inbox;
      if (!isRecord(inbox) || !Array.isArray(inbox.nextStep)) return;
      for (const message of [...inbox.nextStep]) {
        if (message?.id !== id) continue;
        try { inbox.remove?.(message); } catch { /* best effort */ }
      }
    } catch { /* best effort */ }
  };

  const dropPendingSteering = (agent) => {
    try {
      const inbox = agent?.inbox;
      if (!isRecord(inbox) || !Array.isArray(inbox.nextStep)) return;
      for (const message of [...inbox.nextStep]) {
        try { inbox.remove?.(message); } catch { /* best effort */ }
      }
    } catch { /* best effort */ }
  };

  async function execute({ sessionId, seq, mode, paths, planToken }) {
    const headerCheck = await readLog(sessionId);
    if (headerCheck.header?.parentSession !== undefined || headerCheck.header?.origin === 'subagent') {
      throw fail('子会话不能单独回退，请在它所属的主会话里操作。', 'subagent', 409);
    }
    const agent = liveAgentOf(sessionId);
    if (agent === undefined) {
      throw fail('这个会话没有打开。就地回退需要在会话处于打开状态时执行，请先打开它再试一次。', 'not-live', 409);
    }
    const session = agent.session;
    if (!isRecord(session) || typeof session.append !== 'function') {
      throw fail('当前 DSH 版本不允许就地回退会话日志', 'unsupported', 503);
    }

    // Plan from the committed log before touching anything, so a stale preview
    // is refused before the conversation half commits.
    const before = await readLog(sessionId);
    const beforeSurface = await readSurfaceSeqs(sessionId);
    const preplan = planRewind(before.events, beforeSurface, seq);

    if (mode !== 'chat' && archive !== undefined && typeof planToken === 'string' && planToken !== '') {
      const only = Array.isArray(paths) ? new Set(paths) : undefined;
      const planned = restoreEntries(sessionId, preplan.turn)
        .filter((entry) => only === undefined || only.has(entry.file.path));
      const check = verifyPlan(planToken, sessionId, seq, planned);
      if (check.ok !== true) {
        const names = Array.isArray(check.changed)
          ? check.changed.slice(0, 3).map((item) => item.split(/[\\/]/).pop() || item)
          : [];
        const detail = check.reason === 'changed'
          ? `这些文件在预览之后被改动：${names.join('、')}${check.changed.length > 3 ? ' 等' : ''}。`
          : '预览已失效。';
        throw fail(`${detail}请重新打开确认浮层后再执行。`, 'plan-stale', 409);
      }
    }


    if (mode === 'files') {
      if (archive === undefined) throw fail('文件快照未启用', 'unsupported', 503);
      if (agent.status !== 'idle') {
        const stopped = await waitForIdle(agent, IDLE_TIMEOUT_MS);
        if (stopped !== true) throw fail('正在生成的回合没有结束，稍后再只还原文件', 'busy', 409);
      }
      const only = Array.isArray(paths) ? new Set(paths) : undefined;
      const entries = restoreEntries(sessionId, preplan.turn)
        .filter((entry) => only === undefined || only.has(entry.file.path));
      const needed = entries.reduce((sum, entry) => sum + (Number(entry.file.size) || 0), 0);
      const targetFree = entries.length > 0 ? freeSpaceOf(dirname(entries[0].file.path)) : undefined;
      if (targetFree !== undefined && targetFree < needed + 8 * 1024 * 1024) {
        throw fail('目标磁盘剩余空间不足，未执行还原', 'disk-low', 507);
      }
      const files = await restorePlan({ plan: entries, archive, fsService: serviceOf('fs'), sessionId });
      for (const turn of new Set(entries.map((entry) => entry.turn))) {
        try { await archive.markRestored(sessionId, turn); } catch { /* cosmetic */ }
      }
      return {
        markerSeq: -1,
        targetSeq: preplan.targetSeq,
        turn: preplan.turn,
        prompt: '',
        attachments: 0,
        hiddenTurns: [],
        mode: 'files',
        files,
      };
    }

    // An unread steering message can leave the surface without stopping the
    // reply that is already streaming.
    const target = before.events.find((event) => event?.seq === seq);
    const targetId = target?.data?.id;
    const unreadSteering = typeof targetId === 'string'
      && Array.isArray(agent.inbox?.nextStep)
      && agent.inbox.nextStep.some((message) => message?.id === targetId);

    if (agent.status !== 'idle' && unreadSteering !== true) {
      try { agent.cancel?.({ kind: 'user' }, { keepInbox: true }); } catch { /* cancel is advisory */ }
      const stopped = await waitForIdle(agent, IDLE_TIMEOUT_MS);
      if (stopped !== true) throw fail('正在运行的轮次没有及时停下，未执行回退', 'busy', 409);
    }
    if (unreadSteering === true) dropSteeringMessage(agent, targetId);
    else dropPendingSteering(agent);

    // Re-derive after quiescence: the surface may have moved while we waited.
    const { events } = await readLog(sessionId);
    const surfaceSeqs = await readSurfaceSeqs(sessionId);
    const plan = planRewind(events, surfaceSeqs, seq);

    let marker;
    try {
      marker = session.append('user/message', markerPayload(`dsh-rewind-${randomUUID()}`), {
        surfaceOp: { op: 'replace', startSeq: plan.surfaceStart, endSeq: plan.surfaceEnd },
        sourceEventSeqs: [...plan.shadowedSeqs],
      });
    } catch (error) {
      throw fail(`回退标记被宿主拒绝：${error instanceof Error ? error.message : String(error)}`, 'marker-rejected', 409);
    }

    let files;
    if (mode === 'both' && archive !== undefined) {
      const only = Array.isArray(paths) ? new Set(paths) : undefined;
      const entries = restoreEntries(sessionId, plan.turn)
        .filter((entry) => only === undefined || only.has(entry.file.path));
      if (entries.length > 0) {
        const fsService = serviceOf('fs');
        files = await restorePlan({
          plan: entries,
          archive,
          fsService,
          sessionId,
        });
        if (files.restored + files.deleted > 0) {
          for (const turn of new Set(entries.map((entry) => entry.turn))) {
            try { await archive.markRestored(sessionId, turn); } catch { /* cosmetic */ }
          }
        }
      }
    }

    let hiddenTurns = [];
    try {
      const after = await readLog(sessionId);
      hiddenTurns = withdrawnTurns(after.events);
    } catch { /* fall back to the plan's own turn */ }
    if (Number.isInteger(plan.turn) && !hiddenTurns.includes(plan.turn)) hiddenTurns.push(plan.turn);
    hiddenTurns.sort((left, right) => left - right);

    return {
      markerSeq: typeof marker?.seq === 'number' ? marker.seq : -1,
      targetSeq: plan.targetSeq,
      turn: plan.turn,
      prompt: plan.prompt,
      attachments: attachmentsOf(events, plan.targetSeq),
      hiddenTurns,
      mode: mode === 'both' ? 'both' : 'chat',
      ...(files === undefined ? {} : { files }),
    };
  }

  /** Serialize rewinds per Session so two callers cannot interleave a marker. */
  const serializeRewind = (sessionId, job) => {
    if (inFlight.has(sessionId)) return Promise.reject(fail('这个会话正在执行另一次回退', 'busy', 409));
    const run = job();
    inFlight.set(sessionId, run);
    const settle = () => { if (inFlight.get(sessionId) === run) inFlight.delete(sessionId); };
    run.then(settle, settle);
    return run;
  };

  // ---------------------------------------------------------------------
  // Loopback HTTP routes for the Web Client half.
  // ---------------------------------------------------------------------

  const sameOrigin = (req) => {
    const host = String(req.headers.host ?? '').split(':')[0];
    const remote = req.socket?.remoteAddress ?? '';
    if (remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1') return true;
    try {
      return new URL(String(req.headers.origin ?? '')).hostname === host;
    } catch {
      return false;
    }
  };

  /** Reuse DSH's own connection authentication when available, fail closed. */
  const authenticate = (req) => {
    const connection = serviceOf('connection');
    if (connection !== undefined && typeof connection.admit === 'function') {
      try {
        const admission = connection.admit(req);
        if (!isRecord(admission)) return { ok: false, status: 401, error: '未授权' };
        if ('rejection' in admission) {
          const status = typeof admission.rejection === 'number' ? admission.rejection : 401;
          return { ok: false, status, error: status === 403 ? '禁止访问：请求未通过 DSH 信任检查' : '未授权' };
        }
        if (admission.peer?.principal?.kind !== 'owner') {
          return { ok: false, status: 403, error: '禁止访问：回退需要 owner 权限' };
        }
        return { ok: true };
      } catch {
        return { ok: false, status: 403, error: '认证检查失败' };
      }
    }
    return sameOrigin(req)
      ? { ok: true }
      : { ok: false, status: 403, error: '禁止访问：仅允许同源请求' };
  };

  const readBody = async (req) => {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > BODY_LIMIT) throw fail('请求体超过 64 KiB', 'body-too-large', 413);
      chunks.push(bytes);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (text.trim() === '') return {};
    let body;
    try { body = JSON.parse(text); } catch { throw fail('请求体不是合法 JSON'); }
    if (!isRecord(body)) throw fail('请求体必须是 JSON 对象');
    return body;
  };

  const json = (res, status, body) => {
    if (res.headersSent) return;
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };

  const requireSessionId = (value) => {
    const sessionId = typeof value === 'string' ? value.trim() : '';
    if (sessionId === '') throw fail('sessionId 必填');
    if (sessionId.length > 200 || /[\\/\x00-\x1f]/.test(sessionId)) throw fail('sessionId 不合法');
    return sessionId;
  };

  const requireSeq = (value) => {
    const seq = Number(value);
    if (!Number.isInteger(seq) || seq < 0) throw fail('seq 必须是正整数');
    return seq;
  };

  try {
    ctx.inject(['webServer'], (scope) => {
      const webServer = scope.webServer;
      if (webServer?.register === undefined) return;
      scope.effect(() => webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: async (req, res) => {
          const auth = authenticate(req);
          if (auth.ok !== true) return json(res, auth.status ?? 403, { ok: false, error: auth.error ?? 'forbidden' });
          const url = new URL(req.url ?? '/', 'http://localhost');
          const path = url.pathname.startsWith(API_PREFIX)
            ? url.pathname.slice(API_PREFIX.length) || '/'
            : '/';
          const method = req.method ?? 'GET';
          try {
            let body = {};
            if (method === 'POST') body = await readBody(req);
            if (method === 'GET' && path === '/state') {
              const sessionId = requireSessionId(url.searchParams.get('sessionId'));
              return json(res, 200, {
                ok: true,
                ...(await describeSession(sessionId)),
                archive: archive === undefined ? null : archive.stats(),
              });
            }
            if (method === 'POST' && path === '/preview') {
              const sessionId = requireSessionId(body.sessionId);
              const seq = requireSeq(body.seq);
              return json(res, 200, { ok: true, ...(await preview(sessionId, seq)) });
            }
            if (method === 'POST' && path === '/execute') {
              const sessionId = requireSessionId(body.sessionId);
              const seq = requireSeq(body.seq);
              const mode = body.mode === 'both' ? 'both' : (body.mode === 'files' ? 'files' : 'chat');
              const paths = Array.isArray(body.paths)
                ? body.paths.filter((item) => typeof item === 'string' && item !== '' && item.length < 4096).slice(0, 500)
                : undefined;
              const planToken = typeof body.planToken === 'string' ? body.planToken : undefined;
              const result = await serializeRewind(sessionId, () => execute({ sessionId, seq, mode, paths, planToken }));
              return json(res, 200, { ok: true, ...result });
            }
            if (method === 'POST' && path === '/refill-consumed') {
              const sessionId = requireSessionId(body.sessionId);
              const token = typeof body.token === 'string' ? body.token : '';
              const pending = refills.get(sessionId);
              if (pending !== undefined && pending.token === token) refills.delete(sessionId);
              return json(res, 200, { ok: true, consumed: pending !== undefined && pending.token === token });
            }
            if (method === 'GET' && path === '/selfcheck') {
              return json(res, 200, {
                ok: true,
                version: readVersion(),
                plugin: name,
                dataDir: pluginDir(),
                archiveDir,
                archiveEnabled,
                archive: archive === undefined ? null : { ...archive.stats(), integrity: archive.integrity() },
                capabilities,
                runtime: {
                  openTurns: openTurns.size,
                  inFlight: inFlight.size,
                  pendingRefills: refills.size,
                },
                warnings: recentWarnings.slice(-5),
              });
            }
            if (method === 'GET' && path === '/stats') {
              return json(res, 200, {
                ok: true,
                archive: archive === undefined ? null : { ...archive.stats(), integrity: archive.integrity() },
                dataDir: archiveDir,
                settingsDir: pluginDir(),
                archiveEnabled,
                limits,
              });
            }
            if (method === 'POST' && path === '/clear') {
              if (archive === undefined) return json(res, 503, { ok: false, error: '文件快照未启用' });
              if (body.confirm !== true) return json(res, 400, { ok: false, error: '需要 confirm: true 才能清空快照' });
              await archive.clear();
              return json(res, 200, { ok: true, cleared: true });
            }
            if (method === 'GET' && path === '/settings') {
              return json(res, 200, {
                ok: true,
                limits,
                defaults: {
                  maxFileBytes: LIMITS.maxFileBytes.fallback,
                  maxFilesPerTurn: LIMITS.maxFilesPerTurn.fallback,
                  maxTurns: LIMITS.maxTurns.fallback,
                },
                ranges: Object.fromEntries(Object.entries(LIMITS).map(([key, rule]) => [key, { min: rule.min, max: rule.max }])),
                source: readSettingsFile(pluginDir()) === null ? 'config' : 'settings.json',
              });
            }
            if (method === 'POST' && path === '/settings') {
              const saved = writeSettingsFile(pluginDir(), body, userSettings);
              Object.assign(userSettings, saved);
              limits = resolveLimits(userSettings, config);
              const nextEnabled = limits.archiveFiles !== false;
              if (nextEnabled && archive === undefined) {
                try {
                  archive = createArchive({
                    directory: archiveDir,
                    warn,
                    maxFileBytes: limits.maxFileBytes,
                    maxFilesPerTurn: limits.maxFilesPerTurn,
                    maxTurns: limits.maxTurns,
                  });
                } catch (error) {
                  warn(error);
                  archive = undefined;
                }
              } else if (!nextEnabled && archive !== undefined) {
                try { archive.close(); } catch { /* best effort */ }
                archive = undefined;
              } else if (archive !== undefined) {
                try { archive.close(); } catch { /* best effort */ }
                archive = createArchive({
                  directory: archiveDir,
                  warn,
                  maxFileBytes: limits.maxFileBytes,
                  maxFilesPerTurn: limits.maxFilesPerTurn,
                  maxTurns: limits.maxTurns,
                });
              }
              archiveEnabled = nextEnabled;
              return json(res, 200, { ok: true, limits, source: 'settings.json' });
            }
            if (method === 'GET' && path === '/quarantine') {
              if (archive === undefined) return json(res, 200, { ok: true, entries: [] });
              return json(res, 200, { ok: true, entries: archive.quarantineRows().slice(0, 200) });
            }
            if (method === 'POST' && path === '/quarantine-restore') {
              if (archive === undefined) return json(res, 503, { ok: false, error: '文件快照未启用' });
              const blob = typeof body.blob === 'string' ? body.blob : '';
              if (!/^[0-9a-f]{32}\.bin$/.test(blob)) throw fail('blob 不合法');
              const row = archive.quarantineRows().find((item) => item.blob === blob);
              if (row === undefined) throw fail('这条隔离记录不存在', 'not-found', 404);
              if (typeof row.path !== 'string' || row.path === '') throw fail('记录里没有可写回的路径', 'bad-request');
              let current = null;
              try {
                const info = lstatSync(row.path);
                if (info.isSymbolicLink()) throw fail('目标已是符号链接，拒绝写回', 'bad-request', 409);
                if (info.isFile()) current = readFileSync(row.path);
              } catch (error) {
                if (error?.code !== 'ENOENT') {
                  if (typeof error?.status === 'number') throw error;
                  current = null;
                }
              }
              if (current !== null && body.overwrite !== true) {
                throw fail('目标文件已存在，写回会覆盖它；需要 overwrite: true 确认', 'exists', 409);
              }
              const bytes = archive.quarantineBlob(blob);
              if (bytes === null) throw fail('隔离内容已不可读', 'not-found', 404);
              if (current !== null && current.length > 0) {
                // Keep the version we are about to overwrite, so this restore is itself reversible.
                await archive.quarantine({
                  sessionId: row.sessionId,
                  turn: row.turn,
                  path: row.path,
                  displayPath: row.displayPath,
                  bytes: current,
                  reason: 'replaced',
                });
              }
              try {
                mkdirSync(dirname(row.path), { recursive: true, mode: 0o700 });
                writeFileSync(row.path, bytes, { mode: 0o644 });
              } catch (error) {
                throw fail(`写回失败：${error instanceof Error ? error.message : String(error)}`, 'write-failed', 500);
              }
              await archive.discardQuarantine(blob);
              return json(res, 200, { ok: true, restored: true, path: row.path, displayPath: row.displayPath });
            }
            if (method === 'POST' && path === '/quarantine-discard') {
              if (archive === undefined) return json(res, 503, { ok: false, error: '文件快照未启用' });
              const blob = typeof body.blob === 'string' ? body.blob : '';
              if (!/^[0-9a-f]{32}\.bin$/.test(blob)) throw fail('blob 不合法');
              const discarded = await archive.discardQuarantine(blob);
              return json(res, 200, { ok: true, discarded });
            }
            if (method === 'POST' && path === '/clear-quarantine') {
              if (archive === undefined) return json(res, 503, { ok: false, error: '文件快照未启用' });
              if (body.confirm !== true) return json(res, 400, { ok: false, error: '需要 confirm: true 才能清空隔离区' });
              await archive.clearQuarantine();
              return json(res, 200, { ok: true, cleared: true });
            }
            return json(res, 404, { ok: false, error: `not found: ${method} ${path}` });
          } catch (error) {
            const status = statusFor(error);
            try { ctx.logger?.warn?.(`dsh-rewind: api ${method} ${path} failed: ${error?.message ?? String(error)}`); } catch { /* no logger */ }
            return json(res, status, {
              ok: false,
              error: error?.message ?? String(error),
              ...(typeof error?.code === 'string' ? { code: error.code } : {}),
            });
          }
        },
      }), 'dsh-rewind: api');
      capabilities.webServer = true;
    });
  } catch (error) {
    warn(error);
  }

  // ---------------------------------------------------------------------
  // /rewind command. The button is the primary entry point; the command keeps
  // rewind usable from the keyboard and from an Agent-free transcript.
  // ---------------------------------------------------------------------

  const renderCandidates = (candidates) => {
    if (candidates.length === 0) return '这个会话还没有可回退的消息。';
    // A command receipt is rendered as one status line, so the list stays flat.
    const rows = candidates.slice(0, 5).map((candidate) => {
      const preview = candidate.preview.length > 28 ? `${candidate.preview.slice(0, 27)}…` : candidate.preview;
      return `${candidate.index}) ${preview || '(空消息)'}`;
    });
    const more = candidates.length > rows.length ? ` …共 ${candidates.length} 条` : '';
    return `可回退：${rows.join('；')}${more}。用 /rewind <序号> 回退，加 files 连文件一起还原。`;
  };

  try {
    ctx.inject(['commands'], (scope) => {
      const commands = scope.commands;
      if (commands?.register === undefined) return;
      scope.effect(() => commands.register({
        name: 'rewind',
        description: '回退对话到更早的一条消息，可选择连文件一起还原',
        input: { hint: '<序号> [files]' },
        handler: async (invocation) => {
          const sessionId = invocation?.agent?.id;
          try {
            if (typeof sessionId !== 'string' || sessionId === '') {
              return { kind: 'error', text: '当前会话不可用' };
            }
            const raw = typeof invocation.rawInput === 'string' ? invocation.rawInput.trim() : '';
            if (raw === '') {
              const state = await describeSession(sessionId);
              return { kind: 'success', text: renderCandidates(state.candidates) };
            }
            const parts = raw.split(/\s+/);
            if (parts[0] === 'plan') {
              const planned = Number(parts[1]);
              if (!Number.isInteger(planned) || planned < 1) {
                return { kind: 'error', text: '用法：/rewind plan <序号>' };
              }
              const state = await describeSession(sessionId);
              const candidate = state.candidates.find((item) => item.index === planned);
              if (candidate === undefined) {
                return { kind: 'error', text: `没有第 ${planned} 条可回退消息；直接输入 /rewind 查看列表。` };
              }
              const seen = await preview(sessionId, candidate.seq);
              const paths = seen.files.slice(0, 5).map((file) => file.path);
              const more = seen.files.length > paths.length ? ` …共 ${seen.files.length} 个` : '';
              return {
                kind: 'success',
                text: `第 ${planned} 条：将撤回 ${seen.shadowed} 条上下文消息，影响 ${seen.restorable} 个文件${paths.length === 0 ? '' : `（${paths.join('、')}${more}）`}。执行：/rewind ${planned}${seen.restorable > 0 ? ' files' : ''}`,
              };
            }
            const index = Number(parts[0]);
            if (!Number.isInteger(index) || index < 1) {
              return { kind: 'error', text: `"${parts[0]}" 不是有效的序号；直接输入 /rewind 查看列表。` };
            }
            const withFiles = parts.slice(1).some((part) => part === 'files' || part === '--files');
            const state = await describeSession(sessionId);
            const candidate = state.candidates.find((item) => item.index === index);
            if (candidate === undefined) {
              return { kind: 'error', text: `没有第 ${index} 条可回退消息；直接输入 /rewind 查看列表。` };
            }
            const result = await serializeRewind(sessionId, () => execute({
              sessionId,
              seq: candidate.seq,
              mode: withFiles ? 'both' : 'chat',
            }));
            queueRefill(sessionId, result.prompt);
            const lines = [
              `已回退到第 ${index} 条消息（seq ${result.targetSeq}），原文已放回输入框。`,
              ...(withFiles && result.files !== undefined
                ? [`文件：还原 ${result.files.restored}，删除 ${result.files.deleted}，未变 ${result.files.unchanged ?? 0}，跳过 ${result.files.skipped}，失败 ${result.files.failed}。`]
                : []),
            ];
            return { kind: 'success', text: lines.join(' ') };
          } catch (error) {
            return { kind: 'error', text: error instanceof Error ? error.message : String(error) };
          }
        },
      }), 'dsh-rewind: command');

      // /undo is the one-keystroke form of /rewind 1: withdraw the most recent
      // Turn and hand its prompt back in the receipt.
      try {
        scope.effect(() => commands.register({
          name: 'undo',
          description: '撤回最近一轮对话，原文放回输入框（/rewind 1 的快捷方式）',
          input: { hint: '[files]' },
          handler: async (invocation) => {
            const sessionId = invocation?.agent?.id;
            try {
              if (typeof sessionId !== 'string' || sessionId === '') {
                return { kind: 'error', text: '当前会话不可用' };
              }
              const withFiles = String(invocation.rawInput ?? '').trim().split(/\s+/).includes('files');
              const state = await describeSession(sessionId);
              const candidate = state.candidates[0];
              if (candidate === undefined) {
                return { kind: 'error', text: '这个会话还没有可回退的消息。' };
              }
              const result = await serializeRewind(sessionId, () => execute({
                sessionId,
                seq: candidate.seq,
                mode: withFiles ? 'both' : 'chat',
              }));
              queueRefill(sessionId, result.prompt);
              const files = withFiles && result.files !== undefined
                ? ` 文件：还原 ${result.files.restored}，删除 ${result.files.deleted}，跳过 ${result.files.skipped}，失败 ${result.files.failed}。`
                : '';
              return {
                kind: 'success',
                text: `已撤回最近一轮（seq ${result.targetSeq}），原文已放回输入框。${files}`,
              };
            } catch (error) {
              return { kind: 'error', text: error instanceof Error ? error.message : String(error) };
            }
          },
        }), 'dsh-rewind: undo command');
      capabilities.commands = true;
      } catch (error) {
        warn(error);
      }
    });
  } catch (error) {
    warn(error);
  }

  try {
    ctx.effect(() => () => {
      try {
        const closing = archive?.close();
        if (closing !== undefined) closing.catch(() => {});
      } catch { /* teardown must never throw */ }
    }, 'dsh-rewind: archive');
  } catch (error) {
    warn(error);
  }

  const stats = archive === undefined ? null : archive.stats();
  ctx.logger?.info?.(`dsh-rewind: archive=${archiveDir} turns=${stats?.turns ?? 0}`);
}
