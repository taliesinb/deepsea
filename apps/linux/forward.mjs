/**
 * Loopback port forwarding, the client half of "an agent on the server
 * printed `http://127.0.0.1:5173/`; make that link work here". The server
 * half is @deepsea/tailscale's forward route (plugins/tailscale/forward.mjs);
 * the macOS app's PortForward.swift is the other client.
 *
 * The protocol, per TCP connection:
 *   1. a WebSocket to `<mount>api/deepsea-tailscale/loopback-forward?port=<n>`
 *      with the page's cookies (Tailscale identity needs none: Serve adds it);
 *   2. a refusal is an HTTP status before the 101, its reason code in
 *      `X-DeepSea-Forward-Error` (reserved, nothing-listening, foreign-owner,
 *      disabled, not-operator, not-admitted, connect-failed, …);
 *   3. else a text frame `{"type":"connected",port,pid,command}`, then binary
 *      frames both ways until either side closes.
 *
 * `Forwarder.ensure(port)` probes once (handshake and `connected`, then a
 * clean close), then listens on `127.0.0.1:<port>` here, or on a free port
 * when that one is taken; every connection accepted there becomes one more
 * WebSocket. Listeners go when closed from the menu, on quit, or after an
 * hour without connections.
 *
 * `startLoopbackProxy` is the HTTP proxy the app's session uses for loopback
 * destinations only (Chromium's `<-loopback>` bypass rule): it sends each
 * request or CONNECT to the matching listener, so a page keeps its original
 * URL (Host header, absolute paths, the HMR socket) even when the local port
 * had to differ.
 */
import { EventEmitter } from 'node:events'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { connect, createServer, isIP } from 'node:net'
import { connectWebSocket, HandshakeError } from './websocket.mjs'

/** The forward route, relative to the mount directory. */
export const FORWARD_PATH = 'api/deepsea-tailscale/loopback-forward'
export const FORWARD_ERROR_HEADER = 'x-deepsea-forward-error'
const IDLE_LIMIT_MS = 60 * 60 * 1000
/** A single-use forward (a sign-in callback): closed this long after its connection ends, or after this many idle minutes. */
const SINGLE_USE_GRACE_MS = 2000
const SINGLE_USE_IDLE_MS = 10 * 60 * 1000
const HANDSHAKE_TIMEOUT_MS = 15_000

// ---------------------------------------------------------------------------
// Loopback URLs

/** A host name that means "this machine's loopback" (here: the server's). */
export function isLoopbackHost(raw) {
  const host = String(raw).toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0:0:0:0:0:0:0:1' || host === '0.0.0.0') return true
  return isIP(host) === 4 && host.startsWith('127.')
}

/** The TCP port a loopback http(s)/ws(s) URL names, or undefined for anything else. */
export function loopbackPort(value) {
  let url
  try { url = new URL(String(value)) } catch { return undefined }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || !isLoopbackHost(url.hostname)) return undefined
  return Number(url.port || (url.protocol === 'https:' || url.protocol === 'wss:' ? 443 : 80))
}

/** The loopback port an OAuth sign-in page redirects to (its `redirect_uri`), or undefined. */
export function loopbackRedirectPort(value) {
  let url
  try { url = new URL(String(value)) } catch { return undefined }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
  const redirect = url.searchParams.get('redirect_uri')
  return redirect === null ? undefined : loopbackPort(redirect)
}

/** The same loopback URL on another local port (when the remote's port is busy here). */
export function onLocalPort(value, localPort) {
  const url = new URL(String(value))
  if (Number(url.port || (url.protocol === 'https:' ? 443 : 80)) === localPort) return url.toString()
  url.hostname = '127.0.0.1'
  url.port = String(localPort)
  return url.toString()
}

/** The forward endpoint for a port, under a mount directory (`https://node/deepsea/`). */
export function forwardEndpoint(mount, port) {
  const url = new URL(FORWARD_PATH, String(mount))
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('port', String(port))
  return url.toString()
}

/** A refused or failed forward. `code` is the server's reason code when it gave one. */
export class ForwardError extends Error {
  constructor(port, code, message, status) {
    super(message)
    this.name = 'ForwardError'
    this.port = port
    this.code = code
    this.status = status
  }
}

/** What to tell a person about a refusal (the macOS app's wording). */
export function describeForwardError(error) {
  switch (error?.code) {
    case 'nothing-listening': return 'Nothing is listening on that port on the server\'s machine (or it belongs to another account).'
    case 'foreign-owner': return 'That port is held by another account on the server\'s machine.'
    case 'reserved': return 'That port is the DeepSea server itself: it is served by the remote, not forwarded.'
    case 'disabled': return 'Loopback forwarding is turned off on this server (loopbackForward: off).'
    case 'not-operator': return 'Loopback forwarding on this server is reserved for its operators.'
    case 'not-admitted': return 'Not signed in to the server.'
    case 'connect-failed': return `The server could not connect to that port.${error.message ? ` ${error.message}` : ''}`
    case 'lsof-unavailable': return 'The server cannot see its listening ports (lsof is unavailable there).'
    case 'too-many-connections': return 'The server has too many forwarded connections open.'
    case 'listen': return `Could not listen locally: ${error.message}`
    case 'transport': return `Could not reach the server: ${error.message}`
    default: return error?.message || 'The server refused the forward.'
  }
}

// ---------------------------------------------------------------------------
// Piping

/**
 * Pipe one TCP socket and one forwarding WebSocket both ways, with
 * backpressure in both directions; either side ending ends the other.
 * @param {import('node:net').Socket} tcp
 * @param {import('./websocket.mjs').WebSocket} ws
 */
export function pipeTunnel(tcp, ws) {
  tcp.on('data', (chunk) => { if (!ws.send(chunk, { binary: true })) tcp.pause() })
  ws.on('drain', () => tcp.resume())
  ws.on('message', (data, binary) => {
    if (!binary || data.length === 0) return
    if (!tcp.write(data)) ws.pause()
  })
  tcp.on('drain', () => ws.resume())
  tcp.on('end', () => ws.close(1000, 'local side ended'))
  tcp.on('error', () => ws.close(1011, 'local side failed'))
  tcp.on('close', () => ws.close(1000))
  ws.on('error', () => {})
  ws.on('close', () => { if (!tcp.destroyed) tcp.end(() => tcp.destroy()) })
  tcp.resume()
}

// ---------------------------------------------------------------------------
// The table of forwards

const listen = (server, port) => new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
    server.removeListener('error', reject)
    resolve(server.address().port)
  })
})

/**
 * Forwards of one server's loopback ports. Emits `change` when a forward
 * opens or closes, or its connection count changes.
 */
export class Forwarder extends EventEmitter {
  /**
   * @param {{
   *   mount: () => string | undefined,
   *   headers?: (httpUrl: string) => Promise<Record<string, string>> | Record<string, string>,
   *   log?: (line: string) => void,
   *   idleLimitMs?: number,
   *   ca?: unknown,
   * }} options `mount`: the mount directory now (undefined while offline);
   *   `headers`: request headers for the forward endpoint (Cookie, User-Agent)
   */
  constructor(options) {
    super()
    this.options = options
    this.listeners = new Map()
    this.pending = new Map()
    this.sockets = new Set()
    this.disposed = false
    this.timer = setInterval(() => this.closeIdle(), 60_000)
    this.timer.unref?.()
  }

  /**
   * One forwarding WebSocket, resolved after the server's `connected` frame.
   * @param {number} port
   * @returns {Promise<{ ws: import('./websocket.mjs').WebSocket, info: { port: number, pid?: number, command?: string } }>}
   */
  async tunnel(port, mount = this.options.mount()) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ForwardError(port, 'bad-port', 'invalid TCP port')
    if (this.disposed) throw new ForwardError(port, 'transport', 'forwarding has stopped')
    if (mount === undefined) throw new ForwardError(port, 'transport', 'the server is not connected')
    const endpoint = forwardEndpoint(mount, port)
    const headers = await this.options.headers?.(endpoint.replace(/^ws/, 'http')) ?? {}
    let ws
    try {
      ws = await connectWebSocket(endpoint, { headers, timeoutMs: HANDSHAKE_TIMEOUT_MS, ca: this.options.ca })
    } catch (error) {
      if (error instanceof HandshakeError && error.status !== undefined) {
        const code = String(error.headers[FORWARD_ERROR_HEADER] ?? `http-${String(error.status)}`)
        const message = error.body.trim().replace(/^[\w-]+:\s*/, '') || `HTTP ${String(error.status)}`
        throw new ForwardError(port, code, message, error.status)
      }
      throw new ForwardError(port, 'transport', error.message)
    }
    if (this.disposed) { ws.terminate(); throw new ForwardError(port, 'transport', 'forwarding has stopped') }
    this.sockets.add(ws)
    ws.once('close', () => this.sockets.delete(ws))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => fail('no connected frame from the server'), HANDSHAKE_TIMEOUT_MS)
      const fail = (message) => {
        clearTimeout(timer)
        ws.off('message', onMessage)
        ws.terminate()
        reject(new ForwardError(port, 'transport', message))
      }
      const onClose = (code, reason) => fail(`the server closed the forward (${String(code)}${reason ? ` ${reason}` : ''})`)
      const onMessage = (data, binary) => {
        let info
        try { info = binary ? undefined : JSON.parse(data.toString('utf8')) } catch { /* not JSON */ }
        if (info?.type !== 'connected') { fail('unexpected first frame from the forward endpoint'); return }
        clearTimeout(timer)
        ws.off('message', onMessage)
        ws.off('close', onClose)
        resolve({ ws, info })
      }
      ws.on('message', onMessage)
      ws.once('close', onClose)
      ws.on('error', () => {})
    })
  }

  /**
   * Make `127.0.0.1:<port>` of the machine of the server at `mount` (default: the app's own)
   * reachable here, on another local port when that one is taken here; resolves the listener
   * `{ remotePort, localPort, connections, since, mount, singleUse }`.
   * `exact` (a sign-in callback, whose redirect names the port): that port or nothing, bound
   * before the server is asked, so a port taken here (the sign-in's own listener, when the server
   * is on this machine after all) fails at once with code `listen`. `singleUse`: closed once a
   * connection has gone through (a moment after it ends), or after ten idle minutes.
   * @param {number} port
   * @param {{ mount?: string, exact?: boolean, singleUse?: boolean }} [options]
   */
  ensure(port, { mount = this.options.mount(), exact = false, singleUse = false } = {}) {
    if (mount === undefined) return Promise.reject(new ForwardError(port, 'transport', 'the server is not connected'))
    const key = `${mount}|${String(port)}`
    const existing = this.listeners.get(key)
    if (existing !== undefined) return Promise.resolve(existing.row)
    if (this.disposed) return Promise.reject(new ForwardError(port, 'transport', 'forwarding has stopped'))
    if (!this.pending.has(key)) {
      this.pending.set(key, this.open(port, { key, mount, exact, singleUse }).finally(() => this.pending.delete(key)))
    }
    return this.pending.get(key)
  }

  async open(port, { key, mount, exact, singleUse }) {
    const row = { remotePort: port, localPort: 0, connections: 0, since: Date.now(), lastActivity: Date.now(), mount, singleUse }
    const accepted = new Set()
    let served
    const server = createServer({ pauseOnConnect: true }, (socket) => {
      accepted.add(socket)
      row.connections += 1
      row.lastActivity = Date.now()
      clearTimeout(served)
      this.emit('change')
      socket.on('error', () => {})
      socket.once('close', () => {
        accepted.delete(socket)
        row.connections -= 1
        row.lastActivity = Date.now()
        // A single-use listener goes once its connection is done, after a moment for the
        // browser's follow-up requests (a favicon) on the same page.
        if (singleUse && row.connections === 0) served = setTimeout(() => { if (this.listeners.get(key)?.row === row) this.closeKey(key) }, SINGLE_USE_GRACE_MS)
        this.emit('change')
      })
      this.tunnel(port, mount).then(({ ws }) => {
        if (socket.destroyed) { ws.close(1000); return }
        pipeTunnel(socket, ws)
      }, (error) => {
        this.options.log?.(`forward: connection to remote ${String(port)} failed: ${error.message}`)
        socket.destroy()
      })
    })
    server.on('error', (error) => this.options.log?.(`forward: listener for remote ${String(port)} failed: ${error.message}`))
    let why
    if (exact) {
      // Bound before the server is asked: a port taken here costs no question.
      try { row.localPort = await listen(server, port) } catch (error) {
        server.close()
        throw new ForwardError(port, 'listen', `127.0.0.1:${String(port)} is taken here (${String(error.code ?? error.message)})`)
      }
    }
    try {
      const probe = await this.tunnel(port, mount)
      probe.ws.close(1000, 'probe')
      Object.assign(row, { pid: probe.info.pid, command: probe.info.command })
    } catch (error) {
      if (exact) server.close()
      throw error
    }
    if (!exact) {
      try {
        row.localPort = await listen(server, port)
      } catch (error) {
        why = error.code ?? error.message
        try {
          row.localPort = await listen(server, 0)
        } catch (inner) {
          server.close()
          throw new ForwardError(port, 'listen', inner.message)
        }
      }
    }
    if (this.disposed) { server.close(); throw new ForwardError(port, 'transport', 'forwarding has stopped') }
    this.listeners.set(key, { row, server, accepted })
    this.options.log?.(`forward: 127.0.0.1:${String(row.localPort)} → remote 127.0.0.1:${String(port)} via ${mount}${why ? ` (${String(port)} is busy here: ${why})` : ''}${singleUse ? ' (single use)' : ''}`)
    this.emit('change')
    return row
  }

  /** The forwards, by remote port. */
  get rows() {
    return [...this.listeners.values()].map(entry => entry.row).sort((a, b) => a.remotePort - b.remotePort)
  }

  closeKey(key) {
    const entry = this.listeners.get(key)
    if (entry === undefined) return
    this.listeners.delete(key)
    entry.server.close()
    for (const socket of entry.accepted) socket.destroy()
    this.options.log?.(`forward: closed 127.0.0.1:${String(entry.row.localPort)} → remote ${String(entry.row.remotePort)} via ${entry.row.mount}`)
    this.emit('change')
  }

  /** Close every forward of a remote port (the menu's Close). */
  close(port) {
    for (const [key, { row }] of [...this.listeners]) if (row.remotePort === port) this.closeKey(key)
  }

  closeAll() {
    for (const key of [...this.listeners.keys()]) this.closeKey(key)
  }

  closeIdle(now = Date.now()) {
    for (const [key, { row }] of [...this.listeners]) {
      const limit = row.singleUse ? SINGLE_USE_IDLE_MS : this.options.idleLimitMs ?? IDLE_LIMIT_MS
      if (row.connections === 0 && now - row.lastActivity > limit) this.closeKey(key)
    }
  }

  dispose() {
    this.disposed = true
    clearInterval(this.timer)
    this.closeAll()
    for (const ws of this.sockets) ws.terminate()
  }
}

// ---------------------------------------------------------------------------
// The loopback proxy

/**
 * An HTTP proxy on a free loopback port for loopback destinations: plain
 * requests are re-sent to the forward's listener, CONNECT (https, ws, wss)
 * is spliced to it. Anything else is refused: it never proxies other hosts.
 * @param {Forwarder} forwarder
 * @param {{ onError?: (port: number, error: Error) => void, redirect?: (port: number, url: URL) => string | undefined }} [options]
 *   `redirect`: where a refused port's plain request goes instead (the
 *   server's own port → its mount URL), or undefined
 * @returns {Promise<{ port: number, close(): void }>}
 */
export async function startLoopbackProxy(forwarder, options = {}) {
  const sockets = new Set()
  const refused = (port, error) => {
    options.onError?.(port, error)
    return `${error instanceof ForwardError ? describeForwardError(error) : error.message}\n`
  }
  const server = createHttpServer(async (req, res) => {
    let url
    try { url = new URL(req.url) } catch { res.writeHead(400).end('expected an absolute URL\n'); return }
    const port = url.protocol === 'http:' ? loopbackPort(url) : undefined
    if (port === undefined) { res.writeHead(403).end('only loopback destinations are proxied\n'); return }
    let row
    try {
      row = await forwarder.ensure(port)
    } catch (error) {
      const location = options.redirect?.(port, url)
      if (location !== undefined && error instanceof ForwardError && error.code === 'reserved') {
        res.writeHead(307, { Location: location, 'Cache-Control': 'no-store' }).end()
        return
      }
      if (!res.destroyed) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }).end(refused(port, error))
      return
    }
    if (res.destroyed) return
    const headers = { ...req.headers, connection: 'close' }
    delete headers['proxy-connection']
    delete headers['proxy-authorization']
    const upstream = httpRequest({ host: '127.0.0.1', port: row.localPort, method: req.method, path: `${url.pathname}${url.search}`, headers, agent: false }, (response) => {
      res.writeHead(response.statusCode ?? 502, response.rawHeaders)
      response.pipe(res)
    })
    upstream.on('error', (error) => { if (!res.headersSent) res.writeHead(502).end(`${error.message}\n`); else res.destroy() })
    res.once('close', () => upstream.destroy())
    req.pipe(upstream)
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => sockets.delete(socket))
  })
  server.on('connect', async (req, socket, head) => {
    socket.on('error', () => {})
    const port = loopbackPort(`https://${req.url}`)
    if (port === undefined) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return }
    let row
    try {
      row = await forwarder.ensure(port)
    } catch (error) {
      refused(port, error)
      socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
      return
    }
    if (socket.destroyed) return
    const upstream = connect(row.localPort, '127.0.0.1')
    upstream.once('connect', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    upstream.on('error', () => socket.destroy())
    upstream.on('close', () => socket.destroy())
    socket.once('close', () => upstream.destroy())
  })
  const port = await listen(server, 0)
  return {
    port,
    close() {
      server.close()
      for (const socket of sockets) socket.destroy()
    },
  }
}
