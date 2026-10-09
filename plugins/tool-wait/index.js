/**
 * @deepsea/tool-wait: host half of the package root, row `deepsea-tool-wait`
 * ("Wait controls", global).
 *
 * Agents wait with bash (`sleep 30; echo done`) for servers, builds and
 * files. A shell sleep is opaque to the GUI: nothing shows how long it lasts
 * and the only way out is cancelling the whole turn. This package has a
 * `wait` tool that takes the duration as an argument, so the chat can draw
 * the call as a live progress bar (browser half, src/client) with two buttons:
 *
 *   Skip   the tool returns NOW, exactly like a completed timeout (the text
 *          says it was skipped and tells the model to carry on): for "I can
 *          see the thing is already done" or plain impatience.
 *   Abort  the tool returns an ERROR (code USER_ABORTED_WAIT, message
 *          "user aborted sleep: …") so the model stops and asks.
 *
 * Two rows. The tool and its prompt hint are the subpath row
 * `@deepsea/tool-wait/tools` (tools.js, `deepsea-tool-wait-tools`), which joins
 * the agent presets. This row stays global: it holds the pending waits
 * (service `deepseaWait`, which the tools row starts its waits in), the two
 * routes the browser half calls, and the browser half itself (a client is
 * served only for a package-root Host row).
 *
 * Routes (behind DSH's own authentication; the client sends its cookie):
 *
 *   GET  /api/deepsea-wait/status?callId=…&sessionId=…   → { pending, startedAt, deadline, requestedMs, reason, now }
 *        `now` is the server clock, so the browser can draw the bar against the
 *        clock that owns the deadline instead of its own.
 *   POST /api/deepsea-wait/control  { action: 'skip' | 'abort', callId, sessionId }   (JSON only)
 *        → { ok: true } | 404 (not pending: already settled) | 403 (session mismatch)
 *
 * The session id the browser sends must be one the tool call's agent belongs
 * to (`agent.session.id` / `agent.id`): a verdict cannot end another chat's wait.
 *
 * No config: `maxSeconds` and `promptHint` are the tools row's.
 */

import Schema from '@deepseek-ai/schemastery'
import { SERVICE, createWaitRegistry } from './wait.mjs'

export const name = 'deepsea-tool-wait'

export const inject = ['connection']

/** Nothing to configure here; the tool's settings are the tools row's (tools.js). */
export const Config = Schema.object({})

export { SERVICE }

/** Exact Fetch routes (below /api), mirrored in src/client/index.tsx: wire names kept from the plugin's old name (wait). */
export const STATUS_PATH = '/api/deepsea-wait/status'
export const CONTROL_PATH = '/api/deepsea-wait/control'

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - host-plane plugin context.
 */
export function apply(ctx) {
  const registry = createWaitRegistry()
  ctx.effect(() => () => registry.disposeAll(), 'tool-wait: pending waits')
  ctx.provide(SERVICE, registry)

  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })

  /** The pending entry for a (callId, sessionId) pair, or a Response explaining why not. */
  function authorized(callId, sessionId) {
    if (callId === '' || sessionId === '') return json({ error: 'missing callId or sessionId' }, 400)
    const entry = registry.get(callId)
    if (entry === undefined) return json({ error: 'no pending wait for this call (already settled?)', pending: false, now: Date.now() }, 404)
    if (!entry.sessionIds.includes(sessionId)) return json({ error: 'this wait belongs to another session' }, 403)
    return entry
  }

  const route = (definition, label) => ctx.effect(() => {
    const dispose = ctx.connection.fetch.register(definition)
    return () => { void dispose() }
  }, label)

  route({
    path: STATUS_PATH,
    methods: ['GET'],
    // Required by the node:http bridge: a route without it is treated as
    // streaming, and a streaming GET Request throws, so the webserver answers 400.
    requestBody: 'buffered',
    fetch: async (request) => {
      const url = new URL(request.url)
      const found = authorized(url.searchParams.get('callId') ?? '', url.searchParams.get('sessionId') ?? '')
      if (found instanceof Response) return found
      return json({ pending: true, startedAt: found.startedAt, deadline: found.deadline, requestedMs: found.requestedMs, reason: found.reason, now: Date.now() })
    },
  }, 'tool-wait: status route')

  route({
    path: CONTROL_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      // A JSON content type: a cross-site form cannot send one without a CORS preflight.
      if (!(request.headers.get('content-type') ?? '').startsWith('application/json')) return json({ error: 'body must be JSON (content-type: application/json)' }, 415)
      let body
      try { body = await request.json() } catch { return json({ error: 'body must be JSON' }, 400) }
      const action = typeof body?.action === 'string' ? body.action : ''
      const callId = typeof body?.callId === 'string' ? body.callId : ''
      const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
      if (action !== 'skip' && action !== 'abort') return json({ error: `unknown action "${action}"` }, 400)
      const found = authorized(callId, sessionId)
      if (found instanceof Response) return found
      const done = action === 'skip' ? registry.skip(callId) : registry.abort(callId)
      ctx.logger.info(`tool-wait: ${action} ${callId} (${found.reason || 'no reason'}) after ${Math.round((Date.now() - found.startedAt) / 100) / 10}s of ${found.requestedMs / 1000}s`)
      return done ? json({ ok: true, action }) : json({ error: 'wait settled concurrently', pending: false, now: Date.now() }, 404)
    },
  }, 'tool-wait: control route')

  ctx.logger.info('tool-wait: serving the wait status and control routes')
}
