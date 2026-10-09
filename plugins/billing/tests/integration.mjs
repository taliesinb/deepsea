/** Offline real-DSH/pi-ai test. Run from the harness build with node --import tsx/esm --test. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAiAdapter } from '../../../harness/packages/llm/llm-pi-ai/src/adapter.ts'
import { resolveProfiles } from '../../../harness/packages/llm/llm-pi-ai/src/config.ts'
import { memoryAuth } from '../../../harness/packages/llm/llm-pi-ai/tests/auth-double.ts'
import * as Billing from '../index.js'
const require = createRequire(new URL('../../../harness/packages/llm/llm-pi-ai/package.json', import.meta.url))
const { Context } = await import(require.resolve('@deepseek-ai/cordis'))
const { default: LlmRuntime, createUserMessage } = await import(require.resolve('@deepseek-ai/dsh-llm'))
const collect = async stream => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks }
const model = 'claude-sonnet-4-5'
function anthropicSSE() {
  return [
    ['message_start', { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model, content: [], usage: { input_tokens: 10, output_tokens: 0 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }],
    ['message_stop', { type: 'message_stop' }],
  ].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('')
}
function routerSSE() {
  const base = { id: 'gen-offline-fixture', object: 'chat.completion.chunk', created: 1, model: 'openai/gpt-4o-mini' }
  return [
    { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'hello' }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11, cost: '0.000123', cost_details: { upstream_inference_cost: '999' } } },
  ].map(data => `data: ${JSON.stringify(data)}\n\n`).join('') + 'data: [DONE]\n\n'
}
test('real DSH + pi-ai retain native replies and capture both OAuth evidence and OpenRouter charge', async () => {
  const original = globalThis.fetch
  const home = await mkdtemp(join(tmpdir(), 'dsh-billing-integration-'))
  const ctx = new Context()
  let calls = 0, accountReads = 0
  const fixtureFetch = async input => {
    const url = String(input)
    // The header reading names no account, so billing asks the adapter for the account once (usage + profile).
    if (url === 'https://api.anthropic.com/api/oauth/usage' || url === 'https://api.anthropic.com/api/oauth/profile') {
      accountReads++
      return Response.json(url.endsWith('/profile')
        ? { account: { uuid: 'fixture-account', email: 'user@example.com' }, organization: { uuid: 'fixture-org', name: 'Example Org', organization_type: 'claude_team' } }
        : { five_hour: { utilization: 3, resets_at: '2026-10-01T05:00:00Z' } })
    }
    calls++
    assert.ok(url.startsWith('https://api.anthropic.com/v1/messages') || url === 'https://openrouter.ai/api/v1/chat/completions', 'No nonfixture network')
    return url.includes('openrouter.ai')
      ? new Response(routerSSE(), { headers: { 'content-type': 'text/event-stream' } })
      : new Response(anthropicSSE(), { headers: { 'content-type': 'text/event-stream',
        'anthropic-ratelimit-unified-status': 'allowed', 'anthropic-ratelimit-unified-representative-claim': 'five_hour',
        'anthropic-ratelimit-unified-5h-utilization': '0.03' } })
  }
  globalThis.fetch = fixtureFetch
  try {
    await ctx.plugin(LlmRuntime)
    const profiles = resolveProfiles({ 'anthropic-oauth': {}, openrouter: {} })
    const auth = memoryAuth({ 'anthropic-oauth': { type: 'oauth', access: 'sk-ant-oat01-offline-fixture', refresh: 'offline-fixture', expires: Date.now() + 3600000 } })
    const adapter = new PiAiAdapter({ profiles: () => profiles, auth, resolveApiKey: async provider => provider === 'openrouter' ? 'offline-fixture' : undefined })
    ctx.llm.registerAdapter(['anthropic-oauth','openrouter'], adapter)
    await ctx.plugin(Billing, { directory: join(home, 'billing') })
    const options = (provider, selectedModel) => ({ provider, model: selectedModel, sessionId: 'session-fixture', maxTokens: 16,
      messages: [createUserMessage({ content: [{ type: 'text', text: 'offline fixture' }], source: { kind: 'plugin', plugin: 'test' } })] })
    const claude = await collect(ctx.llm.stream(options('anthropic-oauth', model)))
    assert.equal(claude.at(-1).reason.kind, 'stop', JSON.stringify(claude))
    const subscription = await ctx.deepseaBilling.snapshot('session-fixture')
    const [sub] = subscription.sources
    assert.equal(sub.icon, 'subscription', 'route metadata from the adapter')
    assert.equal(sub.quota.windows[0].usedPercent, 3)
    assert.deepEqual(subscription.totals, [])
    assert.deepEqual([sub.connection, sub.name, sub.account?.email, accountReads], ['anthropic-oauth-global', 'Anthropic', 'user@example.com', 2])
    const router = await collect(ctx.llm.stream(options('openrouter', 'openai/gpt-4o-mini')))
    assert.equal(router.at(-1).reason.kind, 'stop', JSON.stringify(router))
    const receipt = await ctx.deepseaBilling.snapshot('session-fixture')
    assert.equal(receipt.totals[0].amount, '0.000123')
    assert.equal(receipt.totals[0].kind, 'reported')
    assert.deepEqual([receipt.sources[0].name, receipt.sources[0].icon, receipt.sources[0].cost], ['OpenAI', 'openrouter', [{ kind: 'reported', currency: 'USD', amount: '0.000123' }]])
    assert.equal(receipt.counts.requests, 2)
    assert.equal(calls, 2)
    await ctx.fiber.dispose()
    assert.equal(globalThis.fetch, fixtureFetch)
  } finally { await ctx.fiber.dispose(); globalThis.fetch = original; await rm(home, { recursive: true, force: true }) }
})
