/**
 * A minimal client of the brow daemon (protocol 1): JSON-RPC 2.0
 * over a Unix socket, one message per line; `$/cancel { id }` aborts a
 * request; the daemon notifies `session.notice`. The reference is the
 * daemon's docs/protocol.md; its own Node client is src/client.mjs.
 *
 * Vendored rather than linked: the protocol is small and language-neutral,
 * and linking the daemon's package would tie this plugin to a checkout path
 * (and to that checkout's dependencies, Chrome tooling included) in every
 * profile it is installed into. Talking to a daemon of another checkout, or
 * an installed one, needs only its socket. What this file does not copy: the
 * code stamp (the daemon's `hello.stamp` hashes its own sources, which only a
 * client in the same checkout can compare).
 *
 *   const client = await connect({ socket, name: '…', autostart: { command, env } })
 *   const { session } = await client.request('session.open', { key, label, cwd })
 *   client.on('session.notice', ({ session, text }) => …)
 *   client.onClose(() => …)
 */

import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

/** The protocol version this client speaks (the daemon's `hello.protocol`). */
export const PROTOCOL = 1

const CANCEL = '$/cancel'

export const ERRORS = Object.freeze({
  PARSE: -32700,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
})

export class RpcError extends Error {
  constructor(code, message, data) {
    super(message)
    this.name = 'RpcError'
    this.code = code
    if (data !== undefined) this.data = data
  }
}

/** A connection that closed under a request (the daemon stopped, restarted or crashed). */
export const CONNECTION_CLOSED = 'connection closed'

/**
 * The daemon's home, as the daemon resolves it (its src/paths.mjs): the home variable, else the bundle id's
 * directory in ~/Library/Application Support (macOS) or `$XDG_STATE_HOME/brow` (elsewhere; an XDG variable
 * counts only when it is an absolute path).
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [platform]
 */
export function daemonHome(env = process.env, platform = process.platform) {
  if (env.BROW_HOME) return env.BROW_HOME
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'io.github.taliesinb.brow')
  const state = env.XDG_STATE_HOME && isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : join(homedir(), '.local', 'state')
  return join(state, 'brow')
}

/**
 * The socket to dial: the configured one, else `<home>/run/daemon.sock` of the configured home, else the
 * daemon's own default (`BROW_SOCKET`, else `<daemon home>/run/daemon.sock`).
 * @param {{ socket?: string, home?: string }} config
 */
export function socketPathOf({ socket = '', home = '' } = {}, env = process.env, platform = process.platform) {
  if (socket !== '') return socket
  if (home !== '') return join(home, 'run', 'daemon.sock')
  if (env.BROW_SOCKET) return env.BROW_SOCKET
  return join(daemonHome(env, platform), 'run', 'daemon.sock')
}

/**
 * JSON-RPC over one socket. Responses can be large (inline screenshots are base64 in one line), so the
 * reader keeps chunks and looks for a newline only in what arrived since the last look.
 * @param {import('node:net').Socket} socket
 * @param {{ onNotification?: (method: string, params: any) => void, onClose?: () => void }} handlers
 */
export function createPeer(socket, { onNotification, onClose } = {}) {
  let nextId = 1
  let closed = false
  /** id → { resolve, reject } */
  const pending = new Map()
  let chunks = []

  function send(message) {
    if (closed || socket.destroyed) return
    socket.write(`${JSON.stringify(message)}\n`)
  }

  function handle(line) {
    let message
    try { message = JSON.parse(line) } catch { return }
    if (message === null || typeof message !== 'object') return
    if (typeof message.method === 'string') {
      if (message.id === undefined || message.id === null) { onNotification?.(message.method, message.params); return }
      send({ jsonrpc: '2.0', id: message.id, error: { code: ERRORS.METHOD_NOT_FOUND, message: `this client serves no method "${message.method}"` } })
      return
    }
    const waiter = pending.get(message.id)
    if (waiter === undefined) return
    pending.delete(message.id)
    if (message.error) waiter.reject(new RpcError(message.error.code, String(message.error.message ?? 'error'), message.error.data))
    else waiter.resolve(message.result)
  }

  socket.setEncoding('utf8')
  socket.on('data', (chunk) => {
    let start = 0
    let newline = chunk.indexOf('\n')
    while (newline >= 0) {
      const line = chunks.length > 0 ? chunks.join('') + chunk.slice(start, newline) : chunk.slice(start, newline)
      chunks = []
      if (line.trim() !== '') handle(line)
      start = newline + 1
      newline = chunk.indexOf('\n', start)
    }
    if (start < chunk.length) chunks.push(chunk.slice(start))
  })
  socket.on('error', () => {})
  socket.on('close', () => {
    if (closed) return
    closed = true
    for (const waiter of pending.values()) waiter.reject(new RpcError(ERRORS.INTERNAL, CONNECTION_CLOSED))
    pending.clear()
    onClose?.()
  })

  return {
    get closed() { return closed },
    /**
     * @param {string} method
     * @param {object} [params]
     * @param {{ signal?: AbortSignal, abandonMs?: number }} [options] - an aborted signal sends `$/cancel`;
     *   when the daemon has not answered `abandonMs` (default 5 s) later, the request rejects with the abort reason.
     */
    request(method, params, { signal, abandonMs = 5000 } = {}) {
      if (closed) return Promise.reject(new RpcError(ERRORS.INTERNAL, CONNECTION_CLOSED))
      const id = nextId++
      return new Promise((resolve, reject) => {
        let abandon
        const onAbort = () => {
          send({ jsonrpc: '2.0', method: CANCEL, params: { id } })
          abandon = setTimeout(() => {
            if (!pending.delete(id)) return
            reject(signal.reason ?? Object.assign(new Error('aborted'), { name: 'AbortError' }))
          }, abandonMs)
          abandon.unref?.()
        }
        const settle = (fn) => (value) => { clearTimeout(abandon); signal?.removeEventListener('abort', onAbort); fn(value) }
        pending.set(id, { resolve: settle(resolve), reject: settle(reject) })
        send({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) })
        if (signal?.aborted) onAbort()
        else signal?.addEventListener('abort', onAbort, { once: true })
      })
    },
    close() { socket.end() },
    destroy() { socket.destroy() },
  }
}

function dial(path) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path)
    socket.once('connect', () => { socket.off('error', reject); resolve(socket) })
    socket.once('error', reject)
  })
}

/**
 * How to run the daemon's `start` command: a `.mjs` / `.js` path (a checkout's bin/brow.mjs)
 * runs with this process's node; anything else is an executable (a name is looked up on PATH).
 * @param {string} command
 * @returns {{ file: string, args: string[] }}
 */
export function startCommandOf(command) {
  if (/\.[cm]?js$/.test(command)) return { file: process.execPath, args: [command, 'start'] }
  return { file: command, args: ['start'] }
}

/** The installed Brow.app (macOS) and the per-user LaunchAgent that runs its daemon. */
export const APP_BUNDLE_ID = 'io.github.taliesinb.brow'
export const LAUNCH_AGENT_LABEL = 'io.github.taliesinb.brow'

/**
 * Run a program to its exit, asynchronously; output kept (last 2000 characters) for messages.
 * Never throws: `{ code, output, error }`.
 * @param {string} file
 * @param {string[]} args
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<{ code: number | null | undefined, output: string, error?: Error }>}
 */
export function runProgram(file, args, { env = process.env } = {}) {
  return new Promise((resolve) => {
    let output = ''
    const keep = (chunk) => { output = (output + chunk).slice(-2000) }
    let child
    try {
      child = spawn(file, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ code: undefined, output, error })
      return
    }
    child.stdout.setEncoding('utf8').on('data', keep)
    child.stderr.setEncoding('utf8').on('data', keep)
    child.once('error', (error) => resolve({ code: undefined, output, error }))
    child.once('close', (code) => resolve({ code, output }))
  })
}

const whyFailed = (ran) => {
  const what = ran.error !== undefined ? String(ran.error.message ?? ran.error) : `exit code ${ran.code}`
  const said = ran.output.trim().split('\n').filter(Boolean).slice(-3).join(' / ')
  return said ? `${what}: ${said}` : what
}

/**
 * Start a daemon, the first way that works:
 *
 *   with `preferInstalled` (the default socket, on macOS):
 *     1. the LaunchAgent: `launchctl kickstart gui/<uid>/<label>`, when `launchctl print` knows it;
 *     2. the app: `open -g -b <bundle id>`, when LaunchServices finds it;
 *   3. `<command> start` (the daemon's CLI: a name on PATH or a checkout's bin/brow.mjs).
 *
 * A custom socket, home or daemon configuration can only be served by a daemon this process spawns, so
 * the caller passes `preferInstalled: false` for those and only 3 runs. Every step is an async child
 * process. Resolves `{ via, how, attempts }` (`via`: 'launch-agent' | 'app' | 'command'; `attempts`:
 * why the earlier ways were passed over) or throws with every attempt.
 * @param {object} options
 * @param {string} options.command
 * @param {NodeJS.ProcessEnv} [options.env] - for `<command> start` (launchctl and open get this process's).
 * @param {boolean} [options.preferInstalled]
 * @param {string} [options.platform]
 * @param {number} [options.uid]
 * @param {typeof runProgram} [options.run] - test seam.
 */
export async function startDaemon({ command, env = process.env, preferInstalled = false, platform = process.platform, uid = process.getuid?.(), run = runProgram }) {
  const attempts = []
  if (preferInstalled && platform === 'darwin') {
    const target = `gui/${uid}/${LAUNCH_AGENT_LABEL}`
    const printed = await run('launchctl', ['print', target])
    if (printed.code === 0) {
      const kicked = await run('launchctl', ['kickstart', target])
      if (kicked.code === 0) return { via: 'launch-agent', how: `launchctl kickstart ${target}`, attempts }
      attempts.push(`launchctl kickstart ${target} failed (${whyFailed(kicked)})`)
    } else {
      attempts.push(`no LaunchAgent ${LAUNCH_AGENT_LABEL} (launchctl print: ${whyFailed(printed)})`)
    }
    const opened = await run('open', ['-g', '-b', APP_BUNDLE_ID])
    if (opened.code === 0) return { via: 'app', how: `open -g -b ${APP_BUNDLE_ID}`, attempts }
    attempts.push(`Brow.app not found (open -b ${APP_BUNDLE_ID}: ${whyFailed(opened)})`)
  }
  const { file, args } = startCommandOf(command)
  const started = await run(file, args, { env })
  if (started.code === 0) return { via: 'command', how: `${command} start`, attempts }
  attempts.push(`"${command} start" failed (${whyFailed(started)})`)
  throw Object.assign(new Error(attempts.join('; ')), { attempts })
}

/**
 * Connect to the daemon and say hello.
 * @param {object} options
 * @param {string} options.socket
 * @param {string} [options.name] - client name for `hello`.
 * @param {string} [options.version]
 * @param {false | { command: string, env?: NodeJS.ProcessEnv, timeoutMs?: number, preferInstalled?: boolean, run?: typeof runProgram, platform?: string, uid?: number }} [options.autostart]
 *   start a daemon when none answers (startDaemon), then wait for the socket (default 15 s).
 * @param {(info: { via: string, how: string, attempts: string[] }) => void} [options.onStarted]
 */
export async function connect({ socket: path, name = 'deepsea-tool-brow', version = '0', autostart = false, onStarted }) {
  let socket
  try {
    socket = await dial(path)
  } catch (error) {
    if (!autostart || !['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw describeDialError(error, path)
    const timeoutMs = autostart.timeoutMs ?? 15_000
    const deadline = Date.now() + timeoutMs
    let started
    try {
      started = await startDaemon({ ...autostart, env: autostart.env ?? process.env })
    } catch (failure) {
      throw new Error(`no brow daemon answers on ${path}, and starting one failed: ${String(failure?.message ?? failure)}`, { cause: failure })
    }
    for (;;) {
      await new Promise(resolve => setTimeout(resolve, 100))
      try { socket = await dial(path); break } catch (retry) {
        if (Date.now() > deadline) throw new Error(`started the brow daemon (${started.how}) but nothing answered on ${path} within ${timeoutMs} ms; is that the socket it serves?`, { cause: retry })
      }
    }
    onStarted?.(started)
  }
  const listeners = new Map()
  const closeListeners = []
  const peer = createPeer(socket, {
    onNotification: (method, params) => { for (const listener of listeners.get(method) ?? []) listener(params) },
    onClose: () => { for (const listener of closeListeners) listener() },
  })
  let hello
  try {
    hello = await peer.request('hello', { client: { name, version }, protocol: PROTOCOL })
  } catch (error) {
    peer.destroy()
    throw new Error(`the brow daemon on ${path} did not answer hello: ${String(error?.message ?? error)}`, { cause: error })
  }
  if (hello?.protocol !== PROTOCOL) {
    peer.destroy()
    throw new Error(`the brow daemon (pid ${hello?.pid}, ${hello?.version}) speaks protocol ${hello?.protocol}, this plugin ${PROTOCOL}; update the one that is older`)
  }
  return {
    hello,
    socket: path,
    request: (method, params, options) => peer.request(method, params, options),
    on(method, listener) { listeners.set(method, [...(listeners.get(method) ?? []), listener]) },
    onClose(listener) { closeListeners.push(listener) },
    get closed() { return peer.closed },
    close() { peer.close() },
    destroy() { peer.destroy() },
  }
}

function describeDialError(error, path) {
  if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') return new Error(`no brow daemon is running on ${path}`, { cause: error })
  if (error.code === 'EACCES') return new Error(`cannot connect to ${path}: permission denied (another user's brow daemon?)`, { cause: error })
  return error
}
