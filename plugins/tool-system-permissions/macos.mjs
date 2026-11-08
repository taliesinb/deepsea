/**
 * macos.mjs — the real prober: macos/probe.jxa run through `osascript` as a
 * fresh child of this server for every probe, so macOS charges it to the
 * same responsible process as the agent's own commands (the variant's server
 * host app) and no per-process cache answers for it.
 *
 * A prober (this one, or fake.mjs's) has:
 *   kind                     'macos' | 'fake'
 *   probe(classes, { refine })  → { subject, results: { <id>: { status, … } } }
 *   trigger(cls, { status, subject }) → { stop() }   never throws
 *   openPane(cls, { subject }) → Promise<void>         never throws
 *   resetStale(cls, { subject }) → Promise<{ ok, command?, error? }>   never throws
 *
 * Refinement. Screen Recording and Accessibility preflights answer only yes
 * or no. With `refine`, the probe also reads tccd's own record of that very
 * probe from the unified log (no Full Disk Access needed): the
 * AUTHREQ_RESULT authValue of each preflight (0 denied, 1 unknown, 2
 * allowed), matched to its service by msgID (`<probe pid>.<n>`), and any
 * "Failed to match existing code requirement for subject <app> and service
 * <service>" line since the probe started: a STALE entry, left by an earlier
 * build of the app, that System Settings may show switched on but tccd
 * ignores. Stale wins over every status but granted.
 */

import { execFile, spawn as spawnChild } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { paneUrl } from './permissions.mjs'

export const PROBE_SCRIPT = fileURLToPath(new URL('./macos/probe.jxa', import.meta.url))

/** Seconds a trigger child may stay alive waiting for an asynchronous prompt (Microphone, Camera). */
export const TRIGGER_KEEPALIVE_SECONDS = 600

/** `execFile` as a promise of stdout, with a timeout. */
export function execText(file, args, { timeout = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        error.message = `${file} ${args[0] ?? ''}: ${String(stderr || error.message).trim()}`
        reject(error)
      } else resolve(stdout)
    })
  })
}

/**
 * The only apps whose entries a reset may touch: a DeepSea variant's server
 * host (LAYOUT.md §1: `io.github.taliesinb.deepsea.<v>.server`). When the
 * agent's commands are charged to anything else (a terminal running `dsh`
 * by hand, say), nothing is reset and the user removes the entry by hand.
 */
export const RESETTABLE_SUBJECT = /^io\.github\.taliesinb\.deepsea\.[a-z0-9-]+\.server$/

/** `tccutil reset`'s SERVICE argument: tccutil prefixes it with `kTCCService` itself. */
export function tccutilService(service) {
  return String(service).replace(/^kTCCService/, '')
}

/**
 * The exact command that removes one stale entry: one service, one bundle id
 * (the server host's), never `All` and never without a bundle id. Undefined
 * when the subject is not a DeepSea server host.
 * @param {{ service: string }} cls
 * @param {{ bundleId?: string }} subject
 * @returns {string[] | undefined} argv, starting with the program.
 */
export function resetCommand(cls, subject) {
  const bundleId = subject?.bundleId
  const service = tccutilService(cls.service)
  if (typeof bundleId !== 'string' || !RESETTABLE_SUBJECT.test(bundleId)) return undefined
  if (!/^[A-Za-z]+$/.test(service) || service === 'All') return undefined
  return ['/usr/bin/tccutil', 'reset', service, bundleId]
}

/** tccd's authValue → our status (only used to refine a "not-granted"). */
const AUTH_VALUE = { 0: 'denied', 1: 'not-determined', 2: 'granted', 3: 'granted' }

/**
 * Parse `log show --style ndjson` output for one probe.
 * @param {string} text - ndjson, one event per line (other lines ignored).
 * @param {{ pid: number, bundleId?: string }} probe
 * @returns {{ authValues: Record<string, number>, stale: Set<string> }} authValues keyed by TCC service.
 */
export function parseTccLog(text, probe) {
  const services = new Map()
  const values = new Map()
  const stale = new Set()
  const prefix = `msgID=${probe.pid}.`
  for (const line of String(text).split('\n')) {
    if (!line.startsWith('{')) continue
    let message
    try { message = JSON.parse(line).eventMessage } catch { continue }
    if (typeof message !== 'string') continue
    const failed = /^Failed to match existing code requirement for subject (\S+) and service (\S+)/.exec(message)
    if (failed) {
      if (probe.bundleId === undefined || failed[1] === probe.bundleId) stale.add(failed[2])
      continue
    }
    const at = message.indexOf(prefix)
    if (at === -1) continue
    const id = /^msgID=(\d+\.\d+)/.exec(message.slice(at))?.[1]
    if (id === undefined) continue
    const service = /service=(kTCCService\w+)/.exec(message)?.[1]
    if (message.startsWith('AUTHREQ_CTX:') && service) services.set(id, service)
    const value = /authValue=(\d+)/.exec(message)?.[1]
    if (message.startsWith('AUTHREQ_RESULT:') && value !== undefined) values.set(id, Number(value))
  }
  const authValues = {}
  for (const [id, service] of services) if (values.has(id)) authValues[service] = values.get(id)
  return { authValues, stale }
}

/**
 * Apply a parsed log to raw probe results (pure).
 * @param {Record<string, { status: string }>} results
 * @param {{ id: string, service: string }[]} classes
 * @param {{ authValues: Record<string, number>, stale: Set<string> }} log
 */
export function refineResults(results, classes, log) {
  const out = {}
  for (const cls of classes) {
    const result = { ...results[cls.id] }
    if (result.status === 'not-granted' && log.authValues[cls.service] !== undefined) {
      const refined = AUTH_VALUE[log.authValues[cls.service]]
      // A preflight that said no while tccd said allowed: keep the probe's no.
      if (refined !== undefined && refined !== 'granted') result.status = refined
    }
    if (result.status !== 'granted' && result.status !== 'unavailable' && log.stale.has(cls.service)) result.status = 'stale'
    out[cls.id] = result
  }
  return out
}

/** The tccd predicate for one probe: its own requests, and stale-entry lines for its subject. */
export function tccPredicate(pid, bundleId) {
  const own = `eventMessage CONTAINS "msgID=${pid}."`
  const stale = bundleId ? ` OR eventMessage BEGINSWITH "Failed to match existing code requirement for subject ${bundleId} "` : ''
  return `process == "tccd" AND (${own}${stale})`
}

/**
 * The real prober.
 * @param {{ exec?: typeof execText, spawn?: typeof spawnChild, script?: string, now?: () => number, logger?: { warn: (m: string) => void, debug?: (m: string) => void } }} [deps]
 */
export function createMacProber(deps = {}) {
  const exec = deps.exec ?? execText
  const spawn = deps.spawn ?? spawnChild
  const script = deps.script ?? PROBE_SCRIPT
  const now = deps.now ?? Date.now
  const logger = deps.logger

  async function probe(classes, { refine = false } = {}) {
    const startedAt = now()
    const stdout = await exec('osascript', ['-l', 'JavaScript', script, 'probe', ...classes.map(c => c.id)])
    const parsed = JSON.parse(stdout)
    const subject = parsed.subject ?? {}
    let results = parsed.results ?? {}
    for (const cls of classes) if (results[cls.id] === undefined) results[cls.id] = { status: 'unknown' }
    if (refine && classes.some(c => results[c.id].status !== 'granted')) {
      try {
        const seconds = Math.max(2, Math.ceil((now() - startedAt) / 1000) + 2)
        const text = await exec('log', ['show', '--last', `${seconds}s`, '--style', 'ndjson', '--predicate', tccPredicate(parsed.pid, subject.bundleId)], { timeout: 20_000 })
        results = refineResults(results, classes, parseTccLog(text, { pid: parsed.pid, bundleId: subject.bundleId }))
      } catch (error) {
        logger?.warn(`tool-system-permissions: reading tccd's log failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return { subject, results }
  }

  function trigger(cls, { status } = {}) {
    let child
    let stopped = false
    const start = () => {
      if (stopped) return
      try {
        child = spawn('osascript', ['-l', 'JavaScript', script, 'trigger', cls.id, String(TRIGGER_KEEPALIVE_SECONDS)], { stdio: ['ignore', 'pipe', 'pipe'] })
        child.on('error', error => logger?.warn(`tool-system-permissions: trigger ${cls.id} failed: ${error.message}`))
        let out = ''
        child.stdout?.on('data', chunk => { out += chunk })
        child.on('exit', () => { if (out.trim()) logger?.debug?.(`tool-system-permissions: trigger ${cls.id}: ${out.trim()}`) })
      } catch (error) {
        logger?.warn(`tool-system-permissions: trigger ${cls.id} failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (cls.target && status === 'not-running') {
      // Apple events can only be asked about for a running app: launch it hidden, in the background.
      exec('open', ['-g', '-j', '-b', cls.target.bundleId]).catch(error => logger?.warn(`tool-system-permissions: launching ${cls.target.bundleId} failed: ${error.message}`)).finally(start)
    } else start()
    return { stop() { stopped = true; if (child && child.exitCode === null) child.kill() } }
  }

  // `reveal` (Screen Recording, Input Monitoring while the app is not listed): the server host in
  // Finder too, to be dragged into the list, as upstream's computer-use permission guide does.
  // Accessibility and Full Disk Access need none: the probe itself makes tccd list the app
  // (AXIsProcessTrusted; the refused read: "recording denied"), seen on macOS 27.2.
  async function openPane(cls, { subject, reveal = false } = {}) {
    try { await exec('open', [paneUrl(cls)]) } catch (error) { logger?.warn(`tool-system-permissions: opening ${paneUrl(cls)} failed: ${error instanceof Error ? error.message : String(error)}`) }
    if (reveal && typeof subject?.app === 'string' && subject.app.endsWith('.app')) {
      try { await exec('open', ['-R', subject.app]) } catch (error) { logger?.warn(`tool-system-permissions: revealing ${subject.app} failed: ${error instanceof Error ? error.message : String(error)}`) }
    }
  }

  /**
   * Remove a stale entry: `tccutil reset <Service> <server host id>`. The
   * user's own tccd does it without an administrator (as Chromium does for
   * its own Screen Recording entry). Never throws.
   * @returns {Promise<{ ok: boolean, command?: string[], error?: string }>}
   */
  async function resetStale(cls, { subject } = {}) {
    const command = resetCommand(cls, subject)
    if (command === undefined) return { ok: false, error: `not a DeepSea server host: ${subject?.bundleId ?? 'unknown app'}` }
    try {
      await exec(command[0], command.slice(1), { timeout: 10_000 })
      logger?.info?.(`tool-system-permissions: removed a stale entry: ${command.join(' ')}`)
      return { ok: true, command }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger?.warn(`tool-system-permissions: ${command.join(' ')} failed: ${message}`)
      return { ok: false, command, error: message }
    }
  }

  return { kind: 'macos', probe, trigger, openPane, resetStale }
}
