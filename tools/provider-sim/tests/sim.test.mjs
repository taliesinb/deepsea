import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSimulator } from '../server.mjs'
import { costMicros } from '../common.mjs'
import { normalize, promptOf } from '../wire.mjs'

const made = []
test.after(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }) })

/** A simulator on a free port with a tiny catalog; returns its base URL and a closer. */
async function start() {
  const dir = mkdtempSync(join(tmpdir(), 'deepsea-provider-sim-test-'))
  made.push(dir)
  const sim = await createSimulator({ db: join(dir, 'sim.sqlite') })
  // A catalog of two priced models, standing in for pi-ai's generated files.
  sim.catalog.cost = (provider, model) => ({ 'openrouter/vendor/model': { input: 1, output: 2 }, 'deepseek/deepseek-v4-pro': { input: 1.32, output: 3.96 } })[`${provider}/${model}`]
  await new Promise(resolve => sim.server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${sim.server.address().port}`
  return { base, sim, close: () => new Promise(resolve => { sim.server.close(() => { sim.store.close(); resolve() }) }) }
}

const post = (url, body, key) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body) })
const sse = async response => (await response.text()).split('\n').filter(l => l.startsWith('data: ') && l !== 'data: [DONE]').map(l => JSON.parse(l.slice(6)))

test('the prompt is the message that starts the turn; context after it and tool results are not', () => {
  const openai = normalize('openai', [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'reply' },
    { role: 'user', content: [{ type: 'text', text: '{"cmd":"say","text":"x"}' }] },
    { role: 'user', content: 'runtime context' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 't', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'result one' },
  ])
  assert.deepEqual(promptOf(openai), { prompt: '{"cmd":"say","text":"x"}', position: 1, responses: [{ results: [{ id: 'c1', text: 'result one' }] }] })
  const anthropic = normalize('anthropic', [
    { role: 'user', content: [{ type: 'text', text: 'say hi' }, { type: 'text', text: 'context' }] },
  ])
  assert.deepEqual(promptOf(anthropic), { prompt: 'say hi', position: 0, responses: [] })
  assert.equal(costMicros({ input: 1, output: 2 }, { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 }), 2000)
  // After a failed turn: the next prompt follows the failed one, or shares the tool results' message.
  const failed = '{"cmd":"error","kind":"server"}'
  assert.deepEqual(promptOf(normalize('openai', [{ role: 'user', content: failed }, { role: 'user', content: 'say again' }])), { prompt: 'say again', position: 0, responses: [] })
  assert.equal(promptOf(normalize('openai', [{ role: 'user', content: failed }, { role: 'user', content: 'runtime context' }])).prompt, failed)
  const merged = normalize('anthropic', [
    { role: 'user', content: '{"cmd":"tool","name":"t"}' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'u1', name: 't', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u1', content: 'interrupted' }, { type: 'text', text: '{"cmd":"say","text":"new"}' }] },
  ])
  assert.deepEqual(promptOf(merged), { prompt: '{"cmd":"say","text":"new"}', position: 0, responses: [] })
})

test('the titler and compaction get the scripted model\'s answers, never a replay of the script', async () => {
  const { respond } = await import('../wire.mjs')
  const script = '{"cmd":"title","text":"named by script"}\n{"cmd":"say","text":"x"}\n{"cmd":"usage","input":9,"output":9}'
  const title = respond(normalize('openai', [{ role: 'user', content: `Generate the session title from this JSON array of human messages:\n${JSON.stringify([{ text: script }])}` }]))
  assert.deepEqual(title.steps, [{ cmd: 'say', text: 'named by script' }])
  const untitled = respond(normalize('openai', [{ role: 'user', content: 'Generate the session title from this JSON array of human messages:\n[{"text":"hello"}]' }]))
  assert.deepEqual(untitled.steps, [{ cmd: 'say', text: 'scripted session' }])
  const compaction = respond(normalize('openai', [{ role: 'user', content: script }, { role: 'system', content: 'You are now acting as a compaction engine for this AI coding assistant.' }]))
  assert.deepEqual(compaction.steps, [{ cmd: 'say', text: 'Summary: a simulated session.' }])
  assert.deepEqual(respond(normalize('anthropic', [{ role: 'user', content: script }]), 'You are now acting as a compaction engine').steps, [{ cmd: 'say', text: 'Summary: a simulated session.' }])
})

test('openrouter: an account per key, scripted streams in both formats, cost lookup, credit, and 402 when it runs out', async () => {
  const { base, sim, close } = await start()
  try {
    assert.equal((await post(`${base}/openrouter.ai/api/v1/chat/completions`, { model: 'vendor/model', messages: [] })).status, 401)
    const script = '{"cmd":"think","text":"hmm"}\n{"cmd":"say","text":"hello there","chunks":2}\n{"cmd":"usage","input":1000,"output":500}'
    const chunks = await sse(await post(`${base}/openrouter.ai/api/v1/chat/completions`, { model: 'vendor/model', stream: true, messages: [{ role: 'user', content: script }] }, 'sk-or-test'))
    assert.equal(chunks.map(c => c.choices[0].delta.content ?? '').join(''), 'hello there')
    assert.equal(chunks.map(c => c.choices[0].delta.reasoning ?? '').join(''), 'hmm')
    const last = chunks.at(-1)
    assert.deepEqual([last.choices[0].finish_reason, last.usage.prompt_tokens, last.usage.completion_tokens, last.usage.cost], ['stop', 1000, 500, 0.002])
    const generation = await (await fetch(`${base}/openrouter.ai/api/v1/generation?id=${last.id}`, { headers: { authorization: 'Bearer sk-or-test' } })).json()
    assert.equal(generation.data.total_cost, 0.002)
    assert.equal((await fetch(`${base}/openrouter.ai/api/v1/generation?id=${last.id}`, { headers: { authorization: 'Bearer someone-else' } })).status, 404)
    const credits = await (await fetch(`${base}/openrouter.ai/api/v1/credits`, { headers: { authorization: 'Bearer sk-or-test' } })).json()
    assert.deepEqual(credits.data, { total_credits: 10, total_usage: 0.002 })
    // A tool call in the Anthropic format, then the script's next response once the result is back.
    const tool = '{"cmd":"tool","name":"read","args":{"path":"a.txt"},"id":"t1"}\n{"cmd":"expect","contains":"alpha"}\n{"cmd":"say","text":"done"}'
    const first = await (await post(`${base}/openrouter.ai/api/v1/messages`, { model: 'vendor/model', messages: [{ role: 'user', content: tool }] }, 'sk-or-test')).json()
    assert.deepEqual([first.stop_reason, first.content[0].type, first.content[0].name, first.content[0].input], ['tool_use', 'tool_use', 'read', { path: 'a.txt' }])
    const history = [{ role: 'user', content: tool }, { role: 'assistant', content: first.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'alpha beta' }] }]
    const second = await (await post(`${base}/openrouter.ai/api/v1/messages`, { model: 'vendor/model', messages: history }, 'sk-or-test')).json()
    assert.deepEqual(second.content, [{ type: 'text', text: 'done' }])
    history[2].content[0].content = 'gamma'
    const failed = await post(`${base}/openrouter.ai/api/v1/messages`, { model: 'vendor/model', messages: history }, 'sk-or-test')
    assert.equal(failed.status, 400)
    assert.match((await failed.json()).error.message, /line 2: expected tools.last.text to contain "alpha"; got "gamma"/)
    // Spend the account's credit; the next request is refused.
    await post(`${base}/_sim/account`, { provider: 'openrouter', credential: 'sk-or-test', state: { usageMicros: 10_000_000 } })
    const broke = await post(`${base}/openrouter.ai/api/v1/chat/completions`, { model: 'vendor/model', messages: [{ role: 'user', content: 'say hi' }] }, 'sk-or-test')
    assert.equal(broke.status, 402)
    assert.equal(sim.store.accounts('openrouter').length, 2)
  } finally { await close() }
})

test('deepseek: Anthropic messages for its own adapter, plain prompts, balance, errors with retry-after, unknown hosts', async () => {
  const { base, close } = await start()
  try {
    const stream = await (await fetch(`${base}/api.deepseek.com/anthropic/v1/messages`, { method: 'POST', headers: { 'x-api-key': 'sk-ds', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-pro', stream: true, messages: [{ role: 'user', content: 'say XXXX YYY ZZZ' }] }) })).text()
    const events = stream.split('\n').filter(l => l.startsWith('event: ')).map(l => l.slice(7))
    assert.deepEqual(events, ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'])
    assert.match(stream, /"text":"XXXX YYY ZZZ"/)
    const balance = await (await fetch(`${base}/api.deepseek.com/user/balance`, { headers: { authorization: 'Bearer sk-ds' } })).json()
    assert.deepEqual([balance.is_available, balance.balance_infos[0].currency], [true, 'USD'])
    const [account] = (await (await fetch(`${base}/_sim/accounts?provider=deepseek`)).json()).accounts
    assert.ok(account.state.balanceMicros < 10_000_000 && account.state.balanceMicros > 9_999_000, String(account.state.balanceMicros))
    const limited = await post(`${base}/api.deepseek.com/chat/completions`, { model: 'deepseek-v4-pro', messages: [{ role: 'user', content: '{"cmd":"error","kind":"rate-limit","retryAfter":3,"times":1}\n{"cmd":"say","text":"ok"}' }] }, 'sk-ds')
    assert.deepEqual([limited.status, limited.headers.get('retry-after')], [429, '3'])
    const retried = await (await post(`${base}/api.deepseek.com/chat/completions`, { model: 'deepseek-v4-pro', messages: [{ role: 'user', content: '{"cmd":"error","kind":"rate-limit","retryAfter":3,"times":1}\n{"cmd":"say","text":"ok"}' }] }, 'sk-ds')).json()
    assert.equal(retried.choices[0].message.content, 'ok')
    const unknown = await post(`${base}/api.example-llm.com/v1/chat`, {}, 'k')
    assert.equal(unknown.status, 501)
  } finally { await close() }
})

test('loops, batches and values play as the scripted model plays them, from the text of tool results', async () => {
  const { respond } = await import('../wire.mjs')
  const script = [
    { cmd: 'batch', cmds: [{ cmd: 'loop', values: { type: 'range', stop: 2 }, body: { cmd: 'tool', name: 'echo', id: 'e', args: { n: { $value$: 'loop.this.index' } } } }] },
    { cmd: 'loop', values: { type: 'literal', value: ['a', 'b'] }, body: { cmd: 'tool', name: 'echo', args: { n: { $value$: 'loop.this.value' } } } },
    { cmd: 'expect', value: 'tools.e.text', equals: 'one' },
    { cmd: 'say', text: { $value$: 'tools.last.text' } },
  ].map(l => JSON.stringify(l)).join('\n')
  const conversation = [{ role: 'user', content: script }]
  const play = () => respond(normalize('openai', conversation))
  const callsOf = steps => steps.filter(s => s.cmd === 'tool').map(s => [s.id, s.args.n])
  const answer = (steps, texts) => {
    const calls = steps.filter(s => s.cmd === 'tool').map((s, i) => ({ id: s.id ?? `r${conversation.length}-${i}`, type: 'function', function: { name: s.name, arguments: JSON.stringify(s.args) } }))
    conversation.push({ role: 'assistant', content: null, tool_calls: calls })
    calls.forEach((c, i) => conversation.push({ role: 'tool', tool_call_id: c.id, content: texts[i] }))
  }
  let plan = play()
  assert.deepEqual(callsOf(plan.steps), [['e-0', 0], ['e-1', 1]])
  answer(plan.steps, ['zero', 'one'])
  plan = play()
  assert.deepEqual(callsOf(plan.steps), [[undefined, 'a']])
  answer(plan.steps, ['A'])
  plan = play()
  assert.deepEqual(callsOf(plan.steps), [[undefined, 'b']])
  answer(plan.steps, ['B'])
  assert.deepEqual(play().steps, [{ cmd: 'say', line: 4, ref: '4', text: 'B' }])
})
