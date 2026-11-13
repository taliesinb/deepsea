/**
 * fake.mjs — the test prober (root config `fakeStateFile`): it never runs
 * osascript, never asks macOS for anything and never opens System Settings.
 * Each probe reads the state file again, so a test flips a permission by
 * rewriting it:
 *
 *   { "subject": { "name": "DeepSea Test Server", "bundleId": "…" },
 *     "states": { "screen-recording": "granted", "microphone": "stale" } }
 *
 * A class the file does not name is "not-determined"; a missing or broken
 * file counts as empty. Triggers, pane openings and stale-entry resets are
 * only recorded (the `events` list, also logged; a reset with the exact
 * `tccutil` argv the real prober would run), so a test can see that Grant
 * reached them. After a reset, a class the file still calls "stale" reads
 * as not-determined, as it would once its entry is gone.
 */

import { readFileSync } from 'node:fs'
import { resetCommand } from './macos.mjs'
import { paneUrl, STATUSES } from './permissions.mjs'

export const FAKE_SUBJECT = Object.freeze({ name: 'DeepSea Test Server', bundleId: 'io.github.taliesinb.deepsea.test.server' })

/**
 * @param {string} file - the state file.
 * @param {{ logger?: { info: (m: string) => void }, now?: () => number }} [deps]
 */
export function createFakeProber(file, deps = {}) {
  const now = deps.now ?? Date.now
  /** @type {{ at: number, kind: 'trigger' | 'open' | 'reset', id: string, url?: string, command?: string[] }[]} */
  const events = []
  /** Classes reset while the file still says "stale": they read as not-determined until the file says otherwise. */
  const resetWhileStale = new Set()

  function read() {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      return parsed !== null && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }

  function record(kind, cls, extra = {}) {
    events.push({ at: now(), kind, id: cls.id, ...extra })
    if (events.length > 500) events.splice(0, events.length - 500)
    deps.logger?.info(`tool-system-permissions (fake): ${kind} ${cls.id}${extra.url ? ` ${extra.url}` : ''}${extra.command ? ` (would run: ${extra.command.join(' ')})` : ''}`)
  }

  async function probe(classes) {
    const state = read()
    const states = state.states !== null && typeof state.states === 'object' ? state.states : {}
    const results = {}
    for (const cls of classes) {
      let status = states[cls.id]
      if (status !== 'stale') resetWhileStale.delete(cls.id)
      else if (resetWhileStale.has(cls.id)) status = 'not-determined'
      results[cls.id] = { status: STATUSES.includes(status) ? status : 'not-determined' }
    }
    const subject = state.subject !== null && typeof state.subject === 'object' ? { ...FAKE_SUBJECT, ...state.subject } : { ...FAKE_SUBJECT }
    return { subject, results }
  }

  function trigger(cls) {
    record('trigger', cls)
    return { stop() {} }
  }

  async function openPane(cls, { reveal = false } = {}) {
    record('open', cls, { url: paneUrl(cls) })
    if (reveal) record('reveal', cls)
  }

  /** Records the exact `tccutil` command the real prober would run, and runs nothing. */
  async function resetStale(cls, { subject } = {}) {
    const command = resetCommand(cls, subject)
    if (command === undefined) return { ok: false, error: `not a DeepSea server host: ${subject?.bundleId ?? 'unknown app'}` }
    record('reset', cls, { command })
    resetWhileStale.add(cls.id)
    return { ok: true, command }
  }

  return { kind: 'fake', file, events, probe, trigger, openPane, resetStale }
}
