# @deepsea/fs-tools

Batch filesystem tools, registered **beside** the built-in `read` / `edit` /
`grep` / `glob` under their own names. Each covers something agents otherwise
do in bash, where the harness cannot see it:

| In bash | Tool |
|---|---|
| `python3 - <<'EOF' … s.replace(old, new) … EOF; pnpm typecheck` | `edit_many` (+ `verify`) |
| `sed -n 'X,Yp' a; echo ---; sed -n … b` | `read_many` |
| `ls` / `tree` / `find -maxdepth` (`glob` returns files only) | `list_dir` |
| `grep -rn -A3 --include=*.ts … \| grep -v …` | `search` |

Everything goes through `ctx.fs`, so the session's sandbox mode and the
read-before-edit policy apply exactly as for the built-ins; `search` spawns
the harness's packaged `@vscode/ripgrep` through `ctx.subprocess`. The tools
are global (no per-session state), so subagents get them too.

## Tools

### `list_dir`

```
list_dir { paths?: string[], depth?: 1..6, max_entries?: int, sizes?: bool, all?: bool }
```

Directories included, `/`-suffixed, listed before files. Several roots per
call. `node_modules`, `.git`, `dist`, `lib`, `build`, hidden directories and
similar are shown as one row and not descended unless `all: true`. A missing
or non-directory root is reported inline; the other roots still list. Stops
at `max_entries` (default 300) with a note.

### `read_many`

```
read_many { files: (string | { path, offset?, limit? })[], collapse_blank?: bool, max_lines?: int }
```

Several files, or several ranges of one file, in one call. Each entry renders
like `read` (`<path>…</path>`, `N: text` rows, the range shown). **Every file
read emits `fs/observed`**, so a following `edit` / `edit_many` is authorised
without a separate `read` (a `sed -n` read in bash is invisible to the
policy, and the edit after it fails with `FS_NOT_OBSERVED`). A missing file is
observed absent and reported inline; a directory is reported inline; the rest
of the call still returns. `max_lines` (default 4000) is a total budget across
entries.

### `edit_many`

```
edit_many {
  edits: ({ file_path, op?: 'replace', old_string, new_string, replace_all? }
        | { file_path, op: 'insert_after' | 'insert_before', marker, new_string }
        | { file_path, op: 'replace_between', start, end?, new_string, inclusive? }
        | { file_path, op: 'append', new_string })[],
  verify?: { command, workdir?, timeout_ms?, max_lines? },
  dry_run?: bool,
}
```

Several edits across several files in one call, then optionally a check
command in the same call. Ops (`replace` is the default and follows `edit`'s
rules: exactly one match unless `replace_all`):

| op | anchors | effect |
|---|---|---|
| `replace` | `old_string` (unique, or `replace_all`) | literal replacement; `""` deletes |
| `insert_after` / `insert_before` | `marker` (unique) | `new_string` as its own line(s) right after / before the **line** holding the marker |
| `replace_between` | `start` (unique), `end` (unique after start; omit = end of file) | the text between the markers becomes `new_string` (markers stay unless `inclusive: true`); `""` deletes; `start` + no `end` + `""` truncates the file after the marker |
| `append` | none | `new_string` at the end of the file (a newline is added before it if missing) |

Structural ops are translated into marker-anchored literal replacements, so
they inherit the uniqueness rule and the compare-and-swap; only `append` takes
the versioned whole-file write. Three phases:

1. **validate**: every target resolved; the read guard (`fs/edit-intent`)
   consulted **and** the current version compared with the observed one;
   every anchor found and unique **in the file as it will be after the
   earlier edits of the same call** (so edit #2 may match text produced by
   edit #1). All problems are collected and returned together, numbered `#k`;
   **nothing is written if any fails.** A failed anchor comes back with its
   **regions**: every occurrence with a line of context when there are
   several, the nearest lines (matching the anchor's first line) when there
   are none.
2. **apply**: in order, through `ctx.fs.editText` with the version guard from
   the intent slot (compare-and-swap in the backend) and an `fs/observed` after
   each, so a following single `edit` needs no re-read.
3. **verify**: if given and the apply succeeded, `command` runs through
   `ctx.shell` (the same executor and sandbox policy as `bash`; `workdir`
   default the workspace; `timeout_ms` default 120 s) and the result carries
   `exitCode`, the **last `max_lines` (default 40) lines** of stdout+stderr and
   how many were dropped. **A failing check is reported, not a tool error**:
   the edits are already applied. Not run in `dry_run` or after a validation
   failure.

**Unread and changed files.** A file the session has not read
(`FS_NOT_OBSERVED`), or whose version moved since it was read (a write from
bash), is *read by the tool*: when every anchor in it matches exactly once,
the edit goes through and the result says so (`file was not read this
session; applied because every anchor matched uniquely`); otherwise the batch
is refused with the regions above **and the observation is recorded**, so the
corrected retry is authorised without a separate read. The guard exists to
stop blind overwrites; a unique literal anchor is not blind.

A failure during apply (a concurrent writer racing the validation) reports
which edits were applied and which were not. `dry_run` stops after
validation. The result lists, per file, the op and line of each edit. In the
chat, a `replace` edit shows as a diff card (call and result), like `edit`;
the call card notes `+ verify`.

Sandbox denials render as the shared `[sandbox: file access denied under <mode>
mode]` marker. The tool takes **no** `sandbox_permissions`; for a one-off
escalation the built-in `edit` / `write` remain.

### `search`

```
search {
  text?: string | string[]
  word?: string | string[]
  regex?: string | string[]
  exclude_text?: string | string[]
  exclude_word?: string | string[]
  exclude_regex?: string | string[]
  ignore_case?: boolean
  paths?: string[]
  include_glob?: string | string[]
  exclude_glob?: string | string[]
  mode?: 'lines' | 'files' | 'count'
  context?: 0..20
  no_ignore?: boolean
  hidden?: boolean
  max_results?: int
}
```

At least one positive selector is required. `text` is literal, `word` is a
whole-word match, and `regex` uses ripgrep/Rust regex syntax; strings and lists
are accepted and all positive selectors combine with OR. The three exclusions
reject matching lines and therefore apply consistently in lines, files and
count modes. `exclude_regex` uses JavaScript regex syntax. `ignore_case`
applies to both positive and exclusion matching.

`paths` holds literal files or directories and never expands globs. Relative
roots resolve against the session workspace; a missing root is skipped and
named, with the directory it was resolved against. Use `include_glob` and
`exclude_glob` for path filtering: a basename glob such as `*.ts` matches at
any depth, while a glob containing `/` is anchored at each search root; use
`**/dir/**` for a directory at any depth.

Output is grouped by file and sorted by path (ripgrep's own order is
nondeterministic), with `N:` for matches, `N-` for context rows, and `--`
between non-contiguous chunks. It is capped at `max_results` matches (lines)
or files (files/count), with a note. Every model value rides in
`--flag=value` form or behind `--`, so no value can become a flag.

The argument names of grep-style tools (`pattern`, `patterns`, `literal`,
`case_insensitive`, `include`, `exclude`, `exclude_pattern`) are accepted as
aliases, so a call in that vocabulary still works; they are not part of the
advertised schema.

## System-prompt hint

With `promptHint: true` (default) one short section after the built-in tool
guidance (`tool:deepsea-fs-tools`) steers the model to these tools instead of
`ls` / `sed -n` / python heredocs / `grep`, and to bash `workdir` instead of
`cd X &&` prefixes. It is emitted only for scopes that see `edit_many`. Set
`promptHint: false` to measure unprompted use.

## Configuration

```yaml
- insert:
    - id: deepsea-fs-tools
      name: "@deepsea/fs-tools"
      config:
        readLimit: 2000          # max lines per read_many entry (and its default)
        readTotalLimit: 4000     # default total line budget of one read_many call
        readMaxLineLength: 2000  # characters kept per line
        listMaxEntries: 300      # default row cap of list_dir
        searchMaxResults: 250    # default cap of search
        searchTimeoutMs: 30000   # cooperative budget of one search
        promptHint: true
```

## Development

```sh
pnpm install && pnpm test
```

`pnpm install` needs the repository's `harness` link (`dsd link`), since
every dependency is a link into the harness build: `@deepseek-ai/dsh-tools`
(`defineTool`), `@deepseek-ai/dsh-llm` (`HarnessError`, so `code` survives
into `result.error`), `@deepseek-ai/schemastery` (`Config`) and the
`@vscode/ripgrep` binary of the harness's own grep tool.

The fake `ctx` (`tests/fake-ctx.mjs`) is a real filesystem under a temporary
root with a version counter, the `FS_SANDBOX_DENIED` / `FS_STALE_VERSION`
codes of the harness's sandbox and local filesystem, and a small observation
policy wired to `fs/edit-intent` + `fs/observed`, so the guard flow (unread →
refused; read_many → allowed; bash write → stale; re-read → allowed) is
covered without a server. `search` tests run the real packaged ripgrep.

In a server: `dsd run release --throwaway-server --scripted --plugins fs-tools`
(tools/dsd/README.md), then script tool calls with the scripted model.
