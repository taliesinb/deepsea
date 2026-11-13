/**
 * The whole plugin (apply) against a fake DSH and the fake tailscale CLI
 * (fixtures/fake-tailscale.mjs) in scratch homes: never the real CLI, never
 * a real home. Tailscale changes state while the server runs: it starts
 * stopped, comes up, relogs, goes away and comes back.
 */
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

const LAUNCH_TOKEN = 'launch-token-apply'
const DSH_COOKIE = 'dsh-auth-apply=v1'
const NAME = 'node.example.ts.net'
const KEY = `${NAME}:443`
const OWNER = 'user@example.com'
const SELF_ADDRESS = '100.100.100.1'

const runningAs = login => ({ BackendState: 'Running', Self: { DNSName: `${NAME}.`, UserID: 7, TailscaleIPs: [SELF_ADDRESS], Tags: [] }, User: { 7: { LoginName: login } } })
const running = runningAs('User@Example.com')
/** Stopped (or still starting): tailscaled knows the node's name, not yet whose node it is. */
const stopped = { BackendState: 'Stopped', Self: { DNSName: `${NAME}.`, UserID: 7, TailscaleIPs: [] } }

const freePort = () => new Promise((resolve) => {
  const probe = createServer()
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)) })
})
const until = async (what, test, timeout = 5_000) => {
  const end = Date.now() + timeout
  while (!(await test())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

const root = mkdtempSync(join(tmpdir(), 'deepsea-host-tailscale-apply-'))
let backend
let plugin

before(async () => {
  backend = createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    if (url.pathname === '/' && url.searchParams.get('token') === LAUNCH_TOKEN) {
      res.writeHead(303, { location: './', 'set-cookie': `${DSH_COOKIE}; Path=/; HttpOnly` })
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ login: req.headers['x-deepsea-tailscale-login'] }))
  })
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve))
  delete process.env.DEEPSEA_RELAY
  plugin = await import('../index.js')
})

after(async () => {
  backend.closeAllConnections()
  await new Promise(resolve => backend.close(resolve))
  rmSync(root, { recursive: true, force: true })
})

/**
 * One server: a home of its own (variant `lab`, Serve path `/deepsea-lab`), a
 * fake CLI of its own whose state starts as `initial`, and the plugin applied
 * with a fake DSH context.
 */
async function startServer(id, initial) {
  const dir = join(root, id)
  const home = join(dir, 'home')
  const cli = join(dir, 'tailscale')
  mkdirSync(home, { recursive: true })
  copyFileSync(new URL('./fixtures/fake-tailscale.mjs', import.meta.url), cli)
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}')
  writeFileSync(join(home, 'variant.yml'), 'id: lab\nserve: true\nservePath: /deepsea-lab\n')
  const stateFile = `${cli}.state.json`
  const read = () => JSON.parse(readFileSync(stateFile, 'utf8'))
  /** Under the fake's lock and atomic, so a fake CLI run neither reads half a file nor writes over a change. */
  const locked = (fn) => {
    const end = Date.now() + 5_000
    for (;;) {
      try { mkdirSync(`${stateFile}.lock`); break } catch (error) {
        if (error?.code !== 'EEXIST' || Date.now() > end) throw error
      }
    }
    try { fn() } finally { rmdirSync(`${stateFile}.lock`) }
  }
  const put = (state) => {
    writeFileSync(`${stateFile}.test.tmp`, JSON.stringify(state))
    renameSync(`${stateFile}.test.tmp`, stateFile)
  }
  locked(() => put(initial))
  const proxyPort = await freePort()
  const logs = []
  const disposers = []
  /** The control channel's handler, as the plugin registers it on DSH's web server; served on demand. */
  let controlHandler
  let controlServer
  process.env.DSH_HOME = home
  plugin.apply({
    logger: { info: message => logs.push(message), warn: message => logs.push(message) },
    webServer: {
      port: backend.address().port,
      register: (route) => { controlHandler = route.handler; return () => controlServer?.close() },
      registerUpgrade: () => () => {},
    },
    connection: { authenticatedUrl: base => `${base}/?token=${LAUNCH_TOKEN}`, requestRejection: () => undefined },
    effect: (fn) => { disposers.push(fn()) },
    provide: () => {},
  }, { proxyPort, tailscalePath: cli, identityOperators: true, loopbackForward: 'admitted' })

  /** A request as Tailscale Serve relays it from this very node, with `login` injected. */
  const viaServe = (login = OWNER, { path = '/api/whoami', headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1', port: proxyPort, path,
      headers: { 'host': NAME, 'x-forwarded-host': NAME, 'x-forwarded-proto': 'https', 'x-forwarded-for': SELF_ADDRESS, ...(login === undefined ? {} : { 'tailscale-user-login': login }), ...headers },
    }, (res) => {
      let body = ''
      res.on('data', chunk => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end()
  })
  const post = endpoint => new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: controlServer.address().port, method: 'POST', path: `/deepsea-tailscale/${endpoint}` }, (res) => {
      let body = ''
      res.on('data', chunk => { body += chunk })
      res.on('end', () => resolve(JSON.parse(body).result))
    })
    req.on('error', reject)
    req.end(JSON.stringify({ type: 'client-request', rpcId: '1', method: endpoint, payload: {} }))
  })
  return {
    proxyPort,
    logs,
    read,
    change: patch => locked(() => put({ ...read(), ...patch, calls: [] })),
    handlers: () => read().web?.[KEY]?.Handlers ?? {},
    statusReads: () => read().calls.filter(call => call[0] === 'status').length,
    viaServe,
    admitted: async login => (await viaServe(login)).status === 200,
    /** The Settings section's call on the control channel (DSH's own gate passes everything here). */
    control: async (endpoint) => {
      if (controlServer === undefined) {
        controlServer = createServer(controlHandler)
        await new Promise(resolve => controlServer.listen(0, '127.0.0.1', resolve))
      }
      return post(endpoint)
    },
    stop: async () => { for (const dispose of disposers.reverse()) await dispose?.() },
  }
}

describe('Tailscale changes state while the server runs', () => {
  let s
  before(async () => {
    plugin.REFRESH_MS.waiting = 50
    plugin.REFRESH_MS.running = 50
    s = await startServer('changes', { status: stopped })
    await until('the boot', () => s.logs.some(line => line.includes('not published')))
  })
  after(() => s.stop())

  it('started while Tailscale was stopped: nothing published, nobody admitted by identity', async () => {
    assert.ok(s.logs.some(line => line === 'host-tailscale: /deepsea-lab not published (unavailable: not-running); published when Tailscale runs'), s.logs.join('\n'))
    assert.deepEqual(s.handlers(), {})
    assert.ok(!s.read().calls.some(call => call.includes('--bg')))
    const answer = await s.viaServe()
    assert.equal(answer.status, 401, 'the node\'s own login is not known yet')
    assert.equal(answer.body, 'unauthorized: Tailscale is still starting on this machine. Try again in a few seconds.\n')
  })

  it('Tailscale comes up: the path is published and the owner admitted, without a restart', async () => {
    s.change({ status: running })
    await until('the path', () => s.handlers()['/deepsea-lab'] !== undefined)
    assert.deepEqual(s.handlers()['/deepsea-lab'], { Proxy: `http://127.0.0.1:${String(s.proxyPort)}` })
    await until('the owner', () => s.admitted(OWNER))
    assert.equal(JSON.parse((await s.viaServe()).body).login, OWNER)
    const stranger = await s.viaServe('stranger@example.com')
    assert.equal(stranger.status, 401)
    assert.match(stranger.body, /Scan the QR code/)
    assert.equal(s.read().calls.filter(call => call.includes('--bg')).length, 1, 'published once')
  })

  it('while it runs, a path removed by hand stays removed', async () => {
    s.change({ web: {} })
    const before = s.statusReads()
    await until('two re-reads', () => s.statusReads() >= before + 2)
    assert.deepEqual(s.handlers(), {})
  })

  it('a relogin: the new login is admitted and the old one no longer is', async () => {
    s.change({ status: runningAs('Other@Example.com') })
    await until('the new login', () => s.admitted('other@example.com'))
    assert.equal(await s.admitted(OWNER), false)
    s.change({ status: running })
    await until('the owner again', () => s.admitted(OWNER))
  })

  it('Tailscale goes away and comes back: the path is published again', async () => {
    const waits = () => s.logs.filter(line => line.includes('not published (unavailable: daemon-unreachable)')).length
    const before = waits()
    s.change({ down: true })
    await until('the plugin to see Tailscale gone', () => waits() > before)
    s.change({ down: false, web: {}, status: stopped })
    await until('a re-read', () => s.statusReads() > 0)
    s.change({ status: running })
    await until('the path', () => s.handlers()['/deepsea-lab'] !== undefined)
    await until('the owner', () => s.admitted(OWNER))
  })

  it('an operator who removed the path: Tailscale coming up again publishes nothing', async () => {
    const removed = await s.control('disable')
    assert.equal(removed.ok, true, JSON.stringify(removed))
    assert.deepEqual(s.handlers(), {})
    s.change({ status: stopped })
    await until('a re-read', () => s.statusReads() > 0)
    s.change({ status: running })
    const before = s.statusReads()
    await until('two re-reads', () => s.statusReads() >= before + 2)
    assert.deepEqual(s.handlers(), {})
    assert.ok(!s.read().calls.some(call => call.includes('--bg')))
    assert.equal((await s.control('enable')).ok, true)
    assert.ok(s.handlers()['/deepsea-lab'] !== undefined)
  })
})

describe('the path tailscaled kept, a server started while Tailscale was stopped (no periodic re-read in between)', () => {
  let s
  before(async () => {
    plugin.REFRESH_MS.waiting = 60_000
    plugin.REFRESH_MS.running = 60_000
    s = await startServer('kept', { status: stopped })
    // tailscaled kept the variant's path from an earlier run, pointing at this proxy.
    s.change({ web: { [KEY]: { Handlers: { '/deepsea-lab': { Proxy: `http://127.0.0.1:${String(s.proxyPort)}` } } } } })
    await until('the boot', () => s.logs.some(line => line.includes('not published')))
  })
  after(() => s.stop())

  it('the owner\'s first request after Tailscale comes up gets in', async () => {
    s.change({ status: running })
    const answer = await s.viaServe()
    assert.equal(answer.status, 200, answer.body)
    assert.equal(JSON.parse(answer.body).login, OWNER)
    assert.equal(s.read().calls.filter(call => call[0] === 'status').length, 1, 'one re-read, on the request')
    await until('the path checked', () => s.logs.some(line => line === `host-tailscale: https://${NAME}/deepsea-lab/ -> http://127.0.0.1:${String(s.proxyPort)}`))
    assert.ok(!s.read().calls.some(call => call.includes('--bg')), 'already published: nothing run')
  })

  it('a stranger\'s request re-reads at most every few seconds and never gets in', async () => {
    const before = s.statusReads()
    for (let i = 0; i < 5; i++) assert.equal((await s.viaServe('stranger@example.com')).status, 401)
    assert.ok(s.statusReads() - before <= 1)
  })
})
