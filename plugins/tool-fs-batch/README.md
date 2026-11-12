# @deepsea/tool-fs-batch

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
the harness's packaged `@vscode/ripgrep` through `ctx.subprocess`.

Relative paths (and `search`'s default root, `edit_many`'s default `verify`
directory) resolve against the session's **current working directory**, the
one `working_directory` `cd` changes, taken from the harness's
`workingDirectory` service exactly as the built-in `read` / `edit` / `grep` /
`bash` take it; without that service, the sandbox policy's workspace root,
else the session's original directory. A path whose display spelling keeps
`.` / `..` segments is shown as the canonical path the backend resolved it to.

## Presets

A session plugin: it joins every agent preset that has upstream's
`@deepseek-ai/dsh-tool-fs-search` (`"deepsea": { "presets": { "joinWith":
[…] } }`; plugins/AGENTS.md → Presets), right after that row, and its
global row is disabled, so Settings → Built-in plugins lists it under
Session plugins (tools/dsd/README.md → Generated presets). In rc.1 that is
`standard`, `ptc` and `cordis`; not `minimal`, whose `tool-fs` is read-only
and which has no search (edit_many would give it the writes upstream left
out), and not `minimal-no-tools`. A subagent gets the tools when its preset
has them. Everything it registers is per agent, so it works from a preset's
context as from the Host's.

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
observed absent and reported inline (a dangling symbolic link says so); a
directory, an offset past the end of the file and an invalid entry (`offset:
0`, `limit: 0`, a limit over the cap) are reported inline too; the rest of the
call still returns. A file with CRLF (or mixed) line endings says so in its
header, since the rows are shown without `\r`.

`limit` defaults to the whole file up to the per-entry cap (`readLimit`,
2000). `max_lines` is a total budget across entries; its default **and
maximum** is `readTotalLimit` (4000), and the schema says so. An entry cut by
the cap or by the budget says why and where to continue (`lines 1-2000 of
3000; 2000-line entry cap; continue with offset 2001`); entries the budget
left unread are named in a closing line (`max_lines 12 reached; not read:
b.ts, c.ts (from line 40)`).

### `edit_many`

```
edit_many {
  edits: ({ file_path, op?: 'replace', old_string, new_string, replace_all? }
        | { file_path, op: 'insert_after' | 'insert_before', marker, new_string }
        | { file_path, op: 'replace_between', start, end?, new_string, inclusive? }
        | { file_path, op: 'append', new_string }
        | { file_path, op: 'create', new_string })[],
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
| `insert_after` / `insert_before` | `marker` (unique; several occurrences on the same line count as one) | `new_string` as its own line(s) right after / before the **line** holding the marker; one trailing newline of `new_string` is dropped (`"x\n\n"` adds `x` and a blank line) |
| `replace_between` | `start` (unique), `end` (unique after start, on a later line; omit = end of file) | **whole lines**: the lines between the line holding `start` and the line holding `end` become `new_string` as whole line(s) (a final newline is added if missing); the marker lines stay unless `inclusive: true`, which replaces them too; `""` deletes the lines; `start` + no `end` + `""` truncates the file after the marker's line |
| `append` | none | `new_string` at the end of an **existing** file (a newline is added before it if missing, and after it); a missing file is "not found", pointing to `create` |
| `create` | none (the path must not exist) | a **new** file holding `new_string`, parent directories created; a final newline is added if missing, `""` makes an empty file |

`replace_between` is line-based like `insert_*`: a marker means the line it is
on, whatever part of the line it is, and a newline the caller puts at a
marker's edge (`start: "# BEGIN\n"`, `end: "\n# END"`) does not move it to the
neighbouring line. So the common case, markers on their own lines, needs no
`\n` anywhere. Both markers on one line is a problem ("use replace for text
within a line"): character splices are what `replace` is for.

The file's line endings are kept: the backend's `editText` restores CRLF, and
`append`'s whole-file write converts to CRLF when the file is CRLF (majority
in the first 4 KiB, as the local backend detects it). A created file takes
the line endings of its `new_string`, detected the same way (`"a\r\nb"` makes
a CRLF file, final newline `\r\n`; mixed text goes to the majority), and later
entries keep them like any file's.

#### `create`

`create` is the only op that makes a file, and it never replaces one:

- **The path must not exist** in any form: a file, a directory, a symbolic
  link (even one to a missing target, checked with `lstat`) or anything else
  is a validation problem (`already exists (a file); create never overwrites
  — edit it with the other ops, or replace it with write`), reported with the
  call's other problems. So is a path whose nearest existing ancestor is not a
  directory, and a second `create` of the same path (any spelling that
  resolves to the same target) in one call. Missing parent directories are
  created by the write (the backend's `mkdir -p`, with the umask's mode).
- **All or nothing**: it is validated with the rest of the call, so a problem
  anywhere means no file and no directory is made. `dry_run` shows the new
  file's lines; `verify` runs after it is written, like any edit.
- **Later entries may edit the file it creates**, anchored in the created text
  (a new module plus the edits that import it, in one call); an entry naming
  the path *before* its `create` is "not found" and says to put the create
  first. After a `create` that failed validation, later entries of that path
  are reported as not checked rather than validated against whatever is
  there.
- **The read guard**: a create needs no read. It is written with the
  backend's `createIfAbsent` intent (the one the built-in `write` gets for a
  file the session never saw), so even a file that appears between
  validation and apply is not overwritten (`already exists (it appeared after
  validation); nothing overwritten`, code `FS_ALREADY_EXISTS`). The created
  file is then observed (`fs/observed`) at its new version, so the later
  entries of the call and later `edit` / `edit_many` calls edit it without a
  read. A `create` refused because the file exists does **not** read it and
  records no observation: the model has not seen its content, so a following
  `write` still needs a read.
- **The sandbox** refuses it like every write (see *Sandbox* below): a
  refused `create` is a validation problem, so no file and no parent
  directory is made, and nothing else in the call is written.
- **File mode**: the local backend publishes a new file owner-only (`0600`,
  its private staging file's mode; the built-in `write` leaves it so). A file
  `create` makes gets the mode a new file gets from the umask instead
  (`0644` with umask `022`), as an editor or `>` in bash would. This is done
  only when the backend's files are the host's (`processPathFromHostPath`
  maps the path to itself), by opening the new file without following a
  symbolic link; if it fails the file stays as created and the result says so
  in a `warning:` line.

Structural ops are translated into marker-anchored literal replacements, so
they inherit the uniqueness rule and the compare-and-swap; `append` takes the
versioned whole-file write and `create` the `createIfAbsent` one. Three phases:

1. **validate**: every target resolved; the read guard (`fs/edit-intent`)
   consulted **and** the current version compared with the observed one;
   every anchor found and unique **in the file as it will be after the
   earlier edits of the same call** (so edit #2 may match text produced by
   edit #1). All problems, argument errors of single entries (`old_string`
   equal to `new_string`, an empty `marker`, a bad `verify`) included, are
   collected and returned together in entry order, numbered `#k` from 1;
   **nothing is written if any fails.** (Type and enum errors of the schema
   itself, such as an unknown `op`, are rejected by the tool registry before
   the tool runs, in its own `edits[i]` wording.) A failed anchor comes back
   with its **regions**: every occurrence (up to 5) with a line of context,
   overlapping windows merged and the matched lines marked `>`, when there
   are several; when there are none, the nearest lines (marked `>`) and what
   differs: indentation/whitespace, letter case, or which line of a
   multi-line anchor diverges. A problem in a file that earlier entries of
   the call already changed says `[as edited by #1, #2]`: its anchors and
   line numbers refer to the file as those entries leave it. Every target
   is also checked against the sandbox (below); a refused path is one more
   problem.

   A `replace_between` whose lines hold text an earlier entry of the call
   wrote (it swallows that edit) is applied with a `warning:` line naming
   both entries; a `replace` that names the earlier text in `old_string` is
   deliberate and is not flagged.
2. **apply**: in order, through `ctx.fs.editText` with the version guard from
   the intent slot (compare-and-swap in the backend) and an `fs/observed` after
   each, so a following single `edit` needs no re-read.
3. **verify**: if given and the apply succeeded, `command` runs through
   `ctx.shell` (the same executor and sandbox policy as `bash`; `workdir`
   default the session's current working directory; `timeout_ms` default
   120 s, reported as given: `timed out after 1.5s`) and the result carries
   `exitCode`, the **last `max_lines` (default 40) lines** of stdout+stderr
   (or `no output`) and how many were dropped. **A failing check is reported, not a tool error**:
   the edits are already applied. Not run in `dry_run` or after a validation
   failure.

**Unread and changed files.** A file the session has not read
(`FS_NOT_OBSERVED`), or whose version moved since it was read (a write from
bash; also a file read as missing that exists now), is *read by the tool*: when every anchor in it matches exactly once,
the edit goes through and the result says so (`file was not read this
session; applied because every anchor matched uniquely`); otherwise the batch
is refused with the regions above **and the observation is recorded**, so the
corrected retry is authorised without a separate read. The guard exists to
stop blind overwrites; a unique literal anchor is not blind.

A failure during apply (a concurrent writer racing the validation, a sandbox
that refuses at write time) stops the batch; nothing is rolled back, and the
error says so: `Already written, kept (not rolled back): #1 a.ts:3, #2 a.ts:9 —
1 file changed: a.ts. Not applied: #3, #4.` (or `Nothing was written.`). `dry_run` stops after
validation and shows, per file, the changed lines of the result (marked `>`,
one line of context, at most 30 rows). The result lists, per file, the op and
the line where each edit's new text starts (`append line 5`: the appended
text's first line; `create, 3 lines`). In the
chat, a `replace` edit shows as a diff card (call and result), like `edit`,
and a `create` as a new file, like `write`; the call card notes `+ verify`.

**Sandbox.** Every write carries the call's sandbox policy, so the backend
fences it exactly as it fences the built-in `edit` / `write`. So that a
refusal does not leave the batch half-applied, validation first asks the
backend, for every target of every op and with the same policy, what its
fence will decide, without writing: `ctx.fs.checkWrite(target, signal,
policy)`, from the harness topic `fs-check-write` (declared in package.json,
`deepsea.requires`). The backend answers with the decision its writes make,
through the same code: `dsh-fs-sandbox` (`read-only` refuses; `workspace-write`
re-resolves the target, so a symlinked ancestor counts as where it points, and
allows it under the workspace root, extra roots and temp dirs;
`danger-full-access` allows), `dsh-fs-ssh` by asking the remote helper's
fence, and a backend that never confines (`dsh-fs-local`) allows everything.
What the write would throw while deciding (an invalid extra root) is reported
with its code.

A refusal is reported once per file, at its first entry, with the call's
other problems (`#2 b.ts: [sandbox: file access denied under workspace-write
mode] outside the writable roots`; under `read-only`, `read-only mode allows
no file writes`); the file's entries are still validated, so their own
problems show too. A call whose only problems are refusals keeps the
backend's code, `FS_SANDBOX_DENIED`; otherwise `EDIT_MANY_INVALID`. The
fence at write time stays: if it still refuses (the policy changed since
validation), the batch stops there and the error names what was written
(above). The same happens when validation cannot know: a backend that
answers `unknown`, or a harness without `checkWrite`, where the plugin does
not guess the fence and leaves every decision to the write, so a refused
entry after allowed ones stops the batch part-way. The fence never asks the
person (approval exists only for an escalation the built-in tools request),
so the check prompts no one. The tool takes **no** `sandbox_permissions`;
the errors point to the built-in `edit` / `write` for a one-off escalation.

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
whole-word match as `rg -w` makes it (a non-word character or the line edge on
each side, so `foo(1)` matches `foo(1);`), and `regex` uses ripgrep/Rust regex
syntax; strings and lists are accepted and all positive selectors combine with
OR. An invalid `regex` is reported with the caller's pattern and ripgrep's
diagnostic on their own lines (each pattern is checked alone, since rg's own
message shows the patterns joined in its internal `(?:…)|(?:…)` wrapper). The three exclusions
reject matching lines and therefore apply consistently in lines, files and
count modes. `exclude_regex` uses JavaScript regex syntax. `ignore_case`
applies to both positive and exclusion matching.

`paths` holds literal files or directories and never expands globs. Relative
roots resolve against the session's current working directory; a missing root
is skipped and named, with the directory it was resolved against. Use
`include_glob` and `exclude_glob` for path filtering: a basename glob such as
`*.ts` matches at any depth, while a glob containing `/` is anchored at each
directory root; use `**/dir/**` for a directory at any depth. ripgrep matches
such globs against paths relative to its own working directory, so each
directory root is searched by its own rg run started in that directory (its
results shown under the root as given); file roots share one run, and rg
searches a file named explicitly whatever the globs say. `hidden: true` adds
hidden files and directories but never `.git` (`--glob=!.git`, last, so no
include glob re-admits it); name `.git` in `paths` to search it. When rg
reports per-file errors (an unreadable file) but found matches, the results
come back with its messages as a warning.

Output is grouped by file and sorted by path (ripgrep's own order is
nondeterministic), with `N:` for matches, `N-` for context rows, and `--`
(always two dashes) between non-contiguous chunks. It is capped at `max_results` matches (lines)
or files (files/count), with a note. Every model value rides in
`--flag=value` form or behind `--`, so no value can become a flag.

The argument names of grep-style tools (`pattern`, `patterns`, `literal`,
`case_insensitive`, `include`, `exclude`, `exclude_pattern`) are accepted as
aliases, so a call in that vocabulary still works; they are not part of the
advertised schema.

## System-prompt hint

With `promptHint: true` (default) one short section after the built-in tool
guidance (`tool:deepsea-tool-fs-batch`) steers the model to these tools instead of
`ls` / `sed -n` / python heredocs / `grep`, and to bash `workdir` instead of
`cd X &&` prefixes. It is emitted only for scopes that see `edit_many`. Set
`promptHint: false` to measure unprompted use.

## Configuration

The row in a preset, set in the Web preset editor, or in a profile or
`--patch` row for its id (`- id: deepsea-tool-fs-batch` with `config:`),
which dsd carries into the presets at its next install:

```yaml
- id: deepsea-tool-fs-batch
  name: "@deepsea/tool-fs-batch"
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
into `result.error`), `@deepseek-ai/dsh-sandbox` (the `[sandbox: …]`
marker; the tests' fake fence also takes `writableRoots` from it),
`@deepseek-ai/schemastery` (`Config`) and the
`@vscode/ripgrep` binary of the harness's own grep tool.

The fake `ctx` (`tests/fake-ctx.mjs`) is a real filesystem under a temporary
root with a version counter, the `FS_SANDBOX_DENIED` / `FS_STALE_VERSION`
codes of the harness's sandbox and local filesystem, and a small observation
policy wired to `fs/edit-intent` + `fs/observed`, so the guard flow (unread →
refused; read_many → allowed; bash write → stale; re-read → allowed) is
covered without a server; it can stand in for the harness's
`workingDirectory` service (`fakeCtx({ workingDirectory: { cwd } })`). Its
`writeText` honours `createIfAbsent` and publishes new files `0600`, as
dsh-fs-local does. Its write fence is dsh-fs-sandbox's (`writableRoots`),
and its `checkWrite` answers that fence's decision (`checkWrite: 'unknown'`
for a backend that cannot decide, `false` for a harness without the method);
`refuseAtWrite` refuses chosen paths at write time only, as a policy changed
after validation would; `outsideDir()` is a directory outside every writable
root (beside the tests, since the temp dirs are writable). Its `build` hands
each tool's `execute` a deep-frozen copy of its arguments, as the harness's
tool pipeline does, so a tool that writes into its arguments fails in the
tests as it would in a server.
`tests/create.test.mjs` covers `create`, one test per rule above;
`tests/sandbox.test.mjs` the sandbox check (a refused second of three
entries, `read-only`, a refused `create`, refusals among other problems,
`dry_run`, refusal at write time, the backends and modes left alone, the
policy `checkWrite` is asked with, an invalid extra root).
`search` tests run the real packaged ripgrep. `tests/regressions.test.mjs`
holds one test per bug found exercising the tools (CRLF append, line-based
`replace_between`, problems reported together, merged regions, overlap
warnings, anchored globs, `rg -w` words, regex diagnostics, read ranges and
budgets, the current working directory, list-valued `search` selectors under
frozen arguments).

In a server: `dsd run release --throwaway-server --scripted --plugins tool-fs-batch`
(tools/dsd/README.md), then script tool calls with the scripted model.
