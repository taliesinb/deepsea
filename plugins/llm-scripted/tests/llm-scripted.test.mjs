import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ScriptedAdapter } from '../adapter.mjs'
import { chunk, FINISHED_REPLY, helpText, isScript, ORDERS_REPLY, parseScript, plainReply, segments } from '@deepsea/script'

const user = text => ({ role: 'user', content: [{ type: 'text', text }] })
const assistant = blocks => ({ role: 'assistant', content: blocks })
const toolResult = (toolCallId, text, isError = false) => ({ role: 'tool', toolCallId, isError, content: [{ type: 'text', text }] })
const script = lines => lines.map(l => JSON.stringify(l)).join('\n')

async function collect(options) {
  const chunks = []
  for await (const c of new ScriptedAdapter().stream({ provider: 'scripted', model: 'script', ...options })) chunks.push(c)
  return chunks
}
const blocks = chunks => chunks.filter(c => c.type === 'block-end').map(c => c.block)
const finish = chunks => chunks.at(-1)

test('plain prompts: say <text> echoes one line, help lists the commands', async () => {
  assert.equal(plainReply('say XXXX YYY ZZZ'), 'XXXX YYY ZZZ')
  assert.equal(plainReply('  Say  hello there  '), 'hello there')
  assert.equal(plainReply('say one\ntwo'), ORDERS_REPLY)
  assert.equal(plainReply('say'), ORDERS_REPLY)
  assert.equal(plainReply('sayonara'), ORDERS_REPLY)
  const help = helpText()
  assert.equal(plainReply(' HELP '), help)
  for (const cmd of ['say', 'think', 'tool', 'expect', 'sleep', 'usage', 'error', 'end', 'title']) assert.match(help, new RegExp(`\\| \`\\{"cmd":"${cmd}"\\}\` \\|`))
  assert.match(help, /`text` `chunks\?` `chunkDelay\?`/)
  assert.match(help, /`rate-limit`/)
  const chunks = await collect({ messages: [user('say XXXX YYY ZZZ')] })
  assert.deepEqual(blocks(chunks), [{ type: 'text', text: 'XXXX YYY ZZZ' }])
})

test('a prompt that is not a script gets the standing reply', async () => {
  for (const text of ['hello', '', '  plain text', '[1,2]']) {
    const chunks = await collect({ messages: [user(text)] })
    assert.deepEqual(blocks(chunks), [{ type: 'text', text: ORDERS_REPLY }], text)
    assert.deepEqual(finish(chunks), { type: 'finish', reason: { kind: 'stop' } })
  }
  assert.equal(isScript('\n  {"cmd": "say"}'), true)
})

test('validation reports every bad line at once, before anything runs', () => {
  const { errors } = parseScript([
    '{"cmd": "say", "text": "ok"}',
    '{"cmd": "sya", "text": "typo"}',
    'not json',
    '{"cmd": "tool"}',
    '{"cmd": "say", "text": 3, "colour": "red"}',
    '',
    '{"cmd": "sleep", "time": -1}',
    '[1]',
    '{"text": "no cmd"}',
    '{"cmd": "error", "kind": "solar-flare"}',
  ].join('\n'))
  assert.deepEqual(errors.map(e => e.replace(/ \(.*$/, '').replace(/must be .*/, 'must be …')), [
    'line 2: unknown cmd "sya"',
    'line 3: not JSON',
    'line 4: tool needs "name"',
    'line 5: say has no field "colour"',
    'line 5: say "text" must be …',
    'line 7: sleep "time" must be …',
    'line 8: not a JSON object',
    'line 9: no "cmd"',
    'line 10: error "kind" must be …',
  ])
})

test('placement rules: end last, one title, expect right after tool calls', () => {
  const errs = lines => parseScript(script(lines)).errors
  assert.match(errs([{ cmd: 'end' }, { cmd: 'say', text: 'x' }])[0], /line 1: end must be the last/)
  assert.match(errs([{ cmd: 'title', text: 'a' }, { cmd: 'title', text: 'b' }])[0], /line 2: only one title/)
  assert.match(errs([{ cmd: 'say', text: 'x' }, { cmd: 'expect', contains: 'y' }])[0], /line 2: expect must directly follow/)
  assert.match(errs([{ cmd: 'tool', name: 'a', id: 'x' }, { cmd: 'expect', contains: 'y', tool: 'z' }])[0], /names tool "z"/)
  assert.match(errs([{ cmd: 'tool', name: 'a' }, { cmd: 'expect' }])[0], /expect needs/)
  assert.match(errs([{ cmd: 'tool', name: 'a', id: 'x' }, { cmd: 'tool', name: 'b', id: 'x' }])[0], /used twice/)
  assert.deepEqual(errs([{ cmd: 'tool', name: 'a', id: 'x' }, { cmd: 'tool', name: 'b' }, { cmd: 'expect', tool: 'x', contains: '' }, { cmd: 'expect', isError: false }, { cmd: 'end' }]), [])
})

test('an invalid script fails the request with an API error listing the problems', async () => {
  await assert.rejects(collect({ messages: [user('{"cmd": "sya"}\n{"cmd": "say"}')] }), (error) => {
    assert.equal(error.code, 'SCRIPT_INVALID')
    assert.equal(error.failure.status, 400)
    assert.match(error.message, /line 1: unknown cmd "sya"[\s\S]*line 2: say needs "text"/)
    return true
  })
})

test('responses split after each run of tool calls', () => {
  const { commands } = parseScript(script([
    { cmd: 'title', text: 't' }, { cmd: 'think', text: 'a' }, { cmd: 'tool', name: 'x' }, { cmd: 'tool', name: 'y' },
    { cmd: 'expect', contains: 'z' }, { cmd: 'say', text: 'b' }, { cmd: 'tool', name: 'w' },
  ]))
  assert.deepEqual(segments(commands).map(s => s.map(c => c.cmd)), [['think', 'tool', 'tool'], ['expect', 'say', 'tool']])
  assert.deepEqual(chunk('abcdefg', 3), ['abc', 'def', 'g'])
})

test('a script plays across responses: text, reasoning, parallel tool calls, then the rest after the results', async () => {
  const text = script([
    { cmd: 'think', text: 'plan' }, { cmd: 'say', text: 'Looking.', chunks: 3 },
    { cmd: 'tool', name: 'bash', args: { command: 'ls' }, id: 'ls' }, { cmd: 'tool', name: 'read', args: { path: 'a' } },
    { cmd: 'expect', tool: 'ls', contains: 'README' }, { cmd: 'say', text: 'Done.' },
  ])
  const first = await collect({ messages: [user(text)] })
  assert.deepEqual(first.filter(c => c.type === 'text-delta').map(c => c.text), ['Loo', 'kin', 'g.'])
  const calls = blocks(first).filter(b => b.type === 'tool-call')
  assert.deepEqual(blocks(first).map(b => b.type), ['reasoning', 'text', 'tool-call', 'tool-call'])
  assert.deepEqual(calls.map(c => [c.name, JSON.parse(c.arguments)]), [['bash', { command: 'ls' }], ['read', { path: 'a' }]])
  assert.match(calls[0].id, /^scripted-[0-9a-f]{12}-0-ls$/)
  assert.deepEqual(finish(first).reason, { kind: 'tool-calls' })
  // The same transcript gives the same ids.
  assert.deepEqual(blocks(await collect({ messages: [user(text)] })).filter(b => b.type === 'tool-call').map(c => c.id), calls.map(c => c.id))

  const history = [user(text), assistant(blocks(first)), toolResult(calls[0].id, 'README.md\nsrc'), toolResult(calls[1].id, 'contents')]
  const second = await collect({ messages: history })
  assert.deepEqual(blocks(second), [{ type: 'text', text: 'Done.' }])
  assert.deepEqual(finish(second).reason, { kind: 'stop' })

  const failing = [user(text), assistant(blocks(first)), toolResult(calls[0].id, 'nothing here'), toolResult(calls[1].id, 'x')]
  await assert.rejects(collect({ messages: failing }), /line 5: expected the tool result to contain "README"; got "nothing here"/)

  // A script ending in tool calls says it is finished once their results are in.
  const toolOnly = script([{ cmd: 'tool', name: 'bash', args: {} }])
  const call = blocks(await collect({ messages: [user(toolOnly)] }))[0]
  assert.deepEqual(blocks(await collect({ messages: [user(toolOnly), assistant([call]), toolResult(call.id, 'ok')] })), [{ type: 'text', text: FINISHED_REPLY }])
})

test('usage, end, sleep and cancellation', async () => {
  const chunks = await collect({ messages: [user(script([{ cmd: 'say', text: 'x' }, { cmd: 'usage', input: 1200, output: 85, cacheRead: 900 }, { cmd: 'end', reason: 'max-tokens' }]))] })
  assert.deepEqual(chunks.at(-2), { type: 'usage', usage: { inputTokens: 1200, outputTokens: 85, cacheReadTokens: 900 } })
  assert.deepEqual(finish(chunks).reason, { kind: 'max-tokens' })

  const controller = new AbortController()
  const started = Date.now()
  setTimeout(() => controller.abort(), 50)
  await assert.rejects(collect({ messages: [user(script([{ cmd: 'sleep', time: 30 }]))], signal: controller.signal }), e => e.code === 'ABORTED')
  assert.ok(Date.now() - started < 2000)
})

test('scripted provider errors: codes, status, retry-after, and `times` for retries', async () => {
  await assert.rejects(collect({ messages: [user('{"cmd": "error", "kind": "rate-limit", "retryAfter": 2}')] }), (e) => {
    assert.equal(e.code, 'RATE_LIMIT')
    assert.deepEqual([e.failure.status, e.failure.providerRetryAfterMs], [429, 2000])
    return true
  })
  // `times: 1` fails the first attempt only, so a retry succeeds.
  const adapter = new ScriptedAdapter()
  const messages = [user(script([{ cmd: 'error', kind: 'overloaded', times: 1 }, { cmd: 'say', text: 'second try' }]))]
  const run = async () => { const out = []; for await (const c of adapter.stream({ provider: 'scripted', model: 'script', messages })) out.push(c); return out }
  await assert.rejects(run(), e => e.code === 'SERVER' && e.failure.status === 529)
  assert.deepEqual(blocks(await run()), [{ type: 'text', text: 'second try' }])
})

test('side calls: titles and compaction get fixed answers; a script may set its title', async () => {
  const adapter = new ScriptedAdapter()
  const call = async options => { const out = []; for await (const c of adapter.stream({ provider: 'scripted', model: 'script', ...options })) out.push(c); return blocks(out)[0].text }
  assert.equal(await call({ purpose: 'session-title', sessionId: 's1', messages: [user('anything')] }), 'scripted session')
  await call({ sessionId: 's1', messages: [user(script([{ cmd: 'title', text: 'my-test' }, { cmd: 'say', text: 'x' }]))] })
  assert.equal(await call({ purpose: 'session-title', sessionId: 's1', messages: [user('anything')] }), 'my-test')
  assert.equal(await call({ purpose: 'compaction', messages: [user('anything')] }), 'Summary: a scripted session.')
})

test('the script is the latest typed message, not context the harness adds after it', async () => {
  const typed = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '{"cmd": "say", "text": "from the script"}' }] }
  const injected = kind => ({ role: 'user', source: { kind }, content: [{ type: 'text', text: `${kind} snapshot` }] })
  const chunks = await collect({ messages: [typed, injected('runtime-context'), injected('time-context')] })
  assert.deepEqual(blocks(chunks), [{ type: 'text', text: 'from the script' }])
})
