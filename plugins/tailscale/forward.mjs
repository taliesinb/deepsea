/**
 * Loopback port forwarding, the server half of "an agent on this machine
 * printed `http://127.0.0.1:5173/`; make that link work on the device looking
 * at the GUI".
 *
 * The DeepSea app on another Mac binds `127.0.0.1:<port>` there and, per
 * accepted TCP connection, opens one WebSocket to
 * `<serve path>/api/deepsea-tailscale/loopback-forward?port=<port>` through
 * Tailscale Serve and the proxy (which forwards any admitted upgrade). This
 * module answers that upgrade on DSH's own http.Server: it decides whether
 * the port may be forwarded, connects to it on this machine's loopback, and
 * pipes bytes as binary WebSocket frames both ways, one TCP connection per
 * socket. The URL the agent printed then works verbatim on the client: same
 * Host header, absolute paths, cookies and the dev server's HMR socket.
 *
 * Policy, in order:
 *   1. admission, the `loopbackForward` config: `off`; `operators` (this node,
 *      `x-deepsea-tailscale-self`, and with `identityOperators` the
 *      identity-admitted users); `admitted` (anyone the proxy let in: a token
 *      holder already drives an agent with a shell here, so forwarding this
 *      account's ports adds nothing). A direct loopback caller (no proxy
 *      headers) passes: DSH's own browser-session gate vetted it;
 *   2. reserved ports: this variant's server, proxy and relay ports are served
 *      by the variant itself; a raw forward would only bypass the fence;
 *   3. the uid guard: `lsof` must show the listener, and every visible
 *      listener must belong to the uid running this server. On a Mac with one
 *      variant per account that is exactly "a server this account's agent
 *      started"; other accounts' listeners are invisible to an unprivileged
 *      `lsof` (404).
 * Refusals are HTTP statuses before the 101, with the reason code in
 * `X-DeepSea-Forward-Error`; failures after the handshake close the
 * WebSocket with a reason.
 *
 * No `ws` dependency: the framing needed here (masked client frames, unmasked
 * server frames, ping/pong/close, fragmentation) is small and self-contained.
 */
import { execFile as execFileCallback } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { connect } from 'node:net'
import { HEADER } from './proxy.mjs'

/** Exact upgrade path on DSH's web server (Serve strips the Serve path before it). */
export const FORWARD_PATH = '/api/deepsea-tailscale/loopback-forward'
/** The response header naming a refusal's reason (the macOS app reads it). */
export const FORWARD_ERROR_HEADER = 'X-DeepSea-Forward-Error'
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
/** Largest single WebSocket message accepted from the client. */
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024
const LSOF_TIMEOUT_MS = 4000

export const OPCODE = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa }

// ---------------------------------------------------------------------------
// Request parsing and policy (pure)

/**
 * @param {string | undefined} url request URL (path + query)
 * @returns {{ port: number } | { error: string }}
 */
export function parseForwardRequest(url) {
  let parsed
  try {
    parsed = new URL(url ?? '/', 'http://x')
  } catch {
    return { error: 'malformed URL' }
  }
  const raw = parsed.searchParams.get('port')
  if (raw === null || !/^\d{1,5}$/.test(raw)) return { error: 'port must be a decimal TCP port (?port=5173)' }
  const port = Number(raw)
  if (port < 1 || port > 65535) return { error: 'port out of range' }
  return { port }
}

/**
 * Who may open a forward, from the facts the proxy attaches after admission
 * (it drops client copies of these headers, so they cannot be forged from the
 * tailnet; a request without them came in on loopback directly).
 * @param {import('node:http').IncomingMessage['headers']} headers
 * @param {'off' | 'operators' | 'admitted'} policy
 * @param {boolean} [identityOperators] - identity-admitted users count as operators (the proxy's rule)
 * @returns {{ ok: true, via: 'direct' | 'operator' | 'user' | 'cookie' } | { ok: false, status: number, code: string, message: string }}
 */
export function forwardAdmission(headers, policy, identityOperators = false) {
  if (policy === 'off') return { ok: false, status: 403, code: 'disabled', message: 'loopback forwarding is off (loopbackForward: off)' }
  const proxied = headers[HEADER.proxied] === '1'
  if (!proxied) return { ok: true, via: 'direct' }
  const admitted = String(headers[HEADER.admitted] ?? '')
  if (headers[HEADER.self] === '1' || (identityOperators && admitted === 'user')) return { ok: true, via: 'operator' }
  if (policy === 'operators') return { ok: false, status: 403, code: 'not-operator', message: 'loopback forwarding is for operators only (loopbackForward: operators)' }
  if (admitted === 'user' || admitted === 'cookie') return { ok: true, via: admitted }
  return { ok: false, status: 401, code: 'not-admitted', message: 'not signed in' }
}

/**
 * Parse `lsof -F pcun` output into listening owners: one record per process,
 * with the socket names it listens on.
 * @param {string} text
 * @returns {Array<{ pid: number, command: string, uid: number, names: string[] }>}
 */
export function parseLsofListeners(text) {
  const owners = []
  let current
  for (const line of String(text).split('\n')) {
    if (line === '') continue
    const field = line[0]
    const value = line.slice(1)
    switch (field) {
      case 'p':
        current = { pid: Number(value), command: '', uid: -1, names: [] }
        owners.push(current)
        break
      case 'c': if (current !== undefined) current.command = value; break
      case 'u': if (current !== undefined) current.uid = Number(value); break
      case 'n': if (current !== undefined) current.names.push(value); break
      default: break
    }
  }
  return owners.filter(owner => Number.isInteger(owner.pid))
}

/**
 * Processes listening on a TCP port, as far as this uid may see them
 * (`lsof` hides other users' processes from an unprivileged caller — which is
 * what the uid guard wants: invisible = not ours).
 * @param {number} port
 * @param {{ execFile?: typeof execFileCallback, lsofPath?: string }} [options]
 * @returns {Promise<Array<{ pid: number, command: string, uid: number, names: string[] }>>}
 */
export function lookupListeners(port, options = {}) {
  const execFile = options.execFile ?? execFileCallback
  // macOS keeps it in /usr/sbin; elsewhere (NixOS has no /usr/sbin) it is found on PATH.
  const lsof = options.lsofPath ?? (existsSync('/usr/sbin/lsof') ? '/usr/sbin/lsof' : 'lsof')
  return new Promise((resolve, reject) => {
    execFile(lsof, ['-nP', `-iTCP:${String(port)}`, '-sTCP:LISTEN', '-F', 'pcun'], { timeout: LSOF_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      // lsof exits 1 when nothing matches; that is "no listener", not a failure.
      if (error && error.code !== 1) {
        reject(new Error(`lsof failed: ${error.code === 'ENOENT' ? 'binary not found' : String(error.message)}`))
        return
      }
      resolve(parseLsofListeners(String(stdout ?? '')))
    })
  })
}

/**
 * Which loopback addresses to try for a port, from the listeners' socket names:
 * a concrete loopback address is used as is; a wildcard (`*:port`) means
 * 127.0.0.1 first (an IPv6 wildcard without v6only accepts v4-mapped too),
 * then ::1. Non-loopback bindings (a LAN address) are ignored — the forward is
 * loopback-only by contract.
 * @param {Array<{ names: string[] }>} owners
 * @param {number} port
 * @returns {Array<{ host: string, port: number }>}
 */
export function connectCandidates(owners, port) {
  const hosts = []
  const push = host => { if (!hosts.includes(host)) hosts.push(host) }
  for (const owner of owners) {
    for (const name of owner.names) {
      const at = name.lastIndexOf(':')
      const host = at === -1 ? name : name.slice(0, at)
      if (host === '*' || host === '') { push('127.0.0.1'); push('::1') }
      else if (host === '127.0.0.1' || host.startsWith('127.')) push(host)
      else if (host === '[::1]') push('::1')
      else if (host === 'localhost') { push('127.0.0.1'); push('::1') }
    }
  }
  if (hosts.length === 0) { push('127.0.0.1'); push('::1') }
  return hosts.map(host => ({ host, port }))
}

/**
 * The forwarding decision for one port.
 * @param {{ port: number, owners: Array<{ pid: number, command: string, uid: number, names: string[] }>, selfUid: number, reservedPorts: Iterable<number> }} facts
 * @returns {{ ok: true, owner: { pid: number, command: string }, targets: Array<{ host: string, port: number }> } | { ok: false, status: number, code: string, message: string }}
 */
export function forwardDecision({ port, owners, selfUid, reservedPorts }) {
  if (new Set(reservedPorts).has(port)) {
    return { ok: false, status: 403, code: 'reserved', message: `port ${String(port)} belongs to this variant (served by it, not forwarded)` }
  }
  if (owners.length === 0) {
    return { ok: false, status: 404, code: 'nothing-listening', message: `nothing this account can see listens on 127.0.0.1:${String(port)}` }
  }
  const foreign = owners.find(owner => owner.uid !== selfUid)
  if (foreign !== undefined) {
    return { ok: false, status: 403, code: 'foreign-owner', message: `port ${String(port)} is held by a process of another account (uid ${String(foreign.uid)})` }
  }
  return { ok: true, owner: { pid: owners[0].pid, command: owners[0].command }, targets: connectCandidates(owners, port) }
}

// ---------------------------------------------------------------------------
// RFC 6455, the parts a byte pipe needs

/** `Sec-WebSocket-Accept` for a client key. */
export function acceptKey(key) {
  return createHash('sha1').update(`${String(key)}${WS_GUID}`).digest('base64')
}

/**
 * One complete frame, server→client (never masked).
 * @param {number} opcode
 * @param {Buffer | string} payload
 */
export function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8')
  let header
  if (data.length < 126) {
    header = Buffer.from([0x80 | opcode, data.length])
  } else if (data.length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(data.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(data.length), 2)
  }
  return Buffer.concat([header, data])
}

/**
 * Close frame payload: status code + UTF-8 reason.
 * @param {number} code
 * @param {string} reason
 */
export function encodeClose(code, reason = '') {
  const text = Buffer.from(reason, 'utf8').subarray(0, 123)
  const payload = Buffer.alloc(2 + text.length)
  payload.writeUInt16BE(code, 0)
  text.copy(payload, 2)
  return encodeFrame(OPCODE.close, payload)
}

/**
 * Incremental frame parser (client→server: masked or not; fragmented data
 * frames are reassembled, control frames delivered whole).
 */
export class FrameParser {
  /**
   * @param {{ onMessage(opcode: number, payload: Buffer): void, onControl(opcode: number, payload: Buffer): void, onError(message: string): void, maxMessageBytes?: number }} handlers
   */
  constructor(handlers) {
    this.handlers = handlers
    this.buffer = Buffer.alloc(0)
    this.fragments = []
    this.fragmentOpcode = 0
    this.fragmentBytes = 0
    this.maxMessageBytes = handlers.maxMessageBytes ?? MAX_MESSAGE_BYTES
    this.failed = false
  }

  /** @param {Buffer} chunk */
  feed(chunk) {
    if (this.failed) return
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    for (;;) {
      const frame = this.next()
      if (frame === undefined || this.failed) return
      this.dispatch(frame)
    }
  }

  fail(message) {
    this.failed = true
    this.buffer = Buffer.alloc(0)
    this.handlers.onError(message)
  }

  /** @returns {{ fin: boolean, opcode: number, payload: Buffer } | undefined} */
  next() {
    const buf = this.buffer
    if (buf.length < 2) return undefined
    const fin = (buf[0] & 0x80) !== 0
    if ((buf[0] & 0x70) !== 0) { this.fail('reserved bits set'); return undefined }
    const opcode = buf[0] & 0x0f
    const masked = (buf[1] & 0x80) !== 0
    let length = buf[1] & 0x7f
    let offset = 2
    if (length === 126) {
      if (buf.length < 4) return undefined
      length = buf.readUInt16BE(2)
      offset = 4
    } else if (length === 127) {
      if (buf.length < 10) return undefined
      const big = buf.readBigUInt64BE(2)
      if (big > BigInt(this.maxMessageBytes)) { this.fail('frame too large'); return undefined }
      length = Number(big)
      offset = 10
    }
    if (length > this.maxMessageBytes) { this.fail('frame too large'); return undefined }
    const maskOffset = offset
    if (masked) offset += 4
    if (buf.length < offset + length) return undefined
    const payload = Buffer.from(buf.subarray(offset, offset + length))
    if (masked) {
      for (let index = 0; index < payload.length; index++) payload[index] ^= buf[maskOffset + (index & 3)]
    }
    this.buffer = buf.subarray(offset + length)
    return { fin, opcode, payload }
  }

  dispatch(frame) {
    const { fin, opcode, payload } = frame
    if (opcode >= 0x8) {
      if (!fin || payload.length > 125) { this.fail('malformed control frame'); return }
      this.handlers.onControl(opcode, payload)
      return
    }
    if (opcode === OPCODE.continuation) {
      if (this.fragments.length === 0) { this.fail('continuation without a start frame'); return }
    } else if (opcode === OPCODE.text || opcode === OPCODE.binary) {
      if (this.fragments.length > 0) { this.fail('new data frame inside a fragmented message'); return }
      this.fragmentOpcode = opcode
    } else {
      this.fail(`unknown opcode ${String(opcode)}`)
      return
    }
    this.fragments.push(payload)
    this.fragmentBytes += payload.length
    if (this.fragmentBytes > this.maxMessageBytes) { this.fail('message too large'); return }
    if (!fin) return
    const message = this.fragments.length === 1 ? this.fragments[0] : Buffer.concat(this.fragments)
    this.fragments = []
    this.fragmentBytes = 0
    this.handlers.onMessage(this.fragmentOpcode, message)
  }
}

// ---------------------------------------------------------------------------
// The upgrade handler

function refuse(socket, status, code, message) {
  const reasons = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 502: 'Bad Gateway', 503: 'Service Unavailable' }
  const body = `${code}: ${message}\n`
  socket.end(`HTTP/1.1 ${String(status)} ${reasons[status] ?? 'Error'}\r\n`
    + `Content-Type: text/plain; charset=utf-8\r\n${FORWARD_ERROR_HEADER}: ${code}\r\n`
    + `Content-Length: ${String(Buffer.byteLength(body))}\r\nConnection: close\r\n\r\n${body}`)
}

/**
 * Connect to the first target that accepts.
 * @param {Array<{ host: string, port: number }>} targets
 * @param {number} timeoutMs
 * @returns {Promise<import('node:net').Socket>}
 */
export function connectFirst(targets, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let index = 0
    const attempt = () => {
      const target = targets[index]
      if (target === undefined) { reject(new Error('no loopback target accepted the connection')); return }
      const tcp = connect({ host: target.host, port: target.port })
      const timer = setTimeout(() => tcp.destroy(new Error('connect timed out')), timeoutMs)
      tcp.once('connect', () => {
        clearTimeout(timer)
        tcp.removeAllListeners('error')
        resolve(tcp)
      })
      tcp.once('error', (error) => {
        clearTimeout(timer)
        index += 1
        if (targets[index] === undefined) reject(error)
        else attempt()
      })
    }
    attempt()
  })
}

/**
 * Answer one `loopback-forward` upgrade.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:stream').Duplex} socket
 * @param {Buffer} head
 * @param {{
 *   policy: () => 'off' | 'operators' | 'admitted',
 *   identityOperators?: () => boolean,
 *   selfUid: number,
 *   reservedPorts: () => Iterable<number>,
 *   lookup?: (port: number) => Promise<Array<{ pid: number, command: string, uid: number, names: string[] }>>,
 *   connections: Set<unknown>,
 *   maxConnections?: number,
 *   log?: (line: string) => void,
 * }} options
 */
export async function handleForwardUpgrade(req, socket, head, options) {
  socket.on('error', () => {})
  const key = req.headers['sec-websocket-key']
  if (String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket' || typeof key !== 'string' || key === '') {
    refuse(socket, 400, 'not-websocket', 'expected a WebSocket upgrade')
    return
  }
  const admission = forwardAdmission(req.headers, options.policy(), options.identityOperators?.() ?? false)
  if (!admission.ok) { refuse(socket, admission.status, admission.code, admission.message); return }
  const request = parseForwardRequest(req.url)
  if ('error' in request) { refuse(socket, 400, 'bad-port', request.error); return }
  if (options.connections.size >= (options.maxConnections ?? 64)) {
    refuse(socket, 503, 'too-many-connections', 'too many forwarded connections are open')
    return
  }
  let owners
  try {
    owners = await (options.lookup ?? lookupListeners)(request.port)
  } catch (error) {
    refuse(socket, 503, 'lsof-unavailable', String(error?.message ?? error))
    return
  }
  const decision = forwardDecision({ port: request.port, owners, selfUid: options.selfUid, reservedPorts: options.reservedPorts() })
  if (!decision.ok) { refuse(socket, decision.status, decision.code, decision.message); return }
  if (socket.destroyed) return
  let tcp
  try {
    tcp = await connectFirst(decision.targets)
  } catch (error) {
    refuse(socket, 502, 'connect-failed', `127.0.0.1:${String(request.port)} refused the connection: ${String(error?.message ?? error)}`)
    return
  }
  if (socket.destroyed) { tcp.destroy(); return }

  const token = {}
  options.connections.add(token)
  const label = `port ${String(request.port)} (${decision.owner.command} pid ${String(decision.owner.pid)}) for ${admission.via}`
  options.log?.(`tailscale: forward opened: ${label}`)

  let closed = false
  const finish = (reason) => {
    if (closed) return
    closed = true
    options.connections.delete(token)
    options.log?.(`tailscale: forward closed: ${label}${reason === undefined ? '' : ` (${reason})`}`)
    tcp.destroy()
    socket.destroy()
  }
  const sendClose = (code, reason) => {
    if (socket.destroyed) return
    socket.write(encodeClose(code, reason))
    socket.end()
  }

  const parser = new FrameParser({
    onMessage: (_opcode, payload) => {
      if (payload.length === 0) return
      if (!tcp.write(payload)) socket.pause()
    },
    onControl: (opcode, payload) => {
      if (opcode === OPCODE.ping) { if (!socket.destroyed) socket.write(encodeFrame(OPCODE.pong, payload)) }
      else if (opcode === OPCODE.close) {
        // Peer wants out: echo the close and let the target see a FIN.
        if (!socket.destroyed) socket.write(encodeClose(1000, ''))
        tcp.end()
        setTimeout(() => finish('client closed'), 500).unref()
      }
    },
    onError: (message) => {
      sendClose(1002, message)
      finish(`protocol error: ${message}`)
    },
  })

  socket.setNoDelay?.(true)
  tcp.setNoDelay(true)
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`)
  socket.write(encodeFrame(OPCODE.text, JSON.stringify({ type: 'connected', port: request.port, pid: decision.owner.pid, command: decision.owner.command })))

  tcp.on('data', (chunk) => { if (!socket.write(encodeFrame(OPCODE.binary, chunk))) tcp.pause() })
  socket.on('drain', () => tcp.resume())
  tcp.on('drain', () => socket.resume())
  tcp.on('end', () => {
    sendClose(1000, 'target closed')
    setTimeout(() => finish('target closed'), 500).unref()
  })
  tcp.on('error', (error) => {
    sendClose(1011, error.message)
    finish(`target error: ${error.message}`)
  })
  socket.on('data', chunk => parser.feed(chunk))
  socket.on('end', () => finish('client hung up'))
  socket.on('close', () => finish())
  if (head.length > 0) parser.feed(head)
}
