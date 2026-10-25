/**
 * Test fixtures: the server side of WebSocket (RFC 6455, written apart from
 * ../websocket.mjs so the two check each other) and a fake DeepSea host that
 * answers the forward route the way @deepsea/tailscale's forward.mjs does:
 * refusals as an HTTP status with `X-DeepSea-Forward-Error`, else 101, a
 * `{"type":"connected",…}` text frame and binary frames to and from the
 * target port.
 *
 * `DEEPSEA_FORWARD_HOST=<path to plugins/tailscale/forward.mjs>` makes
 * `createFakeHost` use that real handler instead (its listener lookup and
 * policy injected), to check the client against the shipped server half.
 */
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { connect } from 'node:net'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export const serverAccept = key => createHash('sha1').update(key + GUID).digest('base64')

/** One unmasked server frame. */
export function serverFrame(opcode, payload = Buffer.alloc(0), { fin = true, mask = false } = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  const head = [(fin ? 0x80 : 0) | opcode]
  const maskBit = mask ? 0x80 : 0
  let extra = Buffer.alloc(0)
  if (data.length < 126) head.push(maskBit | data.length)
  else if (data.length < 65536) { head.push(maskBit | 126); extra = Buffer.alloc(2); extra.writeUInt16BE(data.length) }
  else { head.push(maskBit | 127); extra = Buffer.alloc(8); extra.writeBigUInt64BE(BigInt(data.length)) }
  if (!mask) return Buffer.concat([Buffer.from(head), extra, data])
  const key = Buffer.from([1, 2, 3, 4])
  const masked = Buffer.from(data.map((byte, index) => byte ^ key[index % 4]))
  return Buffer.concat([Buffer.from(head), extra, key, masked])
}

/**
 * Parse client frames from a socket: calls `onFrame({ fin, opcode, payload, masked })`.
 * Unmasks; records whether each frame was masked (a client must mask).
 */
export function readClientFrames(socket, onFrame, head = Buffer.alloc(0)) {
  let buffer = head
  const pump = () => {
    for (;;) {
      if (buffer.length < 2) return
      const fin = (buffer[0] & 0x80) !== 0
      const opcode = buffer[0] & 0x0f
      const masked = (buffer[1] & 0x80) !== 0
      let length = buffer[1] & 0x7f
      let offset = 2
      if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4 }
      else if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10 }
      const keyAt = offset
      if (masked) offset += 4
      if (buffer.length < offset + length) return
      const payload = Buffer.from(buffer.subarray(offset, offset + length))
      if (masked) for (let index = 0; index < payload.length; index++) payload[index] ^= buffer[keyAt + (index & 3)]
      buffer = buffer.subarray(offset + length)
      onFrame({ fin, opcode, payload, masked })
    }
  }
  socket.on('data', (chunk) => { buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]); pump() })
  pump()
}

/** Accept a WebSocket upgrade on a raw socket; returns false (and answers 400) when it is not one. */
export function acceptUpgrade(req, socket, extraHeaders = '') {
  const key = req.headers['sec-websocket-key']
  if (String(req.headers.upgrade).toLowerCase() !== 'websocket' || typeof key !== 'string') {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    return false
  }
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${serverAccept(key)}\r\n${extraHeaders}\r\n`)
  return true
}

/**
 * A WebSocket echo endpoint on an http.Server (the preview's HMR socket):
 * text and binary messages come back as they were sent.
 */
export function attachEcho(server, path = '/hmr') {
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, 'http://x').pathname !== path || !acceptUpgrade(req, socket)) { socket.destroy(); return }
    const parts = []
    readClientFrames(socket, ({ fin, opcode, payload }) => {
      if (opcode === 0x8) { socket.end(serverFrame(0x8, payload.subarray(0, 2))); return }
      if (opcode === 0x9) { socket.write(serverFrame(0xa, payload)); return }
      if (opcode >= 0x8) return
      parts.push({ opcode, payload })
      if (!fin) return
      const message = Buffer.concat(parts.map(part => part.payload))
      const type = parts[0].opcode
      parts.length = 0
      socket.write(serverFrame(type, message))
    }, head)
  })
}

function refuse(socket, status, code, message) {
  const body = `${code}: ${message}\n`
  socket.end(`HTTP/1.1 ${String(status)} Refused\r\nContent-Type: text/plain; charset=utf-8\r\nX-DeepSea-Forward-Error: ${code}\r\nContent-Length: ${String(Buffer.byteLength(body))}\r\nConnection: close\r\n\r\n${body}`)
}

/** The fake host's own forward handler: the protocol, with a table of policies. */
function fakeForward(req, socket, head, host) {
  socket.on('error', () => {})
  const port = Number(new URL(req.url, 'http://x').searchParams.get('port'))
  host.requests.push({ port, headers: req.headers })
  if (host.policy === 'off') { refuse(socket, 403, 'disabled', 'loopback forwarding is off'); return }
  if (host.cookie !== undefined && !String(req.headers.cookie ?? '').split(/;\s*/).includes(host.cookie)) { refuse(socket, 401, 'not-admitted', 'not signed in'); return }
  if (host.reserved.has(port)) { refuse(socket, 403, 'reserved', `port ${String(port)} belongs to this variant`); return }
  if (!host.ports.has(port)) { refuse(socket, 404, 'nothing-listening', `nothing listens on 127.0.0.1:${String(port)}`); return }
  const tcp = connect(port, '127.0.0.1')
  tcp.once('error', () => refuse(socket, 502, 'connect-failed', 'refused'))
  tcp.once('connect', () => {
    tcp.removeAllListeners('error')
    if (!acceptUpgrade(req, socket)) { tcp.destroy(); return }
    host.open += 1
    socket.write(serverFrame(0x1, JSON.stringify({ type: 'connected', port, pid: 4242, command: 'fake' })))
    let done = false
    const finish = () => { if (done) return; done = true; host.open -= 1; tcp.destroy(); socket.destroy() }
    tcp.on('data', (chunk) => { if (!socket.write(serverFrame(0x2, chunk))) tcp.pause() })
    socket.on('drain', () => tcp.resume())
    tcp.on('drain', () => socket.resume())
    tcp.on('end', () => { socket.write(serverFrame(0x8, Buffer.from([0x03, 0xe8]))); setTimeout(finish, 200) })
    tcp.on('error', finish)
    readClientFrames(socket, ({ opcode, payload, masked }) => {
      if (!masked) host.unmasked += 1
      if (opcode === 0x8) { socket.write(serverFrame(0x8, Buffer.from([0x03, 0xe8]))); tcp.end(); setTimeout(finish, 200); return }
      if (opcode === 0x9) { socket.write(serverFrame(0xa, payload)); return }
      if (opcode === 0x2 || opcode === 0x0) { if (payload.length > 0 && !tcp.write(payload)) socket.pause() }
    }, head)
    socket.on('close', finish)
  })
}

/**
 * A fake DeepSea server on 127.0.0.1: its GUI at `<mount>` (pages from
 * `pages`, a function of the request), the forward route under it.
 * @param {{ mount?: string, pages?: (req, res) => boolean, cookie?: string }} [options]
 *   `cookie`: `name=value` the forward route requires (else none is checked)
 */
export async function createFakeHost(options = {}) {
  const mount = options.mount ?? '/deepsea-test/'
  const host = {
    mount, cookie: options.cookie, policy: 'admitted', reserved: new Set(), ports: new Set(), requests: [], open: 0, unmasked: 0,
    sockets: new Set(),
  }
  const real = process.env.DEEPSEA_FORWARD_HOST ? await import(process.env.DEEPSEA_FORWARD_HOST) : undefined
  const server = createServer((req, res) => {
    if (options.pages?.(req, res)) return
    res.writeHead(404).end('not found\n')
  })
  server.on('connection', (socket) => { host.sockets.add(socket); socket.once('close', () => host.sockets.delete(socket)) })
  server.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url, 'http://x').pathname
    if (path !== `${mount}api/deepsea-tailscale/loopback-forward`) { socket.destroy(); return }
    if (real === undefined) { fakeForward(req, socket, head, host); return }
    // The shipped handler, behind the same mount stripping Tailscale Serve does.
    host.requests.push({ port: Number(new URL(req.url, 'http://x').searchParams.get('port')), headers: req.headers })
    if (host.cookie !== undefined && !String(req.headers.cookie ?? '').split(/;\s*/).includes(host.cookie)) {
      refuse(socket, 401, 'not-admitted', 'not signed in')
      return
    }
    req.url = req.url.slice(mount.length - 1)
    const uid = process.getuid()
    void real.handleForwardUpgrade(req, socket, head, {
      policy: () => host.policy,
      selfUid: uid,
      reservedPorts: () => host.reserved,
      connections: new Set(),
      lookup: async port => host.ports.has(port) ? [{ pid: 4242, command: 'fake', uid, names: [`127.0.0.1:${String(port)}`] }] : [],
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  host.server = server
  host.port = server.address().port
  host.url = `http://127.0.0.1:${String(host.port)}${mount}`
  host.close = () => {
    for (const socket of host.sockets) socket.destroy()
    server.close()
  }
  return host
}
