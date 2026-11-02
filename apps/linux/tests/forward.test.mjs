import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { createServer as createHttpServer, request } from 'node:http'
import { connect, createServer } from 'node:net'
import { test } from 'node:test'
import { describeForwardError, forwardEndpoint, Forwarder, loopbackPort, loopbackRedirectPort, onLocalPort, startLoopbackProxy } from '../forward.mjs'
import { attachEcho, createFakeHost } from './fake-host.mjs'

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return server.address().port
}

/** Everything one test needs: the fake host, two targets on "its" loopback, a forwarder and its proxy. */
async function setup(t) {
  const sockets = new Set()
  const track = server => server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  const echo = createServer(socket => socket.pipe(socket))
  const preview = createHttpServer((req, res) => res.end(`${req.method} ${req.url} ${req.headers.host}`))
  attachEcho(preview)
  track(echo); track(preview)
  const echoPort = await listen(echo)
  const previewPort = await listen(preview)
  const host = await createFakeHost({ cookie: 'session=test' })
  host.ports.add(echoPort).add(previewPort)
  host.reserved.add(host.port)
  const logs = []
  const forwarder = new Forwarder({ mount: () => host.url, headers: async () => ({ Cookie: 'other=1; session=test', 'User-Agent': 'DeepSea/0.0.0-test' }), log: line => logs.push(line) })
  const failures = []
  const proxy = await startLoopbackProxy(forwarder, {
    onError: (port, error) => failures.push([port, error.code]),
    redirect: (_port, url) => new URL(url.pathname.slice(1) + url.search, host.url).toString(),
  })
  t.after(() => {
    proxy.close()
    forwarder.dispose()
    host.close()
    for (const socket of sockets) socket.destroy()
    echo.close(); preview.close()
  })
  return { host, forwarder, proxy, echoPort, previewPort, failures, logs }
}

/** Write `bytes` to a TCP connection and read the same number back. */
async function roundTrip(port, bytes) {
  const socket = connect(port, '127.0.0.1')
  const parts = []
  let size = 0
  await new Promise((resolve, reject) => {
    socket.on('error', reject)
    socket.on('data', (chunk) => { parts.push(chunk); size += chunk.length; if (size >= bytes.length) resolve() })
    socket.write(bytes)
  })
  socket.destroy()
  return Buffer.concat(parts)
}

test('loopback URLs and the endpoint', () => {
  for (const host of ['localhost', '127.0.0.2', '[::1]', 'app.localhost', '0.0.0.0']) assert.equal(loopbackPort(`http://${host}:5173/`), 5173, host)
  assert.equal(loopbackPort('https://localhost/'), 443)
  assert.equal(loopbackPort('ws://localhost/hmr'), 80)
  for (const url of ['https://example.com/', 'http://localhost.example.com/', 'http://127.example.com/', 'file:///tmp/a', 'not a url']) assert.equal(loopbackPort(url), undefined, url)
  assert.equal(onLocalPort('http://localhost:5173/a?b', 5173), 'http://localhost:5173/a?b')
  assert.equal(onLocalPort('http://localhost:5173/a?b', 41000), 'http://127.0.0.1:41000/a?b')
  assert.equal(forwardEndpoint('https://node.example.ts.net/deepsea/', 5173), 'wss://node.example.ts.net/deepsea/api/deepsea-tailscale/loopback-forward?port=5173')
  assert.equal(forwardEndpoint('http://127.0.0.1:3203/', 80), 'ws://127.0.0.1:3203/api/deepsea-tailscale/loopback-forward?port=80')
})

test('refusals carry the server\'s reason code', async (t) => {
  const { host, forwarder } = await setup(t)
  await assert.rejects(forwarder.ensure(1), { code: 'nothing-listening', status: 404 })
  await assert.rejects(forwarder.ensure(host.port), { code: 'reserved', status: 403 })
  host.policy = 'off'
  await assert.rejects(forwarder.ensure(2), { code: 'disabled' })
  host.policy = 'admitted'
  const anonymous = new Forwarder({ mount: () => host.url })
  t.after(() => anonymous.dispose())
  await assert.rejects(anonymous.ensure(3), { code: 'not-admitted', status: 401 })
  const offline = new Forwarder({ mount: () => undefined })
  t.after(() => offline.dispose())
  await assert.rejects(offline.ensure(3), { code: 'transport' })
  assert.match(describeForwardError({ code: 'reserved' }), /DeepSea server itself/)
  // The request carried the page's cookie and the app's user agent, and no Origin.
  const sent = host.requests[0].headers
  assert.equal(sent.cookie, 'other=1; session=test')
  assert.equal(sent['user-agent'], 'DeepSea/0.0.0-test')
  assert.equal(sent.origin, undefined)
})

test('a forward: probe, remapped listener, multi-MB both ways, concurrent connections, close', async (t) => {
  const { forwarder, echoPort, host } = await setup(t)
  const changes = []
  forwarder.on('change', () => changes.push(forwarder.rows.length))
  const [row, same] = await Promise.all([forwarder.ensure(echoPort), forwarder.ensure(echoPort)])
  assert.equal(row, same, 'concurrent ensures share one forward')
  assert.notEqual(row.localPort, echoPort, 'the port is taken here, so the listener is remapped')
  assert.equal(row.pid, 4242)
  assert.deepEqual(forwarder.rows.map(r => r.remotePort), [echoPort])

  const big = randomBytes(8 * 1024 * 1024)
  assert.ok((await roundTrip(row.localPort, big)).equals(big), '8 MiB echoed intact')

  const payloads = Array.from({ length: 24 }, () => randomBytes(256 * 1024))
  const results = await Promise.all(payloads.map(bytes => roundTrip(row.localPort, bytes)))
  results.forEach((got, index) => assert.ok(got.equals(payloads[index]), `connection ${String(index)}`))

  const held = connect(row.localPort, '127.0.0.1')
  held.write('x')
  await once(held, 'data')
  assert.equal(row.connections, 1)
  const closed = once(held, 'close')
  forwarder.close(echoPort)
  await closed
  assert.deepEqual(forwarder.rows, [])
  assert.ok(changes.includes(0))
  // Every forwarding socket goes when its connection does.
  for (let i = 0; i < 50 && host.open > 0; i++) await new Promise(resolve => setTimeout(resolve, 20))
  if (!process.env.DEEPSEA_FORWARD_HOST) assert.equal(host.open, 0)
  if (!process.env.DEEPSEA_FORWARD_HOST) assert.equal(host.unmasked, 0, 'every client frame was masked')
})

test('the loopback proxy: plain requests, CONNECT for WebSockets, refusals, redirect of the server\'s own port', async (t) => {
  const { forwarder, proxy, previewPort, host, failures } = await setup(t)
  const get = (url, headers = {}) => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: proxy.port, path: url, headers: { Host: new URL(url).host, ...headers } }, (res) => {
      let body = ''
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }))
    })
    req.on('error', reject)
    req.end()
  })
  assert.deepEqual(await get(`http://localhost:${String(previewPort)}/hello?q=1`).then(r => [r.status, r.body]), [200, `GET /hello?q=1 localhost:${String(previewPort)}`])
  assert.equal((await get('http://example.com/')).status, 403)
  const refused = await get('http://localhost:1/')
  assert.equal(refused.status, 502)
  assert.match(refused.body, /Nothing is listening/)
  assert.deepEqual(failures.at(-1), [1, 'nothing-listening'])
  const own = await get(`http://127.0.0.1:${String(host.port)}/x?y=1`)
  assert.equal(own.status, 307)
  assert.equal(own.headers.location, `${host.url}x?y=1`)

  // A browser's ws:// through an HTTP proxy is a CONNECT; the HMR echo answers through it.
  const socket = connect(proxy.port, '127.0.0.1')
  socket.write(`CONNECT localhost:${String(previewPort)} HTTP/1.1\r\nHost: localhost:${String(previewPort)}\r\n\r\n`)
  const [answer] = await once(socket, 'data')
  assert.match(answer.toString(), /^HTTP\/1.1 200/)
  socket.write(`GET /plain HTTP/1.1\r\nHost: localhost:${String(previewPort)}\r\nConnection: close\r\n\r\n`)
  let text = ''
  socket.on('data', (chunk) => { text += chunk })
  await once(socket, 'end')
  assert.match(text, new RegExp(`GET /plain localhost:${String(previewPort)}`))
  assert.equal(forwarder.rows.length, 1)
})

test('the fixture\'s WebSocket side agrees with Node\'s own WebSocket client', { skip: typeof WebSocket !== 'function' }, async (t) => {
  const server = createHttpServer()
  attachEcho(server)
  const port = await listen(server)
  t.after(() => server.close())
  const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/hmr`)
  await once(ws, 'open')
  ws.send('hello')
  const [event] = await once(ws, 'message')
  assert.equal(event.data, 'hello')
  ws.close()
  await once(ws, 'close')
})

test('sign-in callbacks: the redirect port, through the asking server, exact and single-use', async (t) => {
  const { forwarder, host, echoPort } = await setup(t)
  assert.equal(loopbackRedirectPort('https://claude.ai/oauth/authorize?code=true&redirect_uri=http%3A%2F%2Flocalhost%3A53692%2Fcallback&state=x'), 53692)
  assert.equal(loopbackRedirectPort('https://x.example/a?redirect_uri=https%3A%2F%2Fapp.example%2Fcb'), undefined)
  assert.equal(loopbackRedirectPort('https://x.example/a'), undefined)
  // Through another server's mount (a framed remote session's directory): that server is asked, not the app's own.
  const other = await createFakeHost({ mount: '/deepsea-test/deepsea-remote-workspaces/servers/other/', cookie: 'session=test' })
  other.ports.add(echoPort)
  t.after(() => other.close())
  const before = host.requests.length
  const viaOther = await forwarder.ensure(echoPort, { mount: other.url })
  assert.equal(viaOther.mount, other.url)
  assert.equal(host.requests.length, before)
  assert.ok(other.requests.length > 0)
  // Exact: the port is taken here (the sign-in's own listener, on this machine), so it fails at once, asking nobody.
  const asked = other.requests.length
  await assert.rejects(forwarder.ensure(echoPort, { mount: other.url.replace('/other/', '/another/'), exact: true }), { code: 'listen' })
  assert.equal(other.requests.length, asked)
  // Single use: closed a moment after its connection ends; other forwards stay.
  const used = await forwarder.ensure(echoPort, { mount: host.url, singleUse: true })
  assert.equal(await roundTrip(used.localPort, Buffer.from('callback')).then(b => b.toString()), 'callback')
  await new Promise(resolve => setTimeout(resolve, 2600))
  assert.deepEqual(forwarder.rows.map(row => row.mount), [other.url])
})

test('idle forwards close; a disposed forwarder refuses', async (t) => {
  const { forwarder, echoPort } = await setup(t)
  const row = await forwarder.ensure(echoPort)
  forwarder.closeIdle(row.lastActivity + 59 * 60 * 1000)
  assert.equal(forwarder.rows.length, 1)
  forwarder.closeIdle(row.lastActivity + 61 * 60 * 1000)
  assert.equal(forwarder.rows.length, 0)
  forwarder.dispose()
  await assert.rejects(forwarder.ensure(echoPort), /stopped/)
})
