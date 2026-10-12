// The host half without browsers: configuration, chrome-devtools-mcp arguments and environment, the
// stderr filter, preflight messages, the two rows (the root's service, the tools row's registration), and
// the tools' result and failure shapes against scripted fake connections.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import * as plugin from '../index.js'
import * as toolsRow from '../tools-row.js'
import { createNotes, createTools, dialogOpenedBy, macEditingCommand, safariFunctionCall, safariTiming, stripUndefined } from '../tools.mjs'
import { extractPage, planRead, probeScript } from '../page-read.mjs'
import { CHROME_STDERR_NOISE, describeBlocks, isNoiseLine, readLines, savedFileOf, unwrapPageContent } from '../servers.mjs'
import { fakeAgent, fakeCtx, mountBoth } from './fake-host.mjs'
import { losslessReason } from './lossless.mjs'

const TOOL_NAMES = ['chrome_click', 'chrome_close', 'chrome_console_messages', 'chrome_evaluate_expression', 'chrome_evaluate_function', 'chrome_fill', 'chrome_fill_form', 'chrome_get_network_request', 'chrome_get_page_content', 'chrome_get_page_structure', 'chrome_get_screenshot', 'chrome_handle_dialog', 'chrome_hover', 'chrome_interact', 'chrome_navigate', 'chrome_network_requests', 'chrome_open', 'chrome_press_key', 'chrome_save_screenshot', 'chrome_set_viewport_size', 'chrome_snapshot', 'chrome_type_text', 'chrome_wait_for', 'safari_click', 'safari_close', 'safari_console_messages', 'safari_evaluate_expression', 'safari_evaluate_function', 'safari_get_network_request', 'safari_get_page_content', 'safari_get_page_structure', 'safari_get_screenshot', 'safari_get_youtube_notes', 'safari_handle_dialog', 'safari_hover', 'safari_interact', 'safari_navigate', 'safari_network_requests', 'safari_open', 'safari_press_key', 'safari_save_screenshot', 'safari_set_viewport_size', 'safari_type_text', 'safari_wait_for']

test('configuration defaults; the two rows', () => {
  const config = plugin.Config({ skipPresets: ['minimal'], subagents: false })
  assert.equal(plugin.name, 'deepsea-tool-browser')
  assert.equal(plugin.inject, undefined, 'the root requires no service')
  assert.equal(toolsRow.name, 'deepsea-tool-browser-tools')
  assert.deepEqual(toolsRow.inject, ['tools'], 'deepseaBrowser is read optionally: a required one would make the preset unusable')
  assert.equal(toolsRow.Config({}).subagents, true)
  assert.equal(config.skipPresets.length, 1, 'a stale key is kept by the schema, and nothing reads it')
  assert.equal(config.safari.enabled, true)
  assert.equal(config.safari.labelPrefix, 'DeepSea: ')
  assert.equal(config.safari.hiddenWindows, 'park')
  assert.equal(config.safari.park.helper, '~/Library/Application Support/io.github.taliesinb.deepsea/DeepSea Window Helper.app')
  assert.equal(config.safari.reader.maxIdle, 1)
  assert.equal(config.chrome.headless, false)
  assert.equal(config.chrome.quietStderr, true)
  assert.equal(config.idleMinutes, 30)
  assert.equal(config.trace, false)
})

test('chrome-devtools-mcp: the pinned version, run by this node, with a throwaway profile', () => {
  const pinned = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).dependencies['chrome-devtools-mcp']
  assert.match(pinned, /^\d+\.\d+\.\d+$/, 'pinned exactly')
  const server = plugin.chromeServer(plugin.Config({}))
  assert.equal(server.command, process.execPath)
  assert.equal(server.missing, undefined)
  assert.equal(server.describe, `chrome-devtools-mcp ${pinned}`)
  assert.ok(server.args[0].endsWith('/build/src/bin/chrome-devtools-mcp.js') && existsSync(server.args[0]))
  const args = plugin.chromeArgs(plugin.Config({ chrome: { headless: true } }), '/scratch/profile')
  assert.equal(args[0], server.args[0])
  for (const flag of ['--userDataDir=/scratch/profile', '--headless', '--no-usage-statistics', '--no-performance-crux', '--ignoreDefaultChromeArg=--enable-automation']) assert.ok(args.includes(flag), flag)
  assert.ok(!args.includes('--isolated'), '--isolated conflicts with --userDataDir')
  assert.ok(!plugin.chromeArgs(plugin.Config({}), '/p').includes('--headless'))
  const explicit = plugin.chromeServer(plugin.Config({ chrome: { command: process.execPath } }))
  assert.deepEqual([explicit.command, explicit.args, explicit.missing], [process.execPath, [], undefined])
  const env = plugin.chromeEnv('/scratch')
  assert.deepEqual(env, { TMPDIR: tmpdir(), CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1', NODE_OPTIONS: '--localstorage-file=/scratch/localstorage.json' })
})

test('stderr filter: exactly the launch boilerplate, nothing else', async () => {
  const boilerplate = `(node:23256) ExperimentalWarning: localStorage is not available because --localstorage-file was not provided.
(Use \`node --trace-warnings ...\` to show where the warning was created)

Update available: 1.8.0 -> 1.9.0
Run \`npm install chrome-devtools-mcp@latest\` to update.

chrome-devtools-mcp exposes content of the browser instance to the MCP clients allowing them to inspect,
debug, and modify any data in the browser or DevTools.
Avoid sharing sensitive or personal information that you do not want to share with MCP clients.
Performance tools may send trace URLs to the Google CrUX API to fetch real-user experience data. To disable, run with --no-performance-crux.

Google collects usage statistics to improve Chrome DevTools MCP. To opt-out, run with --no-usage-statistics.
For more details, visit: https://github.com/ChromeDevTools/chrome-devtools-mcp#usage-statistics
[chrome-devtools-mcp] The connecting client did not negotiate the MCP roots capability. File-writing tools will be restricted to the OS temp directory. To restore the previous unrestricted behavior, start the server with --allow-unrestricted-paths.`
  for (const line of boilerplate.split('\n')) assert.ok(isNoiseLine(line, CHROME_STDERR_NOISE), line)
  for (const line of ['Error: Failed to launch the browser process!', '[MCP Context] Error resolving real path for /x: EACCES', 'Update your Chrome to continue']) assert.ok(!isNoiseLine(line, CHROME_STDERR_NOISE), line)
  const stream = new PassThrough(); const lines = []
  readLines(stream, (line) => lines.push(line))
  stream.write('ab'); stream.write('c\nde\r\n'); stream.end('tail')
  await new Promise(resolve => stream.on('end', () => setImmediate(resolve)))
  assert.deepEqual(lines, ['abc', 'de', 'tail'])
})

test('preflight names what is missing and the remedy', () => {
  const preflight = plugin.preflightFor(plugin.Config({ safari: { driver: '/nonexistent/safaridriver' }, chrome: { command: '/nonexistent/cdm' } }))
  assert.throws(() => preflight('safari'), /unavailable.*Classic Safari cannot be used/s)
  assert.throws(() => preflight('chrome'), /unavailable: no chrome-devtools-mcp at "\/nonexistent\/cdm"/)
  const disabled = plugin.preflightFor(plugin.Config({ safari: { enabled: false } }))
  assert.throws(() => disabled('safari'), /disabled on this server \(safari\.enabled: false\)/)
})

test('root row: windows, routes and the deepseaBrowser service; no tools of its own', async () => {
  const routes = []
  const services = { connection: { fetch: { register: (route) => { routes.push(route.path); return () => {} } } } }
  const host = fakeCtx({ services })
  plugin.apply(host, plugin.Config({}), { trace: () => {} })
  assert.deepEqual(host.injected, [['attachments', 'llm'], ['connection']])
  assert.deepEqual(routes, ['/api/deepsea-browser/app-window', '/api/deepsea-browser/app-command'])
  assert.equal(host.registered.size, 0, 'the tools are the tools row\'s')
  const service = host.provided[plugin.SERVICE]
  assert.equal(plugin.SERVICE, 'deepseaBrowser')
  assert.deepEqual(service.enabled, { safari: true, chrome: true })
  assert.ok(service.deps.clipboards instanceof WeakMap, 'one clipboard map per process')
  assert.deepEqual(service.deps.state, { chromeEverOpened: false })
  // A disposed agent's windows are closed by the root.
  const forgotten = []
  service.deps.sessions.forget = async (agent, reason) => { forgotten.push([agent.id, reason]) }
  host.emit('agent/disposed', { agent: fakeAgent('gone') })
  assert.deepEqual(forgotten, [['gone', 'agent-disposed']])
  await host.dispose()
})

test('tools row: registers once per mount, every call finds its caller through exec.agent', async () => {
  const rows = mountBoth({}, { trace: () => {} })
  assert.deepEqual(rows.preset.injected, [['deepseaBrowser']])
  assert.deepEqual([...rows.preset.registered.keys()].sort(), TOOL_NAMES)
  for (const { options } of rows.preset.registered.values()) assert.equal(options.when, undefined, 'subagents: true needs no condition')
  const shot = rows.tool('safari_get_screenshot')
  assert.equal(typeof shot.finalizeContent, 'function')
  assert.ok(shot.parameters.properties.querySelector)
  // One registration serves every agent of the preset: the caller comes from the execution.
  const seen = []
  rows.host.provided.deepseaBrowser.deps.sessions.closeChrome = async (agent) => { seen.push(agent.id); return [] }
  const signal = new AbortController().signal
  for (const id of ['one', 'two']) assert.equal(await rows.tool('chrome_close').execute({}, { agent: fakeAgent(id), signal }), 'No Chrome window was open.')
  assert.deepEqual(seen, ['one', 'two'])
  await assert.rejects(rows.tool('chrome_close').execute({}, { signal }), /needs a calling agent/)
  // A second preset mounts the row again over the same service: the same sessions and per-process state.
  const second = fakeCtx({ services: { ...rows.host.provided } })
  toolsRow.apply(second, toolsRow.Config({}))
  assert.equal(second.registered.size, TOOL_NAMES.length)
  await second.dispose()
  assert.equal(rows.preset.registered.size, TOOL_NAMES.length, 'unmounting one preset leaves the other')
  await rows.dispose()
  assert.equal(rows.preset.registered.size, 0, 'unload removes every registration')
})

test('tools row: subagents: false is a condition on the delegation depth', async () => {
  const rows = mountBoth({}, { trace: () => {} }, { tools: { subagents: false } })
  const { when } = rows.preset.registered.get('chrome_open').options
  assert.equal(typeof when, 'function')
  assert.equal(when({ agent: fakeAgent('top') }), true)
  assert.equal(when({ agent: fakeAgent('child', { depth: 1 }) }), false)
  await rows.dispose()
})

test('tools row: no root row (or no browser enabled), no tools; the preset still mounts', async () => {
  const preset = fakeCtx()
  toolsRow.apply(preset, toolsRow.Config({}))
  assert.deepEqual(preset.injected, [['deepseaBrowser']])
  assert.equal(preset.registered.size, 0)
  const host = fakeCtx()
  plugin.apply(host, plugin.Config({ safari: { enabled: false }, chrome: { enabled: false } }), { trace: () => {} })
  assert.equal(host.provided.deepseaBrowser, undefined)
  await host.dispose()
})

test('Chrome only, headless, no connection service: no Safari tools and no app-window routes', async () => {
  const rows = mountBoth({ safari: { enabled: false }, chrome: { headless: true } }, { trace: () => {} })
  assert.deepEqual(rows.host.injected, [['attachments', 'llm']], 'parking (and its routes) needs Safari')
  assert.deepEqual([...rows.preset.registered.keys()].sort(), TOOL_NAMES.filter(n => n.startsWith('chrome_')))
  await rows.dispose()
})

test('Chrome scratch directories of servers that are gone are swept; live ones stay', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'deepsea-tool-browser-test-'))
  try {
    const dead = 'deepsea-tool-browser-profile-999999-0-abcd1234'
    const mine = `deepsea-tool-browser-profile-${process.pid}-0-abcd1234`
    const older = 'deepsea-browser-profile-999999-0-abcd1234'
    for (const name of [dead, mine, older, 'unrelated']) mkdirSync(join(dir, name))
    assert.deepEqual((await plugin.sweepChromeScratch(dir)).sort(), [older, dead].sort())
    assert.deepEqual((await readdir(dir)).sort(), [mine, 'unrelated'].sort())
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('page content decoding: inline envelope, a spill file, bare text; never an undefined field', async () => {
  const spill = join(tmpdir(), `deepsea-tool-browser-test-spill-${process.pid}.json`)
  await writeFile(spill, JSON.stringify({ content: { type: 'root', children: [] }, url: 'https://x.example/', title: 'X', format: 'json' }))
  try {
    assert.deepEqual(await unwrapPageContent(JSON.stringify({ title: 'T', url: 'https://t.example/', content: 'body', format: 'markdown' })), { url: 'https://t.example/', title: 'T', content: 'body' })
    const spilled = await unwrapPageContent(`Saved large output to '${spill}' (42.9 kB). Use the Read tool to view its contents.`)
    assert.deepEqual(spilled, { url: 'https://x.example/', title: 'X', content: '{"type":"root","children":[]}' })
    assert.deepEqual(await unwrapPageContent('just text'), { content: 'just text' })
    assert.ok(!('title' in await unwrapPageContent(JSON.stringify({ url: 'https://u.example/', content: 'c' }))))
  } finally { await rm(spill, { force: true }) }
})

test('results are stripped of undefined (lossless JSON)', () => {
  assert.notEqual(losslessReason({ a: 1, uid: undefined }), undefined)
  const stripped = stripUndefined({ windowId: 'c:0:0', uid: undefined, fullPage: false, nested: { title: undefined, ok: [1, undefined, { x: undefined }] } })
  assert.equal(losslessReason(stripped), undefined)
  assert.deepEqual(stripped, { windowId: 'c:0:0', fullPage: false, nested: { ok: [1, null, {}] } })
})

// ---------------------------------------------------------------- Chrome tools against scripted connections

async function scriptedTools({ scratch } = {}) {
  const calls = []
  const conn = { closed: false, next: () => ({ content: [] }), callRaw: async (name, args) => { calls.push([name, args]); return conn.next(name, args) }, callText: async () => '' }
  const sessions = {
    resolveChrome: async () => ({ id: 'c:2:1', pageId: 7, conn, opened: false }),
    closeChrome: async () => [],
    closeSafari: async () => [],
  }
  const tools = createTools({ sessions, readerPool: undefined, admitImage: async () => ({ reason: 'the test model does not declare image input' }), inlineImages: new WeakMap(), preflight: () => {}, notes: createNotes(), scratch, limits: { maxChars: 1000, timeoutMs: 60_000 } }, { id: 'a', session: { header: { cwd: tmpdir() } } })
  const tool = (name) => tools.find(t => t.name === name)
  const exec = { agent: { id: 'a', session: { header: { cwd: tmpdir() } } }, signal: new AbortController().signal }
  return { conn, calls, tool, exec }
}

test('chrome screenshots: a capture spilled to disk is read back and its temporary directory removed', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'deepsea-tool-browser-test-'))
  const { conn, tool, exec } = await scriptedTools({ scratch })
  const getShot = tool('chrome_get_screenshot')
  const render = (value) => getShot.output.render({}, value)[0].text
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
  const spillDir = await mkdtemp(join(tmpdir(), 'chrome-devtools-mcp-'))
  const spillPath = join(spillDir, 'screenshot.png')
  await writeFile(spillPath, png)
  try {
    assert.equal(savedFileOf(`Took a screenshot of the current page's viewport.\nSaved screenshot to ${spillPath}.`), spillPath)
    assert.equal(savedFileOf('Took a screenshot.'), undefined)
    assert.equal(describeBlocks({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'text ×2')
    conn.next = () => ({ content: [{ type: 'text', text: `Took a screenshot of the current page's viewport.\nSaved screenshot to ${spillPath}.` }] })
    const shot = await getShot.execute({}, exec)
    assert.equal(shot.source, 'file')
    assert.equal(shot.byteLength, png.length)
    assert.equal(losslessReason(shot), undefined)
    assert.ok(shot.fallbackPath.startsWith(join(scratch, 'deepsea-tool-browser-chrome-screenshot-')), shot.fallbackPath)
    assert.match(render(shot), /wrote it to disk/)
    assert.match(render(shot), /saved to .*; not shown inline: the test model does not declare image input/)
    await new Promise(resolve => setTimeout(resolve, 50)) // the cleanup is not awaited
    assert.ok(!existsSync(spillDir), 'the server\'s temporary capture is removed')
  } finally {
    await rm(scratch, { recursive: true, force: true })
    await rm(spillDir, { recursive: true, force: true })
  }
})

test('chrome failures carry the server\'s words, the target, the request and a remedy; aborts pass through', async () => {
  const { conn, calls, tool, exec } = await scriptedTools()
  const getShot = tool('chrome_get_screenshot')
  conn.next = () => ({ isError: true, content: [{ type: 'text', text: 'Element with uid 2_57 no longer exists on the page.' }] })
  const stale = await getShot.execute({ uid: '2_57' }, exec).then(() => '', error => error.message)
  for (const needle of ['chrome_get_screenshot', 'element uid "2_57"', 'c:2:1', 'chrome-devtools-mcp said: Element with uid 2_57 no longer exists', 'Hint: uids come from chrome_snapshot', 'Request: {"uid":"2_57"}']) assert.ok(stale.includes(needle), `${needle}\n${stale}`)
  conn.next = () => ({ content: [{ type: 'text', text: 'Took a screenshot of the full current page.' }] })
  const empty = await getShot.execute({ fullPage: true }, exec).then(() => '', error => error.message)
  assert.match(empty, /neither an image block nor a "Saved screenshot to <path>" line.*Reply blocks: text.*Reply text: Took a screenshot of the full current page\./s)
  conn.next = () => ({ content: [{ type: 'text', text: 'Took a screenshot of the current page\'s viewport.\nSaved screenshot to /nonexistent/dir/screenshot.png.' }] })
  assert.match(await getShot.execute({}, exec).then(() => '', error => error.message), /\/nonexistent\/dir\/screenshot\.png.*could not be read back: ENOENT/s)
  // uid asked, viewport delivered: a NOTE in the summary.
  conn.next = () => ({ content: [{ type: 'text', text: 'Took a screenshot of the current page\'s viewport.' }, { type: 'image', data: Buffer.from('png').toString('base64'), mimeType: 'image/png' }] })
  const mismatch = await getShot.execute({ uid: '1_3' }, exec)
  assert.match(mismatch.notes[0], /requested element uid "1_3" but chrome-devtools-mcp reports it captured the viewport/)
  await rm(mismatch.fallbackPath, { force: true })
  // uid + fullPage: refused before any server call.
  const count = calls.length
  assert.match(await getShot.execute({ uid: '1_3', fullPage: true }, exec).then(() => '', error => error.message), /not both/)
  assert.equal(calls.length, count)
  // An MCP timeout: read in terms of toolCallTimeoutMs, the server tool named.
  const snapshot = tool('chrome_snapshot')
  conn.callText = async () => { throw new Error('take_snapshot: MCP error -32001: Request timed out') }
  const timeout = await snapshot.execute({ verbose: true }, exec).then(() => '', error => error.message)
  for (const needle of ['chrome_snapshot: server tool take_snapshot failed: MCP error -32001', 'within 60000 ms (the tool-browser plugin\'s toolCallTimeoutMs)', 'chrome_handle_dialog', 'Request: {"verbose":true}']) assert.ok(timeout.includes(needle), `${needle}\n${timeout}`)
  // A stopped turn's abort passes through untouched.
  const aborted = new AbortController(); aborted.abort()
  const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' })
  conn.callText = async () => { throw abortError }
  assert.equal(await snapshot.execute({}, { ...exec, signal: aborted.signal }).then(() => undefined, error => error), abortError)
  // chrome_interact: each step reported, a failed one with the remedy inline.
  conn.callText = async (name) => { if (name === 'hover') throw new Error('hover: Error: Element with uid 1_39 no longer exists on the page.'); return 'ok' }
  const batch = await tool('chrome_interact').execute({ interactions: [{ type: 'hover', purpose: 'hover the top line', node: '1_39' }, { type: 'scroll', purpose: 'down', scrollDelta: { y: 10 } }] }, exec)
  assert.match(batch, /#1 hover .* → FAILED: hover: Error: Element with uid 1_39 no longer exists on the page\. — Hint: uids come from chrome_snapshot/)
  assert.match(batch, /#2 scroll .* → ok/)
})

test('chrome_save_screenshot writes the file relative to the session\'s working directory, lossless result', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'deepsea-tool-browser-test-'))
  try {
    const { conn, tool } = await scriptedTools()
    conn.next = () => ({ content: [{ type: 'image', data: Buffer.from('x').toString('base64'), mimeType: 'image/png' }] })
    const exec = { agent: { id: 'a', session: { header: { cwd } } }, signal: new AbortController().signal }
    const saved = await tool('chrome_save_screenshot').execute({ path: 'shots/one.png' }, exec)
    assert.equal(saved.path, join(cwd, 'shots/one.png'))
    assert.equal(readFileSync(saved.path, 'utf8'), 'x')
    assert.equal(losslessReason(saved), undefined)
    assert.ok(!('uid' in saved))
  } finally { await rm(cwd, { recursive: true, force: true }) }
})

test('a page read beyond maxChars is cut, the full text in a scratch file', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'deepsea-tool-browser-test-'))
  try {
    const conn = { closed: false, callText: async (_name, args) => `Script ran on page and returned:\n\`\`\`json\n${JSON.stringify(/return \{ url: location\.href/.test(args.function) || /format: 'markdown'/.test(args.function) ? { url: 'https://x.example/', title: 'X', format: 'markdown', content: 'y'.repeat(1500) } : { details: 0, buttons: 0, tabGroups: 0 })}\n\`\`\`` }
    const sessions = { resolveChrome: async () => ({ id: 'c:0:0', pageId: 1, conn, opened: false }) }
    const tools = createTools({ sessions, admitImage: async () => ({}), inlineImages: new WeakMap(), preflight: () => {}, scratch, limits: { maxChars: 1000, timeoutMs: 60_000 } }, {})
    const read = await tools.find(t => t.name === 'chrome_get_page_content').execute({ windowId: 'c:0:0', clean: false }, { agent: {}, signal: new AbortController().signal })
    assert.equal(read.truncated, true)
    assert.equal(read.content.length, 1000)
    assert.equal(read.totalChars, 1500)
    assert.ok(read.fullTextPath.startsWith(join(scratch, 'deepsea-tool-browser-read-')) && read.fullTextPath.endsWith('.md'))
    assert.equal(readFileSync(read.fullTextPath, 'utf8').length, 1500)
  } finally { await rm(scratch, { recursive: true, force: true }) }
})

test('a notice is a user message whose source is this plugin\'s own kind (session format v4 refuses the plugin wrapper)', async () => {
  const { pluginNotice, name } = await import('../index.js')
  const notice = pluginNotice('[tool-browser] closed')
  assert.deepEqual(notice.content, [{ type: 'text', text: '[tool-browser] closed' }])
  assert.equal(notice.role, 'user')
  assert.deepEqual(notice.source, { kind: name })
  assert.notEqual(notice.source.kind, 'plugin')
})

// ---------------------------------------------------------------- Safari and Chrome input, dialogs, timings

/** Safari tools over one fake driver connection; `answer(name, args)` scripts its replies. */
function safariTools(answer) {
  const calls = []
  const conn = { closed: false, callText: async (name, args) => { calls.push([name, args]); return answer(name, args) } }
  const sessions = { resolveSafari: async () => ({ id: 's:0:0', conn, opened: false }), closeSafari: async () => [] }
  const tools = createTools({ sessions, admitImage: async () => ({}), inlineImages: new WeakMap(), preflight: () => {}, notes: createNotes(), dialogPollMs: 20, limits: { maxChars: 1000, timeoutMs: 60_000 } }, {})
  const exec = { agent: {}, signal: new AbortController().signal }
  return { calls, run: (name, args) => tools.find(t => t.name === name).execute(args, exec) }
}

test('safari: a click that opens a dialog returns at once and names it; the pending call is left alone', async () => {
  let release
  const { calls, run } = safariTools((name) => {
    if (name === 'page_interactions') return new Promise((_resolve, reject) => { release = () => reject(new Error('page_interactions: MCP error -32001: Request timed out')) })
    if (name === 'browser_dialogs') return '{"dialogs": [{"message": "Are you sure?"}]}'
    return JSON.stringify(JSON.stringify({ x: 10, y: 20, width: 5, height: 5 }))
  })
  const text = await run('safari_click', { selector: '#alertbtn' })
  assert.match(text, /^\[s:0:0\]\nA JavaScript dialog opened and is waiting: "Are you sure\?".*safari_handle_dialog/s)
  assert.deepEqual(calls.find(([name]) => name === 'page_interactions')[1].interactions[0].point, { x: 10, y: 20 })
  release() // its later timeout must not surface anywhere
  await new Promise(resolve => setTimeout(resolve, 10))
  // No dialog: the interaction's own reply, and the dialogs were listed only while it was pending.
  const quick = safariTools((name) => name === 'page_interactions' ? '{"successful":1}' : '{"dialogs": []}')
  assert.equal(await quick.run('safari_interact', { interactions: [{ type: 'click', purpose: 'p', text: 'Go' }] }), '[s:0:0]\n{"successful":1}')
  assert.ok(!quick.calls.some(([name]) => name === 'browser_dialogs'))
})

test('safari_type_text with selector types into the node WebKit lists for that element, and restores its label', async () => {
  let marker
  const { calls, run } = safariTools((name, args) => {
    if (name === 'evaluate_javascript') {
      marker ??= /aria-label', "(deepsea-target-[a-z0-9]+)"/.exec(args.expression)?.[1]
      return JSON.stringify(JSON.stringify({ tag: 'input', count: 1 }))
    }
    if (name === 'get_page_content') return JSON.stringify({ format: 'textTree', content: `root\n\tinput uid=12 label=Other\n\tinput uid=68 label=${marker} name=name` })
    return '{"successful":1}'
  })
  await run('safari_type_text', { selector: '#name', text: 'Grace Hopper', replaceAll: true, pressReturn: true })
  const step = calls.find(([name]) => name === 'page_interactions')[1].interactions[0]
  assert.deepEqual(step, { type: 'type', purpose: 'type text', node: '68', scrollToVisible: true, value: 'Grace Hopper', replaceAll: true, pressReturn: true })
  const evaluated = calls.filter(([name]) => name === 'evaluate_javascript').map(([, args]) => args.expression)
  assert.ok(evaluated.some(body => body.includes('removeAttribute(\'aria-label\')')), 'the element\'s own label is put back')
  assert.equal(calls.filter(([name]) => name === 'get_page_content').length, 2, 'extracted again without the marker, so the diff does not show it')
  // An element WebKit does not list: a clear failure, no interaction.
  const other = safariTools((name) => name === 'get_page_content' ? '{"content":"root"}' : JSON.stringify(JSON.stringify({ tag: 'p', count: 1 })))
  await assert.rejects(other.run('safari_type_text', { selector: '#out', text: 'x' }), /matches a <p> that WebKit does not list as an editable field/)
  assert.ok(!other.calls.some(([name]) => name === 'page_interactions'))
})

test('safari_evaluate_function args: a selector resolves with querySelector (no match names it), a number is a $uid', async () => {
  const call = safariFunctionCall('(a, b) => [a.id, b]', ['#name', ' 42 '])
  assert.equal(call.uids, true)
  const run = (expression, elements) => new (Object.getPrototypeOf(async () => {}).constructor)('document', '$uid', expression)(
    { querySelector: (s) => elements[s] ?? null }, (n) => `uid ${n}`)
  assert.deepEqual(await run(call.expression, { '#name': { id: 'name' } }), ['name', 'uid 42'])
  await assert.rejects(run(call.expression, {}), /^Error: no element matches selector "#name"$/)
  const plain = safariFunctionCall('() => 1')
  assert.deepEqual(plain, { expression: 'return await (() => 1)();', uids: false })
  assert.equal(safariFunctionCall('(el) => el', ['input[name="q"]']).uids, false)
})

test('safari $uid: probed once per window; without it a UID fails fast with the remedy, selectors still work', async () => {
  const missing = safariTools((name, args) => {
    if (/\$uid\(0\)/.test(args.expression)) return 'false'
    return '"ok"'
  })
  await assert.rejects(missing.run('safari_evaluate_function', { function: '(el) => el.id', args: ['12'] }), /node UIDs \(\$uid\) are not available in this Safari build; pass a CSS selector in args instead/)
  await assert.rejects(missing.run('safari_evaluate_expression', { expression: 'return $uid(12).id' }), /not available in this Safari build; use document\.querySelector/)
  assert.equal(missing.calls.length, 1, 'one probe, nothing else ran')
  assert.equal(await missing.run('safari_evaluate_function', { function: '(el) => el.id', args: ['#name'] }), '[s:0:0]\n"ok"')
  assert.match(missing.calls.at(-1)[1].expression, /document\.querySelector\(s\)[\s\S]*__deepseaElement\("#name"\)/)
  // A build with $uid: the UID is passed through.
  const present = safariTools((name, args) => /\$uid\(0\)/.test(args.expression) ? 'true' : '"input"')
  assert.equal(await present.run('safari_evaluate_function', { function: '(el) => el.tagName', args: ['12'] }), '[s:0:0]\n"input"')
  await present.run('safari_evaluate_function', { function: '(el) => el.tagName', args: ['13'] })
  assert.equal(present.calls.filter(([, args]) => /\$uid\(0\)/.test(args.expression)).length, 1, 'probed once')
  assert.match(present.calls.at(-1)[1].expression, /\(\$uid\(13\)\)/)
  // The page's own ReferenceError (no probe: the body names no $uid( call) is rewritten too, and remembered.
  const raw = safariTools((name, args) => { if (/uidOf/.test(args.expression)) throw new Error('evaluate_javascript: ReferenceError: Can\'t find variable: $uid'); return '1' })
  await assert.rejects(raw.run('safari_evaluate_expression', { expression: 'const uidOf = $uid; return uidOf(3)' }), /not available in this Safari build; use document\.querySelector/)
  await assert.rejects(raw.run('safari_evaluate_function', { function: '(el) => el', args: ['3'] }), /pass a CSS selector/)
  assert.equal(raw.calls.length, 1)
})

test('safari network timings: microseconds become milliseconds, zero durations are replaced from the page or dropped', async () => {
  const started = '2026-11-07T16:28:02.193Z'
  const request = { url: 'http://127.0.0.1:8766/x', started_at_iso8601: started, duration_ms: 0, timing: { connect_ms: 1000.2909693866968, content_download_ms: 0, dns_ms: 0.041676685214042664, ssl_ms: 0, ttfb_ms: 303480.59511743486 } }
  const entry = { name: request.url, start: Date.parse(started) + 2, duration: 904.1, download: 601 }
  assert.deepEqual(safariTiming(request, [{ ...entry, start: entry.start + 5000 }, entry]), {
    url: request.url, started_at_iso8601: started, duration_ms: 904.1,
    timing: { connect_ms: 1.0, content_download_ms: 601, dns_ms: 0, ssl_ms: 0, ttfb_ms: 303.481 },
  })
  const alone = safariTiming(request, [{ ...entry, name: 'http://other/' }])
  assert.ok(!('duration_ms' in alone) && !('content_download_ms' in alone.timing), 'no matching entry: no made-up zero')
  const { run } = safariTools((name) => name === 'list_network_requests' ? JSON.stringify({ count: 1, requests: [request] }) : JSON.stringify(JSON.stringify([entry])))
  const listed = JSON.parse((await run('safari_network_requests', {})).split('\n')[1])
  assert.equal(listed.requests[0].duration_ms, 904.1)
  assert.equal(listed.requests[0].timing.ttfb_ms, 303.481)
})

test('macOS editing shortcuts map to their commands; nothing else does, nor on other platforms', () => {
  const cases = { 'Meta+a': 'selectAll', 'Meta+A': 'selectAll', 'Control+c': 'copy', 'Meta+x': 'cut', 'Meta+v': 'paste', 'Meta+z': 'undo', 'Meta+Shift+z': 'redo', 'Shift+Meta+Z': 'redo' }
  for (const [key, command] of Object.entries(cases)) assert.equal(macEditingCommand(key, 'darwin'), command, key)
  for (const key of ['a', 'Enter', 'Meta+b', 'Meta+Control+a', 'Shift+a', 'Meta+Shift+a', 'Alt+a', 'Meta+Meta+a', 'Control++']) assert.equal(macEditingCommand(key, 'darwin'), undefined, key)
  assert.equal(macEditingCommand('Control+a', 'linux'), undefined)
})

test('chrome_press_key on macOS: the keys reach the page, then the plugin runs the command; copy feeds paste', async () => {
  const { conn, calls, tool, exec } = await scriptedTools()
  const results = [{ command: 'copy', text: 'Alan Turing', removed: false }, { command: 'paste', inserted: 11 }]
  const scripts = []
  conn.callText = async (name, args) => {
    calls.push([name, args])
    if (name === 'press_key') return `Successfully pressed key: ${args.key}`
    scripts.push(args.function)
    return `Script ran on page and returned:\n\`\`\`json\n${JSON.stringify(/const C = /.test(args.function) ? results.shift() : true)}\n\`\`\``
  }
  const darwin = process.platform === 'darwin'
  const copied = await tool('chrome_press_key').execute({ key: 'Meta+c' }, exec)
  if (!darwin) { assert.equal(copied, '[c:2:1]\nSuccessfully pressed key: Meta+c'); return }
  assert.deepEqual(calls.map(([name]) => name), ['evaluate_script', 'press_key', 'evaluate_script'], 'armed, pressed, then the command')
  assert.match(copied, /macOS editing command copy .*"Alan Turing" \(11 chars\) is on this chat's Chrome clipboard/)
  const pasted = await tool('chrome_press_key').execute({ key: 'Meta+v' }, exec)
  assert.match(pasted, /paste .*: 11 chars inserted/)
  assert.ok(scripts.at(-1).includes('const P = "Alan Turing"'), 'paste inserts what was copied')
})

test('chrome: an action that opens a dialog is a success naming it; a call blocked by an open dialog still fails', async () => {
  const { conn, tool, exec } = await scriptedTools()
  conn.callText = async () => { throw new Error('click: # Open dialog\nconfirm: Are you sure?.\nCall handle_dialog to handle it before continuing.\nError: Failed to interact with the element with uid 1_22. The element did not become interactive within the configured timeout.') }
  assert.equal(dialogOpenedBy('# Open dialog\nconfirm: Are you sure?.\nCall handle_dialog'), 'confirm: Are you sure?')
  const clicked = await tool('chrome_click').execute({ uid: '1_22' }, exec)
  assert.match(clicked, /^\[c:2:1\]\nclick ran and opened a JavaScript dialog \(confirm: Are you sure\?\); answer it with chrome_handle_dialog/)
  assert.doesNotMatch(clicked, /interactive|scroll it into view/)
  const batch = await tool('chrome_interact').execute({ interactions: [{ type: 'click', purpose: 'confirm', node: '1_22' }, { type: 'scroll', purpose: 'down', scrollDelta: { y: 10 } }] }, exec)
  assert.match(batch, /#1 click \(confirm\) → ok; click ran and opened a JavaScript dialog/)
  assert.match(batch, /#2 scroll \(down\) → not run: a dialog is open/)
  conn.callText = async () => { throw new Error('click: # Open dialog\nconfirm: Are you sure?.\nCall handle_dialog to handle it before continuing.\nError: A dialog is open (confirm: Are you sure?).') }
  const blocked = await tool('chrome_click').execute({ uid: '1_21' }, exec).then(() => '', error => error.message)
  assert.match(blocked, /A dialog is open.*Hint: answer it with chrome_handle_dialog/s)
})

test('chrome_set_viewport_size: verified in the page; emulated at the page\'s pixel ratio when the window resize does not take', async () => {
  const { conn, calls, tool, exec } = await scriptedTools()
  let viewport = { width: 1200, height: 818, dpr: 2 }
  conn.callText = async (name, args) => {
    calls.push([name, args])
    if (name === 'emulate') { const [w, h, dpr] = args.viewport.split('x').map(Number); viewport = { width: w, height: h, dpr }; return 'Emulation configured successfully' }
    if (name === 'evaluate_script') return `Script ran on page and returned:\n\`\`\`json\n${JSON.stringify(viewport)}\n\`\`\``
    return '## Pages' // resize_page: no effect, as on a visible macOS window
  }
  assert.equal(await tool('chrome_set_viewport_size').execute({ width: 500, height: 700 }, exec), '[c:2:1]\nViewport is 500×700 CSS px (emulated viewport; device pixel ratio 2).')
  assert.deepEqual(calls.find(([name]) => name === 'emulate')[1], { viewport: '500x700x2', pageId: 7 })
  calls.length = 0
  conn.callText = async (name, args) => { calls.push([name, args]); if (name === 'resize_page') viewport = { width: args.width, height: args.height, dpr: 1 }; return name === 'evaluate_script' ? `Script ran on page and returned:\n\`\`\`json\n${JSON.stringify(viewport)}\n\`\`\`` : 'ok' }
  assert.match(await tool('chrome_set_viewport_size').execute({ width: 800, height: 600 }, exec), /800×600 CSS px \(window resized/)
  assert.ok(!calls.some(([name]) => name === 'emulate'))
})

test('a scoped window read counts collapsed content in its scope only, before the scope is undone', async () => {
  const order = []
  const call = async (name, args) => {
    const body = args.expression ?? ''
    order.push(/outOfScope/.test(body) ? 'probe' : /let restored = 0/.test(body) ? 'restore' : /const P = /.test(body) ? 'scope' : name === 'get_page_content' ? 'extract' : /return \{ url: location\.href|format: 'markdown'/.test(body) ? 'extract' : 'other')
    if (/const P = /.test(body)) return JSON.stringify(JSON.stringify({ scope: 'section #buttons', chars: 10, hidden: 3 }))
    if (/outOfScope/.test(body)) return JSON.stringify(JSON.stringify({ details: 0, buttons: 0, tabGroups: 0 }))
    if (name === 'get_page_content') return JSON.stringify({ content: 'root' })
    return JSON.stringify(JSON.stringify(1))
  }
  const out = await extractPage(call, planRead({ section: '#buttons', format: 'textTree' }, false), false)
  assert.deepEqual(order.filter(step => step !== 'other'), ['scope', 'extract', 'probe', 'restore'])
  assert.deepEqual(out.notes, [])
  assert.match(probeScript(), /closest\('\[data-deepsea-browser-hidden\]'\)/)
})
