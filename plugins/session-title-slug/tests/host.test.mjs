import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, slugTitleFor, stripFirstPrompt } from '../index.js'

const prompt = (text, kind = 'user') => ({ type: 'user/message', data: { source: { kind }, content: [{ type: 'text', text }] } })
const message = (id, text, kind = 'user', extra = []) => Object.freeze({ id, role: 'user', source: { kind }, content: Object.freeze([{ type: 'text', text }, ...extra]) })

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

test('a slug the pre-step stripped still names the session', () => {
  const first = prompt('the redirect loops')
  first.data.id = 'm1'
  assert.equal(slugTitleFor(first, [first], undefined, 'fix-login'), 'fix-login')
  assert.equal(slugTitleFor(first, [first], { source: { kind: 'user' } }, 'fix-login'), undefined)
})

test('the first human prompt loses its slug prefix on the way to the model', () => {
  const context = message('ctx', 'Current runtime context.', 'runtime-context')
  const first = message('m1', '  fix-login:  \n the redirect loops')
  const result = stripFirstPrompt([first, context], [])
  assert.equal(result?.slug, 'fix-login')
  assert.equal(result?.id, 'm1')
  assert.equal(result?.messages.length, 2)
  assert.deepEqual(result?.messages[0], { ...first, content: [{ type: 'text', text: 'the redirect loops' }] })
  assert.ok(Object.isFrozen(result?.messages[0]))
  assert.equal(result?.messages[1], context, 'other messages are the same objects')
  assert.equal(first.content[0].text, '  fix-login:  \n the redirect loops', 'the input is not mutated')
  // Later blocks are kept as they are.
  const image = { type: 'image', data: 'AAAA', mimeType: 'image/png' }
  const withImage = stripFirstPrompt([message('m2', 'shot: look', 'user', [image])], [])
  assert.deepEqual(withImage?.messages[0].content, [{ type: 'text', text: 'look' }, image])
  // A slug alone with an image: the image is the prompt.
  assert.deepEqual(stripFirstPrompt([message('m3', 'shot:', 'user', [image])], [])?.messages[0].content, [{ type: 'text', text: '' }, image])
})

test('everything but the first human prompt with a slug is left as it is', () => {
  assert.equal(stripFirstPrompt([message('m1', 'hello: is not first')], [prompt('earlier')]), undefined)
  assert.equal(stripFirstPrompt([message('m1', 'Note: prose')], []), undefined)
  assert.equal(stripFirstPrompt([message('m1', 'http://example.com')], []), undefined)
  assert.equal(stripFirstPrompt([message('m1', 'fix-login: injected', 'session-reference')], []), undefined)
  assert.equal(stripFirstPrompt([], []), undefined)
  // Nothing would be left to send.
  assert.equal(stripFirstPrompt([message('m1', 'fix-login:  ')], []), undefined)
  // Only the first human prompt of a batch.
  const two = stripFirstPrompt([message('m1', 'one: a'), message('m2', 'two: b')], [])
  assert.equal(two?.messages[1].content[0].text, 'two: b')
})

test('apply strips at pre-step and renames once the prompt is published', async () => {
  const listeners = {}
  const renamed = []
  const events = []
  const session = { id: 'session-1', snapshotEvents: () => events }
  const ctx = {
    on: (name, listener, options) => {
      listeners[name] = listener
      if (name === 'agent/pre-step') assert.deepEqual(options, { prepend: true })
    },
    sessionTitle: { get: () => undefined, rename: (s, title) => renamed.push([s.id, title]) },
    logger: { warn: () => {} },
  }
  apply(ctx)
  const typed = message('m1', 'ship-it: say hello')
  const decision = await listeners['agent/pre-step']({ agent: { session }, messages: [typed] }, async () => ({ kind: 'enter', messages: [typed], startsRequestSeries: true }))
  assert.equal(decision.kind, 'enter')
  assert.equal(decision.startsRequestSeries, true, 'the rest of the decision is kept')
  assert.equal(decision.messages[0].content[0].text, 'say hello')
  const committed = { type: 'user/message', data: decision.messages[0] }
  events.push(committed)
  listeners['session/event'](session, committed)
  await Promise.resolve()
  assert.deepEqual(renamed, [['session-1', 'ship-it']])
  // A rejected step passes through.
  assert.deepEqual(await listeners['agent/pre-step']({ agent: { session }, messages: [] }, async () => ({ kind: 'reject' })), { kind: 'reject' })
})

test('apply renames through the session-title service once the prompt is published', async () => {
  const listeners = []
  const renamed = []
  const warnings = []
  const events = []
  const session = { id: 'session-1', snapshotEvents: () => events }
  const ctx = {
    on: (name, listener) => { if (name === 'session/event') listeners.push(listener) },
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
