/**
 * Per-docset details for `dash_list_docsets({ details: true })`, gathered from
 * the docset bundle on disk plus one probe of Dash's page server — the API
 * itself exposes nothing beyond name/identifier/platform/path/fts.
 *
 * - `Contents/Info.plist` (via `plutil -convert json`): `dashIndexFilePath`
 *   (landing page), `DashDocSetFallbackURL` (upstream site), `DashDocSetFamily`.
 * - `Contents/Resources/docSet.dsidx` (via `/usr/bin/sqlite3 -readonly -json`):
 *   entry counts per type. Two schemas exist: Dash's `searchIndex(name, type,
 *   path)` and Apple's Core Data one (`ZTOKEN` joined to `ZTOKENTYPE`, e.g. the
 *   HTML/MDN docset).
 * - On-disk pages: the conventional `Contents/Resources/Documents/` folder is
 *   reported when it exists (nLab, tokio, most user-generated docsets); feed
 *   docsets (PyTorch, NumPy, HTML) ship packed as `tarix.tgz` and have none.
 * - Landing-page URL: Dash serves pages under `http://127.0.0.1:<port>/Dash/
 *   <code>/…` where `<code>` is only revealed inside search results, so one
 *   throwaway search learns the prefix; candidates (`dashIndexFilePath`,
 *   `index.html`) are then verified with a GET, because many docsets keep
 *   their documents inside `tarix.tgz` rather than as files.
 */

import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export const expandHome = (path) => path.startsWith('~/') ? join(homedir(), path.slice(2)) : path

async function readPlist(docsetPath) {
  try {
    const { stdout } = await run('plutil', ['-convert', 'json', '-o', '-', join(docsetPath, 'Contents', 'Info.plist')], { maxBuffer: 1 << 20 })
    return JSON.parse(stdout)
  } catch {
    return {}
  }
}

const SEARCH_INDEX_SQL = 'select type, count(*) as count from searchIndex group by type order by count desc'
const CORE_DATA_SQL = 'select ZTYPENAME as type, count(*) as count from ZTOKEN join ZTOKENTYPE on ZTOKEN.ZTOKENTYPE = ZTOKENTYPE.Z_PK group by 1 order by count desc'

/** `[{ type, count }]` sorted by count, or null when the index cannot be read. */
export async function typeCounts(docsetPath) {
  const index = join(docsetPath, 'Contents', 'Resources', 'docSet.dsidx')
  for (const sql of [SEARCH_INDEX_SQL, CORE_DATA_SQL]) {
    try {
      const { stdout } = await run('/usr/bin/sqlite3', ['-readonly', '-json', index, sql], { maxBuffer: 1 << 20 })
      const rows = stdout.trim() === '' ? [] : JSON.parse(stdout)
      return rows.map(row => ({ type: String(row.type ?? ''), count: Number(row.count) || 0 })).filter(row => row.type !== '')
    } catch {
      continue
    }
  }
  return null
}

/** `http://127.0.0.1:<port>/Dash/<code>/` for a docset, learned from a search result; null when nothing matches. */
export async function pagePrefix(dash, identifier, signal) {
  for (const query of ['a', 'e', 'i']) {
    const { results } = await dash.search({ query, identifiers: [identifier], maxResults: 1, snippets: false }, signal)
    const url = results[0]?.load_url
    const match = url ? /^https?:\/\/[^/]+\/Dash\/[^/]+\//.exec(url) : null
    if (match) return match[0]
  }
  return null
}

async function isDir(path) {
  try { return (await stat(path)).isDirectory() } catch { return false }
}
async function isFile(path) {
  try { return (await stat(path)).isFile() } catch { return false }
}

async function exists(url, signal) {
  try {
    const response = await fetch(url, { signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(5000)]) })
    await response.body?.cancel()
    return response.ok
  } catch {
    return false
  }
}

/**
 * @param {object} row - a docset row from `withKeys`
 * @param {{ dash: object, signal?: AbortSignal }} deps
 */
export async function docsetDetails(row, { dash, signal }) {
  const docsetPath = expandHome(String(row.path ?? ''))
  const [plist, types, prefix] = await Promise.all([
    readPlist(docsetPath),
    typeCounts(docsetPath),
    pagePrefix(dash, row.identifier, signal).catch(() => null),
  ])
  let indexUrl = null
  if (prefix) {
    const candidates = [plist.dashIndexFilePath, 'index.html'].filter((c, i, all) => typeof c === 'string' && c !== '' && all.indexOf(c) === i)
    for (const candidate of candidates) {
      const url = prefix + candidate.split('/').map(encodeURIComponent).join('/')
      if (await exists(url, signal)) { indexUrl = url; break }
    }
  }
  const documentsDir = join(docsetPath, 'Contents', 'Resources', 'Documents')
  const documentsPath = docsetPath !== '' && await isDir(documentsDir) ? documentsDir : null
  const indexFile = documentsPath && typeof plist.dashIndexFilePath === 'string' && await isFile(join(documentsPath, plist.dashIndexFilePath))
    ? join(documentsPath, plist.dashIndexFilePath)
    : null
  const packed = documentsPath === null && await isFile(join(docsetPath, 'Contents', 'Resources', 'tarix.tgz'))
  const version = String(row.name ?? '').slice(row.displayName.length).trim() || null
  return {
    version,
    documentsPath,
    indexFile,
    packed,
    entries: types ? types.reduce((sum, t) => sum + t.count, 0) : null,
    types,
    indexUrl,
    site: typeof plist.DashDocSetFallbackURL === 'string' ? plist.DashDocSetFallbackURL : null,
    family: typeof plist.DashDocSetFamily === 'string' ? plist.DashDocSetFamily : null,
    path: docsetPath || null,
  }
}
