/**
 * edit_many — several edits, across several files, in ONE call, optionally
 * followed by a verification command in the same call.
 *
 * Edit kinds (`op`, default `replace`):
 *
 *   replace          old_string → new_string (exactly once, or replace_all) — as `edit`
 *   insert_after     new_string on its own line(s) right after the line that ends the unique `marker`
 *   insert_before    new_string on its own line(s) right before the line that starts the unique `marker`
 *   replace_between  the text between unique `start` and `end` markers (end omitted = to end of file)
 *                    becomes new_string; `inclusive: true` replaces the markers too; "" deletes
 *   append           new_string at the end of the file
 *
 * Structural ops are translated into marker-anchored literal replacements, so
 * they inherit `edit`'s uniqueness rule and compare-and-swap; only `append`
 * takes the versioned whole-file write.
 *
 * Two phases, so a bad edit never leaves a half-applied batch:
 *
 *   validate  every target resolved; the read-before-edit guard (`fs/edit-intent`)
 *             consulted AND the current version compared with the observed one;
 *             every anchor found exactly once in the file AS IT WILL BE after the
 *             earlier edits of the same call. A file the session has not read (or
 *             that changed since) is read by the tool: when every anchor in it is
 *             unique the edit goes through anyway (the result says so); otherwise
 *             the matching / candidate regions are returned with line numbers and
 *             the observation is recorded, so the plain retry is authorised.
 *             All problems are collected and reported together, nothing written.
 *   apply     edits run in order through ctx.fs with the version guard (CAS in the
 *             backend) and emit `fs/observed` after each; then `verify` runs.
 *
 * This is the tool-shaped replacement for `python3 - <<'EOF' … s.replace(old,new) … EOF; pnpm typecheck`.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { FsToolsError, callContext, displayPath, dropUndefined, lineOf, mapFsError, plural, positiveInt, requireFs, resolvePath, splitLines } from './common.mjs'

export const MAX_EDITS = 60
export const OPS = ['replace', 'insert_after', 'insert_before', 'replace_between', 'append']
const VERIFY_DEFAULT_LINES = 40
const VERIFY_MAX_LINES = 400
const VERIFY_DEFAULT_TIMEOUT_MS = 120_000
const VERIFY_MAX_TIMEOUT_MS = 600_000

/** @param {any} args */
export function parseEditManyArgs(args) {
  const raw = args.edits
  if (!Array.isArray(raw) || raw.length === 0) throw new FsToolsError('edits must be a non-empty array of { file_path, op?, old_string, new_string, … }')
  if (raw.length > MAX_EDITS) throw new FsToolsError(`edits may hold at most ${MAX_EDITS} entries per call`)
  const str = (e, i, key, { required = true, nonEmpty = true } = {}) => {
    const v = e[key]
    if (v === undefined || v === null) { if (required) throw new FsToolsError(`edits[${i}].${key} is required for op "${e.op ?? 'replace'}"`); return undefined }
    if (typeof v !== 'string') throw new FsToolsError(`edits[${i}].${key} must be a string`)
    if (nonEmpty && v.length === 0) throw new FsToolsError(`edits[${i}].${key} must not be empty`)
    return v
  }
  const edits = raw.map((e, i) => {
    if (!e || typeof e !== 'object') throw new FsToolsError(`edits[${i}] must be an object`)
    if (typeof e.file_path !== 'string' || e.file_path.trim().length === 0) throw new FsToolsError(`edits[${i}].file_path must be a non-empty string`)
    const op = e.op === undefined || e.op === null ? 'replace' : e.op
    if (!OPS.includes(op)) throw new FsToolsError(`edits[${i}].op must be one of ${OPS.join(', ')}`)
    const base = { index: i, filePath: e.file_path, op }
    switch (op) {
      case 'replace': {
        const oldString = str(e, i, 'old_string')
        const newString = str(e, i, 'new_string', { nonEmpty: false })
        if (oldString === newString) throw new FsToolsError(`edits[${i}]: old_string and new_string must differ`)
        return { ...base, oldString, newString, replaceAll: e.replace_all === true }
      }
      case 'insert_after':
      case 'insert_before':
        return { ...base, marker: str(e, i, 'marker'), newString: str(e, i, 'new_string') }
      case 'replace_between':
        return { ...base, start: str(e, i, 'start'), end: str(e, i, 'end', { required: false }), newString: str(e, i, 'new_string', { nonEmpty: false }), inclusive: e.inclusive === true }
      case 'append':
        return { ...base, newString: str(e, i, 'new_string') }
      default: throw new FsToolsError(`edits[${i}].op "${op}" is not supported`)
    }
  })
  return { edits, dryRun: args.dry_run === true, verify: parseVerify(args.verify) }
}

/** `verify: "cmd"` or `{ command, workdir?, timeout_ms?, max_lines? }` → normalised, or undefined. */
export function parseVerify(v) {
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v === 'string') return { command: v, maxLines: VERIFY_DEFAULT_LINES, timeoutMs: VERIFY_DEFAULT_TIMEOUT_MS }
  if (typeof v !== 'object') throw new FsToolsError('verify must be a command string or { command, workdir?, timeout_ms?, max_lines? }')
  if (typeof v.command !== 'string' || v.command.trim() === '') throw new FsToolsError('verify.command must be a non-empty string')
  if (v.workdir !== undefined && typeof v.workdir !== 'string') throw new FsToolsError('verify.workdir must be a string')
  return {
    command: v.command,
    workdir: v.workdir,
    maxLines: positiveInt(v.max_lines, 'verify.max_lines', VERIFY_DEFAULT_LINES, VERIFY_MAX_LINES),
    timeoutMs: positiveInt(v.timeout_ms, 'verify.timeout_ms', VERIFY_DEFAULT_TIMEOUT_MS, VERIFY_MAX_TIMEOUT_MS),
  }
}

/** Count non-overlapping occurrences of `needle` in `text` (after LF normalisation, as the backend matches). */
export function countOccurrences(text, needle) {
  let count = 0
  let from = 0
  for (;;) {
    const at = text.indexOf(needle, from)
    if (at === -1) return count
    count++
    from = at + needle.length
  }
}

function normalize(text) {
  return text.replace(/\r\n/g, '\n')
}

/** Short one-line preview of a literal for diagnostics. */
function preview(s, n = 60) {
  const one = s.replace(/\n/g, '\\n')
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

/** All start offsets of `needle` in `text` (non-overlapping, capped). */
function occurrences(text, needle, cap = 5) {
  const out = []
  let from = 0
  while (out.length < cap) {
    const at = text.indexOf(needle, from)
    if (at === -1) break
    out.push(at)
    from = at + needle.length
  }
  return out
}

/**
 * The regions of `text` that explain a failed anchor: every occurrence (when
 * there are several) or the lines resembling the anchor's first line (when
 * there is none), rendered `N: text` with a little context.
 * @param {string} text
 * @param {string} needle
 * @param {{ maxChars?: number }} [opts]
 */
export function regionsFor(text, needle, opts = {}) {
  const maxChars = opts.maxChars ?? 1200
  const lines = splitLines(text)
  const width = String(lines.length).length
  const window = (from, to) => {
    const rows = []
    for (let n = Math.max(1, from); n <= Math.min(lines.length, to); n++) rows.push(`${String(n).padStart(width)}: ${lines[n - 1]}`)
    return rows.join('\n')
  }
  const hits = occurrences(text, needle)
  const needleLines = needle.split('\n').length
  let blocks
  let head
  if (hits.length > 0) {
    head = `${hits.length}${hits.length >= 5 ? '+' : ''} matches:`
    blocks = [...new Set(hits.map(at => { const l = lineOf(text, at); return window(l - 1, l + needleLines) }))]
  } else {
    const first = needle.split('\n').map(s => s.trim()).find(s => s !== '') ?? ''
    const cand = []
    for (let n = 1; n <= lines.length && cand.length < 3; n++) if (first !== '' && lines[n - 1].includes(first)) cand.push(n)
    if (cand.length === 0) {
      // fall back on the longest token of the first line
      const token = first.split(/\s+/).sort((a, b) => b.length - a.length)[0] ?? ''
      for (let n = 1; n <= lines.length && cand.length < 3 && token.length >= 3; n++) if (lines[n - 1].includes(token)) cand.push(n)
    }
    if (cand.length === 0) return `no line resembles the first line of the anchor (${preview(first)}); the file has ${plural(lines.length, 'line')}`
    head = `nearest lines (the file is ${plural(lines.length, 'line')}):`
    blocks = cand.map(l => window(l - 2, l + Math.max(2, needleLines)))
  }
  let out = `${head}\n${blocks.join('\n  …\n')}`
  if (out.length > maxChars) out = `${out.slice(0, maxChars - 1)}…`
  return out
}

/**
 * Translate one op against `text` (the file as it will be) into a literal
 * `{ oldString, newString, replaceAll }` (or `{ whole }` for append), or a
 * problem string. Anchors must be unique.
 * @param {any} edit
 * @param {string} text
 * @param {string} path
 */
export function planEdit(edit, text, path) {
  const tag = `#${edit.index + 1} ${path}`
  const unique = (needle, what) => {
    const count = countOccurrences(text, needle)
    if (count === 0) return { problem: `${tag}: ${what} not found (${preview(needle)})\n    ${regionsFor(text, needle).replace(/\n/g, '\n    ')}` }
    if (count > 1) return { problem: `${tag}: ${what} appears ${count} times — make it more specific (${preview(needle)})\n    ${regionsFor(text, needle).replace(/\n/g, '\n    ')}` }
    return { at: text.indexOf(needle) }
  }
  const lineEnd = (i) => { const nl = text.indexOf('\n', i); return nl === -1 ? text.length : nl }
  const lineStart = (i) => text.lastIndexOf('\n', i - 1) + 1
  const stripOneTrailingNl = (s) => s.endsWith('\n') ? s.slice(0, -1) : s
  switch (edit.op) {
    case 'replace': {
      const old = normalize(edit.oldString)
      const count = countOccurrences(text, old)
      if (count === 0) return { problem: `${tag}: old_string not found (${preview(old)})\n    ${regionsFor(text, old).replace(/\n/g, '\n    ')}` }
      if (count > 1 && !edit.replaceAll) return { problem: `${tag}: old_string appears ${count} times — make it more specific or set replace_all: true (${preview(old)})\n    ${regionsFor(text, old).replace(/\n/g, '\n    ')}` }
      return { oldString: old, newString: normalize(edit.newString), replaceAll: edit.replaceAll, count, at: text.indexOf(old) }
    }
    case 'insert_after': {
      const marker = normalize(edit.marker)
      const u = unique(marker, 'marker')
      if (u.problem) return u
      const end = lineEnd(u.at + marker.length)
      const old = text.slice(u.at, end)
      return { oldString: old, newString: `${old}\n${stripOneTrailingNl(normalize(edit.newString))}`, replaceAll: false, count: 1, at: u.at }
    }
    case 'insert_before': {
      const marker = normalize(edit.marker)
      const u = unique(marker, 'marker')
      if (u.problem) return u
      const start = lineStart(u.at)
      const old = text.slice(start, u.at + marker.length)
      return { oldString: old, newString: `${stripOneTrailingNl(normalize(edit.newString))}\n${old}`, replaceAll: false, count: 1, at: start }
    }
    case 'replace_between': {
      const start = normalize(edit.start)
      const u = unique(start, 'start marker')
      if (u.problem) return u
      const afterStart = u.at + start.length
      let endAt = text.length
      let endLen = 0
      if (edit.end !== undefined) {
        const end = normalize(edit.end)
        const rest = text.slice(afterStart)
        const count = countOccurrences(rest, end)
        if (count === 0) return { problem: `${tag}: end marker not found after the start marker (${preview(end)})\n    ${regionsFor(text, end).replace(/\n/g, '\n    ')}` }
        if (count > 1) return { problem: `${tag}: end marker appears ${count} times after the start marker — make it more specific (${preview(end)})\n    ${regionsFor(rest, end).replace(/\n/g, '\n    ')}` }
        endAt = afterStart + rest.indexOf(end)
        endLen = end.length
      }
      const replacement = normalize(edit.newString)
      const old = text.slice(u.at, endAt + endLen)
      const kept = edit.inclusive ? replacement : `${start}${replacement}${edit.end !== undefined ? text.slice(endAt, endAt + endLen) : ''}`
      if (old === kept) return { problem: `${tag}: replace_between changes nothing` }
      return { oldString: old, newString: kept, replaceAll: false, count: 1, at: u.at }
    }
    case 'append': {
      const add = normalize(edit.newString)
      const sep = text === '' || text.endsWith('\n') ? '' : '\n'
      return { whole: `${text}${sep}${add}${add.endsWith('\n') ? '' : '\n'}`, count: 1, at: text.length }
    }
    default: return { problem: `${tag}: unsupported op ${edit.op}` }
  }
}

/**
 * Validate a batch against current file contents without writing.
 * @param {any} fs
 * @param {any} ctx
 * @param {any} exec
 * @param {ReturnType<typeof parseEditManyArgs>['edits']} edits
 * @param {{ cwd: string, policy: any, signal?: AbortSignal }} call
 * @returns {Promise<{ resolved: any[], problems: string[], files: Map<string, any> }>}
 */
export async function validateEdits(fs, ctx, exec, edits, call) {
  /** @type {Map<string, { target: any, path: string, text: string | null, version: any, guard: 'observed' | 'unread' | 'stale', guardError?: string, edits: number, unanchored: boolean }>} */
  const files = new Map()
  const resolved = []
  const problems = []
  for (const edit of edits) {
    let target
    try {
      target = await resolvePath(fs, edit.filePath, call)
    } catch (error) {
      problems.push(`#${edit.index + 1} ${edit.filePath}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    const key = target.targetKey ?? displayPath(target, edit.filePath)
    const path = displayPath(target, edit.filePath)
    let file = files.get(key)
    if (file === undefined) {
      file = { target, path, text: null, version: null, guard: 'observed', edits: 0, unanchored: false }
      files.set(key, file)
      // The read-guard decision. FS_NOT_OBSERVED (never read) and a version drift
      // (changed since read) are not fatal here: the tool reads the file itself and
      // lets unique anchors through, else shows the regions (see the header).
      let intent
      try {
        intent = await ctx.waterfall('fs/edit-intent', target, exec, () => undefined)
      } catch (error) {
        const code = error && typeof error === 'object' ? /** @type {any} */ (error).code : undefined
        if (code === 'FS_NOT_OBSERVED') file.guard = 'unread'
        else file.guardError = mapFsError(error, path, call.policy).message
      }
      if (file.guardError === undefined) {
        try {
          const info = await fs.stat(target, call.signal)
          if (info === undefined) file.guardError = `"${path}": not found`
          else if (info.type !== 'file') file.guardError = `"${path}": not a regular file (${info.type})`
          else {
            file.version = info.version
            if (file.guard === 'observed' && intent && intent.version !== undefined && intent.version !== info.version) file.guard = 'stale'
            file.text = normalize(await fs.readText(target, call.signal))
          }
        } catch (error) {
          file.guardError = mapFsError(error, path, call.policy).message
        }
      }
    }
    if (file.guardError !== undefined) {
      problems.push(`#${edit.index + 1} ${file.guardError}`)
      continue
    }
    file.edits += 1
    const text = /** @type {string} */ (file.text)
    const plan = planEdit(edit, text, path)
    if (plan.problem) {
      const note = file.guard === 'unread' ? ' [file not read this session]' : file.guard === 'stale' ? ' [file changed since it was read]' : ''
      problems.push(note ? plan.problem.replace('\n', `${note}\n`) : plan.problem)
      file.unanchored = true
      continue
    }
    const line = lineOf(text, plan.at)
    // Simulate, so later edits of this call see the file as it will be.
    if (plan.whole !== undefined) file.text = plan.whole
    else file.text = plan.replaceAll ? text.split(plan.oldString).join(plan.newString) : text.replace(plan.oldString, () => plan.newString)
    resolved.push({ edit, target, path, line, count: plan.count, plan, file })
  }
  return { resolved, problems, files }
}

/**
 * @param {{ dryRun: boolean, applied: Array<{ path: string, op: string, line: number, count: number, replaceAll: boolean, guard?: string }>, files: number, verify?: any }} value
 */
export function renderEditMany(value) {
  const byFile = new Map()
  for (const a of value.applied) {
    const list = byFile.get(a.path) ?? []
    list.push(a)
    byFile.set(a.path, list)
  }
  const verb = value.dryRun ? 'would apply' : 'applied'
  const lines = [`${value.dryRun ? 'Dry run: ' : ''}${verb} ${plural(value.applied.length, 'edit')} in ${plural(byFile.size, 'file')}.`]
  for (const [path, list] of byFile) {
    const detail = list.map(a => `${a.op !== 'replace' ? `${a.op} ` : ''}${a.replaceAll ? `${a.count}× from line ${a.line}` : `line ${a.line}`}`).join(', ')
    const guard = list[0].guard === 'unread' ? ' — file was not read this session; applied because every anchor matched uniquely'
      : list[0].guard === 'stale' ? ' — file had changed since it was read; applied because every anchor matched uniquely in the current content' : ''
    lines.push(`  ${path}: ${plural(list.length, 'edit')} (${detail})${guard}`)
  }
  if (value.verify) {
    const v = value.verify
    if (v.skipped) lines.push(`verify skipped (${v.skipped}).`)
    else {
      const status = v.timedOut ? `timed out after ${Math.round(v.timeoutMs / 1000)}s` : v.aborted ? 'cancelled' : v.exitCode === 0 ? 'exit 0' : `exit ${v.exitCode ?? `signal ${v.signal ?? '?'}`}`
      const shown = v.truncatedLines ? `last ${v.outputLines - v.truncatedLines} of ${v.outputLines} lines` : plural(v.outputLines, 'line')
      lines.push(`verify \`${v.command}\` → ${status} (${shown}${v.outputTruncated ? ', output capped by the executor' : ''}):`)
      if (v.output !== '') lines.push(v.output)
    }
  }
  return lines.join('\n')
}

/**
 * Run the verification command through ctx.shell under the caller's sandbox.
 * @param {any} ctx
 * @param {any} exec
 * @param {{ command: string, workdir?: string, maxLines: number, timeoutMs: number }} verify
 * @param {{ cwd: string, policy: any, signal?: AbortSignal }} call
 */
export async function runVerify(ctx, exec, verify, call) {
  const shell = ctx.get('shell')
  if (shell === undefined) return { command: verify.command, skipped: 'no shell service (ctx.shell) in this composition' }
  const workdir = verify.workdir === undefined ? call.cwd : (verify.workdir.startsWith('/') ? verify.workdir : `${call.cwd}/${verify.workdir}`)
  const shellEnv = ctx.get('shellEnv')
  const request = {
    command: verify.command,
    workdir,
    timeoutMs: verify.timeoutMs,
    signal: call.signal,
    ...shellEnv ? { dshEnv: shellEnv.collect(exec) } : {},
    ...call.policy !== undefined ? { sandboxPolicy: call.policy } : {},
  }
  // The executor resolves defaults and caps, then spawns; `result()` settles when the process closes.
  const execution = await shell.execute(shell.resolve(request))
  const result = await execution.result()
  const combined = [result.stdout?.text ?? '', result.stderr?.text ?? ''].map(s => s.replace(/\n$/, '')).filter(s => s !== '').join('\n')
  const all = splitLines(combined)
  const kept = all.slice(Math.max(0, all.length - verify.maxLines))
  return dropUndefined({
    command: verify.command,
    workdir,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut === true,
    aborted: result.aborted === true || undefined,
    timeoutMs: result.timeoutMs ?? verify.timeoutMs,
    output: kept.join('\n'),
    outputLines: all.length,
    truncatedLines: all.length - kept.length,
    outputTruncated: result.stdout?.truncated === true || result.stderr?.truncated === true,
  })
}

/**
 * @param {any} ctx
 */
export function createEditManyTool(ctx) {
  return defineTool({
    name: 'edit_many',
    description: 'Apply several edits — in one file or across many — in ONE call, then optionally run a check command in the same call. '
      + 'Each entry is { file_path, op?, … }: op "replace" (default) { old_string, new_string, replace_all? } with the same rules as `edit`; '
      + '"insert_after" / "insert_before" { marker, new_string } put new lines right after/before the line holding the unique marker; '
      + '"replace_between" { start, end?, new_string, inclusive? } replaces the text between two unique markers (end omitted = to end of file; "" deletes; inclusive also replaces the markers); '
      + '"append" { new_string } adds to the end of the file. '
      + 'ALL entries are validated first and reported together; nothing is written if any fails; a later entry may match text produced by an earlier one. '
      + 'A file you have not read (or that changed since) is read by the tool: when every anchor in it matches exactly once the edit goes through anyway; '
      + 'otherwise the matching / nearest regions come back with line numbers and a plain retry is then allowed. '
      + 'Set replace_all: true to change every occurrence. verify: { command } (e.g. "pnpm -s typecheck") runs after a successful apply and returns its exit code and output tail, '
      + 'so edit + check is one round-trip instead of edit_many followed by bash. Use this instead of python/sed heredocs in bash.',
    parameters: {
      edits: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            file_path: { type: 'string', required: true, description: 'Path to edit (relative to the session workspace, absolute, or ~).' },
            op: { type: 'string', enum: OPS, description: 'Edit kind (default replace).' },
            old_string: { type: 'string', description: 'replace: literal text to replace. Must match exactly.' },
            new_string: { type: 'string', description: 'The new text (replace/replace_between: replacement, "" deletes; insert_*: the lines to insert; append: the lines to add).' },
            replace_all: { type: 'boolean', description: 'replace: change every occurrence (default false: exactly one required).' },
            marker: { type: 'string', description: 'insert_after / insert_before: unique literal text; the insert lands after/before the line containing it.' },
            start: { type: 'string', description: 'replace_between: unique literal text where the region starts.' },
            end: { type: 'string', description: 'replace_between: literal text where the region ends (unique after start); omit for end of file.' },
            inclusive: { type: 'boolean', description: 'replace_between: also replace the markers themselves (default false: markers stay).' },
          },
        },
        description: `The edits, in application order (max ${MAX_EDITS}).`,
      },
      verify: {
        type: 'object',
        additionalProperties: false,
        properties: {
          command: { type: 'string', required: true, description: 'Shell command to run after a successful apply (through the same shell and sandbox as bash).' },
          workdir: { type: 'string', description: 'Working directory (default: the session workspace).' },
          timeout_ms: { type: 'integer', description: `Timeout (default ${VERIFY_DEFAULT_TIMEOUT_MS / 1000}s, max ${VERIFY_MAX_TIMEOUT_MS / 1000}s).` },
          max_lines: { type: 'integer', description: `Keep the last N lines of stdout+stderr (default ${VERIFY_DEFAULT_LINES}, max ${VERIFY_MAX_LINES}).` },
        },
        description: 'Run this after the edits are written; the result reports exit code and output tail (a failing check is reported, not a tool error). Not run after a validation failure or in dry_run.',
      },
      dry_run: { type: 'boolean', description: 'Validate only; report what would change without writing.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: renderEditMany(value) }],
      presentationMeta: (args, value) => ({
        diffs: value.dryRun ? [] : (Array.isArray(args.edits) ? args.edits : []).filter(e => e && (e.op === undefined || e.op === 'replace')).map(e => ({ path: String(e?.file_path ?? ''), oldText: String(e?.old_string ?? ''), newText: String(e?.new_string ?? '') })),
      }),
    },
    async execute(args, exec) {
      const input = parseEditManyArgs(args)
      const fs = requireFs(ctx)
      const call = callContext(ctx, exec)
      const { resolved, problems, files } = await validateEdits(fs, ctx, exec, input.edits, call)
      // The tool read every unread / changed file above: record that, so a retry after
      // the model has seen the regions below is authorised by the guard.
      for (const f of files.values()) {
        if ((f.guard === 'unread' || f.guard === 'stale') && f.version !== null) ctx.emit('fs/observed', f.target, { kind: 'present', version: f.version }, exec)
      }
      if (problems.length > 0) {
        throw new FsToolsError(`edit_many: ${plural(problems.length, 'problem')}, nothing written:\n${problems.map(p => `  ${p}`).join('\n')}`, 'EDIT_MANY_INVALID')
      }
      const applied = []
      const entry = (r, line) => ({ path: r.path, op: r.edit.op, line, count: r.count, replaceAll: r.plan.replaceAll === true, guard: r.file.guard === 'observed' ? undefined : r.file.guard })
      if (input.dryRun) {
        for (const r of resolved) applied.push(entry(r, r.line))
        return dropUndefined({ dryRun: true, applied, files: new Set(applied.map(a => a.path)).size, ...input.verify ? { verify: { command: input.verify.command, skipped: 'dry_run' } } : {} })
      }
      for (const r of resolved) {
        try {
          const intent = await ctx.waterfall('fs/edit-intent', r.target, exec, () => undefined)
          let outcome
          if (r.plan.whole !== undefined) {
            outcome = await fs.writeText(r.target, r.plan.whole, intent?.version !== undefined ? { kind: 'replaceIfVersion', version: intent.version } : undefined, call.signal, call.policy)
          } else {
            outcome = await fs.editText(r.target, { oldString: r.plan.oldString, newString: r.plan.newString, replaceAll: r.plan.replaceAll }, intent, call.signal, call.policy)
          }
          ctx.emit('fs/observed', r.target, { kind: 'present', version: outcome.version }, exec)
          const before = normalize(outcome.before ?? '')
          const at = r.plan.oldString !== undefined && before ? before.indexOf(r.plan.oldString) : -1
          applied.push(entry(r, at >= 0 ? lineOf(before, at) : r.line))
        } catch (error) {
          const mapped = mapFsError(error, r.path, call.policy)
          const done = applied.length > 0 ? `Applied before the failure: ${applied.map((a, i) => `#${resolved[i].edit.index + 1} ${a.path}:${a.line}`).join(', ')}. ` : 'Nothing was applied. '
          const left = resolved.slice(applied.length + 1).map(x => `#${x.edit.index + 1}`)
          throw new FsToolsError(
            `edit_many stopped at edit #${r.edit.index + 1}: ${mapped.message}\n${done}${left.length ? `Not applied: ${left.join(', ')}.` : ''}`,
            mapped.code,
            { cause: error },
          )
        }
      }
      const value = { dryRun: false, applied, files: new Set(applied.map(a => a.path)).size }
      if (input.verify) {
        try {
          value.verify = await runVerify(ctx, exec, input.verify, call)
        } catch (error) {
          value.verify = { command: input.verify.command, skipped: `could not run: ${error instanceof Error ? error.message : String(error)}` }
        }
      }
      return dropUndefined(value)
    },
    presentCall: (args) => {
      const edits = Array.isArray(args.edits) ? args.edits : []
      const paths = [...new Set(edits.map(e => e?.file_path).filter(Boolean))]
      return {
        card: 'diff',
        title: `Edit ${paths.length === 1 ? paths[0] : plural(paths.length, 'file')} (${plural(edits.length, 'edit')})${args.verify ? ' + verify' : ''}`,
        diffs: edits.map(e => ({ path: String(e?.file_path ?? ''), oldText: String(e?.old_string ?? e?.marker ?? e?.start ?? '') || null, newText: String(e?.new_string ?? '') })),
        locations: paths.map(path => ({ path })),
      }
    },
    presentResult: (args, result) => {
      if (result.isError) return undefined
      const meta = result.meta
      const diffs = meta && Array.isArray(meta.diffs) ? meta.diffs : undefined
      if (!diffs || diffs.length === 0) return undefined
      const paths = [...new Set(diffs.map(d => d.path))]
      return { card: 'diff', title: `Edit ${paths.length === 1 ? paths[0] : plural(paths.length, 'file')} (${plural(diffs.length, 'edit')})`, diffs }
    },
  })
}
