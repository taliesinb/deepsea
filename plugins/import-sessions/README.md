# @deepsea/import-sessions

`/import-claude`, `/import-pi` and `/import-dsh` bring **Claude Code** and
**pi** coding-agent transcripts, and the sessions of **another home or a
backup**, into DeepSea as real, resumable sessions, grouped into the
workspace whose directory matches the transcript's working directory.

| Source | Store | Session id |
|---|---|---|
| Claude Code | `~/.claude/projects/<slug>/<uuid>.jsonl` (+ `<uuid>/subagents/agent-*.jsonl`) | `claude-<uuid>` (children `claude-<uuid>-agent-…`) |
| pi | `~/.pi/agent/sessions/--<path>--/<ts>_<uuid>.jsonl` | `pi-<uuid>` |
| another home | `<home>/sessions/<workspace>/<session>/`, or a @deepsea/backup-restore `.backup.deepsea.zip` / `.rollback.deepsea.zip` (or the earlier `.backup.dsh.zip`) | kept |

## What the person sees

The bare command (or `/import-claude ` + Enter) opens **one dialog**:

1. **Pick**: one line per place the transcripts can be. *From
   `~/.pi/agent/sessions` on `<this device>`* · **Upload** opens the
   standard folder chooser (the DeepSea app opens it at the store and also
   takes a single transcript): the store or a workspace folder is a bulk
   import, one transcript a single one; the transcripts among the chosen
   files are gzipped and uploaded in chunks. When the page is another
   machine's client and the server has the store too, *From … on `<server>`*
   · **Choose** reads the server's own store instead. For `/import-dsh`,
   **Choose** opens the server's own file-or-folder panel beside its home
   (`~/.deepsea`): another home, one of its sessions folders, or a backup.
2. **Decide**: a tree of workspaces → sessions (bulk) or a single-session
   card. Each workspace (or the card) has an **Import to** lozenge: the
   workspace whose path equals the transcript's `cwd`, else a new one named
   after the directory under the **Place new workspaces in** base (default
   `~/`), any existing workspace, or ungrouped. Sessions already imported,
   and duplicates within the selection, are hidden unless asked for and are
   not selectable. A filter field narrows by title or path.
3. **Large sessions**: when a *selected* session's estimated model-visible
   surface exceeds `largeTokens` (default 100K), one more step chooses for
   those: **Compacted** (turns before the last `keepTurns` folded behind a
   checkpoint note, tool results capped at `resultCap` characters; the
   session can be prompted) or **Original** (everything as-is; it reads and
   searches in full but is too large to prompt until compacted). The other
   selected sessions import in full.
4. **Import** runs with progress (closing the dialog does not stop it; the
   sessions appear in the sidebar as they are written), then a per-session
   summary: turns, tool calls, images, truncations, folded turns, child
   sessions, token estimate.

Enter presses the stage's primary button and Escape closes
(`src/client/dialog-keys.ts`). The dialog holds no explanations; this file
does.

Without the GUI: `/import-claude <path>` (a transcript, a workspace folder or
the store) imports headlessly in archive mode into the directory-matched
workspaces; the bare command summarizes the store (workspaces, sessions, how
many already imported). `/import-dsh` works through the dialog only.

## Fidelity

- Claude Code writes one record per content block; runs sharing a
  `message.id` are regrouped into one assistant message (one step), so tool
  results pair with their calls. `[Request interrupted]` closes the turn as
  interrupted; injected context (`<system-reminder>`, hook outputs, task
  notifications, attachments, mode and queue bookkeeping) is dropped and
  counted; `aiTitle` becomes the title. Subagent transcripts become child
  sessions (`parentSession`, `origin: 'subagent'`) so the subagent tree
  renders.
- pi logs are trees (edits and regenerations branch); the **main branch**,
  root to the latest leaf, is imported and the abandoned records counted.
  pi's own `compaction` records become a prune (`compaction/prune` and the
  replacing message, marked `deepsea-import-sessions/pi-compaction`) whose
  summary replaces the surface before it; `session_info.name` is the title.
  The working-session fold is written the same way (marked
  `deepsea-import-sessions/fold`).
- A tool call the transcript never answered (an interrupted turn) gets an
  error result in its step, so every call is settled: the current format
  refuses an unresolved call, and providers reject a `tool_use` without a
  `tool_result`.
- Images (user messages, tool results) go through the attachment service
  and render as real images. Usage is carried per assistant message.
- Everything is written through the harness's own services:
  `sessionPersistence`, `attachments`, `sessionProjectionCache` (title in the
  sidebar before first open), `workspaceRegistry`'s `attachSession`, and the
  `session-persistence/stored` event, so nothing touches log files directly
  and nothing needs a restart. The builder produces format v3, which the
  harness's own released-format migration (`@deepseek-ai/dsh-session-format-catalog`,
  `toCurrentFormat` in `host/importer.mjs`) brings to the current format,
  each imported subagent child declared to its parent's migration.
- Another home's sessions are read with the harness's JSONL persistence and
  stored through the Session Controller's `storeSessionLogs` (harness topic
  `session-relocation`), keeping their ids, each root with its subagent
  descendants, into a workspace. The attachments their logs reference are
  copied first, from the source's `attachments/v1/` (in a backup, read from
  the archive) through the attachment service: images (`objects/`) with
  `saveImage`, which reproduces their id because stored images are already
  normalized, and verbatim files (`files/`) with `saveFile`. Bytes whose
  digest is not their id are not saved; attachments this home has are left
  alone. The summary counts them with the images (`3/5 images`: two were not
  in the source; the server log names each one). The home the server runs on
  is refused.

## Where it reads and writes

- The stores are read on the server at the configured roots, or from an
  upload. Uploads live under `$DSH_HOME/plugins/import-sessions/uploads/<id>/`
  while the dialog is open and are deleted after the import (or swept after
  a day); only file names that look like transcripts of the chosen source
  are accepted, with sanitized relative paths.
- A backup archive's `home/sessions/` (`dsh/sessions/` in the earlier layout) is extracted to
  `$TMPDIR/deepsea-import-sessions-…` for the scan and removed after the
  import.
- New workspaces are created at `<base>/<basename of the original cwd>` on
  the server (`mkdir -p`).
- **Same machine or not.** The dialog names this device and the server; a
  request is from the server's own machine when it reached the server on
  loopback without the Tailscale proxy, or when @deepsea/tailscale's proxy
  marks it `x-deepsea-tailscale-self: 1`; otherwise (`x-deepsea-tailscale:
  1`) the peer's host name comes from `tailscale status --json` when the CLI
  exists. Without the tailscale plugin every request is local.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `claudeRoot` / `piRoot` | `~/.claude/projects` / `~/.pi/agent/sessions` | the server's stores |
| `largeTokens` | 100000 | estimated surface tokens above which a session is large |
| `keepTurns` / `resultCap` | 20 / 4096 | the Compacted defaults offered in the dialog |
| `archiveResultCap` | 0 | archive mode's per-tool-result cap (0 = unlimited) |

## Files

| File | Role |
|---|---|
| `index.js` | host: the commands and the control routes (PROTOCOL.md) |
| `host/events.mjs` | the session event builder and an invariant checker |
| `host/claude-reader.mjs`, `host/pi-reader.mjs` | the two transcript readers |
| `host/sources.mjs` | store discovery and the scan |
| `host/dsh-source.mjs` | `/import-dsh`: homes, sessions folders and backup archives |
| `host/uploads.mjs` | device uploads |
| `host/picker.mjs` | the server's own file-or-folder panel (macOS; folders only with zenity/kdialog on Linux) |
| `host/hosts.mjs` | which machine a request comes from |
| `host/importer.mjs` | one transcript → one stored session; the job runner |
| `src/client/` | the dialog (`index.tsx` and its stages; `dialog-keys.ts` is identical in every plugin with a dialog) |
| `PROTOCOL.md` | the host ⇄ browser protocol |

## Requirements

Harness topics `session-relocation` (`storeSessionLogs` and the
`session-persistence/stored` event), `command-claim-decoration` (`/import-claude `
+ Enter opens the dialog like the bare command) and `modal-width`. `unzip` on
`PATH` for backup archives.

## Development

```sh
pnpm install && pnpm build && pnpm typecheck && pnpm test
```

`pnpm install` needs the repository's `harness` link (`dsd link`). The tests
build their own stores and homes under `$TMPDIR/deepsea-import-sessions-…`
and remove them. In a throwaway, point `claudeRoot` and `piRoot` at fixture
stores (a `--patch` row with this plugin's id and a `config:`), so nothing
reads a real store.
