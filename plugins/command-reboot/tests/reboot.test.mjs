import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RebootController, busySessions, describeBlockers, parseArgs, relayVerdict } from '../reboot.mjs'

const agent = (id, status = 'idle', extra = {}) => ({ id, status, inbox: { nextTurn: [] }, ...extra })

function agentsOf(list, owners = {}) {
  return {
    list: () => list,
    isOwnedBy: (id, owner) => owners[id] === owner.id,
  }
}

test('busySessions: idle agents with nothing in flight are not busy', () => {
  assert.deepEqual(busySessions({ agents: agentsOf([agent('a'), agent('b')]) }), [])
})

test('busySessions: running turn, queued messages, jobs and subagents are the blockers', () => {
  const parent = agent('p', 'running', { inbox: { nextTurn: [{}, {}] } })
  const child = agent('c', 'running')
  const jobs = { list: caller => (caller.id === 'p' ? [{ status: 'running', label: 'pnpm build' }, { status: 'completed', label: 'old' }] : []) }
  const rows = busySessions({ agents: agentsOf([parent, child], { c: 'p' }), jobs })
  assert.deepEqual(rows, [
    { sessionId: 'p', blockers: [{ kind: 'turn' }, { kind: 'queue', count: 2 }, { kind: 'jobs', labels: ['pnpm build'] }, { kind: 'subagents', count: 1, running: 1 }] },
    { sessionId: 'c', parentId: 'p', blockers: [{ kind: 'turn' }] },
  ])
  assert.equal(describeBlockers(rows[0].blockers), 'a turn is running; 2 queued messages; 1 background job (pnpm build); 1 subagent loaded, 1 running')
})

test('parseArgs', () => {
  assert.equal(parseArgs(''), 'status')
  assert.equal(parseArgs('  NOW '), 'now')
  assert.equal(parseArgs(' wait'), 'wait')
  assert.equal(parseArgs(' cancel'), 'cancel')
  assert.match(parseArgs(' later').error, /Unknown argument "later"/)
})

test('relayVerdict: restart only when a relay started this server and still answers', () => {
  assert.equal(relayVerdict({ present: false }).kind, 'quit')
  assert.match(relayVerdict({ present: false }).text, /will not come back up/)
  assert.equal(relayVerdict({ present: true, listening: false }).kind, 'quit')
  assert.deepEqual(relayVerdict({ present: true, listening: true }), { kind: 'restart', text: 'Relay running: the server comes back up on the next connection.' })
})

function controllerWith(busyRef) {
  const fired = []
  const logs = []
  let now = 1000
  let interval
  const controller = new RebootController({
    busy: () => busyRef.value,
    fire: reason => fired.push(reason),
    log: line => logs.push(line),
    now: () => now,
    pollMs: 1000,
    idleGraceMs: 2000,
    setInterval: fn => { interval = fn; return 1 },
    clearInterval: () => { interval = undefined },
  })
  return { controller, fired, logs, advance: ms => { now += ms; interval?.() }, hasTimer: () => interval !== undefined }
}

test('rebootNow fires at once and reports what it interrupts', () => {
  const busy = { value: [{ sessionId: 'a', blockers: [{ kind: 'turn' }] }] }
  const { controller, fired } = controllerWith(busy)
  const outcome = controller.rebootNow('me')
  assert.equal(outcome.ok, true)
  assert.match(outcome.message, /interrupting 1 session\./)
  assert.deepEqual(fired, ['now'])
  assert.equal(controller.status().fired, true)
  assert.equal(controller.rebootNow().ok, false)
  assert.equal(controller.cancel().ok, false)
})

test('rebootWhenIdle waits for two seconds of quiet, then fires once', () => {
  const busy = { value: [{ sessionId: 'a', blockers: [{ kind: 'turn' }] }] }
  const { controller, fired, advance, hasTimer } = controllerWith(busy)
  const outcome = controller.rebootWhenIdle('me')
  assert.equal(outcome.ok, true)
  assert.match(outcome.message, /Armed/)
  assert.equal(controller.status().armed.mode, 'when-idle')
  assert.equal(hasTimer(), true)
  advance(1000)
  assert.deepEqual(fired, [])
  busy.value = []
  advance(1000) // idle observed, grace starts
  assert.deepEqual(fired, [])
  advance(1000) // 1 s of quiet
  assert.deepEqual(fired, [])
  busy.value = [{ sessionId: 'b', blockers: [{ kind: 'jobs', labels: ['x'] }] }]
  advance(1000) // busy again: grace resets
  busy.value = []
  advance(1000)
  advance(1000)
  assert.deepEqual(fired, [])
  advance(1000) // 2 s of quiet
  assert.deepEqual(fired, ['when-idle'])
  assert.equal(hasTimer(), false)
  assert.equal(controller.status().armed, undefined)
  assert.equal(controller.status().fired, true)
})

test('rebootWhenIdle on an already idle server arms and fires after the grace', () => {
  const busy = { value: [] }
  const { controller, fired, advance } = controllerWith(busy)
  controller.rebootWhenIdle()
  assert.deepEqual(fired, [])
  advance(2000)
  assert.deepEqual(fired, ['when-idle'])
})

test('cancel disarms; a second wait re-arms', () => {
  const busy = { value: [{ sessionId: 'a', blockers: [{ kind: 'turn' }] }] }
  const { controller, fired, advance, hasTimer } = controllerWith(busy)
  controller.rebootWhenIdle()
  assert.equal(controller.cancel().ok, true)
  assert.equal(hasTimer(), false)
  busy.value = []
  advance(5000)
  assert.deepEqual(fired, [])
  assert.match(controller.cancel().message, /No reboot was armed/)
  controller.rebootWhenIdle()
  advance(1000); advance(1000); advance(1000)
  assert.deepEqual(fired, ['when-idle'])
})

test('listeners hear arming, cancelling and firing', () => {
  const busy = { value: [] }
  const { controller, advance } = controllerWith(busy)
  let count = 0
  const stop = controller.subscribe(() => { count += 1 })
  controller.rebootWhenIdle()
  assert.equal(count, 1)
  controller.cancel()
  assert.equal(count, 2)
  controller.rebootWhenIdle()
  advance(2000)
  assert.equal(count, 4)
  stop()
})

test('rebootIfIdle: refuses with the blockers while busy, fires once idle, never arms', () => {
  const busy = { value: [{ sessionId: 'a', blockers: [{ kind: 'turn' }] }, { sessionId: 'b', blockers: [{ kind: 'jobs', labels: ['build'] }] }] }
  const { controller, fired, hasTimer } = controllerWith(busy)
  const refused = controller.rebootIfIdle('me')
  assert.equal(refused.ok, false)
  assert.match(refused.message, /Not rebooting: 2 sessions have work in flight \(a: a turn is running; b: 1 background job \(build\)\)/)
  assert.equal(refused.busy.length, 2)
  assert.deepEqual(fired, [])
  assert.equal(hasTimer(), false, 'if-idle never arms a timer')
  assert.equal(controller.status().armed, undefined)
  busy.value = []
  const done = controller.rebootIfIdle('me')
  assert.equal(done.ok, true)
  assert.deepEqual(fired, ['if-idle'])
  assert.equal(controller.rebootIfIdle().ok, false, 'already under way')
  assert.equal(parseArgs('if-idle'), 'if-idle')
  assert.equal(parseArgs('safe'), 'if-idle')
})
