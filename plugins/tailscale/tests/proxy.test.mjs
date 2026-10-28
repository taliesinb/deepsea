/**
 * Proxy gate + forwarding against a fake DSH backend. Run: `pnpm test`.
 * The fake DSH mints a cookie on `/?token=<launch>` (303) exactly like
 * client-connection's BrowserAuth, echoes request facts as JSON, and answers
 * WebSocket upgrades with a raw 101 so the passthrough can be observed.
 */
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { after, before, describe, it } from 'node:test'
import { bootstrapUpstreamCookie, canonicalAuthority, cookieValueFor, isOperatorRequest, isSelfRequest, isTailnetHost, originRejection, startProxy } from '../proxy.mjs'

const LAUNCH_TOKEN = 'launch-token-xyz'
const DSH_COOKIE = 'dsh-auth-abc=v1.payload.sig'

let backend
let backendPort
let proxy
const seen = []
let token = 'T0kenT0kenT0kenT0ken'
let allowedUsers = ['alice@example.com']
let identityOperators = false
let selfLogin = 'user@Example.com'
const SELF_ADDRESS = '100.78.174.43'

function fetchProxy(path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: proxy.port, method, path, headers }, (res) => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

/** Headers a request relayed by Tailscale Serve carries (loopback socket is implicit). */
const servePeer = (login) => ({
  'x-forwarded-for': '100.101.102.103',
  'x-forwarded-host': 'node.example.ts.net',
  'x-forwarded-proto': 'https',
  'host': 'node.example.ts.net',
  ...(login === undefined ? {} : { 'tailscale-user-login': login }),
})

before(async () => {
  backend = createServer((req, res) => {
    seen.push({ url: req.url, method: req.method, headers: req.headers })
    const url = new URL(req.url, 'http://x')
    if (url.pathname === '/' && url.searchParams.get('token') === LAUNCH_TOKEN) {
      res.writeHead(303, { location: './', 'set-cookie': `${DSH_COOKIE}; Max-Age=100; Path=/; HttpOnly; SameSite=Strict` })
      res.end()
      return
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      if (req.headers.cookie !== DSH_COOKIE) {
        res.writeHead(401)
        res.end('unauthorized')
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'leak=1' })
      res.end('<!doctype html><html><head><meta charset="utf-8"><script src="./assets/a.js"></script></head><body>shell</body></html>')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ url: req.url, headers: req.headers }))
  })
  backend.on('upgrade', (req, socket) => {
    seen.push({ url: req.url, method: 'UPGRADE', headers: req.headers })
    if (req.url.startsWith('/api/deepsea-tailscale/loopback-forward')) {
      // A refused forward (forward.mjs): status + reason header + body, before any 101.
      socket.end('HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nX-DeepSea-Forward-Error: reserved\r\nContent-Length: 9\r\nConnection: close\r\n\r\nreserved\n')
      return
    }
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: fake\r\n\r\n')
    socket.write('hello-from-dsh')
    socket.on('data', chunk => socket.write(`echo:${chunk.toString()}`))
  })
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve))
  backendPort = backend.address().port
  proxy = await startProxy({
    listenHost: '127.0.0.1',
    listenPort: 0,
    backendHost: '127.0.0.1',
    backendPort,
    connection: { authenticatedUrl: base => `${base}/?token=${LAUNCH_TOKEN}` },
    token: () => token,
    allowedUsers: () => allowedUsers,
    selfLogin: () => selfLogin,
    selfAddresses: () => [SELF_ADDRESS, 'fd7a:115c:a1e0::e33a:ae2c'],
    identityOperators: () => identityOperators,
    publicHosts: () => ['node.example.ts.net', 'node.example.ts.net:443'],
    cookieName: 'deepsea-tailscale-lab',
    controlPrefix: '/deepsea-tailscale',
    servePath: '/deepsea-lab',
  })
})

after(async () => {
  await proxy.close()
  backend.closeAllConnections()
  await new Promise(resolve => backend.close(resolve))
})

describe('upstream cookie bridge', () => {
  it('exchanges the launch token for the DSH cookie', async () => {
    const cookie = await bootstrapUpstreamCookie({ authenticatedUrl: base => `${base}/?token=${LAUNCH_TOKEN}` }, `127.0.0.1:${backendPort}`)
    assert.equal(cookie, DSH_COOKIE)
  })
})

describe('gate', () => {
  it('answers 401 to an anonymous request (HTML for a navigation, text otherwise)', async () => {
    const page = await fetchProxy('/', { headers: { accept: 'text/html' } })
    assert.equal(page.status, 401)
    assert.match(page.body, /Not signed in/)
    const api = await fetchProxy('/api/x', { method: 'POST' })
    assert.equal(api.status, 401)
    assert.equal(api.headers['content-type'], 'text/plain; charset=utf-8')
  })

  it('lets the public shell files through without credentials, GET only', async () => {
    assert.equal((await fetchProxy('/manifest.webmanifest')).status, 200)
    assert.equal((await fetchProxy('/favicon.svg')).status, 200)
    assert.equal((await fetchProxy('/manifest.webmanifest', { method: 'POST' })).status, 401)
  })

  it('exchanges the token on / for the proxy cookie and redirects into the mount', async () => {
    const res = await fetchProxy(`/?token=${token}`, { headers: servePeer() })
    assert.equal(res.status, 303)
    assert.equal(res.headers.location, '/deepsea-lab/', 'behind Serve the path is named outright (the slash-less form cannot be told apart)')
    const direct = await fetchProxy(`/?token=${token}`)
    assert.equal(direct.status, 303)
    assert.equal(direct.headers.location, './', 'on the loopback listener itself the redirect stays relative')
    const setCookie = res.headers['set-cookie'][0]
    assert.match(setCookie, /^deepsea-tailscale-lab=/)
    assert.match(setCookie, /; Path=\/deepsea-lab\/;/, 'scoped to the Serve path, so variants on one tailnet name keep their own cookies')
    assert.match(direct.headers['set-cookie'][0], /; Path=\/;/, 'directly on the listener the path is the root')
    assert.match(setCookie, /HttpOnly/)
    assert.match(setCookie, /Secure/, 'https via x-forwarded-proto marks the cookie Secure')
    assert.equal(setCookie.split(';')[0].split('=')[1], cookieValueFor(token))
  })

  it('keeps every other query parameter across the exchange (per-session `embed` links)', async () => {
    const res = await fetchProxy(`/?token=${token}&embed=session-abc`, { headers: servePeer() })
    assert.equal(res.status, 303)
    assert.equal(res.headers.location, '/deepsea-lab/?embed=session-abc')
    const direct = await fetchProxy(`/?embed=session-abc&token=${token}&x=1`)
    assert.equal(direct.status, 303)
    assert.equal(direct.headers.location, './?embed=session-abc&x=1')
  })

  it('rejects a wrong token, a token on a deep path, and a token on POST', async () => {
    assert.equal((await fetchProxy('/?token=nope')).status, 401)
    assert.equal((await fetchProxy(`/api/x?token=${token}`)).status, 401)
    assert.equal((await fetchProxy(`/?token=${token}`, { method: 'POST' })).status, 401)
  })

  it('admits the proxy cookie and forwards with DSH facts rewritten', async () => {
    seen.length = 0
    const res = await fetchProxy('/api/session.export?sessionId=1', {
      headers: {
        ...servePeer(),
        cookie: `other=1; deepsea-tailscale-lab=${cookieValueFor(token)}`,
        origin: 'https://node.example.ts.net',
        referer: 'https://node.example.ts.net/deepsea-lab/',
        'sec-fetch-site': 'same-origin',
        'tailscale-user-login': 'forged@example.com',
      },
    })
    assert.equal(res.status, 200)
    const [forwarded] = seen
    assert.equal(forwarded.url, '/api/session.export?sessionId=1')
    assert.equal(forwarded.headers.host, `127.0.0.1:${backendPort}`)
    assert.equal(forwarded.headers.origin, `http://127.0.0.1:${backendPort}`)
    assert.equal(forwarded.headers.cookie, DSH_COOKIE, 'browser cookies replaced by the DSH session cookie')
    assert.equal(forwarded.headers.referer, undefined)
    assert.equal(forwarded.headers['tailscale-user-login'], undefined, 'identity headers never reach DSH')
    assert.equal(forwarded.headers['x-forwarded-for'], '100.101.102.103')
    assert.equal(forwarded.headers['x-forwarded-host'], 'node.example.ts.net')
    assert.equal(forwarded.headers['x-forwarded-proto'], 'https')
    assert.equal(forwarded.headers['x-deepsea-tailscale'], '1')
    assert.equal(res.headers['set-cookie'], undefined, 'upstream set-cookie is never relayed')
  })

  it('admits an allowlisted Tailscale login from a Serve peer without any cookie', async () => {
    seen.length = 0
    const res = await fetchProxy('/api/whoami', { headers: servePeer('Alice@Example.com') })
    assert.equal(res.status, 200)
    assert.equal(seen[0].headers['tailscale-user-login'], undefined)
  })

  it('refuses a login that is not allowlisted, or whose forwarding facts are not a Serve peer', async () => {
    assert.equal((await fetchProxy('/api/whoami', { headers: servePeer('mallory@example.com') })).status, 401)
    // Right login, but the rightmost x-forwarded-for is not a tailnet address.
    assert.equal((await fetchProxy('/api/whoami', { headers: { ...servePeer('alice@example.com'), 'x-forwarded-for': '203.0.113.9' } })).status, 401)
    // Right login, no forwarding facts at all (a local process talking to the listener directly).
    assert.equal((await fetchProxy('/api/whoami', { headers: { 'tailscale-user-login': 'alice@example.com' } })).status, 401)
    const saved = allowedUsers
    allowedUsers = []
    assert.equal((await fetchProxy('/api/whoami', { headers: servePeer('alice@example.com') })).status, 401, 'empty allowlist admits nobody by login')
    allowedUsers = saved
  })

  it('always admits this node\'s own login, even with an empty allowlist', async () => {
    const saved = allowedUsers
    allowedUsers = []
    assert.equal((await fetchProxy('/api/whoami', { headers: servePeer('user@example.com') })).status, 200)
    assert.equal((await fetchProxy('/api/whoami', { headers: { ...servePeer('user@example.com'), 'x-forwarded-for': '203.0.113.9' } })).status, 401, 'still needs Serve forwarding facts')
    const savedSelf = selfLogin
    selfLogin = undefined
    assert.equal((await fetchProxy('/api/whoami', { headers: servePeer('user@example.com') })).status, 401, 'a tagged node has no self login')
    selfLogin = savedSelf
    allowedUsers = saved
  })

  it('refuses an unknown Host (421) and a cross-origin Origin (403) before admission', async () => {
    const rebinding = await fetchProxy('/api/whoami', { headers: { ...servePeer('alice@example.com'), host: 'evil.example' } })
    assert.equal(rebinding.status, 421)
    const cross = await fetchProxy('/api/whoami', { method: 'POST', headers: { ...servePeer('alice@example.com'), origin: 'https://evil.example' } })
    assert.equal(cross.status, 403)
    const same = await fetchProxy('/api/whoami', { method: 'POST', headers: { ...servePeer('alice@example.com'), origin: 'https://node.example.ts.net' } })
    assert.equal(same.status, 200)
    const withPort = await fetchProxy('/api/whoami', { headers: { ...servePeer('alice@example.com'), host: 'node.example.ts.net:443', origin: 'https://node.example.ts.net:443' } })
    assert.equal(withPort.status, 200)
    const loopback = await fetchProxy('/api/whoami', { headers: { cookie: `deepsea-tailscale-lab=${cookieValueFor(token)}`, origin: `http://127.0.0.1:${proxy.port}` } })
    assert.equal(loopback.status, 200, 'the listener\'s own authority is always allowed')
  })

  it('forwards the control channel only for this node\'s own admitted requests', async () => {
    seen.length = 0
    const res = await fetchProxy('/deepsea-tailscale/status', { method: 'POST', headers: { ...servePeer('alice@example.com'), 'content-type': 'application/json' }, body: '{}' })
    assert.equal(res.status, 403, 'another device: refused')
    assert.equal(seen.length, 0)
    const anonymousSelf = await fetchProxy('/deepsea-tailscale/status', { method: 'POST', headers: { ...servePeer(), 'x-forwarded-for': SELF_ADDRESS }, body: '{}' })
    assert.equal(anonymousSelf.status, 401, 'this node but not admitted: 401')
    assert.equal(seen.length, 0)
    const self = await fetchProxy('/deepsea-tailscale/status', { method: 'POST', headers: { ...servePeer('user@example.com'), 'x-forwarded-for': SELF_ADDRESS, 'x-deepsea-tailscale-login': 'forged@example.com' }, body: '{}' })
    assert.equal(self.status, 200)
    assert.equal(seen.length, 1)
    assert.equal(seen[0].url, '/deepsea-tailscale/status')
    assert.equal(seen[0].headers['x-deepsea-tailscale-login'], 'user@example.com', 'admitted login, client copy dropped')
    assert.equal(seen[0].headers['x-deepsea-tailscale-admitted'], 'user')
    assert.equal(seen[0].headers['x-deepsea-tailscale-self'], '1')
  })

  it('tags forwarded requests with how they were admitted', async () => {
    seen.length = 0
    await fetchProxy('/api/x', { headers: { cookie: `deepsea-tailscale-lab=${cookieValueFor(token)}` } })
    assert.equal(seen[0].headers['x-deepsea-tailscale-admitted'], 'cookie')
    assert.equal(seen[0].headers['x-deepsea-tailscale-login'], undefined)
    assert.equal(seen[0].headers['x-deepsea-tailscale-self'], undefined)
  })

  it('invalidates cookies when the token rotates', async () => {
    const old = cookieValueFor(token)
    token = 'R0tatedR0tatedR0tated'
    assert.equal((await fetchProxy('/api/whoami', { headers: { cookie: `deepsea-tailscale-lab=${old}` } })).status, 401)
    assert.equal((await fetchProxy('/api/whoami', { headers: { cookie: `deepsea-tailscale-lab=${cookieValueFor(token)}` } })).status, 200)
  })
})

describe('index response', () => {
  it('injects the trailing-slash guard at the top of <head> and fixes content-length', async () => {
    const res = await fetchProxy('/', { headers: { ...servePeer('alice@example.com'), 'accept-encoding': 'gzip' } })
    assert.equal(res.status, 200)
    assert.match(res.body, /<head><script data-deepsea-tailscale>/)
    assert.match(res.body, /location\.replace\(p\+"\/"/)
    assert.equal(Number(res.headers['content-length']), Buffer.byteLength(res.body))
    assert.equal(seen.at(-1).headers['accept-encoding'], 'identity', 'index is requested uncompressed so it can be rewritten')
    assert.doesNotMatch(res.body, /ownsHost/, 'another device is not the operator\'s machine')
  })

  it('marks the node\'s own requests as owning the host (ctx.connection.isLoopback)', async () => {
    const res = await fetchProxy('/', { headers: { ...servePeer('user@example.com'), 'x-forwarded-for': SELF_ADDRESS } })
    assert.equal(res.status, 200)
    assert.match(res.body, /__DSH_TRANSPORT__=Object\.assign\(globalThis\.__DSH_TRANSPORT__\|\|\{\},\{ownsHost:true\}\)/)
    assert.equal(Number(res.headers['content-length']), Buffer.byteLength(res.body))
  })
})

describe('pure helpers', () => {
  const fake = (headers, remoteAddress = '127.0.0.1') => ({ headers, socket: { remoteAddress } })
  it('canonicalAuthority: explicit default ports, lower-cased hostnames', () => {
    assert.equal(canonicalAuthority('Node.example.ts.net'), 'node.example.ts.net:443')
    assert.equal(canonicalAuthority('node.example.ts.net:443'), 'node.example.ts.net:443')
    assert.equal(canonicalAuthority('https://node.example.ts.net:443/x'), 'node.example.ts.net:443')
    assert.equal(canonicalAuthority('127.0.0.1:3084', 'http'), '127.0.0.1:3084')
    assert.equal(canonicalAuthority('http://localhost:3084'), 'localhost:3084')
    assert.equal(canonicalAuthority('[::1]:3084', 'http'), '[::1]:3084')
    assert.equal(canonicalAuthority('null'), 'null:443', 'an opaque origin never equals a real host')
    assert.equal(canonicalAuthority(''), undefined)
  })
  it('originRejection: host allowlist then origin equality', () => {
    const https = { 'x-forwarded-proto': 'https' }
    const allowed = new Set(['node.example.ts.net:443', '127.0.0.1:3084'])
    assert.equal(originRejection(fake({ ...https, host: 'node.example.ts.net' }), allowed), undefined)
    assert.equal(originRejection(fake({ ...https, host: 'NODE.example.ts.net:443', origin: 'https://node.example.ts.net' }), allowed), undefined)
    assert.equal(originRejection(fake({ host: '127.0.0.1:3084', origin: 'http://127.0.0.1:3084' }), allowed), undefined)
    assert.equal(originRejection(fake({ ...https, host: 'other' }), allowed)?.status, 421)
    assert.equal(originRejection(fake({}), allowed)?.status, 421)
    assert.equal(originRejection(fake({ host: 'node.example.ts.net' }), allowed)?.status, 421, 'plain http to the public name is not the published authority')
    assert.equal(originRejection(fake({ ...https, host: 'node.example.ts.net', origin: 'null' }), allowed)?.status, 403)
    assert.equal(originRejection(fake({ ...https, host: 'node.example.ts.net', origin: 'https://node.example.ts.net:8443' }), allowed)?.status, 403)
  })
  it('identityOperators: identity-admitted users operate; token holders and other devices never do', async () => {
    identityOperators = true
    try {
      seen.length = 0
      const alice = await fetchProxy('/deepsea-tailscale/status', { method: 'POST', headers: { ...servePeer('alice@example.com'), 'content-type': 'application/json' }, body: '{}' })
      assert.equal(alice.status, 200, 'allowlisted identity: operator')
      assert.equal(seen.at(-1)?.headers['x-deepsea-tailscale-self'], undefined, 'an operator, but not this Mac: -self means this node only')
      assert.equal(seen.at(-1)?.headers['x-deepsea-tailscale-admitted'], 'user')
      const page = await fetchProxy('/', { headers: { ...servePeer('alice@example.com'), accept: 'text/html' } })
      assert.match(page.body, /ownsHost:true/, 'identity-admitted page owns the host (Settings persist, host panes visible)')
      const stranger = await fetchProxy('/deepsea-tailscale/status', { method: 'POST', headers: { ...servePeer('mallory@example.com'), 'content-type': 'application/json' }, body: '{}' })
      assert.equal(stranger.status, 403, 'not allowlisted: the control fence answers first')
      const bearer = await fetchProxy('/deepsea-tailscale/status', { method: 'POST', headers: { cookie: `deepsea-tailscale-lab=${cookieValueFor(token)}`, origin: `http://127.0.0.1:${proxy.port}`, 'content-type': 'application/json' }, body: '{}' })
      assert.equal(bearer.status, 403, 'token holder: admitted but never an operator')
      const bearerPage = await fetchProxy('/', { headers: { cookie: `deepsea-tailscale-lab=${cookieValueFor(token)}`, origin: `http://127.0.0.1:${proxy.port}`, accept: 'text/html' } })
      assert.doesNotMatch(bearerPage.body, /ownsHost:true/)
    } finally { identityOperators = false }
  })
  it('isOperatorRequest: self always; identity only with the policy on', () => {
    const opts = { selfAddresses: [SELF_ADDRESS], allowedUsers: ['alice@example.com'] }
    assert.equal(isOperatorRequest(fake({ 'x-forwarded-for': SELF_ADDRESS }), { ...opts, identityOperators: false }), true)
    assert.equal(isOperatorRequest(fake({ 'x-forwarded-for': '100.100.1.1', 'tailscale-user-login': 'alice@example.com' }), { ...opts, identityOperators: false }), false)
    assert.equal(isOperatorRequest(fake({ 'x-forwarded-for': '100.100.1.1', 'tailscale-user-login': 'alice@example.com' }), { ...opts, identityOperators: true }), true)
    assert.equal(isOperatorRequest(fake({ 'x-forwarded-for': '100.100.1.1', 'tailscale-user-login': 'bob@example.com' }), { ...opts, identityOperators: true }), false)
  })
  it('isSelfRequest: Serve peer whose forwarded address is one of ours', () => {
    assert.equal(isSelfRequest(fake({ 'x-forwarded-for': SELF_ADDRESS }), [SELF_ADDRESS]), true)
    assert.equal(isSelfRequest(fake({ 'x-forwarded-for': '100.1.1.1' }), [SELF_ADDRESS]), false)
    assert.equal(isSelfRequest(fake({ 'x-forwarded-for': SELF_ADDRESS }, '192.0.2.5'), [SELF_ADDRESS]), false, 'not via Serve')
    assert.equal(isSelfRequest(fake({}), [SELF_ADDRESS]), false)
  })
})

describe('websocket', () => {
  it('passes an upgrade through with the gate applied', async () => {
    const { connect } = await import('node:net')
    const open = (headers) => new Promise((resolve) => {
      const socket = connect(proxy.port, '127.0.0.1', () => {
        socket.write(`GET /api/remote.mux HTTP/1.1\r\nHost: node.example.ts.net\r\nX-Forwarded-Proto: https\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: abc\r\nSec-WebSocket-Version: 13\r\n${headers}\r\n`)
      })
      let text = ''
      socket.on('data', (chunk) => {
        text += chunk.toString()
        if (text.includes('hello-from-dsh')) {
          socket.write('ping')
        }
        if (text.includes('echo:ping') || /^HTTP\/1\.1 4\d\d/.test(text)) {
          socket.destroy()
          resolve(text)
        }
      })
    })
    const denied = await open('')
    assert.match(denied, /^HTTP\/1\.1 401/)
    const crossSite = await open(`X-Forwarded-For: 100.101.102.103\r\nTailscale-User-Login: alice@example.com\r\nOrigin: https://evil.example\r\n`)
    assert.match(crossSite, /^HTTP\/1\.1 403/)
    const ok = await open(`X-Forwarded-For: 100.101.102.103\r\nTailscale-User-Login: alice@example.com\r\nOrigin: https://node.example.ts.net\r\n`)
    assert.match(ok, /^HTTP\/1\.1 101/)
    assert.match(ok, /echo:ping/)
    const upgrade = seen.findLast(entry => entry.method === 'UPGRADE')
    assert.equal(upgrade.headers.cookie, DSH_COOKIE)
    assert.equal(upgrade.headers.host, `127.0.0.1:${backendPort}`)
  })

  it('relays the status and reason header of an upgrade DSH refused, without its body', async () => {
    const { connect } = await import('node:net')
    const text = await new Promise((resolve) => {
      const socket = connect(proxy.port, '127.0.0.1', () => {
        socket.write('GET /api/deepsea-tailscale/loopback-forward?port=3080 HTTP/1.1\r\nHost: node.example.ts.net\r\nX-Forwarded-Proto: https\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: abc\r\nSec-WebSocket-Version: 13\r\nX-Forwarded-For: 100.101.102.103\r\nTailscale-User-Login: alice@example.com\r\n\r\n')
      })
      let out = ''
      socket.on('data', chunk => { out += chunk.toString() })
      socket.on('close', () => resolve(out))
    })
    assert.match(text, /^HTTP\/1\.1 403/)
    assert.match(text, /x-deepsea-forward-error: reserved/i)
    assert.match(text, /content-length: 0/i)
    assert.doesNotMatch(text, /reserved\n$/)
  })
})

describe('a tailnet switch (the node\'s name changes between re-reads)', () => {
  it('recognises MagicDNS names only', () => {
    assert.equal(isTailnetHost('node.example.ts.net'), true)
    assert.equal(isTailnetHost('Node.Example.ts.net:443'), true)
    assert.equal(isTailnetHost('ts.net'), false)
    assert.equal(isTailnetHost('evil.example'), false)
    assert.equal(isTailnetHost('node.example.ts.net.evil.example'), false)
    assert.equal(isTailnetHost(undefined), false)
  })

  it('re-reads the names once for an unknown tailnet name, admits it if Tailscale now reports it, else 421', async () => {
    let names = ['old.example.ts.net']
    let next = names
    let reads = 0
    const switched = await startProxy({
      listenHost: '127.0.0.1', listenPort: 0, backendHost: '127.0.0.1', backendPort,
      connection: { authenticatedUrl: base => `${base}/?token=${LAUNCH_TOKEN}` },
      token: () => token, allowedUsers: () => allowedUsers, selfLogin: () => selfLogin, selfAddresses: () => [SELF_ADDRESS],
      identityOperators: () => false,
      publicHosts: () => names,
      refreshHosts: async () => { reads++; names = next },
      cookieName: 'deepsea-tailscale-switch', controlPrefix: '/deepsea-tailscale', servePath: '/deepsea-lab',
    })
    const get = host => new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port: switched.port, path: '/api/whoami', headers: { ...servePeer('alice@example.com'), host, 'x-forwarded-host': host } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)) })
      req.on('error', reject)
      req.end()
    })
    try {
      assert.equal(await get('old.example.ts.net'), 200)
      assert.equal(reads, 0, 'a known name needs no re-read')
      assert.equal(await get('evil.example'), 421)
      assert.equal(reads, 0, 'a name outside ts.net never triggers a re-read')
      next = ['new.example.ts.net']
      assert.equal(await get('new.example.ts.net'), 200, 'the switch is seen on the first request')
      assert.equal(reads, 1)
      assert.equal(await get('old.example.ts.net'), 421, 'the old name is gone')
      assert.equal(await get('other.example.ts.net'), 421)
      assert.equal(reads, 1, 'unknown names re-read at most every few seconds')
    } finally { await switched.close() }
  })
})
