// Live test against the running Dash: the three tools' executes and renderers
// end to end. Read-only: it neither launches Dash nor turns its API server on,
// so Dash must be running with Settings ▸ Integration ▸ API Server enabled.
// The scratch files of truncated pages are removed at the end.
//   node scripts/live-test.mjs [query] [docset]
import { readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build, Config } from '../index.js'
import { SCRATCH_PREFIX } from '../tools.mjs'

const before = new Set(readdirSync(tmpdir()).filter(file => file.startsWith(SCRATCH_PREFIX)))
process.on('exit', () => {
  for (const file of readdirSync(tmpdir())) if (file.startsWith(SCRATCH_PREFIX) && !before.has(file)) rmSync(join(tmpdir(), file), { force: true })
})

const config = Config({ autoLaunch: false, autoEnableApi: false })
const { tools } = build(config, { logger: console, trace: () => {} })
const defs = Object.fromEntries(tools.map(tool => [tool.name, tool]))
const exec = { signal: new AbortController().signal }
const run = async (name, args = {}) => {
  const t = Date.now()
  const value = await defs[name].execute(args, exec)
  const text = defs[name].output.render(args, value).map(block => block.text).join('\n')
  console.log(`\n=== ${name} ${JSON.stringify(args)} (${Date.now() - t} ms, ${text.length} chars)`)
  return { value, text }
}
const show = (text, n = 1200) => console.log(text.length > n ? `${text.slice(0, n)}\n…` : text)

const list = await run('dash_list_docsets', {})
show(list.text, 600)
const filtered = await run('dash_list_docsets', { filter: 'py' })
console.log(filtered.value.docsets.map(d => d.key).join(', '))
const detailed = await run('dash_list_docsets', { filter: 'torch', details: true })
show(detailed.text, 600)

const query = process.argv[2] ?? 'Tensor.view'
const docset = process.argv[3] ?? 'torch'
const search = await run('dash_search', { query, docsets: [docset], maxResults: 5 })
show(search.text)
const all = await run('dash_search', { query: 'argsort', maxResults: 8 })
show(all.text)
const typed = await run('dash_search', { query: 'view', docsets: ['pytorch', 'numpy'], types: ['Method'], maxResults: 5 })
show(typed.text)
const nothing = await run('dash_search', { query: 'zqxjkvbnm', docsets: ['html'] })
show(nothing.text)
try {
  await run('dash_search', { query: 'x', docsets: ['nope'] })
} catch (error) {
  console.log('expected error:', error.message)
}

const first = search.value.results[0]
if (first) {
  const page = await run('dash_get_page', { url: first.url })
  show(page.text, 1500)
  const outline = await run('dash_get_page', { url: first.url, section: 'outline' })
  show(outline.text, 800)
  const whole = await run('dash_get_page', { url: first.url, section: 'page', maxChars: 2000 })
  show(whole.text, 700)
}

const nlab = await run('dash_search', { query: 'adjoint functor', docsets: ['nlab'], maxResults: 2 })
show(nlab.text, 400)
if (nlab.value.results[0]) {
  const outline = await run('dash_get_page', { url: nlab.value.results[0].url, section: 'outline' })
  show(outline.text, 900)
  const section = await run('dash_get_page', { url: nlab.value.results[0].url, section: 'Definition' })
  show(section.text, 1200)
  const big = await run('dash_get_page', { url: nlab.value.results[0].url, section: 'page', maxChars: 1000 })
  show(big.text, 400)
}

const html = await run('dash_search', { query: 'dialog', docsets: ['html'], maxResults: 3 })
show(html.text, 500)
if (html.value.results[0]) {
  const page = await run('dash_get_page', { url: html.value.results[0].url, maxChars: 3000 })
  show(page.text, 1500)
}

try {
  await run('dash_get_page', { url: 'https://example.com/' })
} catch (error) {
  console.log('expected error:', error.message)
}
try {
  await run('dash_get_page', { url: first?.url ?? 'http://127.0.0.1:1/x', section: '#does-not-exist' })
} catch (error) {
  console.log('expected error:', error.message.slice(0, 400))
}
