import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSimulator } from '../server.mjs'

const made = []
test.after(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }) })

/** A simulator on a free port with two priced Gemini models (pi-ai's `google` catalog). */
async function start() {
  const dir = mkdtempSync(join(tmpdir(), 'deepsea-provider-sim-gemini-'))
  made.push(dir)
  const sim = await createSimulator({ db: join(dir, 'sim.sqlite') })
  const models = [
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', reasoning: true, contextWindow: 1048576, maxTokens: 65536, cost: { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0 } },
    { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash Preview', reasoning: true, contextWindow: 1048576, maxTokens: 65536, cost: { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0 } },
  ]
  sim.catalog.cost = (provider, id) => provider === 'google' ? models.find(m => m.id === id)?.cost : undefined
  sim.catalog.models = provider => provider === 'google' ? models : []
  await new Promise(resolve => sim.server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${sim.server.address().port}/generativelanguage.googleapis.com/v1beta`
  return { base, sim, close: () => new Promise(resolve => { sim.server.close(() => { sim.store.close(); resolve() }) }) }
}

const KEY = 'AIzaSy-test-gemini'
const user = text => ({ role: 'user', parts: [{ text }] })
const call = (base, model, method, body, { key = KEY, query = '' } = {}) => fetch(`${base}/models/${model}:${method}${query}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { 'x-goog-api-key': key } : {}) }, body: JSON.stringify(body) })
/** The server-sent events of a streamed answer, parsed. */
const events = text => text.split('\r\n\r\n').filter(Boolean).map(e => JSON.parse(e.replace(/^data: /, '')))
const partsOf = chunks => chunks.flatMap(c => c.candidates[0].content?.parts ?? [])

test('gemini key: models, whole and streamed answers with usage at catalog prices, thoughts, and Google\'s errors', async () => {
  const { base, sim, close } = await start()
  try {
    const anonymous = await call(base, 'gemini-2.5-flash', 'generateContent', { contents: [user('say hi')] }, { key: '' })
    assert.deepEqual([anonymous.status, (await anonymous.json()).error.status], [403, 'PERMISSION_DENIED'])
    const badKey = await call(base, 'gemini-2.5-flash', 'generateContent', { contents: [user('say hi')] }, { key: 'sk-not-google' })
    const bad = (await badKey.json()).error
    assert.deepEqual([badKey.status, bad.status, bad.message, bad.details[0].reason], [400, 'INVALID_ARGUMENT', 'API key not valid. Please pass a valid API key.', 'API_KEY_INVALID'])

    // A whole answer, the key in ?key=: 1000 × $0.30 + 500 × $2.50 per million tokens = 1550 micro-dollars.
    const whole = await call(base, 'gemini-2.5-flash', 'generateContent', { contents: [user('{"cmd":"say","text":"ok"}\n{"cmd":"usage","input":1000,"output":500}')] }, { key: '', query: `?key=${KEY}` })
    const body = await whole.json()
    assert.deepEqual(body.candidates[0], { content: { parts: [{ text: 'ok', thoughtSignature: body.candidates[0].content.parts[0].thoughtSignature }], role: 'model' }, finishReason: 'STOP', index: 0 })
    assert.deepEqual([body.usageMetadata.promptTokenCount, body.usageMetadata.candidatesTokenCount, body.usageMetadata.totalTokenCount, body.modelVersion], [1000, 500, 1500, 'gemini-2.5-flash'])
    assert.equal(sim.store.accounts('gemini')[0].state.balanceMicros, 10_000_000 - 1550)

    // Streamed: thought parts only with includeThoughts; thinking is billed either way, in thoughtsTokenCount.
    const script = '{"cmd":"think","text":"Let me think."}\n{"cmd":"say","text":"Hello there","chunks":2}\n{"cmd":"usage","input":100,"output":50,"reasoning":20,"cacheRead":40}'
    const shown = events(await (await call(base, 'gemini-2.5-flash', 'streamGenerateContent', { contents: [user(script)], generationConfig: { thinkingConfig: { includeThoughts: true, thinkingBudget: 1024 } } }, { query: '?alt=sse' })).text())
    assert.deepEqual(partsOf(shown).map(p => [p.text, p.thought === true]), [['Let me think.', true], ['Hello ', false], ['there', false]])
    assert.equal(shown.at(-1).candidates[0].finishReason, 'STOP')
    assert.ok(shown.slice(0, -1).every(c => c.candidates[0].finishReason === undefined && c.usageMetadata.candidatesTokenCount === undefined))
    assert.deepEqual(shown.at(-1).usageMetadata, { promptTokenCount: 140, candidatesTokenCount: 30, cachedContentTokenCount: 40, totalTokenCount: 190,
      promptTokensDetails: [{ modality: 'TEXT', tokenCount: 140 }], cacheTokensDetails: [{ modality: 'TEXT', tokenCount: 40 }], thoughtsTokenCount: 20 })
    const hidden = events(await (await call(base, 'gemini-2.5-flash', 'streamGenerateContent', { contents: [user(script)] }, { query: '?alt=sse' })).text())
    assert.deepEqual(partsOf(hidden).map(p => p.text), ['Hello ', 'there'])
    assert.equal(hidden.at(-1).usageMetadata.thoughtsTokenCount, 20)
    // Without alt=sse the stream is a JSON array; thinkingBudget 0 is no thinking (and no signature).
    const array = await (await call(base, 'gemini-2.5-flash', 'streamGenerateContent', { contents: [user('{"cmd":"think","text":"hm"}\n{"cmd":"say","text":"plain"}')], generationConfig: { thinkingConfig: { thinkingBudget: 0 } } })).json()
    assert.deepEqual([Array.isArray(array), partsOf(array), array.at(-1).usageMetadata.thoughtsTokenCount], [true, [{ text: 'plain' }], undefined])

    const models = await (await fetch(`${base}/models?pageSize=1`, { headers: { 'x-goog-api-key': KEY } })).json()
    assert.deepEqual([models.models.length, models.models[0].name, models.models[0].supportedGenerationMethods.includes('generateContent'), typeof models.nextPageToken], [1, 'models/gemini-2.5-flash', true, 'string'])
    const next = await (await fetch(`${base}/models?pageSize=1&pageToken=${models.nextPageToken}`, { headers: { 'x-goog-api-key': KEY } })).json()
    assert.deepEqual([next.models[0].name, next.nextPageToken], ['models/gemini-3-flash-preview', undefined])
    assert.equal((await (await fetch(`${base}/models/gemini-3-flash-preview`, { headers: { 'x-goog-api-key': KEY } })).json()).displayName, 'Gemini 3 Flash Preview')
    const unknown = await call(base, 'gemini-0-nano', 'generateContent', { contents: [user('say hi')] })
    assert.deepEqual([unknown.status, (await unknown.json()).error.status], [404, 'NOT_FOUND'])
    const empty = await call(base, 'gemini-2.5-flash', 'generateContent', { contents: [] })
    assert.deepEqual([empty.status, (await empty.json()).error.message], [400, '* GenerateContentRequest.contents: contents is not specified\n'])

    // The script's errors in Google's shape: 429 with RetryInfo, overloaded as 503 UNAVAILABLE.
    const limited = await call(base, 'gemini-2.5-flash', 'generateContent', { contents: [user('{"cmd":"error","kind":"rate-limit","retryAfter":7}')] })
    assert.deepEqual([limited.status, (await limited.json()).error], [429, { code: 429, message: 'simulated rate-limit', status: 'RESOURCE_EXHAUSTED',
      details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '7s' }] }])
    const overloaded = await call(base, 'gemini-2.5-flash', 'streamGenerateContent', { contents: [user('{"cmd":"error","kind":"overloaded","message":"The model is overloaded. Please try again later."}')] }, { query: '?alt=sse' })
    assert.deepEqual([overloaded.status, (await overloaded.json()).error], [503, { code: 503, message: 'The model is overloaded. Please try again later.', status: 'UNAVAILABLE' }])

    // Prepay credit used up: 402 until credit is added.
    await fetch(`${base.replace(/\/generativelanguage.*/, '')}/_sim/account`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'gemini', credential: KEY, state: { balanceMicros: 0 } }) })
    const broke = await call(base, 'gemini-2.5-flash', 'generateContent', { contents: [user('say hi')] })
    assert.equal(broke.status, 402)
    assert.match((await broke.json()).error.message, /prepayment credits are depleted/)
  } finally { await close() }
})

test('gemini tool calls: functionResponse results, expect by id with and without Gemini 3 call ids, and Gemini 3\'s thought signatures', async () => {
  const { base, close } = await start()
  try {
    const script = '{"cmd":"tool","name":"read","id":"t1","args":{"path":"a.txt"}}\n{"cmd":"expect","value":"tools.t1.text","contains":"hello"}\n{"cmd":"say","text":"done"}'
    const sse = async (model, contents) => {
      const response = await call(base, model, 'streamGenerateContent', { contents, generationConfig: { thinkingConfig: { includeThoughts: true } } }, { query: '?alt=sse' })
      return { status: response.status, text: await response.text() }
    }
    for (const model of ['gemini-2.5-flash', 'gemini-3-flash-preview']) {
      const first = events((await sse(model, [user(script)])).text)
      const [part] = partsOf(first)
      // Gemini 3 numbers its calls; earlier models do not. The first call carries the thought signature.
      assert.deepEqual(part.functionCall, { ...(model.startsWith('gemini-3') ? { id: 't1' } : {}), name: 'read', args: { path: 'a.txt' } }, model)
      assert.match(part.thoughtSignature, /^[A-Za-z0-9+/]+={0,2}$/)
      assert.equal(first.at(-1).candidates[0].finishReason, 'STOP')
      const id = part.functionCall.id
      const answered = result => [user(script), { role: 'model', parts: [part] }, { role: 'user', parts: [{ functionResponse: { name: 'read', response: { output: result }, ...(id ? { id } : {}) } }] }]
      assert.deepEqual(partsOf(events((await sse(model, answered('hello world'))).text)).map(p => p.text), ['done'], model)
      const wrong = await sse(model, answered('nothing'))
      assert.deepEqual([wrong.status, JSON.parse(wrong.text).error.message], [400, 'line 2: expected tools.t1.text to contain "hello"; got "nothing"'], model)
    }
    // Gemini 3 refuses a current-turn function call without its signature; Gemini 2.5 does not check.
    const unsigned = [user(script), { role: 'model', parts: [{ functionCall: { id: 't1', name: 'read', args: {} } }] }, { role: 'user', parts: [{ functionResponse: { id: 't1', name: 'read', response: { output: 'hello' } } }] }]
    const refused = await sse('gemini-3-flash-preview', unsigned)
    assert.equal(refused.status, 400)
    assert.match(JSON.parse(refused.text).error.message, /^Function call is missing a thought_signature in functionCall parts\..*`default_api:read` , position 2\./)
    assert.equal((await sse('gemini-2.5-flash', unsigned)).status, 200)
    // An earlier turn's calls are not checked: a new prompt starts a new turn.
    const later = [...unsigned, { role: 'model', parts: [{ text: 'done' }] }, user('say again')]
    assert.deepEqual(partsOf(events((await sse('gemini-3-flash-preview', later)).text)).map(p => p.text), ['again'])
  } finally { await close() }
})
