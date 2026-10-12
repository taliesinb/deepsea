/**
 * Loopback forwarding: policy helpers, the frame codec, and the upgrade
 * handler end to end — a real http.Server dispatching the upgrade the way DSH's
 * web server does, a TCP echo/probe target on loopback, and Node's own
 * WebSocket client (masked frames, as the DeepSea app's URLSessionWebSocketTask
 * sends them). The real `lsof` is used once against a listener we own; the
 * rest injects owners so the tests do not depend on what else runs here.
 */
import assert from 'node:assert/strict'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { after, before, describe, it } from 'node:test'
import {
  FORWARD_PATH, FrameParser, OPCODE, acceptKey, connectCandidates, encodeClose, encodeFrame, forwardAdmission, forwardDecision,
  handleForwardUpgrade, lookupListeners, parseForwardRequest, parseLsofListeners,
} from '../forward.mjs'

const SELF_UID = 501

describe('pure helpers', () => {
  it('parseForwardRequest: decimal port in the query, nothing else', () => {
    assert.deepEqual(parseForwardRequest(`${FORWARD_PATH}?port=5173`), { port: 5173 })
    assert.ok('error' in parseForwardRequest(`${FORWARD_PATH}`))
    assert.ok('error' in parseForwardRequest(`${FORWARD_PATH}?port=0`))
    assert.ok('error' in parseForwardRequest(`${FORWARD_PATH}?port=70000`))
    assert.ok('error' in parseForwardRequest(`${FORWARD_PATH}?port=51x3`))
    assert.ok('error' in parseForwardRequest(`${FORWARD_PATH}?port=localhost:5173`))
  })

  it('forwardAdmission: direct loopback callers pass; proxied ones follow the policy', () => {
    const proxied = (admitted, self) => ({ 'x-deepsea-tailscale': '1', 'x-deepsea-tailscale-admitted': admitted, ...(self ? { 'x-deepsea-tailscale-self': '1' } : {}) })
    assert.deepEqual(forwardAdmission({}, 'admitted'), { ok: true, via: 'direct' })
    assert.deepEqual(forwardAdmission(proxied('user', true), 'operators'), { ok: true, via: 'operator' })
    assert.deepEqual(forwardAdmission(proxied('user', false), 'admitted'), { ok: true, via: 'user' })
    assert.deepEqual(forwardAdmission(proxied('cookie', false), 'admitted'), { ok: true, via: 'cookie' })
    assert.equal(forwardAdmission(proxied('user', false), 'operators').code, 'not-operator')
    assert.equal(forwardAdmission(proxied('public', false), 'admitted').code, 'not-admitted')
    assert.equal(forwardAdmission({}, 'off').code, 'disabled')
    assert.equal(forwardAdmission(proxied('user', true), 'off').code, 'disabled')
    // With identityOperators, an identity-admitted user operates (the proxy's rule); a token holder never does.
    assert.deepEqual(forwardAdmission(proxied('user', false), 'operators', true), { ok: true, via: 'operator' })
    assert.equal(forwardAdmission(proxied('cookie', false), 'operators', true).code, 'not-operator')
  })

  it('parseLsofListeners: one record per process with its socket names', () => {
    const owners = parseLsofListeners('p123\ncnode\nu501\nf12\nn127.0.0.1:5173\nf13\nn[::1]:5173\np456\ncpython3\nu502\nf5\nn*:5173\n')
    assert.deepEqual(owners, [
      { pid: 123, command: 'node', uid: 501, names: ['127.0.0.1:5173', '[::1]:5173'] },
      { pid: 456, command: 'python3', uid: 502, names: ['*:5173'] },
    ])
    assert.deepEqual(parseLsofListeners(''), [])
  })

  it('connectCandidates: concrete loopback names as bound, wildcard → v4 then v6, LAN bindings ignored', () => {
    assert.deepEqual(connectCandidates([{ names: ['[::1]:5173'] }], 5173), [{ host: '::1', port: 5173 }])
    assert.deepEqual(connectCandidates([{ names: ['*:5173'] }], 5173), [{ host: '127.0.0.1', port: 5173 }, { host: '::1', port: 5173 }])
    assert.deepEqual(connectCandidates([{ names: ['192.0.2.3:5173'] }], 5173), [{ host: '127.0.0.1', port: 5173 }, { host: '::1', port: 5173 }])
    assert.deepEqual(connectCandidates([{ names: ['127.0.0.1:5173'] }, { names: ['127.0.0.1:5173'] }], 5173), [{ host: '127.0.0.1', port: 5173 }])
  })

  it('forwardDecision: reserved → 403, invisible → 404, foreign uid → 403, ours → targets', () => {
    const ours = [{ pid: 1, command: 'node', uid: SELF_UID, names: ['127.0.0.1:5173'] }]
    assert.equal(forwardDecision({ port: 3080, owners: ours, selfUid: SELF_UID, reservedPorts: [3080, 3083, 3084] }).code, 'reserved')
    assert.equal(forwardDecision({ port: 5173, owners: [], selfUid: SELF_UID, reservedPorts: [] }).status, 404)
    const mixed = [...ours, { pid: 2, command: 'ruby', uid: 502, names: ['[::1]:5173'] }]
    assert.equal(forwardDecision({ port: 5173, owners: mixed, selfUid: SELF_UID, reservedPorts: [] }).code, 'foreign-owner')
    const decision = forwardDecision({ port: 5173, owners: ours, selfUid: SELF_UID, reservedPorts: [] })
    assert.deepEqual(decision, { ok: true, owner: { pid: 1, command: 'node' }, targets: [{ host: '127.0.0.1', port: 5173 }] })
  })

  it('acceptKey: the RFC 6455 example', () => {
    assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
  })

  it('frame codec: round-trips unmasked and masked frames of every length class, fragments and controls', () => {
    const messages = []
    const controls = []
    const errors = []
    const parser = new FrameParser({ onMessage: (op, p) => messages.push([op, p]), onControl: (op, p) => controls.push([op, p]), onError: m => errors.push(m) })
    const small = Buffer.from('hi')
    const medium = Buffer.alloc(300, 7)
    const large = Buffer.alloc(70000, 9)
    parser.feed(encodeFrame(OPCODE.binary, small))
    parser.feed(encodeFrame(OPCODE.binary, medium))
    // byte-at-a-time delivery must not matter
    for (const byte of encodeFrame(OPCODE.text, large)) parser.feed(Buffer.from([byte]))
    parser.feed(mask(encodeFrame(OPCODE.binary, Buffer.from('masked'))))
    // fragmented: text start + continuation
    const first = encodeFrame(OPCODE.text, 'ab'); first[0] &= 0x7f
    parser.feed(first)
    parser.feed(encodeFrame(OPCODE.continuation, 'cd'))
    parser.feed(encodeFrame(OPCODE.ping, 'p'))
    parser.feed(encodeClose(1000, 'bye'))
    assert.equal(errors.length, 0)
    assert.equal(messages.length, 5)
    assert.deepEqual(messages[0], [OPCODE.binary, small])
    assert.deepEqual(messages[1][1], medium)
    assert.deepEqual(messages[2][1], large)
    assert.equal(messages[3][1].toString(), 'masked')
    assert.deepEqual(messages[4], [OPCODE.text, Buffer.from('abcd')])
    assert.deepEqual(controls[0], [OPCODE.ping, Buffer.from('p')])
    assert.equal(controls[1][0], OPCODE.close)
    assert.equal(controls[1][1].readUInt16BE(0), 1000)
    assert.equal(controls[1][1].subarray(2).toString(), 'bye')
  })

  it('frame codec: protocol errors stop the parser', () => {
    const errors = []
    const parser = new FrameParser({ onMessage: () => {}, onControl: () => {}, onError: m => errors.push(m), maxMessageBytes: 100 })
    parser.feed(encodeFrame(OPCODE.continuation, 'orphan'))
    assert.equal(errors.length, 1)
    const big = new FrameParser({ onMessage: () => {}, onControl: () => {}, onError: m => errors.push(m), maxMessageBytes: 100 })
    big.feed(encodeFrame(OPCODE.binary, Buffer.alloc(200)))
    assert.equal(errors.length, 2)
  })
})

/** Mask a server-encoded frame the way a client must. */
function mask(frame) {
  const len7 = frame[1] & 0x7f
  const headerLength = len7 === 126 ? 4 : len7 === 127 ? 10 : 2
  const key = Buffer.from([1, 2, 3, 4])
  const payload = Buffer.from(frame.subarray(headerLength))
  for (let index = 0; index < payload.length; index++) payload[index] ^= key[index & 3]
  const header = Buffer.from(frame.subarray(0, headerLength))
  header[1] |= 0x80
  return Buffer.concat([header, key, payload])
}

describe('lsof on a listener we own', () => {
  it('finds our own process and uid', async () => {
    const server = createTcpServer()
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address()
    try {
      const owners = await lookupListeners(port)
      assert.equal(owners.length, 1)
      assert.equal(owners[0].pid, process.pid)
      assert.equal(owners[0].uid, process.getuid())
      assert.ok(owners[0].names.some(name => name.endsWith(`:${String(port)}`)))
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
    const none = await lookupListeners(port)
    assert.deepEqual(none, [])
  })
})

describe('upgrade handler end to end', () => {
  let http
  let httpPort
  let echo
  let echoPort
  const echoSeen = []
  const connections = new Set()
  const logs = []
  let policy = 'admitted'
  /** Injected owners per port; `undefined` = consult the fake as "nothing"; a function may throw to simulate lsof failure. */
  let owners = new Map()
  const reserved = new Set()

  before(async () => {
    echo = createTcpServer((socket) => {
      socket.on('data', (chunk) => { echoSeen.push(chunk.toString()); socket.write(Buffer.concat([Buffer.from('echo:'), chunk])) })
    })
    echoSockets(echo) // start tracking before any client connects
    await new Promise(resolve => echo.listen(0, '127.0.0.1', resolve))
    echoPort = echo.address().port
    http = createHttpServer((req, res) => { res.writeHead(404); res.end() })
    http.on('upgrade', (req, socket, head) => {
      if (new URL(req.url, 'http://x').pathname !== FORWARD_PATH) { socket.destroy(); return }
      void handleForwardUpgrade(req, socket, head, {
        policy: () => policy,
        selfUid: SELF_UID,
        reservedPorts: () => reserved,
        lookup: async (port) => {
          const entry = owners.get(port)
          if (typeof entry === 'function') return entry()
          return entry ?? []
        },
        connections,
        maxConnections: 2,
        log: line => logs.push(line),
      })
    })
    await new Promise(resolve => http.listen(0, '127.0.0.1', resolve))
    httpPort = http.address().port
  })
  after(async () => {
    http.closeAllConnections()
    await new Promise(resolve => http.close(resolve))
    echo.close()
  })

  const ownersOf = port => [{ pid: 4242, command: 'vite', uid: SELF_UID, names: [`127.0.0.1:${String(port)}`] }]

  /** Raw upgrade attempt returning the HTTP status when the server refuses before 101. */
  const rawUpgrade = (path, headers = {}) => new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: httpPort, path, headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers } })
    req.on('response', (res) => { res.resume(); resolve({ status: res.statusCode, error: res.headers['x-deepsea-forward-error'] }) })
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve({ status: res.statusCode, accept: res.headers['sec-websocket-accept'] }) })
    req.on('error', reject)
    req.end()
  })

  const open = (port) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${String(httpPort)}${FORWARD_PATH}?port=${String(port)}`)
    ws.binaryType = 'arraybuffer'
    const events = []
    ws.addEventListener('message', event => events.push(event.data))
    ws.addEventListener('open', () => resolve({ ws, events }))
    ws.addEventListener('error', () => reject(new Error('websocket failed')))
  })
  const until = async (predicate, ms = 2000) => {
    const deadline = Date.now() + ms
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('timed out')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }

  it('refuses non-WebSocket upgrades, bad ports, reserved ports, invisible and foreign listeners with HTTP statuses', async () => {
    assert.deepEqual(await rawUpgrade(`${FORWARD_PATH}?port=${String(echoPort)}`, { upgrade: 'h2c' }), { status: 400, error: 'not-websocket' })
    assert.deepEqual(await rawUpgrade(`${FORWARD_PATH}?port=abc`), { status: 400, error: 'bad-port' })
    reserved.add(echoPort)
    owners.set(echoPort, ownersOf(echoPort))
    assert.deepEqual(await rawUpgrade(`${FORWARD_PATH}?port=${String(echoPort)}`), { status: 403, error: 'reserved' })
    reserved.clear()
    owners.delete(echoPort)
    assert.deepEqual(await rawUpgrade(`${FORWARD_PATH}?port=${String(echoPort)}`), { status: 404, error: 'nothing-listening' })
    owners.set(echoPort, [{ pid: 9, command: 'ruby', uid: 502, names: [`127.0.0.1:${String(echoPort)}`] }])
    assert.deepEqual(await rawUpgrade(`${FORWARD_PATH}?port=${String(echoPort)}`), { status: 403, error: 'foreign-owner' })
    owners.set(echoPort, () => { throw new Error('lsof failed: binary not found') })
    assert.deepEqual(await rawUpgrade(`${FORWARD_PATH}?port=${String(echoPort)}`), { status: 503, error: 'lsof-unavailable' })
    owners.set(echoPort, ownersOf(echoPort))
  })

  it('applies the admission policy from the proxy headers', async () => {
    const proxied = { 'x-deepsea-tailscale': '1', 'x-deepsea-tailscale-admitted': 'cookie' }
    policy = 'operators'
    assert.deepEqual(await rawUpgrade(`${FORWARD_PATH}?port=${String(echoPort)}`, proxied), { status: 403, error: 'not-operator' })
    assert.equal((await rawUpgrade(`${FORWARD_PATH}?port=${String(echoPort)}`, { ...proxied, 'x-deepsea-tailscale-self': '1' })).status, 101)
    policy = 'off'
    assert.deepEqual(await rawUpgrade(`${FORWARD_PATH}?port=${String(echoPort)}`), { status: 403, error: 'disabled' })
    policy = 'admitted'
    const accepted = await rawUpgrade(`${FORWARD_PATH}?port=${String(echoPort)}`, proxied)
    assert.equal(accepted.status, 101)
    assert.equal(accepted.accept, 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
    await until(() => connections.size === 0)
  })

  it('answers 502 when the listener vanished between lsof and connect', async () => {
    const gone = createTcpServer()
    await new Promise(resolve => gone.listen(0, '127.0.0.1', resolve))
    const port = gone.address().port
    await new Promise(resolve => gone.close(resolve))
    owners.set(port, ownersOf(port))
    assert.deepEqual(await rawUpgrade(`${FORWARD_PATH}?port=${String(port)}`), { status: 502, error: 'connect-failed' })
  })

  it('pipes bytes both ways, announces the connection, and closes when the target closes', async () => {
    const { ws, events } = await open(echoPort)
    await until(() => events.length >= 1)
    assert.deepEqual(JSON.parse(events[0]), { type: 'connected', port: echoPort, pid: 4242, command: 'vite' })
    ws.send(Buffer.from('GET / HTTP/1.1\r\n\r\n'))
    await until(() => events.length >= 2)
    assert.equal(Buffer.from(events[1]).toString(), 'echo:GET / HTTP/1.1\r\n\r\n')
    assert.equal(echoSeen.at(-1), 'GET / HTTP/1.1\r\n\r\n')
    // a large message survives fragmentation on both sides
    const big = Buffer.alloc(200_000, 0x41)
    ws.send(big)
    await until(() => events.reduce((sum, event) => sum + (typeof event === 'string' ? 0 : event.byteLength), 0) >= big.length + 5)
    assert.equal(connections.size, 1)
    // target closes → client sees a normal close
    const closed = new Promise(resolve => ws.addEventListener('close', event => resolve(event.code)))
    for (const socket of echoSockets(echo)) socket.end()
    assert.equal(await closed, 1000)
    await until(() => connections.size === 0)
    assert.ok(logs.some(line => line.includes('forward opened: port')))
    assert.ok(logs.some(line => line.includes('forward closed')))
  })

  it('client close ends the target side and frees the slot; the connection cap is enforced', async () => {
    const a = await open(echoPort)
    const b = await open(echoPort)
    await until(() => connections.size === 2)
    assert.deepEqual(await rawUpgrade(`${FORWARD_PATH}?port=${String(echoPort)}`), { status: 503, error: 'too-many-connections' })
    a.ws.close(1000, 'done')
    await until(() => connections.size === 1)
    b.ws.close()
    await until(() => connections.size === 0)
  })
})

/** Live sockets of a net.Server (Node keeps no public list; track through the connection event). */
const tracked = new WeakMap()
function echoSockets(server) {
  if (!tracked.has(server)) {
    const set = new Set()
    server.on('connection', (socket) => { set.add(socket); socket.once('close', () => set.delete(socket)) })
    tracked.set(server, set)
  }
  return [...tracked.get(server)]
}
