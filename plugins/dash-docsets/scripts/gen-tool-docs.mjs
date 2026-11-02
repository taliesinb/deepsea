// Generate docs/tools.md from the tool definitions (names, descriptions,
// parameter schemas) so the reference cannot drift from the code.
//   node scripts/gen-tool-docs.mjs          # write
//   node scripts/gen-tool-docs.mjs --check  # exit 1 when docs/tools.md is stale
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createTools } from '../tools.mjs'

const out = fileURLToPath(new URL('../docs/tools.md', import.meta.url))
const tools = createTools({ dash: {}, limits: { maxChars: 60_000, defaultMaxResults: 20, docsetCacheMs: 0 } })

const NOTES = {
  dash_list_docsets: 'Always refreshes from `GET /docsets/list` (the other tools use a cached copy, `docsetCacheSeconds`). `details: true` (`docset-info.mjs`, ≤ 20 docsets) reads each bundle\'s `Contents/Info.plist` via `plutil` (landing page `dashIndexFilePath`, `DashDocSetFallbackURL`, family) and counts `docSet.dsidx` entries per type via `/usr/bin/sqlite3` (both the `searchIndex` and Apple\'s `ZTOKEN`/`ZTOKENTYPE` schemas), then learns the docset\'s page-server prefix (`/Dash/<code>/`) from one throwaway search and GET-verifies landing-page candidates (`dashIndexFilePath`, `index.html`) — documents often live inside `tarix.tgz`, so disk checks would lie. Keys are derived in `docsets.mjs`: the docset `platform` (Dash\'s own search keyword) unless it is a generic kind (`crate`, `github`, `manPages`, `usercontrib*`, `docgen*`), then the versionless display name; collisions fall back to name, then name + identifier. Identifiers are shown in the canonical value only.',
  dash_search: 'Resolves `docsets` to identifiers (key, exact name, platform, identifier, or a unique fragment — `"torch"` → PyTorch; ambiguity is an error listing the candidates), then `GET /search`. Over-fetches (2× / 4× with `types`, min 30 / 60, max 1000) because rows are filtered by type and grouped by page afterwards: a symbol row (Method, Function, …) absorbs the Guide/Section/Entry rows of the same page and lists them as `(also …)`. Dash searches names fuzzily and returns one row per distinct name (same-named symbols collapse, as in its UI — the API cannot expand them; qualify the query instead). Rows typed `Full-Text Search` appear for some docsets when the name search finds nothing (not reliable). A 400 "Docset with identifier … not found" drops the docset cache so the next call re-resolves.',
  dash_get_page: 'Loopback URLs only (the docset file server Dash runs on a second per-launch port). Pipeline (`html-to-md.mjs`): parse with linkedom → strip chrome (`script/style/nav/aside/footer`, roles navigation/banner/contentinfo, `.headerlink`, breadcrumbs, `aria-hidden`) → select ONE region: explicit `section` (`page`, `outline`, `#id`/`id`/`<a name>`, CSS selector, or heading text with numbering ignored) else the URL anchor (`#id`, `#//apple_ref/…` `<a name>` anchors, `#//dash_ref_<id>/…`) else the main landmark when it holds ≥ 60 % of the text. A heading extends to the next heading of the same or a higher level; a `dt` takes its `dl`; a bare header anchor (rustdoc) grows into its enclosing container until it has text. Links are resolved to absolute URLs; SVG/img become `[diagram]`/`[image: alt]`; turndown (GFM tables) renders with rules for `<pre>` language classes, MathML/KaTeX (`annotation` TeX preferred, Unicode math letters folded to `\\mathcal` etc.), Sphinx signatures and field lists, admonitions. Over `maxChars` the content is cut and the full text written to `$TMPDIR/deepsea-dash-docsets-page-*.md`.',
}

const RETURNS = {
  dash_list_docsets: '`{ total, filter, details, docsets[{ key, name, platform, identifier, fullTextSearch, version?, entries?, types?[{type,count}], indexUrl?, documentsPath?, indexFile?, packed?, site?, family?, path? }] }` rendered as `key  name` lines, or per-docset blocks with `details`',
  dash_search: '`{ query, docsets[], allDocsets, types, maxResults, matched, truncated, message, warnings[], results[{ docset, name, type, alsoTypes[], description, url, platform, language, tags }] }` rendered as numbered `docset · type · name — parent` lines each followed by the url',
  dash_get_page: '`{ url, title, format, scope{ kind: anchor|section|page|outline, target, label?, chars }, pageChars, notes[], outline?, content, truncated?, totalChars?, fullTextPath? }` rendered with a Title/URL/Scope header (plus NOTEs) and the content',
}

function schemaLines(schema) {
  const required = new Set(schema.required ?? [])
  return Object.entries(schema.properties ?? {}).map(([name, spec]) => {
    const type = spec.type === 'array' ? `${spec.items?.type ?? 'any'}[]` : spec.enum ? spec.enum.map(v => `"${v}"`).join(' \\| ') : spec.type
    return `| \`${name}\` | ${type} | ${required.has(name) ? 'yes' : 'no'} | ${(spec.description ?? '').replace(/\|/g, '\\|')} |`
  })
}

const sections = tools.map(tool => [
  `## \`${tool.name}\``,
  '',
  tool.description,
  '',
  '| Parameter | Type | Required | Description |',
  '|---|---|---|---|',
  ...schemaLines(tool.parameters),
  '',
  `**Returns:** ${RETURNS[tool.name] ?? '—'}`,
  '',
  `**Implementation:** ${NOTES[tool.name] ?? '—'}`,
  '',
].join('\n'))

const doc = [
  '# Tools: @deepsea/dash-docsets',
  '',
  `Generated by \`scripts/gen-tool-docs.mjs\` from the tool definitions; do not edit by hand. ${tools.length} tools.`,
  '',
  ...sections,
].join('\n')

if (process.argv.includes('--check')) {
  let current = ''
  try { current = readFileSync(out, 'utf8') } catch { /* missing */ }
  if (current !== doc) {
    console.error('docs/tools.md is stale — run `pnpm run docs`')
    process.exit(1)
  }
  console.log('docs/tools.md is up to date')
} else {
  writeFileSync(out, doc)
  console.log(`wrote ${out}`)
}
