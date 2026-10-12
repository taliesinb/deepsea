/**
 * The Server section's data: who is connected to this variant, and the
 * processes that make it up (its relay, this `dsh web`, its app) with the
 * few actions that apply to each. Installing anything is dsd's job, never
 * this pane's.
 *
 * Clients are observed on DSH's own http.Server (every request and WebSocket
 * upgrade passes through it, from a loopback tab or through the proxy), keyed
 * by (login, address, user agent):
 *   - login and address: the proxy's `x-deepsea-tailscale-*` headers for
 *     proxied clients; `local` and the socket peer for direct ones;
 *   - open sockets: `/api/remote.mux` upgrades still alive, i.e. live tabs;
 *   - last session: from `POST /api/session/*` bodies (only listened to,
 *     never consumed).
 * Rows expire after IDLE_MS without a request or an open socket.
 */
import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { connect } from 'node:net'
import { join } from 'node:path'
import { HEADER } from './proxy.mjs'

const IDLE_MS = 2 * 60 * 1000
const BODY_SNIFF_LIMIT = 64 * 1024
const MUX_PATH = '/api/remote.mux'

function header(req, name) {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}

/** A short user-agent label. The DeepSea app's agent ends in `DeepSea/<version>`. */
export function describeUserAgent(ua) {
  const text = String(ua ?? '')
  if (text === '') return '—'
  if (/\bDeepSea\//.test(text)) return 'DeepSea'
  if (/curl\//.test(text)) return 'curl'
  if (/Edg\//.test(text)) return 'Edge'
  if (/CriOS|Chrome\//.test(text)) return /Mobile/.test(text) ? 'Chrome mobile' : 'Chrome'
  if (/Firefox\//.test(text)) return 'Firefox'
  if (/Safari\//.test(text)) return /iPhone|iPad/.test(text) ? 'iOS Safari' : 'Safari'
  return '—'
}

/** Identity facts of one request as DSH sees it. `self`: this Mac (a direct request, or the proxy says so). */
export function clientFacts(req) {
  const proxied = header(req, HEADER.proxied) === '1'
  const login = proxied ? header(req, HEADER.login) : undefined
  const admitted = proxied ? header(req, HEADER.admitted) ?? 'unknown' : 'local'
  const address = (proxied ? header(req, 'x-forwarded-for') : undefined) ?? String(req.socket?.remoteAddress ?? '').replace(/^::ffff:/i, '')
  const self = !proxied || header(req, HEADER.self) === '1'
  const userAgent = header(req, 'user-agent') ?? ''
  return { proxied, login: login ?? (proxied ? undefined : 'local'), admitted, address, self, userAgent }
}

/**
 * Session facts in a `POST /api/session/...` body, if any. The gateway's wire
 * shape is `payload.args` keyed by parameter name, so `prompt(request)`
 * arrives as `{ args: { request: { sessionId, … } } }`: the sniffer looks one
 * level down. Flat `args.sessionId` and positional `args[0]` are read too.
 */
export function sniffSession(method, bodyText) {
  if (!/^session\//.test(method)) return undefined
  let parsed
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    return undefined
  }
  const args = parsed?.payload?.args
  const candidates = Array.isArray(args) ? [args[0]] : [args, ...(typeof args === 'object' && args !== null ? Object.values(args) : [])]
  for (const record of candidates) {
    if (typeof record !== 'object' || record === null) continue
    const sessionId = typeof record.sessionId === 'string' ? record.sessionId : typeof record.id === 'string' && record.id.startsWith('session-') ? record.id : undefined
    const cwd = typeof record.cwd === 'string' ? record.cwd : undefined
    if (sessionId !== undefined || cwd !== undefined) return { method, sessionId, cwd }
  }
  return undefined
}

/**
 * @param {import('node:http').Server} httpServer DSH's server (`ctx.webServer.server`)
 * @param {{ now?: () => number, ignorePrefix?: string, onSession?: (facts: ReturnType<typeof clientFacts>, found: { method: string, sessionId?: string, cwd?: string }) => void }} [options]
 *   `onSession` fires for every sniffed `POST /api/session/*` body (session owners attribute with it).
 */
export function attachClientTracker(httpServer, options = {}) {
  const now = options.now ?? Date.now
  /** @type {Map<string, any>} */
  const clients = new Map()

  const rowFor = (req) => {
    const facts = clientFacts(req)
    const key = `${facts.login ?? '?'}|${facts.address}|${facts.userAgent}`
    let row = clients.get(key)
    if (row === undefined) {
      row = { key, ...facts, agent: describeUserAgent(facts.userAgent), firstSeen: now(), lastSeen: now(), requests: 0, sockets: 0, lastSession: undefined, lastPath: undefined }
      clients.set(key, row)
    }
    row.lastSeen = now()
    return row
  }

  const onRequest = (req) => {
    const row = rowFor(req)
    row.requests += 1
    const url = String(req.url ?? '/')
    const path = url.split('?')[0]
    // The section's own polling is not looking at anything.
    if (options.ignorePrefix === undefined || !path.startsWith(`${options.ignorePrefix}/`)) row.lastPath = path
    if (req.method === 'POST' && url.startsWith('/api/')) {
      const method = url.slice('/api/'.length).split('?')[0]
      if (/^session\//.test(method)) {
        let text = ''
        let over = false
        const onData = (chunk) => {
          if (over) return
          text += chunk.toString('utf8')
          if (text.length > BODY_SNIFF_LIMIT) over = true
        }
        req.on('data', onData)
        req.once('end', () => {
          req.off('data', onData)
          if (over) return
          const found = sniffSession(method, text)
          if (found === undefined) return
          row.lastSession = { ...found, at: now() }
          try { options.onSession?.(row, found) } catch { /* an observer must not break request handling */ }
        })
      }
    }
  }

  const onUpgrade = (req, socket) => {
    const row = rowFor(req)
    row.requests += 1
    if (String(req.url ?? '').split('?')[0] !== MUX_PATH) return
    row.sockets += 1
    socket.once('close', () => {
      row.sockets = Math.max(0, row.sockets - 1)
      row.lastSeen = now()
    })
  }

  httpServer.on('request', onRequest)
  httpServer.on('upgrade', onUpgrade)

  return {
    snapshot: () => {
      const cutoff = now() - IDLE_MS
      for (const [key, row] of clients) {
        if (row.sockets === 0 && row.lastSeen < cutoff) clients.delete(key)
      }
      return [...clients.values()]
        .sort((a, b) => (b.sockets - a.sockets) || (b.lastSeen - a.lastSeen))
        .map(row => ({ ...row, userAgent: row.userAgent.slice(0, 200) }))
    },
    dispose: () => {
      httpServer.off('request', onRequest)
      httpServer.off('upgrade', onUpgrade)
      clients.clear()
    },
  }
}

/** The workspace directory a session lives under (`--Users-USER-x--` → `/Users/USER/x`), from the sessions store. */
export async function workspaceOfSession(sessionId, home) {
  const root = join(home, 'sessions')
  for (const entry of await readdir(root).catch(() => [])) {
    const inside = await readdir(join(root, entry)).catch(() => [])
    if (inside.includes(sessionId)) return entry.replace(/^--/, '/').replace(/--$/, '').replace(/-/g, '/')
  }
  return undefined
}

// ---- processes -------------------------------------------------------------

/** Run a command: `{ code, stdout, stderr }`, never throws. */
export function runCommand(binary, args) {
  return new Promise((resolve) => {
    execFile(binary, args, { maxBuffer: 4 * 1024 * 1024, timeout: 10_000 }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

/** Whether something accepts TCP connections on 127.0.0.1:<port> (1 s). */
export function listening(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    const done = (ok) => { socket.destroy(); clearTimeout(timer); resolve(ok) }
    const timer = setTimeout(() => done(false), 1000)
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

/** macOS `ps` prints elapsed time as `[[dd-]hh:]mm:ss` (there is no `etimes`). */
export function parseEtime(text) {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(text).trim())
  if (match === null) return undefined
  const [, days = '0', hours = '0', minutes, seconds] = match
  return Number(days) * 86400 + Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds)
}

/** `ps` facts for one pid: elapsed seconds, rss KB, parent, command. */
export async function psFacts(pid, run = runCommand) {
  const result = await run('/bin/ps', ['-o', 'etime=,rss=,ppid=,command=', '-p', String(pid)])
  if (result.code !== 0) return undefined
  const match = /^\s*(\S+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(result.stdout.trim())
  if (match === null) return undefined
  return { pid, uptimeSeconds: parseEtime(match[1]), rssKb: Number(match[2]), ppid: Number(match[3]), command: match[4] }
}

/** `launchctl print` (read-only) for the relay's job: loaded, and its pid when running. */
export async function relayJob(label, run = runCommand) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (uid === undefined || process.platform !== 'darwin') return { loaded: false }
  const result = await run('/bin/launchctl', ['print', `gui/${String(uid)}/${label}`])
  if (result.code !== 0) return { loaded: false }
  const pid = /^\s*pid = (\d+)\s*$/m.exec(result.stdout)?.[1]
  return { loaded: true, pid: pid === undefined ? undefined : Number(pid) }
}

/** Pids whose command line contains `pattern`. */
async function pidsMatching(pattern, run) {
  const result = await run('/usr/bin/pgrep', ['-f', pattern])
  return result.code === 0 ? result.stdout.trim().split(/\s+/).filter(Boolean).map(Number) : []
}

const ACTIONS = {
  restart: { id: 'restart', label: 'Restart', danger: true },
  quit: { id: 'quit', label: 'Quit', danger: true },
  launch: { id: 'launch', label: 'Launch' },
}

/**
 * The process rows.
 * @param {{ relay?: { url: string, port?: number, label?: string, job: { loaded: boolean, pid?: number }, listening: boolean },
 *   app?: { path: string, name: string }, port: number, home: string, run?: typeof runCommand }} spec
 */
export async function processTable(spec) {
  const run = spec.run ?? runCommand
  const rows = []
  const relay = spec.relay
  if (relay !== undefined) {
    const pid = relay.job.pid
    const facts = pid === undefined ? undefined : await psFacts(pid, run)
    rows.push({
      id: 'relay',
      title: 'Relay',
      details: [
        ...(relay.job.loaded && relay.label !== undefined ? [`LaunchAgent ${relay.label}`] : []),
        `${relay.url}${relay.listening ? '' : ' (not answering)'}`,
      ],
      command: facts?.command,
      pid,
      running: relay.listening,
      uptimeSeconds: facts?.uptimeSeconds,
      rssKb: facts?.rssKb,
      actions: relay.job.loaded ? [ACTIONS.restart] : [],
    })
  }
  const self = await psFacts(process.pid, run)
  const parent = self === undefined ? undefined : await psFacts(self.ppid, run)
  rows.push({
    id: 'dsh',
    title: 'dsh web',
    details: [
      `http://127.0.0.1:${String(spec.port)}/`,
      `DSH_HOME ${spec.home}`,
      ...(parent === undefined ? [] : [`parent pid ${String(parent.pid)}: ${parent.command}`]),
    ],
    // ps shows argv[0] as invoked; for this process the real binary is known.
    command: [process.execPath, ...process.argv.slice(1)].join(' '),
    pid: process.pid,
    running: true,
    uptimeSeconds: Math.round(process.uptime()),
    rssKb: Math.round(process.memoryUsage().rss / 1024),
    actions: relay?.listening ? [ACTIONS.restart, ACTIONS.quit] : [ACTIONS.quit],
  })
  if (spec.app !== undefined) {
    const pids = await pidsMatching(`${spec.app.path}/Contents/MacOS/`, run)
    const facts = pids.length === 0 ? undefined : await psFacts(pids[0], run)
    rows.push({
      id: 'app',
      title: `${spec.app.name}.app`,
      details: [spec.app.path],
      command: facts?.command,
      pid: pids[0],
      running: pids.length > 0,
      uptimeSeconds: facts?.uptimeSeconds,
      rssKb: facts?.rssKb,
      actions: pids.length > 0 ? [ACTIONS.quit] : [ACTIONS.launch],
    })
  }
  return rows
}

/**
 * Carry out one action. `deferSelf` runs a step that ends this process after
 * the response has gone out.
 * @param {{ target: string, action: string }} request
 * @param {{ relayLabel?: string, relayLoaded: boolean, relayListening: boolean, appPath?: string, appName?: string,
 *   deferSelf: (fn: () => void) => void, log: (line: string) => void, run?: typeof runCommand, kill?: (pid: number, signal: string) => void }} deps
 */
export async function performAction(request, deps) {
  const run = deps.run ?? runCommand
  const kill = deps.kill ?? ((pid, signal) => process.kill(pid, signal))
  const key = `${request.target}/${request.action}`
  switch (key) {
    case 'relay/restart': {
      if (!deps.relayLoaded || deps.relayLabel === undefined) throw new Error('no relay job to restart')
      const uid = process.getuid?.()
      deps.log(`tailscale: Server pane restarts the relay (launchctl kickstart -k ${deps.relayLabel})`)
      // kickstart -k ends this server too (the relay stops its process group): answer first.
      deps.deferSelf(() => { void run('/bin/launchctl', ['kickstart', '-k', `gui/${String(uid)}/${deps.relayLabel}`]) })
      return { message: 'Relay restarting.' }
    }
    case 'dsh/restart':
    case 'dsh/quit':
      if (request.action === 'restart' && !deps.relayListening) throw new Error('no relay to start the server again; use Quit')
      deps.log(`tailscale: Server pane ${request.action}: SIGTERM to this server`)
      deps.deferSelf(() => { kill(process.pid, 'SIGTERM') })
      return { message: request.action === 'restart' ? 'Restarting.' : 'Quitting.' }
    case 'app/quit':
      if (deps.appPath === undefined) throw new Error('no app')
      await run('/usr/bin/pkill', ['-TERM', '-f', `${deps.appPath}/Contents/MacOS/`])
      return { message: `${deps.appName ?? 'The app'} quit.` }
    case 'app/launch':
      if (deps.appPath === undefined) throw new Error('no app')
      await run('/usr/bin/open', [deps.appPath])
      return { message: `${deps.appName ?? 'The app'} launched.` }
    default:
      throw new Error(`unknown action ${key}`)
  }
}
