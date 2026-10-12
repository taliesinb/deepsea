/**
 * The DeepSea app's windows: the macOS app showing this server reports its
 * native window here, through the plugin's browser half, so placement can put
 * an agent's Safari windows beside the window that drives them and ask that
 * window to make room, without Accessibility.
 *
 * The app's side (apps/macos, "window cooperation"): it sets
 * `window.__DEEPSEA_APP_WINDOW__` and dispatches a `deepsea-app-window` event
 * with `{ pid, bundleId, frame, screen: { frame, visible }, key, active,
 * fullScreen }` (rects in global points, top-left origin) on every move,
 * resize, screen or focus change and after each load, answers
 * `{type: 'window-info'}` with a fresh report, and takes
 * `{type: 'set-frame', frame}` on `webkit.messageHandlers.deepseaApp`
 * (frames that stay on a screen, at least 320 × 240, not in full screen).
 *
 * Wire between the browser half and this module (routes in index.js):
 *   POST ./api/deepsea-browser/app-window    a report, relayed (JSON body)
 *   GET  ./api/deepsea-browser/app-command?pid=N
 *        long poll (≤ 20 s): { command: { type: 'set-frame', frame } } or {}
 *
 * Only windows on this Mac matter: placement matches a report's pid AND
 * bundle id AND frame against the window server's layout, so the app of a
 * person using this server from another Mac never qualifies.
 */

/** Exact Fetch routes (below /api). Mirrored, document-relative, in src/client/index.tsx. */
export const APP_WINDOW_PATH = '/api/deepsea-browser/app-window'
export const APP_COMMAND_PATH = '/api/deepsea-browser/app-command'

const rect = (r) => r && ['x', 'y', 'width', 'height'].every(k => typeof r[k] === 'number' && Number.isFinite(r[k])) ? { x: r.x, y: r.y, width: r.width, height: r.height } : undefined
const near = (a, b, t = 3) => Math.abs(a - b) <= t
export const sameRect = (a, b, t = 3) => !!a && !!b && near(a.x, b.x, t) && near(a.y, b.y, t) && near(a.width, b.width, t) && near(a.height, b.height, t)

/** Validate a report body; undefined when malformed. */
export function parseReport(body) {
  if (!body || typeof body !== 'object' || !Number.isInteger(body.pid) || body.pid <= 0 || typeof body.bundleId !== 'string') return undefined
  const frame = rect(body.frame)
  if (!frame) return undefined
  const screen = body.screen && rect(body.screen.frame) && rect(body.screen.visible) ? { frame: rect(body.screen.frame), visible: rect(body.screen.visible) } : undefined
  return { pid: body.pid, bundleId: body.bundleId, frame, screen, key: body.key === true, active: body.active === true, fullScreen: body.fullScreen === true }
}

/**
 * @param {{ trace?: (event: object) => void, pollMs?: number }} [options]
 */
export function createAppWindows({ trace = () => {}, pollMs = 20_000 } = {}) {
  /** pid → latest report (+ `at`). */
  const windows = new Map()
  /** pid → queued commands. */
  const queues = new Map()
  /** pid → resolver of the pending long poll. */
  const polls = new Map()
  /** Waiters for a report matching a requested frame. */
  let frameWaiters = []

  function report(body) {
    const info = parseReport(body)
    if (!info) return false
    const first = !windows.has(info.pid)
    windows.set(info.pid, { ...info, at: Date.now() })
    if (first) trace({ event: 'app-window', pid: info.pid, bundleId: info.bundleId, frame: info.frame })
    frameWaiters = frameWaiters.filter(w => {
      if (w.pid === info.pid && sameRect(w.frame, info.frame, 4)) { w.resolve(info); return false }
      return true
    })
    return true
  }

  /** The latest report of a process, if any. */
  const get = (pid) => windows.get(pid)

  /** Long poll of one app: the next command for its pid, or undefined after pollMs. */
  function poll(pid, signal) {
    const queue = queues.get(pid)
    if (queue?.length) return Promise.resolve(queue.shift())
    polls.get(pid)?.(undefined) // one poller per pid: the newest wins
    return new Promise(resolve => {
      const finish = (command) => { clearTimeout(timer); if (polls.get(pid) === finish) polls.delete(pid); resolve(command) }
      const timer = setTimeout(() => finish(undefined), pollMs)
      polls.set(pid, finish)
      signal?.addEventListener('abort', () => finish(undefined), { once: true })
    })
  }

  function send(pid, command) {
    const waiting = polls.get(pid)
    if (waiting) { polls.delete(pid); waiting(command); return }
    const queue = queues.get(pid) ?? []
    queue.push(command)
    queues.set(pid, queue.slice(-4))
  }

  /**
   * Ask an app window to take `frame`; resolves with its report once it has
   * (within 4 pt), or undefined after `timeoutMs` (no browser half polling,
   * an app without set-frame, or a refused frame).
   */
  function setFrame(pid, frame, timeoutMs = 2500) {
    return new Promise(resolve => {
      const waiter = { pid, frame, resolve: (info) => { clearTimeout(timer); resolve(info) } }
      const timer = setTimeout(() => { frameWaiters = frameWaiters.filter(w => w !== waiter); resolve(undefined) }, timeoutMs)
      frameWaiters.push(waiter)
      send(pid, { type: 'set-frame', frame })
      trace({ event: 'app-set-frame', pid, frame })
    })
  }

  function dispose() {
    for (const finish of [...polls.values()]) finish(undefined)
    polls.clear()
    for (const w of frameWaiters) w.resolve(undefined)
    frameWaiters = []
  }

  return { report, get, poll, setFrame, dispose, windows }
}

/**
 * The two routes through which this server's DeepSea apps (by way of the
 * browser half) report their windows and receive set-frame requests. Behind
 * DeepSea's own authentication; the report is POST with a JSON body, so a
 * cross-site form cannot reach it without a CORS preflight.
 * @param {{ connection: { fetch: { register(route: object): () => unknown } }, effect(fn: () => () => void, label?: string): unknown }} ctx
 * @param {ReturnType<typeof createAppWindows>} appWindows
 */
export function registerAppWindowRoutes(ctx, appWindows) {
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
  const route = (definition, label) => ctx.effect(() => {
    const dispose = ctx.connection.fetch.register(definition)
    return () => { void dispose() }
  }, label)
  route({
    path: APP_WINDOW_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      if (!(request.headers.get('content-type') ?? '').startsWith('application/json')) return json({ error: 'body must be JSON (content-type: application/json)' }, 415)
      let body
      try { body = await request.json() } catch { return json({ error: 'body must be JSON' }, 400) }
      return appWindows.report(body) ? json({ ok: true }) : json({ error: 'malformed window report' }, 400)
    },
  }, 'browser: app-window route')
  route({
    path: APP_COMMAND_PATH,
    methods: ['GET'],
    // Required by the node:http bridge: a route without it is treated as streaming, and a
    // streaming GET Request throws, so the web server would answer 400.
    requestBody: 'buffered',
    fetch: async (request) => {
      const pid = Number(new URL(request.url).searchParams.get('pid'))
      if (!Number.isInteger(pid) || pid <= 0) return json({ error: 'pid required' }, 400)
      const command = await appWindows.poll(pid, request.signal)
      return json(command ? { command } : {})
    },
  }, 'browser: app-command route')
  return [APP_WINDOW_PATH, APP_COMMAND_PATH]
}
