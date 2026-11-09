// Every file this plugin owns lives under one directory:
//   $DSH_HOME/dsh-plugins/dsh-rewind/archive/index.json
//   $DSH_HOME/dsh-plugins/dsh-rewind/archive/blobs/<sha256>.bin
//
// `$DSH_HOME/storages/` belongs to the DSH storage backend, so this plugin
// shares the same `dsh-plugins/<app>/` namespace as dsh-mcp and dsh-session.

import { homedir } from 'node:os';
import { join } from 'node:path';

export const PLUGINS_DIR = 'dsh-plugins';
export const APP_DIR = 'dsh-rewind';

export function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  return typeof fromEnv === 'string' && fromEnv !== '' ? fromEnv : join(homedir(), '.dsh');
}

export function pluginDir() {
  return join(dshHome(), PLUGINS_DIR, APP_DIR);
}

export function defaultArchiveDir() {
  return join(pluginDir(), 'archive');
}
