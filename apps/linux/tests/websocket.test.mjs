import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { connectWebSocket, encodeClientFrame, FrameReader, HandshakeError, OPCODE } from '../websocket.mjs'
import { acceptUpgrade, readClientFrames, serverFrame } from './fake-host.mjs'

/** A server whose upgrade behaviour each test scripts. */
async function scriptedServer(t, onUpgrade) {
  const sockets = new Set()
  const server = createServer((_req, res) => res.writeHead(426).end('upgrade required\n'))
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  server.on('upgrade', (req, socket, head) => { socket.on('error', () => {}); onUpgrade(req, socket, head) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close() })
  return `ws://127.0.0.1:${String(server.address().port)}/socket`
}

test('handshake, masked frames both ways, text and binary, fragments, ping, close', async (t) => {
  const seen = []
  const url = await scriptedServer(t, (req, socket, head) => {
    assert.equal(req.headers['sec-websocket-version'], '13')
    assert.equal(req.headers['x-test'], 'yes')
    acceptUpgrade(req, socket)
    // A fragmented text message and a ping before anything else.
    socket.write(Buffer.concat([serverFrame(OPCODE.text, 'hel', { fin: false }), serverFrame(OPCODE.ping, 'p1'), serverFrame(OPCODE.continuation, 'lo')]))
    readClientFrames(socket, (frame) => {
      seen.push(frame)
      if (frame.opcode === OPCODE.binary || frame.opcode === OPCODE.text) socket.write(serverFrame(frame.opcode, frame.payload))
      if (frame.opcode === OPCODE.close) socket.end(serverFrame(OPCODE.close, frame.payload))
    }, head)
  })
  const ws = await connectWebSocket(url, { headers: { 'X-Test': 'yes' } })
  const [first, firstBinary] = await once(ws, 'message')
  assert.equal(first.toString(), 'hello')
  assert.equal(firstBinary, false)
  const bytes = randomBytes(200_000)
  ws.send(bytes)
  const [echo, binary] = await once(ws, 'message')
  assert.equal(binary, true)
  assert.deepEqual(echo, bytes)
  ws.send('text', { binary: false })
  assert.equal((await once(ws, 'message'))[0].toString(), 'text')
  ws.close(1000, 'bye')
  const [code] = await once(ws, 'close')
  assert.equal(code, 1000)
  assert.ok(seen.every(frame => frame.masked), 'every client frame is masked')
  const pong = seen.find(frame => frame.opcode === OPCODE.pong)
  assert.equal(pong?.payload.toString(), 'p1')
})

test('a refusal rejects with status, headers and body', async (t) => {
  const url = await scriptedServer(t, (_req, socket) => {
    socket.end('HTTP/1.1 404 Not Found\r\nX-DeepSea-Forward-Error: nothing-listening\r\nContent-Length: 20\r\nConnection: close\r\n\r\nnothing-listening: x')
  })
  const error = await connectWebSocket(url).then(() => undefined, e => e)
  assert.ok(error instanceof HandshakeError)
  assert.equal(error.status, 404)
  assert.equal(error.headers['x-deepsea-forward-error'], 'nothing-listening')
  assert.equal(error.body, 'nothing-listening: x')
})

test('a wrong accept key and a masked server frame are refused', async (t) => {
  const bad = await scriptedServer(t, (_req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: wrong\r\n\r\n')
  })
  await assert.rejects(connectWebSocket(bad), /accept key/)
  const masked = await scriptedServer(t, (req, socket) => {
    acceptUpgrade(req, socket)
    socket.write(serverFrame(OPCODE.text, 'nope', { mask: true }))
  })
  const ws = await connectWebSocket(masked)
  const errors = []
  ws.on('error', error => errors.push(error.message))
  const code = await new Promise(resolve => ws.on('close', resolve)) // events.once would reject on 'error'
  assert.equal(code, 1002)
  assert.match(errors[0], /masked server frame/)
})

test('a handshake that never answers times out', async (t) => {
  const url = await scriptedServer(t, () => {})
  await assert.rejects(connectWebSocket(url, { timeoutMs: 200 }), /timed out/)
})

test('FrameReader joins a large frame from many small chunks, and keeps order', () => {
  const messages = []
  const reader = new FrameReader({ onMessage: (opcode, payload) => messages.push([opcode, payload]), onControl: () => {}, onError: (m) => assert.fail(m) })
  const big = randomBytes(3 * 1024 * 1024)
  const stream = Buffer.concat([serverFrame(OPCODE.binary, big), serverFrame(OPCODE.text, 'after')])
  for (let at = 0; at < stream.length; at += 1000) reader.feed(stream.subarray(at, at + 1000))
  assert.equal(messages.length, 2)
  assert.deepEqual(messages[0][1], big)
  assert.equal(messages[1][1].toString(), 'after')
})

test('encodeClientFrame: lengths 0, 125, 126, 65535, 65536 round-trip through a server parser', () => {
  for (const length of [0, 125, 126, 65535, 65536]) {
    const data = randomBytes(length)
    const frame = encodeClientFrame(OPCODE.binary, data)
    let got
    const fake = new EventEmitter()
    readClientFrames(fake, (parsed) => { got = parsed })
    fake.emit('data', frame)
    assert.equal(got.masked, true)
    assert.deepEqual(got.payload, data)
  }
})
