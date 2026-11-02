/**
 * @deepsea/reboot: `/reboot` restarts this `dsh web` process from inside a
 * session, with a graceful SIGTERM to itself. Whether that is a restart or a
 * quit depends on what started the process: the relay of an installed variant
 * (apps/relay; it sets `DEEPSEA_RELAY` to its URL) starts the server again on
 * the next connection and the page comes back; without one the server stops.
 * The reply and the dialog say which.
 *
 * Two surfaces share one controller (reboot.mjs):
 *
 *   - the host command `/reboot [status|now|if-idle|wait|cancel]`, logged as
 *     command/run + command/done like /compact;
 *   - the control routes `POST /deepsea-reboot/<endpoint>` the browser half
 *     polls for the dialog it hangs on the bare `/reboot` (a ui-commands
 *     decoration): `status` (busy sessions, armed state, relay facts), `now`,
 *     `if-idle` (reboot only when nothing is in flight, else `ok: false` with
 *     the busy list), `wait`, `cancel`.
 *
 * "Busy" means a running turn, running background jobs or loaded subagents
 * (the blockers the Host names when it refuses to move a live session), or
 * queued follow-ups. `wait` arms a host-side state that survives closing the
 * dialog or the tab and fires after 2 s of every session being idle.
 *
 * The routes sit behind DSH's own request gate (`connection.requestRejection`:
 * the Host/Origin fence and the browser-session cookie) and take the
 * Connection JSON envelope, so any admitted connection reaches them.
 */
import { connect } from 'node:net'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { RebootController, busySessions, describeBlockers, parseArgs, relayVerdict } from './reboot.mjs'

export const name = 'deepsea-reboot'
export const inject = ['webServer', 'connection', 'commands', 'agents']

/** The control routes' prefix (document-relative in the browser). */
export const CHANNEL = '/deepsea-reboot'
const MAX_BODY = 16 * 1024
/** Answer the request (and let command/done land) before the process goes. */
const FIRE_DELAY_MS = 400
/** Relay facts cost a `launchctl` call: reused across polls this long. */
const RELAY_CACHE_MS = 5000

/** Whether something accepts TCP connections at a URL's host and port (1 s). */
function answers(url) {
  let target
  try { target = new URL(url) } catch { return Promise.resolve(false) }
  return new Promise((resolve) => {
    const socket = connect({ host: target.hostname, port: Number(target.port) || 80 })
    const done = (ok) => { socket.destroy(); clearTimeout(timer); resolve(ok) }
    const timer = setTimeout(() => done(false), 1000)
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  const log = line => ctx.logger.info(line)

  const controller = new RebootController({
    busy: () => busySessions({ agents: ctx.agents, jobs: ctx.get('jobs') }),
    fire: (reason) => {
      log(`reboot: sending SIGTERM to pid ${String(process.pid)} in ${String(FIRE_DELAY_MS)} ms (${reason})`)
      setTimeout(() => { process.kill(process.pid, 'SIGTERM') }, FIRE_DELAY_MS)
    },
    log,
  })
  ctx.effect(() => () => { controller.dispose() }, 'reboot: controller')
  // A turn ending is the moment an armed reboot most often becomes possible;
  // the controller's own 1 s poll covers jobs and queue changes.
  ctx.on('agent/status', () => { controller.evaluate() })

  // ---- relay facts: DEEPSEA_RELAY, set by the relay that started this server ----
  /** @type {{ at: number, value: any } | undefined} */
  let relayCache
  const relayFacts = async () => {
    const url = process.env.DEEPSEA_RELAY
    if (!url) return { present: false }
    if (relayCache !== undefined && Date.now() - relayCache.at < RELAY_CACHE_MS) return relayCache.value
    const value = { present: true, wakeUrl: url, listening: await answers(url) }
    relayCache = { at: Date.now(), value }
    return value
  }

  const snapshot = async () => {
    const relay = await relayFacts()
    return {
      ...controller.status(),
      relay,
      verdict: relayVerdict(relay),
      process: { pid: process.pid, port: ctx.webServer.port, uptimeSeconds: Math.round(process.uptime()), home: resolveDshHome() },
    }
  }

  // ---- the host command ----------------------------------------------------------
  ctx.effect(() => ctx.commands.register({
    name: 'reboot',
    description: 'Restart this DeepSea server',
    input: { hint: 'status | now | if-idle | wait | cancel' },
    handler: async ({ agent, rawInput }) => {
      const parsed = parseArgs(rawInput)
      if (typeof parsed === 'object') return { kind: 'error', text: parsed.error }
      // One plain clause on what follows the SIGTERM; the dialog says the same.
      const relayNote = relayVerdict(await relayFacts()).text
      switch (parsed) {
        case 'status': {
          // The transcript keeps one line; live detail belongs to the dialog.
          const status = controller.status()
          const busy = status.busy.length === 0
            ? 'nothing in flight'
            : `${String(status.busy.length)} session${status.busy.length === 1 ? '' : 's'} busy (${status.busy.map(row => describeBlockers(row.blockers)).join('; ')})`
          const armed = status.armed === undefined ? 'no reboot armed' : `a when-idle reboot armed since ${new Date(status.armed.since).toLocaleTimeString()}`
          return { kind: 'success', text: `Reboot status: ${busy}, ${armed}. ${relayNote}` }
        }
        case 'now': {
          const outcome = controller.rebootNow(agent.id)
          return outcome.ok ? { kind: 'success', text: `${outcome.message} ${relayNote}` } : { kind: 'error', text: outcome.message }
        }
        case 'if-idle': {
          const outcome = controller.rebootIfIdle(agent.id)
          return outcome.ok ? { kind: 'success', text: `${outcome.message} ${relayNote}` } : { kind: 'error', text: outcome.message }
        }
        case 'wait': {
          const outcome = controller.rebootWhenIdle(agent.id)
          return outcome.ok ? { kind: 'success', text: `${outcome.message} ${relayNote}` } : { kind: 'error', text: outcome.message }
        }
        case 'cancel': {
          const outcome = controller.cancel()
          return outcome.ok ? { kind: 'success', text: outcome.message } : { kind: 'error', text: outcome.message }
        }
        default:
          return { kind: 'error', text: 'unreachable' }
      }
    },
  }), 'reboot: /reboot')

  // ---- control routes for the browser half -----------------------------------------
  const ok = value => ({ ok: true, value })
  const fail = (code, message, details = {}) => ({ ok: false, error: { code: `deepsea-reboot/${code}`, message, details } })
  const dispatch = async (endpoint, args) => {
    const by = typeof args.sessionId === 'string' ? args.sessionId : undefined
    switch (endpoint) {
      case 'status': return ok(await snapshot())
      case 'now': {
        const outcome = controller.rebootNow(by)
        return outcome.ok ? ok({ ...outcome, ...(await snapshot()) }) : fail('now', outcome.message)
      }
      case 'if-idle': {
        // A busy server answers ok:false with the blockers in details.busy and is left alone.
        const outcome = controller.rebootIfIdle(by)
        return outcome.ok ? ok({ ...outcome, ...(await snapshot()) }) : fail('busy', outcome.message, { busy: outcome.busy, ...(await snapshot()) })
      }
      case 'wait': {
        const outcome = controller.rebootWhenIdle(by)
        return outcome.ok ? ok({ ...outcome, ...(await snapshot()) }) : fail('wait', outcome.message)
      }
      case 'cancel': {
        const outcome = controller.cancel()
        return outcome.ok ? ok({ ...outcome, ...(await snapshot()) }) : fail('cancel', outcome.message)
      }
      default: return fail('unknown-endpoint', `unknown endpoint ${endpoint}`)
    }
  }
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: CHANNEL,
    handler: async (req, res) => {
      const rejection = ctx.connection.requestRejection(req)
      if (rejection !== undefined) {
        res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      const endpoint = new URL(req.url ?? '/', 'http://x').pathname.slice(CHANNEL.length + 1)
      if (req.method !== 'POST' || endpoint === '' || endpoint.includes('/')) { res.writeHead(404); res.end('not found'); return }
      let message
      try { message = JSON.parse(await readBody(req, MAX_BODY)) } catch { res.writeHead(400); res.end('body is not JSON'); return }
      if (typeof message !== 'object' || message === null || message.type !== 'client-request' || typeof message.rpcId !== 'string' || message.method !== endpoint) {
        res.writeHead(400); res.end('invalid client-request envelope'); return
      }
      const args = typeof message.payload?.args === 'object' && message.payload.args !== null ? message.payload.args : {}
      let result
      try {
        result = await dispatch(endpoint, args)
      } catch (error) {
        result = fail('internal', String(error?.message ?? error))
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ type: 'server-response', rpcId: message.rpcId, result }))
    },
  }), 'reboot: control routes')
}
