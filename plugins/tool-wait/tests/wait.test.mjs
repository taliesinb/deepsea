// Host-half unit tests: the registry's four settlements and the tool definition
// built over it (real timers, tens of milliseconds).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createWaitRegistry, createWaitTool, formatSeconds, renderWait, sessionIdsOf, USER_ABORTED_WAIT, INVALID_WAIT, WAIT_UNLOADED, TOOL_ABORTED } from '../wait.mjs'

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const exec = (callId, extra = {}) => ({ callId, agent: { id: 'agent-1', session: { id: 'session-1' } }, signal: new AbortController().signal, ...extra })

test('a wait completes when its timer elapses', async () => {
  const registry = createWaitRegistry()
  const settled = await registry.start({ callId: 'c1', sessionIds: ['s'], requestedMs: 40, reason: '' })
  assert.equal(settled.outcome, 'completed')
  assert.ok(settled.endedAt - settled.startedAt >= 35)
  assert.equal(registry.size, 0)
})

test('skip settles early like a completed wait', async () => {
  const registry = createWaitRegistry()
  const promise = registry.start({ callId: 'c2', sessionIds: ['s'], requestedMs: 10_000, reason: 'build' })
  assert.deepEqual(registry.get('c2')?.sessionIds, ['s'])
  await sleep(20)
  assert.equal(registry.skip('c2'), true)
  const settled = await promise
  assert.equal(settled.outcome, 'skipped')
  assert.ok(settled.endedAt - settled.startedAt < 5000)
  assert.equal(registry.skip('c2'), false, 'a settled wait cannot be skipped twice')
  assert.equal(registry.get('c2'), undefined)
})

test('abort rejects with the user-aborted error the model must not retry', async () => {
  const registry = createWaitRegistry()
  const promise = registry.start({ callId: 'c3', sessionIds: ['s'], requestedMs: 10_000, reason: 'dev server' })
  assert.equal(registry.abort('c3'), true)
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, USER_ABORTED_WAIT)
    assert.match(error.message, /^user aborted sleep/)
    assert.match(error.message, /dev server/)
    assert.match(error.message, /of the requested 10 s wait/)
    return true
  })
})

test('the caller signal cancels the timer and rejects with the canonical ABORTED code', async () => {
  const registry = createWaitRegistry()
  const controller = new AbortController()
  const promise = registry.start({ callId: 'c4', sessionIds: ['s'], requestedMs: 10_000, reason: '', signal: controller.signal })
  controller.abort({ kind: 'user-cancel' }) // the web GUI aborts with a plain object, not an Error
  await assert.rejects(promise, (error) => error.code === TOOL_ABORTED && error.message === 'tool call aborted')
  assert.equal(registry.size, 0)
})

test('an already-aborted signal never starts a timer', async () => {
  const registry = createWaitRegistry()
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(registry.start({ callId: 'c5', sessionIds: ['s'], requestedMs: 10_000, reason: '', signal: controller.signal }))
  assert.equal(registry.size, 0)
})

test('disposeAll fails every pending wait', async () => {
  const registry = createWaitRegistry()
  const a = registry.start({ callId: 'a', sessionIds: ['s'], requestedMs: 10_000, reason: '' })
  const b = registry.start({ callId: 'b', sessionIds: ['s'], requestedMs: 10_000, reason: '' })
  const outcomes = []
  registry.onSettle((entry, outcome) => outcomes.push(`${entry.callId}:${outcome}`))
  registry.disposeAll()
  for (const p of [a, b]) await assert.rejects(p, (e) => e.code === WAIT_UNLOADED)
  assert.deepEqual(outcomes.sort(), ['a:unloaded', 'b:unloaded'])
})

test('the tool executes through the registry and reports the outcome', async () => {
  const registry = createWaitRegistry()
  const tool = createWaitTool(registry, { maxSeconds: 5 })
  assert.equal(tool.name, 'wait')
  const value = await tool.execute({ seconds: 0.05, reason: 'tests' }, exec('t1'))
  assert.equal(value.outcome, 'completed')
  assert.equal(value.requestedSeconds, 0.05)
  assert.ok(value.waitedSeconds >= 0.04)
  assert.deepEqual(tool.output.render({ seconds: 0.05 }, value), [{ type: 'text', text: 'Waited 0.1 s.' }])
  assert.equal(tool.output.presentationMeta({ seconds: 0.05 }, value).deepsea, 'wait')
  assert.equal(tool.isConcurrencySafe({ seconds: 1 }), true)
})

test('the tool authorizes verdicts by the agent session id', async () => {
  const registry = createWaitRegistry()
  const tool = createWaitTool(registry, { maxSeconds: 60 })
  const running = tool.execute({ seconds: 30 }, exec('t2'))
  await sleep(5)
  assert.deepEqual(registry.get('t2').sessionIds, ['session-1', 'agent-1'])
  registry.skip('t2')
  const value = await running
  assert.equal(value.outcome, 'skipped')
  assert.match(renderWait({ seconds: 30 }, value), /^Wait skipped by the user after 0 s of the requested 30 s/)
})

test('the tool rejects invalid or too-long durations before waiting', async () => {
  const registry = createWaitRegistry()
  const tool = createWaitTool(registry, { maxSeconds: 10 })
  for (const seconds of [0, -1, 11]) {
    await assert.rejects(tool.execute({ seconds }, exec('bad')), (e) => e.code === INVALID_WAIT)
  }
  // defineTool's own argument validation rejects non-finite numbers before the body runs.
  for (const seconds of [Number.NaN, Number.POSITIVE_INFINITY, '5']) {
    await assert.rejects(tool.execute({ seconds }, exec('bad')), (e) => e.code === 'INVALID_ARGS')
  }
  await assert.rejects(tool.execute({}, exec('bad')), (e) => e.code === INVALID_WAIT || e.code === 'INVALID_ARGS')
  assert.equal(registry.size, 0)
})

test('sessionIdsOf tolerates agent-less executions', () => {
  assert.deepEqual(sessionIdsOf({}), [])
  assert.deepEqual(sessionIdsOf({ agent: { id: 'x' } }), ['x'])
  assert.deepEqual(sessionIdsOf({ agent: { id: 'x', session: { id: 'x' } } }), ['x'])
})

test('formatSeconds', () => {
  assert.equal(formatSeconds(2.34), '2.3 s')
  assert.equal(formatSeconds(45.6), '46 s')
  assert.equal(formatSeconds(90), '1 min 30 s')
  assert.equal(formatSeconds(3600), '1 h')
  assert.equal(formatSeconds(7500), '2 h 5 min')
})
