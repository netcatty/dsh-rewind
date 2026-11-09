// Restoring archived pre-Turn content.
//
// Text goes back through the Harness `fs` service so a restore obeys the same
// path resolution, locking and version guards as any other write. Binary
// pre-images and "this file did not exist before the Turn" need operations the
// `fs` service does not expose, so those go through Node directly — always on
// the absolute path recorded while the Turn ran, never on a client-supplied
// path. A target that has become a symbolic link is skipped rather than
// followed, so a restore can never be redirected outside the recorded file.

import { lstatSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Whether `path` itself (not its target) is a symbolic link or gone. */
function unchangedKind(path) {
  try {
    const info = lstatSync(path);
    return { exists: true, symlink: info.isSymbolicLink(), regular: info.isFile() };
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { exists: false, symlink: false, regular: false };
    throw error;
  }
}

function policyFor(sessionId, workspaceRoot) {
  return {
    mode: 'danger-full-access',
    workspaceRoot: typeof workspaceRoot === 'string' && workspaceRoot !== '' ? workspaceRoot : process.cwd(),
    ...(typeof sessionId === 'string' && sessionId !== '' ? { sessionId } : {}),
  };
}

/**
 * Collect the pre-Turn state of every file touched at or after `fromTurn`.
 * The earliest pre-image of one path wins: that is the state before the first
 * mutation in the withdrawn stretch, which is what a rewind must restore.
 */
export function collectRestorePlan(turns) {
  const byPath = new Map();
  for (const turn of [...turns].sort((left, right) => left.turn - right.turn)) {
    for (const file of Array.isArray(turn.files) ? turn.files : []) {
      if (!isRecord(file) || typeof file.path !== 'string') continue;
      if (byPath.has(file.path)) continue;
      byPath.set(file.path, { file, turn: turn.turn, cwd: turn.cwd });
    }
  }
  return [...byPath.values()];
}

/** Describe the plan for a confirmation dialog, without touching the disk. */
export function describePlan(plan) {
  return plan.map(({ file, turn }) => ({
    path: file.displayPath,
    absolute: file.path,
    turn,
    existed: file.existed === true,
    text: file.text === true,
    size: file.size,
    ...(typeof file.reason === 'string' ? { reason: file.reason } : {}),
  }));
}

/**
 * Restore one file to its archived state.
 * @returns {{ path: string, status: 'restored' | 'deleted' | 'unchanged' | 'skipped' | 'failed', message?: string }}
 */
export async function restoreOne({ file, turn, cwd, archive, fsService, sessionId }) {
  const displayPath = file.displayPath || file.path;
  const kind = unchangedKind(file.path);
  let currentBytes = null;
  if (kind.exists === true && kind.regular === true) {
    try { currentBytes = readFileSync(file.path); } catch { currentBytes = null; }
  }

  /** Keep the displaced bytes so a mistaken restore stays recoverable. */
  const keep = async (bytes, reason) => {
    if (bytes === null || bytes.length === 0) return;
    if (archive === undefined || typeof archive.quarantine !== 'function') return;
    try {
      await archive.quarantine({
        sessionId,
        turn,
        path: file.path,
        displayPath,
        bytes,
        reason,
      });
    } catch { /* quarantine is best effort; never block the restore */ }
  };

  if (file.existed !== true) {
    if (kind.exists && kind.regular !== true) {
      return { path: displayPath, status: 'skipped', message: '目标已不是普通文件，未删除' };
    }
    await keep(currentBytes, 'deleted');
    rmSync(file.path, { force: true });
    return { path: displayPath, status: 'deleted' };
  }

  if (kind.exists && kind.symlink === true) {
    return { path: displayPath, status: 'skipped', message: '目标已被替换为符号链接，未写入' };
  }

  const bytes = archive.readBlob(file.blob);
  if (bytes === null) {
    return {
      path: displayPath,
      status: 'skipped',
      message: file.reason === 'too-large' ? '文件超过快照上限，未保留内容' : '记录的内容已不可用',
    };
  }

  // Already at the recorded state: rewriting it would only bump the version.
  if (currentBytes !== null) {
    if (currentBytes.equals(bytes)) return { path: displayPath, status: 'unchanged' };
    await keep(currentBytes, 'replaced');
  }

  const policy = policyFor(sessionId, cwd);

  if (file.text === true && fsService !== undefined && typeof fsService.writeText === 'function') {
    const target = await fsService.resolve(file.path);
    let expected;
    try {
      const info = await fsService.stat(target);
      expected = info === undefined || info === null
        ? { kind: 'createIfAbsent' }
        : { kind: 'replaceIfVersion', version: info.version };
    } catch {
      expected = undefined;
    }
    await fsService.writeText(target, bytes.toString('utf8'), expected, undefined, policy);
    return { path: displayPath, status: 'restored' };
  }

  writeFileSync(file.path, bytes, { mode: 0o644 });
  return { path: displayPath, status: 'restored' };
}

/**
 * Restore every file in the plan, newest Turn first. A failure is contained to
 * its own file: the conversation half of the rewind has already committed, so
 * one unwritable file must not roll it back.
 */
export async function restorePlan({ plan, archive, fsService, sessionId }) {
  const summary = { restored: 0, deleted: 0, unchanged: 0, skipped: 0, failed: 0, files: [] };
  const ordered = [...plan].sort((left, right) => right.turn - left.turn);
  for (const entry of ordered) {
    let outcome;
    try {
      outcome = await restoreOne({ ...entry, archive, fsService, sessionId });
    } catch (error) {
      outcome = {
        path: entry.file.displayPath || entry.file.path,
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
      };
    }
    if (outcome.status === 'restored') summary.restored += 1;
    else if (outcome.status === 'deleted') summary.deleted += 1;
    else if (outcome.status === 'unchanged') summary.unchanged += 1;
    else if (outcome.status === 'skipped') summary.skipped += 1;
    else summary.failed += 1;
    summary.files.push(outcome);
  }
  return summary;
}
