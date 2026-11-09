// The host half against a fake daemon on a temporary socket: configuration, the two rows, the tools as
// the daemon lists them, sessions per agent, images, notices, disposal, reconnects after a daemon restart,
// autostart through the configured command, and the app-window relay.
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import * as root from '../index.js'
import { APP_COMMAND_PATH, APP_WINDOW_PATH } from '../app-relay.mjs'
import { connect } from '../daemon-client.mjs'
import { fakeAgent, imagingServices, mountBoth, until } from './fake-host.mjs'
import { PNG_BASE64, startFakeDaemon, tempSocket, TOOLS } from './fake-daemon.mjs'
import { assertLossless } from './lossless.mjs'

const FAKE_COMMAND = fileURLToPath(new URL('./fixtures/fake-brow.mjs', import.meta.url))
const quiet = { trace: () => {}, startupRetryMs: [50], reconnectDelaysMs: [20, 50, 100] }

/** A fake daemon, both rows pointed at it, and cleanup. */
async function setup({ daemon: daemonOptions = {}, services = {}, config = {}, seams = {} } = {}) {
  const temp = tempSocket()
  const daemon = await startFakeDaemon({ socket: temp.socket, ...daemonOptions })
  const mounted = mountBoth({ brow: { socket: temp.socket, autostart: false }, ...config }, { ...quiet, scratch: temp.dir, ...seams }, { services })
  await until(() => mounted.tool('browser_read'), 3000, 'the tools')
  const t = {
    temp, daemon, ...mounted,
    // `t.daemon` may be replaced by a test (a restarted daemon): close the current one.
    async cleanup() { await mounted.dispose(); await t.daemon.close(); temp.remove() },
  }
  return t
}

const execOf = (agent, signal = new AbortController().signal) => ({ agent, signal })

test('config: defaults; the environment of a daemon the plugin starts', () => {
  const config = root.Config({})
  assert.deepEqual(config.brow, { socket: '', home: '', command: 'brow', autostart: true, env: {}, startTimeoutMs: 15_000 })
  assert.equal(config.trace, false)
  const env = root.daemonEnv(root.Config({ brow: { home: '/h', env: { BROW_CONFIG: '{"chrome":{"headless":true}}' } } }), { PATH: '/bin' })
  assert.deepEqual(env, { PATH: '/bin', BROW_HOME: '/h', BROW_CONFIG: '{"chrome":{"headless":true}}' })
})

test('package: two rows, the tools row joins the presets with tool-web, machine-wide', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.name, '@deepsea/tool-brow')
  assert.deepEqual(pkg.deepsea.presets, { joinWith: ['@deepseek-ai/dsh-tool-web'], module: '@deepsea/tool-brow/tools' })
  assert.equal(typeof pkg.deepsea.machineWide, 'string')
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(patch, /id: deepsea-tool-brow\n\s+name: "@deepsea\/tool-brow"/)
  assert.match(patch, /id: deepsea-tool-brow-tools\n\s+name: "@deepsea\/tool-brow\/tools"/)
  for (const file of pkg.files.filter(f => !f.includes('*') && !f.startsWith('lib/'))) assert.ok(existsSync(new URL(`../${file}`, import.meta.url)), `${file} is listed in files but missing`)
})

test('tools: the daemon\'s list, names and schemas unchanged; arguments validated before the call', async () => {
  const t = await setup()
  try {
    assert.deepEqual([...t.preset.registered.keys()], TOOLS.map(tool => tool.name))
    for (const tool of TOOLS) {
      const definition = t.tool(tool.name)
      assert.equal(definition.description, tool.description)
      assert.deepEqual(definition.parameters, tool.inputSchema)
      assert.deepEqual(definition.output.schema, { type: 'string' })
    }
    assert.equal(t.daemon.of('hello')[0].client.name, 'deepsea-tool-brow')
    await assert.rejects(t.tool('browser_eval').execute({}, execOf(fakeAgent('a1'))), { name: 'ToolArgsError', message: /expression/ })
    await assert.rejects(t.tool('browser_act').execute({ steps: [{}] }, execOf(fakeAgent('a1'))), { name: 'ToolArgsError' })
    assert.equal(t.daemon.of('tools.call').length, 0)
  } finally { await t.cleanup() }
})

test('tools row: subagents off registers with a depth condition', async () => {
  const temp = tempSocket()
  const daemon = await startFakeDaemon({ socket: temp.socket })
  const mounted = mountBoth({ brow: { socket: temp.socket, autostart: false } }, quiet, { tools: { subagents: false } })
  try {
    await until(() => mounted.tool('browser_read'), 3000, 'the tools')
    const { options } = mounted.preset.registered.get('browser_read')
    assert.equal(options.when({ agent: fakeAgent('a') }), true)
    assert.equal(options.when({ agent: fakeAgent('b', { depth: 1 }) }), false)
  } finally { await mounted.dispose(); await daemon.close(); temp.remove() }
})

test('a call: one daemon session per agent (key, title, cwd), opened once, arguments forwarded', async () => {
  const titles = new Map()
  const t = await setup({ services: { sessionTitle: { get: (session) => titles.get(session.id) } } })
  try {
    const agent = fakeAgent('agent-0001', { cwd: '/work/a' })
    titles.set(agent.session.id, { title: '  Find   the  docs ' })
    const first = await t.tool('browser_read').execute({ url: 'https://example.com', format: 'markdown' }, execOf(agent))
    assert.equal(first, '[chrome:0:0]\nbrowser_read ok')
    assertLossless('browser_read', first)
    assert.deepEqual(t.daemon.of('session.open'), [{ key: 'agent-0001', label: 'Find the docs', cwd: '/work/a', lease: 'connection' }])
    assert.deepEqual(t.daemon.of('tools.call')[0], { session: 'agent-0001', name: 'browser_read', arguments: { url: 'https://example.com', format: 'markdown' }, images: 'inline' })
    await t.tool('browser_close').execute({}, execOf(agent))
    assert.equal(t.daemon.of('session.open').length, 1, 'opened once')
    // The title changed: the daemon hears of it before the next call.
    titles.set(agent.session.id, { title: 'Docs found' })
    await t.tool('browser_logs').execute({}, execOf(agent))
    assert.deepEqual(t.daemon.of('session.update'), [{ session: 'agent-0001', label: 'Docs found', cwd: '/work/a' }])
    // Another agent (a subagent) is another session; without a title, a short id.
    const child = fakeAgent('child-agent-12345678', { depth: 1 })
    await t.tool('browser_open').execute({}, execOf(child))
    assert.equal(t.daemon.of('session.open')[1].key, 'child-agent-12345678')
    assert.equal(t.daemon.of('session.open')[1].label, 'chat 12345678')
  } finally { await t.cleanup() }
})

test('a failed tool throws its text; a lapsed session is opened again once', async () => {
  let fail = true
  const t = await setup({ daemon: { onCall: (params) => (fail ? { content: [{ type: 'text', text: 'browser_eval: no element matches\nHint: read format "outline"' }], isError: true } : { content: [{ type: 'text', text: `[chrome:0:0]\n${params.name}` }], isError: false }) } })
  try {
    const agent = fakeAgent('a2')
    await assert.rejects(t.tool('browser_eval').execute({ expression: 'return 1' }, execOf(agent)), { message: /no element matches\nHint: read format "outline"/ })
    fail = false
    t.daemon.sessions.delete('a2') // the lease lapsed
    assert.equal(await t.tool('browser_eval').execute({ expression: 'return 1' }, execOf(agent)),
      'NOTE: the brow daemon had ended this chat\'s session (its lease lapsed); its earlier browser windows are gone. [chrome:0:0]\nbrowser_eval')
    assert.equal(t.daemon.of('session.open').length, 2)
  } finally { await t.cleanup() }
})

test('images: inline through the attachment store for a vision model, else a file named in the text', async () => {
  const imaging = imagingServices()
  const t = await setup({
    services: { attachments: imaging.attachments, llm: imaging.llm },
    daemon: { onCall: () => ({ content: [{ type: 'image', data: PNG_BASE64, mimeType: 'image/png' }, { type: 'text', text: '[safari:0:1]\nviewport, 1×1 px, 1 kB png' }], isError: false }) },
  })
  try {
    const exec = execOf(fakeAgent('v1', { model: 'vision-model' }))
    const value = await t.tool('browser_screenshot').execute({}, exec)
    assert.equal(value, '[safari:0:1]\nviewport, 1×1 px, 1 kB png')
    assert.equal(imaging.saved.length, 1)
    assert.deepEqual(Buffer.from(imaging.saved[0].data), Buffer.from(PNG_BASE64, 'base64'))
    assert.match(imaging.saved[0].name, /^safari-\d+\.png$/)
    const content = t.tool('browser_screenshot').finalizeContent(exec, { isError: false, content: [{ type: 'text', text: value }] })
    assert.equal(content[0].type, 'image')
    assert.equal(content[0].attachment.attachmentId, 'sha256:1-0')
    assert.deepEqual(content[1], { type: 'text', text: value })
    assert.equal(t.tool('browser_screenshot').finalizeContent(exec, { isError: false, content: [] }), undefined, 'taken once')

    const blind = execOf(fakeAgent('t1', { model: 'text-model' }))
    const text = await t.tool('browser_screenshot').execute({}, blind)
    const path = /saved to (\S+), view it with read_image/.exec(text)?.[1]
    assert.match(text, /screenshot not shown inline \(model "text-model" does not declare image input\); saved to /)
    assert.ok(path && existsSync(path))
    assert.deepEqual(readFileSync(path), Buffer.from(PNG_BASE64, 'base64'))
    assert.equal(t.tool('browser_screenshot').finalizeContent(blind, { isError: false, content: [] }), undefined)
    assert.equal(imaging.saved.length, 1)
  } finally { await t.cleanup() }
})

test('images: without an attachment store, saved to a file', async () => {
  const t = await setup({ daemon: { onCall: () => ({ content: [{ type: 'image', data: PNG_BASE64, mimeType: 'image/jpeg' }, { type: 'text', text: '[chrome:0:0]\nviewport' }], isError: false }) } })
  try {
    const text = await t.tool('browser_screenshot').execute({}, execOf(fakeAgent('n1')))
    assert.match(text, /not shown inline \(no attachment store is mounted\); saved to \S+\.jpg, view it with read_image/)
  } finally { await t.cleanup() }
})

test('notices: session.notice reaches its agent as a user-role message', async () => {
  const t = await setup()
  try {
    const agent = fakeAgent('n2')
    const other = fakeAgent('n3')
    await t.tool('browser_open').execute({}, execOf(agent))
    await t.tool('browser_open').execute({}, execOf(other))
    t.daemon.notice('n2', '[browser] Closed idle browser window(s) chrome:0:0 after 30 min without use.')
    await until(() => agent.notices.length === 1, 2000, 'the notice')
    const [message] = agent.notices
    assert.equal(message.role, 'user')
    assert.deepEqual(message.content, [{ type: 'text', text: '[browser] Closed idle browser window(s) chrome:0:0 after 30 min without use.' }])
    assert.deepEqual(message.source, { kind: 'deepsea-tool-brow' })
    assert.equal(other.notices.length, 0)
  } finally { await t.cleanup() }
})

test('agent/disposed closes its session; unload closes the rest', async () => {
  const t = await setup()
  try {
    const a = fakeAgent('d1')
    const b = fakeAgent('d2')
    await t.tool('browser_open').execute({}, execOf(a))
    await t.tool('browser_open').execute({}, execOf(b))
    t.host.emit('agent/disposed', { agent: a })
    await until(() => t.daemon.of('session.close').length === 1, 2000, 'session.close')
    assert.deepEqual(t.daemon.of('session.close'), [{ session: 'd1' }])
    await t.dispose()
    assert.deepEqual(t.daemon.of('session.close'), [{ session: 'd1' }, { session: 'd2' }])
    await until(() => t.daemon.connections.size === 0, 2000, 'the connection to close')
  } finally { await t.daemon.close(); t.temp.remove() }
})

test('a call is cancelled with $/cancel when its signal aborts', async () => {
  const t = await setup({ daemon: { onCall: (_params, { signal }) => new Promise((resolve) => signal.addEventListener('abort', () => resolve({ content: [{ type: 'text', text: 'aborted' }], isError: true }))) } })
  try {
    const controller = new AbortController()
    const call = t.tool('browser_navigate').execute({ url: 'https://example.com' }, execOf(fakeAgent('c1'), controller.signal))
    await until(() => t.daemon.of('tools.call').length === 1, 2000, 'the call')
    controller.abort()
    await assert.rejects(call, { message: 'aborted' })
    assert.equal(t.daemon.cancelled.length, 1)
  } finally { await t.cleanup() }
})

test('daemon restart: reconnect, the sessions in use re-opened, a note on the next result', async () => {
  const t = await setup()
  try {
    const agent = fakeAgent('r1')
    await t.tool('browser_open').execute({}, execOf(agent))
    await t.daemon.close()
    const second = await startFakeDaemon({ socket: t.temp.socket, pid: 5353 })
    t.daemon = second
    await until(() => second.of('session.open').length === 1, 3000, 'the session re-opened on the new daemon')
    assert.equal(second.of('session.open')[0].key, 'r1')
    const text = await t.tool('browser_read').execute({ url: 'https://example.com' }, execOf(agent))
    assert.match(text, /^NOTE: the brow daemon restarted \(pid 4242 → 5353\); this chat's earlier browser windows are gone\. \[chrome:0:0\]/)
    assert.doesNotMatch(await t.tool('browser_read').execute({ url: 'https://example.com' }, execOf(agent)), /NOTE/)
    assert.deepEqual([...t.preset.registered.keys()], TOOLS.map(tool => tool.name), 'same tools: registered once')
  } finally { await t.cleanup() }
})

test('a daemon with different tools: the tools row registers the new list', async () => {
  const t = await setup()
  try {
    await t.daemon.close()
    const fewer = TOOLS.filter(tool => tool.name !== 'browser_logs').concat([{ name: 'browser_script', description: 'Run a script.', inputSchema: { type: 'object', properties: { source: { type: 'string' } } } }])
    t.daemon = await startFakeDaemon({ socket: t.temp.socket, pid: 6000, tools: fewer })
    await until(() => t.tool('browser_script'), 3000, 'the new tool')
    assert.equal(t.tool('browser_logs'), undefined)
    assert.ok(t.host.infos.some(m => /tools changed/.test(m)))
  } finally { await t.cleanup() }
})

test('a closed connection during a call says so', async () => {
  const t = await setup({ daemon: { onCall: () => new Promise(() => {}) } })
  try {
    const call = t.tool('browser_eval').execute({ expression: 'return 1' }, execOf(fakeAgent('x1')))
    await until(() => t.daemon.of('tools.call').length === 1, 2000, 'the call')
    await t.daemon.close()
    await assert.rejects(call, { message: /connection closed during browser_eval/ })
  } finally { await t.cleanup() }
})

test('no daemon: no tools and a warning; they appear once one answers', async () => {
  const temp = tempSocket()
  const mounted = mountBoth({ brow: { socket: temp.socket, autostart: false } }, quiet)
  let daemon
  try {
    await until(() => mounted.host.warnings.some(m => /no brow daemon/.test(m)), 2000, 'the warning')
    assert.equal(mounted.preset.registered.size, 0)
    daemon = await startFakeDaemon({ socket: temp.socket })
    await until(() => mounted.tool('browser_read'), 3000, 'the tools')
  } finally { await mounted.dispose(); await daemon?.close(); temp.remove() }
})

test('autostart: `<command> start` with the configured home and env, then the socket answers', async () => {
  const temp = tempSocket()
  const home = join(temp.dir, 'h')
  const socket = join(home, 'run', 'daemon.sock')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(join(home, 'run'), { recursive: true })
  const mounted = mountBoth({ brow: { home, command: FAKE_COMMAND, env: { FAKE_MARK: '1' } } }, quiet)
  try {
    await until(() => mounted.tool('browser_read'), 10_000, 'the tools from the started daemon')
    assert.ok(existsSync(socket))
    const value = await mounted.tool('browser_open').execute({}, execOf(fakeAgent('s1')))
    assert.equal(value, '[chrome:0:0]\nbrowser_open ok')
  } finally {
    await mounted.dispose()
    const client = await connect({ socket }).catch(() => undefined)
    await client?.request('daemon.shutdown', {})
    client?.close()
    await until(() => !existsSync(socket), 5000, 'the started daemon to exit').catch(() => {})
    rmSync(temp.dir, { recursive: true, force: true })
  }
})

test('a call with no daemon and autostart off names the remedy', async () => {
  const t = await setup()
  try {
    await t.daemon.close()
    await new Promise(resolve => setTimeout(resolve, 250)) // the quick reconnects give up
    await assert.rejects(t.tool('browser_read').execute({ url: 'https://example.com' }, execOf(fakeAgent('z1'))),
      { message: /the brow daemon is not available: no brow daemon is running on .*Start it \(brow start\)/ })
  } finally { await t.cleanup() }
})

// ---------------------------------------------------------------- the DeepSea app's window

const REPORT = { pid: 4410, bundleId: 'io.github.taliesinb.deepsea.release', frame: { x: 0, y: 34, width: 1200, height: 900 }, screen: { frame: { x: 0, y: 0, width: 1710, height: 1107 }, visible: { x: 0, y: 34, width: 1710, height: 1073 } }, key: true, active: true, fullScreen: false }

function routes() {
  const table = new Map()
  return { table, connection: { fetch: { register(route) { table.set(route.path, route); return () => table.delete(route.path) } } } }
}
const post = (table, body, type = 'application/json') => table.get(APP_WINDOW_PATH).fetch(new Request(`http://x${APP_WINDOW_PATH}`, { method: 'POST', headers: { 'content-type': type }, body: typeof body === 'string' ? body : JSON.stringify(body) }))
const get = (table, query, signal) => table.get(APP_COMMAND_PATH).fetch(new Request(`http://x${APP_COMMAND_PATH}?${query}`, { signal }))

test('app window: reports relayed as app.report, commands from app.poll', async () => {
  const r = routes()
  const t = await setup({ services: { connection: r.connection } })
  try {
    assert.equal(APP_WINDOW_PATH, '/api/deepsea-tool-brow/app-window')
    assert.equal((await post(r.table, REPORT, 'text/plain')).status, 415)
    assert.equal((await post(r.table, '{nope')).status, 400)
    assert.equal((await post(r.table, { pid: 'x' })).status, 400)
    const ok = await post(r.table, REPORT)
    assert.deepEqual([ok.status, await ok.json()], [200, { ok: true }])
    assert.deepEqual(t.daemon.of('app.report'), [{ report: REPORT }])
    assert.equal((await get(r.table, 'pid=abc')).status, 400)
    t.daemon.command(4410, { type: 'set-frame', frame: REPORT.frame })
    assert.deepEqual(await (await get(r.table, 'pid=4410')).json(), { command: { type: 'set-frame', frame: REPORT.frame } })
    assert.deepEqual(await (await get(r.table, 'pid=4410')).json(), {}, 'nothing to do: empty after the poll time')
  } finally { await t.cleanup() }
})

test('app window: parking off in the daemon → 404, so the page stops reporting', async () => {
  const r = routes()
  const t = await setup({ services: { connection: r.connection }, daemon: { parking: false } })
  try {
    assert.equal((await post(r.table, REPORT)).status, 404)
    assert.equal((await get(r.table, 'pid=4410')).status, 404)
  } finally { await t.cleanup() }
})

test('app window: without a daemon, reports are kept and replayed when one connects; polls wait', async () => {
  const r = routes()
  const temp = tempSocket()
  const mounted = mountBoth({ brow: { socket: temp.socket, autostart: false } }, quiet, { services: { connection: r.connection } })
  let daemon
  try {
    const kept = await post(r.table, REPORT)
    assert.deepEqual([kept.status, await kept.json()], [202, { ok: true, relayed: false }])
    const controller = new AbortController()
    const polling = get(r.table, 'pid=4410', controller.signal)
    setTimeout(() => controller.abort(), 50)
    assert.deepEqual(await (await polling).json(), {})
    daemon = await startFakeDaemon({ socket: temp.socket })
    await until(() => daemon.of('app.report').length === 1, 3000, 'the replayed report')
    assert.deepEqual(daemon.of('app.report')[0], { report: REPORT })
  } finally { await mounted.dispose(); await daemon?.close(); temp.remove() }
})

test('app window: an immediately empty poll is held, so the page cannot spin', async () => {
  const { createAppRelay } = await import('../app-relay.mjs')
  const fakeClient = { request: async () => ({}) }
  const relay = createAppRelay({ link: { current: () => fakeClient, onConnected() {} }, minPollMs: 120 })
  const started = Date.now()
  assert.deepEqual(await relay.poll(4410), { status: 200, body: {} })
  assert.ok(Date.now() - started >= 110)
})
