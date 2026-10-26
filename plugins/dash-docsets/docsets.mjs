/**
 * Human-friendly docset keys and their resolution.
 *
 * Dash identifies docsets by opaque 8-letter identifiers (`shofitzl`). A model
 * cannot guess those, so every docset gets a stable `key` derived from what
 * Dash does expose: the `platform` (Dash's own search keyword, e.g. `numpy`,
 * `nlab`) — except for the generic platforms (`crate`, `github`, `manPages`,
 * `usercontrib<Name>`, `docgen<Name>`), where the display name (minus its
 * version) is used. Collisions fall back to the versionless name, then to the
 * name plus identifier, so keys are always unique within one listing.
 */

/** Platforms that name a docset *kind*, not the docset. */
const GENERIC_PLATFORMS = new Set(['crate', 'github', 'manpages', 'usercontributed', 'docgen'])

/** `"NumPy 2.5"` → `"NumPy"`, `"Rust 1.97.1"` → `"Rust"`, `"Litestar 2"` → `"Litestar"`. */
export function stripVersion(name) {
  return name
    .replace(/\s+Repo SHA:.*$/i, '')
    .replace(/\s+v?\d+(\.\d+)*([-+._][0-9a-z.]+)?$/i, '')
    .trim()
}

/** Lower-case, ASCII, dash-separated. Never empty. */
export function slug(text) {
  const out = text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^0-9a-zA-Z]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
  return out.length > 0 ? out : 'docset'
}

function baseKey(docset) {
  const platform = String(docset.platform ?? '')
  const name = stripVersion(String(docset.name ?? ''))
  const lower = platform.toLowerCase()
  const usercontrib = /^usercontrib(.+)$/i.exec(platform)
  if (usercontrib) return slug(usercontrib[1])
  const docgen = /^docgen(.+)$/i.exec(platform)
  if (docgen) return slug(docgen[1])
  if (lower === 'manpages') return 'man'
  if (platform === '' || GENERIC_PLATFORMS.has(lower)) return slug(name)
  return slug(platform)
}

/**
 * Attach a unique `key` to every docset row (returns new objects, input order kept).
 * @param {Array<{ name: string, identifier: string, platform?: string, full_text_search?: string, path?: string }>} docsets
 */
export function withKeys(docsets) {
  const rows = docsets.map(docset => ({ ...docset, key: baseKey(docset), displayName: stripVersion(String(docset.name ?? '')) }))
  // Round 1: colliding platform-derived keys → versionless name.
  const count = (list) => list.reduce((m, r) => m.set(r.key, (m.get(r.key) ?? 0) + 1), new Map())
  let counts = count(rows)
  for (const row of rows) if (counts.get(row.key) > 1) row.key = slug(row.displayName)
  // Round 2: still colliding → suffix with the identifier.
  counts = count(rows)
  for (const row of rows) if (counts.get(row.key) > 1) row.key = `${row.key}-${slug(String(row.identifier))}`
  return rows
}

/**
 * Resolve user-facing docset references (keys, names, platforms, identifiers,
 * unambiguous fragments) to docset rows from `withKeys`.
 *
 * @returns {{ resolved: object[], errors: string[] }}
 */
export function resolveDocsets(inputs, rows) {
  const resolved = []
  const errors = []
  const seen = new Set()
  const add = (row) => {
    if (seen.has(row.identifier)) return
    seen.add(row.identifier)
    resolved.push(row)
  }
  for (const raw of inputs) {
    const wanted = String(raw).trim()
    if (wanted === '') continue
    const lower = wanted.toLowerCase()
    const slugged = slug(wanted)
    const exact = rows.filter(row =>
      row.key === lower || row.key === slugged
      || String(row.identifier) === wanted
      || String(row.platform ?? '').toLowerCase() === lower
      || row.displayName.toLowerCase() === lower
      || String(row.name).toLowerCase() === lower)
    if (exact.length > 0) {
      for (const row of exact) add(row)
      continue
    }
    const partial = rows.filter(row =>
      row.key.includes(slugged)
      || row.displayName.toLowerCase().includes(lower)
      || String(row.platform ?? '').toLowerCase().includes(lower))
    if (partial.length === 1) {
      add(partial[0])
    } else if (partial.length > 1) {
      errors.push(`"${wanted}" is ambiguous: ${partial.map(row => row.key).join(', ')}`)
    } else {
      errors.push(`"${wanted}" matches no installed docset (run dash_list_docsets for the keys)`)
    }
  }
  return { resolved, errors }
}

/** Case-insensitive substring filter over key, name and platform. */
export function filterDocsets(rows, filter) {
  const needle = String(filter ?? '').trim().toLowerCase()
  if (needle === '') return rows
  return rows.filter(row => row.key.includes(needle) || String(row.name).toLowerCase().includes(needle) || String(row.platform ?? '').toLowerCase().includes(needle))
}
