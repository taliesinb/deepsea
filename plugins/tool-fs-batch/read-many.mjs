/**
 * read_many — several files / line ranges in ONE call, rendered like `read`
 * (`N: text` rows inside a <path>/<content> envelope per file). Every
 * successful read emits `fs/observed` with the file's version, so the
 * read-before-edit policy treats it exactly like `read`: an `edit`/`edit_many`
 * that follows is authorised. Absent files are observed absent and reported
 * inline (the other files still return) instead of failing the whole call.
 *
 * This is the tool-shaped replacement for `sed -n 'X,Yp' a; echo ---; sed -n … b`.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { FsToolsError, callContext, detectLineEndings, dropUndefined, plural, positiveInt, renderWindow, requireFs, resolvePath, shownPath, splitLines } from './common.mjs'

export const DEFAULT_LIMIT = 2000
export const DEFAULT_TOTAL_LIMIT = 4000
export const MAX_FILES = 40
export const MAX_LINE_LENGTH = 2000

/** Whether an absent path is a symbolic link whose target is missing (backends with `lstat`). */
async function isDanglingLink(fs, path, call) {
  if (typeof fs.lstat !== 'function') return false
  try {
    const expanded = String(path).replace(/^~(?=\/|$)/, process.env.HOME ?? '~')
    return (await fs.lstat(expanded, { cwd: call.cwd }, call.signal))?.type === 'symlink'
  } catch {
    return false
  }
}

/**
 * Validate one numeric field of an entry; a problem is returned, not thrown, so
 * one bad entry is reported inline like a missing file.
 */
function entryInt(value, name, fallback, max) {
  if (value === undefined || value === null) return { value: fallback }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return { error: `${name} must be a positive integer` }
  if (max !== undefined && value > max) return { error: `${name} must be at most ${max}` }
  return { value }
}

/**
 * @param {any} args
 * @param {{ limit: number, totalLimit: number, maxLineLength: number }} caps
 */
export function parseReadManyArgs(args, caps) {
  const raw = args.files
  if (!Array.isArray(raw) || raw.length === 0) throw new FsToolsError('files must be a non-empty array of { path, offset?, limit? }')
  if (raw.length > MAX_FILES) throw new FsToolsError(`files may name at most ${MAX_FILES} entries per call`)
  const files = raw.map((f, i) => {
    const item = typeof f === 'string' ? { path: f } : f
    if (!item || typeof item.path !== 'string' || item.path.trim().length === 0) return { path: `files[${i}]`, error: 'path must be a non-empty string' }
    const offset = entryInt(item.offset, 'offset', 1)
    const limit = entryInt(item.limit, 'limit', caps.limit, caps.limit)
    const error = [offset.error, limit.error].filter(Boolean).join('; ')
    if (error) return { path: item.path, error }
    return { path: item.path, offset: offset.value, limit: limit.value, explicitLimit: item.limit !== undefined && item.limit !== null }
  })
  return {
    files,
    collapseBlank: args.collapse_blank === true,
    maxLines: positiveInt(args.max_lines, 'max_lines', caps.totalLimit, caps.totalLimit),
    maxLineLength: caps.maxLineLength,
    entryLimit: caps.limit,
    totalLimit: caps.totalLimit,
  }
}

/**
 * @param {{ files: Array<{ path: string, error?: string, rows?: string[], first?: number, last?: number, total?: number, shown?: number, cut?: 'max_lines' | 'cap', lineEndings?: string }>, notRead?: Array<{ path: string, offset: number }>, maxLines?: number, entryLimit?: number, totalLimit?: number }} value
 */
export function renderReadMany(value) {
  const out = []
  for (const f of value.files) {
    if (f.error) { out.push(`<path>${f.path}</path>\n<error>${f.error}</error>`); continue }
    const rows = f.rows ?? []
    const notes = [f.total === 0 ? 'empty file' : `lines ${f.first}-${f.last} of ${f.total}`]
    if (f.lineEndings) notes.push(`${f.lineEndings} line endings`)
    if (f.cut === 'max_lines') notes.push(`max_lines reached; continue with offset ${(f.last ?? 0) + 1}`)
    else if (f.cut === 'cap') notes.push(`${value.entryLimit ?? DEFAULT_LIMIT}-line entry cap; continue with offset ${(f.last ?? 0) + 1}`)
    out.push(`<path>${f.path}</path>\n<type>file</type>\n<content>  (${notes.join('; ')})\n${rows.join('\n')}\n</content>`)
  }
  if (value.notRead?.length) {
    const names = value.notRead.map(n => n.offset > 1 ? `${n.path} (from line ${n.offset})` : n.path).join(', ')
    out.push(`(max_lines ${value.maxLines} reached; not read: ${names}. Raise max_lines (max ${value.totalLimit ?? DEFAULT_TOTAL_LIMIT}) or read them in another call.)`)
  }
  return out.join('\n\n')
}

/**
 * @param {any} ctx
 * @param {{ limit: number, totalLimit: number, maxLineLength: number }} caps
 */
export function createReadManyTool(ctx, caps) {
  return defineTool({
    name: 'read_many',
    description: 'Read several UTF-8 text files, or several line ranges of one file, in ONE call. Each entry is { path, offset?, limit? } '
      + `(1-based offset; limit defaults to the whole file up to ${caps.limit} lines). Output is line-numbered like \`read\`; a cut entry says which offset to continue from. Each file read counts as `
      + 'read for the edit tools\' read-before-edit guard. Missing files and invalid entries are reported inline without failing the call. '
      + 'Use this instead of chained `sed -n`/`cat`/`head` in bash.',
    parameters: {
      files: {
        type: 'array',
        required: true,
        items: {
          oneOf: [
            { type: 'string', description: 'A path (whole file).' },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true, description: 'Path (relative to the session\'s current working directory, absolute, or ~).' },
                offset: { type: 'integer', description: '1-based first line (default 1).' },
                limit: { type: 'integer', description: `Max lines for this entry (default and cap ${caps.limit}).` },
              },
            },
          ],
        },
        description: `Files / ranges to read, in output order (max ${MAX_FILES}). The same path may appear several times with different ranges.`,
      },
      collapse_blank: { type: 'boolean', description: 'Drop blank lines from the output (line numbers stay accurate).' },
      max_lines: { type: 'integer', description: `Total line budget across all entries (default and max ${caps.totalLimit}); when it is reached the result names the entries cut or not read and the offset to continue from.` },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: renderReadMany(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const input = parseReadManyArgs(args, caps)
      const fs = requireFs(ctx)
      const call = await callContext(ctx, exec)
      const files = []
      const notRead = []
      let budget = input.maxLines
      /** @type {Map<string, { target: any, info: any, lines: string[], lineEndings?: string }>} */
      const cache = new Map()
      for (const f of input.files) {
        if (f.error) { files.push({ path: f.path, error: f.error }); continue }
        if (budget <= 0) { notRead.push({ path: f.path, offset: f.offset }); continue }
        let target
        try {
          target = await resolvePath(fs, f.path, call)
          const shown = shownPath(fs, target, f.path)
          const key = target.targetKey ?? shown
          let entry = cache.get(key)
          if (entry === undefined) {
            const info = await fs.stat(target, call.signal)
            if (info === undefined) {
              ctx.emit?.('fs/observed', target, { kind: 'absent' }, exec)
              files.push({ path: shown, error: await isDanglingLink(fs, f.path, call) ? 'not found (dangling symbolic link: its target does not exist)' : 'not found' })
              continue
            }
            if (info.type !== 'file') {
              files.push({ path: shown, error: `not a regular file (${info.type})` })
              continue
            }
            const text = await fs.readText(target, call.signal)
            const style = text.includes('\r\n') ? (detectLineEndings(text) === 'CRLF' ? 'CRLF' : 'mixed CRLF/LF') : undefined
            entry = { target, info, lines: splitLines(text), ...style ? { lineEndings: style } : {} }
            cache.set(key, entry)
            // The read succeeded: record the observation so a following edit is authorised.
            ctx.emit?.('fs/observed', target, { kind: 'present', version: info.version }, exec)
          }
          const total = entry.lines.length
          if (f.offset > total && !(total === 0 && f.offset === 1)) {
            files.push({ path: shown, error: `offset ${f.offset} is past the end of the file (${total === 0 ? 'empty' : plural(total, 'line')})` })
            continue
          }
          const limit = Math.min(f.limit, budget)
          const w = renderWindow(entry.lines, { offset: f.offset, limit, collapseBlank: input.collapseBlank, maxLineLength: input.maxLineLength })
          // Cut when fewer lines came back than asked for: by the call's budget, or (no explicit limit) by the per-entry cap.
          const wanted = f.explicitLimit ? Math.min(total, f.offset + f.limit - 1) : total
          const cut = w.last >= wanted ? undefined : limit < f.limit ? 'max_lines' : f.explicitLimit ? undefined : 'cap'
          budget -= w.rows.length
          files.push({ path: shown, rows: w.rows, first: w.first, last: w.last, total: w.total, shown: w.shown, ...cut ? { cut } : {}, ...entry.lineEndings ? { lineEndings: entry.lineEndings } : {} })
        } catch (error) {
          files.push({ path: target ? shownPath(fs, target, f.path) : f.path, error: error instanceof Error ? error.message : String(error) })
        }
      }
      return dropUndefined({ files, ...notRead.length ? { notRead, maxLines: input.maxLines } : {}, entryLimit: input.entryLimit, totalLimit: input.totalLimit })
    },
    presentCall: (args) => {
      const names = Array.isArray(args.files) ? args.files.map(f => typeof f === 'string' ? f : f?.path).filter(Boolean) : []
      const uniq = [...new Set(names)]
      return { card: 'generic', title: `Read ${uniq.slice(0, 3).join(', ')}${uniq.length > 3 ? ` +${uniq.length - 3}` : ''}`, kind: 'read', locations: uniq.map(path => ({ path })) }
    },
  })
}
