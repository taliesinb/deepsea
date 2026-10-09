import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Config, apply, inUseBy, install, name, providerOf, resolveConfig } from '../index.js'
import { Supervisor, healthy } from '../supervisor.mjs'

const FAKE = fileURLToPath(new URL('./fake-server.mjs', import.meta.url))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function freePort() {
  const server = createNetServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise(resolve => server.close(resolve))
  return port
}

async function until(check, ms = 10_000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await check()) return true
    await sleep(50)
  }
  return false
}

const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }

/** A Cordis-shaped stand-in: listeners, effects, logger, agents, projections. */
function fakeContext({ selections = new Map() } = {}) {
  const listeners = []
  const disposers = []
  const lines = []
  return {
    lines,
    selections,
    logger: { info: m => lines.push(['info', m]), warn: m => lines.push(['warn', m]) },
    on(event, callback) { listeners.push([event, callback]) },
    effect(setup) { disposers.push(setup()) },
    emit(event, ...args) { for (const [name, callback] of listeners) if (name === event) callback(...args) },
    dispose() { for (const dispose of disposers.splice(0)) dispose() },
    agents: { list: () => [...selections.keys()].map(id => ({ session: { id } })) },
    sessionProjections: {
      stateOf(session, key) {
        assert.equal(key, 'modelSelection')
        return selections.get(session.id)
      },
    },
  }
}

function fixtureServer(port, extra = {}) {
  return {
    id: 'fake',
    providers: ['fixture'],
    command: process.execPath,
    args: [FAKE, String(port)],
    healthUrl: `http://127.0.0.1:${port}/v1/models`,
    idleMinutes: 1,
    startupTimeoutMs: 10_000,
    ...extra,
  }
}

function tempHome(t) {
  const root = mkdtempSync(join(tmpdir(), 'deepsea-local-model-supervisor-test-'))
  const home = join(root, '.deepsea', 'test-variant')
  mkdirSync(home, { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return home
}

test('configuration: defaults, detachment, double resolution and the Cordis wrapper', () => {
  assert.deepEqual(resolveConfig(), { servers: [] })
  const raw = { servers: [{ id: 'afm', providers: ['apple'], command: 'afm', healthUrl: 'http://127.0.0.1:9997/v1/models' }] }
  const resolved = resolveConfig(raw)
  assert.deepEqual(resolved.servers[0], {
    id: 'afm', providers: ['apple'], command: 'afm', args: [], healthUrl: 'http://127.0.0.1:9997/v1/models',
    idleMinutes: 0, startupTimeoutMs: 60_000, env: {},
  })
  raw.servers[0].providers.push('later')
  assert.deepEqual(resolved.servers[0].providers, ['apple'])
  assert.deepEqual(resolveConfig(resolved), resolved)
  assert.deepEqual(Config['~standard'].validate(resolved), { value: resolved })
  assert.equal(Config['~standard'].vendor, name)
  assert.equal(name, 'deepsea-local-model-supervisor')
})

test('configuration: every problem fails the load and names the entry', () => {
  const good = { id: 'a', providers: ['p'], command: 'x', healthUrl: 'http://127.0.0.1:1/' }
  for (const [input, pattern] of [
    [null, /only a servers list/], [{ extra: 1 }, /only a servers list/], [{ servers: {} }, /must be a list/],
    [{ servers: [1] }, /servers\[0\] must be a mapping/],
    [{ servers: [{ ...good, logFile: '/tmp/x.log' }] }, /unknown field logFile/],
    [{ servers: [{ ...good, id: '../up' }] }, /\.id must be a name/],
    [{ servers: [{ ...good, providers: [] }] }, /providers must be a non-empty list/],
    [{ servers: [{ ...good, command: '' }] }, /command must be/],
    [{ servers: [{ ...good, args: '--port 1' }] }, /args must be a list/],
    [{ servers: [{ ...good, healthUrl: 'localhost:1' }] }, /healthUrl must be an http/],
    [{ servers: [{ ...good, idleMinutes: -1 }] }, /idleMinutes must be a non-negative/],
    [{ servers: [{ ...good, env: { A: 1 } }] }, /env must be a mapping of strings/],
    [{ servers: [{ ...good, logDirectory: 'logs' }] }, /logDirectory must be an absolute path/],
    [{ servers: [good, { ...good, providers: ['q'] }] }, /two servers are called "a"/],
    [{ servers: [good, { ...good, id: 'b' }] }, /provider "p" is claimed by two servers/],
  ]) {
    assert.throws(() => resolveConfig(input), pattern)
    assert.equal(Config['~standard'].validate(input).issues.length, 1)
  }
})

test('the provider of a session event: model selections and requests only', () => {
  assert.equal(providerOf({ type: 'model/selection', data: { provider: 'apple', model: 'foundation' } }), 'apple')
  assert.equal(providerOf({ type: 'request/header', data: { header: { config: { provider: 'lmstudio', model: 'm' } } } }), 'lmstudio')
  assert.equal(providerOf({ type: 'assistant/message', data: { provider: 'apple' } }), undefined)
})

test('in use: a live agent whose pending, else last used, selection names a provider', () => {
  const ctx = fakeContext({ selections: new Map([
    ['s1', { pending: null, lastUsed: { provider: 'apple', model: 'foundation' } }],
    ['s2', { pending: { provider: 'other', model: 'x' }, lastUsed: { provider: 'lmstudio', model: 'm' } }],
    ['s3', undefined],
  ]) })
  const inUse = inUseBy(ctx)
  assert.equal(inUse({ providers: ['apple'] }), true)
  assert.equal(inUse({ providers: ['lmstudio'] }), false, 'a pending selection replaces the last used one')
  assert.equal(inUse({ providers: ['other'] }), true)
  ctx.sessionProjections.stateOf = () => { throw new Error('projection absent') }
  assert.equal(inUse({ providers: ['apple'] }), false)
})

test('no servers: nothing is installed', () => {
  const ctx = fakeContext()
  assert.equal(install(ctx, {}), undefined)
  assert.match(ctx.lines[0][1], /nothing to supervise/)
  assert.equal(apply(fakeContext(), { servers: [] }), undefined, 'apply returns no effect value')
})

test('first use spawns once, every later use reuses it, the run log is in the variant log directory, unload stops it', { timeout: 30_000 }, async (t) => {
  // A variant home in a DeepSea root: logs go to <log root>/<variant name>/plugins/local-model-supervisor/<id>/.
  const home = tempHome(t)
  const root = dirname(dirname(home))
  const env = { DEEPSEA_ROOT: dirname(home), DEEPSEA_LOG_ROOT: join(root, 'Logs') }
  const port = await freePort()
  const ctx = fakeContext()
  let spawns = 0
  const supervisor = install(ctx, { servers: [fixtureServer(port)] }, {
    home, env, supervisor: { spawn: (...args) => { spawns++; return spawn(...args) } },
  })
  t.after(() => ctx.dispose())
  ctx.emit('session/event', {}, { type: 'model/selection', data: { provider: 'fixture', model: 'm' } })
  ctx.emit('session/event', {}, { type: 'request/header', data: { header: { config: { provider: 'fixture', model: 'm' } } } })
  await supervisor.states.get('fake').ensuring
  assert.equal(await healthy(`http://127.0.0.1:${port}/v1/models`), true)
  await supervisor.touch('fixture')
  ctx.emit('session/event', {}, { type: 'model/selection', data: { provider: 'unrelated', model: 'm' } })
  assert.equal(spawns, 1)
  const state = supervisor.states.get('fake')
  assert.equal(state.owned, true)
  const pid = state.child.pid

  const dir = join(root, 'Logs', 'io.github.taliesinb.deepsea.test-variant', 'plugins', 'local-model-supervisor', 'fake')
  const files = readdirSync(dir).filter(f => f !== 'latest.log')
  assert.deepEqual(files.length, 1)
  assert.match(files[0], new RegExp(`^\\d{4}-\\d\\d-\\d\\dT\\d\\d-\\d\\d-\\d\\d-${pid}\\.log$`))
  assert.equal(readlinkSync(join(dir, 'latest.log')), files[0])
  assert.ok(await until(() => readFileSync(join(dir, files[0]), 'utf8').includes('fake model server')))
  const [first] = readFileSync(join(dir, files[0]), 'utf8').split('\n')
  assert.match(first, new RegExp(`^\\S+ io\\.github\\.taliesinb\\.deepsea\\.test-variant local-model-supervisor fake pid ${pid} `))
  assert.ok(ctx.lines.some(([, m]) => m.includes('"fake" started')))

  ctx.dispose()
  assert.ok(await until(() => !alive(pid)), 'unload stops the owned server')
  await supervisor.touch('fixture')
  assert.equal(spawns, 1, 'nothing starts after unload')
})

test('a server already healthy is adopted: reused, never started or stopped', { timeout: 30_000 }, async (t) => {
  const external = createServer((_request, response) => { response.writeHead(200); response.end('{}') })
  await new Promise(resolve => external.listen(0, '127.0.0.1', resolve))
  t.after(() => external.close())
  const { port } = external.address()
  let spawns = 0
  const supervisor = new Supervisor({
    servers: resolveConfig({ servers: [fixtureServer(port)] }).servers,
    logger: { info() {}, warn() {} }, inUse: () => false, logDirectory: () => tempHome(t),
    spawn: () => { spawns++; throw new Error('must not spawn') },
  })
  await supervisor.touch('fixture')
  assert.equal(spawns, 0)
  assert.equal(supervisor.states.get('fake').owned, false)
  supervisor.sweep()
  supervisor.stopOwned()
  assert.equal(await healthy(`http://127.0.0.1:${port}/`), true, 'the adopted server is left running')
})

test('idle sweep: stops an owned server only past its window and with no live session on its providers', { timeout: 30_000 }, async (t) => {
  const port = await freePort()
  let clock = 1_000_000
  let used = true
  const supervisor = new Supervisor({
    servers: resolveConfig({ servers: [fixtureServer(port, { idleMinutes: 15 })] }).servers,
    logger: { info() {}, warn() {} }, inUse: () => used, logDirectory: () => tempHome(t),
    now: () => clock,
  })
  t.after(() => supervisor.stopOwned())
  await supervisor.touch('fixture')
  const pid = supervisor.states.get('fake').child.pid
  clock += 14 * 60_000
  used = false
  supervisor.sweep()
  await sleep(200)
  assert.ok(alive(pid), 'inside the idle window')
  clock += 2 * 60_000
  used = true
  supervisor.sweep()
  await sleep(200)
  assert.ok(alive(pid), 'a live session still selects the provider')
  used = false
  supervisor.sweep()
  assert.ok(await until(() => !alive(pid)), 'idle and unused: stopped')
  assert.ok(await until(() => supervisor.states.get('fake').child === undefined))

  // idleMinutes 0 never idles out.
  const port2 = await freePort()
  const forever = new Supervisor({
    servers: resolveConfig({ servers: [fixtureServer(port2, { idleMinutes: 0 })] }).servers,
    logger: { info() {}, warn() {} }, inUse: () => false, logDirectory: () => tempHome(t), now: () => clock,
  })
  t.after(() => forever.stopOwned())
  await forever.touch('fixture')
  clock += 365 * 86_400_000
  forever.sweep()
  await sleep(200)
  assert.ok(alive(forever.states.get('fake').child.pid))
})

test('a crashed server starts again on the next use', { timeout: 30_000 }, async (t) => {
  const port = await freePort()
  const supervisor = new Supervisor({
    servers: resolveConfig({ servers: [fixtureServer(port)] }).servers,
    logger: { info() {}, warn() {} }, inUse: () => false, logDirectory: () => tempHome(t),
  })
  t.after(() => supervisor.stopOwned())
  await supervisor.touch('fixture')
  const first = supervisor.states.get('fake').child.pid
  process.kill(first, 'SIGKILL')
  assert.ok(await until(() => supervisor.states.get('fake').child === undefined))
  await supervisor.touch('fixture')
  const second = supervisor.states.get('fake').child.pid
  assert.notEqual(second, first)
  assert.equal(await healthy(`http://127.0.0.1:${port}/v1/models`), true)
})

test('a server that never gets healthy is stopped at its deadline, and a missing command is reported', { timeout: 30_000 }, async (t) => {
  const port = await freePort()
  const warnings = []
  const dir = tempHome(t)
  const supervisor = new Supervisor({
    servers: resolveConfig({ servers: [
      fixtureServer(port, { startupTimeoutMs: 1_000, env: { FAKE_NO_LISTEN: '1' } }),
      { ...fixtureServer(port, { id: 'missing', providers: ['nothing'] }), command: '/nonexistent/deepsea-test-command' },
    ] }).servers,
    logger: { info() {}, warn: m => warnings.push(m) }, inUse: () => false, logDirectory: server => join(dir, server.id),
    pollMs: 100,
  })
  t.after(() => supervisor.stopOwned())
  await supervisor.touch('fixture')
  assert.match(warnings[0], /"fake" did not become healthy within 1000 ms \(see .*\.log\)/)
  assert.ok(await until(() => supervisor.states.get('fake').child === undefined), 'the stuck process is stopped')

  await supervisor.touch('nothing')
  assert.ok(warnings.some(m => /"missing" failed to spawn: .*ENOENT/.test(m)))
  assert.ok(warnings.some(m => /could not start "missing": "missing" exited during startup/.test(m)))
  assert.ok(readdirSync(join(dir, 'missing')).some(f => /-failed\.log$/.test(f)))
  assert.equal(supervisor.states.get('missing').child, undefined)
})

test('stop escalates to SIGKILL when the server ignores SIGTERM', { timeout: 30_000 }, async (t) => {
  const port = await freePort()
  const supervisor = new Supervisor({
    servers: resolveConfig({ servers: [fixtureServer(port, { env: { FAKE_IGNORE_TERM: '1' } })] }).servers,
    logger: { info() {}, warn() {} }, inUse: () => false, logDirectory: () => tempHome(t), killGraceMs: 300,
  })
  await supervisor.touch('fixture')
  const child = supervisor.states.get('fake').child
  supervisor.stopOwned()
  assert.ok(await until(() => !alive(child.pid)))
  assert.ok(await until(() => child.signalCode === 'SIGKILL'))
})
