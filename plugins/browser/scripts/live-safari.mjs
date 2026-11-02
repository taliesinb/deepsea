// LIVE, Safari Technology Preview: opens real STP windows on this Mac (they park at the right edge of the
// screen) and an isolated reader window. Run it in a session where the person expects windows.
//
//   node scripts/live-safari.mjs [--youtube <url>] [--keep-helper-default]
//
// The safari_* tools through the plugin's real tool executes, against tests/fixtures/read-page.html on a
// free loopback port: two windows (independent pages, the most-recently-used default), evaluate and
// evaluate_function, click by text and by selector, type, waits, window reads (format, section, the page
// restored), isolated reads (expand, scope, webkitMarkdown, structure, prepare), element and viewport
// screenshots, save, auto-open, close; with --youtube, the show notes of a video (needs the network).
// Afterwards no safaridriver of this process is left, and STP is quit if this run launched it. The
// hidden-window remedy is `park`, so a parked window shows the window helper at work; without the helper
// installed the results carry a NOTE instead.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as plugin from '../index.js'
import { fakeAgent, fakeCtx } from '../tests/fake-host.mjs'
import { assertLossless } from '../tests/lossless.mjs'

const argOf = (name) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined
const PAGE = readFileSync(new URL('../tests/fixtures/read-page.html', import.meta.url), 'utf8')
const server = createServer((req, res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.setHeader('cache-control', 'no-store'); res.end(PAGE) })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const URL_ = `http://127.0.0.1:${server.address().port}/guide`

const scratch = await mkdtemp(join(tmpdir(), 'deepsea-browser-live-'))
const ctx = fakeCtx()
const traced = []
plugin.apply(ctx, plugin.Config({ chrome: { enabled: false }, idleMinutes: 0, safari: { reader: { idleMinutes: 0 } } }), { trace: (event) => traced.push(event), scratch })
const agent = fakeAgent('session-live-safari', { cwd: scratch })
ctx.emit('agent/created', { agent })
const exec = { agent, signal: new AbortController().signal }
const run = async (name, args = {}) => assertLossless(name, await agent.registered.get(name).execute(args, exec))
const render = (name, value) => agent.registered.get(name).output.render({}, value)[0].text
const drivers = () => { try { return execFileSync('pgrep', ['-P', String(process.pid), '-f', 'safaridriver'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).length } catch { return 0 } }
let failures = 0
const check = (label, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${String(detail).split('\n')[0].slice(0, 160)}` : ''}`); if (!ok) failures++ }

try {
  // Windows.
  const s0 = await run('safari_open', { url: URL_ })
  const s1 = await run('safari_open', { url: `${URL_}?second` })
  check('two windows', s0.windowId === 's:0:0' && s1.windowId === 's:0:1' && s0.title === 'Fixture guide', `${s0.windowId} ${s1.windowId}`)
  await run('safari_evaluate_expression', { expression: 'window.marker = "first"; return 1', windowId: 's:0:0' })
  const other = await run('safari_evaluate_expression', { expression: 'return String(window.marker)', windowId: 's:0:1' })
  check('windows are independent', other.includes('undefined'), other)
  const mru = await run('safari_evaluate_expression', { expression: 'return location.search' })
  check('no windowId: the most recently used window, the other named', mru.includes('used s:0:1') && mru.includes('pass windowId for s:0:0'), mru)
  const fn = await run('safari_evaluate_function', { function: '() => document.querySelector("h1").textContent', windowId: 's:0:0' })
  check('safari_evaluate_function', fn.includes('Fixture guide'), fn.split('\n').at(-1))
  const waited = await run('safari_wait_for', { selector: '#ready', timeout: 10_000, windowId: 's:0:0' })
  check('safari_wait_for selector', /selector "#ready" matched 1 element/.test(waited), waited.split('\n').at(-1))
  const timedOut = await run('safari_wait_for', { text: ['zzz-not-there'], timeout: 1500, windowId: 's:0:0' })
  check('safari_wait_for timeout is a notice', /wait timed out after 1\.5s/.test(timedOut), timedOut.split('\n').at(-1))
  const clicked = await run('safari_click', { selector: '#btn', windowId: 's:0:0' })
  const typed = await run('safari_type_text', { selector: '#name', text: 'hello', windowId: 's:0:0' })
  const state = await run('safari_evaluate_expression', { expression: 'return [window.clicks, document.getElementById("echo").textContent].join(" ")', windowId: 's:0:0' })
  check('click and type by selector', state.includes('1 hello'), `${clicked.split('\n')[0]} | ${typed.split('\n')[0]} | ${state.split('\n').at(-1)}`)
  const byText = await run('safari_click', { text: 'clicked 1', windowId: 's:0:0' })
  check('click by text', !/error/i.test(byText), byText.split('\n')[0])

  // Window reads.
  const window = await run('safari_get_page_content', { windowId: 's:0:0', format: 'plainText' })
  check('window read', window.mode === 'window' && window.content.includes('Fixture guide'), `${window.content.length} chars`)
  const section = await run('safari_get_page_content', { windowId: 's:0:0', section: '#faq', expand: true })
  check('window section read', section.content.includes('Interactive authorization') && !section.content.includes('Install'), `${section.content.length} chars`)
  const left = await run('safari_evaluate_expression', { expression: 'return document.querySelectorAll("[data-deepsea-browser-hidden]").length', windowId: 's:0:0' })
  check('the window is restored after a scoped read', /\b0\s*$/.test(left.trim()), left.split('\n').at(-1))
  const tree = await run('safari_get_page_content', { windowId: 's:0:0', format: 'textTree' })
  check('textTree carries node UIDs', /uid=\d+/.test(tree.content), `${tree.content.length} chars`)

  // Isolated reads.
  const iso = await run('safari_get_page_content', { url: URL_ })
  check('isolated read: expand, scope main, markdown', iso.mode === 'isolated' && iso.content.includes('Run the bridge helper') && iso.content.includes('Pass the scope flag') && /## Hidden tab panels/.test(iso.content) && !iso.content.includes('Sidebar only link') && /```json/.test(iso.content), iso.scope?.scope)
  const wk = await run('safari_get_page_content', { url: URL_, format: 'webkitMarkdown' })
  check('webkitMarkdown with marked headings', /^## Troubleshooting$/m.test(wk.content), `${wk.content.length} chars`)
  const structure = await run('safari_get_page_structure', { url: URL_ })
  check('structure', structure.structure.headings.some(h => h.selector === '#troubleshooting') && structure.structure.collapsed.details === 2, render('safari_get_page_structure', structure).split('\n')[3])
  const prepared = await run('safari_get_page_content', { url: URL_, expand: false, scope: 'page', prepare: 'for (const d of document.querySelectorAll("details")) d.open = true; return document.querySelectorAll("details[open]").length' })
  check('prepare runs before extraction', prepared.prepareResult === 2 && prepared.content.includes('Run the bridge helper'), JSON.stringify(prepared.prepareResult))

  // Screenshots.
  const element = await run('safari_get_screenshot', { querySelector: 'h1', windowId: 's:0:0' })
  check('element screenshot (a scratch file without an attachment store)', element.querySelector === 'h1' && existsSync(element.fallbackPath ?? ''), render('safari_get_screenshot', element))
  const viewport = await run('safari_get_screenshot', { windowId: 's:0:1' })
  check('viewport screenshot', viewport.width > 0 && viewport.height > 0, `${viewport.width}×${viewport.height}`)
  const saved = await run('safari_save_screenshot', { windowId: 's:0:0', path: 'shots/safari.png' })
  check('safari_save_screenshot', saved.path === join(scratch, 'shots/safari.png') && existsSync(saved.path), saved.path)

  // Closing and auto-open.
  check('close one', (await run('safari_close', { windowId: 's:0:0' })) === 'Closed s:0:0.')
  const single = await run('safari_evaluate_expression', { expression: 'return location.search' })
  check('one window left: used without an id', single.startsWith('[s:0:1]'), single.split('\n')[0])
  check('close all', (await run('safari_close')) === 'Closed s:0:1.')
  const auto = await run('safari_navigate', { url: URL_ })
  check('a tool with no window opens one', auto.windowId === 's:0:2', auto.windowId)
  await run('safari_close')

  const youtube = argOf('--youtube')
  if (youtube) {
    const notes = await run('safari_get_youtube_notes', { url: youtube })
    check('YouTube show notes', typeof notes.title === 'string' && notes.description.length > 0, render('safari_get_youtube_notes', notes).split('\n').slice(0, 2).join(' | '))
  }
  check('parking ran (or said why not)', traced.some(e => e.event === 'safari-park' || e.event === 'safari-park-result' || e.event === 'safari-park-unmatched'), traced.filter(e => /park/.test(e.event)).map(e => e.event).join(', '))
} catch (error) {
  failures++
  console.error('FAIL (exception)', error)
} finally {
  await ctx.dispose()
  server.close()
}
// Give the closed drivers and the STP quit grace time to finish: exiting at once can leave an orphaned STP window.
await new Promise(resolve => setTimeout(resolve, 6000))
check('no safaridriver left', drivers() === 0, `${drivers()} left`)
await rm(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
