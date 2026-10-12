/**
 * @deepsea/remote-workspaces: workspaces of other DeepSea servers in this
 * sidebar.
 *
 * A remote workspace is a sidebar group whose sessions live on another
 * DeepSea server, reached at its tailnet URL (`https://<node>/deepsea[-<v>]/`,
 * published there by @deepsea/tailscale) or at any http(s) URL that admits
 * this server. Selecting one of its sessions frames the remote GUI's
 * chrome-less page (`?embed=<sessionId>`, harness topic `embed-session`) in an
 * iframe that this plugin serves SAME-ORIGIN at
 * `/deepsea-remote-workspaces/servers/<serverId>/…` through an egress proxy
 * (egress.mjs) holding the remote's credentials. Management (list, start,
 * rename, archive, move and copy sessions) goes host to host through the same
 * egress and the remote's Typert Remote endpoints.
 *
 * Servers come from the registry (state.mjs, `$DSH_HOME/plugins/
 * remote-workspaces/workspaces.json`) and the `servers` config seed. The
 * browser half (src/client/) calls the control channel
 * `POST /deepsea-remote-workspaces/<endpoint>`; peers call its `fs.*`
 * endpoints to check paths on this server.
 *
 * Config:
 *   servers[]      seed entries { id, url, label?, token? } (present every start, never written)   []
 *   tailscalePath  the tailscale CLI, for the MagicDNS suffix of short names ('' = PATH, then the app)  ''
 *   trace          a JSONL trace of control calls and egress failures (@deepsea/logs)              false
 */
import os from 'node:os'
import { readFileSync } from 'node:fs'
import { createTrace } from '@deepsea/logs'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import Schema from '@deepseek-ai/schemastery'
import { createEgress, friendlyRemoteName, parseRemoteUrl } from './egress.mjs'
import { createRemoteFs } from './remote-fs.mjs'
import { createMagicDnsSuffixSource, inspectPath, makeDirectory, normalizeRemoteInput, suffixFromKnownUrls } from './resolve.mjs'
import { generateId, loadState, normalizeState, routeIdFor, saveState, stateFileOf } from './state.mjs'

export const name = 'deepsea-remote-workspaces'
export const inject = ['webServer', 'connection']

export const Config = Schema.object({
  servers: Schema.array(Schema.object({
    id: Schema.string().required(),
    url: Schema.string().required(),
    label: Schema.string().default(''),
    token: Schema.string().default(''),
  })).default([]),
  tailscalePath: Schema.string().default(''),
  trace: Schema.boolean().default(false),
})

/** The control channel the browser half calls (`POST /deepsea-remote-workspaces/<endpoint>`). */
export const CONTROL_CHANNEL = '/deepsea-remote-workspaces'
/** Where each server's egress is mounted: `<SERVERS_PREFIX>/<serverId>/`. */
export const SERVERS_PREFIX = `${CONTROL_CHANNEL}/servers`
/** The one upgrade the embedded shell opens, relative to its document directory. */
const MUX_PATH = '/api/remote.mux'
const MAX_CONTROL_BODY = 64 * 1024
const PKG = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * One control request: DSH's own request gate (Host/Origin fence and
 * browser-session cookie), then the Connection JSON envelope
 * (`client-request` in, `server-response` out).
 */
export async function controlRoute(req, res, connection, dispatch) {
  const rejection = connection.requestRejection(req)
  if (rejection !== undefined) {
    res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
    return
  }
  const endpoint = new URL(req.url ?? '/', 'http://x').pathname.slice(CONTROL_CHANNEL.length + 1)
  if (req.method !== 'POST' || endpoint === '' || endpoint.includes('/')) {
    res.writeHead(404)
    res.end('not found')
    return
  }
  let message
  try {
    message = JSON.parse(await readBody(req, MAX_CONTROL_BODY))
  } catch {
    res.writeHead(400)
    res.end('body is not JSON')
    return
  }
  if (typeof message !== 'object' || message === null || message.type !== 'client-request' || typeof message.rpcId !== 'string' || message.method !== endpoint) {
    res.writeHead(400)
    res.end('invalid client-request envelope')
    return
  }
  let result
  try {
    result = await dispatch(endpoint, message.payload)
  } catch (error) {
    result = { ok: false, error: { code: 'deepsea-remote-workspaces/internal', message: String(error?.message ?? error), details: {} } }
  }
  // The client's envelope parser requires `error.details` to be an object;
  // errors forwarded from a remote or built without one would otherwise
  // surface as "invalid server-response failure" and hide the real message.
  if (result?.ok === false && (typeof result.error?.details !== 'object' || result.error.details === null)) {
    result = { ok: false, error: { ...result.error, details: {} } }
  }
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify({ type: 'server-response', rpcId: message.rpcId, result }))
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {ReturnType<typeof Config>} config
 * @param {{ stateFile?: string, trace?: (event: object) => void }} [seams] test seams
 */
export function apply(ctx, config, seams = {}) {
  const stateFile = seams.stateFile ?? stateFileOf(resolveDshHome())
  const trace = seams.trace ?? createTrace({ enabled: config.trace, name: 'remote-workspaces', plugin: `${PKG.name}@${PKG.version}`, home: resolveDshHome() })
  const log = message => ctx.logger.info(message)
  const warn = message => ctx.logger.warn(message)
  const ok = value => ({ ok: true, value })
  const fail = (code, message, details = {}) => ({ ok: false, error: { code: `deepsea-remote-workspaces/${code}`, message, details } })

  /** @type {ReturnType<typeof normalizeState>} */
  let state = normalizeState({})
  /** Seed servers from config: present every start, never written to the file. */
  const seeds = new Map((config.servers ?? []).map(entry => [entry.id, {
    id: entry.id, url: entry.url, label: entry.label || entry.id, token: entry.token || undefined, seeded: true,
  }]))
  /** @type {Map<string, { server: object, egress: ReturnType<typeof createEgress>, dispose: () => void }>} */
  const mounted = new Map()
  let disposed = false

  const gate = (req, res) => {
    const rejection = ctx.connection.requestRejection(req)
    if (rejection === undefined) return true
    res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
    return false
  }

  const localBaseOf = id => `${SERVERS_PREFIX}/${id}`

  /** Mount the egress routes of one server (idempotent per id). */
  const mount = (server) => {
    if (mounted.has(server.id)) return mounted.get(server.id)
    const localBase = localBaseOf(server.id)
    const egress = createEgress({
      id: server.id,
      url: server.url,
      localBase,
      token: () => mounted.get(server.id)?.server.token,
      log,
      warn,
      trace,
    })
    const disposeRoute = ctx.webServer.register({
      kind: 'prefix',
      path: localBase,
      handler: (req, res) => {
        if (!gate(req, res)) return
        const url = req.url ?? '/'
        return egress.handleRequest(req, res, url.slice(localBase.length))
      },
    })
    const disposeUpgrade = ctx.webServer.registerUpgrade({
      path: `${localBase}${MUX_PATH}`,
      handler: (req, socket, head) => {
        const rejection = ctx.connection.requestRejection(req)
        if (rejection !== undefined) {
          socket.end(`HTTP/1.1 ${String(rejection)} ${rejection === 401 ? 'Unauthorized' : 'Forbidden'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
          return
        }
        return egress.handleUpgrade(req, socket, head, (req.url ?? '/').slice(localBase.length))
      },
    })
    const entry = {
      server,
      egress,
      dispose: () => {
        disposeUpgrade()
        disposeRoute()
      },
    }
    mounted.set(server.id, entry)
    log(`remote-workspaces: ${localBase}/ -> ${egress.remote.url} (${egress.status().mode})`)
    return entry
  }

  const unmount = (id) => {
    const entry = mounted.get(id)
    if (entry === undefined) return
    mounted.delete(id)
    entry.dispose()
  }

  /** Effective server list: persisted entries, then seeds not already persisted. */
  const servers = () => {
    const out = [...state.servers.map(server => ({ ...server, seeded: false }))]
    for (const seed of seeds.values()) if (!out.some(server => server.id === seed.id)) out.push(seed)
    return out
  }

  const syncMounts = () => {
    const wanted = new Map(servers().map(server => [server.id, server]))
    for (const id of [...mounted.keys()]) if (!wanted.has(id)) unmount(id)
    for (const server of wanted.values()) {
      const current = mounted.get(server.id)
      if (current !== undefined && current.server.url !== server.url) unmount(server.id)
      const entry = mount(server)
      entry.server = server
    }
  }

  /** Serialize registry mutations so two panel actions cannot interleave writes. */
  let chain = Promise.resolve()
  const exclusive = fn => {
    const next = chain.then(fn, fn)
    chain = next.catch(() => {})
    return next
  }
  const persist = () => saveState(stateFile, state)

  const snapshot = () => {
    const byServer = new Map(servers().map(server => [server.id, server]))
    const lastServer = [...byServer.values()].filter(server => server.lastUsedAt !== undefined)
      .sort((a, b) => String(b.lastUsedAt).localeCompare(String(a.lastUsedAt)))[0]
    return {
      lastServerUrl: lastServer?.url,
      servers: [...byServer.values()].map(server => ({
        id: server.id,
        url: server.url,
        label: server.label,
        seeded: server.seeded,
        hasToken: server.token !== undefined,
        localBase: `${localBaseOf(server.id)}/`,
        bridge: mounted.get(server.id)?.egress.status(),
      })),
      workspaces: [...state.workspaces].sort((a, b) => a.order - b.order).map(workspace => ({
        ...workspace,
        server: byServer.get(workspace.serverId) === undefined ? undefined : {
          id: workspace.serverId, label: byServer.get(workspace.serverId).label, localBase: `${localBaseOf(workspace.serverId)}/`,
        },
      })),
    }
  }

  const egressOf = (serverId) => {
    const entry = mounted.get(String(serverId ?? ''))
    if (entry === undefined) throw new Error(`no remote server "${String(serverId)}"`)
    return entry.egress
  }
  const workspaceOf = (id) => {
    const workspace = state.workspaces.find(candidate => candidate.id === String(id ?? ''))
    if (workspace === undefined) throw new Error(`no remote workspace "${String(id)}"`)
    return workspace
  }
  /** Unwrap a remote result or throw its message. */
  const must = (result, what) => {
    if (result.ok) return result.value
    throw new Error(`${what}: ${result.error?.message ?? result.error?.code ?? 'failed'}`)
  }
  const sessionRow = (item, remoteIndex) => ({
    id: item.sessionId,
    title: item.projections?.values?.title ?? '',
    updatedAt: new Date(Number(item.updatedAt) || 0).toISOString(),
    running: item.running === true,
    // The remote's account order is creation order for a workspace whose
    // rows were never dragged there; `session.list` carries no createdAt.
    remoteIndex,
    ...(item.projections?.values?.permissions === undefined ? {} : { permissions: item.projections.values.permissions }),
  })

  /**
   * What was typed (`studio`, `user@studio`, `studio/deepsea-lab`,
   * `localhost:3202`, a full URL) as a canonical URL (resolve.mjs). Dot-less
   * hosts get the tailnet's MagicDNS suffix (CLI, else the suffix of a known
   * server).
   */
  const magicDnsSuffix = createMagicDnsSuffixSource(config.tailscalePath ?? '')
  const normalizeInput = text => normalizeRemoteInput(text, {
    magicDnsSuffix: async () => (await magicDnsSuffix()) ?? suffixFromKnownUrls(servers().map(server => server.url)),
  })

  /**
   * Egress for a URL that may not be registered yet (the modal's probe and
   * path-completion calls): a known server's mount when the URL is known and
   * no different token is offered, else a transient egress kept for a while
   * so the token exchange happens once per modal, not once per keystroke.
   */
  const transientEgresses = new Map()
  const TRANSIENT_TTL_MS = 10 * 60 * 1000
  const egressForUrl = (remoteUrl, offeredToken) => {
    const known = servers().find(server => parseRemoteUrl(server.url).url === remoteUrl)
    if (known !== undefined && (offeredToken === undefined || offeredToken === known.token)) return { egress: egressOf(known.id), known }
    const key = `${remoteUrl}\n${offeredToken ?? ''}`
    const now = Date.now()
    for (const [candidate, entry] of transientEgresses) if (now - entry.at > TRANSIENT_TTL_MS) transientEgresses.delete(candidate)
    let entry = transientEgresses.get(key)
    if (entry === undefined) {
      entry = { egress: createEgress({ id: 'probe', url: remoteUrl, localBase: localBaseOf('probe'), token: () => offeredToken ?? known?.token, log, warn, trace }), at: now }
      transientEgresses.set(key, entry)
    }
    entry.at = now
    return { egress: entry.egress, known }
  }

  /**
   * The remote's filesystem answers for one egress (remote-fs.mjs): its own
   * plugin's `fs.*` when it has one, else the harness's `directoryPicker`.
   * One per egress so the "which door" memory and the home survive keystrokes.
   */
  const remoteFsByEgress = new WeakMap()
  const remoteFsOf = (egress) => {
    let fs = remoteFsByEgress.get(egress)
    if (fs === undefined) { fs = createRemoteFs(egress); remoteFsByEgress.set(egress, fs) }
    return fs
  }

  /** Confirm the remote accepts this server: exchange the token if any, then list its sessions. */
  const probe = async (serverId) => {
    const entry = mounted.get(String(serverId ?? ''))
    if (entry === undefined) return fail('unknown-server', `no remote server "${String(serverId)}"`)
    const started = Date.now()
    try {
      await entry.egress.exchange()
    } catch (error) {
      return fail('unreachable', String(error?.message ?? error), { bridge: entry.egress.status() })
    }
    const listed = await entry.egress.call('session', 'list', { _request: {} })
    if (!listed.ok) return listed
    const items = Array.isArray(listed.value?.items) ? listed.value.items : []
    return ok({
      serverId: entry.server.id,
      url: entry.egress.remote.url,
      elapsedMs: Date.now() - started,
      sessionCount: items.length,
      // Item shape: { sessionId, updatedAt, running, blank, cwd, projections: { values: { title, … } } }.
      sessions: items.slice(0, 20).map(item => ({ ...sessionRow(item), cwd: item.cwd })),
      bridge: entry.egress.status(),
    })
  }

  /**
   * Reach a remote by URL (+ optional token) and list its workspaces: the
   * add-remote modal's first step. Reuses a known server's bridge when the
   * URL is already registered and no different token is offered.
   */
  const probeServer = async (url, token) => {
    let remote
    try {
      remote = parseRemoteUrl(await normalizeInput(url))
    } catch (error) {
      return fail('bad-url', String(error?.message ?? error))
    }
    const offeredToken = typeof token === 'string' && token !== '' ? token : undefined
    const { egress, known } = egressForUrl(remote.url, offeredToken)
    const started = Date.now()
    try {
      await egress.exchange()
    } catch (error) {
      return fail('unreachable', String(error?.message ?? error))
    }
    const listed = await egress.call('workspace', 'list', {})
    if (!listed.ok) {
      if (listed.error?.code === 'gateway/arguments-invalid' || String(listed.error?.message ?? '').includes('unknown method')) {
        return fail('old-remote', 'the remote server has no workspace.list (harness topic workspace-destinations)', { error: listed.error })
      }
      return listed
    }
    const items = Array.isArray(listed.value?.items) ? listed.value.items : []
    // Already in this sidebar: the modal grays these out instead of adding them twice.
    const mirrored = new Set(known === undefined ? [] : state.workspaces.filter(workspace => workspace.serverId === known.id).map(workspace => workspace.remoteWorkspaceId))
    return ok({
      url: remote.url,
      hostname: remote.hostname,
      serverId: known?.id,
      label: known?.label ?? friendlyRemoteName(remote.url),
      elapsedMs: Date.now() - started,
      mode: egress.status().mode,
      workspaces: items.map(view => ({
        workspaceId: view.workspaceId, path: view.path, title: view.title, sessionCount: view.sessionIds.length, mirrored: mirrored.has(view.workspaceId),
      })),
    })
  }

  /**
   * Ask the remote about a path on it (`~` resolved there, existence,
   * completion candidates): the New workspace field's live status. Answered
   * by the remote's own remote-workspaces plugin when it runs one, else by
   * the harness's directory picker there (remote-fs.mjs); a remote with
   * neither answers `fs-unavailable` and the modal falls back to "an
   * absolute path that exists".
   */
  const inspectRemotePath = async (url, token, path) => {
    let remote
    try {
      remote = parseRemoteUrl(await normalizeInput(url))
    } catch (error) {
      return fail('bad-url', String(error?.message ?? error))
    }
    const offeredToken = typeof token === 'string' && token !== '' ? token : undefined
    const { egress } = egressForUrl(remote.url, offeredToken)
    return remoteFsOf(egress).inspect(String(path ?? ''))
  }

  /** Find or register the server for a URL; a token offered here becomes the stored one. */
  const ensureServer = async (url, token, label) => {
    const remote = parseRemoteUrl(await normalizeInput(url))
    const offeredToken = typeof token === 'string' && token !== '' ? token : undefined
    let server = state.servers.find(candidate => parseRemoteUrl(candidate.url).url === remote.url)
    const seeded = [...seeds.values()].find(candidate => parseRemoteUrl(candidate.url).url === remote.url)
    if (server === undefined && seeded !== undefined) {
      // A seeded server is usable as is; it is written to the registry only when it gains a token.
      if (offeredToken === undefined || offeredToken === seeded.token) {
        seeded.lastUsedAt = new Date().toISOString()
        return seeded
      }
      server = { id: seeded.id, url: seeded.url, label: seeded.label }
      state.servers.push(server)
    }
    if (server === undefined) {
      const taken = new Set([...state.servers.map(candidate => candidate.id), ...seeds.keys(), 'probe'])
      server = { id: routeIdFor(label || friendlyRemoteName(remote.url), taken), url: remote.url, label: label || friendlyRemoteName(remote.url) }
      state.servers.push(server)
    }
    if (offeredToken !== undefined) server.token = offeredToken
    server.lastUsedAt = new Date().toISOString()
    await persist()
    syncMounts()
    return server
  }

  /**
   * Local manual order over the remote's order, like the local tree's
   * per-workspace order: ids arranged here keep their relative order;
   * sessions not yet arranged (new ones) stay in front, in the remote's order.
   */
  const applySessionOrder = (ids, order) => {
    if (!Array.isArray(order) || order.length === 0) return ids
    const present = new Set(ids)
    const arranged = order.filter(id => present.has(id))
    const arrangedSet = new Set(arranged)
    return [...ids.filter(id => !arrangedSet.has(id)), ...arranged]
  }

  /** Refresh one remote workspace from the remote: existence, path/title, visible sessions. */
  const pollWorkspace = async (workspace) => {
    const egress = egressOf(workspace.serverId)
    const baseline = must(await egress.call('workspace', 'list', {}), 'workspace.list')
    const view = (baseline.items ?? []).find(candidate => candidate.workspaceId === workspace.remoteWorkspaceId)
    if (view === undefined) {
      workspace.cache = { ...workspace.cache, gone: true, polledAt: new Date().toISOString() }
      await persist()
      return fail('gone', `the remote no longer has workspace "${workspace.title}"`, { workspace })
    }
    const archived = new Set(baseline.archivedSessionIds ?? [])
    const listed = must(await egress.call('session', 'list', { _request: {} }), 'session.list')
    const byId = new Map((listed.items ?? []).map(item => [item.sessionId, item]))
    const visible = view.sessionIds.filter(id => byId.has(id) && !archived.has(id) && byId.get(id).blank !== true)
    const sessions = applySessionOrder(visible, workspace.sessionOrder).map(id => sessionRow(byId.get(id), view.sessionIds.indexOf(id)))
    // Blank sessions (no turn yet) are not rows, but the browser needs their
    // ids: a blank session with a persisted draft gets a dimmed ghost row so
    // the draft stays reachable after switching away, like the local tree's.
    const blankIds = view.sessionIds.filter(id => byId.has(id) && !archived.has(id) && byId.get(id).blank === true)
    workspace.remotePath = view.path
    workspace.remoteTitle = view.title
    workspace.remoteCreatedAt = view.createdAt
    workspace.cache = { sessions, blankIds, polledAt: new Date().toISOString() }
    const server = state.servers.find(candidate => candidate.id === workspace.serverId)
    if (server !== undefined) server.lastUsedAt = workspace.cache.polledAt
    await persist()
    return ok({ workspace: snapshot().workspaces.find(candidate => candidate.id === workspace.id) })
  }

  const addWorkspace = (args) => exclusive(async () => {
    if (disposed) return fail('disposed', 'the plugin is unloading')
    let server
    try {
      server = await ensureServer(args.url, args.token, args.label)
    } catch (error) {
      return fail('bad-url', String(error?.message ?? error))
    }
    const egress = egressOf(server.id)
    let view
    try {
      if (typeof args.remotePath === 'string' && args.remotePath.trim() !== '') {
        let target = args.remotePath.trim()
        // `~` is the remote account's home and a missing directory is made
        // there (`create`), through the remote's own plugin or the harness's
        // directory picker there (remote-fs.mjs); a remote with neither takes
        // only an existing absolute path.
        if (target.startsWith('~') || args.create === true) {
          const fs = remoteFsOf(egress)
          const inspected = await fs.inspect(target)
          if (!inspected.ok) return fail('remote', `cannot resolve "${target}" on ${server.label}: ${inspected.error?.message ?? inspected.error?.code ?? 'failed'}`)
          target = inspected.value.resolved
          if (inspected.value.kind === 'missing') {
            if (args.create !== true) return fail('remote', `${target} does not exist on ${server.label}`)
            must(await fs.mkdir(target), 'fs.mkdir')
          }
        }
        view = must(await egress.call('workspace', 'create', { request: { path: target } }), 'workspace.create').workspace
      } else {
        const baseline = must(await egress.call('workspace', 'list', {}), 'workspace.list')
        view = (baseline.items ?? []).find(candidate => candidate.workspaceId === String(args.remoteWorkspaceId ?? ''))
        if (view === undefined) return fail('unknown-workspace', 'the remote has no such workspace')
      }
    } catch (error) {
      return fail('remote', String(error?.message ?? error))
    }
    const existing = state.workspaces.find(candidate => candidate.serverId === server.id && candidate.remoteWorkspaceId === view.workspaceId)
    if (existing !== undefined) {
      // Both picker paths land here: a grayed-out pick bypassed, or a typed
      // directory the remote resolved to a workspace this sidebar already has.
      return fail('already-added', `"${existing.title}" already shows ${view.title} (${view.path}) from ${server.label}`, { workspaceId: existing.id })
    }
    const workspace = {
      id: generateId('rws'),
      serverId: server.id,
      remoteWorkspaceId: view.workspaceId,
      title: String(args.title ?? '').trim() || view.title,
      remotePath: view.path,
      createdAt: new Date().toISOString(),
      order: state.workspaces.reduce((max, candidate) => Math.max(max, candidate.order), -1) + 1,
      cache: { sessions: [] },
    }
    state.workspaces.push(workspace)
    await persist()
    return pollWorkspace(workspace)
  })

  const removeWorkspace = id => exclusive(async () => {
    const before = state.workspaces.length
    state.workspaces = state.workspaces.filter(candidate => candidate.id !== String(id ?? ''))
    if (state.workspaces.length === before) return fail('unknown-workspace', `no remote workspace "${String(id)}"`)
    await persist()
    return ok(snapshot())
  })

  const renameWorkspace = (id, title) => exclusive(async () => {
    const workspace = workspaceOf(id)
    const next = String(title ?? '').trim()
    if (next === '') return fail('invalid', 'a title is required')
    workspace.title = next
    await persist()
    return ok(snapshot())
  })

  /** Persist a new order of the remote workspaces (ids in display order). */
  const reorderWorkspaces = ids => exclusive(async () => {
    const wanted = Array.isArray(ids) ? ids.map(String) : []
    const known = new Map(state.workspaces.map(workspace => [workspace.id, workspace]))
    let order = 0
    for (const id of wanted) if (known.has(id)) known.get(id).order = order++
    for (const workspace of [...state.workspaces].sort((a, b) => a.order - b.order)) if (!wanted.includes(workspace.id)) workspace.order = order++
    await persist()
    return ok(snapshot())
  })

  /** Persist the session order within one remote workspace and re-project its cache. */
  const reorderSessions = (workspaceId, ids) => exclusive(async () => {
    const workspace = workspaceOf(workspaceId)
    workspace.sessionOrder = Array.isArray(ids) ? ids.map(String) : []
    const cachedIds = workspace.cache.sessions.map(session => session.id)
    const byId = new Map(workspace.cache.sessions.map(session => [session.id, session]))
    workspace.cache = { ...workspace.cache, sessions: applySessionOrder(cachedIds, workspace.sessionOrder).map(id => byId.get(id)) }
    await persist()
    return ok({ workspace: snapshot().workspaces.find(candidate => candidate.id === workspace.id) })
  })

  const renameSession = (workspaceId, sessionId, title) => exclusive(async () => {
    const workspace = workspaceOf(workspaceId)
    const egress = egressOf(workspace.serverId)
    const result = await egress.call('session', 'rename', { request: { sessionId: String(sessionId), title: String(title ?? '').trim() } })
    if (!result.ok) return result
    return pollWorkspace(workspace)
  })

  const archiveSession = (workspaceId, sessionId) => exclusive(async () => {
    const workspace = workspaceOf(workspaceId)
    const egress = egressOf(workspace.serverId)
    const result = await egress.call('workspace', 'archiveSession', { request: { sessionId: String(sessionId) } })
    if (!result.ok) return result
    return pollWorkspace(workspace)
  })

  /**
   * Start a session in a remote workspace the way the local shell does for a
   * local one: reuse that workspace's blank session or create one. The
   * embedded page then shows the remote's own composer (its models, presets,
   * attachments and draft persistence), so nothing else is sent until a
   * prompt is submitted there.
   */
  const startSession = workspaceId => exclusive(async () => {
    const workspace = workspaceOf(workspaceId)
    const egress = egressOf(workspace.serverId)
    const baseline = must(await egress.call('workspace', 'list', {}), 'workspace.list')
    const view = (baseline.items ?? []).find(candidate => candidate.workspaceId === workspace.remoteWorkspaceId)
    if (view === undefined) return fail('gone', `the remote no longer has workspace "${workspace.title}"`)
    const archived = new Set(baseline.archivedSessionIds ?? [])
    const listed = must(await egress.call('session', 'list', { _request: {} }), 'session.list')
    const blank = (listed.items ?? []).find(item => item.blank === true && item.cwd === view.path
      && view.sessionIds.includes(item.sessionId) && !archived.has(item.sessionId))
    if (blank !== undefined) return ok({ sessionId: blank.sessionId, created: false })
    const created = must(await egress.call('session', 'create', { request: { workspaceId: view.workspaceId } }), 'session.create')
    return ok({ sessionId: created.sessionId, created: true })
  })

  // ---- moving and copying sessions across servers ----------------------
  //
  // Local operations go through this server's own Connection fetch handler
  // in-process (the code path the browser's requests take after the
  // Host/Origin fence), so no token or cookie is involved. Remote operations
  // go through the egress (Typert `call` for JSON, `fetchRaw` for the export
  // and import routes' binary bodies, harness topic session-relocation).

  const localApi = ctx.connection.createSharedFetchHandler('/api')
  const LOCAL_ORIGIN = 'http://127.0.0.1'
  /** Call a local Typert Remote in-process. */
  const localCall = async (namespace, method, args) => {
    const rpcId = crypto.randomUUID()
    const response = await localApi.fetch(new Request(`${LOCAL_ORIGIN}/api/${namespace}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method: `${namespace}/${method}`, payload: { args } }),
    }))
    const envelope = await response.json().catch(() => undefined)
    if (typeof envelope !== 'object' || envelope === null || typeof envelope.result !== 'object') {
      return { ok: false, error: { code: 'deepsea-remote-workspaces/bad-response', message: `local ${namespace}.${method} answered HTTP ${String(response.status)}` } }
    }
    return envelope.result
  }
  /** Read the local export ZIP of one session (with descendants) as a Buffer. */
  const localExport = async (sessionId) => {
    const response = await localApi.fetch(new Request(`${LOCAL_ORIGIN}/api/session.export?sessionId=${encodeURIComponent(sessionId)}&includeDescendants=true`))
    if (response.status !== 200) throw new Error(`local export failed: HTTP ${String(response.status)} ${await response.text()}`)
    return Buffer.from(await response.arrayBuffer())
  }
  /**
   * Query string of an import: `mode=copy` (fresh ids, copy notice, optional
   * `truncate` / `title`) when `copy` is given, else a move-style import.
   */
  const importQuery = (origin, copy, notify) => {
    const params = new URLSearchParams({ origin })
    if (notify === false) params.set('notify', 'false')
    if (copy !== undefined) {
      params.set('mode', 'copy')
      if (copy.truncate === true) params.set('truncate', 'true')
      if (typeof copy.title === 'string' && copy.title.trim() !== '') params.set('title', copy.title.trim())
    }
    return params.toString()
  }
  /** Import one ZIP Buffer into a local workspace; returns the import result. */
  const localImport = async (zip, destination, origin, copy, notify) => {
    const query = 'workspaceId' in destination
      ? `workspaceId=${encodeURIComponent(destination.workspaceId)}`
      : `cwd=${encodeURIComponent(destination.path)}`
    const response = await localApi.fetch(new Request(`${LOCAL_ORIGIN}/api/session.import?${query}&${importQuery(origin, copy, notify)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/zip' },
      body: zip,
    }))
    const text = await response.text()
    if (response.status !== 200) throw new Error(`local import failed: HTTP ${String(response.status)} ${text}`)
    return JSON.parse(text)
  }
  /** Read a remote session's export ZIP as a Buffer. */
  const remoteExport = async (egress, sessionId) => {
    const response = await egress.fetchRaw('GET', `/api/session.export?sessionId=${encodeURIComponent(sessionId)}&includeDescendants=true`)
    const chunks = []
    for await (const chunk of response) chunks.push(chunk)
    if (response.statusCode !== 200) throw new Error(`remote export failed: HTTP ${String(response.statusCode)} ${Buffer.concat(chunks).toString('utf8').slice(0, 300)}`)
    return Buffer.concat(chunks)
  }
  /** Import one ZIP Buffer into a remote workspace. */
  const remoteImport = async (egress, zip, remoteWorkspaceId, origin, copy, notify) => {
    const response = await egress.fetchRaw('POST',
      `/api/session.import?workspaceId=${encodeURIComponent(remoteWorkspaceId)}&${importQuery(origin, copy, notify)}`,
      { body: zip, headers: { 'content-type': 'application/zip' } })
    const chunks = []
    for await (const chunk of response) chunks.push(chunk)
    const text = Buffer.concat(chunks).toString('utf8')
    if (response.statusCode !== 200) throw new Error(`remote import failed: HTTP ${String(response.statusCode)} ${text.slice(0, 300)}`)
    return JSON.parse(text)
  }
  /** How an import notice names where a session came from: this machine, or the remote's label. */
  const hostLabel = () => os.hostname().replace(/\.local$/i, '')
  const remoteLabel = (serverId) => {
    const server = servers().find(candidate => candidate.id === serverId)
    return server?.label ?? serverId
  }
  /** Is the session running a turn on the given remote right now? Cheap check via its list row. */
  const remoteSessionLive = async (egress, sessionId) => {
    const listed = await egress.call('session', 'list', { _request: {} })
    if (!listed.ok) return false
    const row = (listed.value.items ?? []).find(item => item.sessionId === sessionId)
    return row?.running === true
  }

  /**
   * Move a session between two workspaces of the same remote: the remote's
   * own `session.move`, refusals passed through as they are (the dialog
   * answers `session/move-live` with stop-and-move).
   */
  const moveSessionWithinRemote = (fromWorkspaceId, sessionId, toWorkspaceId, stopLive) => exclusive(async () => {
    const from = workspaceOf(fromWorkspaceId)
    const to = workspaceOf(toWorkspaceId)
    if (from.serverId !== to.serverId) return fail('cross-remote', 'use sessions.transfer for moves between different servers')
    const egress = egressOf(from.serverId)
    const result = await egress.call('session', 'move', { request: {
      sessionId: String(sessionId), destination: { workspaceId: to.remoteWorkspaceId }, stopLive: stopLive === true,
    } })
    if (!result.ok) return result
    await pollWorkspace(from)
    return pollWorkspace(to)
  })

  /**
   * Move a session across servers: export at the source, import at the
   * destination, then archive the source copy (kept rather than deleted:
   * the one place a bug would lose work). Source and destination are each
   * `{ local: true, workspaceId?, path? }` or `{ workspaceId: <remote
   * workspace id> }`. A source that is running a turn refuses unless
   * `stopLive`.
   */
  const transferSession = (spec) => exclusive(async () => {
    const { sessionId } = spec
    const source = spec.source
    const destination = spec.destination
    if (source.local === true && destination.local === true) return fail('bad-request', 'a move within this server is session.move, not a transfer')
    // 1. Source liveness.
    if (source.local === true) {
      const listed = await localCall('session', 'list', { _request: {} })
      const row = listed.ok ? (listed.value.items ?? []).find(item => item.sessionId === sessionId) : undefined
      if (row === undefined) return fail('missing', `no local session "${String(sessionId)}"`)
      // A running turn dies with the agent; the wire error carries `details`
      // (the client rejects an error envelope without an object there).
      if (row.running === true && spec.stopLive !== true) {
        return { ok: false, error: { code: 'session/move-live', message: 'the session is running; stop it first or move with stopLive', details: { sessionId, blockers: [{ kind: 'turn' }] } } }
      }
      if (row.running === true) {
        const cancelled = await localCall('session', 'cancel', { request: { sessionId } })
        if (!cancelled.ok) return cancelled
      }
    } else {
      const from = workspaceOf(source.workspaceId)
      const egress = egressOf(from.serverId)
      if (await remoteSessionLive(egress, sessionId)) {
        if (spec.stopLive !== true) {
          return { ok: false, error: { code: 'session/move-live', message: 'the remote session is running; stop it first or move with stopLive', details: { sessionId, blockers: [{ kind: 'turn' }] } } }
        }
        const cancelled = await egress.call('session', 'cancel', { request: { sessionId } })
        if (!cancelled.ok) return cancelled
      }
    }
    // 2. Export at the source.
    const originLabel = source.local === true ? hostLabel() : remoteLabel(workspaceOf(source.workspaceId).serverId)
    const zip = source.local === true
      ? await localExport(sessionId)
      : await remoteExport(egressOf(workspaceOf(source.workspaceId).serverId), sessionId)
    // 3. Import at the destination.
    let imported
    if (destination.local === true) {
      imported = await localImport(zip, destination.workspaceId !== undefined ? { workspaceId: destination.workspaceId } : { path: destination.path }, originLabel, undefined, spec.notify)
    } else {
      const to = workspaceOf(destination.workspaceId)
      imported = await remoteImport(egressOf(to.serverId), zip, to.remoteWorkspaceId, originLabel, undefined, spec.notify)
      await pollWorkspace(to)
    }
    // 4. Archive the source copy; never delete.
    if (source.local === true) {
      await localCall('workspace', 'archiveSession', { request: { sessionId } })
    } else {
      const from = workspaceOf(source.workspaceId)
      await egressOf(from.serverId).call('workspace', 'archiveSession', { request: { sessionId } })
      await pollWorkspace(from)
    }
    return ok({ sessionId: imported.sessionId, imported: imported.imported, bytes: zip.byteLength })
  })

  /**
   * Copy a session between two workspaces of the same remote (the remote's
   * own `session.copy`, which reads the source and leaves it running).
   * Refusals pass through as they are: the dialog answers
   * `session/copy-live` by asking whether to drop the turn in progress
   * (`truncate`).
   */
  const copySessionWithinRemote = (fromWorkspaceId, sessionId, toWorkspaceId, options = {}) => exclusive(async () => {
    const from = workspaceOf(fromWorkspaceId)
    const to = workspaceOf(toWorkspaceId)
    if (from.serverId !== to.serverId) return fail('cross-remote', 'use sessions.copyAcross for copies between different servers')
    const egress = egressOf(from.serverId)
    const result = await egress.call('session', 'copy', { request: {
      sessionId: String(sessionId),
      destination: { workspaceId: to.remoteWorkspaceId },
      ...(options.truncate === undefined ? {} : { truncate: options.truncate === true }),
      ...(typeof options.title === 'string' && options.title.trim() !== '' ? { title: options.title.trim() } : {}),
    } })
    if (!result.ok) return result
    const polled = await pollWorkspace(to)
    if (!polled.ok) return polled
    return ok({ ...polled.value, sessionId: result.value.sessionId, truncated: result.value.truncated === true })
  })

  /**
   * Copy a session across servers: export at the source, import at the
   * destination in `copy` mode (fresh ids, copy notice). Nothing at the
   * source changes: no cancel, no archive. A source that is running is
   * refused (`session/copy-live`) until `truncate` is decided; the export
   * carries the log as recorded so far and the destination shapes it (drops
   * the turn in progress, or closes it as interrupted).
   */
  const copySessionAcross = (spec) => exclusive(async () => {
    const { sessionId } = spec
    const source = spec.source
    const destination = spec.destination
    if (source.local === true && destination.local === true) return fail('bad-request', 'a copy within this server is session.copy')
    // 1. Source liveness, only to ask the truncate question once.
    if (spec.truncate === undefined) {
      let running = false
      if (source.local === true) {
        const listed = await localCall('session', 'list', { _request: {} })
        const row = listed.ok ? (listed.value.items ?? []).find(item => item.sessionId === sessionId) : undefined
        if (row === undefined) return fail('missing', `no local session "${String(sessionId)}"`)
        running = row.running === true
      } else {
        running = await remoteSessionLive(egressOf(workspaceOf(source.workspaceId).serverId), sessionId)
      }
      if (running) {
        return { ok: false, error: { code: 'session/copy-live', message: 'the session is running; decide whether the copy keeps the turn in progress (truncate)', details: { sessionId, blockers: [{ kind: 'turn' }] } } }
      }
    }
    const copy = { truncate: spec.truncate === true, title: spec.title }
    // 2. Export at the source (the log as recorded so far; a live source is flushed first).
    const originLabel = source.local === true ? hostLabel() : remoteLabel(workspaceOf(source.workspaceId).serverId)
    const zip = source.local === true
      ? await localExport(sessionId)
      : await remoteExport(egressOf(workspaceOf(source.workspaceId).serverId), sessionId)
    // 3. Import at the destination as a copy.
    let imported
    if (destination.local === true) {
      imported = await localImport(zip, destination.workspaceId !== undefined ? { workspaceId: destination.workspaceId } : { path: destination.path }, originLabel, copy, spec.notify)
    } else {
      const to = workspaceOf(destination.workspaceId)
      imported = await remoteImport(egressOf(to.serverId), zip, to.remoteWorkspaceId, originLabel, copy, spec.notify)
      await pollWorkspace(to)
    }
    return ok({ sessionId: imported.sessionId, imported: imported.imported, truncated: imported.truncated === true, bytes: zip.byteLength })
  })

  const handlers = {
    status: () => ok(snapshot()),
    probe: args => probe(args.serverId),
    'servers.probe': args => probeServer(args.url, args.token),
    'servers.inspectPath': args => inspectRemotePath(args.url, args.token, args.path),
    // Served for peers (their add-remote modal asks about paths HERE):
    'fs.inspect': async args => ok(await inspectPath(args.path)),
    'fs.mkdir': async args => ok(await makeDirectory(args.path)),
    'workspaces.add': args => addWorkspace(args),
    'workspaces.poll': args => exclusive(() => pollWorkspace(workspaceOf(args.id))),
    'workspaces.remove': args => removeWorkspace(args.id),
    'workspaces.rename': args => renameWorkspace(args.id, args.title),
    'workspaces.reorder': args => reorderWorkspaces(args.ids),
    'sessions.reorder': args => reorderSessions(args.workspaceId, args.ids),
    'sessions.rename': args => renameSession(args.workspaceId, args.sessionId, args.title),
    'sessions.archive': args => archiveSession(args.workspaceId, args.sessionId),
    'sessions.start': args => startSession(args.workspaceId),
    'sessions.move': args => moveSessionWithinRemote(args.fromWorkspaceId, args.sessionId, args.toWorkspaceId, args.stopLive),
    'sessions.transfer': args => transferSession(args),
    'sessions.copy': args => copySessionWithinRemote(args.fromWorkspaceId, args.sessionId, args.toWorkspaceId, args),
    'sessions.copyAcross': args => copySessionAcross(args),
  }

  const dispatch = async (endpoint, payload) => {
    await boot
    const args = typeof payload === 'object' && payload !== null && typeof payload.args === 'object' && payload.args !== null ? payload.args : {}
    const handler = Object.hasOwn(handlers, endpoint) ? handlers[endpoint] : undefined
    if (handler === undefined) return fail('unknown-endpoint', `unknown endpoint ${endpoint}`)
    const started = Date.now()
    let result
    try {
      result = await handler(args)
    } catch (error) {
      result = fail('failed', String(error?.message ?? error))
    }
    if (endpoint !== 'status') {
      trace({ event: 'control', endpoint, ok: result?.ok === true, ...(result?.ok === false ? { code: result.error?.code, message: result.error?.message } : {}), ms: Date.now() - started })
    }
    return result
  }
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: CONTROL_CHANNEL,
    handler: (req, res) => controlRoute(req, res, ctx.connection, dispatch),
  }), 'remote-workspaces: control channel')

  const boot = (async () => {
    try {
      state = await loadState(stateFile)
    } catch (error) {
      warn(String(error?.message ?? error))
    }
    if (disposed) return
    syncMounts()
  })()

  ctx.effect(() => () => {
    disposed = true
    return boot.then(() => { for (const id of [...mounted.keys()]) unmount(id) })
  }, 'remote-workspaces: egress routes')
}
