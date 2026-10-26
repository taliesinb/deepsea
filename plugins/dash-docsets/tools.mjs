/**
 * The three model-facing tools. Each is a plain DSH tool (`defineTool`) whose
 * canonical value is a JSON object; `output.render` turns it into compact text
 * for the model. Docset resolution and HTML conversion live in docsets.mjs and
 * html-to-md.mjs; the Dash HTTP client in dash.mjs.
 */

import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { DashError } from './dash.mjs'
import { filterDocsets, resolveDocsets, withKeys } from './docsets.mjs'
import { docsetDetails } from './docset-info.mjs'
import { convertPage } from './html-to-md.mjs'

/** Upper bound of docsets detailed in one call (each costs plutil + sqlite3 + a probe search + page GETs). */
const MAX_DETAILS = 20

const objectOutput = (render) => ({
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: render(value) }],
})

/** Result types that point at a whole page rather than a symbol; a symbol row is preferred when a page appears several times. */
const PAGE_TYPES = new Set(['Guide', 'Section', 'Entry', 'Word'])

/**
 * @param {object} deps
 * @param {ReturnType<import('./dash.mjs').createDashClient>} deps.dash
 * @param {{ maxChars: number, defaultMaxResults: number, docsetCacheMs: number }} deps.limits
 * @param {(line: object) => void} [deps.trace]
 */
export function createTools(deps) {
  const { dash, limits } = deps
  const trace = deps.trace ?? (() => {})

  // ------------------------------------------------------------ docset cache
  let cache
  async function docsets(signal, { refresh = false } = {}) {
    if (!refresh && cache !== undefined && Date.now() - cache.at < limits.docsetCacheMs) return cache.rows
    const rows = withKeys(await dash.listDocsets(signal))
    cache = { rows, at: Date.now() }
    return rows
  }

  const tools = []

  tools.push(defineTool({
    name: 'dash_list_docsets',
    description: `List the documentation sets installed in Dash (the macOS docs browser) with the KEY to use in dash_search's docsets parameter (e.g. numpy, pytorch, nlab, html, rust). Cheap (~2 kB); call it when unsure which docsets exist or how one is keyed. With details: true (use with filter; at most ${MAX_DETAILS} docsets) each docset also reports its version, entry counts per type (the vocabulary for dash_search's types), its landing/index page url for browsing with dash_get_page, and the upstream site.`,
    parameters: {
      filter: { type: 'string', description: 'Case-insensitive substring over key, name and platform (e.g. "py").' },
      details: { type: 'boolean', description: `Add version, entry counts by type, landing-page url and site per docset (default false; slower — ~0.3 s per docset, max ${MAX_DETAILS}).` },
    },
    output: objectOutput(renderDocsets),
    async execute(args, exec) {
      const rows = filterDocsets(await docsets(exec.signal, { refresh: true }), args.filter)
      if (args.details === true && rows.length > MAX_DETAILS) throw new DashError(`details: true covers at most ${MAX_DETAILS} docsets; ${rows.length} match.`, { hint: 'Narrow with filter.' })
      const details = args.details === true
        ? await Promise.all(rows.map(row => docsetDetails(row, { dash, signal: exec.signal })))
        : null
      return {
        total: cache.rows.length,
        filter: args.filter ?? null,
        details: args.details === true,
        docsets: rows.map((row, i) => ({
          key: row.key,
          name: row.name,
          platform: row.platform ?? null,
          identifier: row.identifier,
          fullTextSearch: row.full_text_search ?? null,
          ...(details ? details[i] : {}),
        })),
      }
    },
  }))

  tools.push(defineTool({
    name: 'dash_search',
    description: 'Search the docsets installed in Dash. Matches SYMBOL AND SECTION NAMES (classes, functions, methods, guide/section titles, nLab entries) fuzzily — not body text — so query with an identifier or a short title ("Tensor.view", "argsort", "adjoint functor", "<dialog>"), not a sentence. Default: all installed docsets; narrow with docsets (keys from dash_list_docsets; names like "torch" or "PyTorch" also resolve). Dash returns ONE entry per name: same-named symbols (torch.transpose vs Tensor.transpose) hide behind the first, so qualify the query ("Tensor.transpose") to reach a specific one. Each result carries a url for dash_get_page.',
    parameters: {
      query: { type: 'string', required: true, description: 'Symbol or title to look up. Multi-word queries match titles containing the words; fewer words match more.' },
      docsets: { type: 'array', items: { type: 'string' }, description: 'Docset keys/names to search (e.g. ["numpy", "pytorch"]). Omit for all installed docsets.' },
      types: { type: 'array', items: { type: 'string' }, description: 'Keep only these result types, case-insensitive (e.g. ["Method", "Function", "Class"]; others include Guide, Section, Attribute, Module, Entry, Element, Property, Macro, Type, Word).' },
      maxResults: { type: 'number', description: `Maximum results to return (default ${limits.defaultMaxResults}, max 200).` },
      snippets: { type: 'boolean', description: 'Also search the user\'s personal Dash code snippets (default false).' },
    },
    output: objectOutput(renderSearch),
    async execute(args, exec) {
      const query = args.query.trim()
      if (query === '') throw new DashError('query must not be empty.')
      const maxResults = Math.min(200, Math.max(1, Math.floor(args.maxResults ?? limits.defaultMaxResults)))
      const types = (args.types ?? []).map(t => t.trim().toLowerCase()).filter(Boolean)

      let rows = await docsets(exec.signal)
      let selected
      let resolution = { resolved: rows, errors: [] }
      if (args.docsets !== undefined && args.docsets.length > 0) {
        resolution = resolveDocsets(args.docsets, rows)
        if (resolution.resolved.length === 0 && resolution.errors.length > 0) {
          // Maybe the installed set changed since the cache was filled.
          rows = await docsets(exec.signal, { refresh: true })
          resolution = resolveDocsets(args.docsets, rows)
        }
        if (resolution.resolved.length === 0) throw new DashError(`No docset matched: ${resolution.errors.join('; ')}.`)
      }
      selected = resolution.resolved
      if (selected.length === 0) throw new DashError('Dash has no docsets installed.', { hint: 'Install some in Dash ▸ Settings ▸ Downloads.' })

      // Over-fetch when a type filter or page-grouping will drop rows; Dash caps at 1000.
      const requested = Math.min(1000, types.length > 0 ? Math.max(maxResults * 4, 60) : Math.max(maxResults * 2, 30))
      let response
      try {
        response = await dash.search({ query, identifiers: selected.map(row => row.identifier), maxResults: requested, snippets: args.snippets === true }, exec.signal)
      } catch (error) {
        if (error instanceof DashError && error.status === 400 && /identifier/i.test(error.message)) {
          cache = undefined // stale identifiers (Dash reinstalled a docset); the caller can retry
          throw new DashError(`${error.message}`, { hint: 'The docset list changed; retry (the cache was refreshed).' })
        }
        throw error
      }
      trace({ event: 'search', query, docsets: selected.map(row => row.key), returned: response.results.length })

      // Dash answers `[{}]` for "nothing found"; dash.mjs drops those, but be safe.
      let items = response.results.filter(row => row && (row.name || row.load_url)).map(row => ({
        docset: row.docset ?? null,
        name: row.name ?? '',
        type: row.type ?? '',
        description: row.description ?? null,
        url: row.load_url ?? '',
        platform: row.platform ?? null,
        language: row.language ?? null,
        tags: row.tags ?? null,
      }))
      if (types.length > 0) items = items.filter(item => types.includes(item.type.toLowerCase()))
      const grouped = groupByPage(items)
      const results = grouped.slice(0, maxResults)
      return {
        query,
        docsets: selected.map(row => row.key),
        allDocsets: args.docsets === undefined || args.docsets.length === 0,
        types: types.length > 0 ? types : null,
        maxResults,
        matched: grouped.length,
        truncated: grouped.length > results.length,
        message: response.message ?? null,
        warnings: resolution.errors,
        results,
      }
    },
  }))

  tools.push(defineTool({
    name: 'dash_get_page',
    description: `Read a documentation page from Dash as Markdown, given a url from dash_search (or a link found in a previously read page). Default scope: the SECTION the url's #anchor points at (e.g. one method's signature and description), else the page's main content. section: "page" reads the whole page, "outline" lists its headings with the section values that select them (use it first on big pages), or pass a heading id ("#loc-3"), heading text ("Definition"), or a CSS selector. Output beyond ${limits.maxChars} chars is truncated and the full text saved to a file (path reported). MathML/KaTeX math becomes $LaTeX$; links stay absolute so they can be passed back to this tool.`,
    parameters: {
      url: { type: 'string', required: true, description: 'Page URL from dash_search (http://127.0.0.1:<port>/Dash/…), optionally with #anchor.' },
      section: { type: 'string', description: '"page" (whole page), "outline" (headings only), "#id" / "id", heading text, or a CSS selector. Default: the url\'s anchor, else the main content.' },
      format: { type: 'string', enum: ['markdown', 'html'], description: 'markdown (default) or the cleaned HTML of the selected region.' },
      maxChars: { type: 'number', description: `Truncate the returned content at this many characters (default ${limits.maxChars}); the full text is always saved to a file when truncated.` },
    },
    output: objectOutput(renderPage),
    async execute(args, exec) {
      const url = args.url.trim()
      const section = args.section?.trim() || undefined
      const { html, finalUrl } = await dash.fetchPage(url, exec.signal)
      let converted
      try {
        converted = convertPage(html, { url: finalUrl === url ? url : keepFragment(url, finalUrl), section, format: args.format ?? 'markdown' })
      } catch (error) {
        if (error?.outline) {
          throw new DashError(`${error.message}. Available headings:\n${renderOutline(error.outline)}`)
        }
        throw error
      }
      const maxChars = Math.max(1000, Math.floor(args.maxChars ?? limits.maxChars))
      const result = {
        url,
        title: converted.title,
        format: args.format ?? 'markdown',
        scope: converted.scope,
        pageChars: converted.pageChars,
        notes: converted.notes,
        outline: converted.outline ?? null,
        content: converted.content,
      }
      return await clamp(result, maxChars, trace)
    },
  }))

  return tools
}

// ----------------------------------------------------------------- helpers

/** Rows that point at the same page collapse into one (symbol rows win over Guide/Section rows). */
function groupByPage(items) {
  const groups = new Map()
  for (const item of items) {
    const pageKey = `${item.docset}|${item.url.split('#')[0]}|${item.name.toLowerCase()}`
    const group = groups.get(pageKey)
    if (!group) {
      groups.set(pageKey, { ...item, alsoTypes: [] })
      continue
    }
    if (PAGE_TYPES.has(group.type) && !PAGE_TYPES.has(item.type)) {
      // Promote the symbol row's url/type; remember the page-level type.
      group.alsoTypes.push(group.type)
      group.type = item.type
      group.url = item.url
      group.description = group.description ?? item.description
    } else if (!group.alsoTypes.includes(item.type) && item.type !== group.type) {
      group.alsoTypes.push(item.type)
    }
  }
  return [...groups.values()]
}

/** Keep the caller's #fragment when the server redirected. */
function keepFragment(original, final) {
  try {
    const hash = new URL(original).hash
    const out = new URL(final)
    if (hash && !out.hash) out.hash = hash
    return out.toString()
  } catch {
    return final
  }
}

/** Scratch files holding the full text of a truncated page: `$TMPDIR/deepsea-dash-docsets-page-<ms>-<pid>.md`. */
export const SCRATCH_PREFIX = 'deepsea-dash-docsets-page-'

/** Cut the content at `maxChars`, saving the full text first (null when it could not be written). */
async function clamp(result, maxChars, trace) {
  if (result.content.length <= maxChars) return result
  let file = join(tmpdir(), `${SCRATCH_PREFIX}${Date.now()}-${process.pid}.${result.format === 'html' ? 'html' : 'md'}`)
  try {
    await writeFile(file, result.content, { mode: 0o600 })
  } catch (error) {
    trace({ event: 'spill-failed', file, error: String(error) })
    file = null
  }
  return { ...result, content: result.content.slice(0, maxChars), truncated: true, totalChars: result.content.length, fullTextPath: file }
}

// ---------------------------------------------------------------- renderers

function renderDocsets(value) {
  const head = value.filter ? `${value.docsets.length} of ${value.total} installed docsets match "${value.filter}"` : `${value.total} installed docsets`
  if (value.docsets.length === 0) return `${head}.`
  const width = Math.min(34, Math.max(...value.docsets.map(d => d.key.length)))
  if (!value.details) {
    const lines = value.docsets.map(d => `${d.key.padEnd(width)}  ${d.name}`)
    return `${head} (key  name):\n${lines.join('\n')}`
  }
  const n = (x) => x.toLocaleString('en-US')
  const blocks = value.docsets.map(d => {
    const lines = [`${d.key}  ${d.name}${d.fullTextSearch && d.fullTextSearch !== 'enabled' ? `  (full-text search: ${d.fullTextSearch})` : ''}`]
    if (d.types && d.types.length > 0) {
      const shown = d.types.slice(0, 10).map(t => `${t.type} ${n(t.count)}`).join(', ')
      lines.push(`  ${n(d.entries)} entries: ${shown}${d.types.length > 10 ? ` (+${d.types.length - 10} more types)` : ''}`)
    } else {
      lines.push(d.types ? '  entries: none in the docset index (Dash indexes this docset elsewhere)' : '  entries: docset index not readable')
    }
    if (d.indexUrl) lines.push(`  index page: ${d.indexUrl}`)
    if (d.documentsPath) lines.push(`  files: ${d.documentsPath}${d.indexFile ? ` (index: ${d.indexFile.slice(d.documentsPath.length + 1)})` : ''}`)
    else if (d.packed) lines.push('  files: packed (tarix.tgz) — pages exist only through Dash\'s server')
    if (d.site) lines.push(`  site: ${d.site}`)
    return lines.join('\n')
  })
  return `${head}:\n${blocks.join('\n')}`
}

function renderSearch(value) {
  const where = value.allDocsets ? `all ${value.docsets.length} docsets` : value.docsets.join(', ')
  const head = []
  if (value.results.length === 0) {
    head.push(`No results for "${value.query}" in ${where}${value.types ? ` (types: ${value.types.join(', ')})` : ''}.`)
    head.push('Dash matches symbol and section NAMES fuzzily: try a shorter or different identifier, drop a word, or search other docsets.')
  } else {
    head.push(`${value.results.length}${value.truncated ? ` of ${value.matched}` : ''} result${value.results.length === 1 ? '' : 's'} for "${value.query}" in ${where}${value.types ? ` (types: ${value.types.join(', ')})` : ''}:`)
  }
  if (value.message) head.push(`NOTE: ${value.message}`)
  for (const warning of value.warnings) head.push(`NOTE: ${warning}`)
  const lines = value.results.map((r, i) => {
    const also = r.alsoTypes.length > 0 ? ` (also ${r.alsoTypes.join(', ')})` : ''
    const parent = r.description ? ` — ${r.description}` : ''
    const snippet = r.language ? ` [${r.language}${r.tags ? `; ${r.tags}` : ''}]` : ''
    return `${i + 1}. ${r.docset ?? 'Snippet'} · ${r.type}${also} · ${r.name}${parent}${snippet}\n   ${r.url}`
  })
  return [...head, ...lines].join('\n')
}

function renderOutline(outline) {
  return outline.map(h => `${'  '.repeat(Math.max(0, h.level - 1))}${'#'.repeat(h.level)} ${h.text}${h.id ? `  → section: "#${h.id}"` : ''}`).join('\n')
}

function renderPage(value) {
  const scope = value.scope
  let scopeLine
  if (scope.kind === 'outline') scopeLine = `Outline of ${value.pageChars.toLocaleString('en-US')} chars of text; pass one of the section values (or the heading text) to dash_get_page.`
  else if (scope.kind === 'anchor') scopeLine = `Scope: anchor ${scope.target}${scope.label ? ` ("${scope.label}")` : ''} — ${scope.chars.toLocaleString('en-US')} of ${value.pageChars.toLocaleString('en-US')} chars of page text${scope.chars < value.pageChars * 0.9 ? '; section: "page" for the whole page, "outline" for its headings' : ''}.`
  else if (scope.kind === 'section') scopeLine = `Scope: section ${scope.target}${scope.label ? ` ("${scope.label}")` : ''} — ${scope.chars.toLocaleString('en-US')} of ${value.pageChars.toLocaleString('en-US')} chars of page text.`
  else scopeLine = `Scope: ${scope.target} — ${scope.chars.toLocaleString('en-US')} chars of text.`
  const head = [
    value.title ? `Title: ${value.title}` : undefined,
    `URL: ${value.url}`,
    scopeLine,
    ...value.notes.map(note => `NOTE: ${note}`),
    value.truncated
      ? `NOTE: content truncated to ${value.content.length.toLocaleString('en-US')} of ${value.totalChars.toLocaleString('en-US')} chars; ${value.fullTextPath ? `full text saved to ${value.fullTextPath} (use read, or ` : 'the full text could not be saved ('}re-call with section: "outline" and pick a section).`
      : undefined,
  ].filter(Boolean)
  if (scope.kind === 'outline') return `${head.join('\n')}\n\n${renderOutline(value.outline ?? [])}`
  return `${head.join('\n')}\n\n${value.content}`
}
