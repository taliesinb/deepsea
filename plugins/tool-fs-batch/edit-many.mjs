/**
 * edit_many — several edits, across several files, in ONE call, optionally
 * followed by a verification command in the same call.
 *
 * Edit kinds (`op`, default `replace`):
 *
 *   replace          old_string → new_string (exactly once, or replace_all) — as `edit`
 *   insert_after     new_string on its own line(s) right after the line that ends the unique `marker`
 *   insert_before    new_string on its own line(s) right before the line that starts the unique `marker`
 *   replace_between  whole lines: the lines between the line holding the unique `start` marker and
 *                    the line holding `end` (end omitted = to end of file) become new_string as
 *                    whole line(s); `inclusive: true` replaces the marker lines too; "" deletes
 *   append           new_string at the end of an existing file (the file's CRLF/LF line endings kept)
 *   create           a new file holding new_string (parent directories created); refused when the
 *                    path exists (file, directory or symlink), so it never overwrites
 *
 * Structural ops are translated into marker-anchored literal replacements, so
 * they inherit `edit`'s uniqueness rule and compare-and-swap; `append` takes
 * the versioned whole-file write, `create` the backend's `createIfAbsent` write.
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
 *             the observation is recorded, so the plain retry is authorised. A `create`
 *             needs no read: its path must not exist, and later entries of the call
 *             may edit the file it creates. Every target is checked against the
 *             sandbox decision its write will meet (the backend's `checkWrite`,
 *             through `sandboxRefusal`), for every op, so a refused path is one
 *             more problem and nothing is written.
 *             All problems (argument errors included) are collected and reported
 *             together, numbered #k, nothing written. A replace_between whose lines
 *             hold text an earlier edit of the call wrote is applied with a warning.
 *   apply     edits run in order through ctx.fs with the version guard (CAS in the
 *             backend) and emit `fs/observed` after each (a created file is observed at
 *             its new version, so later edits need no read); then `verify` runs. The
 *             backend fences each write again; a refusal there (the policy changed, or
 *             a backend that cannot answer `checkWrite`) stops the batch, and
 *             the error names the entries and files already written.
 *
 * This is the tool-shaped replacement for `python3 - <<'EOF' … s.replace(old,new) … EOF; pnpm typecheck`.
 */

import { constants as fsConstants } from 'node:fs'
import { open } from 'node:fs/promises'
import { dirname } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { FsToolsError, SANDBOX_ESCALATION_HINT, callContext, detectLineEndings, dropUndefined, lineOf, mapFsError, plural, positiveInt, requireFs, resolvePath, sandboxRefusal, shownPath, splitLines } from './common.mjs'

export const MAX_EDITS = 60
export const OPS = ['replace', 'insert_after', 'insert_before', 'replace_between', 'append', 'create']
const VERIFY_DEFAULT_LINES = 40
const VERIFY_MAX_LINES = 400
const VERIFY_DEFAULT_TIMEOUT_MS = 120_000
const VERIFY_MAX_TIMEOUT_MS = 600_000

/**
 * Parse the call. Only a malformed `edits` list fails at once; a bad entry (or a
 * bad `verify`) becomes a problem numbered `#k` like the anchor problems, so
 * every problem of the call is reported together.
 * @param {any} args
 */
export function parseEditManyArgs(args) {
  const raw = args.edits
  if (!Array.isArray(raw) || raw.length === 0) throw new FsToolsError('edits must be a non-empty array of { file_path, op?, old_string, new_string, … }')
  if (raw.length > MAX_EDITS) throw new FsToolsError(`edits may hold at most ${MAX_EDITS} entries per call`)
  const problems = []
  const edits = []
  raw.forEach((e, i) => {
    const tag = `#${i + 1}${e && typeof e === 'object' && typeof e.file_path === 'string' && e.file_path.trim() !== '' ? ` ${e.file_path}` : ''}`
    const errors = []
    const str = (key, { required = true, nonEmpty = true } = {}) => {
      const v = e[key]
      if (v === undefined || v === null) { if (required) errors.push(`${key} is required for op "${e.op ?? 'replace'}"`); return undefined }
      if (typeof v !== 'string') { errors.push(`${key} must be a string`); return undefined }
      if (nonEmpty && v.length === 0) { errors.push(`${key} must not be empty`); return undefined }
      return v
    }
    if (!e || typeof e !== 'object') { problems.push(`${tag}: must be an object`); return }
    if (typeof e.file_path !== 'string' || e.file_path.trim().length === 0) errors.push('file_path must be a non-empty string')
    const op = e.op === undefined || e.op === null ? 'replace' : e.op
    if (!OPS.includes(op)) { problems.push(`${tag}: op must be one of ${OPS.join(', ')}`); return }
    const base = { index: i, filePath: e.file_path, op }
    let edit
    switch (op) {
      case 'replace': {
        const oldString = str('old_string')
        const newString = str('new_string', { nonEmpty: false })
        if (oldString !== undefined && oldString === newString) errors.push('old_string and new_string must differ')
        edit = { ...base, oldString, newString, replaceAll: e.replace_all === true }
        break
      }
      case 'insert_after':
      case 'insert_before':
        edit = { ...base, marker: str('marker'), newString: str('new_string') }
        break
      case 'replace_between':
        edit = { ...base, start: str('start'), end: str('end', { required: false }), newString: str('new_string', { nonEmpty: false }), inclusive: e.inclusive === true }
        break
      case 'append':
        edit = { ...base, newString: str('new_string') }
        break
      case 'create':
        // "" is a legitimate empty file (__init__.py, .gitkeep).
        edit = { ...base, newString: str('new_string', { nonEmpty: false }) }
        break
    }
    if (errors.length > 0) problems.push(`${tag}: ${errors.join('; ')}`)
    else edits.push(edit)
  })
  let verify
  try {
    verify = parseVerify(args.verify)
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error))
  }
  return { edits, problems, dryRun: args.dry_run === true, verify }
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

/** Start offsets of `needle` in `text` from `from` on (non-overlapping, capped). */
function occurrences(text, needle, cap = 5, from = 0) {
  const out = []
  while (out.length < cap) {
    const at = text.indexOf(needle, from)
    if (at === -1) break
    out.push(at)
    from = at + needle.length
  }
  return out
}

/**
 * The lines an occurrence of `needle` at `at` sits on, as offsets: `from` is the
 * start of its first line, `to` the end of its last line (before the newline).
 * A newline at either edge of the needle does not pull in the neighbouring line.
 */
export function lineSpan(text, at, needle) {
  let first = at
  let last = at + needle.length - 1
  while (first < last && text[first] === '\n') first++
  while (last > first && text[last] === '\n') last--
  const from = text.lastIndexOf('\n', first - 1) + 1
  const nl = text.indexOf('\n', last)
  return { from, to: nl === -1 ? text.length : nl }
}

/**
 * Render the given 1-based line numbers as `N: text` rows, merged in order with
 * `…` between non-adjacent runs, `>` on the marked lines.
 */
function renderLines(lines, show, marked) {
  const nums = [...new Set(show)].filter(n => n >= 1 && n <= lines.length).sort((a, b) => a - b)
  const width = String(nums.at(-1) ?? 1).length
  const rows = []
  let prev
  for (const n of nums) {
    if (prev !== undefined && n > prev + 1) rows.push('  …')
    rows.push(`${marked.has(n) ? '>' : ' '} ${String(n).padStart(width)}: ${lines[n - 1]}`)
    prev = n
  }
  return rows.join('\n')
}

/**
 * Why the anchor's first line, or the first line where a multi-line anchor diverges, does not match `lines` at `n`.
 * @param {string[]} needleLines
 * @param {number} k - index in needleLines aligned with file line n
 */
function divergence(lines, n, needleLines, k) {
  const last = needleLines.length - 1
  const collapse = (s) => s.replace(/\s+/g, ' ').trim()
  for (let j = 0; j <= last; j++) {
    const fileLine = lines[n - 1 + j - k]
    const want = needleLines[j]
    // a one-line anchor may sit anywhere in its line; a multi-line anchor's first/last line may be part of a longer line
    const ok = fileLine !== undefined && (last === 0 ? fileLine.includes(want) : j === 0 ? fileLine.endsWith(want) : j === last ? fileLine.startsWith(want) : fileLine === want)
    if (ok) continue
    const which = last === 0 ? 'the anchor' : `anchor line ${j + 1}`
    if (fileLine === undefined) return `${which} is past the end of the file`
    const lineNo = n + j - k
    if (collapse(fileLine).includes(collapse(want))) return `${which} differs from line ${lineNo} in indentation/whitespace`
    if (fileLine.toLowerCase().includes(want.trim().toLowerCase())) return `${which} differs from line ${lineNo} in letter case`
    return `${which} differs from line ${lineNo}`
  }
  return ''
}

/**
 * The regions of `text` that explain a failed anchor: every occurrence (when
 * there are several; matched lines marked `>`, overlapping windows merged) or
 * the lines resembling the anchor (when there is none), with what differs.
 * @param {string} text
 * @param {string} needle
 * @param {{ maxChars?: number, from?: number }} [opts] - `from`: only occurrences at or after this offset
 */
export function regionsFor(text, needle, opts = {}) {
  const maxChars = opts.maxChars ?? 1200
  const lines = splitLines(text)
  const total = countOccurrences(opts.from ? text.slice(opts.from) : text, needle)
  let out
  if (total > 0) {
    const show = []
    const marked = new Set()
    for (const at of occurrences(text, needle, 5, opts.from ?? 0)) {
      const span = lineSpan(text, at, needle)
      const a = lineOf(text, span.from)
      const b = lineOf(text, span.to)
      for (let n = a; n <= b; n++) marked.add(n)
      for (let n = a - 1; n <= b + 1; n++) show.push(n)
    }
    out = `${plural(total, 'match', 'matches')}${total > 5 ? ' (first 5 shown)' : ''}:\n${renderLines(lines, show, marked)}`
  } else {
    const needleLines = needle.split('\n')
    const k = needleLines.findIndex(s => s.trim() !== '')
    const first = k === -1 ? '' : needleLines[k].trim()
    const collapse = (s) => s.replace(/\s+/g, ' ').trim()
    const tests = [
      (l) => l.includes(first),
      (l) => collapse(l).includes(collapse(first)),
      (l) => l.toLowerCase().includes(first.toLowerCase()),
      (l) => { const token = first.split(/\s+/).sort((x, y) => y.length - x.length)[0] ?? ''; return token.length >= 3 && l.toLowerCase().includes(token.toLowerCase()) },
    ]
    let cand = []
    for (const t of tests) {
      if (first === '') break
      for (let n = 1; n <= lines.length && cand.length < 3; n++) if (t(lines[n - 1])) cand.push(n)
      if (cand.length > 0) break
    }
    if (cand.length === 0) return `no line resembles the first line of the anchor (${preview(first)}); the file has ${plural(lines.length, 'line')}`
    const why = divergence(lines, cand[0], needleLines, k)
    const show = cand.flatMap(n => Array.from({ length: needleLines.length + 2 }, (_, j) => n - 1 - k + j))
    out = `nearest lines (the file has ${plural(lines.length, 'line')})${why ? `; ${why}` : ''}:\n${renderLines(lines, show, new Set(cand))}`
  }
  if (out.length > maxChars) out = `${out.slice(0, maxChars - 1)}…`
  return out
}

/**
 * Translate one op against `text` (the file as it will be) into a literal
 * `{ oldString, newString, replaceAll }` (or `{ whole }` for append) plus
 * `changes` (the spans of `text` replaced and what replaces them, for overlap
 * warnings and the dry-run preview), or a problem string. Anchors must be unique.
 *
 * `insert_after` / `insert_before` / `replace_between` work on whole lines: the
 * line(s) holding a marker, whatever part of the line the marker is.
 * @param {any} edit
 * @param {string} text
 * @param {string} path
 */
export function planEdit(edit, text, path) {
  const tag = `#${edit.index + 1} ${path}`
  const regions = (needle, opts) => regionsFor(text, needle, opts).replace(/\n/g, '\n    ')
  const unique = (needle, what) => {
    const count = countOccurrences(text, needle)
    if (count === 0) return { problem: `${tag}: ${what} not found (${preview(needle)})\n    ${regions(needle)}` }
    if (count > 1) return { problem: `${tag}: ${what} appears ${count} times — make it more specific (${preview(needle)})\n    ${regions(needle)}` }
    return { at: text.indexOf(needle) }
  }
  const stripOneTrailingNl = (s) => s.endsWith('\n') ? s.slice(0, -1) : s
  switch (edit.op) {
    case 'replace': {
      const old = normalize(edit.oldString)
      const count = countOccurrences(text, old)
      if (count === 0) return { problem: `${tag}: old_string not found (${preview(old)})\n    ${regions(old)}` }
      if (count > 1 && !edit.replaceAll) return { problem: `${tag}: old_string appears ${count} times — make it more specific or set replace_all: true (${preview(old)})\n    ${regions(old)}` }
      const replacement = normalize(edit.newString)
      const changes = occurrences(text, old, edit.replaceAll ? Infinity : 1).map(at => ({ from: at, to: at + old.length, text: replacement }))
      return { oldString: old, newString: replacement, replaceAll: edit.replaceAll, count, at: changes[0].from, changes }
    }
    case 'insert_after':
    case 'insert_before': {
      const marker = normalize(edit.marker)
      const hits = occurrences(text, marker, 1000)
      if (hits.length === 0) return { problem: `${tag}: marker not found (${preview(marker)})\n    ${regions(marker)}` }
      // Several occurrences on the same line(s) are not ambiguous: the insert lands next to that line either way.
      const spans = hits.map(at => lineSpan(text, at, marker))
      if (spans.some(s => s.from !== spans[0].from || s.to !== spans[0].to)) {
        return { problem: `${tag}: marker appears ${hits.length} times — make it more specific (${preview(marker)})\n    ${regions(marker)}` }
      }
      const { from, to } = spans[0]
      const line = text.slice(from, to)
      if (line.trim() === '') return { problem: `${tag}: marker must contain text, not only line breaks` }
      const insert = stripOneTrailingNl(normalize(edit.newString))
      return edit.op === 'insert_after'
        ? { oldString: line, newString: `${line}\n${insert}`, replaceAll: false, count: 1, at: from, line: lineOf(text, to) + 1, changes: [{ from: to, to, text: `\n${insert}` }] }
        : { oldString: line, newString: `${insert}\n${line}`, replaceAll: false, count: 1, at: from, changes: [{ from, to: from, text: `${insert}\n` }] }
    }
    case 'replace_between': {
      const start = normalize(edit.start)
      const u = unique(start, 'start marker')
      if (u.problem) return u
      const afterStart = u.at + start.length
      const startSpan = lineSpan(text, u.at, start)
      let endSpan
      let endTo = afterStart
      if (edit.end !== undefined) {
        const end = normalize(edit.end)
        // The end marker is searched after the start marker's text, not after a newline the caller added to it
        // (so `start: "A\n", end: "\nB"` finds B on the line right after A).
        const searchFrom = u.at + start.replace(/\n+$/, '').length
        const count = countOccurrences(text.slice(searchFrom), end)
        if (count === 0) {
          const before = text.indexOf(end)
          if (before !== -1 && before < searchFrom) return { problem: `${tag}: end marker occurs only before the start marker (line ${lineOf(text, before)}; start marker on line ${lineOf(text, u.at)}) (${preview(end)})` }
          return { problem: `${tag}: end marker not found after the start marker (${preview(end)})\n    ${regions(end)}` }
        }
        if (count > 1) return { problem: `${tag}: end marker appears ${count} times after the start marker — make it more specific (${preview(end)})\n    ${regions(end, { from: searchFrom })}` }
        const endAt = text.indexOf(end, searchFrom)
        endSpan = lineSpan(text, endAt, end)
        endTo = endAt + end.length
        if (endSpan.from <= startSpan.to) {
          return { problem: `${tag}: the end marker is on the same line as the start marker (line ${lineOf(text, endAt)}); replace_between replaces whole lines — use replace for text within a line` }
        }
      }
      // Whole lines: between the marker lines, or (inclusive) the marker lines too.
      const from = edit.inclusive ? startSpan.from : Math.min(startSpan.to + 1, text.length)
      const to = endSpan === undefined ? text.length : edit.inclusive ? Math.min(endSpan.to + 1, text.length) : endSpan.from
      let replacement = normalize(edit.newString)
      if (replacement !== '' && !replacement.endsWith('\n')) replacement += '\n'
      // The start line is the last line and has no newline: the new lines go after one.
      if (replacement !== '' && !edit.inclusive && startSpan.to === text.length) replacement = `\n${replacement}`
      const anchorFrom = startSpan.from
      const anchorTo = Math.max(to, endTo, afterStart, endSpan?.to ?? 0)
      const old = text.slice(anchorFrom, anchorTo)
      const next = `${text.slice(anchorFrom, from)}${replacement}${text.slice(to, anchorTo)}`
      if (old === next) return { problem: `${tag}: replace_between changes nothing` }
      // Reported line: where the new lines start (after a newline added to a last line that had none).
      const line = lineOf(text, from) + (replacement.startsWith('\n') ? 1 : 0)
      return { oldString: old, newString: next, replaceAll: false, count: 1, at: u.at, line, changes: [{ from, to, text: replacement }] }
    }
    case 'append': {
      const add = normalize(edit.newString)
      const sep = text === '' || text.endsWith('\n') ? '' : '\n'
      const tail = `${sep}${add}${add.endsWith('\n') ? '' : '\n'}`
      return { whole: `${text}${tail}`, count: 1, at: text.length, line: splitLines(text).length + 1, changes: [{ from: text.length, to: text.length, text: tail }] }
    }
    case 'create': {
      // `text` is "" (the file does not exist yet). A final newline is added as append adds one; "" stays empty.
      const content = normalize(edit.newString)
      const whole = content === '' || content.endsWith('\n') ? content : `${content}\n`
      return { whole, create: true, count: splitLines(whole).length, at: 0, line: 1, changes: [{ from: 0, to: 0, text: whole }] }
    }
    default: return { problem: `${tag}: unsupported op ${edit.op}` }
  }
}

/**
 * Carry the spans written by earlier edits of the call through `changes`
 * (ascending, non-overlapping) and add the new ones, tagged with the edit.
 * @param {Array<{ s: number, e: number, by: number }>} ranges
 * @param {Array<{ from: number, to: number, text: string }>} changes
 * @param {number} by - edit index
 */
export function carryRanges(ranges, changes, by) {
  let out = ranges
  for (const c of [...changes].reverse()) {
    const delta = c.text.length - (c.to - c.from)
    const next = []
    for (const r of out) {
      if (r.e <= c.from) next.push(r)
      else if (r.s >= c.to) next.push({ ...r, s: r.s + delta, e: r.e + delta })
      else {
        if (r.s < c.from) next.push({ ...r, e: c.from })
        if (r.e > c.to) next.push({ ...r, s: c.from + c.text.length, e: r.e + delta })
      }
    }
    next.push({ s: c.from, e: c.from + c.text.length, by })
    out = next.sort((a, b) => a.s - b.s || a.e - b.e)
  }
  return out
}

/**
 * @typedef {{ target: any, path: string, text: string | null, version: any, lineEndings: 'LF' | 'CRLF',
 *   guard: 'observed' | 'unread' | 'stale', guardError?: string, edits: number, applied: number[],
 *   ranges: Array<{ s: number, e: number, by: number }>, unanchored: boolean,
 *   missing: boolean, missingAt: number[], existing?: string, danglingLink?: boolean,
 *   created?: number, blockedBy?: number }} FileState
 */

/**
 * First touch of a file in the call: whether it exists, and for an existing
 * regular file the read-guard decision and its current text. A file whose
 * first entry is a `create` is not read: a create that finds it there fails,
 * and reading it would record an observation the model never saw.
 * @param {any} fs
 * @param {any} ctx
 * @param {any} exec
 * @param {FileState} file
 * @param {any} edit - the first entry naming the file
 * @param {{ cwd: string, policy: any, signal?: AbortSignal }} call
 */
async function loadFile(fs, ctx, exec, file, edit, call) {
  const { target, path } = file
  let info
  try {
    info = await fs.stat(target, call.signal)
  } catch (error) {
    file.guardError = mapFsError(error, path, call.policy).message
    return
  }
  if (info === undefined) {
    file.missing = true
    // A symbolic link to a missing target is still a path entry (stat follows it; lstat does not).
    const link = typeof fs.lstat === 'function'
      ? await fs.lstat(String(edit.filePath).replace(/^~(?=\/|$)/, process.env.HOME ?? '~'), { cwd: call.cwd }, call.signal).catch(() => undefined)
      : undefined
    if (link?.type === 'symlink') file.danglingLink = true
    return
  }
  file.existing = info.type
  if (info.type !== 'file') {
    file.guardError = `"${path}": not a regular file (${info.type})`
    return
  }
  if (edit.op === 'create') return
  // The read-guard decision. FS_NOT_OBSERVED (never read) and a version drift
  // (changed since read, or created since it was observed absent) are not fatal
  // here: the tool reads the file itself and lets unique anchors through, else
  // shows the regions (see the header).
  let intent
  try {
    intent = await ctx.waterfall('fs/edit-intent', target, exec, () => undefined)
  } catch (error) {
    const code = error && typeof error === 'object' ? /** @type {any} */ (error).code : undefined
    if (code === 'FS_NOT_OBSERVED') file.guard = 'unread'
    else if (code === 'FS_NOT_FOUND') file.guard = 'stale'
    else {
      file.guardError = mapFsError(error, path, call.policy).message
      return
    }
  }
  try {
    file.version = info.version
    if (file.guard === 'observed' && intent && intent.version !== undefined && intent.version !== info.version) file.guard = 'stale'
    const raw = await fs.readText(target, call.signal)
    file.lineEndings = detectLineEndings(raw)
    file.text = normalize(raw)
  } catch (error) {
    file.guardError = mapFsError(error, path, call.policy).message
  }
}

/**
 * Why a `create` cannot make this file, or undefined: the path must not exist
 * in any form (file, directory, symlink, even a dangling one), no earlier entry
 * of the call may create it, and its nearest existing ancestor must be a
 * directory (missing parents are created by the write).
 * @param {any} fs
 * @param {FileState} file
 * @param {{ cwd: string, policy: any, signal?: AbortSignal }} call
 * @returns {Promise<string | undefined>}
 */
async function createProblem(fs, file, call) {
  const never = 'create never overwrites — edit it with the other ops, or replace it with write'
  if (file.created !== undefined) return `#${file.created + 1} already creates this file in this call`
  if (file.danglingLink) return `already exists (a symbolic link to a missing target); ${never}`
  if (!file.missing) {
    if (file.existing === undefined) return file.guardError ?? 'already exists'
    const what = file.existing === 'file' ? 'a file' : file.existing === 'directory' ? 'a directory' : `a ${file.existing}`
    return `already exists (${what}); ${never}`
  }
  // The nearest existing ancestor must be a directory, or the write cannot make the parents.
  let dir
  try { dir = typeof fs.processPath === 'function' ? fs.processPath(file.target) : file.path } catch { dir = file.path }
  for (let depth = 0; depth < 256; depth++) {
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
    let info
    try {
      info = await fs.stat(await fs.resolve(dir, { cwd: call.cwd, signal: call.signal }), call.signal)
    } catch {
      break
    }
    if (info === undefined) continue
    if (info.type !== 'directory') return `"${dir}" is not a directory (${info.type}), so it cannot hold the new file`
    break
  }
  return undefined
}

/**
 * The local backend publishes a new file owner-only (0600, the mode of its
 * private staging file). A file `create` makes gets the mode a new file gets
 * from the process umask instead (0644 with umask 022), as an editor or `>`
 * in bash would give it. Only when the backend's files are the host's
 * (`processPathFromHostPath` maps the path to itself); opened without
 * following a symlink, and only a regular file. Returns an error message, or
 * undefined (also when there was nothing to do).
 * @param {any} fs
 * @param {any} target
 * @returns {Promise<string | undefined>}
 */
export async function applyDefaultMode(fs, target) {
  if (process.platform === 'win32' || typeof fs.processPath !== 'function' || typeof fs.processPathFromHostPath !== 'function') return undefined
  let path
  try {
    path = fs.processPath(target)
    if (fs.processPathFromHostPath(path) !== path) return undefined
  } catch {
    return undefined
  }
  const mode = 0o666 & ~process.umask()
  let handle
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    const info = await handle.stat()
    if (info.isFile() && (info.mode & 0o777) !== mode) await handle.chmod(mode)
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  } finally {
    await handle?.close().catch(() => {})
  }
}

/**
 * Validate a batch against current file contents without writing.
 * @param {any} fs
 * @param {any} ctx
 * @param {any} exec
 * @param {ReturnType<typeof parseEditManyArgs>['edits']} edits
 * @param {{ cwd: string, policy: any, signal?: AbortSignal }} call
 * @returns {Promise<{ resolved: any[], problems: string[], warnings: string[], files: Map<string, any>, refusals: string[] }>}
 */
export async function validateEdits(fs, ctx, exec, edits, call) {
  /** @type {Map<string, FileState>} */
  const files = new Map()
  const resolved = []
  const problems = []
  const warnings = []
  /** codes of the sandbox refusals among `problems` */
  const refusals = []
  // The mode the writes run under (the backend falls back to the deployment's policy when the call has none), for the wording.
  const mode = (call.policy ?? ctx.get('sandboxPolicy')?.resolve())?.mode
  for (const edit of edits) {
    let target
    try {
      target = await resolvePath(fs, edit.filePath, call)
    } catch (error) {
      problems.push(`#${edit.index + 1} ${edit.filePath}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    const path = shownPath(fs, target, edit.filePath)
    const key = target.targetKey ?? path
    let file = files.get(key)
    if (file === undefined) {
      file = { target, path, text: null, version: null, lineEndings: 'LF', guard: 'observed', edits: 0, applied: [], ranges: [], unanchored: false, missing: false, missingAt: [] }
      files.set(key, file)
      await loadFile(fs, ctx, exec, file, edit, call)
      // Once per file, at its first entry; the entries are still validated, so their other problems show too.
      const refusal = await sandboxRefusal(fs, target, call.policy, mode, call.signal)
      if (refusal !== undefined) {
        problems.push(`#${edit.index + 1} ${path}: ${refusal.message}`)
        refusals.push(refusal.code)
      }
    }
    const n = edit.index + 1
    if (file.blockedBy !== undefined) {
      problems.push(`#${n} ${path}: not checked: the create in #${file.blockedBy + 1} failed`)
      continue
    }
    if (edit.op === 'create') {
      const problem = await createProblem(fs, file, call)
      if (problem !== undefined) {
        problems.push(`#${n} ${path}: ${problem}`)
        // Later entries of the call would edit a file that is not the one meant.
        if (file.created === undefined) file.blockedBy = edit.index
        continue
      }
      // Entries before this one found no file: say why, since the order is the fix.
      for (const at of file.missingAt) problems[at] += ` (#${n} creates it later in this call; entries apply in order, so put the create first)`
      file.created = edit.index
      file.missing = false
      file.text = ''
      // The new file's line endings are those of new_string (majority, as for an existing file).
      file.lineEndings = detectLineEndings(edit.newString)
    } else if (file.missing) {
      // An edit needs an existing file; only create makes one.
      const hint = edit.op === 'append' ? ' (append needs an existing file; use op "create" for a new one)' : ''
      file.missingAt.push(problems.length)
      problems.push(`#${n} "${path}": not found${hint}`)
      continue
    } else if (file.guardError !== undefined) {
      problems.push(`#${n} ${file.guardError}`)
      continue
    }
    file.edits += 1
    const text = /** @type {string} */ (file.text)
    const plan = planEdit(edit, text, path)
    if (plan.problem) {
      const notes = []
      if (file.guard === 'unread') notes.push('[file not read this session]')
      if (file.guard === 'stale') notes.push('[file changed since it was read]')
      // Anchors and line numbers refer to the file as the earlier entries of this call leave it.
      if (file.applied.length > 0) notes.push(`[as edited by ${file.applied.map(i => `#${i + 1}`).join(', ')}]`)
      const [head, ...rest] = plan.problem.split('\n')
      problems.push([notes.length ? `${head} ${notes.join(' ')}` : head, ...rest].join('\n'))
      file.unanchored = true
      continue
    }
    // A region replaced by this edit that holds text an earlier edit of the call wrote:
    // flagged, since replace_between swallows it without naming it (a replace that names
    // that text in old_string is deliberate and is not flagged).
    if (edit.op === 'replace_between') {
      const hit = new Set()
      for (const c of plan.changes) for (const r of file.ranges) if (r.s < c.to && c.from < r.e) hit.add(r.by)
      if (hit.size > 0) warnings.push(`#${edit.index + 1} ${path}: replace_between replaced text written by ${[...hit].sort((a, b) => a - b).map(i => `#${i + 1}`).join(', ')} earlier in this call`)
    }
    const line = plan.line ?? lineOf(text, plan.at)
    // Simulate, so later edits of this call see the file as it will be.
    if (plan.whole !== undefined) file.text = plan.whole
    else file.text = plan.replaceAll ? text.split(plan.oldString).join(plan.newString) : text.replace(plan.oldString, () => plan.newString)
    file.ranges = carryRanges(file.ranges, plan.changes, edit.index)
    file.applied.push(edit.index)
    resolved.push({ edit, target, path, line, count: plan.count, plan, file })
  }
  return { resolved, problems, warnings, files, refusals }
}

/**
 * The changed lines of each file after the whole batch (dry-run preview): every
 * line an edit wrote marked `>`, one line of context, capped.
 * @param {string} text
 * @param {Array<{ s: number, e: number }>} ranges
 */
export function previewChanges(text, ranges, maxRows = 30) {
  const lines = splitLines(text)
  const show = []
  const marked = new Set()
  for (const r of ranges) {
    const a = lineOf(text, Math.min(r.s, Math.max(0, text.length - 1)))
    const b = r.e > r.s ? lineOf(text, r.e - 1) : a
    for (let n = a; n <= b; n++) if (r.e > r.s) marked.add(n)
    for (let n = a - 1; n <= b + 1; n++) show.push(n)
  }
  const rows = renderLines(lines, show, marked).split('\n').filter(Boolean)
  return rows.length > maxRows ? [...rows.slice(0, maxRows), `  … (${rows.length - maxRows} more rows)`] : rows
}

/**
 * @param {{ dryRun: boolean, applied: Array<{ path: string, op: string, line: number, count: number, replaceAll: boolean, guard?: string }>, files: number, warnings?: string[], preview?: Array<{ path: string, rows: string[] }>, verify?: any }} value
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
    const detail = list.map(a => a.op === 'create' ? `create, ${a.count === 0 ? 'empty' : plural(a.count, 'line')}`
      : `${a.op !== 'replace' ? `${a.op} ` : ''}${a.replaceAll ? `${a.count}× from line ${a.line}` : `line ${a.line}`}`).join(', ')
    const guard = list[0].guard === 'unread' ? ' — file was not read this session; applied because every anchor matched uniquely'
      : list[0].guard === 'stale' ? ' — file had changed since it was read; applied because every anchor matched uniquely in the current content' : ''
    lines.push(`  ${path}: ${plural(list.length, 'edit')} (${detail})${guard}`)
  }
  for (const w of value.warnings ?? []) lines.push(`warning: ${w}`)
  for (const p of value.preview ?? []) lines.push(`${p.path} after the edits (> changed):`, ...p.rows.length ? p.rows.map(r => `  ${r}`) : ['  (empty file)'])
  if (value.verify) {
    const v = value.verify
    if (v.skipped) lines.push(`verify skipped (${v.skipped}).`)
    else {
      const status = v.timedOut ? `timed out after ${formatMs(v.timeoutMs)}` : v.aborted ? 'cancelled' : v.exitCode === 0 ? 'exit 0' : `exit ${v.exitCode ?? `signal ${v.signal ?? '?'}`}`
      const shown = v.truncatedLines ? `last ${v.outputLines - v.truncatedLines} of ${v.outputLines} lines` : plural(v.outputLines, 'line')
      if (v.outputLines === 0) lines.push(`verify \`${v.command}\` → ${status} (no output)`)
      else {
        lines.push(`verify \`${v.command}\` → ${status} (${shown}${v.outputTruncated ? ', output capped by the executor' : ''}):`)
        lines.push(v.output)
      }
    }
  }
  return lines.join('\n')
}

/** `1.5s`, `2s`, `250ms`: a timeout as given, not rounded. */
function formatMs(ms) {
  return ms < 1000 ? `${ms}ms` : `${Number((ms / 1000).toFixed(3))}s`
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
      + '"insert_after" / "insert_before" { marker, new_string } put new_string as whole line(s) right after/before the line holding the unique marker (one trailing newline of new_string is dropped); '
      + '"replace_between" { start, end?, new_string, inclusive? } works on whole lines: the lines between the line holding the unique start marker and the line holding end '
      + '(omitted = to end of file) become new_string as whole line(s) (no \\n needed); "" deletes them; inclusive also replaces the marker lines; for text within one line use replace; '
      + '"append" { new_string } adds line(s) to the end of an existing file; '
      + '"create" { new_string } makes a new file (and its parent directories; refused if the path exists: never overwrites; "" = empty; later entries may edit it). '
      + 'append/create add a missing final newline. Line endings (LF/CRLF) are kept (create: those of new_string). '
      + 'ALL entries are validated first (the sandbox included) and reported together (numbered #1…); nothing is written if any fails; a later entry may match text produced by an earlier one '
      + '(a replace_between that swallows such text is applied with a warning). dry_run shows the changed lines. '
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
            file_path: { type: 'string', required: true, description: 'Path to edit or create (relative to the session\'s current working directory, absolute, or ~).' },
            op: { type: 'string', enum: OPS, description: 'Edit kind (default replace).' },
            old_string: { type: 'string', description: 'replace: literal text to replace. Must match exactly.' },
            new_string: { type: 'string', description: 'The new text (replace: replacement, "" deletes; replace_between: the new line(s), "" deletes the lines; insert_*: the lines to insert; append: the lines to add; create: the whole new file).' },
            replace_all: { type: 'boolean', description: 'replace: change every occurrence (default false: exactly one required).' },
            marker: { type: 'string', description: 'insert_after / insert_before: unique literal text; the insert lands after/before the line containing it.' },
            start: { type: 'string', description: 'replace_between: unique literal text on the line before the replaced lines.' },
            end: { type: 'string', description: 'replace_between: literal text (unique after start, on a later line) on the line after the replaced lines; omit for end of file.' },
            inclusive: { type: 'boolean', description: 'replace_between: also replace the lines holding the markers (default false: those lines stay).' },
          },
        },
        description: `The edits, in application order (max ${MAX_EDITS}).`,
      },
      verify: {
        type: 'object',
        additionalProperties: false,
        properties: {
          command: { type: 'string', required: true, description: 'Shell command to run after a successful apply (through the same shell and sandbox as bash).' },
          workdir: { type: 'string', description: 'Working directory (default: the session\'s current working directory, as for bash).' },
          timeout_ms: { type: 'integer', description: `Timeout (default ${VERIFY_DEFAULT_TIMEOUT_MS / 1000}s, max ${VERIFY_MAX_TIMEOUT_MS / 1000}s).` },
          max_lines: { type: 'integer', description: `Keep the last N lines of stdout+stderr (default ${VERIFY_DEFAULT_LINES}, max ${VERIFY_MAX_LINES}).` },
        },
        description: 'Run this after the edits are written; the result reports exit code and output tail (a failing check is reported, not a tool error). Not run after a validation failure or in dry_run.',
      },
      dry_run: { type: 'boolean', description: 'Validate only; report what would change, with the changed lines, without writing.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: renderEditMany(value) }],
      presentationMeta: (args, value) => ({
        diffs: value.dryRun ? [] : (Array.isArray(args.edits) ? args.edits : []).filter(e => e && (e.op === undefined || e.op === 'replace' || e.op === 'create'))
          .map(e => ({ path: String(e?.file_path ?? ''), oldText: e.op === 'create' ? null : String(e?.old_string ?? ''), newText: String(e?.new_string ?? '') })),
      }),
    },
    async execute(args, exec) {
      const input = parseEditManyArgs(args)
      const fs = requireFs(ctx)
      const call = await callContext(ctx, exec)
      const validated = await validateEdits(fs, ctx, exec, input.edits, call)
      const { resolved, warnings, files } = validated
      // Argument and anchor problems together, in entry order (a verify problem last).
      const order = (p) => { const m = /^#(\d+)/.exec(p); return m ? Number(m[1]) : Infinity }
      const problems = [...input.problems, ...validated.problems].map((p, i) => ({ p, i })).sort((a, b) => order(a.p) - order(b.p) || a.i - b.i).map(x => x.p)
      // The tool read every unread / changed file above: record that, so a retry after
      // the model has seen the regions below is authorised by the guard.
      for (const f of files.values()) {
        if ((f.guard === 'unread' || f.guard === 'stale') && f.version !== null) ctx.emit('fs/observed', f.target, { kind: 'present', version: f.version }, exec)
      }
      if (problems.length > 0) {
        const { refusals } = validated
        const hint = refusals.includes('FS_SANDBOX_DENIED') ? `\n${SANDBOX_ESCALATION_HINT}` : ''
        // Only sandbox refusals: the code the backend's refusal carries, as for a single write.
        const code = refusals.length === problems.length && refusals.every(c => c === 'FS_SANDBOX_DENIED') ? 'FS_SANDBOX_DENIED' : 'EDIT_MANY_INVALID'
        throw new FsToolsError(`edit_many: ${plural(problems.length, 'problem')}, nothing written:\n${problems.map(p => `  ${p}`).join('\n')}${hint}`, code)
      }
      const applied = []
      const entry = (r, line) => ({ path: r.path, op: r.edit.op, line, count: r.count, replaceAll: r.plan.replaceAll === true, guard: r.file.guard === 'observed' ? undefined : r.file.guard })
      if (input.dryRun) {
        for (const r of resolved) applied.push(entry(r, r.line))
        const preview = [...files.values()].filter(f => f.applied.length > 0).map(f => ({ path: f.path, rows: previewChanges(/** @type {string} */ (f.text), f.ranges) }))
        return dropUndefined({ dryRun: true, applied, files: new Set(applied.map(a => a.path)).size, ...warnings.length ? { warnings } : {}, preview, ...input.verify ? { verify: { command: input.verify.command, skipped: 'dry_run' } } : {} })
      }
      for (const r of resolved) {
        try {
          if (r.plan.create) {
            // No read guard to consult: createIfAbsent is the guard (the intent the built-in
            // write gets for a file never seen); the backend refuses an existing path, even one
            // created since validation. The sandbox fences it like every other write.
            const content = r.file.lineEndings === 'CRLF' ? r.plan.whole.split('\n').join('\r\n') : r.plan.whole
            const outcome = await fs.writeText(r.target, content, { kind: 'createIfAbsent' }, call.signal, call.policy)
            const modeError = await applyDefaultMode(fs, r.target)
            if (modeError !== undefined) warnings.push(`#${r.edit.index + 1} ${r.path}: created, but its mode was left as the backend set it (${modeError})`)
            // Observed at its version now (a chmod moves it), so later entries and later calls edit it without a read.
            const version = (await fs.stat(r.target, call.signal).catch(() => undefined))?.version ?? outcome.version
            ctx.emit('fs/observed', r.target, { kind: 'present', version }, exec)
            applied.push(entry(r, r.line))
            continue
          }
          const intent = await ctx.waterfall('fs/edit-intent', r.target, exec, () => undefined)
          let outcome
          if (r.plan.whole !== undefined) {
            // A whole-file write keeps the file's line endings, as the backend's editText does.
            const whole = r.file.lineEndings === 'CRLF' ? r.plan.whole.split('\n').join('\r\n') : r.plan.whole
            outcome = await fs.writeText(r.target, whole, intent?.version !== undefined ? { kind: 'replaceIfVersion', version: intent.version } : undefined, call.signal, call.policy)
          } else {
            outcome = await fs.editText(r.target, { oldString: r.plan.oldString, newString: r.plan.newString, replaceAll: r.plan.replaceAll }, intent, call.signal, call.policy)
          }
          ctx.emit('fs/observed', r.target, { kind: 'present', version: outcome.version }, exec)
          applied.push(entry(r, r.line))
        } catch (error) {
          const code = error && typeof error === 'object' ? /** @type {any} */ (error).code : undefined
          // createIfAbsent's refusal is the backend's FS_NOT_OBSERVED ("read it first"), which is not the remedy here.
          const mapped = r.plan.create && code === 'FS_NOT_OBSERVED'
            ? new FsToolsError(`"${r.path}": already exists (it appeared after validation); nothing overwritten`, 'FS_ALREADY_EXISTS', { cause: error })
            : mapFsError(error, r.path, call.policy)
          // Validation passed, so earlier entries are on disk: name them and their files, since nothing is rolled back.
          const changed = [...new Set(applied.map(a => a.path))]
          const done = applied.length > 0
            ? `Already written, kept (not rolled back): ${applied.map((a, i) => `#${resolved[i].edit.index + 1} ${a.path}:${a.line}`).join(', ')} — ${plural(changed.length, 'file')} changed: ${changed.join(', ')}. `
            : 'Nothing was written. '
          const left = resolved.slice(applied.length).map(x => `#${x.edit.index + 1}`)
          throw new FsToolsError(
            `edit_many stopped at edit #${r.edit.index + 1}: ${mapped.message}\n${done}Not applied: ${left.join(', ')}.`,
            mapped.code,
            { cause: error },
          )
        }
      }
      const value = { dryRun: false, applied, files: new Set(applied.map(a => a.path)).size, ...warnings.length ? { warnings } : {} }
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
