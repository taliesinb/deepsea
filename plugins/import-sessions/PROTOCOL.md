# @deepsea/import-sessions: host ⇄ browser protocol

Control routes: `POST /deepsea-import-sessions/<endpoint>` with the Connection
JSON envelope (as @deepsea/reboot and @deepsea/import-api-keys use it), sent
through the client's `connection.rpc.call('/deepsea-import-sessions', endpoint,
{ args })` and gated by DSH's own request check (`connection.requestRejection`):

```json
{ "type": "client-request", "rpcId": "…", "method": "<endpoint>", "payload": { "args": { … } } }
→ { "type": "server-response", "rpcId": "…", "result": { "ok": true, "value": … } | { "ok": false, "error": { "code": "deepsea-import-sessions/…", "message": "…", "details": {} } } }
```

All endpoints are POST. `source` is `'claude' | 'pi' | 'dsh' | 'workspace' |
'session'` (`dsh`: another home, a backup or an export, read on the server;
never uploaded. `workspace` / `session`: one `.workspace.deepsea.zip` /
`.session.deepsea.zip` export, read on the server or uploaded).

## `sources` — `{}`

```ts
{
  platform: 'darwin' | 'linux' | 'win32' | string,
  pickerAvailable: boolean,          // a native file-or-folder chooser can be shown on the server machine
  sources: {
    claude: { label: 'Claude Code', root: string, defaultRoot: '~/.claude/projects',   exists: boolean },  // root: expanded server path; exists: the server store holds ≥1 workspace
    pi:     { label: 'pi',          root: string, defaultRoot: '~/.pi/agent/sessions', exists: boolean },
    dsh:    { label: 'DeepSea',     root: string, defaultRoot: string,                 exists: true },     // root: the directory holding the server's home (~/.deepsea)
    workspace: { label: 'workspace', root: string, defaultRoot: '~/Downloads',         exists: true },     // where the server's chooser opens for an export
    session:   { label: 'session',   root: string, defaultRoot: '~/Downloads',         exists: true },
  },
  server: { host?: string },                                          // short host name of the server machine
  client: { sameMachine: boolean, host?: string },                    // is this request from the server machine itself? (x-deepsea-tailscale / -self headers of @deepsea/tailscale's proxy, else a loopback peer) host = tailnet peer name when known
  workspaces: Array<{ id: string, title: string, path: string }>,      // existing workspaces, for destination overrides
  pickerKind: 'file-or-directory' | 'directory' | 'none',            // Linux choosers are directory-only
  defaults: { keepTurns: number, resultCap: number },                 // configured working-mode defaults
}
```

## `pick` — `{ source }`

Opens the native chooser on the server machine, rooted at the source's root,
allowing ONE file or ONE directory. Long-running (resolves when the dialog
closes). `{ path: string | null }` — `null` = cancelled. Fails with
`deepsea-import-sessions/picker-unavailable` when no chooser exists. The
dialog uses it for `dsh` only (rooted at the directory holding the server's
home); for `claude` and `pi` it reads the server's store directly.

## `upload-begin` / `upload-chunk` / `upload-finish` / `upload-discard`

For clients whose transcripts live on THEIR device (the DeepSea app or a
browser on a laptop talking to a shared host). The browser picks a folder or a transcript
with the standard HTML chooser (`<input type="file" webkitdirectory>` for a
folder, `<input type="file" accept=".jsonl">` for one transcript), keeps only
transcript files (see filter below), and streams each one gzipped in base64
chunks. All chunks of one file go in order; files may be sequential.

```ts
upload-begin   { source }                                   → { uploadId, chunkBytes }     // chunkBytes = max RAW bytes per chunk (4 MiB)
upload-chunk   { uploadId, path, data, encoding, offset }   → { bytes }                    // path: relative posix path (below); data: base64 of the (gzipped) bytes; encoding: 'gzip' | 'identity'; offset: bytes of ENCODED data sent before this chunk
upload-finish  { uploadId }                                 → { path, files, bytes }       // path is a server directory: pass it to `scan` as-is
upload-discard { uploadId }                                 → { discarded }                // on cancel / close before import; after `import` with uploadId the server discards it itself
```

Relative `path` rules (the server rejects anything else): keep the chooser's
`webkitRelativePath` MINUS its first segment when the chosen folder is the
store root or a workspace directory… simplest robust rule: send the
`webkitRelativePath` verbatim (it starts with the chosen folder's name); the
server classifies by content, so the wrapper directory is harmless. For a
single transcript send its `name`. Client-side FILTER before uploading:
- claude: `<uuid>.jsonl` at any depth, plus `<uuid>/subagents/agent-*.jsonl`; skip `memory/`, `*.backup`, everything else
- pi: `<ISO-ts>_<uuid>.jsonl`; skip everything else
- workspace / session: the one chosen file, when its name ends in `.workspace.deepsea.zip` / `.session.deepsea.zip`; sent as its bare name
Show upload progress (files done / total, bytes). `upload-chunk` errors are fatal
for that upload (discard it).

## `scan` — `{ source, path }`

`path` may be the source root, one workspace slug directory, one session
file, or the directory returned by `upload-finish`. For `workspace` and
`session` it is the export file, or an upload directory holding it; the
reply's `path` is the export file, its `kind` is `workspace` / `session`, and
an export of the other kind, or one holding more than one workspace (or,
for `session`, more than one session), fails the scan. The scan READS EVERY
transcript fully (fast: hundreds of MB/s) so counts are exact. Returns a tree:

```ts
{
  source: 'claude' | 'pi',
  path: string,
  kind: 'root' | 'workspace' | 'session',   // what the user selected
  uploaded: boolean,           // the path is an upload: workspace dirs are the CLIENT's, so `new` is rarely offered
  largeTokens: number,         // the configured threshold
  workspaces: Array<{
    key: string,                 // slug directory name (stable row key)
    dir: string,                 // decoded original working directory (from session headers when available)
    dirExists: boolean,
    destination:                 // computed default; the client may override per workspace
      | { kind: 'existing', workspaceId: string, title: string }
      | { kind: 'new', title: string }            // basename(dir); created at import time
      | { kind: 'ungrouped', reason: string },    // e.g. directory no longer exists
    sessions: Array<{
      id: string,                // stable session id: `claude-<uuid>` | `pi-<uuid>` (dsh: the stored id)
      sourceId: string,          // the source's own id
      file: string,              // absolute path of the transcript
      title: string,             // Claude aiTitle / pi session_info.name / first prompt excerpt / fallback
      startedAt: number,         // epoch ms
      endedAt: number,           // epoch ms (file mtime or last record)
      bytes: number,
      prompts?: number,          // user prompts counted
      turns: number,             // exact turns the import will produce
      toolCalls: number,
      estimatedTokens: number,   // model-visible surface estimate (DSH's token meter)
      large: boolean,            // estimatedTokens > largeTokens → offer the working-session fold
      imported: boolean,         // a session with this id already exists → not selectable
      duplicateOf?: string,      // same sourceId seen earlier in this scan (pi: moved worktrees) → not selectable
      subagents?: number,        // Claude: subagent transcripts that will become child sessions
    }>,
  }>,
}
```

## `import` — `{ source, selections, uploadId? }`

```ts
type Mode =
  | { kind: 'archive' }                                          // full fidelity; a huge one may not be promptable
  | { kind: 'working', keepTurns: number, resultCap: number }    // fold turns before the last keepTurns behind a checkpoint note; cap tool-result text (chars)
selections: Array<{
  file: string,                 // transcript path from `scan`
  destination:                  // final per-session choice (the client resolves the workspace-level select to each session)
    | { kind: 'existing', workspaceId: string }
    | { kind: 'new', dir: string }        // create a workspace at `dir` (`~` ok; mkdir -p if missing) titled basename(dir); the client builds it as `<placement base>/<basename of the original cwd>`
    | { kind: 'ungrouped' }
  mode: Mode,                   // per session: the "large sessions" choice for large ones, {kind:'archive'} for the rest
}>
uploadId?: string               // when the files came from an upload: the server deletes the upload after the job
scanToken?: string              // dsh: the token `scan` returned; selections name sessions by id in `file`
→ { jobId: string, total: number }
```

## `progress` — `{ jobId }`

```ts
{
  jobId: string,
  total: number,
  done: number,
  current?: { file: string, title: string, phase: 'reading' | 'writing' | 'attaching' },
  finished: boolean,
  results: Array<{
    file: string,
    ok: boolean,
    sessionId?: string,
    title?: string,
    workspace?: { id: string, title: string } | null,   // null = ungrouped
    counts?: {                                         // fidelity report
      turns: number, steps: number, toolCalls: number, toolResults: number,
      images: number, imagesImported: number, truncatedResults: number,
      droppedRecords: number, orphanResults: number, foldedTurns?: number, children?: number,
      surfaceTokens?: number,                          // estimate after any fold
    },
    error?: string,
  }>,
}
```

Jobs live in host memory for 10 minutes after finishing; `progress` for an
unknown job fails with `deepsea-import-sessions/unknown-job`.

## Client flow

`/import-claude`, `/import-pi`, `/import-dsh`, `/import-workspace` and
`/import-session` are host slash commands; the
browser half decorates the bare command (`commandUi.decorate`, `ui.kind =
'action'`) to open ONE dialog. Its stages:

1. **pick**, one line per place the transcripts can be:
   - `From <store> on <this device>` · **Upload**: the standard folder chooser
     (`<input type=file webkitdirectory>`; the DeepSea app opens it at the
     store through its `open-panel` hint and also accepts a single file) →
     filter → upload with progress and Cancel → `upload-finish` → `scan`.
   - `From <store> on <server>` · **Choose**, only when the client is another
     machine (`!client.sameMachine`) and the server has that store
     (`sources[source].exists`): `scan` of the server's own store.
   - `/import-dsh`: `From ~/.deepsea on <server>` · **Choose**: `pick` (the
     server's own file-or-folder panel, rooted beside its home) → `scan`.
   - `/import-workspace`, `/import-session`: `From ~/Downloads on <this device>`
     · **Upload** (`<input type=file accept=.zip>`, one file) → upload →
     `scan`; on another machine's client also `From ~/Downloads on <server>` ·
     **Choose**: `pick` → `scan`.
2. **scanning**.
3. **decide**, two shapes:
   - **bulk** (`kind !== 'session'`): a filter field and the tree table
     (workspace rows: tri-state checkbox, `~`-collapsed dir, ⚠ when
     `!dirExists` and the dirs are this machine's, destination lozenge with a
     menu: the new workspace (green, under the "Place new workspaces in"
     base), every existing workspace, ungrouped; session leaves: checkbox,
     title, date range, size, turns, `~tokens`, `N subagents`). Imported and
     duplicate sessions are hidden unless "Show already imported" is ticked.
     Root scans start with nothing selected; workspace scans with everything
     selectable selected.
   - **single** (`kind === 'session'`): a card with the session's title, dates,
     size, turns, tool calls, tokens, where it was recorded and **Import to**
     with the same choices.
   - **workspace** (`/import-workspace`): a card with the directory's name,
     sessions (and how many are already imported), dates, turns, where it was
     recorded and **Import to**; every importable session is selected.
   - For an export the description line is the export's file name.
   - Footer: count · Back · Cancel · **Import N sessions** (disabled at 0).
4. **large**, only when a SELECTED session is `large`: "N selected sessions
   exceed ~X tokens" and two cards, **Compacted** (default; keep the last
   `keepTurns` turns visible, cap tool results at `resultCap` characters, both
   editable, from `sources.defaults`) and **Original** (everything as-is),
   applied to the large ones only; the rest import in full.
5. **running**: poll `progress` every 500 ms; progress bar and current
   title and phase. Closing the dialog does not stop the job.
6. **summary**: per-session rows (ok/error, title → workspace, counts); Close.

Enter presses the stage's primary button (Upload / Choose, Import, Close;
`dialog-keys.ts`) and Escape closes. Closing the dialog at pick or decide
after an upload calls `upload-discard`.
