# @deepsea/backup-restore

`/backup` packs the whole home (`$DSH_HOME`) into a private ZIP in the
variant's backups directory; `/restore` puts one back. Both are host commands
that work without the web GUI; in the GUI the bare commands open dialogs.

```text
/backup            the confirmation dialog (bare, `/backup ` + Enter, or the slash menu), then the backup
/restore           the chooser of backups; Restore saves a rollback and restarts onto the chosen one
/restore FILE      restore that backup (a file name in the backups directory, never a path)
```

Without the browser half, bare `/backup` backs up at once and bare
`/restore` lists the backups.

## Where things go

| What | Where |
|---|---|
| The home | `$DSH_HOME` (`resolveDshHome()`), e.g. `~/.deepsea/<v>/` |
| Backups | config `directory`, else `_backups/<v>/` beside the home: `~/.deepsea/_backups/<v>/` (LAYOUT.md §4) |
| The variant `<v>` | `$DEEPSEA_VARIANT`, else the home's directory name (`~/.deepsea/personal` → `personal`) |
| Restore logs | the plugin's log directory (@deepsea/logs): `~/Library/Logs/io.github.taliesinb.deepsea.<v>/plugins/backup-restore/<ts>-<pid>.log`, one per restore, `latest.log` pointing at the newest (`<home>/logs/plugins/backup-restore/` for a home outside the DeepSea root) |
| Restore status | `<backups>/.restore-status/<id>.json` |
| Staging | `_restore-<v>-…` beside the home, removed after the swap |

The variant comes from `DEEPSEA_VARIANT` when the launcher sets it and from
the home's name otherwise (@deepsea/logs' `variantOf`, the rule LAYOUT.md §5
gives for log directories), so backups and logs always agree. Backups sit
beside the homes, never in one (a backup inside the home would include
itself), and a home outside the DeepSea layout gets its `_backups/` beside it
all the same, so a test home never writes into a real variant's backups. The
backups directory is created `0700` and the ZIPs are `0600`: they hold
credentials; do not publish them.

## Backup

The ZIP holds the manifest `deepsea-backup.json` (format `deepsea-home-v1`: counts,
and every file with its size, link target or SQLite flag) and the home under
`home/`:

- **SQLite databases** are snapshotted through Node's online backup API:
  committed WAL transactions are included in a standalone database file, and
  each snapshot passes `PRAGMA integrity_check`; WAL/SHM/journal sidecars are
  left out. A `.db`/`.sqlite` file without a SQLite header, or a sidecar
  without its database, aborts the backup instead of producing a misleading
  ZIP.
- **Links are archived as links**, never followed: the home's `logs`,
  `support` and `source` links (LAYOUT.md §4) keep the launch token and the
  builds out of every backup, and a restore recreates them. Installed plugin
  links keep their targets.
- **Sockets and FIFOs** (runtime endpoints) are left out; their owners
  recreate them. Any other special file aborts the backup.
- Every other file is copied; a file whose size changes during the copy
  aborts the backup.

The ZIP is written under a temporary name, tested (`unzip -t`), compared with
the staged file list, and only then renamed into place.

Names: `y2026m09d28h14m03s04.h<host>.f<harness commit>.p5.w1.s3.backup.deepsea.zip`
(local time, this machine's short host name, the harness commit, and the
counts of plugins, workspaces and sessions); rollbacks
`h<host>--y2026-m09-d28-h14-m03-s04--c<harness commit>-p5-w1-s3.rollback.deepsea.zip`.

It covers everything inside the home: sessions, attachments, settings,
credentials, profiles, plugin state. It does not cover workspace directories
outside the home, plugin sources, the backups themselves, the process
environment, or data configured to live elsewhere.

The dialog asks "Back up this home to `<dir>`?", then shows the workspace and
session counts, the path with a copy button, and the size.

## Restore

1. The archive is validated: a regular file in the backups directory, a
   good ZIP, every entry under `home/` or the manifest (no absolute paths, no
   `..`, no duplicates), entry types and sizes matching the manifest.
2. A **rollback** of the current home is written and verified first; if
   that fails, nothing else happens and the server keeps running.
3. A pending status is recorded, the detached restore worker
   (`restore-worker.mjs`) is started, and the server shuts itself down
   gracefully (SIGTERM, 400 ms after the reply).
4. The worker waits for the server's process to exit (at most 60 s; if it
   does not, the home is left untouched and the restore recorded as failed),
   extracts the archive beside the home, checks every file against the
   manifest and every database's integrity, and swaps the homes by rename.
5. If anything fails, it puts the rollback back the same way. The outcome
   (`restored`, `rolled-back`, `rollback-failed`, `failed`) goes to the
   status file and each step to the run log.

An installed variant's relay (apps/relay) starts the server again on the
next connection, on the restored home; without one, start it by hand. The
page that started the restore keeps the attempt in sessionStorage
(`deepsea.backup-restore.pending`), polls the status while the server is
away, reloads when the server answers again, and then shows the verified
outcome: the restored archive and the rollback, each with counts, path, size
and a copy button; a failed rollback names the run log.

## Limitations

- Each SQLite database is consistent on its own, with its committed WAL
  transactions; there is no transaction across databases or with the JSON
  and session files. Other files are copied while the server runs: a
  changing size is caught, a same-size rewrite or a multi-file update in
  flight is not. For a strict whole-home snapshot, stop the server and copy
  the home. The rollback is taken while the server still runs, too.
- A restore replaces the whole home: anything created after the backup
  disappears. An interrupted turn does not resume by itself.
- Restoring onto another machine needs what the archived links point at
  (builds, plugins) to exist there.
- Empty directories are not archived.

## Control routes

`POST /deepsea-backup-restore/{list,backup,restore,status}` with the
Connection JSON envelope, behind DSH's own request gate
(`connection.requestRejection`: the Host/Origin fence and the browser-session
cookie). `list` → `{ shownBackups, archives, restoring }`; `backup` → the
written ZIP; `restore { name }` → the attempt (`id`, selected and rollback
archives); `status { id }` → the status file.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `directory` | `_backups/<v>/` beside the home | the backups directory (absolute or `~/…`); must lie outside the home |

```yaml
- id: deepsea-backup-restore
  config:
    directory: ~/Backups/deepsea
```

## Files

| File | Role |
|---|---|
| `index.js` | host half: `/backup`, `/restore`, the control routes, `Config` |
| `archive.mjs` | backup, validation, extraction, the home swap |
| `paths.mjs` | the home, variant and backups directory; the restore worker's run log (@deepsea/logs) |
| `restore-worker.mjs` | the detached worker that restores after shutdown (`performRestore`) |
| `restore-status.mjs` | one atomic status file per restore |
| `src/client/index.tsx` | browser half: the decorations and the dialog |
| `build.mjs` | esbuild → `lib/client.js` in the shell's module-loader wrapper |
| `cordis.patch.yml` | bundle patch inserting the `deepsea-backup-restore` row |

## Requirements

Harness topics `command-claim-decoration` (`/backup ` + Enter opens the
confirmation like the bare command, instead of backing up at once) and
`modal-width` (the dialog's width). `zip`, `unzip` and `zipinfo` on `PATH`;
Node with `node:sqlite`.

## Development

```sh
pnpm install && pnpm build && pnpm typecheck && pnpm test
```

`pnpm install` needs the repository's `harness` link (`dsd link`). The tests
work in their own temporary directories only. In a throwaway, point
`directory` at a scratch directory: a throwaway's default backups directory
is `~/.deepsea/_backups/<id>/`, which removing the throwaway leaves behind.
