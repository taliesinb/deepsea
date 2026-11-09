/**
 * The DeepSea app's window, relayed to the brow daemon. The macOS app
 * publishes its window to the page (`window.__DEEPSEA_APP_WINDOW__`, the
 * `deepsea-app-window` event: `{ pid, bundleId, frame, screen, key, active,
 * fullScreen }`); the browser half (src/client/index.tsx) POSTs each report
 * here and long-polls for `set-frame` commands, which it hands to the app.
 * The daemon does the rest (its core/app-windows.mjs and placement): Safari
 * windows park beside the app's window, which may be asked to make room.
 *
 *   POST ./api/deepsea-tool-brow/app-window          → app.report { report }
 *   GET  ./api/deepsea-tool-brow/app-command?pid=N   → app.poll { pid } (≤ 20 s)
 *
 * Whether the daemon parks is in its `hello` (`parking: { enabled, reason }`),
 * fixed for that daemon's life. With parking off the relay stops: nothing goes
 * to the daemon, and both routes answer 404 at once, which the browser half
 * reads as "no parking here" (it stops sending reports and asks again once a
 * minute, so a daemon restarted with parking on is found). The latest report
 * of each app is kept and replayed whenever the plugin (re)connects to a
 * daemon that parks, so a daemon started later (by the first tool call) still
 * learns where the app is. The relay never starts a daemon: without one,
 * reports are kept and polls wait out their time with nothing to do.
 */

import { ERRORS } from './daemon-client.mjs'

/** Exact Fetch routes (below /api), mirrored, document-relative, in src/client/index.tsx. */
export const APP_WINDOW_PATH = '/api/deepsea-tool-brow/app-window'
export const APP_COMMAND_PATH = '/api/deepsea-tool-brow/app-command'

/** Reports kept for replay (one per app process; a person rarely runs more than a couple of apps). */
const MAX_REPORTS = 8

/**
 * @param {object} options
 * @param {ReturnType<typeof import('./link.mjs').createLink>} options.link
 * @param {(event: object) => void} [options.trace]
 * @param {number} [options.idlePollMs] - how long a poll waits when no daemon is connected (default 20 s, the daemon's own poll time).
 * @param {number} [options.minPollMs] - a poll answered sooner is held this long (default 1 s): an empty answer comes at
 *   once when a newer poll of the same app took over, and the page's loop must not spin.
 */
export function createAppRelay({ link, trace = () => {}, idlePollMs = 20_000, minPollMs = 1000 }) {
  /** pid → the app's latest report. */
  const reports = new Map()
  /** The connected daemon's `hello.parking` ({ enabled, reason }), or undefined before the first connection. */
  let parking

  const parkingOf = (client) => client.hello.parking
  const off = (client) => ({ status: 404, body: { error: `the brow daemon does not park windows: ${parkingOf(client).reason}`, parking: false } })

  link.onConnected(async (client) => {
    parking = parkingOf(client)
    trace({ event: 'app-parking', parking: parking.enabled, reason: parking.reason })
    if (!parking.enabled) return
    for (const report of reports.values()) await client.request('app.report', { report }).catch(() => {})
  })

  /**
   * A report from the browser half.
   * @returns {Promise<{ status: number, body: object }>}
   */
  async function report(body) {
    if (body === null || typeof body !== 'object' || !Number.isInteger(body.pid) || body.pid <= 0) return { status: 400, body: { error: 'malformed window report' } }
    reports.delete(body.pid)
    reports.set(body.pid, body)
    while (reports.size > MAX_REPORTS) reports.delete(reports.keys().next().value)
    const client = link.current()
    if (client === undefined) return { status: 202, body: { ok: true, relayed: false } }
    if (!parkingOf(client).enabled) return off(client)
    try {
      await client.request('app.report', { report: body })
      return { status: 200, body: { ok: true } }
    } catch (error) {
      if (error?.code === ERRORS.INVALID_PARAMS) {
        reports.delete(body.pid)
        return { status: 400, body: { error: String(error.message) } }
      }
      return { status: 202, body: { ok: true, relayed: false } }
    }
  }

  /**
   * A long poll for the next command to one app.
   * @param {number} pid
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ status: number, body: object }>}
   */
  async function poll(pid, signal) {
    const started = Date.now()
    const client = link.current()
    if (client === undefined) {
      await sleep(idlePollMs, signal)
      return { status: 200, body: {} }
    }
    if (!parkingOf(client).enabled) return off(client)
    let result
    try {
      result = await client.request('app.poll', { pid }, { signal })
    } catch {
      result = {}
    }
    if (result?.command !== undefined) return { status: 200, body: { command: result.command } }
    const left = minPollMs - (Date.now() - started)
    if (left > 0) await sleep(left, signal)
    return { status: 200, body: {} }
  }

  return { report, poll, reports, get parking() { return parking } }
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return }
    const timer = setTimeout(done, ms)
    function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve() }
    signal?.addEventListener('abort', done, { once: true })
  })
}

/**
 * The two routes. Behind DeepSea's own authentication; the report is POST with a JSON body, so a
 * cross-site form cannot reach it without a CORS preflight.
 * @param {{ connection: { fetch: { register(route: object): () => unknown } }, effect(fn: () => () => void, label?: string): unknown }} ctx
 * @param {ReturnType<typeof createAppRelay>} relay
 */
export function registerAppRelayRoutes(ctx, relay) {
  const json = ({ status, body }) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
  const route = (definition, label) => ctx.effect(() => {
    const dispose = ctx.connection.fetch.register(definition)
    return () => { void dispose() }
  }, label)
  route({
    path: APP_WINDOW_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      if (!(request.headers.get('content-type') ?? '').startsWith('application/json')) return json({ status: 415, body: { error: 'body must be JSON (content-type: application/json)' } })
      let body
      try { body = await request.json() } catch { return json({ status: 400, body: { error: 'body must be JSON' } }) }
      return json(await relay.report(body))
    },
  }, 'tool-brow: app-window route')
  route({
    path: APP_COMMAND_PATH,
    methods: ['GET'],
    // Required by the node:http bridge: a route without it is treated as streaming, and a
    // streaming GET Request throws, so the web server would answer 400.
    requestBody: 'buffered',
    fetch: async (request) => {
      const pid = Number(new URL(request.url).searchParams.get('pid'))
      if (!Number.isInteger(pid) || pid <= 0) return json({ status: 400, body: { error: 'pid required' } })
      return json(await relay.poll(pid, request.signal))
    },
  }, 'tool-brow: app-command route')
  return [APP_WINDOW_PATH, APP_COMMAND_PATH]
}
