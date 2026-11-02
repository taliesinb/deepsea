/**
 * The supervisor proper, without Cordis: configuration, and the state of each
 * configured model server (started on first use, reused, adopted when already
 * healthy, stopped once idle and unused). index.js wires it to session events.
 */
import { spawn as spawnProcess } from 'node:child_process'
import { join } from 'node:path'
import { openRunLog } from '@deepsea/logs'

const SERVER_KEYS = new Set(['id', 'providers', 'command', 'args', 'healthUrl', 'idleMinutes', 'startupTimeoutMs', 'env', 'logDirectory'])
export const DEFAULT_STARTUP_TIMEOUT_MS = 60_000
export const PROBE_TIMEOUT_MS = 1_500
export const POLL_MS = 500
export const KILL_GRACE_MS = 5_000

const isMapping = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Validate one server entry; every problem names the entry. */
function resolveServer(server, index) {
  const where = `local-model-supervisor: servers[${index}]`
  if (!isMapping(server)) throw new Error(`${where} must be a mapping`)
  const unknown = Object.keys(server).filter(key => !SERVER_KEYS.has(key))
  if (unknown.length > 0) throw new Error(`${where} has unknown field${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')}`)
  if (typeof server.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(server.id)) {
    throw new Error(`${where}.id must be a name of letters, digits, '.', '_' or '-'`)
  }
  if (!Array.isArray(server.providers) || server.providers.length === 0
    || server.providers.some(p => typeof p !== 'string' || p.length === 0)) {
    throw new Error(`${where}.providers must be a non-empty list of provider ids`)
  }
  if (typeof server.command !== 'string' || server.command.length === 0) throw new Error(`${where}.command must be a non-empty string`)
  if (server.args !== undefined && (!Array.isArray(server.args) || server.args.some(a => typeof a !== 'string'))) {
    throw new Error(`${where}.args must be a list of strings`)
  }
  if (typeof server.healthUrl !== 'string' || !/^https?:\/\//.test(server.healthUrl)) {
    throw new Error(`${where}.healthUrl must be an http(s) URL`)
  }
  for (const field of ['idleMinutes', 'startupTimeoutMs']) {
    if (server[field] !== undefined && (typeof server[field] !== 'number' || !Number.isFinite(server[field]) || server[field] < 0)) {
      throw new Error(`${where}.${field} must be a non-negative number`)
    }
  }
  if (server.env !== undefined && (!isMapping(server.env) || Object.values(server.env).some(v => typeof v !== 'string'))) {
    throw new Error(`${where}.env must be a mapping of strings`)
  }
  if (server.logDirectory !== undefined && (typeof server.logDirectory !== 'string' || !server.logDirectory.startsWith('/'))) {
    throw new Error(`${where}.logDirectory must be an absolute path`)
  }
  return {
    id: server.id,
    providers: [...server.providers],
    command: server.command,
    args: [...server.args ?? []],
    healthUrl: server.healthUrl,
    idleMinutes: server.idleMinutes ?? 0,
    startupTimeoutMs: server.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
    env: { ...server.env },
    ...server.logDirectory !== undefined ? { logDirectory: server.logDirectory } : {},
  }
}

/** Validate and detach the configuration: `{ servers: [...] }`, no two servers on one provider. */
export function resolveConfig(input = {}) {
  if (!isMapping(input) || Object.keys(input).some(key => key !== 'servers')) {
    throw new Error('local-model-supervisor: expected only a servers list')
  }
  if (input.servers !== undefined && !Array.isArray(input.servers)) throw new Error('local-model-supervisor: servers must be a list')
  const servers = (input.servers ?? []).map(resolveServer)
  const providers = new Set()
  const ids = new Set()
  for (const server of servers) {
    if (ids.has(server.id)) throw new Error(`local-model-supervisor: two servers are called "${server.id}"`)
    ids.add(server.id)
    for (const provider of server.providers) {
      if (providers.has(provider)) throw new Error(`local-model-supervisor: provider "${provider}" is claimed by two servers`)
      providers.add(provider)
    }
  }
  return { servers }
}

/** One 2xx-or-bust health probe. The probe never authenticates. */
export async function healthy(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    await response.body?.cancel()
    return response.ok
  } catch {
    return false
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * The configured servers and their processes.
 *
 * - `touch(provider)` records activity on a provider and makes sure its
 *   server runs: adopted when already healthy, else spawned (single-flight).
 * - `sweep()` stops owned servers idle past `idleMinutes` that `inUse`
 *   reports unused.
 * - `stopOwned()` stops every owned server (unload).
 *
 * Only processes it spawned are ever stopped.
 */
export class Supervisor {
  /**
   * @param {object} options
   * @param {Array<object>} options.servers - resolved server definitions.
   * @param {{ info(m: string): void, warn(m: string): void }} options.logger
   * @param {(server: object) => boolean} options.inUse - whether a live session still selects the server's providers.
   * @param {(server: object) => string} options.logDirectory - where a server's run logs go.
   * @param {string} [options.variant] - the variant name for log identity lines.
   */
  constructor({ servers, logger, inUse, logDirectory, variant, probe = healthy, spawn = spawnProcess, now = Date.now, pollMs = POLL_MS, killGraceMs = KILL_GRACE_MS }) {
    Object.assign(this, { servers, logger, inUse, logDirectory, variant, probe, spawn, now, pollMs, killGraceMs })
    this.byProvider = new Map(servers.flatMap(server => server.providers.map(provider => [provider, server])))
    /** Per server id: the child we spawned (if any), whether we own the running server, last activity, the ensure in flight. */
    this.states = new Map(servers.map(server => [server.id, { child: undefined, owned: false, lastActivity: 0, ensuring: undefined }]))
    this.disposed = false
  }

  /** The server carrying a provider, if any. */
  serverFor(provider) { return this.byProvider.get(provider) }

  /** Record activity on a provider and make sure its server runs. */
  touch(provider) {
    const server = this.byProvider.get(provider)
    if (server === undefined) return undefined
    this.states.get(server.id).lastActivity = this.now()
    return this.ensure(server)
  }

  /** Single-flight: adopt a healthy server or spawn our own. Never rejects. */
  ensure(server) {
    const state = this.states.get(server.id)
    if (state.ensuring !== undefined) return state.ensuring
    const run = (async () => {
      if (this.disposed) return
      if (state.child !== undefined) return // ours is up, or starting under an earlier ensure
      if (await this.probe(server.healthUrl)) {
        if (!state.owned) this.logger.info(`"${server.id}" already healthy at ${server.healthUrl}; adopting it (its lifetime is not managed here)`)
        return
      }
      if (this.disposed) return
      await this.start(server, state)
    })()
    const guard = run.catch((error) => {
      this.logger.warn(`could not start "${server.id}": ${error?.message ?? String(error)}`)
    }).finally(() => {
      if (state.ensuring === guard) state.ensuring = undefined
    })
    state.ensuring = guard
    return guard
  }

  /** Spawn the server and wait until its health probe passes. */
  async start(server, state) {
    const env = { ...process.env, ...server.env }
    let log
    try {
      log = openRunLog(server.logDirectory ?? this.logDirectory(server), { tag: 'starting' })
    } catch (error) {
      this.logger.warn(`no run log for "${server.id}": ${error?.message ?? String(error)}`)
    }
    const commandLine = [server.command, ...server.args].join(' ')
    // The run log's first line (after its time): which variant, which server and process, what ran.
    const identity = pid => [this.variant, 'local-model-supervisor', server.id, 'pid', pid, commandLine].filter(part => part !== undefined).join(' ')
    let child
    try {
      child = this.spawn(server.command, server.args, { stdio: ['ignore', log?.fd ?? 'ignore', log?.fd ?? 'ignore'], env })
    } catch (error) {
      if (log !== undefined) {
        try { log.rename('failed'); log.identify(`${identity('-')}: ${error?.message ?? String(error)}`) } catch { /* best effort */ }
        log.close()
      }
      throw error
    }
    if (log !== undefined) {
      try {
        log.rename(child.pid === undefined ? 'failed' : String(child.pid))
        log.identify(identity(child.pid ?? '-'))
      } catch { /* the log is best effort */ }
      log.close()
    }
    state.child = child
    state.owned = true
    child.on('exit', (code, signal) => {
      if (state.child !== child) return
      state.child = undefined
      state.owned = false
      this.logger.info(`"${server.id}" exited (${signal ?? code}); it starts again on next use`)
    })
    child.on('error', (error) => {
      if (state.child === child) { state.child = undefined; state.owned = false }
      this.logger.warn(`"${server.id}" failed to spawn: ${error?.message ?? String(error)}`)
    })
    const where = log === undefined ? '' : ` (see ${log.path})`
    const deadline = this.now() + server.startupTimeoutMs
    while (this.now() < deadline) {
      if (state.child !== child) throw new Error(`"${server.id}" exited during startup${where}`)
      if (await this.probe(server.healthUrl)) {
        if (state.child !== child) throw new Error(`"${server.id}" exited during startup${where}`)
        this.logger.info(`"${server.id}" started (pid ${child.pid}, ${server.healthUrl})`)
        return
      }
      await sleep(this.pollMs)
    }
    this.stop(state)
    throw new Error(`"${server.id}" did not become healthy within ${server.startupTimeoutMs} ms${where}`)
  }

  /** Stop owned servers idle past their window with no live session on their providers. */
  sweep() {
    const now = this.now()
    for (const server of this.servers) {
      const state = this.states.get(server.id)
      if (state.child === undefined || !state.owned) continue
      const idleMs = server.idleMinutes * 60_000
      if (idleMs === 0 || now - state.lastActivity < idleMs) continue
      if (this.inUse(server)) continue
      this.logger.info(`"${server.id}" idle ${Math.round((now - state.lastActivity) / 60_000)} min with no live session on ${server.providers.join(', ')}; stopping pid ${state.child.pid}`)
      this.stop(state)
    }
  }

  /** SIGTERM an owned child, SIGKILL after a grace period. */
  stop(state) {
    const child = state.child
    if (child === undefined || !state.owned) return
    child.kill('SIGTERM')
    const hardKill = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }, this.killGraceMs)
    hardKill.unref?.()
  }

  /** Stop every owned server and refuse further starts. */
  stopOwned() {
    this.disposed = true
    for (const state of this.states.values()) this.stop(state)
  }
}

/** Where a server's run logs go by default: `<plugin log directory>/<server id>`. */
export const serverLogDirectory = pluginDirectory => server => join(pluginDirectory, server.id)
