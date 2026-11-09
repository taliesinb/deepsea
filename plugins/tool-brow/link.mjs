/**
 * The plugin's link to the brow daemon: one connection at a time,
 * made on demand (single flight), with or without starting the daemon.
 *
 * - `ensure({ autostart })` resolves the live connection, dialing (and, with
 *   autostart, running `<command> start`) when there is none. Tool calls ask
 *   with autostart; the app-window relay and background reconnects without,
 *   so a daemon the person stopped is started again only by a tool call.
 * - When the connection closes (the daemon stopped, restarted or crashed),
 *   a few quick reconnects without autostart follow (0.25 s, 1 s, 3 s), so a
 *   restarted daemon gets this server's sessions and app reports back at once;
 *   after that the next tool call reconnects.
 * - `onConnected(fn)` runs on every new connection (the first included):
 *   re-open sessions, replay the app's window reports, re-read the tools.
 * - Notification listeners (`on`) survive reconnects.
 * - How a daemon was started (LaunchAgent, app or command; daemon-client.mjs
 *   `startDaemon`) is traced, logged, and offered once as a note for the
 *   result of the call that started it (`takeStartNote`).
 */

import { connect as connectDaemon } from './daemon-client.mjs'

const RECONNECT_DELAYS_MS = [250, 1000, 3000]

/** "via its LaunchAgent (launchctl kickstart …)" and so on, for logs and notes. */
export function describeStart({ via, how }) {
  const what = via === 'launch-agent' ? 'via its LaunchAgent' : via === 'app' ? 'by opening Brow.app' : 'with its command'
  return `${what} (${how})`
}

/**
 * @param {object} options
 * @param {string} options.socket
 * @param {{ command: string, env?: NodeJS.ProcessEnv, timeoutMs?: number, preferInstalled?: boolean } | false} options.autostart - how to start a daemon (false: never); daemon-client.mjs `startDaemon`.
 * @param {string} [options.name]
 * @param {string} [options.version]
 * @param {{ info(m: string): void, warn(m: string): void }} [options.logger]
 * @param {(event: object) => void} [options.trace]
 * @param {typeof connectDaemon} [options.connect] - test seam.
 * @param {number[]} [options.reconnectDelaysMs]
 */
export function createLink({ socket, autostart, name, version, logger = { info() {}, warn() {} }, trace = () => {}, connect = connectDaemon, reconnectDelaysMs = RECONNECT_DELAYS_MS }) {
  /** @type {Awaited<ReturnType<typeof connectDaemon>> | undefined} */
  let client
  /** @type {Promise<object> | undefined} */
  let dialing
  let disposed = false
  let reconnectTimer
  const listeners = new Map()
  const connectedHooks = []
  let lastPid
  /** Said once, in front of the result of the call that started the daemon. */
  let startNote = ''

  function adopt(next) {
    client = next
    for (const [method, list] of listeners) next.on(method, (params) => { for (const listener of list) listener(params) })
    next.onClose(() => {
      if (client !== next) return
      client = undefined
      trace({ event: 'disconnected', pid: next.hello.pid })
      if (!disposed) logger.warn(`tool-brow: the connection to the brow daemon (pid ${next.hello.pid}) closed`)
      scheduleReconnect(0)
    })
    const restarted = lastPid !== undefined && lastPid !== next.hello.pid
    lastPid = next.hello.pid
    trace({ event: 'connected', pid: next.hello.pid, version: next.hello.version, home: next.hello.home, restarted })
    logger.info(`tool-brow: connected to brow ${next.hello.version} (pid ${next.hello.pid}) on ${socket}`)
    for (const hook of connectedHooks) {
      try {
        void Promise.resolve(hook(next, { restarted })).catch((error) => logger.warn(`tool-brow: after connecting: ${String(error?.message ?? error)}`))
      } catch (error) {
        logger.warn(`tool-brow: after connecting: ${String(error?.message ?? error)}`)
      }
    }
  }

  function scheduleReconnect(attempt) {
    clearTimeout(reconnectTimer)
    if (disposed || attempt >= reconnectDelaysMs.length) return
    reconnectTimer = setTimeout(() => {
      if (disposed || client !== undefined) return
      ensure({ autostart: false }).catch(() => scheduleReconnect(attempt + 1))
    }, reconnectDelaysMs[attempt])
    reconnectTimer.unref?.()
  }

  /**
   * The live connection, dialing when there is none.
   * @param {{ autostart?: boolean }} [options]
   */
  function ensure({ autostart: start = false } = {}) {
    if (disposed) return Promise.reject(new Error('the brow daemon link is closed (plugin unloading)'))
    if (client !== undefined && !client.closed) return Promise.resolve(client)
    // A dial without autostart in flight does not satisfy a caller that wants one: chain behind it.
    if (dialing !== undefined) return dialing.then(c => c, (error) => (start && autostart ? ensure({ autostart: true }) : Promise.reject(error)))
    const attempt = connect({ socket, name, version, autostart: start ? autostart : false, onStarted: ({ via, how, attempts }) => {
      trace({ event: 'daemon-started', via, how, attempts, socket })
      logger.info(`tool-brow: started the brow daemon ${describeStart({ via, how })}${attempts.length > 0 ? ` (passed over: ${attempts.join('; ')})` : ''}`)
      startNote = `Started the brow daemon ${describeStart({ via, how })}. `
    } })
    dialing = attempt
      .then((next) => {
        if (disposed) { next.close(); throw new Error('the brow daemon link is closed (plugin unloading)') }
        adopt(next)
        return next
      })
      .finally(() => { dialing = undefined })
    return dialing
  }

  return {
    ensure,
    /** The live connection, or undefined (never dials). */
    current: () => (client !== undefined && !client.closed ? client : undefined),
    /** Listen to a daemon notification on every connection. */
    on(method, listener) {
      const list = listeners.get(method)
      if (list !== undefined) { list.push(listener); return }
      listeners.set(method, [listener])
      if (client !== undefined) client.on(method, (params) => { for (const l of listeners.get(method) ?? []) l(params) })
    },
    /** How the daemon was started, once (for the next tool result), or ''. */
    takeStartNote() { const note = startNote; startNote = ''; return note },
    /** Run after every new connection: `(client, { restarted })`. */
    onConnected(hook) { connectedHooks.push(hook) },
    async dispose() {
      disposed = true
      clearTimeout(reconnectTimer)
      const last = client
      client = undefined
      last?.close()
    },
  }
}
