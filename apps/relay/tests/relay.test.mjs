import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRelay, isTailnetAddress, isTailnetRequest, loginShell, parseCommandLine, parseRequestHead, standingToken } from '../relay.mjs'

const RELAY = fileURLToPath(new URL('../relay.mjs', import.meta.url))
const made = []
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), 'deepsea-relay-test-')); made.push(dir); return dir }
test.after(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }) })

const freePort = () => new Promise((resolve) => {
  const server = createTcpServer().listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)) })
})

/** An HTTP server answering `<name> <path>` (and the request headers it saw, as JSON). */
const fakeServer = (name, port) => new Promise((resolve) => {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ name, path: req.url, headers: req.headers }))
  }).listen(port ?? 0, '127.0.0.1', () => resolve(server))
})

// A fresh connection per request: the relay routes per connection, by its first request.
const get = (port, path, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, path, method, agent: false, headers: { accept: 'text/html', ...headers } }, (res) => {
    let body = ''
    res.on('data', (c) => { body += c })
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
  })
  req.on('error', reject)
  req.end()
})

/** A stand-in child process: `exit()` ends it. */
const fakeChild = () => Object.assign(new EventEmitter(), { pid: 4242, exitCode: null, exit(code = 1) { this.exitCode = code; this.emit('exit', code, null) } })

test('pure parts: tailnet addresses and requests, launch tokens, request heads, the command line', () => {
  assert.equal(isTailnetAddress('100.101.102.103'), true)
  assert.equal(isTailnetAddress('100.128.0.1'), false)
  assert.equal(isTailnetAddress('fd7a:115c:a1e0::1'), true)
  assert.equal(isTailnetAddress('127.0.0.1'), false)
  assert.equal(isTailnetRequest({ headers: { 'x-forwarded-for': '203.0.113.9, 100.64.0.7' } }), true)
  assert.equal(isTailnetRequest({ headers: { 'x-forwarded-for': '100.64.0.7, 127.0.0.1' } }), false)
  assert.equal(isTailnetRequest({ headers: { 'tailscale-user-login': 'user@example.com' } }), true)
  assert.equal(isTailnetRequest({ headers: {} }), false)
  const head = parseRequestHead(Buffer.from('GET /a?b=1 HTTP/1.1\r\nHost: x\r\nAccept: text/html\r\n\r\nbody'))
  assert.deepEqual([head.method, head.target, head.headers.accept], ['GET', '/a?b=1', 'text/html'])
  assert.equal(parseRequestHead(Buffer.from('GET / HTTP/1.1\r\nHost: x\r\n')), undefined)
  const args = parseCommandLine(['--variant', 'lab', '--home', '/h', '--listen', '127.0.0.1:3213', '--dsh', '127.0.0.1:3210', '--log-dir', '/l', '--', 'node', 'bin.ts', '--port', '3210'])
  assert.deepEqual([args.variant, args.proxy, args.command], ['lab', undefined, ['node', 'bin.ts', '--port', '3210']])
  assert.throws(() => parseCommandLine(['--variant', 'lab']), /required/)
  assert.throws(() => parseCommandLine(['--bogus', 'x']), /unexpected/)
})

test('the login shell: $SHELL when POSIX, else zsh or bash (at /bin, then on PATH), else /bin/sh', () => {
  const only = (...paths) => p => paths.includes(p)
  assert.deepEqual(loginShell({ SHELL: '/usr/local/bin/zsh' }, only('/usr/local/bin/zsh')), { shell: '/usr/local/bin/zsh' })
  // NixOS: nushell as login shell, no /bin/bash, bash in the profile on PATH.
  const nix = { SHELL: '/run/current-system/sw/bin/nu', PATH: '/run/wrappers/bin:/home/u/.nix-profile/bin:/run/current-system/sw/bin' }
  assert.deepEqual(loginShell(nix, only('/run/current-system/sw/bin/nu', '/home/u/.nix-profile/bin/bash', '/run/current-system/sw/bin/bash', '/bin/sh')),
    { shell: '/home/u/.nix-profile/bin/bash', why: '/run/current-system/sw/bin/nu is not a POSIX shell' })
  assert.deepEqual(loginShell({ SHELL: '/usr/bin/fish' }, only('/usr/bin/fish', '/bin/zsh', '/bin/bash')), { shell: '/bin/zsh', why: '/usr/bin/fish is not a POSIX shell' })
  assert.deepEqual(loginShell({}, only('/bin/bash')), { shell: '/bin/bash', why: 'SHELL is not set' })
  assert.deepEqual(loginShell({ SHELL: '/x/nu', PATH: '/a:/b' }, only('/a/zsh', '/b/bash')), { shell: '/b/bash', why: '/x/nu is not a POSIX shell' })
  assert.deepEqual(loginShell({ SHELL: '/bin/zsh' }, only('/bin/sh')), { shell: '/bin/sh', why: '/bin/zsh does not exist' })
})

test('the standing token: created once, 0600, reused', () => {
  const home = scratch()
  const token = standingToken(home)
  assert.match(token, /^[A-Za-z0-9_-]{32}$/)
  assert.equal(statSync(join(home, 'relay', 'state.json')).mode & 0o777, 0o600)
  assert.equal(standingToken(home), token)
})

test('a cold start: 503 with the relay page and header, one start, then the server itself', async () => {
  const dshPort = await freePort()
  let starts = 0
  let child
  const relay = createRelay({
    listen: { host: '127.0.0.1', port: 0 }, dsh: { host: '127.0.0.1', port: dshPort }, start: () => { starts += 1; child = fakeChild(); return child }, log: () => {},
  })
  const port = await relay.listen()
  try {
    const first = await get(port, '/')
    assert.equal(first.status, 503)
    assert.equal(first.headers['x-deepsea-relay'], 'starting')
    assert.match(first.body, /Starting DeepSea…/)
    const plain = await get(port, '/api/x', { accept: 'application/json' })
    assert.equal(plain.headers['content-type'], 'text/plain; charset=utf-8')
    assert.equal(starts, 1)
    const dsh = await fakeServer('dsh', dshPort)
    const up = await get(port, '/hello')
    assert.equal(up.status, 200)
    assert.deepEqual([JSON.parse(up.body).name, JSON.parse(up.body).path], ['dsh', '/hello'])
    assert.equal(up.headers['x-deepsea-relay'], undefined)
    dsh.close()
  } finally { await relay.close() }
})

test('tailnet clients go to the proxy, are refused without one, and never start a second server', async () => {
  const dsh = await fakeServer('dsh')
  const proxy = await fakeServer('proxy')
  const tailnet = { 'x-forwarded-for': '100.100.1.2', 'tailscale-user-login': 'user@example.com' }
  const relay = createRelay({
    listen: { host: '127.0.0.1', port: 0 }, dsh: { host: '127.0.0.1', port: dsh.address().port }, proxy: { host: '127.0.0.1', port: proxy.address().port },
    start: () => { throw new Error('must not start') }, log: () => {},
  })
  const port = await relay.listen()
  const bare = createRelay({ listen: { host: '127.0.0.1', port: 0 }, dsh: { host: '127.0.0.1', port: dsh.address().port }, start: () => fakeChild(), log: () => {} })
  const barePort = await bare.listen()
  try {
    const seen = JSON.parse((await get(port, '/x', tailnet)).body)
    assert.equal(seen.name, 'proxy')
    assert.equal(seen.headers['tailscale-user-login'], 'user@example.com')
    assert.equal(JSON.parse((await get(port, '/x')).body).name, 'dsh')
    const refused = await get(barePort, '/x', tailnet)
    assert.deepEqual([refused.status, refused.headers['x-deepsea-relay']], [403, 'no-proxy'])
    proxy.close()
    const proxyDown = await get(port, '/x', tailnet)
    assert.deepEqual([proxyDown.status, proxyDown.headers['x-deepsea-relay']], [503, 'no-proxy'])
  } finally { await relay.close(); await bare.close(); dsh.close() }
})

test('a connection that closes without a request starts nothing', async () => {
  const dshPort = await freePort()
  let starts = 0
  const relay = createRelay({ listen: { host: '127.0.0.1', port: 0 }, dsh: { host: '127.0.0.1', port: dshPort }, start: () => { starts += 1; return fakeChild() }, log: () => {} })
  const port = await relay.listen()
  try {
    const { connect } = await import('node:net')
    await new Promise((resolve) => { const s = connect({ host: '127.0.0.1', port }, () => { s.end(); resolve() }) })
    await new Promise(r => setTimeout(r, 5500))
    assert.equal(starts, 0)
  } finally { await relay.close() }
})

test('a failure streak stops the retries and says so', async () => {
  const dshPort = await freePort()
  let starts = 0
  const relay = createRelay({
    listen: { host: '127.0.0.1', port: 0 }, dsh: { host: '127.0.0.1', port: dshPort },
    start: () => { starts += 1; const child = fakeChild(); setImmediate(() => child.exit(1)); return child },
    log: () => {}, logPath: () => '/logs/server/latest.log', minSpawnIntervalMs: 0, maxFailures: 3,
  })
  const port = await relay.listen()
  try {
    for (let i = 0; i < 3; i++) { await get(port, '/'); await new Promise(r => setTimeout(r, 20)) }
    const failed = await get(port, '/')
    assert.equal(failed.headers['x-deepsea-relay'], 'failed')
    assert.match(failed.body, /DeepSea could not start/)
    assert.match(failed.body, /Log: \/logs\/server\/latest\.log/)
    assert.equal(starts, 3)
  } finally { await relay.close() }
})

test('the command line: a real start through the login shell, logs, the environment (the standing token as launch token), and SIGTERM', async () => {
  const dir = scratch()
  const home = join(dir, 'home')
  const logs = join(dir, 'logs')
  const [listen, dshPort] = [await freePort(), await freePort()]
  const fake = join(dir, 'fake-dsh.mjs')
  writeFileSync(fake, `import { createServer } from 'node:http'
const port = Number(process.argv[2])
createServer((req, res) => res.end(JSON.stringify({ path: req.url, relay: process.env.DEEPSEA_RELAY, variant: process.env.DEEPSEA_VARIANT, home: process.env.DSH_HOME, token: process.env.DSH_LAUNCH_TOKEN })))
  .listen(port, '127.0.0.1', () => console.log('dsh web: http://127.0.0.1:' + port + '/?token=' + process.env.DSH_LAUNCH_TOKEN))
process.on('SIGTERM', () => process.exit(0))
`)
  const relay = spawn(process.execPath, [RELAY, '--variant', 'lab', '--home', home, '--listen', `127.0.0.1:${listen}`, '--dsh', `127.0.0.1:${dshPort}`, '--log-dir', logs, '--', process.execPath, fake, String(dshPort)], { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  relay.stderr.on('data', (c) => { stderr += c })
  try {
    for (let i = 0; i < 50 && !stderr.includes('listening'); i++) await new Promise(r => setTimeout(r, 100))
    const cold = await get(listen, '/')
    assert.equal(cold.headers['x-deepsea-relay'], 'starting')
    let up
    for (let i = 0; i < 50; i++) {
      up = await get(listen, '/probe')
      if (up.status === 200) break
      await new Promise(r => setTimeout(r, 100))
    }
    const facts = JSON.parse(up.body)
    const standing = JSON.parse(readFileSync(join(home, 'relay', 'state.json'), 'utf8')).token
    assert.deepEqual([facts.path, facts.relay, facts.variant, facts.home, facts.token], ['/probe', `http://127.0.0.1:${listen}/`, 'lab', home, standing])
    const serverLogs = readdirSync(join(logs, 'server')).filter(f => f.endsWith('.log') && f !== 'latest.log')
    assert.equal(serverLogs.length, 1)
    assert.match(readFileSync(join(logs, 'server', serverLogs[0]), 'utf8'), /^\S+ io\.github\.taliesinb\.deepsea\.lab server pid \d+ started by the relay/)
    assert.ok(existsSync(join(logs, 'relay', 'latest.log')))
    relay.kill('SIGTERM')
    await new Promise(resolve => relay.once('exit', resolve))
    const after = await get(dshPort, '/').catch(error => error.code)
    assert.equal(after, 'ECONNREFUSED')
  } finally { if (relay.exitCode === null) relay.kill('SIGKILL') }
})
