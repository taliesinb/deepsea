/**
 * common.mjs — helpers shared by the four tools:
 *
 *   - session-aware path resolution through ctx.fs (the session's current
 *     working directory, `~` expansion), exactly as the built-in read/edit/bash
 *     tools do;
 *   - the per-call sandbox policy (`ctx.sandboxPolicy.resolve({ session })`)
 *     stamped onto mutations so a confining backend fences them like `edit`;
 *   - the model-facing error class and the `[sandbox: …]` denial mapping, and
 *     the backend's own sandbox decision (`ctx.fs.checkWrite`) edit_many asks
 *     for during validation;
 *   - line-window rendering in the same `N: text` shape as `read`.
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'
import { sandboxDenialMarker } from '@deepseek-ai/dsh-sandbox'

/** Model-facing failure of one of these tools (a HarnessError so `code` survives into the result). */
export class FsToolsError extends HarnessError {
  /**
   * @param {string} message
   * @param {string} [code]
   * @param {{ cause?: unknown }} [options]
   */
  constructor(message, code = 'FS_TOOLS_FAILED', options) {
    super(message, code, options)
    this.name = 'FsToolsError'
  }
}

/**
 * The filesystem service, or a clear failure when the composition has none.
 * @param {any} ctx
 */
export function requireFs(ctx) {
  const fs = ctx.get('fs')
  if (fs === undefined) throw new FsToolsError('this tool needs a filesystem service (ctx.fs) in this composition; none is mounted.')
  return fs
}

/**
 * The standing sandbox policy for this call (undefined when the backend does not confine),
 * and the cwd relative paths resolve against: the session's current working directory
 * (`ctx.workingDirectory.ensure`, which follows `working_directory` cd, exactly as the
 * built-in read/edit/grep/bash tools resolve it), else the policy's workspace root, else
 * the session's original directory.
 * @param {any} ctx
 * @param {any} exec - tool execution context (`exec.agent.session`)
 */
export async function callContext(ctx, exec) {
  const session = exec?.agent?.session
  const policy = session ? ctx.get('sandboxPolicy')?.resolve({ session }) : undefined
  const directories = exec?.agent !== undefined ? ctx.get('workingDirectory') : undefined
  const current = directories?.ensure ? await directories.ensure(exec.agent, exec.signal) : undefined
  const cwd = current ?? policy?.workspaceRoot ?? session?.header?.cwd ?? process.cwd()
  return { policy, cwd, signal: exec?.signal }
}

/**
 * Expand a leading `~` and resolve through ctx.fs against the call's cwd.
 * @param {any} fs
 * @param {string} path
 * @param {{ cwd: string, signal?: AbortSignal }} call
 */
export async function resolvePath(fs, path, call) {
  const expanded = String(path).replace(/^~(?=\/|$)/, process.env.HOME ?? '~')
  return fs.resolve(expanded, { cwd: call.cwd, signal: call.signal })
}

/** `target.displayPath` with a fallback for minimal backends. */
export function displayPath(target, fallback) {
  return target?.displayPath ?? target?.path ?? fallback
}

/**
 * The path shown to the model: the backend's display path, or, when that keeps
 * `.`/`..` segments (the local backend preserves the physical spelling of
 * `../../x`), the canonical process path the backend resolved it to.
 * @param {any} fs
 * @param {any} target
 * @param {string} fallback
 */
export function shownPath(fs, target, fallback) {
  const shown = displayPath(target, fallback)
  if (typeof shown === 'string' && /(^|\/)\.\.?(\/|$)/.test(shown) && typeof fs?.processPath === 'function') {
    try { return fs.processPath(target) } catch { /* keep the display path */ }
  }
  return shown
}

/**
 * The line-ending style of a file, detected as the local backend does (the
 * majority in the first 4 KiB): `CRLF` files are written back with CRLF.
 * @param {string} raw
 * @returns {'LF' | 'CRLF'}
 */
export function detectLineEndings(raw) {
  const sample = raw.slice(0, 4096)
  const crlf = sample.split('\r\n').length - 1
  const lf = sample.split('\n').length - 1 - crlf
  return crlf > lf ? 'CRLF' : 'LF'
}

/**
 * Map a thrown fs error to the model-facing shape: a sandbox denial becomes the
 * shared `[sandbox: …]` marker with the mode's reason and a pointer to the
 * built-in `edit`/`write` (these tools carry no `sandbox_permissions`), guard failures get
 * the same remedies the built-in tools print, everything else keeps its message.
 * @param {unknown} error
 * @param {string} path
 * @param {any} policy
 */
export function mapFsError(error, path, policy) {
  const code = error && typeof error === 'object' ? /** @type {any} */ (error).code : undefined
  const message = error instanceof Error ? error.message : String(error)
  if (code === 'FS_SANDBOX_DENIED') {
    return new FsToolsError(`${sandboxDenial(policy?.mode, path)}. ${SANDBOX_ESCALATION_HINT}`, 'FS_SANDBOX_DENIED', { cause: error })
  }
  if (code === 'FS_NOT_OBSERVED') {
    return new FsToolsError(`cannot modify "${path}": file has not been read — read it (read or read_many), then retry`, code, { cause: error })
  }
  if (code === 'FS_STALE_VERSION') {
    return new FsToolsError(`cannot modify "${path}": file changed since it was read — re-read it (read or read_many), then retry`, code, { cause: error })
  }
  if (code === 'FS_NOT_FOUND') return new FsToolsError(`"${path}": not found`, code, { cause: error })
  return new FsToolsError(`"${path}": ${message}`, typeof code === 'string' ? code : 'FS_TOOLS_FAILED', { cause: error })
}

/** These tools carry no `sandbox_permissions`; the built-in mutating tools do. */
export const SANDBOX_ESCALATION_HINT = 'For a one-off escalation use the built-in edit/write tool with sandbox_permissions.'

/**
 * The `[sandbox: …]` marker of a refused write and the mode's reason, naming `path` when given.
 * @param {string | undefined} mode
 * @param {string} [path]
 */
export function sandboxDenial(mode, path) {
  const why = mode === 'read-only' ? 'read-only mode allows no file writes' : mode === 'workspace-write' ? 'outside the writable roots' : 'refused by the sandbox'
  return `${mode === undefined ? '[sandbox: file access denied]' : sandboxDenialMarker(mode)}${path === undefined ? '' : ` "${path}":`} ${why}`
}

/**
 * Whether `path` (canonical) is a writable root/**
 * The sandbox decision a write of `target` will meet, taken without writing:
 * the backend's own answer, `ctx.fs.checkWrite(target, signal, policy)`
 * (harness topic `fs-check-write`), which runs the fence its writes run.
 * Undefined when allowed, when the backend cannot decide (`unknown`), or when
 * the harness has no `checkWrite`: the write then decides at apply time. Else
 * the refusal (`message` without the path, worded by `mode`; `code`
 * FS_SANDBOX_DENIED, or the code of what the write would throw while deciding,
 * such as an invalid extra root). The fence never prompts anyone.
 * @param {any} fs
 * @param {any} target
 * @param {any} policy - exactly the policy the write will carry (undefined: the backend's own default)
 * @param {string | undefined} mode - the mode that policy resolves to, for the wording
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ message: string, code: string } | undefined>}
 */
export async function sandboxRefusal(fs, target, policy, mode, signal) {
  if (typeof fs.checkWrite !== 'function') return undefined
  let answer
  try {
    answer = await fs.checkWrite(target, signal, policy)
  } catch (error) {
    const code = error && typeof error === 'object' ? /** @type {any} */ (error).code : undefined
    return { message: error instanceof Error ? error.message : String(error), code: typeof code === 'string' ? code : 'FS_TOOLS_FAILED' }
  }
  return answer?.kind === 'denied' ? { message: sandboxDenial(mode), code: 'FS_SANDBOX_DENIED' } : undefined
}

/**
 * Validate an optional positive integer argument.
 * @param {unknown} value
 * @param {string} name
 * @param {number} fallback
 * @param {number} [max]
 */
export function positiveInt(value, name, fallback, max) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new FsToolsError(`${name} must be a positive integer`)
  if (max !== undefined && value > max) throw new FsToolsError(`${name} must be at most ${max}`)
  return value
}

/**
 * Split text into lines the way `read` does (LF/CRLF; a trailing newline does not add an empty line).
 * @param {string} text
 */
export function splitLines(text) {
  if (text === '') return []
  const lines = text.split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/**
 * Render a 1-based line window `offset..offset+limit-1` as `N: text` rows.
 * @param {string[]} lines - the whole file's lines
 * @param {{ offset: number, limit: number, collapseBlank?: boolean, maxLineLength?: number }} window
 * @returns {{ rows: string[], first: number, last: number, total: number, shown: number }}
 */
export function renderWindow(lines, window) {
  const total = lines.length
  const first = Math.min(window.offset, total + 1)
  const end = Math.min(total, first + window.limit - 1)
  const width = String(end).length
  const rows = []
  let shown = 0
  for (let n = first; n <= end; n++) {
    let text = lines[n - 1]
    if (window.collapseBlank && text.trim() === '') continue
    if (window.maxLineLength && text.length > window.maxLineLength) text = `${text.slice(0, window.maxLineLength)}…`
    rows.push(`${String(n).padStart(width)}: ${text}`)
    shown++
  }
  return { rows, first, last: end, total, shown }
}

/** 1-based line number of a character offset inside `text`. */
export function lineOf(text, index) {
  let line = 1
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++
  return line
}

/** `n thing`/`n things`. */
export function plural(n, word, pluralWord = `${word}s`) {
  return `${n} ${n === 1 ? word : pluralWord}`
}

/**
 * Deep copy without `undefined` members (the tool registry snapshots canonical values as lossless JSON).
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function dropUndefined(value) {
  if (Array.isArray(value)) return /** @type {any} */ (value.map(v => v === undefined ? null : dropUndefined(v)))
  if (value && typeof value === 'object') {
    const out = /** @type {any} */ ({})
    for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = dropUndefined(v)
    return out
  }
  return value
}
