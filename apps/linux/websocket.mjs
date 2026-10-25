/**
 * A WebSocket client (RFC 6455), the part a byte pipe needs: the opening
 * handshake over http/https with its `Sec-WebSocket-Accept` check, masked
 * client frames, text and binary messages (fragmented server messages
 * reassembled), ping/pong, the closing handshake, and backpressure through
 * the socket. No extensions, no subprotocols. A refusal (any answer but 101)
 * rejects with its status, headers and the first 4 KB of its body.
 *
 * No `ws` dependency (apps carry none); the server half of the forwarding
 * protocol lives in plugins/tailscale/forward.mjs.
 */
import { createHash, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

export const OPCODE = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa }
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const DEFAULT_MAX_MESSAGE_BYTES = 32 * 1024 * 1024
const REFUSAL_BODY_BYTES = 4096
const CLOSE_TIMEOUT_MS = 2000

/** `Sec-WebSocket-Accept` for a key. */
export function acceptKey(key) {
  return createHash('sha1').update(`${String(key)}${GUID}`).digest('base64')
}

/** A refused or failed opening handshake. `status` is set when the server answered. */
export class HandshakeError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, headers?: Record<string, string | string[] | undefined>, body?: string }} [details]
   */
  constructor(message, details = {}) {
    super(message)
    this.name = 'HandshakeError'
    this.status = details.status
    this.headers = details.headers ?? {}
    this.body = details.body ?? ''
  }
}

/**
 * One client frame: FIN set, masked with a fresh random key.
 * @param {number} opcode
 * @param {Buffer | string} [payload]
 */
export function encodeClientFrame(opcode, payload = Buffer.alloc(0)) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8')
  const length = data.length
  const headerLength = length < 126 ? 2 : length < 65536 ? 4 : 10
  const frame = Buffer.allocUnsafe(headerLength + 4 + length)
  frame[0] = 0x80 | opcode
  if (length < 126) frame[1] = 0x80 | length
  else if (length < 65536) { frame[1] = 0x80 | 126; frame.writeUInt16BE(length, 2) }
  else { frame[1] = 0x80 | 127; frame.writeBigUInt64BE(BigInt(length), 2) }
  const mask = randomBytes(4)
  mask.copy(frame, headerLength)
  const start = headerLength + 4
  for (let index = 0; index < length; index++) frame[start + index] = data[index] ^ mask[index & 3]
  return frame
}

/** Close payload: status code and a UTF-8 reason (cut to fit a control frame). */
export function closePayload(code, reason = '') {
  if (code === undefined) return Buffer.alloc(0)
  const text = Buffer.from(String(reason), 'utf8').subarray(0, 123)
  const payload = Buffer.alloc(2 + text.length)
  payload.writeUInt16BE(code, 0)
  text.copy(payload, 2)
  return payload
}

/**
 * Incremental parser of server frames. Server frames are never masked (a
 * masked one is a protocol error); data frames may be fragmented and are
 * delivered whole; control frames are delivered as they come. Chunks are
 * kept in a list and joined only once a frame is complete, so a large frame
 * arriving in many TCP chunks is copied once.
 */
export class FrameReader {
  /**
   * @param {{ onMessage(opcode: number, payload: Buffer): void, onControl(opcode: number, payload: Buffer): void, onError(message: string): void, maxMessageBytes?: number }} handlers
   */
  constructor(handlers) {
    this.handlers = handlers
    this.maxMessageBytes = handlers.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES
    this.chunks = []
    this.size = 0
    this.fragments = []
    this.fragmentBytes = 0
    this.fragmentOpcode = 0
    this.failed = false
  }

  /** @param {Buffer} chunk */
  feed(chunk) {
    if (this.failed || chunk.length === 0) return
    this.chunks.push(chunk)
    this.size += chunk.length
    while (!this.failed && this.step()) { /* one frame per step */ }
  }

  /** The first `n` buffered bytes (joining chunks as needed), not consumed. */
  peek(n) {
    if (this.chunks[0].length < n) {
      let count = 0
      let bytes = 0
      while (bytes < n) bytes += this.chunks[count++].length
      this.chunks.splice(0, count, Buffer.concat(this.chunks.slice(0, count), bytes))
    }
    return this.chunks[0].subarray(0, n)
  }

  consume(n) {
    this.size -= n
    while (n > 0) {
      const first = this.chunks[0]
      if (first.length <= n) { this.chunks.shift(); n -= first.length }
      else { this.chunks[0] = first.subarray(n); n = 0 }
    }
  }

  fail(message) {
    this.failed = true
    this.chunks = []
    this.size = 0
    this.handlers.onError(message)
  }

  /** Parse one frame if it is complete; false when more bytes are needed. */
  step() {
    if (this.size < 2) return false
    const start = this.peek(2)
    const fin = (start[0] & 0x80) !== 0
    const opcode = start[0] & 0x0f
    if ((start[0] & 0x70) !== 0) { this.fail('reserved bits set'); return false }
    if ((start[1] & 0x80) !== 0) { this.fail('masked server frame'); return false }
    let length = start[1] & 0x7f
    let headerLength = 2
    if (length === 126) headerLength = 4
    else if (length === 127) headerLength = 10
    if (this.size < headerLength) return false
    const header = this.peek(headerLength)
    if (length === 126) length = header.readUInt16BE(2)
    else if (length === 127) {
      const big = header.readBigUInt64BE(2)
      if (big > BigInt(this.maxMessageBytes)) { this.fail('frame too large'); return false }
      length = Number(big)
    }
    if (length > this.maxMessageBytes) { this.fail('frame too large'); return false }
    if (this.size < headerLength + length) return false
    const payload = Buffer.from(this.peek(headerLength + length).subarray(headerLength))
    this.consume(headerLength + length)
    this.dispatch(fin, opcode, payload)
    return true
  }

  dispatch(fin, opcode, payload) {
    if (opcode >= 0x8) {
      if (!fin || payload.length > 125) { this.fail('malformed control frame'); return }
      if (opcode !== OPCODE.close && opcode !== OPCODE.ping && opcode !== OPCODE.pong) { this.fail(`unknown opcode ${String(opcode)}`); return }
      this.handlers.onControl(opcode, payload)
      return
    }
    if (opcode === OPCODE.continuation) {
      if (this.fragments.length === 0) { this.fail('continuation without a start frame'); return }
    } else if (opcode === OPCODE.text || opcode === OPCODE.binary) {
      if (this.fragments.length > 0) { this.fail('new message inside a fragmented one'); return }
      this.fragmentOpcode = opcode
    } else {
      this.fail(`unknown opcode ${String(opcode)}`)
      return
    }
    this.fragments.push(payload)
    this.fragmentBytes += payload.length
    if (this.fragmentBytes > this.maxMessageBytes) { this.fail('message too large'); return }
    if (!fin) return
    const message = this.fragments.length === 1 ? this.fragments[0] : Buffer.concat(this.fragments, this.fragmentBytes)
    this.fragments = []
    this.fragmentBytes = 0
    this.handlers.onMessage(this.fragmentOpcode, message)
  }
}

/**
 * An open connection. Events: `message` (data: Buffer, isBinary: boolean),
 * `pong` (payload), `drain`, `close` (code: number, reason: string; once,
 * after the socket is gone), `error` (only with a listener; the connection
 * then closes).
 */
export class WebSocket extends EventEmitter {
  /**
   * @param {import('node:net').Socket} socket the upgraded socket
   * @param {Buffer} head bytes that arrived with the 101
   * @param {{ maxMessageBytes?: number }} [options]
   */
  constructor(socket, head, options = {}) {
    super()
    this.socket = socket
    this.readyState = 'open'
    this.closeSent = false
    this.closeCode = 1006
    this.closeReason = ''
    this.closeTimer = undefined
    this.reader = new FrameReader({
      maxMessageBytes: options.maxMessageBytes,
      onMessage: (opcode, payload) => this.emit('message', payload, opcode === OPCODE.binary),
      onControl: (opcode, payload) => this.control(opcode, payload),
      onError: (message) => this.protocolError(message),
    })
    socket.setNoDelay?.(true)
    socket.on('data', chunk => this.reader.feed(chunk))
    socket.on('drain', () => this.emit('drain'))
    socket.on('end', () => { if (!socket.destroyed) socket.end() })
    socket.on('error', (error) => { if (this.listenerCount('error') > 0) this.emit('error', error) })
    socket.on('close', () => this.finish())
    // Nothing is read until the caller, who gets this object from a promise,
    // has had its turn to listen; bytes that came with the 101 go first.
    socket.pause()
    setImmediate(() => {
      if (head !== undefined && head.length > 0) this.reader.feed(head)
      if (this.readyState !== 'closed') socket.resume()
    })
  }

  /**
   * Send one message. Returns false when the socket's buffer is full: wait
   * for `drain` (or keep going and let the buffer grow).
   * @param {Buffer | string} data
   * @param {{ binary?: boolean }} [options] binary defaults to true for a Buffer
   */
  send(data, options = {}) {
    if (this.readyState !== 'open') return false
    const binary = options.binary ?? Buffer.isBuffer(data)
    return this.socket.write(encodeClientFrame(binary ? OPCODE.binary : OPCODE.text, data))
  }

  ping(payload = Buffer.alloc(0)) {
    if (this.readyState === 'open') this.socket.write(encodeClientFrame(OPCODE.ping, payload))
  }

  /** Start the closing handshake; the socket goes once the server answers (or after a grace period). */
  close(code = 1000, reason = '') {
    if (this.readyState === 'closed') return
    if (!this.closeSent && !this.socket.destroyed) {
      this.closeSent = true
      this.socket.write(encodeClientFrame(OPCODE.close, closePayload(code, reason)))
    }
    this.readyState = 'closing'
    this.closeTimer ??= setTimeout(() => this.socket.destroy(), CLOSE_TIMEOUT_MS)
    this.closeTimer.unref?.()
  }

  /** Drop the connection without a closing handshake. */
  terminate() {
    this.socket.destroy()
  }

  /** Stop reading from the server (backpressure towards it). */
  pause() { this.socket.pause() }
  resume() { this.socket.resume() }

  control(opcode, payload) {
    if (opcode === OPCODE.ping) {
      if (this.readyState === 'open') this.socket.write(encodeClientFrame(OPCODE.pong, payload))
    } else if (opcode === OPCODE.pong) {
      this.emit('pong', payload)
    } else if (opcode === OPCODE.close) {
      this.closeCode = payload.length >= 2 ? payload.readUInt16BE(0) : 1005
      this.closeReason = payload.length > 2 ? payload.subarray(2).toString('utf8') : ''
      if (!this.closeSent && !this.socket.destroyed) {
        this.closeSent = true
        this.socket.write(encodeClientFrame(OPCODE.close, payload.subarray(0, 2)))
      }
      this.readyState = 'closing'
      // The server closes the TCP connection after the handshake (RFC 6455 §7.1.1).
      this.socket.end()
      this.closeTimer ??= setTimeout(() => this.socket.destroy(), CLOSE_TIMEOUT_MS)
      this.closeTimer.unref?.()
    }
  }

  protocolError(message) {
    this.closeCode = 1002
    this.closeReason = message
    if (!this.closeSent && !this.socket.destroyed) {
      this.closeSent = true
      this.socket.write(encodeClientFrame(OPCODE.close, closePayload(1002, message)))
    }
    if (this.listenerCount('error') > 0) this.emit('error', new Error(`WebSocket protocol error: ${message}`))
    this.socket.destroy()
  }

  finish() {
    if (this.readyState === 'closed') return
    this.readyState = 'closed'
    clearTimeout(this.closeTimer)
    this.emit('close', this.closeCode, this.closeReason)
  }
}

/**
 * Open a WebSocket.
 * @param {string | URL} url ws:, wss:, http: or https:
 * @param {{ headers?: Record<string, string>, timeoutMs?: number, maxMessageBytes?: number, ca?: unknown }} [options]
 * @returns {Promise<WebSocket>}
 */
export function connectWebSocket(url, options = {}) {
  const target = new URL(String(url))
  if (target.protocol === 'ws:') target.protocol = 'http:'
  else if (target.protocol === 'wss:') target.protocol = 'https:'
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return Promise.reject(new HandshakeError(`not a WebSocket URL: ${String(url)}`))
  const key = randomBytes(16).toString('base64')
  const timeoutMs = options.timeoutMs ?? 10_000
  return new Promise((resolve, reject) => {
    let settled = false
    const settle = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(value)
    }
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest
    const req = send(target, {
      method: 'GET',
      agent: false,
      ...(options.ca === undefined ? {} : { ca: options.ca }),
      headers: {
        ...options.headers,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key,
      },
    })
    const timer = setTimeout(() => {
      settle(new HandshakeError(`WebSocket handshake with ${target.host} timed out`))
      req.destroy()
    }, timeoutMs)
    timer.unref?.()
    req.on('upgrade', (res, socket, head) => {
      const upgrade = String(res.headers.upgrade ?? '').toLowerCase()
      if (upgrade !== 'websocket' || res.headers['sec-websocket-accept'] !== acceptKey(key)) {
        socket.destroy()
        settle(new HandshakeError('the server answered 101 with a wrong WebSocket accept key', { status: res.statusCode, headers: res.headers }))
        return
      }
      if (settled) { socket.destroy(); return }
      settle(undefined, new WebSocket(socket, head, { maxMessageBytes: options.maxMessageBytes }))
    })
    req.on('response', (res) => {
      const parts = []
      let size = 0
      res.on('data', (chunk) => {
        if (size < REFUSAL_BODY_BYTES) parts.push(chunk.subarray(0, REFUSAL_BODY_BYTES - size))
        size += chunk.length
      })
      const done = () => settle(new HandshakeError(`HTTP ${String(res.statusCode)}`, {
        status: res.statusCode, headers: res.headers, body: Buffer.concat(parts).toString('utf8'),
      }))
      res.on('end', done)
      res.on('close', done)
      res.on('error', done)
    })
    req.on('error', (error) => settle(new HandshakeError(error.message)))
    req.end()
  })
}
