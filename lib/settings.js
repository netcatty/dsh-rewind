import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const LIMITS = {
  maxFileBytes: { min: 1024, max: 64 * 1024 * 1024, fallback: 2 * 1024 * 1024 },
  maxFilesPerTurn: { min: 1, max: 5000, fallback: 200 },
  maxTurns: { min: 1, max: 10000, fallback: 500 },
};

/**
 * Coerce one settings document. Unknown keys are dropped, out-of-range values
 * fall back to the previous value, so a hand-edited file cannot disable pruning.
 */
export function normalizeSettings(value, previous = {}) {
  const settings = {};
  if (typeof value?.archiveFiles === 'boolean') settings.archiveFiles = value.archiveFiles;
  else if (typeof previous?.archiveFiles === 'boolean') settings.archiveFiles = previous.archiveFiles;
  for (const [key, rule] of Object.entries(LIMITS)) {
    const candidate = value?.[key];
    const prior = previous?.[key];
    if (Number.isInteger(candidate) && candidate >= rule.min && candidate <= rule.max) {
      settings[key] = candidate;
    } else if (Number.isInteger(prior) && prior >= rule.min && prior <= rule.max) {
      settings[key] = prior;
    } else {
      settings[key] = rule.fallback;
    }
  }
  return settings;
}

export function readSettingsFile(directory) {
  const path = join(directory, 'settings.json');
  if (!existsSync(path)) return null;
  try {
    return normalizeSettings(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
}

export function writeSettingsFile(directory, value, previous = {}) {
  const settings = normalizeSettings(value, previous);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'settings.json');
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
  return settings;
}

/**
 * User settings win over the plugin row, which wins over the built-in default.
 */
export function resolveLimits(settings, config = {}) {
  const resolved = {
    archiveFiles: typeof settings?.archiveFiles === 'boolean'
      ? settings.archiveFiles
      : config?.archiveFiles !== false,
  };
  for (const [key, rule] of Object.entries(LIMITS)) {
    if (Number.isInteger(settings?.[key])) resolved[key] = settings[key];
    else if (Number.isFinite(config?.[key])) resolved[key] = config[key];
    else resolved[key] = rule.fallback;
  }
  return resolved;
}
