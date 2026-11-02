/**
 * wait.mjs — the `wait` tool and the registry of its pending calls.
 *
 * Kept free of Cordis so the unit tests can drive it directly: `createWaitRegistry`
 * owns the timers and the two user verdicts (skip / abort), `createWaitTool`
 * builds the `defineTool` definition over a registry.
 *
 * OUTCOMES (what the model receives):
 *   completed  the timeout elapsed — "Waited 10 s."
 *   skipped    the user pressed Skip — returns like a completed wait, early;
 *              the text says so and tells the model to carry on as if the
 *              time had passed (the user saw the thing was already done, or
 *              got impatient).
 *   aborted    the user pressed Abort — an ERROR result (code USER_ABORTED_WAIT,
 *              message starts with "user aborted sleep") so the model stops
 *              and asks instead of waiting again.
 *   (turn cancelled) `exec.signal` aborted — the timer is cleared and the
 *              body throws a WaitError with the registry's own ABORTED code and
 *              message. (The registry only substitutes its canonical ABORTED
 *              result for a SUCCESSFUL body; a body that rejects keeps its own
 *              error, and rejecting with `signal.reason`, a plain object in the
 *              web GUI's cancel path, would render "Error: [object Object]".)
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { HarnessError } from '@deepseek-ai/dsh-llm'

/** Error code of the user's Abort verdict (the client keys its "aborted" rendering on it). */
export const USER_ABORTED_WAIT = 'USER_ABORTED_WAIT'
/** Error code for an invalid `seconds` argument. */
export const INVALID_WAIT = 'INVALID_WAIT'
/** Error code when the plugin unloads while waits are pending. */
export const WAIT_UNLOADED = 'WAIT_UNLOADED'
/** The registry's canonical cancellation code (dsh-tools TOOL_ABORTED), reused for a cancelled turn. */
export const TOOL_ABORTED = 'ABORTED'

/** Model-facing failure of the wait tool (a HarnessError so `code` reaches `result.error`). */
export class WaitError extends HarnessError {
  /**
   * @param {string} message
   * @param {string} code
   */
  constructor(message, code) {
    super(message, code)
    this.name = 'WaitError'
  }
}

/** `2.3 s`, `10 s`, `1 min 30 s`, `2 h 5 min` — human durations for the model text. */
export function formatSeconds(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0
  if (seconds < 60) {
    const rounded = seconds < 10 ? Math.round(seconds * 10) / 10 : Math.round(seconds)
    return `${rounded} s`
  }
  const whole = Math.round(seconds)
  const h = Math.floor(whole / 3600)
  const m = Math.floor((whole % 3600) / 60)
  const s = whole % 60
  const parts = []
  if (h > 0) parts.push(`${h} h`)
  if (m > 0) parts.push(`${m} min`)
  if (s > 0 && h === 0) parts.push(`${s} s`)
  return parts.join(' ')
}

/**
 * Registry of pending waits, keyed by tool call id.
 *
 * @param {{ now?: () => number, setTimeout?: typeof setTimeout, clearTimeout?: typeof clearTimeout }} [clock]
 *   injectable clock for tests.
 */
export function createWaitRegistry(clock = {}) {
  const now = clock.now ?? (() => Date.now())
  const schedule = clock.setTimeout ?? setTimeout
  const unschedule = clock.clearTimeout ?? clearTimeout
  /** @type {Map<string, any>} */
  const pending = new Map()
  /** @type {Set<(entry: any, outcome: string) => void>} */
  const listeners = new Set()

  function notify(entry, outcome) {
    for (const listener of listeners) {
      try { listener(entry, outcome) } catch { /* observers never break a wait */ }
    }
  }

  /**
   * Start one wait. Resolves with `{ outcome: 'completed' | 'skipped', startedAt, endedAt }`,
   * rejects with a WaitError (user abort / turn cancelled / unload).
   * @param {{ callId: string, sessionIds: string[], requestedMs: number, reason: string, signal?: AbortSignal }} spec
   */
  function start(spec) {
    if (pending.has(spec.callId)) throw new WaitError(`a wait for call ${spec.callId} is already pending`, INVALID_WAIT)
    const startedAt = now()
    const entry = {
      callId: spec.callId,
      sessionIds: spec.sessionIds,
      reason: spec.reason,
      requestedMs: spec.requestedMs,
      startedAt,
      deadline: startedAt + spec.requestedMs,
      timer: undefined,
      settled: false,
      settle: /** @type {(outcome: string, error?: unknown) => void} */ (() => {}),
    }
    const promise = new Promise((resolve, reject) => {
      entry.settle = (outcome, error) => {
        if (entry.settled) return
        entry.settled = true
        unschedule(entry.timer)
        spec.signal?.removeEventListener('abort', onSignal)
        pending.delete(entry.callId)
        const endedAt = now()
        notify(entry, outcome)
        if (outcome === 'completed' || outcome === 'skipped') resolve({ outcome, startedAt, endedAt })
        else reject(error)
      }
    })
    const onSignal = () => entry.settle('cancelled', new WaitError('tool call aborted', TOOL_ABORTED))
    if (spec.signal?.aborted) {
      // Never start a timer for a call that is already cancelled.
      pending.set(entry.callId, entry)
      onSignal()
      return promise
    }
    spec.signal?.addEventListener('abort', onSignal, { once: true })
    entry.timer = schedule(() => entry.settle('completed'), spec.requestedMs)
    // Do not keep the process alive for a pending wait (tests, unload).
    if (typeof entry.timer === 'object' && entry.timer !== null && 'unref' in entry.timer) entry.timer.unref?.()
    pending.set(entry.callId, entry)
    return promise
  }

  /** Public snapshot of one pending wait, or undefined. */
  function get(callId) {
    const entry = pending.get(callId)
    if (entry === undefined) return undefined
    return { callId: entry.callId, sessionIds: entry.sessionIds, reason: entry.reason, requestedMs: entry.requestedMs, startedAt: entry.startedAt, deadline: entry.deadline }
  }

  /** The user's Skip: settles like a completed wait, now. */
  function skip(callId) {
    const entry = pending.get(callId)
    if (entry === undefined) return false
    entry.settle('skipped')
    return true
  }

  /** The user's Abort: settles as an error the model must not simply retry. */
  function abort(callId) {
    const entry = pending.get(callId)
    if (entry === undefined) return false
    const elapsed = (now() - entry.startedAt) / 1000
    entry.settle('aborted', new WaitError(
      `user aborted sleep: the user pressed Abort after ${formatSeconds(elapsed)} of the requested ${formatSeconds(entry.requestedMs / 1000)} wait`
        + (entry.reason !== '' ? ` (${entry.reason})` : '')
        + '. Do not start another wait; ask the user what they want to do instead.',
      USER_ABORTED_WAIT,
    ))
    return true
  }

  /** Plugin unload: fail every pending wait so no tool call hangs forever. */
  function disposeAll() {
    for (const entry of [...pending.values()]) {
      entry.settle('unloaded', new WaitError('the wait tool was unloaded while this wait was pending; the time did not necessarily elapse', WAIT_UNLOADED))
    }
  }

  /** Observe settlements (`(entry, outcome)`); returns the disposer. */
  function onSettle(listener) {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }

  return { start, get, skip, abort, disposeAll, onSettle, get size() { return pending.size } }
}

/**
 * Session ids an execution belongs to, for authorizing a browser verdict. The
 * chat renders a tool call in the session whose log holds it: the agent's
 * session id (also `agent.id`, which is the same value for a root agent).
 * @param {any} exec - ToolRunContext.
 * @returns {string[]}
 */
export function sessionIdsOf(exec) {
  const ids = new Set()
  const agent = exec?.agent
  if (agent === undefined || agent === null) return []
  for (const candidate of [agent.session?.id, agent.id]) {
    if (typeof candidate === 'string' && candidate !== '') ids.add(candidate)
  }
  return [...ids]
}

/** Model-facing text for a settled wait. */
export function renderWait(args, value) {
  const requested = formatSeconds(typeof args?.seconds === 'number' ? args.seconds : value.requestedSeconds)
  if (value.outcome === 'skipped') {
    return `Wait skipped by the user after ${formatSeconds(value.waitedSeconds)} of the requested ${requested}. `
      + 'Treat this exactly like the timeout having elapsed and carry on (the user either saw that what you were waiting for is already done, or did not want to wait).'
  }
  return `Waited ${requested}.`
}

/**
 * Build the `wait` tool definition over a registry.
 * @param {ReturnType<typeof createWaitRegistry>} registry
 * @param {{ maxSeconds: number }} options
 */
export function createWaitTool(registry, options) {
  const maxSeconds = options.maxSeconds
  return defineTool({
    name: 'wait',
    description:
      'Pause for a fixed time, then return. Use this INSTEAD of bash `sleep N` (or `sleep N; echo done`) whenever you need to '
      + 'let time pass — a server coming up, a build finishing, a file appearing, polling backoff. The user sees a live '
      + `progress bar for the wait and can end it early: "Skip" returns normally as if the time had elapsed, "Abort" fails `
      + 'the call with "user aborted sleep" (then stop and ask the user rather than waiting again). '
      + `Maximum ${maxSeconds} seconds per call; for longer waits call it again.`,
    parameters: {
      seconds: { type: 'number', required: true, description: `How long to wait, in seconds (0 < seconds <= ${maxSeconds}; fractions allowed).` },
      reason: { type: 'string', description: 'What you are waiting for, in a few words (shown to the user next to the progress bar), e.g. "dev server to come up".' },
    },
    output: {
      schema: {
        type: 'object',
        // Author DSL: requiredness is per property (`required: true`), not a `required` array.
        properties: {
          outcome: { type: 'string', enum: ['completed', 'skipped'], required: true },
          requestedSeconds: { type: 'number', required: true },
          waitedSeconds: { type: 'number', required: true },
          startedAt: { type: 'number', required: true, description: 'Unix epoch ms when the wait began.' },
          endedAt: { type: 'number', required: true, description: 'Unix epoch ms when it settled.' },
        },
        additionalProperties: false,
      },
      render: (args, value) => [{ type: 'text', text: renderWait(args, value) }],
      // Replayable presentation for the chat row (mirrors the value; the client narrows it).
      presentationMeta: (_args, value) => ({ deepsea: 'wait', ...value }),
    },
    // Waiting mutates nothing; it may overlap with sibling calls of the same batch.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const seconds = args.seconds
      if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
        throw new WaitError('seconds must be a positive finite number', INVALID_WAIT)
      }
      if (seconds > maxSeconds) {
        throw new WaitError(`seconds must be at most ${maxSeconds} (requested ${seconds}); call wait again for longer periods`, INVALID_WAIT)
      }
      const reason = typeof args.reason === 'string' ? args.reason.trim().slice(0, 200) : ''
      const settled = await registry.start({
        callId: String(exec.callId),
        sessionIds: sessionIdsOf(exec),
        requestedMs: Math.round(seconds * 1000),
        reason,
        signal: exec.signal,
      })
      return {
        outcome: settled.outcome,
        requestedSeconds: seconds,
        waitedSeconds: Math.round((settled.endedAt - settled.startedAt)) / 1000,
        startedAt: settled.startedAt,
        endedAt: settled.endedAt,
      }
    },
  })
}
