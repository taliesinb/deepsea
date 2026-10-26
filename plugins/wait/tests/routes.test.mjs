// Host half end to end without a server: apply() against a fake context,
// then the tool and the two Fetch routes it registers.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONTROL_PATH, Config, PROMPT_HINT, PROMPT_SECTION, STATUS_PATH, apply, name } from '../index.js'

function fakeCtx() {
  const routes = new Map()
  const tools = new Map()
  const sections = []
  const disposers = []
  const ctx = {
    routes, tools, sections,
    logger: { info() {}, warn() {} },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) },
    tools: { register(tool) { tools.set(tool.name, tool) }, get(toolName) { return tools.get(toolName) } },
    connection: { fetch: { register(route) { routes.set(route.path, route); return async () => { routes.delete(route.path) } } } },
    systemPrompt: { section(section) { sections.push(section) }, getSectionOrder() { return 1000 } },
    inject(_names, callback) { callback(ctx) },
    dispose() { for (const dispose of disposers.splice(0)) dispose() },
  }
  return ctx
}

const exec = (callId) => ({ callId, agent: { id: 'session-1', session: { id: 'session-1' } }, signal: new AbortController().signal })
const status = (ctx, query) => ctx.routes.get(STATUS_PATH).fetch(new Request(`http://x${STATUS_PATH}?${query}`))
const control = (ctx, body, type = 'application/json') => ctx.routes.get(CONTROL_PATH).fetch(new Request(`http://x${CONTROL_PATH}`, { method: 'POST', headers: { 'content-type': type }, body: JSON.stringify(body) }))

test('apply registers the tool, both routes under /api/deepsea-wait and the prompt section', () => {
  const ctx = fakeCtx()
  apply(ctx, Config({}))
  assert.equal(name, 'deepsea-wait')
  assert.ok(ctx.tools.get('wait'))
  assert.deepEqual([...ctx.routes.keys()], ['/api/deepsea-wait/status', '/api/deepsea-wait/control'])
  assert.equal(ctx.sections[0].name, PROMPT_SECTION)
  assert.equal(ctx.sections[0].text({ scope: undefined }), PROMPT_HINT)
  const quiet = fakeCtx()
  apply(quiet, Config({ promptHint: false }))
  assert.equal(quiet.sections.length, 0)
})

test('status and control: session check, JSON only, skip settles the call, then 404', async () => {
  const ctx = fakeCtx()
  apply(ctx, Config({}))
  const running = ctx.tools.get('wait').execute({ seconds: 30, reason: 'tests' }, exec('call-1'))
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

test('abort fails the call with the user-aborted code; unload fails pending waits', async () => {
  const ctx = fakeCtx()
  apply(ctx, Config({}))
  const aborted = ctx.tools.get('wait').execute({ seconds: 30 }, exec('call-2'))
  assert.equal((await control(ctx, { action: 'abort', callId: 'call-2', sessionId: 'session-1' })).status, 200)
  await assert.rejects(aborted, (error) => error.code === 'USER_ABORTED_WAIT')
  const pending = ctx.tools.get('wait').execute({ seconds: 30 }, exec('call-3'))
  await new Promise(resolve => setTimeout(resolve, 5))
  ctx.dispose()
  await assert.rejects(pending, (error) => error.code === 'WAIT_UNLOADED')
})
