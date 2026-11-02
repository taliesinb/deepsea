/**
 * serve.mjs: the host half that makes THIS instance's transcripts readable
 * from another machine's transcript_* tools (remote.mjs is the client).
 *
 *   GET /api/deepsea-session-introspect/v1/capabilities   { plugin, version, api, routes }
 *   GET /api/deepsea-session-introspect/v1/sessions       { sessions: [{ id, header, cwd, createdAt, live, title, parent, depth }] }
 *   GET /api/deepsea-session-introspect/v1/session?id=…   { session: header, events: [...], live }   (gzip when accepted)
 *
 * Exact Fetch routes on DSH's shared `/api` channel (`ctx.connection.fetch`),
 * so they sit behind the same admission as every other API request: the
 * browser-session cookie, or, over the tailnet, the tailscale plugin's proxy
 * and its identity check. The routes add no policy of their own; whoever may
 * open this GUI may read these logs, which is already true through the GUI.
 *
 * Responses are JSON of exactly what the local source returns, so both
 * machines share one shape (source.mjs). The event log of one session is
 * gzipped when the client accepts it (DSH's own compression middleware is
 * off by default); attachments are never included — the log carries
 * references only, which is all the tools need.
 */

import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { API_VERSION, ROUTE_PREFIX } from './remote.mjs'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const ROUTES = ['capabilities', 'sessions', 'session']

/**
 * @param {any} ctx - plugin Context with `connection` and `sessionQuery`
 * @param {ReturnType<import('./source.mjs').createLocalSource>} local
 * @param {{ trace?: (line: object) => void }} [options]
 * @returns {string[]} the registered paths
 */
export function registerTranscriptRoutes(ctx, local, options = {}) {
  const trace = options.trace ?? (() => {})
  const respond = (request, body, status = 200) => {
    let payload = Buffer.from(JSON.stringify(body), 'utf8')
    const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
    if (status === 200 && payload.length > 1024 && /\bgzip\b/.test(request.headers.get('accept-encoding') ?? '')) {
      payload = gzipSync(payload)
      headers['content-encoding'] = 'gzip'
    }
    return new Response(payload, { status, headers })
  }
  const fail = (request, status, message) => respond(request, { error: message }, status)

  const handlers = {
    capabilities: async request => respond(request, { plugin: pkg.name, version: pkg.version, api: API_VERSION, routes: ROUTES }),
    sessions: async (request) => {
      const t0 = Date.now()
      const entries = await local.list(request.signal)
      trace({ event: 'serve-sessions', count: entries.length, ms: Date.now() - t0 })
      return respond(request, { sessions: entries })
    },
    session: async (request) => {
      const id = new URL(request.url).searchParams.get('id') ?? ''
      if (id === '') return fail(request, 400, 'missing id query parameter')
      const t0 = Date.now()
      let snapshot
      try {
        snapshot = await local.read(id, request.signal)
      } catch (error) {
        request.signal?.throwIfAborted()
        const message = error instanceof Error ? error.message : String(error)
        trace({ event: 'serve-session-failed', id, error: message })
        // Absence and refusal both surface as the reader's own diagnostic; the
        // client shows it like a local read failure.
        return fail(request, /not found|no such|does not exist|ENOENT/i.test(message) ? 404 : 422, message)
      }
      const live = await local.isLive(id, request.signal)
      trace({ event: 'serve-session', id, events: snapshot.events?.length ?? 0, ms: Date.now() - t0 })
      return respond(request, { session: snapshot.session, events: snapshot.events, live })
    },
  }

  const paths = []
  for (const [route, handler] of Object.entries(handlers)) {
    const path = `${ROUTE_PREFIX}/${route}`
    ctx.effect(() => {
      const dispose = ctx.connection.fetch.register({
        path,
        methods: ['GET'],
        // Required by the node:http bridge: a route without it is treated as
        // streaming, and a streaming GET Request throws → the webserver answers 400.
        requestBody: 'buffered',
        fetch: async (request) => {
          try {
            return await handler(request)
          } catch (error) {
            if (request.signal?.aborted) throw error
            const message = error instanceof Error ? error.message : String(error)
            trace({ event: 'serve-failed', route, error: message })
            return fail(request, 500, message)
          }
        },
      })
      return () => { void dispose() }
    }, `session-introspect: route ${route}`)
    paths.push(path)
  }
  return paths
}
