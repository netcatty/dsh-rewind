# dsh-rewind

A DeepSeek Harness plugin that **rewinds the conversation in place to any of your earlier messages**, optionally restores the files that turn changed, and puts the original text back in the composer so you can edit and resend.

Same engineering shape as `dsh-mcp` and `dsh-session`: one Host half, one Web Client half, one data directory, zh/en copy, and a `/rewind` command.

## What it adds

| Surface | Behaviour |
| --- | --- |
| In-place rewind | The target message and everything after it leave the model context; the conversation stays in the same session, with no branch |
| Append-only log | One marker (`user/message` + `surfaceOp: replace`) is appended. History, trajectory and audit are never rewritten |
| File snapshots | Pre-images of files touched by `write` / `edit` / `delete` are captured before the mutation and restored (or removed) on rewind |
| Composer refill | The withdrawn text returns to the input box, ready to edit and resend |
| Transcript sync | Withdrawn turns are hidden after a rewind, and new turns are never hidden by mistake |
| Confirmation dialog | Shows the message, the affected files, and whether each file will be restored or removed before anything runs |
| Command entry | `/rewind` lists candidates, `/rewind <n>` rewinds, `/rewind <n> files` rewinds and restores files, `/undo` withdraws the most recent Turn |

## Install

```sh
dsh plugin --profile web add @netcatty/dsh-rewind
```

Refresh the page. A `↶` action appears beside the Copy button under each of your own messages.

## Data

```
$DSH_HOME/dsh-plugins/dsh-rewind/archive/
  index.json            per-session, per-Turn pre-image records
  blobs/<sha256>.bin    the bytes as they were before the mutation
```

Caps: 2 MiB per file, 200 files per Turn, 500 Turns total. `.git` metadata is never recorded. Tune with `maxFileBytes`, `maxFilesPerTurn`, `maxTurns`, `archiveFiles`, `archiveDir` on the plugin row.

## Boundaries

- In-place rewind requires an **open** session; a cold session answers 409.
- The session log is **append-only**; only a marker event is added.
- File restore only touches paths recorded at runtime, never a path from a request body; symlinked targets are skipped.
- There is no lossless undo in this version: rewind, edit and resend. Withdrawn content remains in the trajectory view and exports.
- `/api/dsh-rewind/*` reuses DSH's `connection.admit` authentication and falls back to loopback/same-origin when that service is absent.
- Snapshot capture depends on the `fs/*-intent` waterfalls, so writes made through `bash`, git, or external tools are out of scope.
- The action is injected beside the host's Copy button on the user row; a future host markup change can hide the action, never break the row.

## License

MIT
