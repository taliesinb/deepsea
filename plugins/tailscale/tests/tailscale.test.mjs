/**
 * The Serve manager against a fake tailscale CLI (fixtures/fake-tailscale.mjs),
 * copied into a scratch directory with its own state: never the real CLI.
 */
import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, describe, it } from 'node:test'
import { createServeManager, isOwnTarget, isTailscaleAddress, routeUrl, selfIdentity, targetOf } from '../tailscale.mjs'

const dir = mkdtempSync(join(tmpdir(), 'deepsea-tailscale-test-'))
const cli = join(dir, 'tailscale')
copyFileSync(new URL('./fixtures/fake-tailscale.mjs', import.meta.url), cli)
writeFileSync(join(dir, 'package.json'), '{"type":"module"}')
const stateFile = `${cli}.state.json`
after(() => rmSync(dir, { recursive: true, force: true }))

const write = state => writeFileSync(stateFile, JSON.stringify(state))
const read = () => JSON.parse(readFileSync(stateFile, 'utf8'))
const handlers = () => read().web['node.example.ts.net:443']?.Handlers ?? {}
const RELAY = 'http://127.0.0.1:3203/'
const PROXY = 'http://127.0.0.1:3204'

/** A manager the way index.js makes one: relay target, own ports relay and proxy. */
const manager = (servePath = '/deepsea-lab', target = RELAY) => createServeManager({
  cliPath: cli, servePath, target: () => target === undefined ? undefined : targetOf(target), ownPorts: () => [3203, 3204],
})

describe('Serve manager (fake CLI)', () => {
  beforeEach(() => { write({}) })

  it('with a socket of the account\'s own, every call goes to that tailscaled (--socket first)', async () => {
    const calls = []
    const run = async (binary, args) => {
      calls.push(args)
      if (args.includes('status') && !args.includes('serve')) return { code: 0, stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'node-user.example.ts.net.', TailscaleIPs: ['100.64.0.9'], UserID: 7 }, User: { 7: { LoginName: 'User@Example.com' } } }), stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }
    const serve = createServeManager({ cliPath: cli, socket: '/run/user/1000/ts/tailscaled.sock', servePath: '/deepsea', target: () => targetOf(RELAY), ownPorts: () => [3203, 3204], run })
    const status = await serve.status()
    assert.deepEqual([status.state, status.dnsName, status.selfLogin, status.url], ['off', 'node-user.example.ts.net', 'user@example.com', 'https://node-user.example.ts.net/deepsea/'])
    await serve.enable()
    assert.ok(calls.length >= 3)
    for (const args of calls) assert.equal(args[0], '--socket=/run/user/1000/ts/tailscaled.sock')
    assert.ok(calls.some(args => args.join(' ') === '--socket=/run/user/1000/ts/tailscaled.sock serve --bg --yes --https=443 --set-path=/deepsea http://127.0.0.1:3203'))
    const plain = []
    await createServeManager({ cliPath: cli, servePath: '/deepsea', target: () => targetOf(RELAY), ownPorts: () => [], run: async (b, args) => { plain.push(args); return { code: 1, stdout: '', stderr: '' } } }).status()
    assert.deepEqual(plain[0], ['status', '--json'])
  })

  it('without a Serve path it still reads the node, and publishes nothing', async () => {
    const serve = createServeManager({ cliPath: cli, servePath: undefined, target: () => targetOf(RELAY), ownPorts: () => [3203, 3204] })
    const status = await serve.status()
    assert.equal(status.state, 'no-path')
    assert.equal(status.dnsName, 'node.example.ts.net')
    assert.equal(status.selfLogin, 'user@example.com')
    assert.equal(await serve.enable(), 'no-path')
    assert.equal(await serve.disable(), 'no-path')
    assert.ok(read().calls.every(call => call[0] === 'status' || (call[0] === 'serve' && call[1] === 'status')))
  })

  it('publishes the relay at its own path, verifies it, and removes it again', async () => {
    const serve = manager()
    assert.equal((await serve.status()).state, 'off')
    assert.equal(await serve.enable(), 'ok')
    assert.deepEqual(handlers(), { '/deepsea-lab': { Proxy: 'http://127.0.0.1:3203' } })
    assert.deepEqual(read().calls.find(call => call.includes('--bg')), ['serve', '--bg', '--yes', '--https=443', '--set-path=/deepsea-lab', 'http://127.0.0.1:3203'])
    const status = await serve.status()
    assert.equal(status.state, 'active')
    assert.equal(status.url, 'https://node.example.ts.net/deepsea-lab/')
    assert.equal(await serve.enable(), 'ok', 'already published: nothing to do')
    assert.equal(read().calls.filter(call => call.includes('--bg')).length, 1)
    assert.equal(await serve.disable(), 'ok')
    assert.deepEqual(handlers(), {})
    assert.deepEqual(read().calls.at(-1), ['serve', '--https=443', '--set-path=/deepsea-lab', 'off'])
  })

  it('re-points its own stale mapping (the proxy, once a relay fronts the server)', async () => {
    write({ web: { 'node.example.ts.net:443': { Handlers: { '/deepsea-lab': { Proxy: PROXY } } } } })
    const serve = manager()
    assert.equal((await serve.status()).state, 'stale')
    assert.equal(await serve.enable(), 'ok')
    assert.deepEqual(handlers()['/deepsea-lab'], { Proxy: 'http://127.0.0.1:3203' })
  })

  it('never replaces or removes another variant\'s mapping, and leaves other paths alone', async () => {
    const others = { '/deepsea-lab': { Proxy: 'http://127.0.0.1:3213' }, '/deepsea': { Proxy: 'http://127.0.0.1:3203' }, '/elsewhere': { Proxy: 'http://192.0.2.5:80' } }
    write({ web: { 'node.example.ts.net:443': { Handlers: structuredClone(others) } } })
    const serve = manager()
    const status = await serve.status()
    assert.equal(status.state, 'conflict')
    assert.equal(status.mappedTarget, 'http://127.0.0.1:3213')
    assert.equal(await serve.enable(), 'conflict')
    assert.equal(await serve.disable(), 'conflict')
    assert.deepEqual(handlers(), others)
    assert.ok(!read().calls.some(call => call.includes('--bg') || call.includes('off')), 'no serve change was run')
  })

  it('reports Tailscale down, a failed serve, and a missing CLI', async () => {
    write({ down: true })
    assert.equal((await manager().status()).state, 'unavailable')
    assert.equal(await manager().enable(), 'unavailable')
    write({ failServe: true })
    assert.equal(await manager().enable(), 'failed')
    const missing = createServeManager({ cliPath: join(dir, 'nope'), servePath: '/deepsea-lab', target: () => RELAY, ownPorts: () => [] })
    assert.deepEqual([(await missing.status()).state, (await missing.status()).detail], ['unavailable', 'binary-missing'])
  })

  it('never runs serve reset or funnel', async () => {
    const serve = manager()
    await serve.enable()
    await serve.disable()
    for (const call of read().calls) {
      assert.ok(!call.includes('reset') && !call.some(arg => /funnel/i.test(arg)), call.join(' '))
    }
  })
})

describe('helpers', () => {
  it('selfIdentity: the node user\'s login (lower-cased) and addresses; none for a tagged node', () => {
    const json = { Self: { UserID: 1, TailscaleIPs: ['100.64.0.2'], Tags: [] }, User: { 1: { LoginName: 'A@Example.com' } } }
    assert.deepEqual(selfIdentity(json), { selfLogin: 'a@example.com', selfAddresses: ['100.64.0.2'] })
    assert.equal(selfIdentity({ ...json, Self: { ...json.Self, Tags: ['tag:server'] } }).selfLogin, undefined)
    assert.equal(selfIdentity({ Self: { UserID: 2 }, User: { 2: { LoginName: 'tagged-devices' } } }).selfLogin, undefined)
  })
  it('isTailscaleAddress: 100.64/10 and fd7a:115c:a1e0::/48 only', () => {
    assert.ok(isTailscaleAddress('100.64.0.1'))
    assert.ok(isTailscaleAddress('100.127.255.255'))
    assert.ok(!isTailscaleAddress('100.128.0.1'))
    assert.ok(!isTailscaleAddress('203.0.113.9'))
    assert.ok(isTailscaleAddress('fd7a:115c:a1e0::5'))
    assert.ok(isTailscaleAddress('::ffff:100.100.1.1'))
  })
  it('routeUrl, targetOf and isOwnTarget', () => {
    assert.equal(routeUrl('node.example.ts.net', '/deepsea'), 'https://node.example.ts.net/deepsea/')
    assert.equal(routeUrl('node.example.ts.net', '/'), 'https://node.example.ts.net/')
    assert.equal(targetOf('http://127.0.0.1:3203/'), 'http://127.0.0.1:3203')
    assert.ok(isOwnTarget('http://127.0.0.1:3204', [3203, 3204]))
    assert.ok(isOwnTarget('http://localhost:3203/', [3203]))
    assert.ok(!isOwnTarget('http://127.0.0.1:3213', [3203, 3204]))
    assert.ok(!isOwnTarget('https://127.0.0.1:3203', [3203]))
    assert.ok(!isOwnTarget('http://192.0.2.5:3203', [3203]))
  })
})
