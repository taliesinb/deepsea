// LIVE, headless Chrome only (no visible window): the chrome_* tools through the plugin's real tool
// executes, against tests/fixtures/read-page.html served on a free loopback port.
//
//   node scripts/live-chrome.mjs
//
// Checks waits (selector / text / expression / timeout) on wait_for, evaluate, navigate (+ then) and
// screenshots; click / fill by selector and text; the most-recently-used default; a window reopened under
// its id after chrome-devtools-mcp is killed; page reads (temporary page and window: expand, scope,
// section, selectors, structure, the window restored); a refused URL; snapshot and interact; and that
// unloading leaves no process and no scratch directory. Every Chrome runs with a throwaway profile in a
// scratch directory under $TMPDIR/deepsea-browser-live-…, removed at the end.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as plugin from '../index.js'
import { fakeAgent, fakeCtx } from '../tests/fake-host.mjs'
import { assertLossless } from '../tests/lossless.mjs'

const PAGE = readFileSync(new URL('../tests/fixtures/read-page.html', import.meta.url), 'utf8')
const server = createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(PAGE)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const URL_ = `http://127.0.0.1:${server.address().port}/guide`

const scratch = await mkdtemp(join(tmpdir(), 'deepsea-browser-live-'))
const ctx = fakeCtx()
const traced = []
plugin.apply(ctx, plugin.Config({ safari: { enabled: false }, chrome: { headless: true }, idleMinutes: 0 }), { trace: (event) => traced.push(event), scratch })
const agent = fakeAgent('session-live-chrome', { cwd: scratch })
ctx.emit('agent/created', { agent })
const exec = { agent, signal: new AbortController().signal }
const run = async (name, args = {}) => assertLossless(name, await agent.registered.get(name).execute(args, exec))
const render = (name, value) => agent.registered.get(name).output.render({}, value)[0].text
const children = () => { try { return execFileSync('pgrep', ['-P', String(process.pid)], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(Number) } catch { return [] } }
const ours = () => { try { return execFileSync('pgrep', ['-f', scratch], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(Number) } catch { return [] } }
let failures = 0
const check = (label, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`); if (!ok) failures++ }
const since = (start) => `${Date.now() - start} ms`
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

try {
  // 1. Waits.
  const opened = await run('chrome_open', { url: URL_ })
  const w0 = opened.windowId
  check('chrome_open', w0 === 'c:0:0', w0)
  check('a throwaway profile in the scratch directory', readdirSync(scratch).some(name => name.startsWith('deepsea-browser-profile-')), readdirSync(scratch).join(', '))
  let t0 = Date.now()
  let r = await run('chrome_wait_for', { selector: '#ready', timeout: 10_000, windowId: w0 })
  check('wait_for selector resolves once the element appears', /selector "#ready" matched 1 element/.test(r) && Date.now() - t0 >= 700, `${since(t0)}: ${r.split('\n')[1]}`)
  r = await run('chrome_wait_for', { text: ['nope', 'done'], windowId: w0 })
  check('wait_for text (any of) names the one that matched', /text "done" appeared/.test(r), r.split('\n')[1])
  r = await run('chrome_wait_for', { expression: 'return document.querySelectorAll("h2").length', windowId: w0 })
  check('wait_for expression returns its truthy value', /expression returned 3/.test(r) && /\n3$/.test(r), r.split('\n').slice(1).join(' | '))
  t0 = Date.now()
  r = await run('chrome_wait_for', { text: ['never-there'], timeout: 1500, windowId: w0 })
  check('a timeout is a notice, not an error', /wait timed out after 1\.5s for text "never-there"/.test(r) && Date.now() - t0 >= 1400 && Date.now() - t0 < 5000, `${since(t0)}: ${r.split('\n')[1]}`)
  r = await run('chrome_navigate', { url: URL_, wait: { selector: '#ready' }, then: 'return document.getElementById("status").textContent', windowId: w0 })
  check('navigate + wait + then in one call', /selector "#ready" matched/.test(r) && /then → "?done"?$/.test(r.trim()), r.split('\n').slice(1).join(' | '))
  await run('chrome_navigate', { url: URL_, windowId: w0 })
  r = await run('chrome_evaluate_expression', { expression: 'return document.getElementById("status").textContent', wait: { text: ['done'] }, windowId: w0 })
  check('evaluate waits for text first', /waited [\d.]+s: text "done" appeared\. /.test(r) && /"done"/.test(r), r.split('\n').slice(0, 2).join(' | '))
  r = await run('chrome_evaluate_expression', { expression: 'return 1', wait: { settleMs: 300 }, windowId: w0 })
  check('evaluate with a settle only', /settled 300 ms\. /.test(r), r.split('\n')[1])
  const shot = await run('chrome_get_screenshot', { format: 'jpeg', quality: 40, wait: { selector: '#ready' }, windowId: w0 })
  check('a screenshot waits and says so', (shot.notes ?? []).some(n => /selector "#ready" matched/.test(n)), render('chrome_get_screenshot', shot))
  check('without an attachment store the capture is a scratch file', typeof shot.fallbackPath === 'string' && shot.fallbackPath.startsWith(join(scratch, 'deepsea-browser-chrome-screenshot-')) && existsSync(shot.fallbackPath), shot.fallbackPath)
  const saved = await run('chrome_save_screenshot', { path: 'shots/guide.png', windowId: w0 })
  check('save_screenshot writes relative to the working directory', saved.path === join(scratch, 'shots/guide.png') && existsSync(saved.path), saved.path)

  // 2. Targets without a snapshot.
  r = await run('chrome_click', { selector: '#btn', windowId: w0 })
  check('click by selector', /"clicked":"button#btn/.test(r), r.split('\n')[1])
  r = await run('chrome_click', { text: 'clicked 1', windowId: w0 })
  check('click by text', /"clicked":"button#btn/.test(r), r.split('\n')[1])
  const n = await run('chrome_evaluate_expression', { expression: 'return window.clicks', windowId: w0 })
  check('both clicks ran the handler', /```(?:json)?\n2\n```/.test(n), n.split('\n').slice(-3).join(' | '))
  r = await run('chrome_fill', { selector: '#name', value: 'hello', windowId: w0 })
  check('fill by selector dispatches input', /"filled":"input#name/.test(r) && /"value":"hello"/.test(r), r.split('\n')[1])
  const echo = await run('chrome_evaluate_expression', { expression: 'return document.getElementById("echo").textContent', windowId: w0 })
  check('the input handler saw the value', /hello/.test(echo), echo.split('\n')[1])
  let bad = ''
  try { await run('chrome_click', { selector: '#nope', windowId: w0 }) } catch (error) { bad = error.message }
  check('a missing selector fails clearly', /no element matches selector "#nope"/.test(bad), bad.split('\n')[0])
  try { await run('chrome_click', { windowId: w0 }) } catch (error) { bad = error.message }
  check('no target fails clearly', /give uid .*selector .*or text/.test(bad), bad.split('\n')[0])
  const snapshot = await run('chrome_snapshot', { windowId: w0 })
  check('chrome_snapshot lists elements with uids', /uid=\d+_\d+/.test(snapshot) && snapshot.includes('Fixture guide'), `${snapshot.length} chars`)
  const batch = await run('chrome_interact', { windowId: w0, interactions: [
    { type: 'scroll', purpose: 'scroll down', scrollDelta: { x: 0, y: 300 } },
    { type: 'click', purpose: 'press the button', text: 'clicked 2' },
    { type: 'selectText', purpose: 'unsupported on purpose', text: 'x' },
    { type: 'keyPress', purpose: 'press Escape', value: 'Escape' },
  ] })
  check('chrome_interact reports every step', /#1 scroll.*ok/.test(batch) && /#2 click.*ok/.test(batch) && /#3 selectText.*FAILED/.test(batch) && /#4 keyPress.*ok/.test(batch), batch.split('\n').slice(1).join(' | '))

  // 3. Two windows: the most recently used one is the default.
  const w1 = (await run('chrome_open', { url: URL_ })).windowId
  r = await run('chrome_evaluate_expression', { expression: 'return location.href' })
  check('two windows: the new one is used and the other named', r.includes(`used ${w1}, the most recently used`) && r.includes(`pass windowId for ${w0}`) && r.includes(`[${w1}]`), r.split('\n')[0])
  await run('chrome_evaluate_expression', { expression: 'return 1', windowId: w0 })
  r = await run('chrome_evaluate_expression', { expression: 'return 1' })
  check('the default follows the last explicit use', r.includes(`used ${w0}`) && r.includes(`[${w0}]`), r.split('\n')[0])
  check('chrome_close one', (await run('chrome_close', { windowId: w1 })) === `Closed ${w1}.`)

  // 4. chrome-devtools-mcp dies underneath the plugin: the window comes back under its id.
  const kill = () => { const pids = children(); for (const pid of pids) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } } return pids.length }
  const killed = kill()
  await sleep(800)
  t0 = Date.now()
  r = await run('chrome_evaluate_expression', { expression: 'return location.href + " clicks=" + window.clicks', windowId: w0 })
  check('a lost window is reopened under its id at its last URL', r.startsWith(`Chrome had restarted; reopened ${w0} at ${URL_}`) && /clicks=0/.test(r), `${killed} killed; ${since(t0)}: ${r.split('\n')[0]}`)
  r = await run('chrome_evaluate_expression', { expression: 'return 2', windowId: w0 })
  check('the note is given once', !r.includes('reopened'), r.split('\n')[0])
  kill()
  await sleep(800)
  r = await run('chrome_evaluate_expression', { expression: 'return document.title' })
  check('without a windowId after a crash the last window comes back', r.startsWith(`Chrome had restarted; reopened ${w0}`) && /Fixture guide/.test(r), r.split('\n')[0])

  // 5. Page reads on a temporary page.
  const read = await run('chrome_get_page_content', { url: URL_ })
  check('a url read uses a temporary page', read.mode === 'isolated' && read.browser === 'chrome', `${read.content.length} chars`)
  check('collapsed details included (expand)', read.content.includes('Run the bridge helper') && read.content.includes('downloads the runtime'))
  check('the accordion body included', read.content.includes('Pass the scope flag'))
  check('hidden tab panels appended', /## Hidden tab panels/.test(read.content) && read.content.includes('Edit the configuration file of the terminal client'), JSON.stringify(read.expanded))
  check('auto scope picked main; sidebar and footer left out', /^main/.test(read.scope?.scope ?? '') && !read.content.includes('Sidebar only link') && !read.content.includes('Footer text'), read.scope?.scope)
  check('headings, code fence, inline code, links, list, table', /^# Fixture guide$/m.test(read.content) && /^## Troubleshooting$/m.test(read.content) && /```json\n\{ "servers"/.test(read.content) && read.content.includes('`inline code`') && read.content.includes('[documentation link](https://example.com/docs)') && /^1\. Add the server/m.test(read.content) && /\| Question \| Answer \|/.test(read.content))
  console.log(`\n${render('chrome_get_page_content', read).split('\n').slice(0, 5).join('\n')}\n  …\n`)
  const flat = await run('chrome_get_page_content', { url: URL_, expand: false, scope: 'page' })
  check('expand: false leaves collapsed text out and says so', !flat.content.includes('Run the bridge helper') && flat.notes.some(note => /collapsed <details>/.test(note) && /tab group/.test(note)), JSON.stringify(flat.notes))
  check('scope: page keeps the sidebar', flat.content.includes('Sidebar only link'))
  const section = await run('chrome_get_page_content', { url: URL_, section: '#troubleshooting' })
  check('a section runs to the next heading of its level', section.content.trimStart().startsWith('## Troubleshooting') && section.content.includes('Known issues') && !section.content.includes('Interactive authorization'), `${section.content.length} chars`)
  const wrapped = await run('chrome_get_page_content', { url: URL_, section: '#known-issues' })
  check('a heading in a decorated wrapper keeps its section', wrapped.content.includes('cache the server list') && !wrapped.content.includes('FAQ'), JSON.stringify(wrapped.content.slice(0, 80)))
  const picked = await run('chrome_get_page_content', { url: URL_, selectors: ['#page-title', '#faq'], format: 'plainText' })
  check('selectors with plainText', picked.content.includes('Fixture guide') && picked.content.includes('FAQ') && !picked.content.includes('Install'), JSON.stringify(picked.content.slice(0, 60)))
  bad = ''
  try { await run('chrome_get_page_content', { url: URL_, selectors: ['#does-not-exist'] }) } catch (error) { bad = error.message }
  check('an unknown selector fails clearly', /no element matches/.test(bad), bad.split('\n')[0])
  const structure = await run('chrome_get_page_structure', { url: URL_ })
  const s = structure.structure
  check('structure: headings with selectors, collapsed content', s.headings.some(h => h.selector === '#troubleshooting' && h.level === 2) && s.collapsed.details === 2 && s.collapsed.tablists.length === 1)
  check('the outline names the chrome tool', render('chrome_get_page_structure', structure).includes('Next: chrome_get_page_content'))

  // 6. Window mode: hide and restore.
  const win = await run('chrome_get_page_content', { windowId: w0, section: '#faq', expand: true })
  check('a section read in the window', win.mode === 'window' && win.content.includes('Interactive authorization') && !win.content.includes('Fixture guide'), `${win.content.length} chars`)
  const leftovers = await run('chrome_evaluate_expression', { windowId: w0, expression: 'return document.querySelectorAll("[data-deepsea-browser-hidden]").length' })
  check('the window is restored after a scoped read', /\n0\n```$/.test(leftovers.trim()), leftovers.split('\n').slice(-2).join(' '))
  const plain = await run('chrome_get_page_content', { windowId: w0 })
  check('a window read does not expand; the probe finds the tab group', plain.collapsed?.tabGroups === 1, JSON.stringify(plain.collapsed))

  // 7. A refused URL: an error, no window, no orphan error page.
  const closedPort = await new Promise((resolve) => { const probe = createServer(); probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)) }) })
  const refusedUrl = `http://127.0.0.1:${closedPort}/nothing`
  let refused = ''
  try { await run('chrome_open', { url: refusedUrl }) } catch (error) { refused = error.message }
  check('a refused URL fails clearly', refused.includes(`could not open ${refusedUrl}: `) && /ERR_CONNECTION_REFUSED.*No window was opened/s.test(refused), refused.split('\n')[0])
  check('no window registered by the failed open', (await run('chrome_close')) === `Closed ${w0}.`)
} catch (error) {
  failures++
  console.error('FAIL (exception)', error)
} finally {
  await ctx.dispose()
  server.close()
}
await sleep(1500)
check('unloading leaves no chrome-devtools-mcp and no Chrome', children().length === 0 && ours().length === 0, `children=${children()} ours=${ours()}`)
check('the instances\' scratch directories are removed', !readdirSync(scratch).some(name => name.startsWith('deepsea-browser-profile-')), readdirSync(scratch).join(', '))
check('the trace saw the instance lost and reopened', traced.some(e => e.event === 'chrome-instance-lost') && traced.some(e => e.event === 'chrome-reopen'))
for (const pid of ours()) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
await rm(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
