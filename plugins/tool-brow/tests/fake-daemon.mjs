// A fake brow daemon on a temporary Unix socket: the protocol's framing (one JSON-RPC message
// per line, $/cancel) and the methods this plugin uses, with sessions and leases kept simply and every
// request recorded. Tool calls are answered by `onCall(params, { signal })`.
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The daemon's tool list, as `tools.list` publishes it (shortened descriptions, the real shapes). */
export const TOOLS = [
  { name: 'browser_open', description: 'Open a NEW browser window.', inputSchema: { type: 'object', properties: { browser: { type: 'string', enum: ['chrome', 'safari'] }, url: { type: 'string' } } } },
  { name: 'browser_close', description: 'Close a window.', inputSchema: { type: 'object', properties: { handle: { type: 'string' } } } },
  { name: 'browser_navigate', description: 'Load a URL.', inputSchema: { type: 'object', properties: { handle: { type: 'string' }, url: { type: 'string' }, screenshot: { type: 'boolean' } } } },
  { name: 'browser_eval', description: 'Run JavaScript in the page.', inputSchema: { type: 'object', properties: { handle: { type: 'string' }, expression: { type: 'string' } }, required: ['expression'] } },
  { name: 'browser_read', description: 'Read a page.', inputSchema: { type: 'object', properties: { url: { type: 'string' }, format: { type: 'string', enum: ['markdown', 'plainText'] } } } },
  { name: 'browser_screenshot', description: 'Screenshot.', inputSchema: { type: 'object', properties: { handle: { type: 'string' }, fullPage: { type: 'boolean' } } } },
  { name: 'browser_act', description: 'Input steps.', inputSchema: { type: 'object', properties: { steps: { type: 'array', items: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] } } }, required: ['steps'] } },
  { name: 'browser_logs', description: 'Console messages.', inputSchema: { type: 'object', properties: { handle: { type: 'string' } } } },
]

/** A 1×1 PNG. */
export const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

/** A short socket path in a fresh temporary directory (Unix socket paths are limited to ~104 bytes). */
export function tempSocket() {
  const dir = mkdtempSync(join(tmpdir(), 'bs-fake-'))
  return { dir, socket: join(dir, 'd.sock'), remove: () => rmSync(dir, { recursive: true, force: true }) }
}

/**
 * @param {object} options
 * @param {string} options.socket
 * @param {number} [options.pid]
 * @param {object[]} [options.tools]
 * @param {(params: object, context: { signal: AbortSignal }) => Promise<object> | object} [options.onCall]
 * @param {boolean} [options.parking]
 * @param {number} [options.pollMs]
 * @param {() => void} [options.onShutdown]
 */
export async function startFakeDaemon({ socket, pid = 4242, tools = TOOLS, onCall, parking = true, pollMs = 200, onShutdown } = {}) {
  /** Every request: { method, params }. */
  const requests = []
  /** Cancelled request ids. */
  const cancelled = []
  /** key → { key, label, cwd, connections: Set } */
  const sessions = new Map()
  const connections = new Set()
  const commands = new Map()

  const server = createServer((sock) => {
    const conn = { sock, sessions: new Set(), running: new Map() }
    connections.add(conn)
    sock.setEncoding('utf8')
    let buffer = ''
    const send = (message) => { if (!sock.destroyed) sock.write(`${JSON.stringify(message)}\n`) }
    conn.notify = (method, params) => send({ jsonrpc: '2.0', method, params })
    sock.on('data', (chunk) => {
      buffer += chunk
      let newline
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line.trim() === '') continue
        const message = JSON.parse(line)
        if (message.method === '$/cancel') { cancelled.push(message.params.id); conn.running.get(message.params.id)?.abort(); continue }
        void (async () => {
          const controller = new AbortController()
          conn.running.set(message.id, controller)
          try {
            const result = await handle(message.method, message.params ?? {}, conn, controller.signal)
            send({ jsonrpc: '2.0', id: message.id, result: result ?? null })
          } catch (error) {
            send({ jsonrpc: '2.0', id: message.id, error: { code: error.code ?? -32603, message: error.message } })
          } finally {
            conn.running.delete(message.id)
          }
        })()
      }
    })
    sock.on('error', () => {})
    sock.on('close', () => {
      connections.delete(conn)
      for (const controller of conn.running.values()) controller.abort()
      for (const key of conn.sessions) sessions.get(key)?.connections.delete(conn)
    })
  })

  const invalid = (message) => Object.assign(new Error(message), { code: -32602 })
  const sessionOf = (key) => {
    const session = sessions.get(String(key))
    if (session === undefined) throw invalid(`unknown session "${key}"; open it with session.open (sessions end when their lease lapses)`)
    return session
  }

  async function handle(method, params, conn, signal) {
    requests.push({ method, params })
    switch (method) {
      case 'hello': return { server: 'brow', version: '0.1.0', protocol: 1, stamp: 'fake', pid, home: '/fake' }
      case 'session.open': {
        const key = String(params.key)
        let session = sessions.get(key)
        const resumed = session !== undefined
        if (!resumed) { session = { key, label: params.label, cwd: params.cwd, connections: new Set() }; sessions.set(key, session) }
        session.connections.add(conn)
        conn.sessions.add(key)
        return { session: key, resumed, windows: [] }
      }
      case 'session.update': {
        const session = sessionOf(params.session)
        if (params.label !== undefined) session.label = params.label
        if (params.cwd !== undefined) session.cwd = params.cwd
        return { ok: true }
      }
      case 'session.close': sessionOf(params.session); sessions.delete(String(params.session)); return { closed: [] }
      case 'tools.list': return { tools }
      case 'tools.call': {
        sessionOf(params.session)
        if (onCall === undefined) return { content: [{ type: 'text', text: `[chrome:0:0]\n${params.name} ok` }], isError: false }
        return onCall(params, { signal })
      }
      case 'app.report':
        if (!parking) return { ok: false, reason: 'parking is off (safari.hiddenWindows is not park)' }
        if (!Number.isInteger(params.report?.pid)) throw invalid('malformed window report')
        return { ok: true }
      case 'app.poll': {
        if (!parking) return {}
        const queued = commands.get(params.pid)
        if (queued) { commands.delete(params.pid); return { command: queued } }
        await new Promise((resolve) => { const t = setTimeout(resolve, pollMs); signal.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true }) })
        return {}
      }
      case 'daemon.shutdown': setImmediate(() => { void close().then(() => onShutdown?.()) }); return { ok: true }
      default: throw Object.assign(new Error(`unknown method "${method}"`), { code: -32601 })
    }
  }

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve) })

  let closing
  function close() {
    closing ??= new Promise((resolve) => {
      server.close(() => resolve())
      for (const conn of connections) conn.sock.destroy()
    })
    return closing
  }

  return {
    pid,
    socket,
    requests,
    cancelled,
    sessions,
    connections,
    /** Requests of one method. */
    of: (method) => requests.filter(r => r.method === method).map(r => r.params),
    /** Push a notice to the connections of a session (the daemon's `push` delivery). */
    notice(key, text) { for (const conn of sessions.get(key)?.connections ?? []) conn.notify('session.notice', { session: key, text }) },
    /** Queue a command for an app's poll. */
    command(appPid, command) { commands.set(appPid, command) },
    close,
  }
}
