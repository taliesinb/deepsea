/**
 * job-wait.mjs — the running `job_output` waits the browser can show and skip.
 *
 * Upstream's tool-jobs announces each `job_output` wait on a running job on the
 * Cordis event `tool-jobs/wait-started` (harness topic `job-wait-release`) with a
 * `JobOutputWait`: `{ callId, agent, jobId, startedAt, deadline, ended,
 * release(detail?) }`. The root row keeps them here, keyed by call id, until
 * `ended` resolves; Skip calls `release`, which ends the wait as on timeout and
 * leaves the job running.
 *
 * Kept free of Cordis so the unit tests can drive it with fake waits.
 */

import { sessionIdsOf } from './wait.mjs'

/** Status detail the model reads after a Skip: `[status: running, wait skipped by the user]`. */
export const SKIP_DETAIL = 'wait skipped by the user'

/** Registry of announced `job_output` waits. */
export function createJobWaitTracker() {
  /** @type {Map<string, { wait: any, sessionIds: string[] }>} */
  const waits = new Map()

  /**
   * Keep one announced wait until it ends.
   * @param {any} wait - a JobOutputWait.
   */
  function track(wait) {
    const callId = String(wait.callId)
    const entry = { wait, sessionIds: sessionIdsOf({ agent: wait.agent }) }
    waits.set(callId, entry)
    void Promise.resolve(wait.ended).then(() => {
      if (waits.get(callId) === entry) waits.delete(callId)
    })
  }

  /**
   * The running wait of a call, or undefined.
   * @param {string} callId
   * @returns {{ callId: string, jobId: string, startedAt: number, deadline: number, sessionIds: string[] } | undefined}
   */
  function get(callId) {
    const entry = waits.get(callId)
    if (entry === undefined) return undefined
    const { wait, sessionIds } = entry
    return { callId, jobId: String(wait.jobId), startedAt: wait.startedAt, deadline: wait.deadline, sessionIds }
  }

  /**
   * The person's Skip: end the wait as on timeout; the job keeps running.
   * @param {string} callId
   * @returns {boolean} false when the wait had already ended.
   */
  function skip(callId) {
    const entry = waits.get(callId)
    if (entry === undefined) return false
    waits.delete(callId)
    return entry.wait.release(SKIP_DETAIL) === true
  }

  return { track, get, skip, get size() { return waits.size } }
}
