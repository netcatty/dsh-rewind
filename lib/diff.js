// Line diff for the confirmation dialog: what a restore would change.
//
// `before` is the text on disk right now and `after` is the archived pre-image
// (what a restore writes back), so a `-` row is text the restore removes and a
// `+` row is text it restores.

const MAX_LINES = 1500;
const MAX_ROWS = 120;

/**
 * @param {string} before archived text (restore target)
 * @param {string} after current text on disk
 * @param {{ maxLines?: number, maxRows?: number, context?: number }} [options]
 * @returns {{ truncated: boolean, added: number, removed: number, rows: Array<{ type: 'context'|'add'|'del', text: string }> }}
 */
export function diffLines(before, after, options = {}) {
  const maxLines = Number.isInteger(options.maxLines) ? options.maxLines : MAX_LINES;
  const maxRows = Number.isInteger(options.maxRows) ? options.maxRows : MAX_ROWS;
  const context = Number.isInteger(options.context) ? options.context : 2;
  const a = String(before ?? '').split('\n');
  const b = String(after ?? '').split('\n');
  if (a.length > maxLines || b.length > maxLines) {
    return { truncated: true, added: 0, removed: 0, rows: [] };
  }
  const n = a.length;
  const m = b.length;
  // LCS table over lines; the inputs are bounded by maxLines.
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const all = [];
  let i = 0;
  let j = 0;
  let added = 0;
  let removed = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      all.push({ type: 'context', text: a[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      all.push({ type: 'del', text: a[i] });
      i += 1;
      removed += 1;
    } else {
      all.push({ type: 'add', text: b[j] });
      j += 1;
      added += 1;
    }
  }
  while (i < n) {
    all.push({ type: 'del', text: a[i] });
    i += 1;
    removed += 1;
  }
  while (j < m) {
    all.push({ type: 'add', text: b[j] });
    j += 1;
    added += 1;
  }

  // Keep only changed rows plus their neighbourhood; drop long unchanged runs.
  const keep = new Array(all.length).fill(false);
  for (let index = 0; index < all.length; index += 1) {
    if (all[index].type === 'context') continue;
    for (let around = index - context; around <= index + context; around += 1) {
      if (around >= 0 && around < all.length) keep[around] = true;
    }
  }
  const rows = [];
  let skipped = 0;
  for (let index = 0; index < all.length; index += 1) {
    if (keep[index]) {
      if (skipped > 0) {
        rows.push({ type: 'context', text: `… ${skipped} 行未变化 …` });
        skipped = 0;
      }
      rows.push(all[index]);
    } else {
      skipped += 1;
    }
  }
  const clipped = rows.slice(0, maxRows);
  return {
    truncated: rows.length > maxRows,
    added,
    removed,
    rows: clipped,
  };
}
