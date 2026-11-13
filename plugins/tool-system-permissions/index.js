/**
 * @deepsea/tool-system-permissions: host half of the package root, row
 * `deepsea-tool-system-permissions` ("System permission controls", global).
 *
 * The tool `seek_system_permission` lives in the subpath row
 * `@deepsea/tool-system-permissions/tools` (tools.js), which joins the agent
 * presets. This row stays global and holds what a preset row cannot:
 *
 *   - the service `deepseaSystemPermissions`: the prober every call uses
 *     (macOS, or the fake one of the test mode) and the registry of running
 *     and finished calls;
 *   - the routes the card calls;
 *   - the slash command `/system-permissions` (command.mjs);
 *   - the browser half (the card; src/client).
 *
 * Routes (behind DSH's own authentication):
 *
 *   GET  /api/deepsea-tool-system-permissions/status?callId=…&sessionId=…
 *        → { running, snapshot: { subject, rows, startedAt, finishedAt, noticeAt, noticeMs }, now[, fake] }
 *        Finished calls are kept (the last 200, in
 *        $DSH_HOME/plugins/tool-system-permissions/calls.json), so a card
 *        reloaded after its call was cancelled still shows its rows.
 *   POST /api/deepsea-tool-system-permissions/action   { action: 'grant' | 'deny', permission, callId, sessionId }   (JSON only)
 *        → { ok: true } | 404 (no running call, or that row is settled) | 403 (session mismatch)
 *   GET  /api/deepsea-tool-system-permissions/running
 *        → { calls: [{ callId, sessionId, noticeAt, noticeMs, open, total }], now }
 *        every running call with an open row, for the browser half's notices
 *        (src/client/notice.ts)
 *   GET  /api/deepsea-tool-system-permissions/panel?callId=…&sessionId=…&panel=…
 *        the standalone card the macOS app shows in a floating panel (panel-page.mjs)
 *
 * Config:
 *
 *   fakeStateFile: ''   # test mode: a JSON file the fake prober reads (fake.mjs); never asks macOS, never opens System Settings
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { createCommand } from './command.mjs'
import { createFakeProber } from './fake.mjs'
import { createMacProber } from './macos.mjs'
import { panelHtml } from './panel-page.mjs'
import { SERVICE, createRegistry } from './seek.mjs'

export const name = 'deepsea-tool-system-permissions'

export const inject = ['connection']

export const Config = Schema.object({
  fakeStateFile: Schema.string().default(''),
})

export { SERVICE }

/** Exact Fetch routes (below /api), mirrored in src/client/index.tsx. */
export const STATUS_PATH = '/api/deepsea-tool-system-permissions/status'
export const ACTION_PATH = '/api/deepsea-tool-system-permissions/action'
export const RUNNING_PATH = '/api/deepsea-tool-system-permissions/running'
export const PANEL_PATH = '/api/deepsea-tool-system-permissions/panel'

/** The panel page's script (built by build.mjs from src/panel). */
export const PANEL_SCRIPT = new URL('./lib/panel.js', import.meta.url)

/** A session's title from a Session Controller list entry (its projection values; shapes vary by version). */
export function titleOf(entry) {
  const values = entry?.projections?.values ?? {}
  for (const candidate of [values.title, values.sessionTitle, entry?.title]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
    if (typeof candidate?.title === 'string' && candidate.title.trim() !== '') return candidate.title.trim()
  }
  return undefined
}

/**
 * The session's workspace and title, for the panel's line "<workspace> /
 * <session title>", from the Host's workspace registry and Session
 * Controller (either may be missing; the panel names the default workspace as
 * the sidebar does).
 * @returns {Promise<{ workspace?: string, title?: string }>}
 */
export async function sessionInfo(ctx, sessionId) {
  let workspace
  let title
  try {
    const workspaces = await ctx.get('workspaceRegistry')?.list?.()
    workspace = (workspaces ?? []).find(w => Array.isArray(w?.sessionIds) && w.sessionIds.includes(sessionId))?.title
  } catch { /* no workspace name */ }
  try {
    const listed = await ctx.get('sessionController')?.list?.({})
    const items = Array.isArray(listed) ? listed : listed?.items ?? listed?.sessions ?? []
    title = titleOf(items.find(item => item?.sessionId === sessionId))
  } catch { /* no title */ }
  return { ...typeof workspace === 'string' && workspace !== '' ? { workspace } : {}, ...title !== undefined ? { title } : {} }
}

/** Where finished calls are kept: $DSH_HOME/plugins/tool-system-permissions/calls.json (none without DSH_HOME). */
export function recordFile(env = process.env) {
  return env.DSH_HOME ? join(env.DSH_HOME, 'plugins', 'tool-system-permissions', 'calls.json') : undefined
}

/** A JSON file store for the registry's finished calls. */
export function fileStore(file) {
  if (file === undefined) return {}
  return {
    load: () => {
      try { return JSON.parse(readFileSync(file, 'utf8')).calls ?? [] } catch { return [] }
    },
    save: (calls) => {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      const temporary = `${file}.${process.pid}.tmp`
      writeFileSync(temporary, JSON.stringify({ calls }), { mode: 0o600 })
      renameSync(temporary, file)
    },
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - host-plane plugin context.
 * @param {{ fakeStateFile: string, recordFile?: string, platform?: string }} config - `recordFile`, `platform`: tests only.
 */
export function apply(ctx, config) {
  const prober = config.fakeStateFile
    ? createFakeProber(config.fakeStateFile, { logger: ctx.logger })
    : createMacProber({ logger: ctx.logger })
  const registry = createRegistry(fileStore(config.recordFile ?? recordFile()))
  ctx.provide(SERVICE, { prober, registry })

  // /system-permissions (command.mjs): here, not in the tools row, because it needs this row's prober and
  // registry, and the panel its calls are shown in; commands are a Host service, reached optionally.
  ctx.inject(['commands'], (ctx) => {
    ctx.commands.register(createCommand({ prober, registry, logger: ctx.logger, platform: config.platform }))
  })

  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })

  const route = (definition, label) => ctx.effect(() => {
    const dispose = ctx.connection.fetch.register(definition)
    return () => { void dispose() }
  }, label)

  route({
    path: STATUS_PATH,
    methods: ['GET'],
    // Required by the node:http bridge: without it a GET is treated as streaming and answered 400.
    requestBody: 'buffered',
    fetch: async (request) => {
      const url = new URL(request.url)
      const callId = url.searchParams.get('callId') ?? ''
      const sessionId = url.searchParams.get('sessionId') ?? ''
      if (callId === '' || sessionId === '') return json({ error: 'missing callId or sessionId' }, 400)
      const entry = registry.get(callId)
      if (entry === undefined) return json({ error: 'no such call', now: Date.now() }, 404)
      if (!entry.sessionIds.includes(sessionId)) return json({ error: 'this call belongs to another session' }, 403)
      const body = { running: entry.running, snapshot: entry.snapshot, now: Date.now() }
      if (prober.kind === 'fake') body.fake = { events: prober.events.slice(-100) }
      return json(body)
    },
  }, 'tool-system-permissions: status route')

  route({
    path: ACTION_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      // A JSON content type: a cross-site form cannot send one without a CORS preflight.
      if (!(request.headers.get('content-type') ?? '').startsWith('application/json')) return json({ error: 'body must be JSON (content-type: application/json)' }, 415)
      let body
      try { body = await request.json() } catch { return json({ error: 'body must be JSON' }, 400) }
      const action = typeof body?.action === 'string' ? body.action : ''
      const permission = typeof body?.permission === 'string' ? body.permission : ''
      const callId = typeof body?.callId === 'string' ? body.callId : ''
      const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
      if (action !== 'grant' && action !== 'deny') return json({ error: `unknown action "${action}"` }, 400)
      if (callId === '' || sessionId === '' || permission === '') return json({ error: 'missing callId, sessionId or permission' }, 400)
      const entry = registry.get(callId)
      if (entry === undefined || !entry.running) return json({ error: 'no running call (already settled?)', now: Date.now() }, 404)
      if (!entry.sessionIds.includes(sessionId)) return json({ error: 'this call belongs to another session' }, 403)
      const done = registry.act(callId, action, permission)
      return done ? json({ ok: true, action }) : json({ error: `"${permission}" is not open in this call`, now: Date.now() }, 404)
    },
  }, 'tool-system-permissions: action route')

  route({
    path: RUNNING_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => {
      const calls = []
      for (const call of registry.running()) {
        const open = call.snapshot.rows.filter(r => r.state === 'pending' || r.state === 'granting').length
        if (open === 0) continue
        const sessionId = call.sessionIds[0] ?? ''
        calls.push({ callId: call.callId, sessionId, noticeAt: call.snapshot.noticeAt, noticeMs: call.snapshot.noticeMs, open, total: call.snapshot.rows.length })
      }
      return json({ calls, now: Date.now() })
    },
  }, 'tool-system-permissions: running route')

  route({
    path: PANEL_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const url = new URL(request.url)
      const callId = url.searchParams.get('callId') ?? ''
      const sessionId = url.searchParams.get('sessionId') ?? ''
      const entry = registry.get(callId)
      if (entry === undefined || !entry.sessionIds.includes(sessionId)) return new Response('no such call', { status: 404, headers: { 'content-type': 'text/plain' } })
      let script
      try { script = readFileSync(PANEL_SCRIPT, 'utf8') } catch { return new Response('the panel is not built (pnpm build)', { status: 500, headers: { 'content-type': 'text/plain' } }) }
      const html = panelHtml({ callId, sessionId, panelId: url.searchParams.get('panel') ?? '', ...await sessionInfo(ctx, sessionId), script })
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
    },
  }, 'tool-system-permissions: panel route')

  ctx.logger.info(`tool-system-permissions: serving the status, action, running and panel routes (${prober.kind} prober${prober.kind === 'fake' ? `: ${config.fakeStateFile}` : ''})`)
}
