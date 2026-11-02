/** Session owners: who drives which session, joined from the proxy headers and session bodies. */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { SessionOwners, TOKEN_LOGIN, loginOf, shortLogin } from '../owners.mjs'
import { attachClientTracker } from '../server.mjs'

describe('loginOf / shortLogin', () => {
  it('prefers the proxied login, then self, then the token marker; loopback is the node itself', () => {
    assert.equal(loginOf({ proxied: true, login: 'user@github', self: false }, 'alpha@github'), 'user@github')
    assert.equal(loginOf({ proxied: true, login: undefined, self: true }, 'alpha@github'), 'alpha@github')
    assert.equal(loginOf({ proxied: true, login: undefined, self: false }, 'alpha@github'), TOKEN_LOGIN)
    assert.equal(loginOf({ proxied: false, login: 'local', self: true }, 'alpha@github'), 'alpha@github')
    assert.equal(loginOf({ proxied: false, login: 'local', self: true }, undefined), 'local')
  })
  it('shortens logins to a tag-safe local part', () => {
    assert.equal(shortLogin('user@github'), 'user')
    assert.equal(shortLogin('Some.One+x@example.com'), 'some.one-x')
    assert.equal(shortLogin(''), undefined)
  })
})

describe('SessionOwners', () => {
  let dir
  before(async () => { dir = await mkdtemp(join(tmpdir(), 'deepsea-tailscale-test-')) })
  after(async () => { await rm(dir, { recursive: true, force: true }) })

  it('owner is the first driver, actor the latest; lookers do not take ownership; persisted and reloaded', async () => {
    let t = 100
    const file = join(dir, 'owners.json')
    const owners = new SessionOwners({ file, now: () => t++ })
    await owners.loaded
    owners.record('session-a', 'bob@x', 'session/attach')     // looking only
    owners.record('session-a', 'user@x', 'session/prompt')    // drives → owner
    owners.record('session-a', 'bob@x', 'session/prompt')     // drives later → actor
    owners.record('session-b', 'eve@x', 'session/history')    // never drove: owner by default
    owners.record('', 'x', 'session/prompt'); owners.record('session-c', undefined, 'session/prompt')
    const a = owners.of('session-a')
    assert.equal(a.owner, 'user@x'); assert.equal(a.actor, 'bob@x')
    assert.deepEqual(a.logins, { 'bob@x': 2, 'user@x': 1 })
    assert.equal(owners.of('session-b').owner, 'eve@x'); assert.equal(owners.of('session-b').actor, 'eve@x')
    assert.equal(owners.of('session-c'), undefined)
    assert.equal(owners.of('nope'), undefined)
    await owners.dispose()
    const raw = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(raw.sessions['session-a'].owner.login, 'user@x')
    const again = new SessionOwners({ file })
    await again.loaded
    assert.equal(again.of('session-a').actor, 'bob@x')
    assert.equal(again.list().length, 2)
  })
})

describe('tracker → owners', () => {
  let server, port, tracker, owners
  before(async () => {
    owners = new SessionOwners({ file: join(tmpdir(), `deepsea-tailscale-test-owners-${process.pid}.json`) })
    await owners.loaded
    server = createServer((req, res) => { req.resume(); req.on('end', () => { res.end('ok') }) })
    tracker = attachClientTracker(server, { onSession: (facts, found) => { if (found.sessionId) owners.record(found.sessionId, loginOf(facts, 'alpha@x'), found.method) } })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    port = server.address().port
  })
  after(async () => { tracker.dispose(); server.closeAllConnections(); await new Promise(r => server.close(r)); clearTimeout(owners.timer); await rm(owners.file, { force: true }) })
  const post = (path, body, headers = {}) => new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, method: 'POST', path, headers: { 'user-agent': 'x', ...headers } }, (res) => { res.resume(); res.on('end', resolve) })
    req.on('error', reject); req.end(body)
  })
  it('attributes a proxied prompt to its login and a loopback prompt to the node', async () => {
    const proxied = { 'x-deepsea-tailscale': '1', 'x-deepsea-tailscale-admitted': 'user', 'x-deepsea-tailscale-login': 'user@x' }
    await post('/api/session/prompt', JSON.stringify({ type: 'client-request', payload: { args: { sessionId: 'session-p', requestId: 'r', mode: 'queue', content: [] } } }), proxied)
    await post('/api/session/prompt', JSON.stringify({ type: 'client-request', payload: { args: { sessionId: 'session-q' } } }))
    await new Promise(r => setTimeout(r, 20))
    assert.equal(owners.of('session-p').owner, 'user@x')
    assert.equal(owners.of('session-q').owner, 'alpha@x')
  })
})
