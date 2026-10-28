# @deepsea/export-sessions

`/export-workspace` and `/export-session` write a workspace or a session to a
ZIP on the server, for `/import-workspace` and `/import-session`
(@deepsea/import-sessions) on another machine.

```text
/export-workspace            the workspace of the session the command runs in
/export-workspace NAME       a workspace by title (case-insensitive), path (~ allowed) or id
/export-session              the session the command runs in
/export-session NAME         a session by title (case-insensitive) or id
```

A title several workspaces or sessions share is refused, with their paths or
ids to choose from. In the GUI the bare commands open a dialog that exports
at once and shows the counts, the path (with a copy button), the size, and a
**Download** button that fetches the ZIP from the server, for a browser on
another machine. Without the GUI, or with a name, the command answers with
the same facts as text.

The harness's own `/export` (a browser download of one session in its own
format, which `/import-session` does not read) is still there.

## What an export holds

The layout of a @deepsea/backup-restore home backup, with only part of the
home under `home/`, so `/import-dsh` reads backups and exports alike:

| Entry | |
|---|---|
| `deepsea-backup.json` | the manifest: `format` (`deepsea-workspace-v1` or `deepsea-session-v1`), `createdAt`, `workspace` (`title`, `path`) or `session` (`id`, `title`, `cwd`, its `workspace`), `counts` (`sessions`, `attachments`), `missingAttachments`, and every file with its size |
| `home/sessions/<project>/<session>/…` | the directory of each exported session, without `session.lock` |
| `home/attachments/v1/objects/<2>/<sha>`, `file-objects/<2>/<sha>`, `files/<2>/<sha>/<name>` | every image and verbatim file the exported logs reference |

A workspace export holds the workspace's sessions; a session export holds one
session. Both include every subagent session under them. Sessions are found
through the server's session persistence, which is flushed first, so a
running session (the one the command runs in, say) is exported with its
newest events. A log that grows while it is copied is copied again, up to
five times. `missingAttachments` counts attachments a log references that
this home's store lacks; the server log names the export.

Names: `y2026m09d28h21m03s04.h<host>.f<harness commit>.s12.<title>.workspace.deepsea.zip`
or `….session.deepsea.zip`: local time, this machine's short host name, the
harness commit, the number of sessions (subagent sessions included) and the
title reduced to `[A-Za-z0-9_-]`. Exports are written `0600`: they hold whole
conversations. `/restore` refuses them.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `directory` | `~/Downloads` | where exports are written (absolute or `~/…`; created when missing) |

```yaml
- id: deepsea-export-sessions
  config:
    directory: ~/Exports
```

## Routes

`POST /deepsea-export-sessions/export { kind: 'workspace' | 'session', sessionId }`
with the Connection JSON envelope exports the workspace holding that session,
or the session; `GET /deepsea-export-sessions/download/<name>` serves an
export from the directory (only names ending in `.workspace.deepsea.zip` or
`.session.deepsea.zip`, never a path). Both sit behind DSH's own request gate
(`connection.requestRejection`).

## Files

| File | Role |
|---|---|
| `index.js` | host half: the commands, the routes, `Config`, finding a workspace or session by name |
| `archive.mjs` | the export: sessions and descendants, attachments, staging, the verified ZIP |
| `src/client/index.tsx` | browser half: the dialog of the bare commands |
| `build.mjs` | esbuild → `lib/client.js` in the shell's module-loader wrapper |

## Requirements

`zip` and `unzip` on `PATH`; the JSONL session persistence (session
directories under `<home>/sessions/`).

## Development

```sh
pnpm install && pnpm build && pnpm typecheck && pnpm test
```

The tests work in their own temporary directories. In a throwaway, point
`directory` at a scratch directory (a `--patch` row with this plugin's id).
