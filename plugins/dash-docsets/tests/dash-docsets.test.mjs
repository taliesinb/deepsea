// Offline: no Dash needed. A fake Dash client serves the fixtures, so the
// three tools (arguments, grouping, errors, rendering) and the HTML converter
// (anchors, sections, outline, math, code, field lists) run end to end.
// Fixtures: a saved docset list and search, a PyTorch page as Dash serves it,
// and nLab's "adjoint functor" page trimmed to the first two elements of each
// section (every heading, anchor and the one table kept).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Config, apply, build } from '../index.js'
import { DashError, errorText } from '../dash.mjs'
import { filterDocsets, resolveDocsets, slug, stripVersion, withKeys } from '../docsets.mjs'
import { expandHome } from '../docset-info.mjs'
import { convertPage, normalizeMathText, parseFragment } from '../html-to-md.mjs'
import { SCRATCH_PREFIX, createTools } from '../tools.mjs'

const fixture = (name) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8')
const docsetsJson = JSON.parse(fixture('docsets.json')).docsets
const searchJson = JSON.parse(fixture('search-view.json'))
const pytorchHtml = fixture('pytorch-tensor-view.html')
const nlabHtml = fixture('nlab-adjoint-functor.html')
const PYTORCH_URL = 'http://127.0.0.1:53653/Dash/yhhfldsx/generated/torch.Tensor.view.html'
const NLAB_URL = 'http://127.0.0.1:53653/Dash/iudzkden/pages/494.html'

const ok = (cond, message) => assert.ok(cond, message)

test('config', async () => {
  const config = Config({})
  ok(config.autoLaunch === true && config.maxChars === 60_000 && config.defaultMaxResults === 20 && config.trace === false, 'config defaults')
  ok(config.bundleIds[0] === 'com.kapeli.dash-setapp', 'setapp bundle id first')
  assert.throws(() => Config({ maxChars: 10 }), 'maxChars below minimum is rejected')
})

test('trace: off by default, else one JSONL file per process in the variant\'s log directory', async () => {
  // A throwaway DEEPSEA_ROOT, home and log root: the test never writes into a real home.
  const scratch = mkdtempSync(join(tmpdir(), 'deepsea-dash-docsets-test-'))
  const saved = { DSH_HOME: process.env.DSH_HOME, DEEPSEA_ROOT: process.env.DEEPSEA_ROOT, DEEPSEA_LOG_ROOT: process.env.DEEPSEA_LOG_ROOT, DEEPSEA_VARIANT: process.env.DEEPSEA_VARIANT }
  const ctx = { tools: { register() {} }, logger: { info() {} } }
  try {
    Object.assign(process.env, { DEEPSEA_ROOT: join(scratch, 'root'), DSH_HOME: join(scratch, 'root', 'personal'), DEEPSEA_LOG_ROOT: join(scratch, 'logs') })
    delete process.env.DEEPSEA_VARIANT
    apply(ctx, Config({}))
    ok(readdirSync(scratch).length === 0, 'trace off: nothing written')
    const { trace } = build(Config({ trace: true }))
    trace({ event: 'search', query: 'view' })
    const directory = join(scratch, 'logs', 'io.github.taliesinb.deepsea.personal', 'plugins', 'dash-docsets')
    ok(trace.path?.startsWith(`${directory}/`) && trace.path.endsWith(`-${process.pid}.jsonl`), `trace in the variant's log directory (${trace.path})`)
    const lines = readFileSync(trace.path, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    ok(lines[0].event === 'start' && lines[0].plugin === '@deepsea/dash-docsets@0.1.0' && lines[0].variant === 'io.github.taliesinb.deepsea.personal', 'identity line first')
    ok(lines[1].event === 'search' && typeof lines[1].t === 'string', 'events follow')
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('docsets', async () => {
  ok(stripVersion('NumPy 2.5') === 'NumPy' && stripVersion('Rust 1.97.1') === 'Rust' && stripVersion('Litestar 2') === 'Litestar', 'stripVersion')
  ok(stripVersion('python/cpython Repo SHA: (null), Wiki SHA: no-commits') === 'python/cpython', 'stripVersion github')
  ok(stripVersion('OpenTelemetry Python') === 'OpenTelemetry Python', 'stripVersion keeps words')
  ok(slug('C++') === 'c' && slug('Python Developer\'s Guide') === 'python-developer-s-guide' && slug('') === 'docset', 'slug')
  const rows = withKeys(docsetsJson)
  const keys = Object.fromEntries(rows.map(r => [r.name, r.key]))
  ok(keys['PyTorch 2.11.0'] === 'pytorch' && keys['NumPy 2.5'] === 'numpy' && keys.nLab === 'nlab' && keys['Man Pages'] === 'man', 'derived keys')
  ok(keys['tokio 1.53.1'] === 'tokio' && keys['pyo3 0.29.2'] === 'pyo3' && keys['Kitty Terminal'] === 'kitty', 'generic platforms fall back to the name')
  ok(new Set(rows.map(r => r.key)).size === rows.length, 'keys are unique')
  const dup = withKeys([{ name: 'A 1.0', identifier: 'aaaaaaaa', platform: 'same' }, { name: 'A 2.0', identifier: 'bbbbbbbb', platform: 'same' }])
  ok(dup[0].key === 'a-aaaaaaaa' && dup[1].key === 'a-bbbbbbbb', 'full collision falls back to identifier suffix')

  const r1 = resolveDocsets(['torch', 'NumPy 2.5', 'nlab', 'shofitzl', 'usercontribPyTorch'], rows)
  ok(r1.errors.length === 0 && r1.resolved.map(r => r.key).join(',') === 'pytorch,numpy,nlab', 'resolution by fragment, name, key, identifier, platform (deduplicated)')
  const r2 = resolveDocsets(['py', 'nope'], rows)
  ok(r2.resolved.length === 0 && /ambiguous/.test(r2.errors[0]) && /matches no installed docset/.test(r2.errors[1]), 'ambiguous and unknown inputs are reported')
  ok(filterDocsets(rows, 'PY').length === 19 && filterDocsets(rows, '').length === rows.length, 'filterDocsets')
})

test('dash helpers', async () => {
  ok(errorText('<!DOCTYPE html><html><body><h1>HTTP Error 400: Docset with identifier \'x\' not found</h1></body></html>') === 'Docset with identifier \'x\' not found', 'errorText strips the HTML page')
  ok(new DashError('a', { hint: 'b' }).message === 'a b', 'DashError appends the hint')
})

test('docset-info helpers', async () => {
  ok(expandHome('~/Library/x') === `${process.env.HOME}/Library/x` && expandHome('/abs') === '/abs', 'expandHome')
})

test('fragments & math', async () => {
  ok(parseFragment(`${PYTORCH_URL}#torch.Tensor.view`).id === 'torch.Tensor.view', 'plain id fragment')
  ok(parseFragment('http://x/y.html#//dash_ref_156771/Method/push/0').id === '156771', 'dash_ref fragment carries an id')
  const apple = parseFragment('http://x/y.html#//apple_ref/cpp/Section/1.%20Idea')
  ok(apple.raw === '//apple_ref/cpp/Section/1.%20Idea' && apple.decoded === '//apple_ref/cpp/Section/1. Idea', 'apple_ref fragment raw + decoded')
  ok(parseFragment('http://x/y.html') === undefined, 'no fragment')
  ok(normalizeMathText('𝐿⊣𝑅:𝒟︀⇆𝒞︀') === 'L⊣R:\\mathcal{D}⇆\\mathcal{C}', 'math alphanumerics folded to LaTeX')
  ok(normalizeMathText('\\mathit{x} ℝ 𝔸 𝐯 𝟛 𝛼') === 'x \\mathbb{R} \\mathbb{A} \\mathbf{v} 3 α', 'letterlike, bold, digits, greek')
})

test('converter', async () => {
  const anchored = convertPage(pytorchHtml, { url: `${PYTORCH_URL}#torch.Tensor.view` })
  ok(anchored.scope.kind === 'anchor' && anchored.scope.target === '#torch.Tensor.view', 'anchor scope')
  ok(anchored.content.startsWith('**`Tensor.view(*shape) → Tensor`**'), 'Sphinx signature rendered as bold code')
  ok(anchored.content.includes('$d, d+1, \\dots, d+k$') && !anchored.content.includes('d,d+1,…'), 'KaTeX annotation used once (no doubled math)')
  ok(anchored.content.includes('$$\n\\text{stride}[i]'), 'display math')
  ok(anchored.content.includes('```python\n>>> x = torch.randn(4, 4)'), 'fenced code with language')
  ok(anchored.content.includes(`](${PYTORCH_URL.replace('torch.Tensor.view', 'torch.Tensor.shape')}#torch.Tensor.shape`), 'relative links resolved against the page URL')
  ok(anchored.content.includes('**Parameters:**\n\n**shape** (') && !anchored.content.includes('****'), 'parameter list (no doubled bold)')
  ok(!anchored.content.includes('Rate this Page'), 'theme chrome stripped')

  const page = convertPage(pytorchHtml, { url: `${PYTORCH_URL}#torch.Tensor.view`, section: 'page' })
  ok(page.scope.kind === 'page' && /^main/.test(page.scope.target) && page.content.startsWith('# torch.Tensor.view'), 'section: "page" picks the main landmark')

  const outline = convertPage(pytorchHtml, { url: PYTORCH_URL, section: 'outline' })
  ok(outline.outline.length === 1 && outline.outline[0].id === 'torch-tensor-view', 'outline is limited to the main region (footer headings excluded)')

  const missing = convertPage(pytorchHtml, { url: `${PYTORCH_URL}#nope` })
  ok(missing.scope.kind === 'page' && /anchor #nope not found/.test(missing.notes[0]), 'unknown anchor falls back to the page with a note')

  assert.throws(() => convertPage(pytorchHtml, { url: PYTORCH_URL, section: '#does-not-exist' }), (error) => Array.isArray(error.outline), 'unknown section throws with the outline attached')

  const html = convertPage(pytorchHtml, { url: `${PYTORCH_URL}#torch.Tensor.view`, format: 'html' })
  ok(html.content.startsWith('<dl class="py method">'), 'html format returns the selected region')

  const t = Date.now()
  const nlab = convertPage(nlabHtml, { url: NLAB_URL, section: 'page' })
  ok(Date.now() - t < 2000, `nLab (heavy MathML and SVG) converts quickly (${Date.now() - t} ms)`)
  ok(nlab.content.startsWith('# adjoint functor') && nlab.content.includes('$L \\dashv R$'), 'MathML → LaTeX')
  ok(nlab.content.includes('$\\mathcal{C}$'), 'script letters → \\mathcal')
  ok(nlab.content.includes('\n[diagram]\n') && !nlab.content.includes('\\[diagram\\]'), 'SVG diagrams become unescaped placeholders')
  ok(/\| --- \| --- \|/.test(nlab.content), 'GFM tables')
  ok(!nlab.content.includes('## Contents'), 'nav (table of contents) stripped')

  const byId = convertPage(nlabHtml, { url: NLAB_URL, section: '#loc-3' })
  ok(byId.scope.kind === 'section' && byId.scope.label === '2.1. In terms of Hom isomorphism' && byId.content.startsWith('### 2.1. In terms of Hom isomorphism') && !byId.content.includes('### 2.2.'), 'heading extent stops at the next heading of the same level')
  const byText = convertPage(nlabHtml, { url: NLAB_URL, section: 'Definition' })
  ok(byText.scope.label === '2. Definition' && byText.content.includes('### 2.1.') && byText.content.includes('### 2.8.') && !byText.content.includes('## 3.'), 'heading by text includes its subsections only')
  const appleRef = convertPage(nlabHtml, { url: `${NLAB_URL}#//apple_ref/cpp/Section/1.%20Idea` })
  ok(appleRef.scope.kind === 'anchor' && appleRef.scope.label === '1. Idea' && appleRef.content.startsWith('## 1. Idea'), 'Dash apple_ref anchor before a heading selects that heading\'s section')
})

test('tools (fake Dash)', async () => {
  const calls = []
  const fakeDash = {
    async listDocsets() { calls.push('list'); return docsetsJson },
    async search(request) { calls.push(['search', request]); return { results: searchJson.results.filter(r => Object.keys(r).length > 0), message: undefined } },
    async fetchPage(url) {
      calls.push(['page', url])
      if (url.includes('yhhfldsx')) return { html: pytorchHtml, contentType: 'text/html', finalUrl: url }
      if (url.includes('iudzkden')) return { html: nlabHtml, contentType: 'text/html', finalUrl: url }
      throw new DashError('nope', { status: 404 })
    },
  }
  const tools = createTools({ dash: fakeDash, limits: { maxChars: 5000, defaultMaxResults: 20, docsetCacheMs: 60_000 } })
  const defs = Object.fromEntries(tools.map(t => [t.name, t]))
  ok(Object.keys(defs).join(',') === 'dash_list_docsets,dash_search,dash_get_page', 'three tools')
  const exec = { signal: new AbortController().signal }
  // Tool values must be lossless JSON: no `undefined` anywhere (DSH rejects the result otherwise).
  const assertLossless = (value, path = 'value') => {
    if (value === undefined) throw new Error(`${path} is undefined`)
    if (Array.isArray(value)) value.forEach((v, i) => assertLossless(v, `${path}[${i}]`))
    else if (value !== null && typeof value === 'object') for (const [k, v] of Object.entries(value)) assertLossless(v, `${path}.${k}`)
  }
  const run = async (name, args) => { const value = await defs[name].execute(args, exec); assertLossless(value); return { value, text: defs[name].output.render(args, value).map(b => b.text).join('\n') } }

  const list = await run('dash_list_docsets', {})
  ok(list.value.total === 51 && list.text.startsWith('51 installed docsets') && /^pytorch\s+PyTorch 2\.11\.0$/m.test(list.text), 'list renders key + name')
  const filtered = await run('dash_list_docsets', { filter: 'torch' })
  ok(filtered.value.docsets.length === 1 && /1 of 51 installed docsets match "torch"/.test(filtered.text), 'list filter')
  await assert.rejects(run('dash_list_docsets', { details: true }), /details: true covers at most 20 docsets; 51 match/)
  // Details on a docset whose bundle is not on disk: every field present (null), page probe learns the prefix from the fake search.
  fakeDash.listDocsets = async () => [{ name: 'Ghost 1.2', identifier: 'ghostxyz', platform: 'ghost', path: '/nonexistent/Ghost.docset', full_text_search: 'disabled' }]
  const detailed = await run('dash_list_docsets', { filter: 'ghost', details: true })
  const ghost = detailed.value.docsets[0]
  ok(ghost.version === '1.2' && ghost.types === null && ghost.entries === null && ghost.indexUrl === null && ghost.site === null && ghost.path === '/nonexistent/Ghost.docset' && ghost.documentsPath === null && ghost.indexFile === null && ghost.packed === false, 'details fields are null-safe when the bundle is missing')
  ok(/^ghost {2}Ghost 1\.2 {2}\(full-text search: disabled\)\n {2}entries: docset index not readable$/m.test(detailed.text), 'details rendering')
  fakeDash.listDocsets = async () => docsetsJson
  await run('dash_list_docsets', {}) // refill the cache with the real fixture list for the tests below

  const search = await run('dash_search', { query: 'view', docsets: ['torch', 'numpy'], maxResults: 3 })
  const req = calls.find(c => c[0] === 'search' && c[1].query === 'view')[1]
  ok(req.identifiers.join(',') === 'shofitzl,srwugqtb' && req.maxResults === 30 && req.snippets === false, 'search resolves docsets to identifiers and over-fetches')
  ok(search.value.results.length === 3 && search.value.truncated === true && search.value.matched > 3, 'maxResults applied after grouping')
  const first = search.value.results[0]
  ok(first.type === 'Method' && first.alsoTypes.join(',') === 'Guide,Section' && first.url.endsWith('#torch.Tensor.view'), 'Method/Guide/Section rows of one page collapse into the symbol row')
  ok(/^3 of \d+ results for "view" in pytorch, numpy:\n1\. PyTorch · Method \(also Guide, Section\) · view — torch\.Tensor\n   http/.test(search.text), 'search rendering')

  const typed = await run('dash_search', { query: 'view', types: ['method'] })
  ok(typed.value.results.every(r => r.type === 'Method') && typed.value.allDocsets === true && /in all 51 docsets \(types: method\)/.test(typed.text), 'type filter, all docsets')
  await assert.rejects(run('dash_search', { query: '  ' }), /query must not be empty/)
  await assert.rejects(run('dash_search', { query: 'x', docsets: ['nope'] }), /No docset matched: "nope" matches no installed docset/)
  fakeDash.search = async () => ({ results: [{}], message: undefined })
  const none = await run('dash_search', { query: 'zzz', docsets: ['html'] })
  ok(none.value.results.length === 0 && /^No results for "zzz" in html\./.test(none.text), 'empty result rendering')

  const page = await run('dash_get_page', { url: `${PYTORCH_URL}#torch.Tensor.view` })
  ok(/^Title: torch\.Tensor\.view — PyTorch 2\.11 documentation\nURL: .*\nScope: anchor #torch\.Tensor\.view — 4,342 of [\d,]+ chars of page text; section: "page" for the whole page, "outline" for its headings\.\nNOTE: content truncated[^\n]*\n\n\*\*`Tensor\.view/.test(page.text), 'page rendering header')
  ok(page.value.truncated === true && page.value.fullTextPath.endsWith('.md') && page.value.content.length === 5000 && /NOTE: content truncated to 5,000 of/.test(page.text), 'truncation with spill file')
  ok(page.value.fullTextPath.startsWith(join(tmpdir(), SCRATCH_PREFIX)) && readFileSync(page.value.fullTextPath, 'utf8').length === page.value.totalChars, 'the full text is written before the result returns')
  rmSync(page.value.fullTextPath, { force: true })
  const small = await run('dash_get_page', { url: `${PYTORCH_URL}#torch.Tensor.view`, maxChars: 100_000 })
  ok(small.value.truncated === undefined, 'no truncation when under the limit')
  const outline = await run('dash_get_page', { url: NLAB_URL, section: 'outline' })
  ok(outline.value.outline.length > 10 && /## 1\. Idea {2}→ section: "#loc-1"/.test(outline.text) && /^Outline of 9,982 chars/m.test(outline.text), 'outline rendering')
  await assert.rejects(run('dash_get_page', { url: NLAB_URL, section: 'no such heading' }), /section "no such heading" not found on adjoint functor\. Available headings:\n# adjoint functor/)
  await assert.rejects(run('dash_get_page', { url: 'http://127.0.0.1:53653/Dash/other/x.html' }), /nope/)

  // defineTool compiled the DSL into JSON Schema; arrays must declare items.
  for (const tool of tools) {
    ok(tool.parameters.type === 'object' && typeof tool.description === 'string' && tool.description.length > 40, `${tool.name}: schema + description`)
    for (const [name, spec] of Object.entries(tool.parameters.properties ?? {})) {
      if (spec.type === 'array') ok(spec.items?.type === 'string', `${tool.name}.${name}: array declares items`)
    }
  }
  ok(defs.dash_search.parameters.required?.join(',') === 'query' && defs.dash_get_page.parameters.required?.join(',') === 'url', 'required parameters')
})

