/** Offline only. From the harness build: node --import tsx/esm --test <repo>/plugins/billing/tests/collector-integration.mjs */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PiAiAdapter } from '../../../harness/packages/llm/llm-pi-ai/src/adapter.ts'
import { resolveProfiles } from '../../../harness/packages/llm/llm-pi-ai/src/config.ts'
import { memoryAuth } from '../../../harness/packages/llm/llm-pi-ai/tests/auth-double.ts'
import { installCollector } from '../collector.mjs'
const require = createRequire(new URL('../../../harness/packages/llm/llm-pi-ai/package.json', import.meta.url))
const { Context } = await import(require.resolve('@deepseek-ai/cordis'))
const cordisRequire = createRequire(new URL('../../../harness/vendor/cordis/package.json', import.meta.url))
const { default: Loader } = await import(cordisRequire.resolve('@deepseek-ai/cordis-plugin-loader'))
const { default: Include } = await import(cordisRequire.resolve('@deepseek-ai/cordis-plugin-include'))
const { default: LlmRuntime, createUserMessage } = await import(require.resolve('@deepseek-ai/dsh-llm'))
const collect = async iterable => { const chunks = []; for await (const chunk of iterable) chunks.push(chunk); return chunks }
const anthropicSSE = () => [
  { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], usage: { input_tokens: 10, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'fixture' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
].map(data => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`).join('')
const openRouterSSE = () => [
  { id: 'gen-fixture', object: 'chat.completion.chunk', model: 'fixture-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'fixture' }, finish_reason: null }] },
  { id: 'gen-fixture', object: 'chat.completion.chunk', model: 'fixture-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11, cost: 0.0001 } },
].map(data => `data: ${JSON.stringify(data)}\n\n`).join('') + 'data: [DONE]\n\n'

test('real Loader + Pi adapter standalone collector captures OAuth and OpenRouter without command/audit services', async () => {
  const original = globalThis.fetch
  const observations = [], requests = []
  globalThis.fetch = async (input, init) => {
    const parsed = new URL(input instanceof Request ? input.url : String(input))
    const url = parsed.origin + parsed.pathname
    requests.push(url)
    if (url === 'https://api.anthropic.com/v1/messages') return new Response(anthropicSSE(), { headers: {
      'content-type': 'text/event-stream', 'anthropic-ratelimit-unified-status': 'allowed', 'anthropic-ratelimit-unified-representative-claim': 'five_hour',
    } })
    if (url === 'https://openrouter.ai/api/v1/chat/completions') return new Response(openRouterSSE(), { headers: { 'content-type': 'text/event-stream' } })
    assert.fail('No live network allowed: unexpected fixture URL')
  }
  const fakeFetch = globalThis.fetch
  const ctx = new Context()
  const home = await mkdtemp(join(tmpdir(), 'billing-collector-fixture-'))
  try {
    const profiles = resolveProfiles({ 'anthropic-oauth': {}, openrouter: { api: 'openai-completions', baseURL: 'https://openrouter.ai/api/v1', models: [{ id: 'fixture-model', contextWindow: 4096, maxTokens: 64 }] } })
    const auth = memoryAuth({ 'anthropic-oauth': { type: 'oauth', access: 'sk-ant-oat-fixture', refresh: 'fixture-refresh', expires: Date.now() + 3600000 } })
    const adapter = new PiAiAdapter({ profiles: () => profiles, auth, resolveApiKey: async provider => provider === 'openrouter' ? 'fixture-key' : undefined })
    const modules = new Map([
      ['fixture-llm', LlmRuntime],
      ['fixture-provider', { name: 'fixture-provider', inject: ['llm'], apply(ctx) { ctx.llm.registerAdapter(['anthropic-oauth', 'openrouter'], adapter) } }],
      ['fixture-collector', { name: 'fixture-collector', inject: ['llm'], apply(ctx) { installCollector(ctx, event => observations.push(event)) } }],
    ])
    const path = join(home, 'cordis.yml')
    await writeFile(path, '- id: llm\n  name: fixture-llm\n- id: provider\n  name: fixture-provider\n- id: collector\n  name: fixture-collector\n')
    ctx.baseUrl = pathToFileURL(home).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.internal = { version: 'v2', async import(name) { assert.ok(modules.has(name)); return modules.get(name) } }
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
    await ctx.loader.await()
    const options = (provider, model) => ({ provider, model, maxTokens: 16, sessionId: 'session-fixture', purpose: 'session-title',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'PRIVATE fixture prompt' }], source: { kind: 'plugin', plugin: 'fixture' } })] })
    const anth = await collect(ctx.llm.stream(options('anthropic-oauth', 'claude-sonnet-4-5')))
    assert.equal(anth.at(-1).reason.kind, 'stop', JSON.stringify(anth))
    assert.equal(observations.find(x => x.evidence?.kind === 'anthropic-oauth').evidence.outcome, 'plan-evidence')
    const router = await collect(ctx.llm.stream(options('openrouter', 'fixture-model')))
    assert.equal(router.at(-1).reason.kind, 'stop', JSON.stringify(router))
    assert.equal(observations.find(x => x.evidence?.reportedCost).evidence.reportedCost.amount, '0.0001')
    assert.equal(observations.find(x => x.provider === 'openrouter' && x.phase === 'usage').usage.inputTokens, 10)
    assert.equal(requests.length, 2)
    assert.ok(!JSON.stringify(observations).includes('PRIVATE'))
    observations.length = 0; auth.stored.clear()
    const failed = await collect(ctx.llm.stream(options('anthropic-oauth', 'claude-sonnet-4-5')))
    assert.equal(failed.at(-1).reason.kind, 'error')
    assert.equal(requests.length, 2)
    assert.equal(observations.some(x => x.phase === 'usage'), false, 'Do not retain SDK synthetic zero usage on auth error')
    await ctx.fiber.dispose()
    assert.equal(globalThis.fetch, fakeFetch)
  } finally { await ctx.fiber.dispose(); globalThis.fetch = original; await rm(home, { recursive: true, force: true }) }
})
