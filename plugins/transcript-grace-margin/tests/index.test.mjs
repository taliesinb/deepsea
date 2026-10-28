// node --test: the plugin against a fake ctx, no server needed.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { COLUMN_SELECTOR, Config, DEFAULT_MARGIN, MAX_MARGIN, apply, graceStyle, name, validate } from '../index.js'

function fakeContext() {
  const listeners = new Map()
  const logs = []
  const ctx = {
    on(event, fn) {
      listeners.set(event, fn)
      return () => { listeners.delete(event) }
    },
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(`warn: ${m}`) },
  }
  return { ctx, listeners, logs }
}

test('defaults: 160px on the top-level chat column of the active scroller', () => {
  assert.deepEqual(validate(undefined), { value: { margin: DEFAULT_MARGIN } })
  assert.deepEqual(validate({}), { value: { margin: DEFAULT_MARGIN } })
  assert.equal(graceStyle({ margin: 160 }),
    '[data-conversation-scroll] [data-chat-flow]:not([data-step-process-content]){padding-bottom:160px}')
})

test('a step group\'s own column is not padded', () => {
  assert.match(COLUMN_SELECTOR, /:not\(\[data-step-process-content\]\)$/)
})

test('config: integer 0-600 accepted, anything else is an issue', () => {
  assert.deepEqual(validate({ margin: 0 }), { value: { margin: 0 } })
  assert.deepEqual(validate({ margin: MAX_MARGIN }), { value: { margin: MAX_MARGIN } })
  for (const bad of [-1, MAX_MARGIN + 1, 12.5, '160', NaN, Infinity]) {
    assert.match(validate({ margin: bad }).issues?.[0].message ?? '', /margin is an integer/, String(bad))
  }
  assert.match(validate({ margins: 10 }).issues?.[0].message ?? '', /takes only "margin"/)
  assert.match(validate([]).issues?.[0].message ?? '', /is an object/)
})

test('Config is a standard schema whose vendor is the loader row id', () => {
  assert.equal(name, 'deepsea-transcript-grace-margin')
  assert.equal(Config['~standard'].vendor, name)
  assert.deepEqual(Config['~standard'].validate({ margin: 40 }), { value: { margin: 40 } })
})

test('apply pushes one style row into the index-inject table', () => {
  const { ctx, listeners, logs } = fakeContext()
  apply(ctx, { margin: 200 })
  const table = []
  listeners.get('webserver/index-inject')(table)
  assert.equal(table.length, 1)
  assert.equal(table[0].kind, 'style')
  assert.match(table[0].text, /padding-bottom:200px/)
  assert.match(table[0].text, /^\/\* deepsea-transcript-grace-margin \*\//)
  assert.match(logs[0], /200px/)
})

test('margin 0: no listener, no style', () => {
  const { ctx, listeners, logs } = fakeContext()
  apply(ctx, { margin: 0 })
  assert.equal(graceStyle({ margin: 0 }), '')
  assert.equal(listeners.has('webserver/index-inject'), false)
  assert.match(logs[0], /no rule/)
})
