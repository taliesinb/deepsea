/**
 * @deepsea/tailscale: this variant on the tailnet, at
 * `https://<node>.<tailnet>.ts.net/<serve path>/`.
 *
 *   - an authenticating loopback reverse proxy (proxy.mjs) in front of DSH,
 *     which tailnet clients reach through Tailscale Serve and, on an
 *     installed variant, through its relay;
 *   - the variant's own Tailscale Serve path (tailscale.mjs), published and
 *     removed by this plugin, never anyone else's;
 *   - the "Tailscale" settings section: publish or remove the path, the
 *     address, a QR code carrying the standing token, the allowed tailnet
 *     logins; and the "Server" section: the variant's processes (relay,
 *     dsh web, app) with restart, quit and launch, and who is connected;
 *   - a per-session QR button in the session header;
 *   - the loopback-forward route the DeepSea app on another Mac uses to reach
 *     this machine's dev servers (forward.mjs);
 *   - the `deepseaSessionOwners` service: which tailnet login drives which
 *     session (owners.mjs).
 *
 * The defaults come from the variant (variant.mjs): its port block (proxy on
 * +4, relay on +3) and Serve path in `$DSH_HOME/variant.yml`, the relay from
 * `DEEPSEA_RELAY`. A throwaway or a stock home has no Serve path, and a proxy
 * only when the config names a port. Installing anything (LaunchAgent, app,
 * server host) is dsd's job.
 *
 * Config (each overrides the variant's value):
 *   proxyPort          the proxy's loopback port                    variant block +4
 *   servePath          the Serve path (`/deepsea-lab`)               variant.yml servePath
 *   tailscalePath      the tailscale CLI ('' = PATH, then the app)  ''
 *   identityOperators  identity-admitted users operate (control channel, ownsHost)   true
 *   loopbackForward    who may forward this machine's loopback ports: admitted | operators | off   admitted
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import Schema from '@deepseek-ai/schemastery'
import { renderSVG } from 'uqr'
import { FORWARD_PATH, handleForwardUpgrade } from './forward.mjs'
import { SessionOwners, loginOf } from './owners.mjs'
import { startProxy } from './proxy.mjs'
import { attachClientTracker, listening, performAction, processTable, relayJob, workspaceOfSession } from './server.mjs'
import { generateToken, loadState, parseUserList, saveState, stateFileOf } from './state.mjs'
import { SERVE_PORT, createServeManager, targetOf } from './tailscale.mjs'
import { readVariantFile, resolveSettings } from './variant.mjs'

export const name = 'deepsea-tailscale'
export const inject = ['webServer', 'connection']

export const Config = Schema.object({
  proxyPort: Schema.natural().min(1).max(65535),
  servePath: Schema.string(),
  tailscalePath: Schema.string().default(''),
  identityOperators: Schema.boolean().default(true),
  loopbackForward: Schema.union(['admitted', 'operators', 'off']).default('admitted'),
})

/** The control channel the browser half calls (`POST /deepsea-tailscale/<endpoint>`); the proxy forwards it for operators only. */
export const CONTROL_CHANNEL = '/deepsea-tailscale'

const TOKEN_QUERY = 'token'
const MAX_CONTROL_BODY = 64 * 1024
/** How often the node's Tailscale facts (name, own login and addresses) are re-read while the proxy runs. */
const REFRESH_UNKNOWN_MS = 60_000
const REFRESH_KNOWN_MS = 10 * 60_000

function qrSvg(text) {
  try {
    return renderSVG(text, { ecc: 'M', border: 2 })
  } catch {
    return undefined
  }
}

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
 * One control request: DSH's own request gate, then the Connection JSON
 * envelope (`client-request` in, `server-response` out).
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{ requestRejection(req: unknown): number | undefined }} connection
 * @param {(endpoint: string, payload: unknown) => Promise<unknown>} dispatch
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
    result = { ok: false, error: { code: 'deepsea-tailscale/internal', message: String(error?.message ?? error), details: {} } }
  }
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify({ type: 'server-response', rpcId: message.rpcId, result }))
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ proxyPort?: number, servePath?: string, tailscalePath: string, identityOperators: boolean, loopbackForward: 'admitted' | 'operators' | 'off' }} config
 */
export function apply(ctx, config) {
  const log = message => ctx.logger.info(message)
  const warn = message => ctx.logger.warn(message)
  const home = resolveDshHome()
  let variant
  try {
    variant = readVariantFile(home)
  } catch (error) {
    warn(`tailscale: cannot read ${home}/variant.yml: ${String(error?.message ?? error)}`)
  }
  const settings = resolveSettings(variant, config, { home })
  const stateFile = stateFileOf(home)

  /** @type {{ version: number, enabled?: boolean, allowedUsers: string[], token: string }} */
  let state
  /** @type {Awaited<ReturnType<typeof startProxy>> | undefined} */
  let proxy
  let proxyError
  /** Open loopback forwards, one token per piped connection. */
  const forwards = new Set()
  let disposed = false
  /** Serialize state changes so two clicks cannot interleave CLI calls. */
  let chain = Promise.resolve()
  const exclusive = (fn) => {
    const next = chain.then(fn, fn)
    chain = next.catch(() => {})
    return next
  }

  /** What Serve publishes: the relay, which hands tailnet clients to the proxy, else the proxy itself. */
  const publishTarget = () => settings.relayUrl !== undefined ? targetOf(settings.relayUrl) : proxy?.url
  const ownPorts = () => [settings.relayPort, settings.proxyPort, proxy?.port].filter(port => port !== undefined)
  const serve = createServeManager({
    cliPath: config.tailscalePath,
    servePath: settings.servePath,
    target: publishTarget,
    ownPorts,
    log,
  })
  /** The operator's wish, else the variant's: publish when it has a Serve path. */
  const wanted = () => settings.servePath !== undefined && (state?.enabled ?? true)

  /** The last `tailscale status` that knew this node: the proxy's identity facts and public name. */
  let lastRoute
  const routeStatus = async () => {
    const route = await serve.status()
    if (route.dnsName !== undefined) {
      if (lastRoute?.dnsName !== undefined && lastRoute.dnsName !== route.dnsName) log(`tailscale: this node is now ${route.dnsName} (was ${lastRoute.dnsName})`)
      lastRoute = route
    }
    return route
  }
  const publicHosts = () => lastRoute?.dnsName === undefined ? [] : [lastRoute.dnsName, `${lastRoute.dnsName}:${String(SERVE_PORT)}`]
  const persist = () => saveState(stateFile, state)

  const ensureProxy = async () => {
    if (proxy !== undefined || settings.proxyPort === undefined) return proxy
    await routeStatus()
    try {
      proxy = await startProxy({
        listenHost: '127.0.0.1',
        listenPort: settings.proxyPort,
        backendHost: '127.0.0.1',
        backendPort: ctx.webServer.port,
        connection: ctx.connection,
        token: () => state.token,
        allowedUsers: () => state.allowedUsers,
        selfLogin: () => lastRoute?.selfLogin,
        selfAddresses: () => lastRoute?.selfAddresses ?? [],
        identityOperators: () => config.identityOperators,
        publicHosts,
        // A request for a tailnet name not (yet) known re-reads this node's facts first.
        refreshHosts: () => routeStatus(),
        cookieName: settings.cookieName,
        controlPrefix: CONTROL_CHANNEL,
        servePath: settings.servePath ?? '/',
        log,
        warn,
      })
      proxyError = undefined
      log(`tailscale: proxy ${proxy.url} -> http://127.0.0.1:${String(ctx.webServer.port)}${settings.relayUrl === undefined ? '' : ` (behind the relay ${settings.relayUrl})`}`)
    } catch (error) {
      proxyError = String(error?.message ?? error)
      warn(`tailscale: the proxy could not start on 127.0.0.1:${String(settings.proxyPort)}: ${proxyError}`)
    }
    return proxy
  }

  const snapshot = async () => {
    const route = await routeStatus()
    const url = route.url
    const tokenUrl = url === undefined ? undefined : `${url}?${TOKEN_QUERY}=${encodeURIComponent(state.token)}`
    return {
      variant: settings.id,
      display: settings.display,
      enabled: wanted(),
      servePath: settings.servePath,
      route: route.state,
      detail: route.detail,
      dnsName: route.dnsName,
      mappedTarget: route.mappedTarget,
      url,
      tokenUrl,
      qrSvg: tokenUrl === undefined ? undefined : qrSvg(tokenUrl),
      allowedUsers: state.allowedUsers,
      selfLogin: route.selfLogin ?? lastRoute?.selfLogin,
      selfAddresses: route.selfAddresses.length > 0 ? route.selfAddresses : lastRoute?.selfAddresses ?? [],
      proxy: { port: settings.proxyPort, running: proxy !== undefined, error: proxyError },
      target: publishTarget(),
      loopbackForward: { policy: config.loopbackForward, open: forwards.size, path: FORWARD_PATH },
    }
  }

  const ok = value => ({ ok: true, value })
  const fail = (code, message, details = {}) => ({ ok: false, error: { code: `deepsea-tailscale/${code}`, message, details } })

  const enable = () => exclusive(async () => {
    if (disposed) return fail('disposed', 'the plugin is unloading')
    if (settings.servePath === undefined) return fail('no-path', 'This variant has no Serve path.')
    await ensureProxy()
    const outcome = await serve.enable()
    if (outcome !== 'ok') {
      const route = await routeStatus()
      const reasons = {
        'no-target': 'No proxy is running.',
        'unavailable': `Tailscale is unavailable (${route.detail ?? 'unknown'}).`,
        'conflict': `${settings.servePath} already points at ${route.mappedTarget ?? 'another service'}.`,
        'failed': 'tailscale serve failed; see the server log.',
        'verify-failed': 'tailscale serve succeeded, but the path did not appear.',
      }
      return fail(outcome, reasons[outcome] ?? outcome, { route: route.state })
    }
    state.enabled = true
    await persist()
    return ok(await snapshot())
  })

  const disable = () => exclusive(async () => {
    if (settings.servePath === undefined) return fail('no-path', 'This variant has no Serve path.')
    const outcome = await serve.disable()
    if (outcome === 'failed') return fail('failed', 'tailscale serve off failed; see the server log.')
    if (outcome === 'unavailable') return fail('unavailable', 'Tailscale is unavailable.')
    state.enabled = false
    await persist()
    return ok(await snapshot())
  })

  const setUsers = value => exclusive(async () => {
    state.allowedUsers = parseUserList(value)
    await persist()
    return ok(await snapshot())
  })

  const rotateToken = () => exclusive(async () => {
    state.token = generateToken()
    await persist()
    return ok(await snapshot())
  })

  // ---- the Server section: clients on DSH's own http.Server, and this variant's processes ----
  // `server` is a TypeScript-private field of the WebServer service; from JS it
  // is a plain property. Guarded, so a rename leaves the pane without clients
  // rather than failing the load.
  const httpServer = /** @type {any} */ (ctx.webServer).server
  const owners = new SessionOwners({ file: stateFileOf(home, 'session-owners.json'), log: warn })
  ctx.effect(() => () => { void owners.dispose() }, 'tailscale: session owners')
  const tracker = typeof httpServer?.on === 'function'
    ? attachClientTracker(httpServer, {
        ignorePrefix: CONTROL_CHANNEL,
        onSession: (facts, found) => {
          if (found.sessionId !== undefined) owners.record(found.sessionId, loginOf(facts, lastRoute?.selfLogin), found.method)
        },
      })
    : undefined
  if (tracker !== undefined) ctx.effect(() => () => tracker.dispose(), 'tailscale: client tracker')
  ctx.provide('deepseaSessionOwners', {
    /** `{ owner, actor, first, last, logins }` for a session id, or undefined when never seen. */
    of: sessionId => owners.of(sessionId),
    list: () => owners.list(),
    /** This node's own tailnet login (what direct loopback requests count as), when known. */
    selfLogin: () => lastRoute?.selfLogin,
    file: owners.file,
  })

  const relayLabel = settings.name === undefined ? undefined : `${settings.name}.relay`
  const appPath = settings.display === undefined ? undefined : join(homedir(), 'Applications', `${settings.display}.app`)
  const relayFacts = async () => {
    if (settings.relayUrl === undefined) return undefined
    const [job, up] = await Promise.all([
      relayLabel === undefined ? { loaded: false } : relayJob(relayLabel),
      settings.relayPort === undefined ? false : listening(settings.relayPort),
    ])
    return { url: settings.relayUrl, port: settings.relayPort, label: relayLabel, job, listening: up }
  }
  const workspaceCache = new Map()
  const serverStatus = async (message) => {
    const relay = await relayFacts()
    const processes = await processTable({
      relay,
      app: appPath !== undefined && existsSync(appPath) ? { path: appPath, name: settings.display } : undefined,
      port: ctx.webServer.port,
      home,
    })
    const clients = []
    for (const row of tracker?.snapshot() ?? []) {
      let workspace
      const sessionId = row.lastSession?.sessionId
      if (sessionId !== undefined) {
        workspace = workspaceCache.get(sessionId) ?? await workspaceOfSession(sessionId, home)
        if (workspace !== undefined) workspaceCache.set(sessionId, workspace)
      }
      clients.push({ ...row, lastSession: row.lastSession === undefined ? undefined : { ...row.lastSession, workspace: workspace ?? row.lastSession.cwd } })
    }
    return { variant: settings.id, tracking: tracker !== undefined, processes, clients, now: Date.now(), ...(message === undefined ? {} : { message }) }
  }
  const serverAct = args => exclusive(async () => {
    const relay = await relayFacts()
    try {
      const outcome = await performAction({ target: String(args.target ?? ''), action: String(args.action ?? '') }, {
        relayLabel,
        relayLoaded: relay?.job.loaded === true,
        relayListening: relay?.listening === true,
        appPath: appPath !== undefined && existsSync(appPath) ? appPath : undefined,
        appName: settings.display,
        deferSelf: fn => setTimeout(fn, 400),
        log,
      })
      return ok(await serverStatus(outcome.message))
    } catch (error) {
      return fail('server-act', String(error?.message ?? error))
    }
  })

  // ---- the control channel ------------------------------------------------
  // Registered on the web server with DSH's own request gate (Host/Origin
  // fence and browser-session cookie); the wire shape is the Connection
  // envelope, so the browser half calls it through `ctx.connection.rpc`.
  const dispatch = async (endpoint, payload) => {
    await boot
    const args = typeof payload === 'object' && payload !== null && typeof payload.args === 'object' && payload.args !== null ? payload.args : {}
    switch (endpoint) {
      case 'status': return ok(await snapshot())
      case 'enable': return enable()
      case 'disable': return disable()
      case 'set-users': return setUsers(args.allowedUsers)
      case 'rotate-token': return rotateToken()
      case 'server-status': return ok(await serverStatus())
      case 'server-act': return serverAct(args)
      default: return fail('unknown-endpoint', `unknown endpoint ${endpoint}`)
    }
  }
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: CONTROL_CHANNEL,
    handler: (req, res) => controlRoute(req, res, ctx.connection, dispatch),
  }), 'tailscale: control channel')

  // ---- loopback port forwarding (forward.mjs) -----------------------------
  // One WebSocket per forwarded TCP connection, opened by the DeepSea app on
  // another Mac through the proxy (which admits it and says how). DSH's own
  // request gate runs first, as for every /api upgrade.
  const reservedPorts = () => new Set([ctx.webServer.port, ...ownPorts()])
  ctx.effect(() => ctx.webServer.registerUpgrade({
    path: FORWARD_PATH,
    handler: (req, socket, head) => {
      const rejection = ctx.connection.requestRejection(req)
      if (rejection !== undefined) {
        socket.end(`HTTP/1.1 ${String(rejection)} ${rejection === 401 ? 'Unauthorized' : 'Forbidden'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
        return
      }
      return handleForwardUpgrade(req, socket, head, {
        policy: () => config.loopbackForward,
        identityOperators: () => config.identityOperators,
        selfUid: typeof process.getuid === 'function' ? process.getuid() : -1,
        reservedPorts,
        connections: forwards,
        log,
      })
    },
  }), 'tailscale: loopback forward route')

  // ---- boot: the proxy, then the Serve path as wanted ----------------------
  const boot = (async () => {
    state = await loadState(stateFile, warn)
    if (disposed) return
    await ensureProxy()
    const route = await routeStatus()
    if (!wanted() || disposed) return
    if (route.state === 'active') {
      log(`tailscale: ${route.url ?? settings.servePath} -> ${route.mappedTarget ?? '?'}`)
      return
    }
    const outcome = await serve.enable()
    if (outcome !== 'ok') warn(`tailscale: ${settings.servePath} not published (${outcome})`)
  })().catch(error => warn(`tailscale: start failed: ${String(error?.message ?? error)}`))

  // The node's name, own login and addresses can change (Tailscale started
  // late, a relogin): re-read them now and then while the proxy needs them.
  let refreshTimer
  const scheduleRefresh = () => {
    refreshTimer = setTimeout(() => {
      void routeStatus().catch(() => {}).finally(() => { if (!disposed) scheduleRefresh() })
    }, lastRoute?.dnsName === undefined ? REFRESH_UNKNOWN_MS : REFRESH_KNOWN_MS)
    refreshTimer.unref?.()
  }
  if (settings.proxyPort !== undefined) scheduleRefresh()

  ctx.effect(() => () => {
    disposed = true
    clearTimeout(refreshTimer)
    // The Serve path is intent that outlives this process (tailscaled keeps
    // it); only the proxy's listener belongs to it.
    return boot.then(() => chain).then(async () => {
      const current = proxy
      proxy = undefined
      if (current !== undefined) await current.close()
    })
  }, 'tailscale: proxy listener')
}
