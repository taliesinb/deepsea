import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, slugTitleFor } from '../index.js'

const prompt = (text, kind = 'user') => ({ type: 'user/message', data: { source: { kind }, content: [{ type: 'text', text }] } })

test('the first human prompt with a slug names the session', () => {
  const first = prompt('fix-login: the redirect loops')
  assert.equal(slugTitleFor(first, [first], undefined), 'fix-login')
  // A fallback or provider title stands: the slug still wins.
  assert.equal(slugTitleFor(first, [first], { source: { kind: 'fallback' } }), 'fix-login')
})

test('later prompts, other sources and a title the person chose are left alone', () => {
  const first = prompt('hello')
  const second = prompt('fix-login: now this')
  assert.equal(slugTitleFor(second, [first, second], undefined), undefined)
  assert.equal(slugTitleFor(first, [first], undefined), undefined)
  const injected = prompt('fix-login: context', 'session-reference')
  assert.equal(slugTitleFor(injected, [injected], undefined), undefined)
  const named = prompt('fix-login: x')
  assert.equal(slugTitleFor(named, [named], { source: { kind: 'user' } }), undefined)
  assert.equal(slugTitleFor({ type: 'assistant/message', data: {} }, [], undefined), undefined)
})

test('apply renames through the session-title service once the prompt is published', async () => {
  const listeners = []
  const renamed = []
  const warnings = []
  const events = []
  const session = { id: 'session-1', snapshotEvents: () => events }
  const ctx = {
    on: (name, listener) => { assert.equal(name, 'session/event'); listeners.push(listener) },
    sessionTitle: {
      get: () => undefined,
      rename: (s, title) => {
        if (title === 'boom') throw new Error('not live')
        renamed.push([s.id, title])
      },
    },
    logger: { warn: message => warnings.push(message) },
  }
  apply(ctx)
  const first = prompt('ship-it: release notes')
  events.push(first)
  listeners[0](session, first)
  assert.deepEqual(renamed, [], 'not inside the publication of the prompt')
  await Promise.resolve()
  assert.deepEqual(renamed, [['session-1', 'ship-it']])
  const other = { id: 'session-2', snapshotEvents: () => [prompt('boom: x')] }
  listeners[0](other, other.snapshotEvents()[0])
  await Promise.resolve()
  assert.match(warnings[0], /could not name session "session-2" "boom"/)
})
