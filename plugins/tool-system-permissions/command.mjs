/**
 * command.mjs — the `/system-permissions` slash command (registered by the
 * package root, index.js: it needs the prober and the registry of calls, which
 * live there, and commands are a Host service).
 *
 *   /system-permissions [status]   every class the tool supports: name → granted | denied | stale | not asked
 *   /system-permissions remove     tccutil reset of every class, this server host only
 *   /system-permissions add        a seek for every class, shown at once in the floating panel
 *
 * The replies are plain text: the command row of the chat shows them in a
 * monospace block (no Markdown), so the tables are aligned text.
 */

import { AUTOMATION_TARGETS, CLASSES, parsePermission } from './permissions.mjs'
import { createSeek, sessionIdsOf } from './seek.mjs'
import { RESETTABLE_SUBJECT, resetCommand } from './macos.mjs'

/** The command's name (the browser half keys its row on it). */
export const COMMAND_NAME = 'system-permissions'
export const USAGE = 'Usage: /system-permissions [status | add | remove]'
/** The justification `add` gives every permission. */
export const ADD_JUSTIFICATION = '/system-permissions add'
/** System Events: the Automation target `add` asks for and `status` always lists. */
export const SYSTEM_EVENTS = 'automation:com.apple.systemevents'

/** The fixed classes, as the parser gives them (no aliases). */
export function fixedClasses() {
  return CLASSES.map(c => parsePermission(c.id))
}

/** Every Automation target the tool names (`status` shows those it can say something about). */
export function automationClasses() {
  return Object.keys(AUTOMATION_TARGETS).map(key => parsePermission(`automation:${key}`))
}

/** One class per TCC service, for `remove`: the six fixed ones and Apple events (System Events stands for every target). */
export function resetClasses() {
  return [...fixedClasses(), parsePermission(SYSTEM_EVENTS)]
}

/** A probe status in the four words of `status` (and a few for Automation). */
export function statusWord(status) {
  switch (status) {
    case 'granted': return 'granted'
    // Full Disk Access's refused read cannot tell a switched-off row from a missing one, and the read itself
    // makes tccd record the row (denied).
    case 'denied': case 'not-granted': return 'denied'
    case 'stale': return 'stale'
    case 'not-determined': case 'unknown': return 'not asked'
    case 'not-running': return 'not running'
    case 'unavailable': return 'not installed'
    case 'restricted': return 'restricted'
    default: return String(status)
  }
}

/** Two aligned columns, with a header and a rule. */
export function textTable(header, rows) {
  const width = Math.max(header[0].length, ...rows.map(r => r[0].length))
  const line = ([a, b]) => `${a.padEnd(width)}  ${b}`
  return [line(header), line(['-'.repeat(width), '-'.repeat(Math.max(header[1].length, ...rows.map(r => r[1].length)))]), ...rows.map(line)].join('\n')
}

/**
 * `status`: one refined probe of every fixed class and every Automation
 * target. A target is listed when it is System Events, or when its answer
 * says something (granted, denied, not asked): a target that is not running
 * cannot be asked without launching it, one not installed is left out.
 */
export async function runStatus(prober) {
  const fixed = fixedClasses()
  const targets = automationClasses()
  const { subject, results } = await prober.probe([...fixed, ...targets], { refine: true })
  const rows = fixed.map(c => [c.id, statusWord(results[c.id]?.status)])
  for (const c of targets) {
    const status = results[c.id]?.status
    if (c.id === SYSTEM_EVENTS || ['granted', 'denied', 'stale', 'not-determined'].includes(status)) rows.push([c.id, statusWord(status)])
  }
  const who = subject?.name ? `${subject.name}${subject.bundleId ? ` (${subject.bundleId})` : ''}` : 'this server host'
  return { kind: 'success', text: `${who}\n\n${textTable(['permission', 'status'], rows)}` }
}

/**
 * `remove`: `tccutil reset <Service> <server host id>` for each of the seven
 * services, never another bundle id and never `All` (macos.mjs
 * `resetCommand`). Refused when the responsible app is not a DeepSea server
 * host.
 */
export async function runRemove(prober) {
  const { subject } = await prober.probe([], {})
  const bundleId = subject?.bundleId
  if (typeof bundleId !== 'string' || !RESETTABLE_SUBJECT.test(bundleId)) {
    return { kind: 'error', text: `Not removed: this server runs under ${bundleId ?? 'an unknown app'}, not a DeepSea server host (io.github.taliesinb.deepsea.<variant>.server).` }
  }
  const rows = []
  let failed = 0
  for (const cls of resetClasses()) {
    const command = resetCommand(cls, subject)
    const service = command?.[2] ?? cls.service
    const result = typeof prober.resetStale === 'function' ? await prober.resetStale(cls, { subject }) : { ok: false, error: 'this prober cannot reset' }
    if (!result.ok) failed += 1
    rows.push([service, result.ok ? 'reset' : `failed: ${String(result.error ?? 'unknown error').split('\n')[0]}`])
  }
  const head = `${failed === 0 ? 'Removed' : `Removed with ${failed} failure${failed === 1 ? '' : 's'}`}: every privacy grant and row of ${subject.name ?? bundleId} (${bundleId}), with /usr/bin/tccutil reset <Service> ${bundleId}.`
  return { kind: failed === rows.length ? 'error' : 'success', text: `${head}\n\n${textTable(['service', 'result'], rows)}` }
}

/**
 * `add`: a seek for every fixed class and System Events, each justified by
 * the command itself, tracked in the registry under `command-<commandId>` and
 * due in the floating panel at once (`noticeAt`: now). It runs on after the
 * command has answered; the reply's `call:` line lets the command row draw
 * its live card.
 */
export function runAdd({ prober, registry, settings, logger, now = Date.now }, invocation) {
  const classes = [...fixedClasses(), parsePermission(SYSTEM_EVENTS)].map(c => ({ ...c, justification: ADD_JUSTIFICATION }))
  const callId = `command-${String(invocation.commandId)}`
  const seek = createSeek({ classes, prober, ...settings, noticeAt: now(), logger })
  const tracked = registry.track(callId, sessionIdsOf({ agent: invocation.agent }), seek)
  void seek.run().catch(() => {}).finally(() => tracked.done())
  return { kind: 'success', text: `Asking for ${classes.length} permissions: ${classes.map(c => c.id).join(', ')}.\ncall: ${callId}`, seek, callId }
}

/**
 * The command definition.
 * @param {{ prober: object, registry: object, settings?: () => object, logger?: object, now?: () => number }} deps
 */
export function createCommand(deps) {
  return {
    name: COMMAND_NAME,
    description: 'macOS privacy permissions of this server: status, add (ask for all), remove (reset all)',
    input: { hint: '[status | add | remove]' },
    handler: async (invocation) => {
      const sub = String(invocation.rawInput ?? '').trim().toLowerCase()
      if (process.platform !== 'darwin' && deps.platform !== 'darwin') return { kind: 'error', text: 'Not applicable: this server does not run on macOS.' }
      try {
        if (sub === '' || sub === 'status') return await runStatus(deps.prober)
        if (sub === 'remove') return await runRemove(deps.prober)
        if (sub === 'add') {
          const { kind, text } = runAdd({ ...deps, settings: deps.settings?.() ?? {} }, invocation)
          return { kind, text }
        }
        return { kind: 'error', text: `Unknown subcommand "${sub}". ${USAGE}` }
      } catch (error) {
        return { kind: 'error', text: `/system-permissions ${sub || 'status'} failed: ${error instanceof Error ? error.message : String(error)}` }
      }
    },
  }
}
