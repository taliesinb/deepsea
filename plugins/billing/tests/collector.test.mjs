import test from 'node:test'
import assert from 'node:assert/strict'
import { installCollector } from '../collector.mjs'
import { tapResponse, telemetryParser } from '../collector-transport.mjs'

const A = 'https://api.anthropic.com/v1/messages'
const O = 'https://openrouter.ai/api/v1/chat/completions'
const C = 'https://chatgpt.com/backend-api/codex/responses'
const init = { method: 'POST', headers: { authorization: 'Bearer sk-ant-oat-fixture' }, body: 'PRIVATE PROMPT' }
const options = { provider: 'anthropic-oauth', model: 'fixture-model', sessionId: 'session-fixture' }
const headers = { 'anthropic-ratelimit-unified-status': 'allowed', 'anthropic-ratelimit-unified-representative-claim': 'five_hour' }
const finish = { type: 'finish', reason: { kind: 'stop' } }
function harness(fetch, callback) {
  const events = [], target = { fetch }, effects = []
  const ctx = { effect(fn) { effects.push(fn()) }, on(name, listener, settings) {
    assert.equal(name, 'llm/stream'); assert.equal(settings.global, true)
    this.listener = listener
    return () => { this.listener = undefined }
  } }
  const dispose = installCollector(ctx, callback ?? (event => events.push(event)), { target })
  return { target, events, dispose, effects, ctx, stream: (next, opts = options) => ctx.listener(opts, next) }
}
const consume = async stream => { const out = []; for await (const chunk of stream) out.push(chunk); return out }
const sse = value => `data: ${JSON.stringify(value)}\n\n`

test('standalone lazy scoped capture keeps exact inputs, responses and chunks; snapshots replace', async () => {
  const response = new Response('body', { headers })
  let calls = 0
  const h = harness(async (url, args) => { calls++; assert.equal(url, A); assert.equal(args, init); return response })
  const chunks = [{ type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } }, { type: 'usage', usage: { inputTokens: 2, outputTokens: 4 } }, finish]
  try {
    assert.equal(await h.target.fetch(A, init), response)
    assert.equal(h.events.length, 0) // outside LLM scope
    const stream = h.stream(async function* () {
      assert.equal(await h.target.fetch(A, init), response)
      yield* chunks
    }, { ...options, purpose: 'session-title' })
    assert.equal(h.events.length, 0)
    assert.deepEqual(await consume(stream), chunks)
    assert.equal(calls, 2)
    assert.deepEqual(h.events.map(x => x.phase), ['start', 'evidence', 'usage', 'usage', 'finish'])
    assert.equal(h.events[1].evidence.outcome, 'plan-evidence')
    assert.equal(h.events[0].purpose, 'session-title')
    assert.equal(new Set(h.events.map(x => x.requestId)).size, 1)
    assert.ok(!JSON.stringify(h.events).includes('PRIVATE'))
    assert.ok(!JSON.stringify(h.events).includes('sk-ant-oat'))
  } finally { h.dispose(); h.dispose() }
  assert.equal(h.ctx.listener, undefined)
})
test('native HTTP retries get separate lifecycles and usage only on final attempt', async () => {
  let count = 0
  const h = harness(async () => new Response(null, { status: ++count === 1 ? 429 : 200, headers }))
  try {
    await consume(h.stream(async function* () {
      await h.target.fetch(A, init); await h.target.fetch(A, init)
      yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 8 } }; yield finish
    }))
    const starts = h.events.filter(x => x.phase === 'start')
    assert.equal(starts.length, 2)
    assert.notEqual(starts[0].requestId, starts[1].requestId)
    assert.equal(h.events.find(x => x.phase === 'usage').requestId, starts[1].requestId)
    assert.deepEqual(h.events.filter(x => x.phase === 'finish').map(x => x.finishReason), ['superseded', 'stop'])
    assert.equal(h.events.filter(x => x.phase === 'evidence')[0].evidence.outcome, 'rejected')
  } finally { h.dispose() }
})
test('distinct DSH retries and concurrent sessions never share attempt ids or evidence', async () => {
  const h = harness(async () => new Response(null, { headers }))
  const run = sessionId => consume(h.stream(async function* () { await h.target.fetch(A, init); yield finish }, { ...options, sessionId }))
  try {
    await Promise.all([run('one'), run('two')]); await run('one')
    const starts = h.events.filter(x => x.phase === 'start')
    assert.equal(new Set(starts.map(x => x.requestId)).size, 3)
    for (const start of starts) assert.ok(h.events.filter(x => x.requestId === start.requestId).every(x => x.sessionId === start.sessionId))
  } finally { h.dispose() }
})
test('nested LLM calls use their actual route, not outer selected provider', async () => {
  const h = harness(async () => new Response(null, { headers }))
  try {
    await consume(h.stream(async function* () {
      await consume(h.stream(async function* () { await h.target.fetch(A, init); yield finish }, { provider: 'custom-route', model: 'inner', sessionId: 'inner' }))
      yield finish
    }))
    const plan = h.events.find(x => x.evidence?.outcome === 'plan-evidence')
    assert.equal(plan.sessionId, 'inner'); assert.equal(plan.provider, 'custom-route')
    assert.equal(h.events.find(x => x.sessionId === options.sessionId && x.phase === 'evidence').evidence.outcome, 'unobserved')
  } finally { h.dispose() }
})
test('unsupported inputs do not invoke getters; redirects do not certify subscription', async () => {
  let getterCalls = 0
  const response = new Response(null, { headers })
  Object.defineProperty(response, 'redirected', { value: true })
  const h = harness(async () => response)
  try {
    await consume(h.stream(async function* () {
      await h.target.fetch(A, { get headers() { getterCalls++; return init.headers } })
      await h.target.fetch(A, init); yield finish
    }))
    assert.equal(getterCalls, 0)
    assert.ok(!h.events.some(x => x.evidence?.outcome === 'plan-evidence'))
  } finally { h.dispose() }
})
test('OpenRouter JSON receipt and exact amount emitted without prompt or text persistence', async () => {
  const text = '{"choices":[{"text":"PRIVATE RESPONSE"}],"usage":{"cost":0.123456789012345678}}'
  const h = harness(async () => new Response(text, { headers: { 'content-type': 'application/json' } }))
  try {
    await consume(h.stream(async function* () { const response = await h.target.fetch(O, init); assert.equal(await response.text(), text); yield finish }, { ...options, provider: 'openrouter' }))
    assert.equal(h.events.find(x => x.evidence?.reportedCost).evidence.reportedCost.amount, '0.123456789012345678')
    assert.ok(!JSON.stringify(h.events).includes('PRIVATE'))
  } finally { h.dispose() }
})
test('Codex HTTP quota is not a plan claim; WS/no-fetch explicitly unobserved', async () => {
  const h = harness(async () => new Response(null, { headers: { 'x-codex-primary-used-percent': '12', 'x-codex-primary-window-minutes': '60' } }))
  const opts = { ...options, provider: 'openai-codex' }
  try {
    await consume(h.stream(async function* () { await h.target.fetch(C, init); yield finish }, opts))
    const quota = h.events.find(x => x.evidence?.kind === 'openai-codex').evidence
    assert.equal(quota.outcome, 'quota-observed'); assert.equal(quota.websocket, 'unobserved')
    h.events.length = 0
    await consume(h.stream(async function* () { yield finish }, opts))
    assert.equal(h.events[1].evidence.outcome, 'unobserved')
    assert.equal(h.events[1].evidence.websocket, 'unobserved')
  } finally { h.dispose() }
})
test('native thrown error identity and aborted finish survive telemetry failures', async () => {
  const error = new Error('native failure')
  const h = harness(async () => { throw error }, () => { throw new Error('observer broke') })
  try { await assert.rejects(consume(h.stream(async function* () { await h.target.fetch(A, init) })), value => value === error) }
  finally { h.dispose() }
  const h2 = harness(async () => new Response(null), () => Promise.reject(error))
  const aborted = { type: 'finish', reason: { kind: 'aborted', failure: { message: 'native' } } }
  try { assert.deepEqual(await consume(h2.stream(async function* () { yield aborted })), [aborted]) }
  finally { h2.dispose() }
})
test('consumer return closes underlying iterator and produces one terminal observation', async () => {
  let closed = false
  const h = harness(async () => new Response(null))
  try {
    const iterator = h.stream(async function* () { try { yield { type: 'text-delta', text: 'private' } } finally { closed = true } })[Symbol.asyncIterator]()
    await iterator.next(); await iterator.return()
    assert.equal(closed, true)
    assert.deepEqual(h.events.filter(x => x.phase === 'finish').map(x => x.finishReason), ['returned'])
  } finally { h.dispose() }
})

test('stream tap is demand driven, byte-preserving, and forwards cancel reason', async () => {
  let reads = 0, canceled
  const chunk = new TextEncoder().encode(sse({ usage: { cost: 0 } }))
  const response = new Response(new ReadableStream({ pull(c) { reads++; c.enqueue(chunk) }, cancel(reason) { canceled = reason } }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } })
  const receipts = []
  const tapped = tapResponse(response, event => receipts.push(event))
  await Promise.resolve(); assert.equal(reads, 0)
  const reader = tapped.body.getReader()
  assert.equal((await reader.read()).value, chunk)
  assert.equal(reads, 1)
  assert.equal(receipts[0].reportedCost.amount, '0')
  const reason = new Error('native consumer cancel')
  await reader.cancel(reason)
  assert.equal(canceled, reason)
  assert.equal(reads, 1)
})
test('tap returns exact body read failures to native consumer', async () => {
  const error = new Error('native stream failure')
  const response = new Response(new ReadableStream({ pull(c) { c.error(error) } }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } })
  const tapped = tapResponse(response, () => { throw new Error('not used') })
  await assert.rejects(tapped.text(), value => value === error)
})
test('SSE split unicode, CRLF, multiline, oversized frames and malformed metadata are bounded', () => {
  const receipts = []
  const parser = telemetryParser('sse', value => receipts.push(value), { eventLimit: 128 })
  const text = `data: ${'x'.repeat(2000)}\n\ndata: broken\n\ndata: {"usage":\r\ndata: {"cost":0.25},"text":"🦉"}\r\n\r\n${sse({ usage: { cost: 0.5 } })}data: [DONE]\n\n`
  for (const byte of new TextEncoder().encode(text)) parser.push(Uint8Array.of(byte))
  parser.end()
  assert.deepEqual(receipts.map(x => x.reportedCost.amount), ['0.25', '0.5'])
  const json = telemetryParser('json', () => assert.fail('oversize JSON must be ignored'), { jsonLimit: 30 })
  json.push(new TextEncoder().encode('{"text":"' + 'a'.repeat(100) + '","usage":{"cost":1}}')); json.end()
})

test('billing alone wraps fetch once and restores it on dispose', async () => {
  const target = { fetch: async () => new Response(null, { headers }) }, original = target.fetch
  const events = [], ctx = { effect: fn => fn(), on(name, fn) { this.listener = fn; return () => {} } }
  const dispose = installCollector(ctx, value => events.push(value), { target })
  assert.notEqual(target.fetch, original)
  await consume(ctx.listener(options, async function* () { await target.fetch(A, init); yield finish }))
  assert.equal(events.find(x => x.phase === 'evidence').evidence.outcome, 'plan-evidence')
  dispose()
  assert.equal(target.fetch, original)
})

test('zero usage is retained on success only, partial billed usage survives errors', async () => {
  const h = harness(async () => new Response(null))
  const zero = { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }
  try {
    for (const kind of ['error', 'aborted', 'stop']) {
      h.events.length = 0
      await consume(h.stream(async function* () { yield zero; yield { type: 'finish', reason: { kind } } }))
      assert.equal(h.events.filter(x => x.phase === 'usage').length, kind === 'stop' ? 1 : 0)
    }
    h.events.length = 0
    await consume(h.stream(async function* () {
      yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 1 } }
      yield zero; yield { type: 'finish', reason: { kind: 'error' } }
    }))
    assert.deepEqual(h.events.filter(x => x.phase === 'usage').map(x => x.usage), [{ inputTokens: 5, outputTokens: 1 }])
  } finally { h.dispose() }
})
test('unknown/custom usage getters are never evaluated by telemetry', async () => {
  let calls = 0
  const h = harness(async () => new Response(null))
  const chunk = { type: 'usage', usage: { get inputTokens() { calls++; throw new Error('bad getter') }, outputTokens: 1 } }
  try {
    assert.deepEqual(await consume(h.stream(async function* () { yield chunk; yield finish })), [chunk, finish])
    assert.equal(calls, 0)
  } finally { h.dispose() }
})
test('effect-owned teardown is safe during active body consumption and preserves later wrappers', async () => {
  const text = sse({ usage: { cost: 1 } })
  const h = harness(async () => new Response(text, { headers: { 'content-type': 'text/event-stream' } }))
  const stream = h.stream(async function* () {
    const response = await h.target.fetch(O, init)
    yield { type: 'text-delta', text: 'before read' }
    assert.equal(await response.text(), text)
    yield finish
  }, { ...options, provider: 'openrouter' })[Symbol.asyncIterator]()
  await stream.next()
  const ownWrapper = h.target.fetch
  const laterWrapper = (...args) => ownWrapper(...args)
  h.target.fetch = laterWrapper
  h.effects[0]()
  const count = h.events.length
  await consume({ [Symbol.asyncIterator]: () => stream })
  assert.equal(h.events.length, count)
  assert.equal(h.target.fetch, laterWrapper)
  h.dispose()
})
test('two independent collector contexts share one fetch broker and dispose independently', async () => {
  const target = { fetch: async () => new Response(null, { headers }) }, original = target.fetch
  const context = () => ({ effect: fn => fn(), on(name, fn) { this.listener = fn; return () => {} } })
  const first = context(), second = context(), a = [], b = []
  const offA = installCollector(first, event => a.push(event), { target })
  const wrapper = target.fetch
  const offB = installCollector(second, event => b.push(event), { target })
  try {
    assert.equal(target.fetch, wrapper)
    offA()
    await consume(second.listener(options, async function* () { await target.fetch(A, init); yield finish }))
    assert.equal(a.length, 0)
    assert.equal(b.find(x => x.evidence)?.evidence.outcome, 'plan-evidence')
  } finally { offA(); offB() }
  assert.equal(target.fetch, original)
})
test('cancel before first read never pulls a body; only forwards cancellation', async () => {
  let reads = 0, canceled
  const source = new ReadableStream({ pull() { reads++ }, cancel(reason) { canceled = reason } }, { highWaterMark: 0 })
  const response = tapResponse(new Response(source, { headers: { 'content-type': 'text/event-stream' } }), () => assert.fail())
  await response.body.cancel('done')
  assert.equal(reads, 0); assert.equal(canceled, 'done')
})

test('SSE accepts CR-only boundaries and CRLF split across chunks', () => {
  for (const delimiter of ['\r', '\r\n', '\n']) {
    const receipts = [], parser = telemetryParser('sse', receipt => receipts.push(receipt))
    const text = `data: {"usage":{"cost":0.1}}${delimiter}${delimiter}data: {"usage":{"cost":0.2}}${delimiter}${delimiter}`
    for (const byte of new TextEncoder().encode(text)) parser.push(Uint8Array.of(byte))
    parser.end()
    assert.deepEqual(receipts.map(x => x.reportedCost.amount), ['0.1', '0.2'])
  }
})

test('under provider simulation, requests and responses are read as the provider\'s', async () => {
  const { providerUrl, requestKind } = await import('../passive-fetch.mjs')
  const sim = 'http://127.0.0.1:4100'
  assert.equal(providerUrl(`${sim}/api.anthropic.com/v1/messages?beta=true`, sim).href, 'https://api.anthropic.com/v1/messages?beta=true')
  assert.equal(providerUrl('https://openrouter.ai/api/v1/chat/completions', sim).href, 'https://openrouter.ai/api/v1/chat/completions')
  assert.equal(providerUrl(`${sim}/openrouter.ai/x`, undefined).href, `${sim}/openrouter.ai/x`)
  const previous = process.env.DSH_PROVIDER_SIMULATOR
  process.env.DSH_PROVIDER_SIMULATOR = sim
  try {
    const kind = requestKind(`${sim}/openrouter.ai/api/v1/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer k' } })
    assert.deepEqual({ ...kind }, { kind: 'openrouter', origin: 'https://openrouter.ai', pathname: '/api/v1/chat/completions' })
  } finally {
    if (previous === undefined) delete process.env.DSH_PROVIDER_SIMULATOR
    else process.env.DSH_PROVIDER_SIMULATOR = previous
  }
})
