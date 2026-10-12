/**
 * The whole plugin (apply) against a fake DSH and the fake tailscale CLI
 * (fixtures/fake-tailscale.mjs) in a scratch home: never the real CLI, never
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

const dir = mkdtempSync(join(tmpdir(), 'deepsea-host-tailscale-apply-'))
const home = join(dir, 'home')
const cli = join(dir, 'tailscale')
copyFileSync(new URL('./fixtures/fake-tailscale.mjs', import.meta.url), cli)
writeFileSync(join(dir, 'package.json'), '{"type":"module"}')
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
const write = state => locked(() => put(state))
const change = patch => locked(() => put({ ...read(), ...patch, calls: [] }))
const handlers = () => read().web?.[KEY]?.Handlers ?? {}
const statusReads = () => read().calls.filter(call => call[0] === 'status').length

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

let backend
let proxyPort
let plugin
/** The control channel's handler, as the plugin registers it on DSH's web server; served on demand. */
let controlHandler
let controlServer
const logs = []
const disposers = []

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
const admitted = async login => (await viaServe(login)).status === 200

/** The Settings section's call on the control channel (DSH's own gate passes everything here). */
const control = async (endpoint) => {
  if (controlServer === undefined) {
    controlServer = createServer(controlHandler)
    await new Promise(resolve => controlServer.listen(0, '127.0.0.1', resolve))
  }
  return post(endpoint)
}
const post = endpoint => new Promise((resolve, reject) => {
  const req = httpRequest({ hostname: '127.0.0.1', port: controlServer.address().port, method: 'POST', path: `/deepsea-tailscale/${endpoint}` }, (res) => {
    let body = ''
    res.on('data', chunk => { body += chunk })
    res.on('end', () => resolve(JSON.parse(body).result))
  })
  req.on('error', reject)
  req.end(JSON.stringify({ type: 'client-request', rpcId: '1', method: endpoint, payload: {} }))
})

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
  proxyPort = await freePort()
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'variant.yml'), 'id: lab\nserve: true\nservePath: /deepsea-lab\n')
  write({ status: stopped })
  process.env.DSH_HOME = home
  delete process.env.DEEPSEA_RELAY
  plugin = await import('../index.js')
  plugin.REFRESH_MS.waiting = 50
  plugin.REFRESH_MS.running = 50
  const ctx = {
    logger: { info: message => logs.push(message), warn: message => logs.push(message) },
    webServer: {
      port: backend.address().port,
      register: (route) => { controlHandler = route.handler; return () => controlServer?.close() },
      registerUpgrade: () => () => {},
    },
    connection: { authenticatedUrl: base => `${base}/?token=${LAUNCH_TOKEN}`, requestRejection: () => undefined },
    effect: (fn) => { disposers.push(fn()) },
    provide: () => {},
  }
  plugin.apply(ctx, { proxyPort, tailscalePath: cli, identityOperators: true, loopbackForward: 'admitted' })
  await until('the boot', () => logs.some(line => line.includes('not published')))
})

after(async () => {
  for (const dispose of disposers.reverse()) await dispose?.()
  backend.closeAllConnections()
  await new Promise(resolve => backend.close(resolve))
  rmSync(dir, { recursive: true, force: true })
})

describe('Tailscale changes state while the server runs', () => {
  it('started while Tailscale was stopped: nothing published, nobody admitted by identity', async () => {
    assert.ok(logs.some(line => line === 'host-tailscale: /deepsea-lab not published (unavailable: not-running); published when Tailscale runs'), logs.join('\n'))
    assert.deepEqual(handlers(), {})
    assert.ok(!read().calls.some(call => call.includes('--bg')))
    const answer = await viaServe()
    assert.equal(answer.status, 401, 'the node\'s own login is not known yet')
  })

  it('Tailscale comes up: the path is published and the owner admitted, without a restart', async () => {
    change({ status: running })
    await until('the path', () => handlers()['/deepsea-lab'] !== undefined)
    assert.deepEqual(handlers()['/deepsea-lab'], { Proxy: `http://127.0.0.1:${String(proxyPort)}` })
    await until('the owner', () => admitted(OWNER))
    assert.equal(JSON.parse((await viaServe()).body).login, OWNER)
    assert.equal(await admitted('stranger@example.com'), false)
    assert.equal(read().calls.filter(call => call.includes('--bg')).length, 1, 'published once')
  })

  it('while it runs, a path removed by hand stays removed', async () => {
    change({ web: {} })
    const before = statusReads()
    await until('two re-reads', () => statusReads() >= before + 2)
    assert.deepEqual(handlers(), {})
  })

  it('a relogin: the new login is admitted and the old one no longer is', async () => {
    change({ status: runningAs('Other@Example.com') })
    await until('the new login', () => admitted('other@example.com'))
    assert.equal(await admitted(OWNER), false)
    change({ status: running })
    await until('the owner again', () => admitted(OWNER))
  })

  it('Tailscale goes away and comes back: the path is published again', async () => {
    const waits = () => logs.filter(line => line.includes('not published (unavailable: daemon-unreachable)')).length
    const before = waits()
    change({ down: true })
    await until('the plugin to see Tailscale gone', () => waits() > before)
    change({ down: false, web: {}, status: stopped })
    await until('a re-read', () => statusReads() > 0)
    change({ status: running })
    await until('the path', () => handlers()['/deepsea-lab'] !== undefined)
    await until('the owner', () => admitted(OWNER))
  })

  it('an operator who removed the path: Tailscale coming up again publishes nothing', async () => {
    const removed = await control('disable')
    assert.equal(removed.ok, true, JSON.stringify(removed))
    assert.deepEqual(handlers(), {})
    change({ status: stopped })
    await until('a re-read', () => statusReads() > 0)
    change({ status: running })
    const before = statusReads()
    await until('two re-reads', () => statusReads() >= before + 2)
    assert.deepEqual(handlers(), {})
    assert.ok(!read().calls.some(call => call.includes('--bg')))
    assert.equal((await control('enable')).ok, true)
    assert.ok(handlers()['/deepsea-lab'] !== undefined)
  })
})
