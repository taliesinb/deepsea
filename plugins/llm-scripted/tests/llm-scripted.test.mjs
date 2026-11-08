import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ScriptedAdapter } from '../adapter.mjs'
import {
  chunk, evaluate, evaluateCommand, FINISHED_REPLY, formatPrint, helpText, interpret, isScript, newContext, ORDERS_REPLY, parseScript, plainReply,
} from '@deepsea/script'

const user = text => ({ role: 'user', content: [{ type: 'text', text }] })
const assistant = blocks => ({ role: 'assistant', content: blocks })
const toolResult = (toolCallId, text, isError = false) => ({ role: 'tool', toolCallId, isError, content: [{ type: 'text', text }] })
const script = lines => lines.map(l => JSON.stringify(l)).join('\n')

async function collect(options, adapter = new ScriptedAdapter()) {
  const chunks = []
  for await (const c of adapter.stream({ provider: 'scripted', model: 'script', ...options })) chunks.push(c)
  return chunks
}
const blocks = chunks => chunks.filter(c => c.type === 'block-end').map(c => c.block)
const finish = chunks => chunks.at(-1)
const texts = bs => bs.filter(b => b.type === 'text').map(b => b.text)

/**
 * Play a script to the end as the harness would: each response's tool calls run through
 * `run(name, args)` → `{ value, text, isError }`, their results go back, and the model is asked again.
 * @returns {{ messages, replies }} the transcript and each response's blocks
 */
async function playScript(adapter, history, run = () => ({ text: 'ok' })) {
  const messages = [...history]
  const replies = []
  for (let round = 0; round < 50; round++) {
    const bs = blocks(await collect({ messages }, adapter))
    replies.push(bs)
    messages.push({ ...assistant(bs), id: `a-${messages.length}` })
    const calls = bs.filter(b => b.type === 'tool-call')
    if (calls.length === 0) return { messages, replies }
    for (const call of calls) {
      const exec = { callId: call.id, name: call.name, arguments: JSON.parse(call.arguments) }
      adapter.callStarted(exec)
      const { value = null, text, isError = false } = run(call.name, exec.arguments)
      adapter.callFinished(exec, isError ? { isError, error: { message: text }, content: [] } : { isError, value, content: [] })
      messages.push(toolResult(call.id, text, isError))
    }
  }
  throw new Error('the script did not finish')
}

/** The ops a script's run yields with an empty context, tool results recorded as nothing. */
const ops = lines => [...interpret(parseScript(script(lines)).commands, newContext())].map(a => a.op === 'suspend' ? '|' : `${a.op}:${a.key}`)

// ---- prompts and parsing -----------------------------------------------------------------------

test('plain prompts: say <text> echoes one line, help lists the commands', async () => {
  assert.equal(plainReply('say XXXX YYY ZZZ'), 'XXXX YYY ZZZ')
  assert.equal(plainReply('  Say  hello there  '), 'hello there')
  assert.equal(plainReply('say one\ntwo'), ORDERS_REPLY)
  assert.equal(plainReply('say'), ORDERS_REPLY)
  assert.equal(plainReply('sayonara'), ORDERS_REPLY)
  const help = helpText()
  assert.equal(plainReply(' HELP '), help)
  for (const cmd of ['say', 'think', 'print', 'tool', 'batch', 'expect', 'loop', 'save', 'sleep', 'usage', 'error', 'end', 'title']) assert.match(help, new RegExp(`\\| \`\\{"cmd":"${cmd}"\\}\` \\|`))
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
    '{"cmd": "loop", "values": "locals.xs", "body": [{"cmd": "say"}, {"cmd": "nope"}, 3]}',
    '{"cmd": "expect", "matches": "("}',
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
    'line 11, body[0]: say needs "text"',
    'line 11, body[1]: unknown cmd "nope"',
    'line 11, body[2]: not a command',
    'line 12: expect "matches" must be …',
  ])
})

test('placement rules: end last, one title, nothing nested that cannot be, unique tool ids', () => {
  const errs = lines => parseScript(script(lines)).errors
  assert.match(errs([{ cmd: 'end' }, { cmd: 'say', text: 'x' }])[0], /line 1: end must be the last/)
  assert.match(errs([{ cmd: 'title', text: 'a' }, { cmd: 'title', text: 'b' }])[0], /line 2: only one title/)
  assert.match(errs([{ cmd: 'tool', name: 'a', id: 'x' }, { cmd: 'tool', name: 'b', id: 'x' }])[0], /used twice/)
  assert.match(errs([{ cmd: 'loop', values: 'locals.x', body: { cmd: 'tool', name: 'a', id: 'x' } }, { cmd: 'tool', name: 'b', id: 'x' }])[0], /line 2: tool id "x" is used twice/)
  assert.match(errs([{ cmd: 'loop', values: 'locals.x', body: [{ cmd: 'end' }] }])[0], /line 1, body\[0\]: end cannot be inside a loop/)
  assert.match(errs([{ cmd: 'batch', cmds: [{ cmd: 'title', text: 't' }] }])[0], /line 1, cmds\[0\]: title cannot be inside a batch/)
  assert.match(errs([{ cmd: 'batch', cmds: [{ cmd: 'loop', values: 'locals.x', body: { cmd: 'batch', cmds: [{ cmd: 'say', text: 'x' }] } }] }])[0], /line 1, cmds\[0\].body: a batch cannot be inside a batch/)
  assert.match(errs([{ cmd: 'expect' }])[0], /expect needs "equals", "contains" or "matches"/)
  // expect goes anywhere: it reads the context.
  assert.deepEqual(errs([{ cmd: 'expect', value: 'globals.x', equals: 1 }, { cmd: 'say', text: 'x' }, { cmd: 'expect', contains: 'y' }, { cmd: 'end' }]), [])
})

test('an invalid script fails the request with an API error listing the problems', async () => {
  await assert.rejects(collect({ messages: [user('{"cmd": "sya"}\n{"cmd": "say"}')] }), (error) => {
    assert.equal(error.code, 'SCRIPT_INVALID')
    assert.equal(error.failure.status, 400)
    assert.match(error.message, /line 1: unknown cmd "sya"[\s\S]*line 2: say needs "text"/)
    return true
  })
})

// ---- how a script runs across responses ---------------------------------------------------------

test('a tool call ends the response; a batch sends its tool calls together', () => {
  assert.deepEqual(chunk('abcdefg', 3), ['abc', 'def', 'g'])
  assert.deepEqual(ops([{ cmd: 'title', text: 't' }, { cmd: 'think', text: 'a' }, { cmd: 'tool', name: 'x' }, { cmd: 'tool', name: 'y', id: 'y' }, { cmd: 'say', text: 'b' }]),
    ['think:2', 'tool:3', '|', 'tool:y', '|', 'say:5'])
  assert.deepEqual(ops([{ cmd: 'batch', cmds: [{ cmd: 'say', text: 'a' }, { cmd: 'tool', name: 'x' }, { cmd: 'sleep', time: 0 }, { cmd: 'tool', name: 'y' }] }, { cmd: 'say', text: 'b' }]),
    ['say:1_0', 'tool:1_1', 'sleep:1_2', 'tool:1_3', '|', 'say:2'])
  // A batch without tool calls does not end the response.
  assert.deepEqual(ops([{ cmd: 'batch', cmds: [{ cmd: 'say', text: 'a' }] }, { cmd: 'say', text: 'b' }]), ['say:1_0', 'say:2'])
})

test('a script plays across responses: text, reasoning, a batch of tool calls, then the rest after the results', async () => {
  const text = script([
    { cmd: 'think', text: 'plan' }, { cmd: 'say', text: 'Looking.', chunks: 3 },
    { cmd: 'batch', cmds: [{ cmd: 'tool', name: 'bash', args: { command: 'ls' }, id: 'ls' }, { cmd: 'tool', name: 'read', args: { path: 'a' } }] },
    { cmd: 'expect', value: 'tools.ls.text', contains: 'README' }, { cmd: 'say', text: 'Done.' },
  ])
  const first = await collect({ messages: [user(text)] })
  assert.deepEqual(first.filter(c => c.type === 'text-delta').map(c => c.text), ['Loo', 'kin', 'g.'])
  const calls = blocks(first).filter(b => b.type === 'tool-call')
  assert.deepEqual(blocks(first).map(b => b.type), ['reasoning', 'text', 'tool-call', 'tool-call'])
  assert.deepEqual(calls.map(c => [c.name, JSON.parse(c.arguments)]), [['bash', { command: 'ls' }], ['read', { path: 'a' }]])
  assert.match(calls[0].id, /^scripted-[0-9a-f]{12}-0-ls$/)
  assert.match(calls[1].id, /^scripted-[0-9a-f]{12}-0-3_1$/)
  assert.deepEqual(finish(first).reason, { kind: 'tool-calls' })
  // The same transcript gives the same ids.
  assert.deepEqual(blocks(await collect({ messages: [user(text)] })).filter(b => b.type === 'tool-call').map(c => c.id), calls.map(c => c.id))

  const history = [user(text), assistant(blocks(first)), toolResult(calls[0].id, 'README.md\nsrc'), toolResult(calls[1].id, 'contents')]
  const second = await collect({ messages: history })
  assert.deepEqual(blocks(second), [{ type: 'text', text: 'Done.' }])
  assert.deepEqual(finish(second).reason, { kind: 'stop' })

  const failing = [user(text), assistant(blocks(first)), toolResult(calls[0].id, 'nothing here'), toolResult(calls[1].id, 'x')]
  await assert.rejects(collect({ messages: failing }), (e) => {
    assert.equal(e.code, 'SCRIPT_EXPECTATION')
    assert.equal(e.message, 'line 4: expected tools.ls.text to contain "README"; got "nothing here"')
    return true
  })

  // A script ending in tool calls says it is finished once their results are in.
  const toolOnly = script([{ cmd: 'tool', name: 'bash', args: {} }])
  const call = blocks(await collect({ messages: [user(toolOnly)] }))[0]
  assert.deepEqual(blocks(await collect({ messages: [user(toolOnly), assistant([call]), toolResult(call.id, 'ok')] })), [{ type: 'text', text: FINISHED_REPLY }])
})

test('expect: equals any JSON, contains and matches text, the last tool text by default', async () => {
  const adapter = new ScriptedAdapter()
  const ok = script([
    { cmd: 'tool', name: 'bash', id: 'b' },
    { cmd: 'expect', contains: 'hello' },
    { cmd: 'expect', value: 'tools.b.text', matches: '^hel+o' },
    { cmd: 'expect', value: 'tools.b.result', equals: { n: 1, list: [1, 2] } },
    { cmd: 'expect', value: 'tools.b.ok', equals: true },
    { cmd: 'say', text: 'fine' },
  ])
  const { replies } = await playScript(adapter, [user(ok)], () => ({ value: { list: [1, 2], n: 1 }, text: 'hello world' }))
  assert.deepEqual(texts(replies.at(-1)), ['fine'])
  const fails = async (expect, message) => {
    const lines = script([{ cmd: 'tool', name: 'bash', id: 'b' }, expect])
    await assert.rejects(playScript(new ScriptedAdapter(), [user(lines)], () => ({ value: { n: 1 }, text: 'hello', isError: true })), e => e.code === 'SCRIPT_EXPECTATION' && e.message === message)
  }
  await fails({ cmd: 'expect', value: 'tools.b.ok', equals: true }, 'line 2: expected tools.b.ok to equal true; got false')
  await fails({ cmd: 'expect', value: 'tools.b.error', contains: 'x' }, 'line 2: expected tools.b.error to be a string that contains "x"; got an object, {"message":"hello"}')
  await fails({ cmd: 'expect', value: 'tools.c.text', contains: 'x' }, 'line 2: expected tools.c.text to be there; "tools.c.text": no "c" in tools (it has "last", "bash", "b")')
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
  await assert.rejects(collect({ messages }, adapter), e => e.code === 'SERVER' && e.failure.status === 529)
  assert.deepEqual(blocks(await collect({ messages }, adapter)), [{ type: 'text', text: 'second try' }])
  // Replaying earlier responses never fires an error again: the response that got past it is in the transcript.
  const later = script([{ cmd: 'error', kind: 'server', times: 1 }, { cmd: 'tool', name: 'bash' }, { cmd: 'say', text: 'after' }])
  const once = new ScriptedAdapter()
  await assert.rejects(collect({ messages: [user(later)] }, once))
  const { replies } = await playScript(once, [user(later)])
  assert.deepEqual(texts(replies.at(-1)), ['after'])
})

test('side calls: titles and compaction get fixed answers; a script may set its title', async () => {
  const adapter = new ScriptedAdapter()
  const call = async options => blocks(await collect(options, adapter))[0].text
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

test('the same script sent again gets tool-call ids of its own (the client keys a row by its id)', async () => {
  const text = script([{ cmd: 'tool', name: 'bash', args: { command: 'true' } }])
  const ids = async messageId => blocks(await collect({ messages: [{ ...user(text), id: messageId }] })).find(b => b.type === 'tool-call').id
  const [first, again, same] = [await ids('m-1'), await ids('m-2'), await ids('m-1')]
  assert.notEqual(first, again)
  assert.equal(first, same, 'stable for one prompt, so expect lines and retries agree')
})

// ---- values: $value$, $splat$, save, the JSON context ------------------------------------------

test('value expressions: paths, load, toString, stringSub, literal, range, splats', () => {
  const context = { tools: { bash: { result: { jobId: 'bash-1', list: [1, 2] } } }, locals: { n: 3, extra: { b: 2 }, more: [3, 4] }, globals: {} }
  assert.equal(evaluate({ $value$: 'tools.bash.result.jobId' }, context), 'bash-1')
  assert.equal(evaluate({ $value$: 'tools.bash.result.list.1' }, context), 2)
  assert.equal(evaluate({ $value$: { type: 'load', path: 'locals.n' } }, context), 3)
  assert.equal(evaluate({ $value$: { type: 'toString', value: 'locals.n' } }, context), '3')
  assert.equal(evaluate({ $value$: { type: 'toString', value: 'tools.bash.result.jobId' } }, context), 'bash-1')
  assert.equal(evaluate({ $value$: { type: 'stringSub', str: 'kill JOB; echo JOB', lhs: 'JOB', rhs: 'tools.bash.result.jobId' } }, context), 'kill bash-1; echo bash-1')
  assert.deepEqual(evaluate({ $value$: { type: 'literal', value: { $value$: 'not evaluated' } } }, context), { $value$: 'not evaluated' })
  assert.deepEqual(evaluate({ a: 1, $splat$: 'locals.extra', c: [0, { $splat$: 'locals.more' }, 5] }, context), { a: 1, b: 2, c: [0, 3, 4, 5] })
  assert.deepEqual(evaluate({ $value$: { type: 'range', stop: 5 } }, context), [0, 1, 2, 3, 4])
  assert.deepEqual(evaluate({ $value$: { type: 'range', start: 10, stop: 0, step: -3 } }, context), [10, 7, 4, 1])
  assert.deepEqual(evaluate({ $value$: { type: 'range', start: 'locals.n', stop: 3 } }, context), [])
  assert.deepEqual(evaluate({ $value$: { type: 'range', stop: { type: 'load', path: 'locals.n' } } }, context), [0, 1, 2])
  // What a path loads is data: it is not evaluated again.
  assert.deepEqual(evaluate({ x: { $value$: 'locals.y' } }, { ...context, locals: { y: { $value$: 'locals.n' } } }), { x: { $value$: 'locals.n' } })
  assert.throws(() => evaluate({ job: { $value$: 'tools.bsh.result' } }, context), /job: "tools.bsh.result": no "bsh" in tools \(it has "bash"\)/)
  assert.throws(() => evaluate({ $value$: 'locals.n.x' }, context), /locals.n is a number, not an object/)
  assert.throws(() => evaluate({ $splat$: 'locals.n' }, context), /must give an object, not a number/)
  assert.throws(() => evaluate([{ $splat$: 'locals.extra' }], context), /must give a list, not an object/)
  assert.throws(() => evaluate({ $value$: { type: 'range', stop: 'locals.extra' } }, context), /range "stop" must be a whole number, not an object/)
  assert.throws(() => evaluate({ $value$: { type: 'range', stop: 1e6 } }, context), /more than 10000/)
})

test('values are checked when the script is parsed; fields they fill are checked once evaluated', () => {
  const errs = lines => parseScript(script(lines)).errors
  assert.deepEqual(errs([
    { cmd: 'say', text: { $value$: 'locals.greeting' } },
    { cmd: 'tool', name: 'bash', args: { $splat$: 'locals.args', command: { $value$: { type: 'toString', value: 'locals.c' } } } },
    { cmd: 'save', locals: { a: 'tools.last.result', b: { type: 'literal', value: [1] }, $splat$: 'globals' }, globals: { c: { $value$: 'locals.a' } } },
    { cmd: 'say', $splat$: 'locals.sayFields' },
    { cmd: 'loop', values: { type: 'range', stop: 3 }, body: { cmd: 'say', text: { $value$: { type: 'toString', value: 'loop.this.index' } } } },
  ]), [])
  assert.deepEqual(errs([
    { cmd: 'say', text: { $value$: '' } },
    { cmd: 'say', text: { $value$: 3 } },
    { cmd: 'say', text: { $value$: { type: 'nope' } } },
    { cmd: 'say', text: { $value$: { type: 'stringSub', str: 's', lhs: '' } } },
    { cmd: 'tool', name: 'x', id: { $value$: 'locals.id' } },
    { cmd: 'save', locals: { 'a.b': 'x' } },
    { cmd: 'say', text: { $value$: 'a..b' }, extra: 1 },
    { cmd: 'loop', values: { type: 'range', stop: 2, step: 0 }, body: { cmd: 'say', text: 'x' }, limit: { $value$: 'locals.n' } },
    { cmd: 'loop', values: 3, body: { cmd: 'say', text: 'x' }, id: 'this' },
  ]).map(e => e.replace(/ \(.*$/, '')), [
    'line 1: text: a path cannot be empty',
    'line 2: text: a value is a path string or an object with "type"',
    'line 3: text: value "type" must be one of load, toString, stringSub, literal, range',
    'line 4: text: stringSub needs "rhs"',
    'line 4: text: stringSub "lhs" cannot be empty',
    'line 5: tool "id" must be written out, not a value expression',
    'line 6: save locals name "a.b" must be non-empty and without dots',
    'line 7: text: path "a..b" has an empty segment',
    'line 8: loop "limit" must be written out, not a value expression',
    'line 8: values: range "step" cannot be 0',
    'line 9: values: a value is a path string or an object with "type"',
  ])
  assert.match(errs([{ cmd: 'loop', values: 'locals.x', body: { cmd: 'say', text: 'x' }, id: 'this' }])[0], /line 1: loop "id" must be a name without dots, not "this"/)
  // Once evaluated, the command is checked in full.
  const step = parseScript(script([{ cmd: 'say', text: { $value$: 'locals.n' } }])).commands[0]
  assert.deepEqual(evaluateCommand(step, { tools: {}, locals: { n: 'hi' }, globals: {} }), { cmd: 'say', line: 1, ref: '1', text: 'hi' })
  assert.throws(() => evaluateCommand(step, { tools: {}, locals: { n: 3 }, globals: {} }), /line 1: say "text" must be a string/)
})

const jobs = (name, args) => name === 'bash'
  ? { value: { kind: 'background', jobId: 'bash-fde989378ba84567', cwd: '/w' }, text: 'started background job bash-fde989378ba84567' }
  : { value: { status: 'done', jobId: args.job_id }, text: `job ${args.job_id}: done` }

test('one script: a tool call reads the job id an earlier call returned', async () => {
  const adapter = new ScriptedAdapter()
  const text = script([
    { cmd: 'tool', name: 'bash', args: { command: 'sleep 120; echo done', run_in_background: true }, id: 'bash' },
    { cmd: 'tool', name: 'job_output', args: { job_id: { $value$: 'tools.bash.result.jobId' }, wait: true }, id: 'wait' },
    { cmd: 'say', text: { $value$: { type: 'stringSub', str: 'ok=OK', lhs: 'OK', rhs: 'tools.wait.ok' } } },
  ])
  const { messages, replies } = await playScript(adapter, [{ ...user(text), id: 'm-1' }], jobs)
  assert.deepEqual(JSON.parse(replies[1][0].arguments), { job_id: 'bash-fde989378ba84567', wait: true })
  assert.deepEqual(replies[2], [{ type: 'text', text: 'ok=true' }])

  // The context is rebuilt from the transcript, so a retry of the last response gives the same answer.
  assert.deepEqual(blocks(await collect({ messages: messages.slice(0, -1) }, adapter)), replies[2])
  // A process that did not see the calls run (a restart) still has each call's text, args and outcome.
  const probe = script([{ cmd: 'tool', name: 'bash', args: { command: 'x' }, id: 'b' }, { cmd: 'say', text: { $value$: { type: 'toString', value: 'tools.last' } } }])
  const { replies: r } = await playScript(new ScriptedAdapter(), [user(probe)], () => ({ text: 'out' }))
  const seen = JSON.parse(r[1][0].text)
  assert.deepEqual({ ...seen, duration: typeof seen.duration }, { name: 'bash', args: { command: 'x' }, result: null, text: 'out', duration: 'number', error: null, ok: true })
  const restarted = blocks(await collect({ messages: [user(probe), assistant(r[0]), toolResult(r[0][0].id, 'out')] }))
  assert.equal(JSON.parse(restarted[0].text).duration, null)
})

test('tools are recorded under last, the tool name and the id; saves see the context as it was', async () => {
  const text = script([
    { cmd: 'save', locals: { a: { type: 'literal', value: 1 }, b: { type: 'literal', value: 2 } } },
    { cmd: 'save', locals: { a: 'locals.b', b: 'locals.a' } },
    { cmd: 'batch', cmds: [{ cmd: 'tool', name: 'bash', args: { $splat$: 'locals', command: 'one' }, id: 'first' }, { cmd: 'tool', name: 'bash', args: { command: 'two' } }] },
    { cmd: 'save', locals: { keys: { type: 'toString', value: 'tools.first.args' } } },
    { cmd: 'say', text: { $value$: { type: 'stringSub', str: 'args=A', lhs: 'A', rhs: 'locals.keys' } } },
    { cmd: 'say', text: { $value$: 'tools.last.args.command' } },
    { cmd: 'say', text: { $value$: 'tools.bash.args.command' } },
  ])
  const { replies } = await playScript(new ScriptedAdapter(), [user(text)], (name, args) => ({ value: args, text: args.command }))
  assert.deepEqual(JSON.parse(replies[0][0].arguments), { a: 2, b: 1, command: 'one' })
  assert.deepEqual(texts(replies[1]), ['args={"a":2,"b":1,"command":"one"}', 'two', 'two'])
})

test('globals outlive the script; locals and tools do not', async () => {
  const adapter = new ScriptedAdapter()
  const first = script([
    { cmd: 'tool', name: 'bash', args: { command: 'sleep 120; echo done', run_in_background: true } },
    { cmd: 'save', globals: { sleep_id: 'tools.last.result.jobId' }, locals: { mine: { type: 'literal', value: 1 } } },
  ])
  const one = await playScript(adapter, [{ ...user(first), id: 'm-1' }], jobs)
  assert.deepEqual(one.replies.at(-1), [{ type: 'text', text: FINISHED_REPLY }])
  const second = script([{ cmd: 'tool', name: 'job_output', args: { job_id: { $value$: 'globals.sleep_id' }, wait: true }, id: 'wait' }])
  const two = await playScript(adapter, [...one.messages, { ...user(second), id: 'm-2' }], jobs)
  assert.deepEqual(JSON.parse(two.replies[0][0].arguments), { job_id: 'bash-fde989378ba84567', wait: true })
  const third = script([{ cmd: 'say', text: { $value$: 'locals.mine' } }])
  await assert.rejects(collect({ messages: [...two.messages, user(third)] }), e => e.code === 'SCRIPT_VALUE' && /line 1: text: "locals.mine": no "mine" in locals \(it is empty\)/.test(e.message))
})

test('a value that cannot be evaluated fails the request with SCRIPT_VALUE and its line', async () => {
  await assert.rejects(collect({ messages: [user(script([{ cmd: 'say', text: 'x' }, { cmd: 'tool', name: 'job_output', args: { job_id: { $value$: 'tools.bash.result.jobId' } } }]))] }), (e) => {
    assert.equal(e.code, 'SCRIPT_VALUE')
    assert.equal(e.failure.status, 400)
    assert.match(e.message, /^line 2: args.job_id: "tools.bash.result.jobId": no "bash" in tools \(it is empty\)$/)
    return true
  })
  await assert.rejects(collect({ messages: [user(script([{ cmd: 'save', globals: { x: 'locals.none' } }]))] }), /line 1: globals.x: "locals.none": no "none"/)
  await assert.rejects(collect({ messages: [user(script([{ cmd: 'loop', values: 'globals', body: { cmd: 'say', text: 'x' } }]))] }), /line 1: loop "values" must give a list, not an object/)
})

// ---- loops --------------------------------------------------------------------------------------

test('a loop runs its body per item: loop.this and loop.<id>, limit, nesting, scope', async () => {
  const text = script([
    { cmd: 'loop', values: { type: 'literal', value: ['a', 'b', 'c'] }, id: 'outer', limit: 2, body: [
      { cmd: 'loop', values: { type: 'range', stop: 2 }, body: { cmd: 'say', text: { $value$: { type: 'toString', value: { type: 'literal', value: 'x' } } } } },
      { cmd: 'say', text: { $value$: { type: 'toString', value: 'loop.this' } } },
      { cmd: 'loop', values: { type: 'range', start: 1, stop: 2 }, id: 'inner', body: { cmd: 'say', text: { $value$: { type: 'stringSub', str: 'O/I', lhs: 'O', rhs: { type: 'stringSub', str: 'V', lhs: 'V', rhs: 'loop.outer.value' } } } } },
    ] },
    { cmd: 'save', locals: { $splat$: 'loop' } },
    { cmd: 'say', text: { $value$: { type: 'toString', value: 'locals' } } },
  ])
  const said = texts(blocks(await collect({ messages: [user(text)] })))
  assert.deepEqual(said, [
    'x', 'x', '{"id":"outer","index":0,"value":"a","count":2,"last":false}', 'a/I',
    'x', 'x', '{"id":"outer","index":1,"value":"b","count":2,"last":true}', 'b/I',
    // After the loops, neither loop.this nor loop.outer is left.
    '{}',
  ])
})

test('a loop of tool calls: one response per call, or one response for all inside a batch; delay sleeps between', async () => {
  const run = (name, args) => ({ value: args, text: `ran ${args.n}` })
  const sequential = script([
    { cmd: 'loop', values: { type: 'range', stop: 3 }, id: 'i', body: { cmd: 'tool', name: 'bash', id: 'b', args: { n: { $value$: 'loop.i.index' } } } },
    { cmd: 'expect', value: 'tools.b.text', equals: 'ran 2' },
    { cmd: 'say', text: 'done' },
  ])
  const one = await playScript(new ScriptedAdapter(), [user(sequential)], run)
  assert.deepEqual(one.replies.map(r => r.map(b => b.type === 'tool-call' ? `${JSON.parse(b.arguments).n}:${b.id.replace(/^scripted-\w+-/, '')}` : b.text)), [['0:0-b-0'], ['1:1-b-1'], ['2:2-b-2'], ['done']])

  const parallel = script([
    { cmd: 'batch', cmds: [{ cmd: 'loop', values: { type: 'range', stop: 3 }, delay: 0.05, body: { cmd: 'tool', name: 'bash', args: { n: { $value$: 'loop.this.value' } } } }] },
    { cmd: 'say', text: { $value$: 'tools.last.text' } },
  ])
  const started = Date.now()
  const all = await playScript(new ScriptedAdapter(), [user(parallel)], run)
  assert.ok(Date.now() - started >= 90, 'two delays of 0.05 s')
  assert.deepEqual(all.replies.map(r => r.map(b => b.type === 'tool-call' ? b.id.replace(/^scripted-\w+-/, '') : b.text)), [['0-1_0_0-0', '0-1_0_0-1', '0-1_0_0-2'], ['ran 2']])
})

test('a loop over values a tool returned', async () => {
  const text = script([
    { cmd: 'tool', name: 'list', id: 'list' },
    { cmd: 'loop', values: 'tools.list.result.jobs', body: { cmd: 'tool', name: 'job_output', args: { job_id: { $value$: 'loop.this.value' } } } },
    { cmd: 'say', text: 'all done' },
  ])
  const { replies } = await playScript(new ScriptedAdapter(), [user(text)], (name, args) => name === 'list' ? { value: { jobs: ['j1', 'j2'] }, text: 'two jobs' } : { text: `${args.job_id} done` })
  assert.deepEqual(replies.map(r => r.map(b => b.type === 'tool-call' ? JSON.parse(b.arguments).job_id ?? b.name : b.text)), [['list'], ['j1'], ['j2'], ['all done']])
})

// ---- print --------------------------------------------------------------------------------------

test('print formats a value: a string as it is, anything else as indented JSON, fenced, cut at maxChars', () => {
  assert.equal(formatPrint({ a: [1, 2] }), '```json\n{\n  "a": [\n    1,\n    2\n  ]\n}\n```')
  assert.equal(formatPrint('line one\nline two', { prefix: 'Output:' }), 'Output:\n```\nline one\nline two\n```')
  assert.equal(formatPrint('has ``` and ````` inside'), '``````\nhas ``` and ````` inside\n``````')
  assert.equal(formatPrint(null), '```json\nnull\n```')
  assert.equal(formatPrint('abcdefghij', { maxChars: 4 }), '```\nabcd\n```\n… (6 more characters)')
})

test('print shows the last tool call by default, any value with a prefix, and fails on a value that is not there', async () => {
  const text = script([
    { cmd: 'tool', name: 'bash', args: { command: 'ls' }, id: 'ls' },
    { cmd: 'print' },
    { cmd: 'loop', values: { type: 'literal', value: ['x'] }, body: { cmd: 'print', value: 'tools.ls.text', prefix: { $value$: { type: 'stringSub', str: 'Item #:', lhs: '#', rhs: 'loop.this.index' } }, chunks: 2 } },
  ])
  const { replies } = await playScript(new ScriptedAdapter(), [user(text)], () => ({ value: { files: ['a'] }, text: 'a\n' }))
  const [record, listing] = texts(replies[1])
  assert.match(record, /^```json\n\{\n {2}"name": "bash",\n {2}"args": \{\n {4}"command": "ls"\n {2}\},\n {2}"result": \{\n {4}"files": \[\n/)
  assert.equal(listing, 'Item 0:\n```\na\n```')
  assert.equal(parseScript(script([{ cmd: 'print', value: '' }])).errors[0], 'line 1: value: a path cannot be empty')
  await assert.rejects(collect({ messages: [user(script([{ cmd: 'print', value: 'locals.nope' }]))] }), e => e.code === 'SCRIPT_VALUE' && e.message === 'line 1: value: "locals.nope": no "nope" in locals (it is empty)')
})

// ---- session.tools: every finished tool call of the conversation ------------------------------

/** A turn answered by another model: its prompt, one tool call and its result. */
function otherModelTurn(adapter, id, name, args, text, value) {
  adapter.callStarted({ callId: id, name, arguments: args })
  adapter.callFinished({ callId: id, name, arguments: args }, { isError: false, value, content: [] })
  return [
    user('run it'),
    { role: 'assistant', source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' }, content: [{ type: 'tool-call', id, name, arguments: JSON.stringify(args) }] },
    toolResult(id, text),
    { role: 'assistant', source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' }, content: [{ type: 'text', text: 'ok' }] },
  ]
}

test('a lone print shows the conversation\'s last tool call; tools stays the script\'s own', async () => {
  const adapter = new ScriptedAdapter()
  const first = await playScript(adapter, [{ ...user(script([{ cmd: 'tool', name: 'bash', args: { command: 'ls' }, id: 'ls' }])), id: 'm-1' }], () => ({ value: { files: ['a'] }, text: 'a\n' }))
  const history = [...first.messages, { ...user(script([{ cmd: 'print' }, { cmd: 'say', text: { $value$: 'session.tools.ls.text' } }])), id: 'm-2' }]
  const [printed, said] = texts(blocks(await collect({ messages: history }, adapter)))
  assert.match(printed, /^```json\n\{\n {2}"name": "bash",\n {2}"args": \{\n {4}"command": "ls"\n {2}\},\n {2}"result": \{\n {4}"files": \[/)
  assert.equal(said, 'a\n')
  // `tools` and the expect default still mean this script's calls only.
  await assert.rejects(collect({ messages: [...first.messages, user(script([{ cmd: 'say', text: { $value$: 'tools.last.text' } }]))] }, adapter),
    e => e.code === 'SCRIPT_VALUE' && /no "last" in tools \(it is empty\)/.test(e.message))
  await assert.rejects(collect({ messages: [...first.messages, user(script([{ cmd: 'expect', contains: 'a' }]))] }, adapter), e => e.code === 'SCRIPT_EXPECTATION')
  // With nothing called yet in the conversation, a lone print says so.
  await assert.rejects(collect({ messages: [user(script([{ cmd: 'print' }]))] }), e => e.code === 'SCRIPT_VALUE' && /"session.tools.last": no "last" in session.tools \(it is empty\)/.test(e.message))
})

test('session.tools holds other models\' calls too, in conversation order, structured results included', async () => {
  const adapter = new ScriptedAdapter()
  const scripted = await playScript(adapter, [{ ...user(script([{ cmd: 'tool', name: 'bash', args: { command: 'one' } }])), id: 'm-1' }], () => ({ value: { n: 1 }, text: 'one' }))
  const other = otherModelTurn(adapter, 'call_9', 'bash', { command: 'sleep 9 &', run_in_background: true }, 'started background job bash-9', { kind: 'background', jobId: 'bash-9' })
  const history = [...scripted.messages, ...other, user(script([
    { cmd: 'say', text: { $value$: 'session.tools.last.result.jobId' } },
    { cmd: 'say', text: { $value$: { type: 'toString', value: 'session.tools.bash.args' } } },
  ]))]
  assert.deepEqual(texts(blocks(await collect({ messages: history }, adapter))), ['bash-9', '{"command":"sleep 9 &","run_in_background":true}'])
})

test('session.tools grows as the script runs, so a replayed response sees what the live one saw', async () => {
  const text = script([
    { cmd: 'tool', name: 'bash', args: { command: 'one' } },
    { cmd: 'save', locals: { first: 'session.tools.last.args.command' } },
    { cmd: 'tool', name: 'bash', args: { command: 'two' } },
    { cmd: 'say', text: { $value$: { type: 'stringSub', str: 'first=F last=L', lhs: 'F', rhs: 'locals.first' } } },
    { cmd: 'say', text: { $value$: 'session.tools.last.args.command' } },
  ])
  const { replies } = await playScript(new ScriptedAdapter(), [user(text)], (name, args) => ({ value: args, text: args.command }))
  assert.deepEqual(texts(replies.at(-1)), ['first=one last=L', 'two'])
})
