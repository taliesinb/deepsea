/**
 * Offline integration, against the harness build. From the repository root:
 *
 *   (cd harness && node --import tsx/esm --test "$OLDPWD/plugins/prompt-excision/tests/integration.mjs")
 *
 * All core runtime imports use the checkout's source plane, including Cordis:
 * mixing source AgentLoop with built Session/Scope produces distinct identities.
 * No live home, credentials, persistence plugin, server, or network is used.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '../../../harness/vendor/cordis/src/index.ts'
import Loader from '../../../harness/vendor/loader/src/index.ts'
import Include from '../../../harness/vendor/include/src/index.ts'
import AgentRegistry, { installModelSelection } from '../../../harness/packages/core/agent/src/index.ts'
import AgentLoop from '../../../harness/packages/core/agent-loop/src/index.ts'
import LlmRuntime, { LlmAdapter, createUserMessage } from '../../../harness/packages/llm/llm/src/index.ts'
import SessionStore, { Session, SessionId } from '../../../harness/packages/core/session/src/index.ts'
import Projections from '../../../harness/packages/session/session-projection/src/index.ts'
import SystemPrompt, { renderPrompt } from '../../../harness/packages/core/system-prompt/src/index.ts'
import Tools, { defineContentToolFixture } from '../../../harness/packages/core/tools/src/index.ts'
import * as Excision from '../index.js'

const marker = 'DeepSeek Harness'
const oauth = 'anthropic-oauth'
const plain = 'anthropic'
const model = 'offline-fixture-model'
const userText = 'User-provided DeepSeek Harness text must remain verbatim.'
const runtimeText = 'Runtime-context DeepSeek Harness text must remain verbatim.'
const toolDescription = 'Describe DeepSeek Harness without altering the tool schema.'
const identity = 'You are an AI agent powered by DeepSeek Harness.'
const sourceParagraph = 'SOURCE-PARAGRAPH-BEGIN: inspect DeepSeek Harness sources.\nSOURCE-PARAGRAPH-END: this entire instruction belongs to the branded paragraph.'
const webParagraph = 'WEB-PARAGRAPH-BEGIN: use the DeepSeek Harness GUI.\nWEB-PARAGRAPH-END: remove this continuation too.'
const kept = [
  'Keep the unbranded instruction before the source paragraph.',
  'Keep the unbranded instruction after the source paragraph.\nKeep this second line too.',
  'Keep the unbranded instruction before the GUI paragraph.',
  'Keep the unbranded instruction after the GUI paragraph.',
  'Case-sensitive counterexample: deepseek harness remains.',
  'Inserted variable value stays literal: {{not_a_registered_variable}}.',
  'Non-interpolating section stays literal: {{another_unknown_variable}}.',
]
const expectedPrompt = kept.join('\n\n')

class OfflineAdapter extends LlmAdapter {
  constructor(ctx) { super(); this.ctx = ctx; this.requests = [] }
  async resolveModel(provider, id) { return { provider, id, name: id } }
  async * stream(request) {
    const subject = this.ctx.agents.get(request.sessionId)
    // Capture at the adapter boundary, before its reply enters the event log.
    // Replay below is detached from both the live projection and request history.
    this.requests.push({
      provider: request.provider,
      system: request.system,
      messages: structuredClone(request.messages),
      tools: structuredClone(request.tools),
      sessionId: subject.id,
      events: structuredClone(subject.session.snapshotEvents()),
    })
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'offline reply' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'offline reply' } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function harness(t, { branded = true } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'deepsea-prompt-excision-test-'))
  const ctx = new Context()
  t.after(async () => {
    try { await ctx.fiber.dispose() } finally { await rm(home, { recursive: true, force: true }) }
  })
  const adapter = new OfflineAdapter(ctx)
  const downstream = []
  const assembled = []
  const modules = new Map([
    ['fixture-llm', LlmRuntime],
    ['fixture-sessions', SessionStore],
    ['fixture-projections', Projections],
    ['fixture-system-prompt', SystemPrompt],
    ['fixture-tools', Tools],
    ['fixture-agents', AgentRegistry],
    ['fixture-loop', AgentLoop],
    ['fixture-contributions', {
      name: 'fixture-contributions', inject: ['systemPrompt', 'tools', 'llm'],
      apply(scoped) {
        scoped.llm.registerAdapter([oauth, plain], adapter)
        scoped.systemPrompt.variable('fixture_brand', () => marker)
        scoped.systemPrompt.variable('fixture_literal', () => '{{not_a_registered_variable}}')
        scoped.systemPrompt.section({ name: 'fixture:source', order: 10, text: [
          kept[0],
          ...(branded ? [sourceParagraph.replace(marker, '{{fixture_brand}}')] : []),
          kept[1],
        ].join('\n\n') })
        scoped.systemPrompt.section({ name: 'fixture:gui', order: 20, text: [
          kept[2], ...(branded ? [webParagraph] : []), kept[3], kept[4],
          'Inserted variable value stays literal: {{fixture_literal}}.',
        ].join('\n\n') })
        scoped.systemPrompt.section({ name: 'fixture:literal', order: 30, text: kept[6], interpolate: false })
        scoped.systemPrompt.context({ name: 'fixture:runtime', order: 1, text: runtimeText })
        scoped.tools.register(defineContentToolFixture({
          name: 'marker_tool', description: toolDescription, parameters: {},
          execute: async () => { throw new Error('This test must never execute a tool') },
        }))
        scoped.on('system-prompt/assemble', async (_input, _context, next) => {
          const result = await next()
          downstream.push(result)
          return result
        })
      },
    }],
    ['@deepsea/prompt-excision', Excision],
  ])
  const rows = [
    { id: 'llm', name: 'fixture-llm' },
    { id: 'sessions', name: 'fixture-sessions' },
    { id: 'projections', name: 'fixture-projections' },
    { id: 'prompt', name: 'fixture-system-prompt', config: { includeHarnessIdentity: branded, personaPrefix: '', personaSuffix: '' } },
    { id: 'tools', name: 'fixture-tools', config: { mode: 'native' } },
    { id: 'agents', name: 'fixture-agents' },
    { id: 'loop', name: 'fixture-loop', config: { agents: [] } },
    { id: 'contributions', name: 'fixture-contributions' },
    { id: 'deepsea-prompt-excision', name: '@deepsea/prompt-excision', config: { providers: { [oauth]: [marker] } } },
  ]
  const path = join(home, 'cordis.yml')
  // JSON is valid YAML, and the real Include service must parse and mount it.
  await writeFile(path, JSON.stringify(rows))
  ctx.baseUrl = pathToFileURL(home).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = { version: 'v2', async import(specifier) {
    assert.ok(modules.has(specifier), `Unexpected Loader module: ${specifier}`)
    return modules.get(specifier)
  } }
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
  await ctx.loader.await()
  for (const plugin of [LlmRuntime, SessionStore, Projections, SystemPrompt, Tools, AgentRegistry, AgentLoop, Excision]) {
    const runtime = ctx.registry.get(plugin)
    assert.ok(runtime && [...runtime.fibers].some(fiber => fiber.state === 2),
      `${plugin.name}: real Loader plugin must activate; optional injectors may remain pending`)
  }
  assert.ok(ctx.get('agentLoop'))
  assert.equal(Excision.name, 'deepsea-prompt-excision')
  assert.deepEqual(Excision.inject, ['systemPrompt'])
  const excisionRuntime = ctx.registry.get(Excision)
  assert.ok(excisionRuntime, 'Loader must mount the actual plugin module')
  const excisionFibers = [...excisionRuntime.fibers]
  assert.equal(excisionFibers.length, 1)
  ctx.on('system-prompt/assemble', async (_input, _context, next) => {
    const result = await next()
    assembled.push(result)
    return result
  }, { prepend: true })
  let id = 0
  async function createAgent(provider = oauth) {
    return ctx.agentLoop.create(SessionId(`excision-fixture-${++id}`), { provider, model }, { cwd: home })
  }
  async function send(agent, text = userText) {
    const before = adapter.requests.length
    agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    await agent.whenIdle()
    assert.equal(adapter.requests.length, before + 1,
      `Expected one real adapter request; events: ${JSON.stringify(agent.session.snapshotEvents())}`)
    const request = adapter.requests.at(-1)
    const replay = Session.create(request.sessionId, request.events)
    assert.deepEqual(request.messages, replay.deriveMessages(), 'actual request must equal detached event replay')
    assert.equal(request.system, undefined, 'system text must be durably admitted, not rewritten only at transport')
    const reply = agent.session.snapshotEvents().findLast(event => event.type === 'assistant/message')
    assert.ok(reply, 'a real agent turn must finish with an assistant message')
    assert.equal(reply.data.message.content[0].text, 'offline reply')
    return request
  }
  return {
    ctx, adapter, downstream, assembled, createAgent, send,
    async disposeExcision() { await excisionFibers[0].dispose() },
  }
}

function systemText(request) {
  return request.messages.filter(message => message.role === 'system')
    .flatMap(message => message.content.map(block => block.text)).join('\n\n')
}

function assertOtherSurfaces(request) {
  assert.ok(request.messages.some(message => message.role === 'user'
    && message.source.kind === 'user' && message.content.some(block => block.text === userText)),
  'user-authored marker is not a system-prompt paragraph')
  assert.ok(request.messages.some(message => message.role === 'user'
    && message.content.some(block => block.type === 'text' && block.text.includes(runtimeText))),
  'runtime-context snapshots must not be excised')
  assert.equal(request.tools.find(tool => tool.name === 'marker_tool')?.description, toolDescription)
}

function assertUnbranded(request) {
  assert.equal(systemText(request), expectedPrompt)
  for (const fragment of [marker, 'SOURCE-PARAGRAPH-BEGIN', 'SOURCE-PARAGRAPH-END', 'WEB-PARAGRAPH-BEGIN', 'WEB-PARAGRAPH-END']) {
    assert.equal(systemText(request).includes(fragment), false, `Whole paragraph must disappear: ${fragment}`)
  }
  assertOtherSurfaces(request)
}

function assertBranded(request) {
  const text = systemText(request)
  for (const paragraph of [identity, sourceParagraph, webParagraph, ...kept]) {
    assert.ok(text.includes(paragraph), `Unmodified prompt must contain: ${paragraph}`)
  }
  assert.equal(text.split(marker).length - 1, 3, 'exactly three original branded paragraphs')
  assertOtherSurfaces(request)
}

test('Loader + real agent turn: excise whole rendered paragraphs before durable admission, not other surfaces', { timeout: 30_000 }, async t => {
  const h = await harness(t)
  const agent = await h.createAgent()
  const request = await h.send(agent)
  assert.equal(request.provider, oauth)
  assertUnbranded(request)
  const before = h.downstream.at(-1)
  const after = h.assembled.at(-1)
  assert.equal(after.sections.some(section => section.name === 'harness:identity'), false,
    'a wholly excised section must not leave an empty identity paragraph')
  for (const name of ['fixture:source', 'fixture:gui']) {
    assert.equal(after.sections.find(section => section.name === name)?.interpolate, false,
      'modified, already-rendered sections must not be interpolated twice')
  }
  assert.equal(after.sections.find(section => section.name === 'fixture:literal'),
    before.sections.find(section => section.name === 'fixture:literal'), 'unmodified sections retain their identity')
  assert.equal(renderPrompt(after), expectedPrompt)
  for (const key of ['tools', 'contexts', 'variables']) assert.equal(after[key], before[key], `${key} must be preserved by reference`)
  assert.notEqual(after, before)
  assert.ok(renderPrompt(before).includes(sourceParagraph), 'input assembly is not mutated')
  const events = request.events.filter(event => event.type === 'system/message')
  assert.equal(events.length, 1)
  assert.equal(events[0].data.message.content[0].text, expectedPrompt)
})

test('non-OAuth route and matching route with no matching paragraph are exact assembly no-ops', { timeout: 30_000 }, async t => {
  const branded = await harness(t)
  const ordinary = await branded.send(await branded.createAgent(plain))
  assert.equal(ordinary.provider, plain)
  assertBranded(ordinary)
  assert.equal(branded.assembled.at(-1), branded.downstream.at(-1))

  const unbranded = await harness(t, { branded: false })
  const unmatched = await unbranded.send(await unbranded.createAgent())
  assertUnbranded(unmatched)
  assert.equal(unbranded.assembled.at(-1), unbranded.downstream.at(-1), 'no match must preserve original sections/assembly')
  assert.ok(unbranded.assembled.at(-1).sections.length > 1)
})

test('installModelSelection routes both prompt admission and requests on each provider switch; disposal restores prompt', { timeout: 30_000 }, async t => {
  const h = await harness(t)
  const agent = await h.createAgent(plain)
  const selection = { current: { provider: plain, model }, assembled: undefined }
  installModelSelection(agent.ctx, selection)
  assertBranded(await h.send(agent))
  selection.current = { provider: oauth, model }
  const switched = await h.send(agent)
  assert.equal(switched.provider, oauth)
  assert.equal(h.assembled.at(-1).variables.provider, oauth)
  assertUnbranded(switched)
  // The original agent options still say anthropic: consulting those would fail.
  assert.equal(agent.options.provider, plain)
  selection.current = { provider: plain, model }
  assertBranded(await h.send(agent))
  selection.current = { provider: oauth, model }
  assertUnbranded(await h.send(agent))
  await h.disposeExcision()
  const restored = await h.send(agent)
  assert.equal(restored.provider, oauth)
  assertBranded(restored)
  assert.equal(h.assembled.at(-1), h.downstream.at(-1), 'disposal removes the waterfall listener')
})

test('complete:true persona is deliberately exempt: core restores it after the excision waterfall', { timeout: 30_000 }, async t => {
  const h = await harness(t)
  const agent = await h.createAgent()
  const complete = 'Complete persona owned by DeepSeek Harness.\nPreserve its entire branded paragraph.\n\nPreserve this other paragraph too.'
  agent.ctx.systemPrompt.section({ name: 'fixture:complete', order: -2000, text: complete, complete: true, interpolate: false })
  const request = await h.send(agent)
  assert.equal(request.provider, oauth)
  assert.equal(systemText(request), complete)
  assertOtherSurfaces(request)
  assert.equal(renderPrompt(h.assembled.at(-1)).includes(marker), false,
    'excision did run; SystemPrompt, not a plugin bypass, restores the complete persona afterwards')
  assert.equal(request.events.filter(event => event.type === 'system/message')[0].data.message.content[0].text, complete)
})

test('request-only late route override is unsupported unless also exposed during assembly', { timeout: 30_000 }, async t => {
  const h = await harness(t)
  const agent = await h.createAgent(plain)
  agent.ctx.on('agent/request', async (_payload, next) => ({ ...await next(), provider: oauth }))
  const request = await h.send(agent)
  assert.equal(request.provider, oauth)
  assert.equal(h.assembled.at(-1).variables.provider, plain)
  assertBranded(request)
  assert.equal(h.assembled.at(-1), h.downstream.at(-1),
    'assembly-only plugin must not pretend to know a later transport route')
})


test('real pi-ai OAuth serialization retains its native CLI identity after durable DSH paragraph excision', { timeout: 30_000 }, async t => {
  // Exercise the installed adapter and pi-ai serializers, intercepting every HTTP
  // call. Auth is an in-memory fixture; neither home credentials nor env are read.
  const { PiAiAdapter } = await import('../../../harness/packages/llm/llm-pi-ai/src/adapter.ts')
  const { resolveProfiles } = await import('../../../harness/packages/llm/llm-pi-ai/src/config.ts')
  const { memoryAuth } = await import('../../../harness/packages/llm/llm-pi-ai/tests/auth-double.ts')
  const h = await harness(t)
  const admitted = await h.send(await h.createAgent())
  assertUnbranded(admitted)
  const ordinary = await h.send(await h.createAgent(plain))
  assertBranded(ordinary)
  const originalFetch = globalThis.fetch
  const wire = []
  const piModel = 'claude-sonnet-4-5'
  globalThis.fetch = async (url, options) => {
    assert.equal(new URL(String(url)).origin, 'https://api.anthropic.com', 'no unexpected auth or model-catalog request')
    assert.equal(new URL(String(url)).pathname, '/v1/messages')
    wire.push({ headers: new Headers(options.headers), body: JSON.parse(options.body) })
    const events = [
      ['message_start', { type: 'message_start', message: { id: 'msg_excision_fixture', type: 'message', role: 'assistant', model: piModel,
        content: [], usage: { input_tokens: 10, output_tokens: 0 } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'offline reply' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }],
      ['message_stop', { type: 'message_stop' }],
    ]
    return new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''),
      { headers: { 'content-type': 'text/event-stream' } })
  }
  try {
    const profiles = resolveProfiles({ [oauth]: {}, [plain]: {} })
    const adapter = new PiAiAdapter({ profiles: () => profiles,
      auth: memoryAuth({ [oauth]: { type: 'oauth', access: 'sk-ant-oat01-excision-offline-fixture',
        refresh: 'unused-offline-fixture', expires: Date.now() + 3_600_000 } }),
      resolveApiKey: async provider => provider === plain ? 'api-key-offline-fixture' : undefined,
    })
    for (const request of [admitted, ordinary]) {
      const chunks = []
      for await (const chunk of adapter.stream({ provider: request.provider, model: piModel,
        system: request.system, messages: request.messages, tools: request.tools, maxTokens: 16 })) chunks.push(chunk)
      assert.equal(chunks.at(-1)?.reason.kind, 'stop', JSON.stringify(chunks))
    }
    assert.equal(wire.length, 2, 'one intercepted HTTP call per admitted request, no probes')
    const nativeIdentity = "You are Claude Code, Anthropic's official CLI for Claude."
    assert.equal(wire[0].body.system[0].text, nativeIdentity, 'pi-ai inserts its identity after DSH assembly/admission')
    assert.equal(wire[0].body.system[1].text, expectedPrompt)
    assert.equal(wire[0].headers.get('authorization'), 'Bearer sk-ant-oat01-excision-offline-fixture')
    assert.equal(wire[0].headers.has('x-api-key'), false)
    assert.equal(wire[0].body.tools.find(tool => tool.name === 'marker_tool')?.description, toolDescription)
    assert.ok(JSON.stringify(wire[0].body.messages).includes(userText))
    assert.ok(JSON.stringify(wire[0].body.messages).includes(runtimeText))
    assert.equal(wire[1].headers.get('x-api-key'), 'api-key-offline-fixture')
    assert.equal(wire[1].body.system.some(block => block.text === nativeIdentity), false)
    assert.equal(wire[1].body.system[0].text, systemText(ordinary))
  } finally {
    globalThis.fetch = originalFetch
  }
})
