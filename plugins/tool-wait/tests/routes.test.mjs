// The package root (row deepsea-tool-wait) without a server: apply() against a
// fake context, then the service it provides and the two Fetch routes over it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONTROL_PATH, Config, SERVICE, STATUS_PATH, apply, inject, name } from '../index.js'
import { createWaitTool } from '../wait.mjs'
import { exec, fakeCtx } from './fake-ctx.mjs'

const status = (ctx, query) => ctx.routes.get(STATUS_PATH).fetch(new Request(`http://x${STATUS_PATH}?${query}`))
const control = (ctx, body, type = 'application/json') => ctx.routes.get(CONTROL_PATH).fetch(new Request(`http://x${CONTROL_PATH}`, { method: 'POST', headers: { 'content-type': type }, body: JSON.stringify(body) }))
/** A wait started in the root's registry, as the tools row starts one. */
const wait = (ctx, seconds, callId, reason) => createWaitTool(ctx.get(SERVICE), { maxSeconds: 3600 }).execute(reason === undefined ? { seconds } : { seconds, reason }, exec(callId))

test('apply provides deepseaWait and registers the two routes under /api/deepsea-wait; no tool, no prompt section', () => {
  const ctx = fakeCtx()
  apply(ctx, Config({ maxSeconds: 10 }))
  assert.equal(name, 'deepsea-tool-wait')
  assert.deepEqual(inject, ['connection'])
  assert.equal(SERVICE, 'deepseaWait')
  assert.equal(typeof ctx.get('deepseaWait').start, 'function')
  assert.deepEqual([...ctx.routes.keys()], ['/api/deepsea-wait/status', '/api/deepsea-wait/control'])
  assert.equal(ctx.tools.get('wait'), undefined)
  assert.equal(ctx.sections.length, 0)
  // A config left on this row from before the split validates and is ignored.
  assert.doesNotThrow(() => Config({ maxSeconds: 10, promptHint: false }))
})

test('status and control: session check, JSON only, skip settles the call, then 404', async () => {
  const ctx = fakeCtx()
  apply(ctx, Config({}))
  const running = wait(ctx, 30, 'call-1', 'tests')
  const pending = await status(ctx, 'callId=call-1&sessionId=session-1')
  assert.equal(pending.status, 200)
  const body = await pending.json()
  assert.equal(body.pending, true)
  assert.equal(body.requestedMs, 30_000)
  assert.equal(body.reason, 'tests')
  assert.equal(typeof body.now, 'number')
  assert.equal((await status(ctx, 'callId=call-1&sessionId=session-2')).status, 403)
  assert.equal((await status(ctx, 'callId=&sessionId=session-1')).status, 400)
  assert.equal((await control(ctx, { action: 'skip', callId: 'call-1', sessionId: 'session-1' }, 'text/plain')).status, 415)
  assert.equal((await control(ctx, { action: 'skip', callId: 'call-1', sessionId: 'session-2' })).status, 403)
  assert.equal((await control(ctx, { action: 'nap', callId: 'call-1', sessionId: 'session-1' })).status, 400)
  const ok = await control(ctx, { action: 'skip', callId: 'call-1', sessionId: 'session-1' })
  assert.deepEqual(await ok.json(), { ok: true, action: 'skip' })
  assert.equal((await running).outcome, 'skipped')
  assert.equal((await status(ctx, 'callId=call-1&sessionId=session-1')).status, 404)
})

test('abort fails the call with the user-aborted code; unload fails pending waits and withdraws the service', async () => {
  const ctx = fakeCtx()
  apply(ctx, Config({}))
  const aborted = wait(ctx, 30, 'call-2')
  assert.equal((await control(ctx, { action: 'abort', callId: 'call-2', sessionId: 'session-1' })).status, 200)
  await assert.rejects(aborted, (error) => error.code === 'USER_ABORTED_WAIT')
  const pending = wait(ctx, 30, 'call-3')
  await new Promise(resolve => setTimeout(resolve, 5))
  ctx.dispose()
  await assert.rejects(pending, (error) => error.code === 'WAIT_UNLOADED')
  assert.equal(ctx.get(SERVICE), undefined)
})
