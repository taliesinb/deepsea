// The host half without browsers: configuration, chrome-devtools-mcp arguments and environment, the
// stderr filter, preflight messages, tool registration per agent, and the tools' result and failure
// shapes against scripted fake connections.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import * as plugin from '../index.js'
import { createNotes, createTools, stripUndefined } from '../tools.mjs'
import { CHROME_STDERR_NOISE, describeBlocks, isNoiseLine, readLines, savedFileOf, unwrapPageContent } from '../servers.mjs'
import { fakeAgent, fakeCtx } from './fake-host.mjs'
import { losslessReason } from './lossless.mjs'

const TOOL_NAMES = ['chrome_click', 'chrome_close', 'chrome_console_messages', 'chrome_evaluate_expression', 'chrome_evaluate_function', 'chrome_fill', 'chrome_fill_form', 'chrome_get_network_request', 'chrome_get_page_content', 'chrome_get_page_structure', 'chrome_get_screenshot', 'chrome_handle_dialog', 'chrome_hover', 'chrome_interact', 'chrome_navigate', 'chrome_network_requests', 'chrome_open', 'chrome_press_key', 'chrome_save_screenshot', 'chrome_set_viewport_size', 'chrome_snapshot', 'chrome_type_text', 'chrome_wait_for', 'safari_click', 'safari_close', 'safari_console_messages', 'safari_evaluate_expression', 'safari_evaluate_function', 'safari_get_network_request', 'safari_get_page_content', 'safari_get_page_structure', 'safari_get_screenshot', 'safari_get_youtube_notes', 'safari_handle_dialog', 'safari_hover', 'safari_interact', 'safari_navigate', 'safari_network_requests', 'safari_open', 'safari_press_key', 'safari_save_screenshot', 'safari_set_viewport_size', 'safari_type_text', 'safari_wait_for']

test('configuration defaults', () => {
  const config = plugin.Config({})
  assert.equal(plugin.name, 'deepsea-browser')
  assert.deepEqual(plugin.inject, ['agents', 'tools', 'sessionProjections'])
  assert.equal(config.safari.enabled, true)
  assert.equal(config.safari.labelPrefix, 'DeepSea: ')
  assert.equal(config.safari.hiddenWindows, 'park')
  assert.equal(config.safari.park.helper, '~/Library/Application Support/io.github.taliesinb.deepsea/DeepSea Window Helper.app')
  assert.equal(config.safari.reader.maxIdle, 1)
  assert.equal(config.chrome.headless, false)
  assert.equal(config.chrome.quietStderr, true)
  assert.equal(config.subagents, true)
  assert.deepEqual(config.skipPresets, ['minimal', 'minimal-no-tools'])
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

test('apply: tools per agent, subagents filtered, presets gated, optional services injected, disposal unwinds', async () => {
  const before = fakeAgent('before')
  const services = { connection: { fetch: { register: (route) => { routes.push(route.path); return () => {} } } } }
  const routes = []
  const ctx = fakeCtx({ agents: [before], services })
  const traced = []
  plugin.apply(ctx, plugin.Config({ subagents: false }), { trace: (event) => traced.push(event) })
  assert.deepEqual(ctx.injected, [['attachments', 'llm'], ['connection']])
  assert.deepEqual(routes, ['/api/deepsea-browser/app-window', '/api/deepsea-browser/app-command'])
  const top = fakeAgent('top')
  const child = fakeAgent('child', { depth: 1 })
  const tiny = fakeAgent('tiny', { preset: 'minimal-no-tools' })
  ctx.emit('agent/created', { agent: top })
  ctx.emit('agent/created', { agent: child })
  ctx.emit('agent/created', { agent: tiny })
  assert.deepEqual([...top.registered.keys()].sort(), TOOL_NAMES)
  assert.equal(child.registered.size, 0, 'subagents: false')
  assert.equal(tiny.registered.size, 0, 'a chat-only preset')
  assert.equal(before.registered.size, TOOL_NAMES.length, 'agents alive when the plugin loads are attached')
  const shot = top.registered.get('safari_get_screenshot')
  assert.equal(typeof shot.finalizeContent, 'function')
  assert.ok(shot.parameters.properties.querySelector)
  // The preset switches after creation: detached, and attached again when it switches back.
  ctx.agents.list = () => [before, top, tiny]
  ctx.presets.set('top', 'minimal')
  ctx.emit('agent-preset/selected', 'top', 'minimal')
  assert.equal(top.registered.size, 0)
  ctx.presets.set('tiny', 'standard')
  ctx.emit('agent-preset/selected', 'tiny', 'standard')
  assert.equal(tiny.registered.size, TOOL_NAMES.length)
  ctx.emit('agent/disposed', { agent: before })
  assert.equal(before.registered.size, 0)
  assert.deepEqual(traced.filter(e => e.event === 'skip').map(e => e.id), ['tiny'])
  await ctx.dispose()
  assert.equal(tiny.registered.size, 0, 'unload removes every registration')
})

test('apply: Chrome only, headless, no connection service: no Safari tools and no app-window routes', async () => {
  const ctx = fakeCtx()
  plugin.apply(ctx, plugin.Config({ safari: { enabled: false }, chrome: { headless: true } }), { trace: () => {} })
  assert.deepEqual(ctx.injected, [['attachments', 'llm']], 'parking (and its routes) needs Safari')
  const agent = fakeAgent('a')
  ctx.emit('agent/created', { agent })
  assert.deepEqual([...agent.registered.keys()].sort(), TOOL_NAMES.filter(n => n.startsWith('chrome_')))
  await ctx.dispose()
})

test('Chrome scratch directories of servers that are gone are swept; live ones stay', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'deepsea-browser-test-'))
  try {
    const dead = 'deepsea-browser-profile-999999-0-abcd1234'
    const mine = `deepsea-browser-profile-${process.pid}-0-abcd1234`
    for (const name of [dead, mine, 'unrelated']) mkdirSync(join(dir, name))
    assert.deepEqual(await plugin.sweepChromeScratch(dir), [dead])
    assert.deepEqual((await readdir(dir)).sort(), [mine, 'unrelated'].sort())
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('page content decoding: inline envelope, a spill file, bare text; never an undefined field', async () => {
  const spill = join(tmpdir(), `deepsea-browser-test-spill-${process.pid}.json`)
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
  const scratch = await mkdtemp(join(tmpdir(), 'deepsea-browser-test-'))
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
    assert.ok(shot.fallbackPath.startsWith(join(scratch, 'deepsea-browser-chrome-screenshot-')), shot.fallbackPath)
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
  for (const needle of ['chrome_snapshot: server tool take_snapshot failed: MCP error -32001', 'within 60000 ms (the browser plugin\'s toolCallTimeoutMs)', 'chrome_handle_dialog', 'Request: {"verbose":true}']) assert.ok(timeout.includes(needle), `${needle}\n${timeout}`)
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
  const cwd = await mkdtemp(join(tmpdir(), 'deepsea-browser-test-'))
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
  const scratch = await mkdtemp(join(tmpdir(), 'deepsea-browser-test-'))
  try {
    const conn = { closed: false, callText: async (_name, args) => `Script ran on page and returned:\n\`\`\`json\n${JSON.stringify(/return \{ url: location\.href/.test(args.function) || /format: 'markdown'/.test(args.function) ? { url: 'https://x.example/', title: 'X', format: 'markdown', content: 'y'.repeat(1500) } : { details: 0, buttons: 0, tabGroups: 0 })}\n\`\`\`` }
    const sessions = { resolveChrome: async () => ({ id: 'c:0:0', pageId: 1, conn, opened: false }) }
    const tools = createTools({ sessions, admitImage: async () => ({}), inlineImages: new WeakMap(), preflight: () => {}, scratch, limits: { maxChars: 1000, timeoutMs: 60_000 } }, {})
    const read = await tools.find(t => t.name === 'chrome_get_page_content').execute({ windowId: 'c:0:0', clean: false }, { agent: {}, signal: new AbortController().signal })
    assert.equal(read.truncated, true)
    assert.equal(read.content.length, 1000)
    assert.equal(read.totalChars, 1500)
    assert.ok(read.fullTextPath.startsWith(join(scratch, 'deepsea-browser-read-')) && read.fullTextPath.endsWith('.md'))
    assert.equal(readFileSync(read.fullTextPath, 'utf8').length, 1500)
  } finally { await rm(scratch, { recursive: true, force: true }) }
})

test('a notice is a user message whose source is this plugin\'s own kind (session format v4 refuses the plugin wrapper)', async () => {
  const { pluginNotice, name } = await import('../index.js')
  const notice = pluginNotice('[browser] closed')
  assert.deepEqual(notice.content, [{ type: 'text', text: '[browser] closed' }])
  assert.equal(notice.role, 'user')
  assert.deepEqual(notice.source, { kind: name })
  assert.notEqual(notice.source.kind, 'plugin')
})
