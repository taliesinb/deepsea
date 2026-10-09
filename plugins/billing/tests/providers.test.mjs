import test from 'node:test'
import assert from 'node:assert/strict'
import { anthropicEvidence, codexEvidence, openRouterEvidence, parseTelemetryJSON, decimalAmount, tokenUsage } from '../providers.mjs'

const anth = values => new Headers(Object.entries(values).map(([key, value]) => [`anthropic-ratelimit-unified-${key}`, value]))
test('Anthropic positive claims require accepted response plus allowed unified status', () => {
  const headers = anth({ status: 'allowed', 'representative-claim': 'five_hour', '5h-utilization': '0.03', '7d-utilization': '0', '5h-reset': '1700000000' })
  const evidence = anthropicEvidence(200, headers)
  assert.equal(evidence.outcome, 'plan-evidence')
  assert.deepEqual(evidence.windows, [{ label: '5h', usedPercent: 3, resetAt: '2023-11-14T22:13:20.000Z' }, { label: '7d', usedPercent: 0 }])
  assert.equal(anthropicEvidence(429, headers).outcome, 'rejected')
  assert.equal(anthropicEvidence(200, anth({ 'representative-claim': 'five_hour' })).outcome, 'unknown')
  assert.equal(anthropicEvidence(200, anth({ status: 'allowed', '5h-utilization': '0.1' })).outcome, 'unknown')
  assert.equal(anthropicEvidence(200, anth({ 'representative-claim': 'overage' })).outcome, 'extra-usage')
})
test('Anthropic rejects unfamiliar values and never returns raw header material', () => {
  const value = anthropicEvidence(200, anth({ status: 'secret', 'representative-claim': 'secret', '5h-utilization': 'secret', '7d-utilization': '-0.1', 'overage-utilization': 'secret' }))
  assert.equal(value.outcome, 'unknown')
  assert.deepEqual(value.windows, [])
  assert.ok(!JSON.stringify(value).includes('secret'))
})
test('Codex HTTP windows retain reported duration, credits are not dollars or plan claims', () => {
  const evidence = codexEvidence(200, new Headers({ 'x-codex-primary-used-percent': '0', 'x-codex-primary-window-minutes': '60', 'x-codex-primary-reset-at': '1700000000',
    'x-codex-secondary-used-percent': '12.5', 'x-codex-credits-has-credits': '1', 'x-codex-credits-unlimited': 'False', 'x-codex-credits-balance': '12.030', 'set-cookie': 'secret' }))
  assert.equal(evidence.outcome, 'quota-observed')
  assert.equal(evidence.websocket, 'unobserved')
  assert.deepEqual(evidence.credits, { hasCredits: true, unlimited: false, balance: '12.03' })
  assert.deepEqual(evidence.windows[0], { label: 'primary', usedPercent: 0, windowMinutes: 60, resetAt: '2023-11-14T22:13:20.000Z' })
  assert.equal(evidence.reportedCost, undefined)
  assert.ok(!JSON.stringify(evidence).includes('secret'))
  assert.equal(codexEvidence(429, new Headers()).outcome, 'rejected')
  assert.equal(codexEvidence(200, new Headers()).outcome, 'unknown')
})
test('OpenRouter exact decimal receipt, independent upstream cost and explicit BYOK', () => {
  const payload = parseTelemetryJSON('{"id":"gen-example_1","model":"vendor/model","usage":{"cost":0.123456789012345678,"is_byok":true,"cost_details":{"upstream_inference_cost":2e-7}},"choices":[{"text":"PRIVATE"}]}')
  const evidence = openRouterEvidence(payload)
  assert.deepEqual(evidence.reportedCost, { amount: '0.123456789012345678', currency: 'USD', scope: 'openrouter-account' })
  assert.equal(evidence.upstreamCost.amount, '0.0000002')
  assert.equal(evidence.byok, true)
  assert.equal(evidence.responseId, 'gen-example_1')
  assert.ok(!JSON.stringify(evidence).includes('PRIVATE'))
  assert.equal(openRouterEvidence({ usage: { cost: 0 } }).reportedCost.amount, '0')
  assert.equal(openRouterEvidence({ usage: { cost: { total: 1 } } }), undefined)
  assert.equal(openRouterEvidence({ error: {}, usage: { cost: 1 } }), undefined)
})
test('Bounded decimal expansion and token allowlist', () => {
  for (const value of [NaN, Infinity, -1, '', null, '1e99', '0.0000000000000000001', '9999999999999']) assert.equal(decimalAmount(value), undefined)
  assert.equal(decimalAmount('1.2300e2'), '123')
  assert.equal(decimalAmount('0e-24'), '0')
  assert.deepEqual(tokenUsage({ inputTokens: 2, outputTokens: 3, reasoningTokens: 1, cacheReadTokens: -1, totalTokens: NaN, text: 'PRIVATE', cost: 10 }), { inputTokens: 2, outputTokens: 3, reasoningTokens: 1 })
})
