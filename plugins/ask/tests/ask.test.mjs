import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  SIDE_MARK, answeredPrefix, buildMessages, describeProgress, exportMarkdown, exportName, mainPosition, questionHeader,
  resolveRoute, runSideQuestion, sideIntro, toolSummary,
} from '../ask.mjs'
import { ThreadStore } from '../thread.mjs'

const system = { role: 'system', content: [{ type: 'text', text: 'You are an agent.' }] }
const user = text => ({ role: 'user', content: [{ type: 'text', text }] })
const said = text => ({ role: 'assistant', content: [{ type: 'text', text }] })
const calls = (...ids) => ({ role: 'assistant', content: ids.map(id => ({ type: 'tool-call', id, name: 'bash', arguments: '{}' })) })
const result = id => ({ role: 'tool', toolCallId: id, content: [{ type: 'text', text: `out ${id}` }] })
const textOf = message => message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')

async function* chunks(...list) { for (const chunk of list) yield chunk }
const stop = { type: 'finish', reason: { kind: 'stop' } }

test('answeredPrefix stops before tool calls still running', () => {
  const complete = [system, user('go'), calls('a', 'b'), result('a'), result('b'), said('done')]
  assert.deepEqual(answeredPrefix(complete), complete)
  const midTurn = [system, user('go'), calls('a'), result('a'), calls('b', 'c'), result('b')]
  assert.deepEqual(answeredPrefix(midTurn), midTurn.slice(0, 4))
  assert.deepEqual(answeredPrefix([]), [])
})

test('describeProgress: what was said, running calls, results already in, clipped', () => {
  assert.equal(describeProgress([]), '')
  const lines = describeProgress([
    { role: 'assistant', content: [
      { type: 'reasoning', text: 'secret' },
      { type: 'text', text: 'Building now.' },
      { type: 'tool-call', id: 'a', name: 'bash', arguments: '{"command":"make"}' },
      { type: 'tool-call', id: 'b', name: 'read', arguments: 'x'.repeat(500) },
    ] },
    { role: 'tool', toolCallId: 'a', content: [{ type: 'text', text: 'ok' }] },
  ]).split('\n')
  assert.deepEqual(lines.slice(1), [
    '- assistant: Building now.',
    '- tool call bash: {"command":"make"}',
    `- tool call read: ${'x'.repeat(400)}\u2026`,
    '- result of bash: ok',
  ])
})

test('resolveRoute: override, then the session header (with effort and temperature), then the agent', () => {
  const session = header => ({ requestHeader: () => header })
  const header = { config: { provider: 'deepseek', model: 'chat', reasoningEffort: 'high', temperature: 0.2, maxTokens: 8000 } }
  const agent = { options: { provider: 'p', model: 'm' } }
  assert.deepEqual(resolveRoute({ provider: 'x', model: 'y' }, session(header), agent), { provider: 'x', model: 'y' })
  assert.deepEqual(resolveRoute({ provider: '', model: '' }, session(header), agent),
    { provider: 'deepseek', model: 'chat', reasoningEffort: 'high', temperature: 0.2 })
  assert.deepEqual(resolveRoute({ provider: '', model: '' }, session(undefined), agent), { provider: 'p', model: 'm' })
  assert.equal(resolveRoute({ provider: '', model: '' }, session(undefined), { options: {} }), undefined)
})

test('mainPosition: the open turn and its step, else the last completed turn', () => {
  const event = (seq, type, data = {}) => ({ seq, type, data })
  assert.deepEqual(mainPosition([]), { turn: 0, step: 0, running: false, seq: -1 })
  const closed = [event(0, 'turn/start', { turn: 1 }), event(1, 'step/start', { turn: 1, step: 1 }), event(2, 'turn/end', { turn: 1 })]
  assert.deepEqual(mainPosition(closed), { turn: 1, step: 0, running: false, seq: 2 })
  const open = [...closed, event(3, 'turn/start', { turn: 2 }), event(4, 'step/start', { turn: 2, step: 1 }), event(5, 'step/start', { turn: 2, step: 2 }), event(6, 'tool/call', {})]
  assert.deepEqual(mainPosition(open), { turn: 2, step: 2, running: true, seq: 6 })
})

test('buildMessages: main prefix unchanged, then the side thread with the intro once, then the question', () => {
  const history = [system, user('go'), calls('a'), result('a'), calls('b')]
  const route = { provider: 'p', model: 'm' }
  const first = buildMessages(history, [], { question: 'what ran?', askedAt: '2026-10-17T12:00:00Z', turn: 1, running: true }, { tools: ['read'], route })
  assert.equal(first.replayed, 4)
  assert.deepEqual(first.messages.slice(0, 4), history.slice(0, 4))
  assert.equal(first.messages.length, 5)
  const question = textOf(first.messages[4])
  assert.ok(question.startsWith(SIDE_MARK))
  assert.match(question, /only these read-only tools here: read\./)
  assert.match(question, /were still running\):\n- tool call bash: \{\}\n\n\[Side question, asked at \d\d:\d\d, while turn 1 was running\]\nwhat ran\?$/)
  assert.equal(first.prompt, question)

  // A follow-up replays the first question exactly as it was sent, so its request repeats the first one up to there.
  const replay = buildMessages(history, [{ question: 'what ran?', answer: 'bash', prompt: first.prompt, askedAt: '2026-10-17T12:00:00Z', turn: 1, running: true }],
    { question: 'and then?', askedAt: '2026-10-17T12:01:00Z', turn: 1, running: true }, { tools: ['read'], route })
  assert.deepEqual(replay.messages.slice(0, 5), first.messages)
  assert.doesNotMatch(replay.prompt, /Side conversation/)

  const earlier = [
    { question: 'q1', answer: 'a1', askedAt: '2026-10-17T11:00:00Z', turn: 1, running: true },
    { question: 'q2', answer: '', askedAt: '2026-10-17T11:30:00Z', turn: 1, running: false },
  ]
  const later = buildMessages([system, user('go'), said('done')], earlier, { question: 'q3', askedAt: '2026-10-17T12:00:00Z', turn: 1, running: false }, { tools: [], route })
  const side = later.messages.slice(later.replayed)
  assert.deepEqual(side.map(message => message.role), ['user', 'assistant', 'user', 'assistant', 'user'])
  assert.ok(textOf(side[0]).startsWith(`${SIDE_MARK}\n`))
  assert.match(textOf(side[0]), /cannot use tools/)
  assert.match(textOf(side[0]), /while turn 1 was running\]\nq1$/)
  assert.equal(textOf(side[1]), 'a1')
  assert.equal(side[1].source.provider, 'p')
  assert.match(textOf(side[2]), /after turn 1\]\nq2$/)
  assert.doesNotMatch(textOf(side[2]), /Side conversation/)
  assert.equal(textOf(side[3]), '(no answer)')
  assert.match(textOf(side[4]), /^\[Side question, asked at \d\d:\d\d, after turn 1\]\nq3$/)
})

test('questionHeader and sideIntro wording', () => {
  assert.match(questionHeader({ askedAt: '2026-10-17T12:00:00Z', turn: 0, running: false }), /before the first turn\]$/)
  assert.match(sideIntro([]), /do not call any/)
})

test('toolSummary picks the telling argument', () => {
  assert.equal(toolSummary({ path: 'src/a.ts', limit: 5 }), 'src/a.ts')
  assert.equal(toolSummary({ files: [{ path: 'a' }, 'b'] }), 'a, b')
  assert.equal(toolSummary({ x: 1 }), '{"x":1}')
  assert.equal(toolSummary(undefined), '{}')
})

function runner(script, extra = {}) {
  const requests = []
  const toolCalls = []
  const updates = []
  return {
    requests, toolCalls, updates,
    run: () => runSideQuestion({
      llm: { stream: (request) => { requests.push(request); return chunks(...script[requests.length - 1]) } },
      runTool: async (call) => { toolCalls.push(call); return { content: [{ type: 'text', text: `contents of ${call.args.path}` }], isError: false } },
      route: { provider: 'p', model: 'm' },
      messages: [system, user('q')],
      tools: [{ name: 'read' }, { name: 'write' }],
      toolHistory: { tools: [], updates: [] },
      allowedTools: ['read'],
      maxAnswerTokens: 500,
      maxToolRounds: 3,
      sessionId: 's1',
      signal: new AbortController().signal,
      onUpdate: state => updates.push(state),
      ...extra,
    }),
  }
}

test('runSideQuestion: a plain answer streams and carries usage', async () => {
  const r = runner([[
    { type: 'reasoning-delta', index: 0, text: 'hmm' },
    { type: 'text-delta', index: 1, text: 'It ran ' },
    { type: 'text-delta', index: 1, text: 'ls.' },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 9000 } },
    stop,
  ]])
  const outcome = await r.run()
  assert.equal(outcome.kind, 'done')
  assert.equal(outcome.answer, 'It ran ls.')
  assert.deepEqual(outcome.usage, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 9000 })
  assert.deepEqual(r.updates.map(update => update.answer), ['It ran', 'It ran ls.'])
  assert.equal(r.requests[0].maxTokens, 500)
  assert.equal(r.requests[0].sessionId, 's1')
  assert.deepEqual(r.requests[0].tools, [{ name: 'read' }, { name: 'write' }])
})

test('runSideQuestion: read-only tools run, others are refused, results go back to the model', async () => {
  const r = runner([
    [
      { type: 'text-delta', index: 0, text: 'Checking.' },
      { type: 'tool-call-delta', index: 1, id: 't1', name: 'read', argumentsDelta: '{"path":"a.ts"}' },
      { type: 'tool-call-delta', index: 2, id: 't2', name: 'write', argumentsDelta: '{"path":"b.ts"}' },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ],
    [{ type: 'text-delta', index: 0, text: 'a.ts exports foo.' }, stop],
  ])
  const outcome = await r.run()
  assert.equal(outcome.kind, 'done')
  assert.equal(outcome.answer, 'Checking.\n\na.ts exports foo.')
  assert.deepEqual(r.toolCalls, [{ id: 't1', name: 'read', args: { path: 'a.ts' } }])
  assert.deepEqual(outcome.tools, [
    { name: 'read', summary: 'a.ts', state: 'ok' },
    { name: 'write', summary: 'b.ts', state: 'refused' },
  ])
  const second = r.requests[1].messages
  assert.equal(second.length, 5)
  assert.equal(second[2].role, 'assistant')
  assert.deepEqual(second[2].content.filter(block => block.type === 'tool-call').map(block => block.id), ['t1', 't2'])
  assert.equal(second[3].role, 'tool')
  assert.equal(second[3].toolCallId, 't1')
  assert.equal(second[4].toolCallId, 't2')
  assert.equal(second[4].isError, true)
  assert.match(textOf(second[4]), /write is not available in side questions\. Available: read\./)
})

test('runSideQuestion: tool rounds are capped', async () => {
  const round = id => [{ type: 'tool-call-delta', index: 0, id, name: 'read', argumentsDelta: '{"path":"x"}' }, { type: 'finish', reason: { kind: 'tool-calls' } }]
  const r = runner([round('a'), round('b'), round('c'), round('d')], { maxToolRounds: 2 })
  const outcome = await r.run()
  assert.equal(r.requests.length, 3)
  assert.equal(outcome.kind, 'done')
  assert.match(outcome.answer, /Stopped after 2 rounds/)
})

test('runSideQuestion: max tokens, errors, cancellation, empty', async () => {
  assert.equal((await runner([[{ type: 'text-delta', index: 0, text: 'part' }, { type: 'finish', reason: { kind: 'max-tokens' } }]]).run()).answer, 'part\n\n[truncated]')
  assert.deepEqual(await runner([[{ type: 'finish', reason: { kind: 'error', failure: { message: 'overloaded', code: 'SERVER' } } }]]).run(),
    { kind: 'error', error: 'overloaded', answer: '', tools: [], usage: {} })
  assert.equal((await runner([[{ type: 'text-delta', index: 0, text: 'so far' }, { type: 'finish', reason: { kind: 'aborted', failure: { message: 'x', code: 'ABORTED' } } }]]).run()).kind, 'cancelled')
  assert.equal((await runner([[stop]]).run()).error, 'The model returned no answer.')
})

test('export: file name and Markdown', () => {
  const now = new Date(2026, 9, 17, 15, 4)
  assert.equal(exportName('session-1', now), 'asks-session-1-2026-10-17.md')
  const markdown = exportMarkdown('session-1', [
    { question: 'what ran?', askedAt: new Date(2026, 9, 17, 14, 40).toISOString(), turn: 2, step: 1, running: true, model: 'flash',
      status: 'done', answer: 'It ran **ls**.', tools: [{ name: 'glob', summary: '*', state: 'ok' }, { name: 'write', summary: 'a', state: 'refused' }] },
    { question: 'two\nlines', askedAt: new Date(2026, 9, 17, 14, 50).toISOString(), turn: 2, step: 0, running: false,
      status: 'error', answer: '', error: 'overloaded', tools: [] },
  ], now)
  assert.equal(markdown, [
    '# Side questions', '', 'Session `session-1`, exported 2026-10-17 15:04.', '',
    '---', '', '## what ran?', '', '*turn 2, step 1 · 2026-10-17 14:40 · flash*', '',
    '- `glob` *', '- `write` a (refused)', '', 'It ran **ls**.', '',
    '---', '', '## two', '', '*after turn 2 · 2026-10-17 14:50*', '', '> two', '> lines', '', '*Failed: overloaded*',
  ].join('\n') + '\n')
})

test('ThreadStore: add, update, persist, reload, clear', () => {
  const directory = mkdtempSync(join(tmpdir(), 'deepsea-ask-test-'))
  try {
    const store = new ThreadStore(directory)
    const exchange = store.add('session-1', { question: 'q', turn: 2 })
    assert.equal(exchange.status, 'answering')
    store.update('session-1', exchange.id, { answer: 'partial' })
    const onDisk = JSON.parse(readFileSync(join(directory, 'session-1.json'), 'utf8'))
    assert.equal(onDisk.exchanges[0].answer, '')
    const before = store.snapshot('session-1').version
    store.update('session-1', exchange.id, { status: 'done', answer: 'a' }, true)
    assert.ok(store.snapshot('session-1').version > before)

    const reloaded = new ThreadStore(directory)
    assert.equal(reloaded.snapshot('session-1').exchanges[0].answer, 'a')
    reloaded.add('session-1', { question: 'unfinished' })
    const restarted = new ThreadStore(directory).snapshot('session-1').exchanges
    assert.equal(restarted[1].status, 'error')

    store.clear('session-1')
    assert.equal(store.snapshot('session-1').exchanges.length, 0)
    assert.equal(existsSync(join(directory, 'session-1.json')), false)
    assert.throws(() => store.get('../etc'), /invalid session id/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
