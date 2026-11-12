// Job waits: upstream tool-jobs announces each `job_output` wait on
// `tool-jobs/wait-started` (harness topic job-wait-release); the root row's
// status route answers for it and its control route skips it through `release`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONTROL_PATH, Config, JOB_WAIT_EVENT, STATUS_PATH, apply } from '../index.js'
import { SKIP_DETAIL, createJobWaitTracker } from '../job-wait.mjs'
import { fakeCtx } from './fake-ctx.mjs'

/** A JobOutputWait as tool-jobs announces it; `released` records release calls. */
function fakeWait(callId, sessionId = 'session-1') {
  let end
  const ended = new Promise(resolve => { end = resolve })
  const wait = {
    callId, agent: { id: sessionId, session: { id: sessionId } }, jobId: `job-${callId}`,
    startedAt: 1_000, deadline: 151_000, ended, released: [], open: true,
    release(detail) {
      if (!wait.open) return false
      wait.open = false
      wait.released.push(detail)
      end()
      return true
    },
    end() { wait.open = false; end() },
  }
  return wait
}

const status = (ctx, callId, sessionId) => ctx.routes.get(STATUS_PATH).fetch(new Request(`http://x${STATUS_PATH}?callId=${callId}&sessionId=${sessionId}`))
const control = (ctx, body) => ctx.routes.get(CONTROL_PATH).fetch(new Request(`http://x${CONTROL_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
const tick = () => new Promise(resolve => setImmediate(resolve))

test('the tracker keeps a wait until it ends, and skips with the detail', async () => {
  const tracker = createJobWaitTracker()
  const a = fakeWait('a')
  const b = fakeWait('b', 'session-2')
  tracker.track(a)
  tracker.track(b)
  assert.deepEqual(tracker.get('a'), { callId: 'a', jobId: 'job-a', startedAt: 1_000, deadline: 151_000, sessionIds: ['session-1'] })
  assert.deepEqual(tracker.get('b').sessionIds, ['session-2'])
  b.end()
  await tick()
  assert.equal(tracker.get('b'), undefined)
  assert.equal(tracker.skip('a'), true)
  assert.deepEqual(a.released, [SKIP_DETAIL])
  assert.equal(tracker.skip('a'), false)
  assert.equal(tracker.size, 0)
})

test('routes: status answers for an announced wait of its session and Skip releases it; Abort is refused', async () => {
  const ctx = fakeCtx()
  apply(ctx, Config({}))
  const wait = fakeWait('d')
  assert.equal((await status(ctx, 'd', 'session-1')).status, 404)
  ctx.emit(JOB_WAIT_EVENT, wait)
  const pending = await (await status(ctx, 'd', 'session-1')).json()
  assert.equal(typeof pending.now, 'number')
  assert.deepEqual({ ...pending, now: 0 }, { pending: true, job: true, jobId: 'job-d', startedAt: 1_000, deadline: 151_000, requestedMs: 150_000, now: 0 })
  assert.equal((await status(ctx, 'd', 'session-2')).status, 403)
  assert.equal((await control(ctx, { action: 'skip', callId: 'd', sessionId: 'session-2' })).status, 403)
  assert.equal((await control(ctx, { action: 'abort', callId: 'd', sessionId: 'session-1' })).status, 400)
  const ok = await control(ctx, { action: 'skip', callId: 'd', sessionId: 'session-1' })
  assert.deepEqual(await ok.json(), { ok: true, action: 'skip' })
  assert.deepEqual(wait.released, [SKIP_DETAIL])
  assert.equal((await control(ctx, { action: 'skip', callId: 'd', sessionId: 'session-1' })).status, 404)
  assert.equal((await status(ctx, 'd', 'session-1')).status, 404)
  // Unloading the row stops listening; a later announcement is not kept.
  ctx.dispose()
  ctx.emit(JOB_WAIT_EVENT, fakeWait('e'))
})
