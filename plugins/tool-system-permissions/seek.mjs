/**
 * seek.mjs — `seek_system_permission`: one call's session (the rows, the
 * polling, Grant and Deny, the notice time), the registry the routes reach
 * running sessions through, the tool definition and the model's text.
 *
 * Kept free of Cordis so the unit tests drive it with a fake prober.
 *
 * ROW STATES (the card's icons in brackets):
 *   checking     before the first probe answered            […]
 *   granted      granted, already or during the call         [✓]
 *   pending      not granted, nobody acted on it yet         [?]  Grant / Deny
 *   granting     Grant pressed: dialog, or pane (and Finder) [?]  Grant / Deny
 *                opened, being polled
 *   denied       the user pressed Deny                       [✗]
 *   unavailable  cannot be granted here: restricted by       [✗]
 *                policy, or the target app is not installed
 *   cancelled    still open when the turn was stopped        [✗]
 *
 * ONE WINDOW (permissions.mjs `grant`): the first Grant on a never-asked
 * Microphone, Camera or Automation row fires only the trigger, whose Allow /
 * Don't Allow is the grant; on a never-asked Screen Recording or Input
 * Monitoring row only the request API, whose alert lists the app and leads
 * to the pane. Every other Grant opens the pane (with the server host in
 * Finder for those two while it is still not listed). Don't Allow turns the
 * row into a cross, denied in the dialog; the alerts' Deny is not recorded.
 *
 * STALE ENTRIES: Grant on a row the probe judged stale (tccd logged "Failed
 * to match existing code requirement" for it) first removes that entry with
 * the prober's `resetStale` (`tccutil reset <Service> <server host id>`: one
 * service, the server host's bundle id only), then triggers and opens the
 * pane as for a never-asked row. Rows not judged stale are never reset.
 *
 * Every open row (pending or granting) is probed every `pollMs` in a fresh
 * process, so a permission switched on in System Settings without pressing
 * Grant still turns into a tick. The call returns once no row is open.
 *
 * NOTICE: nothing is granted without a click. While a row is open, the
 * snapshot's `noticeAt` is `noticeMs` after the last activity (the start, a
 * click, a row changing); the package root's browser half shows the card in
 * a floating panel of the macOS app at that time, so an agent waiting in a
 * session nobody is looking at gets seen (index.js, src/client/notice.ts).
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { JUSTIFICATION_MAX, instructions, paneName, parsePermissions, PermissionNameError, UNATTAINABLE } from './permissions.mjs'

/** Service the package root provides (prober, running and finished calls); the tools row reads it optionally. */
export const SERVICE = 'deepseaSystemPermissions'
/** The tool's name, as the model calls it. */
export const TOOL_NAME = 'seek_system_permission'
/** Error code of an unknown or malformed permission name. */
export const INVALID_PERMISSION = 'INVALID_PERMISSION'
/** The registry's canonical cancellation code (dsh-tools TOOL_ABORTED). */
export const TOOL_ABORTED = 'ABORTED'
/** presentationMeta marker the card keys on. */
export const META_MARK = 'system-permissions'

/** Model-facing failure (a HarnessError so `code` reaches `result.error`). */
export class SeekError extends HarnessError {
  constructor(message, code) {
    super(message, code)
    this.name = 'SeekError'
  }
}

const OPEN = new Set(['pending', 'granting'])

/** `4 s`, `2 min 5 s`, `1 h 3 min`. */
export function formatSeconds(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0
  const whole = Math.round(seconds)
  if (whole < 60) return `${whole} s`
  const h = Math.floor(whole / 3600)
  const m = Math.floor((whole % 3600) / 60)
  const s = whole % 60
  return [h > 0 ? `${h} h` : '', m > 0 ? `${m} min` : '', s > 0 && h === 0 ? `${s} s` : ''].filter(Boolean).join(' ')
}

/**
 * One call's session.
 * @param {object} options
 * @param {ReturnType<typeof parsePermissions>} options.classes
 * @param {{ probe: Function, trigger: Function, openPane: Function }} options.prober
 * @param {number} [options.pollMs] - between probes.
 * @param {number} [options.refineMs] - least time between probes that also read tccd's log (real prober only).
 * @param {number} [options.noticeMs] - inactivity before the card is due in a floating panel (0: never).
 * @param {number} [options.noticeAt] - a fixed time the card is due instead (`/system-permissions add`: at once).
 * @param {number} [options.paneDelayMs] - after a trigger, before the pane opens (the trigger adds the row).
 * @param {AbortSignal} [options.signal]
 * @param {() => number} [options.now]
 * @param {(snapshot: object) => void} [options.onChange]
 * @param {{ info: Function, warn: Function }} [options.logger]
 */
export function createSeek(options) {
  const { classes, prober } = options
  const pollMs = options.pollMs ?? 1500
  const refineMs = options.refineMs ?? 5000
  const noticeMs = options.noticeMs ?? 60_000
  const paneDelayMs = options.paneDelayMs ?? 500
  const now = options.now ?? Date.now
  const signal = options.signal
  const logger = options.logger

  const startedAt = now()
  let subject = {}
  let lastActivity = startedAt
  let lastRefine = 0
  let finishedAt
  let cancelled = false
  /** @type {Map<string, { stop: () => void }>} */
  const triggers = new Map()
  const rows = classes.map(cls => ({
    id: cls.id, name: cls.name, ...cls.justification !== undefined ? { justification: cls.justification } : {},
    state: 'checking', status: 'unknown', grants: 0, opened: 0, triggered: 0,
  }))
  const byId = new Map(rows.map((row, index) => [row.id, { row, cls: classes[index] }]))

  let wakeUp = () => {}
  const wake = () => wakeUp()
  const cls = row => byId.get(row.id).cls

  function snapshot() {
    const granting = rows.some(r => r.state === 'granting')
    const pending = rows.some(r => r.state === 'pending')
    return {
      subject: { ...subject },
      startedAt,
      finishedAt: finishedAt ?? null,
      noticeAt: finishedAt === undefined && (pending || granting) && (options.noticeAt !== undefined || noticeMs > 0)
        ? options.noticeAt ?? lastActivity + noticeMs
        : null,
      noticeMs,
      rows: rows.map(r => ({ ...r })),
    }
  }

  function changed() {
    try { options.onChange?.(snapshot()) } catch { /* an observer never breaks the call */ }
  }

  function stopTrigger(id) {
    const trigger = triggers.get(id)
    if (trigger === undefined) return
    triggers.delete(id)
    try { trigger.stop() } catch { /* already gone */ }
  }

  async function probe(list, refine) {
    try {
      const answer = await prober.probe(list, { refine })
      if (answer.subject && typeof answer.subject === 'object') subject = answer.subject
      return answer.results ?? {}
    } catch (error) {
      logger?.warn(`tool-system-permissions: probe failed: ${error instanceof Error ? error.message : String(error)}`)
      return {}
    }
  }

  /** The user's Grant: macOS's dialog, or the pane (and Finder); then poll. */
  function grant(id) {
    const entry = byId.get(id)
    if (entry === undefined || !OPEN.has(entry.row.state) || finishedAt !== undefined) return false
    const { row, cls } = entry
    row.state = 'granting'
    row.grantingSince ??= now()
    row.grants += 1
    lastActivity = now()
    stopTrigger(id)
    logger?.info(`tool-system-permissions: grant ${id} (${row.status})`)
    // A stale entry is removed first (exactly this service, exactly the server host's id), so that
    // the trigger adds a fresh one; the user never has to find it and press −.
    if (row.status === 'stale' && typeof prober.resetStale === 'function' && row.staleReset !== 'removed') {
      void Promise.resolve()
        .then(() => prober.resetStale(cls, { subject }))
        .catch(error => ({ ok: false, error: error instanceof Error ? error.message : String(error) }))
        .then((result) => {
          row.staleReset = result.ok ? 'removed' : 'failed'
          if (result.command) row.resetCommand = result.command.join(' ')
          if (result.ok) { row.status = 'not-determined'; row.resetAt = now() }
          if (row.state === 'granting' && finishedAt === undefined) ask(row, cls)
          changed()
        })
    } else ask(row, cls)
    changed()
    wake()
    return true
  }

  /**
   * One window in front of the person: macOS's own dialog or alert for the
   * first Grant on a never-asked 'dialog' or 'alert' row (an Automation
   * target not running counts: it is launched and asked), else the pane, with
   * the app in Finder for an 'alert' class while it is still not listed. A
   * later Grant opens the pane (the dialog did not come, or was dismissed);
   * a 'dialog' class is asked again with it, an 'alert' class is not (its
   * alert would only lead to the same pane).
   */
  function ask(row, cls) {
    // A switched-off row (denied) needs only the pane, where a trigger would show nothing.
    const asking = row.status !== 'denied' && row.status !== 'granted'
    const neverAsked = ['not-determined', 'not-granted', 'unknown'].includes(row.status)
    const fire = asking && (cls.grant === 'dialog' || (cls.grant === 'alert' && row.grants === 1 && neverAsked))
    if (fire) {
      try { triggers.set(row.id, prober.trigger(cls, { status: row.status, subject })) } catch (error) { logger?.warn(`tool-system-permissions: trigger ${row.id}: ${error instanceof Error ? error.message : String(error)}`) }
      row.triggered += 1
      if (row.grants === 1 && (row.status === 'not-determined' || row.status === 'not-running'
        || (cls.grant === 'alert' && (row.status === 'not-granted' || row.status === 'unknown')))) {
        row.askedStatus = row.status
        return
      }
    }
    // Screen Recording and Input Monitoring: if the alert did not list the app, the pane and the app
    // in Finder to drag in, while the probe says it is not listed.
    const reveal = cls.grant === 'alert' && ['not-determined', 'not-granted', 'unknown'].includes(row.status)
    row.opened += 1
    if (reveal) row.revealed = (row.revealed ?? 0) + 1
    const open = () => { void Promise.resolve().then(() => prober.openPane(cls, { subject, reveal })).catch(() => {}) }
    if (fire && paneDelayMs > 0) setTimeout(open, paneDelayMs).unref?.()
    else open()
  }

  /** The user's Deny: this permission is explicitly not granted. */
  function deny(id) {
    const entry = byId.get(id)
    if (entry === undefined || !OPEN.has(entry.row.state) || finishedAt !== undefined) return false
    entry.row.state = 'denied'
    entry.row.deniedIn = 'card'
    entry.row.deniedAt = now()
    stopTrigger(id)
    lastActivity = now()
    logger?.info(`tool-system-permissions: deny ${id}`)
    changed()
    wake()
    return true
  }

  function pause(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms)
      timer.unref?.()
      function done() {
        clearTimeout(timer)
        signal?.removeEventListener('abort', done)
        wakeUp = () => {}
        resolve()
      }
      wakeUp = done
      signal?.addEventListener('abort', done, { once: true })
    })
  }

  function cancel() {
    cancelled = true
    for (const row of rows) if (OPEN.has(row.state) || row.state === 'checking') row.state = 'cancelled'
    for (const id of [...triggers.keys()]) stopTrigger(id)
    finishedAt = now()
    changed()
    return new SeekError('tool call aborted', TOOL_ABORTED)
  }

  /**
   * Take a probe's answers. An unrefined "no" (a bare not-granted, or a
   * not-determined) never replaces what a refined probe found (denied,
   * not-determined, stale), so the status does not flicker between polls.
   */
  function apply(results, refined) {
    for (const row of rows) {
      if (!OPEN.has(row.state) && row.state !== 'checking') continue
      const result = results[row.id]
      if (result === undefined || typeof result.status !== 'string') continue
      const before = row.state
      const vague = result.status === 'not-granted' || result.status === 'not-determined'
      // tccd's log is read a few seconds back: a stale line from before a reset is not news.
      const echo = result.status === 'stale' && row.resetAt !== undefined && now() - row.resetAt < 5000
      const keep = echo || (!refined && vague && (result.status === 'not-granted' ? row.status !== 'unknown' : row.status === 'stale'))
      if (!keep && result.status !== row.status) {
        lastActivity = now()
        row.status = result.status
      }
      // An Automation target launched for its dialog: the dialog's question is the not-determined one.
      if (row.askedStatus === 'not-running' && row.status === 'not-determined') row.askedStatus = 'not-determined'
      if (row.state === 'granting' && cls(row).grant === 'dialog' && row.askedStatus === 'not-determined' && row.status === 'denied') {
        // Don't Allow in macOS's own dialog: the only writer of that refusal is the dialog we raised.
        row.state = 'denied'
        row.deniedIn = 'prompt'
        row.deniedAt = now()
        stopTrigger(row.id)
        logger?.info(`tool-system-permissions: ${row.id} denied in macOS's dialog`)
      } else if (result.status === 'granted') {
        row.state = 'granted'
        if (before === 'checking') row.already = true
        else row.grantedAt = now()
        stopTrigger(row.id)
      } else if (UNATTAINABLE.has(result.status)) {
        row.state = 'unavailable'
        stopTrigger(row.id)
      } else if (before === 'checking') {
        row.state = 'pending'
      }
      if (row.state !== before) lastActivity = now()
    }
  }

  async function run() {
    if (signal?.aborted) throw cancel()
    apply(await probe(classes, true), true)
    for (const row of rows) if (row.state === 'checking') row.state = 'pending'
    lastRefine = now()
    lastActivity = now()
    changed()
    while (rows.some(r => OPEN.has(r.state))) {
      await pause(pollMs)
      if (signal?.aborted) throw cancel()
      const open = rows.filter(r => OPEN.has(r.state))
      if (open.length === 0) break
      const refine = open.some(r => r.state === 'granting') && now() - lastRefine >= refineMs
      if (refine) lastRefine = now()
      const results = await probe(open.map(r => byId.get(r.id).cls), refine)
      if (signal?.aborted) throw cancel()
      const before = JSON.stringify(rows)
      apply(results, refine)
      if (JSON.stringify(rows) !== before) changed()
    }
    for (const id of [...triggers.keys()]) stopTrigger(id)
    finishedAt = now()
    changed()
    return valueOf()
  }

  function valueOf() {
    const allGranted = rows.every(r => r.state === 'granted')
    return {
      outcome: allGranted ? 'granted' : 'not-granted',
      platform: 'darwin',
      subject: subjectValue(subject),
      waitedSeconds: Math.round(((finishedAt ?? now()) - startedAt) / 100) / 10,
      permissions: rows.map(r => rowValue(r)),
    }
  }

  return {
    run, grant, deny, snapshot,
    get finished() { return finishedAt !== undefined },
    get cancelled() { return cancelled },
    has: id => byId.has(id),
  }
}

/** The subject as the value carries it: strings only. */
export function subjectValue(subject) {
  const out = {}
  for (const key of ['name', 'bundleId', 'app']) if (typeof subject?.[key] === 'string' && subject[key] !== '') out[key] = subject[key]
  return out
}

function rowValue(row) {
  const out = { id: row.id, name: row.name, state: row.state, status: row.status }
  if (row.justification !== undefined) out.justification = row.justification
  if (row.deniedIn !== undefined) out.deniedIn = row.deniedIn
  if (row.already) out.already = true
  if (row.staleReset !== undefined) out.staleReset = row.staleReset
  if (row.resetCommand !== undefined) out.resetCommand = row.resetCommand
  if (row.grantedAt !== undefined && row.grantingSince !== undefined) out.waitedSeconds = Math.round((row.grantedAt - row.grantingSince) / 100) / 10
  return out
}

/**
 * Running and finished calls, keyed by tool call id, for the routes.
 * @param {{ load?: () => any[], save?: (entries: any[]) => void, limit?: number }} [store]
 */
export function createRegistry(store = {}) {
  const limit = store.limit ?? 200
  /** @type {Map<string, { sessionIds: string[], seek: ReturnType<typeof createSeek> }>} */
  const running = new Map()
  /** @type {Map<string, { sessionIds: string[], snapshot: object, value?: object }>} */
  const finished = new Map()
  try {
    for (const entry of store.load?.() ?? []) {
      if (entry && typeof entry.callId === 'string' && Array.isArray(entry.sessionIds) && entry.snapshot) finished.set(entry.callId, { sessionIds: entry.sessionIds, snapshot: entry.snapshot })
    }
  } catch { /* a broken record is dropped */ }

  function persist() {
    while (finished.size > limit) finished.delete(finished.keys().next().value)
    try { store.save?.([...finished].map(([callId, entry]) => ({ callId, sessionIds: entry.sessionIds, snapshot: entry.snapshot }))) } catch { /* best effort */ }
  }

  return {
    track(callId, sessionIds, seek) {
      running.set(callId, { sessionIds, seek })
      return {
        done() {
          running.delete(callId)
          finished.delete(callId)
          finished.set(callId, { sessionIds, snapshot: seek.snapshot() })
          persist()
        },
      }
    },
    /** The running calls: `{ callId, sessionIds, snapshot }`, oldest first. */
    running() {
      return [...running].map(([callId, live]) => ({ callId, sessionIds: live.sessionIds, snapshot: live.seek.snapshot() }))
    },
    /** `{ running, sessionIds, snapshot }` or undefined. */
    get(callId) {
      const live = running.get(callId)
      if (live !== undefined) return { running: true, sessionIds: live.sessionIds, snapshot: live.seek.snapshot() }
      const done = finished.get(callId)
      return done === undefined ? undefined : { running: false, sessionIds: done.sessionIds, snapshot: done.snapshot }
    },
    /** Grant or Deny on a running call: true when it changed something. */
    act(callId, action, id) {
      const live = running.get(callId)
      if (live === undefined) return false
      return action === 'grant' ? live.seek.grant(id) : live.seek.deny(id)
    },
    get size() { return running.size },
  }
}

/** Session ids an execution belongs to (the agent's session id, and its id), for authorizing the card's clicks. */
export function sessionIdsOf(exec) {
  const ids = new Set()
  const agent = exec?.agent
  for (const candidate of [agent?.session?.id, agent?.id]) if (typeof candidate === 'string' && candidate !== '') ids.add(candidate)
  return [...ids]
}

/** The model's text for a settled call. */
export function renderResult(value, classes) {
  if (value.outcome === 'not-applicable') {
    return `Not applicable: this server runs on ${value.platform}, not macOS, so there are no macOS privacy permissions to grant. Carry on without them.`
  }
  const app = value.subject?.name ?? 'the DeepSea server host'
  const who = value.subject?.bundleId ? `"${app}" (${value.subject.bundleId})` : `"${app}"`
  const lines = []
  const byId = new Map((classes ?? []).map(c => [c.id, c]))
  const granted = value.permissions.filter(p => p.state === 'granted')
  const missing = value.permissions.filter(p => p.state !== 'granted')
  if (missing.length === 0 && granted.every(p => p.already)) {
    lines.push(`All granted already: ${granted.map(p => p.name).join(', ')}. macOS charges your commands to ${who}; it holds these permissions.`)
    return lines.join('\n')
  }
  lines.push(`macOS charges your commands to ${who}. Permissions:`)
  for (const p of value.permissions) {
    const cls = byId.get(p.id)
    const reset = p.staleReset === 'removed'
      ? ` Removed a stale grant for it first (\`${p.resetCommand ?? 'tccutil reset'}\`).`
      : p.staleReset === 'failed'
        ? ` Could not remove its stale entry${p.resetCommand ? ` (\`${p.resetCommand}\` failed)` : ''}${cls ? `: ${instructions(cls, 'stale', app)}` : '.'}`
        : ''
    switch (p.state) {
      case 'granted':
        lines.push(`- ${p.name}: granted${p.already ? ' (already)' : p.waitedSeconds !== undefined ? ` (after ${formatSeconds(p.waitedSeconds)})` : ''}.${reset}`)
        break
      case 'denied':
        lines.push(`- ${p.name}: NOT granted: ${p.deniedIn === 'prompt' ? 'the user denied it in macOS\'s own dialog (Don\'t Allow).' : 'the user pressed Deny.'}${reset}${p.status === 'stale' && cls && p.staleReset === undefined ? ` (It has a stale entry: ${instructions(cls, 'stale', app)})` : ''}`)
        break
      case 'unavailable':
        lines.push(`- ${p.name}: NOT granted: ${cls ? instructions(cls, p.status, app) : p.status}`)
        break
      default:
        lines.push(`- ${p.name}: NOT granted (${p.state}).${reset}`)
    }
  }
  if (missing.length > 0) {
    lines.push(`Not granted: ${missing.map(p => p.id).join(', ')}. Do not try what needs ${missing.length === 1 ? 'it' : 'them'} and do not call ${TOOL_NAME} for ${missing.length === 1 ? 'it' : 'them'} again unless the user asks; tell the user what you cannot do without ${missing.length === 1 ? 'it' : 'them'}.`)
  }
  if (granted.some(p => !p.already)) {
    lines.push('The grants hold for every command you start from now on (the check ran in a fresh process, as your commands do); the DeepSea server does not need restarting. A program that was already running before the grant may need restarting.')
    if (granted.some(p => !p.already && p.id === 'full-disk-access')) lines.push('Full Disk Access: your built-in file tools (read, search, write) run inside the long-lived server process and may not see it until the DeepSea server restarts; shell commands see it now.')
  }
  return lines.join('\n')
}

/** Model-facing description of the tool. */
export const DESCRIPTION = 'Make sure macOS privacy permissions are granted to the app your commands run under (this DeepSea server\'s host app), '
  + 'BEFORE the first command that needs one. Which permission: screenshots or screen capture (`screencapture`, ScreenCaptureKit, a window grab) → '
  + '`screen-recording`; driving other apps\' UI, sending clicks or keystrokes, reading UI elements → `accessibility`; recording audio or video → '
  + '`microphone`, `camera`; global keyboard or mouse event taps → `input-monitoring`; reading protected data (Mail, Messages, Safari, other apps\' '
  + 'containers) → `full-disk-access`; `osascript` / AppleScript / JXA telling another app what to do → `automation:<bundle id>` (e.g. '
  + '`automation:com.apple.systemevents`, or `automation:safari`, `automation:finder`). '
  + 'Give each permission a `justification`: one sentence, shown to the user right next to the permission, saying what you will do with it '
  + '("To take screenshots of the prototype."); macOS\'s own dialogs cannot carry it. '
  + 'Returns at once when all are granted. Otherwise the user gets a card with Grant and Deny for each missing one, and the call returns only when '
  + 'every one is granted or denied (minutes, possibly; if nobody acts for a minute, DeepSea brings the card up in a window of its own). '
  + 'Ask before acting, not after a failure: macOS denies the first unpermitted call at once and only shows a notification. '
  + 'Ask for all you will need in one call. Do not ask again for a denied permission unless the user asks. On a host that is not macOS it returns "not applicable".'

export const PROMPT_HINT = `Before a command that needs a macOS privacy permission (screenshots or screen capture, UI automation, microphone or camera, `
  + `keyboard or mouse monitoring, protected files, AppleScript control of another app), call \`${TOOL_NAME}\` for it first; never retry a capture `
  + 'that failed for lack of permission.'

const ROW_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', required: true },
    name: { type: 'string', required: true },
    state: { type: 'string', enum: ['granted', 'denied', 'unavailable', 'cancelled', 'pending', 'granting', 'checking', 'not-applicable'], required: true },
    status: { type: 'string', required: true },
    already: { type: 'boolean' },
    waitedSeconds: { type: 'number' },
    staleReset: { type: 'string', enum: ['removed', 'failed'] },
    justification: { type: 'string' },
    deniedIn: { type: 'string', enum: ['card', 'prompt'] },
    resetCommand: { type: 'string' },
  },
  additionalProperties: false,
}

/**
 * The tool definition.
 * @param {object} deps
 * @param {() => { prober?: object, registry?: ReturnType<typeof createRegistry> } | undefined} deps.service - the root's service, read per call.
 * @param {() => object} deps.fallbackProber - the prober when no root row runs.
 * @param {() => { pollMs: number, refineMs: number, noticeMs: number, paneDelayMs?: number }} deps.settings
 * @param {string} [deps.platform] - process.platform, for tests.
 * @param {{ info: Function, warn: Function }} [deps.logger]
 */
export function createSeekTool(deps) {
  const platform = deps.platform ?? process.platform
  return defineTool({
    name: TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      permissions: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          properties: {
            permission: { type: 'string', required: true, description: 'screen-recording, accessibility, microphone, camera, input-monitoring, full-disk-access, or automation:<bundle id>.' },
            justification: { type: 'string', required: true, description: `One sentence (at most ${JUSTIFICATION_MAX} characters, no line breaks) shown to the user next to the permission: what you will do with it.` },
          },
          additionalProperties: false,
        },
        description: 'The permissions to make sure of, each with its justification.',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          outcome: { type: 'string', enum: ['granted', 'not-granted', 'not-applicable'], required: true },
          platform: { type: 'string', required: true },
          subject: { type: 'object', properties: { name: { type: 'string' }, bundleId: { type: 'string' }, app: { type: 'string' } }, additionalProperties: false, required: true },
          waitedSeconds: { type: 'number', required: true },
          permissions: { type: 'array', items: ROW_SCHEMA, required: true },
        },
        additionalProperties: false,
      },
      render: (args, value) => {
        let classes = []
        try { classes = parsePermissions(args?.permissions) } catch { /* the value carries the names */ }
        return [{ type: 'text', text: renderResult(value, classes) }]
      },
      presentationMeta: (_args, value) => ({ deepsea: META_MARK, ...value }),
    },
    async execute(args, exec) {
      let classes
      try { classes = parsePermissions(args.permissions, { requireJustification: true }) } catch (error) {
        if (error instanceof PermissionNameError) throw new SeekError(error.message, INVALID_PERMISSION)
        throw error
      }
      if (platform !== 'darwin') {
        return {
          outcome: 'not-applicable', platform, subject: {}, waitedSeconds: 0,
          permissions: classes.map(c => ({ id: c.id, name: c.name, justification: c.justification, state: 'not-applicable', status: 'unavailable' })),
        }
      }
      const service = deps.service()
      const prober = service?.prober ?? deps.fallbackProber()
      const settings = deps.settings()
      const seek = createSeek({ classes, prober, ...settings, signal: exec.signal, logger: deps.logger })
      const tracked = service?.registry?.track(String(exec.callId), sessionIdsOf(exec), seek)
      try {
        return await seek.run()
      } finally {
        tracked?.done()
      }
    },
  })
}

export { paneName }
