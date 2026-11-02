import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import vm from 'node:vm'
import * as React from 'react'
import * as jsx from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'

const result = await build({ entryPoints: [new URL('../client.tsx', import.meta.url).pathname], bundle: true, format: 'cjs', platform: 'browser', jsx: 'automatic', write: false, loader: { '.css': 'text' }, external: ['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'] })
const sandbox = { module: { exports: {} }, require: name => ({ react: React, 'react/jsx-runtime': jsx, 'react-dom': {}, '@deepseek-ai/dsh-client-ui-primitives': {} })[name] }
vm.runInNewContext(result.outputFiles[0].text, sandbox)
const { readReport, planLabel, compactDuration, modelName, parseSnapshot, formatAmount, exactAmount, mergedMoney, billingNotes, pillSummary, billingTitle, gaps, windowLabel, OAuthShield, ApiIcon, OpenRouterIcon, apply } = sandbox.module.exports
const at = Date.parse('2026-01-01T12:00:00Z')
const sub = (extra = {}) => ({ key: 'anthropic-oauth-global/anthropic', name: 'Anthropic', icon: 'subscription', requests: 5, equivalent: [{ currency: 'USD', amount: '4.2' }],
  quota: { at, windows: [{ label: '5h', usedPercent: 8 }, { label: '7d', usedPercent: 31 }] }, ...extra })
const router = (extra = {}) => ({ key: 'openrouter-global/anthropic', name: 'Anthropic', icon: 'openrouter', connectionLabel: 'OpenRouter', requests: 27, cost: [{ kind: 'reported', currency: 'USD', amount: '2.99' }], ...extra })
const base = (sources = [sub()]) => ({ version: 2, sessionId: 'fixture-session', sources, counts: { requests: 5, pending: 0 }, persistence: 'ok' })
const same = (actual, expected, message) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)), message) // vm realm arrays

test('money: two decimals, leading zero, thousands separators, never a false zero', () => {
  const cases = { '0': '$0.00', '0.04': '$0.04', '0.0423': '$0.04', '1.236': '$1.24', '1.20': '$1.20', '4.2': '$4.20', '52.44': '$52.44', '1024.1': '$1,024.10', '9.995': '$10.00', '0.004': '<$0.01', '0.005': '$0.01' }
  for (const [amount, expected] of Object.entries(cases)) assert.equal(formatAmount(amount, 'USD'), expected, amount)
  assert.equal(formatAmount('2.52', 'EUR'), '€2.52')
  assert.equal(formatAmount('0.04', 'JPY'), 'JPY 0.04')
  assert.equal(formatAmount('0.001', 'JPY'), '<JPY 0.01')
  assert.equal(formatAmount('garbage', 'USD'), '—')
})
test('tokens: a compact count, never decimals below a thousand nor a trailing .0; exact in titles', () => {
  const cases = { '0': '0T', '20': '20T', '999': '999T', '1000': '1kT', '1234': '1.2kT', '15400': '15.4kT', '99960': '100kT', '154300': '154kT', '999600': '1MT', '1250000': '1.3MT' }
  for (const [amount, expected] of Object.entries(cases)) assert.equal(formatAmount(amount, 'TOK'), expected, amount)
  assert.equal(exactAmount('9703', 'TOK'), '9,703T')
  same(mergedMoney([{ kind: 'reported', currency: 'TOK', amount: '1200' }, { kind: 'reported', currency: 'TOK', amount: '85' }, { kind: 'reported', currency: 'USD', amount: '1.24' }]),
    [{ currency: 'TOK', amount: '1285', estimated: false }, { currency: 'USD', amount: '1.24', estimated: false }])
})
test('exact money keeps full precision and the currency', () => {
  assert.equal(exactAmount('0.042310', 'USD'), '$0.04231')
  assert.equal(exactAmount('2', 'CHF'), 'CHF 2')
})
test('window labels come from provider labels or durations', () => {
  assert.equal(windowLabel({ label: '5h' }), '5h')
  assert.equal(windowLabel({ label: 'primary', windowMinutes: 300 }), '5h')
  assert.equal(windowLabel({ label: 'secondary', windowMinutes: 10080 }), '7d')
  assert.equal(windowLabel({ label: 'primary' }), undefined)
})
test('OAuth shield geometry matches the picker exactly', async () => {
  const source = await readFile(new URL('../../../harness/packages/client/ui-model-selection/src/client/ModelSelect.tsx', import.meta.url), 'utf8')
  const output = renderToStaticMarkup(React.createElement(OAuthShield))
  assert.ok(output.includes('cx="10" cy="7.2" r="2"'))
  assert.ok(output.includes('stroke-width="1.55"'))
  if (!source.includes("if (route === 'plan') return ")) return  // a harness without topic/model-picker-sections has no RouteIcon
  const glyph = source.split("if (route === 'plan') return ")[1].split('\n')[0]
  for (const [, path] of glyph.matchAll(/ d="([^"]+)"/g)) assert.ok(output.includes(`d="${path}"`))
})
test('OpenRouter icon matches the picker glyph exactly', async () => {
  const source = await readFile(new URL('../../../harness/packages/client/ui-model-selection/src/client/ModelSelect.tsx', import.meta.url), 'utf8')
  const output = renderToStaticMarkup(React.createElement(OpenRouterIcon))
  assert.ok(output.includes('stroke-width="1.65"'))
  if (!source.includes('function RouteIcon')) return  // a harness without topic/model-picker-sections has no RouteIcon
  const glyph = source.split('function RouteIcon')[1].split("if (route === 'openrouter') return ")[1].split('\n')[0]
  const paths = [...glyph.matchAll(/ d="([^"]+)"/g)]
  assert.equal(paths.length, 1)
  assert.ok(output.includes(`d="${paths[0][1]}"`))
  assert.ok(output.includes('stroke-width="1.65"'))
})
test('token-billing icon matches the picker API glyph exactly', async () => {
  const source = await readFile(new URL('../../../harness/packages/client/ui-model-selection/src/client/ModelSelect.tsx', import.meta.url), 'utf8')
  const output = renderToStaticMarkup(React.createElement(ApiIcon))
  assert.ok(output.includes('x="1.8" y="3" width="16.4" height="14" rx="3"'))
  // The glyph is copied from the harness's model picker (ui-model-selection); compare when the harness has it.
  if (!source.includes('function RouteIcon')) return
  const glyph = source.split('function RouteIcon')[1].split("if (route === 'openrouter') return ")[1].split('\n')[1]
  assert.ok(glyph.includes('<rect'), 'API glyph line located')
  for (const [, path] of glyph.matchAll(/ d="([^"]+)"/g)) assert.ok(output.includes(`d="${path}"`))
})
test('mount requires only slots; unload removes own style; no client-plugin runtime imports', () => {
  let disposed
  let style
  let registered
  sandbox.document = { createElement: () => ({ dataset: {}, remove() { this.removed = true } }), head: { appendChild(node) { style = node } } }
  const slots = []
  apply({ effect(callback) { disposed = callback() }, slots: { inject(name, callback) { slots.push(name); callback() }, register(config) { registered ??= config; if (config.key) assert.equal(config.key, 'billing') } } })
  same(slots, ['conversation.composer.dock', 'conversation.chat.commandview'])
  assert.equal(registered.order, -10) // before the session stats (order 0): billing is leftmost
  assert.equal(registered.id, 'deepsea-billing')
  assert.ok(style.textContent.includes('padding: 1px 8px'))
  assert.ok(!/\border\s*:\s*1\s*[;}]/.test(style.textContent))
  disposed()
  assert.equal(style.removed, true)
})
test('snapshot validation addresses one session and an explicit schema', () => {
  assert.ok(parseSnapshot(base(), 'fixture-session'))
  assert.ok(parseSnapshot(base([]), 'fixture-session'))
  for (const change of [{ sessionId: 'other' }, { version: 1 }, { counts: { requests: -1, pending: 0 } }, { persistence: 'maybe' }, { now: 'invalid' }, { sources: 'x' },
    { sources: [sub({ icon: 'paid' })] }, { sources: [router({ cost: [{ kind: 'reported', currency: 'usd', amount: '1' }] })] }, { sources: [router({ cost: [{ kind: 'maybe', currency: 'USD', amount: '1' }] })] },
    { sources: [sub({ quota: { at, windows: [{ label: '5h', usedPercent: 150 }] } })] }, { sources: [sub({ quota: { at: 'invalid', windows: [] } })] }, { sources: [sub({ counts: { failed: -1 } })] },
    { sources: [sub({ account: { email: '' } })] }]) assert.equal(parseSnapshot({ ...base(), ...change }, 'fixture-session'), null, JSON.stringify(change))
})
test('merged money: reported plus estimate; an estimate under 1% of the charge stays reported', () => {
  same(mergedMoney([{ kind: 'reported', currency: 'USD', amount: '1.24' }, { kind: 'estimated', currency: 'USD', amount: '0.04' }]), [{ currency: 'USD', amount: '1.28', estimated: true }])
  same(mergedMoney([{ kind: 'reported', currency: 'USD', amount: '2.99' }, { kind: 'estimated', currency: 'USD', amount: '0.02' }]), [{ currency: 'USD', amount: '3.01', estimated: false }])
  same(mergedMoney([{ kind: 'estimated', currency: 'USD', amount: '0.03' }, { kind: 'reported', currency: 'EUR', amount: '2' }]), [{ currency: 'EUR', amount: '2', estimated: false }, { currency: 'USD', amount: '0.03', estimated: true }])
})
test('titles, model names, plans and durations read as words', () => {
  assert.equal(billingTitle(sub()), 'Anthropic plan')
  assert.equal(billingTitle(router()), 'OpenRouter API billing')
  assert.equal(billingTitle({ ...router(), icon: 'api', name: 'DeepSeek' }), 'DeepSeek API billing')
  assert.equal(billingTitle({ ...router(), icon: 'local', name: 'LM Studio' }), 'Local model')
  assert.equal(modelName('~anthropic/claude-opus-latest'), 'claude-opus-latest')
  assert.equal(planLabel('claude_team'), 'Team')
  assert.equal(planLabel('plus'), 'Plus')
  assert.deepEqual([compactDuration(58 * 60000), compactDuration(118 * 60000), compactDuration((5 * 1440 + 23 * 60) * 60000)], ['58m', '2h', '6d'])
})
test('only the current source warns; local models are never unpriced; storage failure is a danger', () => {
  same(billingNotes(base([sub(), router({ counts: { failed: 2 } })]), false), [])
  same(billingNotes(base([router({ counts: { failed: 1, incomplete: 1 } })]), false).map(n => n.text), ['1 request failed', '1 request partial'])
  same(gaps({ ...router(), icon: 'local', counts: { unpriced: 2 } }), [])
  same(billingNotes({ ...base(), persistence: 'error' }, false).map(n => n.level), ['danger'])
  same(billingNotes(undefined, true).map(n => n.text), ['Billing unavailable'])
})
test('the pill summary names the current source and its fuller window or money', () => {
  assert.equal(pillSummary(base(), false), 'Anthropic plan · 7d 31% used')
  assert.equal(pillSummary(base([sub({ quota: { at, stale: true, extra: true, windows: [] } })]), false), 'Anthropic plan · Extra usage · stale')
  assert.equal(pillSummary(base([router({ cost: [{ kind: 'reported', currency: 'USD', amount: '1.24' }, { kind: 'estimated', currency: 'USD', amount: '0.04' }] })]), false), 'OpenRouter API billing · ~$1.28')
  assert.equal(pillSummary({ ...base([router()]), counts: { requests: 27, pending: 1 } }, false), 'OpenRouter API billing · $2.99 · 1 request in flight')
  assert.equal(pillSummary(base([]), false), 'No requests recorded yet')
  assert.equal(pillSummary(undefined, true), 'Billing unavailable')
})
test('real host snapshots pass the client contract', async t => {
  const { BillingStore } = await import('../store.mjs')
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const directory = await mkdtemp(join(tmpdir(), 'billing-ui-contract-'))
  const card = { provider: 'fixture-api', model: 'fixture-model', currency: 'EUR', version: 'fixture-v1', source: 'https://example.com/prices', inputMode: 'exclusive', inputPerMillion: '2', outputPerMillion: '8', cacheReadPerMillion: '0.2', cacheWritePerMillion: '3' }
  const store = new BillingStore({ directory, rateCards: [card], now: () => new Date(at).toISOString(),
    providers: () => [{ id: 'openrouter', name: 'OpenRouter', catalogProvider: 'openrouter', auth: 'api-key' }, { id: 'fixture-api', name: 'Fixture API', auth: 'api-key' }, { id: 'openai-codex', name: 'Codex', catalogProvider: 'openai-codex', auth: 'subscription' }] })
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }) })
  const request = { sessionId: 'fixture-session', requestId: 'request-router', provider: 'openrouter', model: '~anthropic/claude-opus-latest', at: new Date(at - 2000).toISOString() }
  await store.record({ ...request, phase: 'evidence', evidence: { kind: 'openrouter', responseId: 'gen-fixture', reportedCost: { amount: '0.004', currency: 'USD', scope: 'openrouter-account' }, outcome: 'unknown' } })
  await store.record({ ...request, phase: 'finish' })
  const other = { ...request, requestId: 'request-api', provider: 'fixture-api', model: 'fixture-model', at: new Date(at - 1000).toISOString() }
  await store.record({ ...other, phase: 'usage', usage: { inputTokens: 1000000, outputTokens: 0 } })
  await store.record({ ...other, phase: 'finish' })
  let snapshot = await store.snapshot('fixture-session')
  assert.ok(parseSnapshot(snapshot, 'fixture-session'))
  same(snapshot.sources.map(s => [s.name, s.icon]), [['Fixture API', 'api'], ['Anthropic', 'openrouter']])
  assert.equal(pillSummary(snapshot, false), 'Fixture API API billing · ~€2.00')
  const quota = { ...request, requestId: 'request-quota', provider: 'openai-codex', model: 'gpt-5.6-terra', at: new Date(at).toISOString() }
  await store.record({ ...quota, phase: 'evidence', evidence: { kind: 'openai-codex', outcome: 'quota-observed', windows: [{ label: 'Primary', usedPercent: 20, windowMinutes: 300 }], credits: { hasCredits: true, unlimited: false, balance: '2.5' } } })
  snapshot = await store.snapshot('fixture-session')
  assert.ok(parseSnapshot(snapshot, 'fixture-session'))
  assert.equal(snapshot.sources[0].name, 'OpenAI')
})

test('the /billing report reads back for the card; other text is not a report', async () => {
  const { encodeReport, reportLine } = await import('../report.mjs')
  const report = { v: 1, sessionId: 'fixture-session', now: new Date(at).toISOString(), persistence: 'ok',
    sources: [sub(), router({ keyHint: '9f2a' }), { key: 'openai-global/openai', name: 'OpenAI', icon: 'api', connectionLabel: 'OpenAI', requests: 0 }] }
  assert.equal(reportLine(report), 'Anthropic plan 5h 8% 7d 31% · Anthropic $2.99 · 1 other provider')
  assert.equal(readReport(encodeReport(report)).sources[1].keyHint, '9f2a')
  assert.equal(reportLine({ ...report, sources: [router({ cost: [{ kind: 'reported', currency: 'USD', amount: '1.24' }, { kind: 'estimated', currency: 'USD', amount: '0.0004' }] })] }), 'Anthropic ~$1.24')
  const lmstudio = { key: 'lmstudio-global/lmstudio', name: 'LM Studio', icon: 'local', connectionLabel: 'LM Studio', requests: 3 }
  assert.equal(reportLine({ ...report, sources: [{ ...lmstudio, cost: [{ kind: 'reported', currency: 'TOK', amount: '9703' }] }] }), 'LM Studio 9.7kT')
  assert.equal(reportLine({ ...report, sources: [lmstudio] }), 'LM Studio local')
  assert.equal(readReport('Usage: /billing'), undefined)
  assert.equal(readReport(encodeReport({ ...report, sources: [router({ keyHint: 'sk-ant-whole-key' })] })), undefined, 'only four characters of a key')
})
