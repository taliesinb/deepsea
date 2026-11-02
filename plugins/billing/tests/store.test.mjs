import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, readdir, writeFile, appendFile, mkdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BillingStore, accountKeyOf, connectionIdOf, fileName } from '../store.mjs'

const card = { provider: 'openai', model: 'fixture-model', currency: 'USD', version: 'fixture-v1', source: 'https://example.com/prices', inputMode: 'exclusive', inputPerMillion: '2', outputPerMillion: '8', cacheReadPerMillion: '0.2', cacheWritePerMillion: '3' }
const base = { sessionId: 'session-one', requestId: 'request-one', provider: 'openai', model: 'fixture-model', at: '2026-01-01T00:00:00.000Z' }
const catalogPricing = { currency: 'USD', inputPerMillion: '4', outputPerMillion: '20', cacheReadPerMillion: '0.2', cacheWritePerMillion: '5', source: 'pi-ai catalog 2026-09-22' }
const providers = () => [
  { id: 'openai', name: 'OpenAI', catalogProvider: 'openai', auth: 'api-key' },
  { id: 'openrouter', name: 'OpenRouter', catalogProvider: 'openrouter', auth: 'api-key' },
  { id: 'anthropic', name: 'Anthropic', catalogProvider: 'anthropic', auth: 'api-key' },
  { id: 'anthropic-oauth', name: 'Anthropic OAuth', catalogProvider: 'anthropic', auth: 'subscription' },
  { id: 'openai-codex-oauth', name: 'Codex', catalogProvider: 'openai-codex', auth: 'subscription' },
  { id: 'lmstudio', name: 'LM Studio', auth: 'local' },
]
const settle = () => new Promise(resolve => setTimeout(resolve, 20))
// Stores close before their directories are removed (after-hooks run in registration order).
const opened = new WeakMap()
async function temp(t, prefix = 'billing-store-') {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  if (!opened.has(t)) {
    opened.set(t, { stores: [], directories: [] })
    t.after(async () => {
      const { stores, directories } = opened.get(t)
      await Promise.all(stores.map(store => store.close()))
      await Promise.all(directories.map(path => rm(path, { recursive: true, force: true })))
    })
  }
  opened.get(t).directories.push(directory)
  return directory
}
function open(t, options) {
  const store = new BillingStore(options)
  opened.get(t)?.stores.push(store)
  return store
}
async function fixture(t, options = {}) {
  const directory = options.directory ?? await temp(t)
  const store = open(t, { directory, rateCards: [card], providers, ...options })
  await store.ready
  return { store, directory }
}
const lines = async path => (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
const sessionFile = (directory, id = 'session-one') => join(directory, 'sessions', `${id}.jsonl`)

test('one append-only fact log per session; summaries are derived; nothing else rewrites it', async t => {
  const { store, directory } = await fixture(t)
  await store.record({ ...base, phase: 'start' })
  await store.record({ ...base, phase: 'usage', usage: { inputTokens: 1000, outputTokens: 100 } })
  await store.record({ ...base, phase: 'usage', usage: { inputTokens: 1000, outputTokens: 200 } })
  await store.record({ ...base, phase: 'finish', finishReason: 'stop' })
  await store.record({ ...base, sessionId: 'session-other', phase: 'usage', usage: { inputTokens: 1000000, outputTokens: 0 } })
  const records = await lines(sessionFile(directory))
  assert.deepEqual(records.map(r => r.t), ['start', 'usage', 'usage', 'finish'])
  assert.equal(records[0].connection, 'openai-global')
  assert.equal(records[1].connection, undefined, 'only the start record carries the request identity')
  const snapshot = await store.snapshot('session-one')
  assert.deepEqual(snapshot.totals, [{ kind: 'estimated', currency: 'USD', scope: 'model-tokens', connection: 'openai-global', amount: '0.0036', source: 'fixture-v1' }], 'cumulative samples replace')
  assert.deepEqual(snapshot.sources.map(s => [s.key, s.name, s.icon, s.connectionLabel, s.requests]), [['openai-global/openai', 'OpenAI', 'api', 'OpenAI', 1]])
  assert.equal((await lines(sessionFile(directory, 'session-other'))).length, 2, 'other sessions have their own file')
  await store.close()
  const summary = JSON.parse(await readFile(join(directory, 'sessions', 'session-one.json'), 'utf8'))
  assert.equal(summary.totals[0].amount, '0.0036')
  assert.equal((await stat(sessionFile(directory))).mode & 0o777, 0o600)
})

test('implicit connections are <route>-global with the adapter\'s provider, auth kind and label', async t => {
  const { store, directory } = await fixture(t)
  assert.equal(connectionIdOf('anthropic-oauth'), 'anthropic-oauth-global')
  await store.record({ ...base, provider: 'anthropic-oauth', model: 'claude-opus-5-5', phase: 'start' })
  await store.record({ ...base, requestId: 'r2', provider: 'custom-gateway', model: 'm', phase: 'start' })
  await store.close()
  const connection = JSON.parse(await readFile(join(directory, 'connections', 'anthropic-oauth-global.json'), 'utf8'))
  assert.deepEqual({ id: connection.id, route: connection.route, provider: connection.provider, auth: connection.auth, label: connection.label, implicit: connection.implicit },
    { id: 'anthropic-oauth-global', route: 'anthropic-oauth', provider: 'anthropic', auth: 'subscription', label: 'Anthropic OAuth', implicit: true })
  const custom = JSON.parse(await readFile(join(directory, 'connections', 'custom-gateway-global.json'), 'utf8'))
  assert.deepEqual([custom.provider, custom.auth], ['custom-gateway', undefined])
})

test('the usage read names the account: hashed key, identity file, latest and an append-only history of changes', async t => {
  let clock = '2026-01-01T00:00:00.000Z', used = 3
  const calls = []
  const { store, directory } = await fixture(t, { now: () => clock, firstLoadWaitMs: 50,
    usage: async route => { calls.push(route); return { windows: [{ label: '5h', usedPercent: used }], observedAt: clock, account: { id: 'acct-uuid/org-uuid', email: 'user@example.com', organization: 'Example Org', plan: 'claude_team' } } } })
  const oauth = { ...base, provider: 'anthropic-oauth', model: 'claude-opus-5-5' }
  await store.record({ ...oauth, phase: 'start' })
  const first = await store.snapshot('session-one')
  const key = accountKeyOf('anthropic', 'acct-uuid/org-uuid')
  assert.match(key, /^anthropic-[0-9a-f]{8}$/)
  assert.deepEqual([first.sources[0].quota.windows[0].usedPercent, first.sources[0].account], [3, { email: 'user@example.com', organization: 'Example Org', plan: 'claude_team' }])
  // Header readings on the same account: an unchanged reading adds no history line.
  await store.record({ ...oauth, at: '2026-01-01T00:00:01.000Z', phase: 'evidence', evidence: { kind: 'anthropic-oauth', outcome: 'plan-evidence', windows: [{ label: '5h', usedPercent: 3 }] } })
  await store.record({ ...oauth, at: '2026-01-01T00:00:02.000Z', phase: 'evidence', evidence: { kind: 'anthropic-oauth', outcome: 'plan-evidence', windows: [{ label: '5h', usedPercent: 4 }] } })
  await store.close()
  const identity = JSON.parse(await readFile(join(directory, 'accounts', key, 'identity.json'), 'utf8'))
  assert.deepEqual([identity.email, identity.id], ['user@example.com', undefined], 'the raw provider id stays out of the file')
  const history = await lines(join(directory, 'accounts', key, 'quota.jsonl'))
  assert.deepEqual(history.map(r => [r.source, r.windows[0].usedPercent]), [['usage-endpoint', 3], ['response-headers', 4]])
  assert.equal(JSON.parse(await readFile(join(directory, 'accounts', key, 'latest.json'), 'utf8')).windows[0].usedPercent, 4)
  const connection = JSON.parse(await readFile(join(directory, 'connections', 'anthropic-oauth-global.json'), 'utf8'))
  assert.equal(connection.account, key)
  // A restart restores the account and its reading without asking again while it is fresh.
  clock = '2026-01-01T00:01:00.000Z'
  const again = open(t, { directory, providers, now: () => clock, usage: async route => { calls.push(route) } })
  const restored = await again.snapshot('session-one')
  assert.deepEqual([restored.sources[0].quota.windows[0].usedPercent, restored.sources[0].quota.stale, restored.sources[0].account.email], [4, undefined, 'user@example.com'])
  await settle()
  assert.deepEqual(calls, ['anthropic-oauth'])
  used = 10
})

test('a usage read that found no sign-in is retried: after the refresh interval, or at once when forgotten', async t => {
  // The footer reads the default subscription route before the user has signed in; that answer
  // (nothing) must not stop the read after the sign-in.
  let signedIn = false
  const calls = []
  const { store } = await fixture(t, { now: () => '2026-01-01T00:00:00.000Z', firstLoadWaitMs: 50, usageRefreshMs: 60_000,
    usage: async route => { calls.push(route); return signedIn ? { windows: [{ label: '5h', usedPercent: 9 }], observedAt: '2026-01-01T00:00:00.000Z', account: { id: 'acct', email: 'user@example.com' } } : undefined } })
  await store.snapshot('session-one', 'anthropic-oauth')
  await settle()
  assert.deepEqual(calls, ['anthropic-oauth'])
  signedIn = true
  await store.snapshot('session-one', 'anthropic-oauth')
  await settle()
  assert.deepEqual(calls, ['anthropic-oauth'], 'within the refresh interval nothing is read again')
  store.forgetUsage('anthropic-oauth')  // what a credentials/record-updated for the route does
  const after = await store.snapshot('session-one', 'anthropic-oauth')
  assert.deepEqual(calls, ['anthropic-oauth', 'anthropic-oauth'])
  assert.deepEqual([after.sources[0].quota.windows[0].usedPercent, after.sources[0].account.email], [9, 'user@example.com'])
})

test('readPlans reads every Plan route at startup, skipping fresh accounts; a read that found no credential does not hold it back', async t => {
  // A Plan signed in before the server started: no sign-in event, so startup reads it.
  let signedIn = false
  const calls = []
  const { store } = await fixture(t, { now: () => '2026-01-01T00:00:00.000Z', firstLoadWaitMs: 50, usageRefreshMs: 60_000,
    usage: async route => { calls.push(route); return signedIn ? { windows: [{ label: '5h', usedPercent: 9 }], observedAt: '2026-01-01T00:00:00.000Z', account: { id: `acct-${route}`, email: `${route}@example.com` } } : undefined } })
  await store.snapshot('session-one', 'anthropic-oauth')   // the footer, before the credentials are available
  await settle()
  assert.deepEqual(calls, ['anthropic-oauth'])
  signedIn = true
  await store.readPlans()
  await settle()
  assert.deepEqual(calls.sort(), ['anthropic-oauth', 'anthropic-oauth', 'openai-codex-oauth'], 'every Plan route, none of the API-key or local ones')
  const report = await store.report('session-one', 'anthropic-oauth')
  assert.deepEqual(report.sources.filter(s => s.icon === 'subscription').map(s => [s.connection, s.account?.email, s.quota?.windows[0].usedPercent]),
    [['anthropic-oauth-global', 'anthropic-oauth@example.com', 9], ['openai-codex-oauth-global', 'openai-codex-oauth@example.com', 9]])
  await store.readPlans()
  await settle()
  assert.equal(calls.length, 3, 'a fresh reading is not read again')
})

test('readPlans keeps a failed read\'s backoff; the /billing card reads a Plan whose read found no credential', async t => {
  let answer = 'error'
  const calls = []
  const { store } = await fixture(t, { now: () => '2026-01-01T00:00:00.000Z', firstLoadWaitMs: 50, usageRefreshMs: 60_000,
    providers: () => providers().filter(p => p.id !== 'openai-codex-oauth'),
    usage: async route => { calls.push(route); if (answer === 'error') throw new Error('subscription usage rate limited; retry after 600s'); return answer === 'none' ? undefined : { windows: [{ label: '5h', usedPercent: 3 }], observedAt: '2026-01-01T00:00:00.000Z', account: { id: 'acct', email: 'user@example.com' } } } })
  await store.readPlans()
  await settle()
  answer = 'none'
  await store.readPlans()
  await store.report('session-one')
  await settle()
  assert.deepEqual(calls, ['anthropic-oauth'], 'a rate-limited read waits out its backoff')
  store.forgetUsage('anthropic-oauth')
  await store.readPlans()
  await settle()
  assert.deepEqual(calls, ['anthropic-oauth', 'anthropic-oauth'])
  answer = 'read'
  const report = await store.report('session-one')
  assert.deepEqual(calls, ['anthropic-oauth', 'anthropic-oauth', 'anthropic-oauth'], 'nothing was sent, so the card reads again')
  assert.equal(report.sources.find(s => s.connection === 'anthropic-oauth-global').account.email, 'user@example.com')
})

test('a header reading before the account is known is held with the connection, then moved to the account', async t => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const { store, directory } = await fixture(t, { now: () => '2026-01-01T00:00:05.000Z', firstLoadWaitMs: 10,
    usage: async () => { await gate; return { windows: [], observedAt: '2026-01-01T00:00:04.000Z', account: { id: 'acct', email: 'user@example.com' } } } })
  const oauth = { ...base, provider: 'anthropic-oauth', model: 'claude-opus-5-5' }
  await store.record({ ...oauth, phase: 'evidence', evidence: { kind: 'anthropic-oauth', outcome: 'plan-evidence', windows: [{ label: '5h', usedPercent: 7 }] } })
  assert.deepEqual((await store.snapshot('session-one')).sources[0].quota.windows.map(w => w.usedPercent), [7])
  await settle()
  assert.ok(JSON.parse(await readFile(join(directory, 'connections', 'anthropic-oauth-global.json'), 'utf8')).reading, 'held on disk')
  release(); await settle()
  const key = accountKeyOf('anthropic', 'acct')
  const after = (await store.snapshot('session-one')).sources[0]
  assert.deepEqual([after.account.email, after.quota.windows[0].usedPercent], ['user@example.com', 7])
  await store.close()
  assert.equal(JSON.parse(await readFile(join(directory, 'connections', 'anthropic-oauth-global.json'), 'utf8')).account, key)
  assert.equal(JSON.parse(await readFile(join(directory, 'connections', 'anthropic-oauth-global.json'), 'utf8')).reading, undefined)
})

test('subscription usage is not dollars; it has an API-price equivalent from list prices', async t => {
  const lookups = []
  const { store, directory } = await fixture(t, { pricing: async (route, model) => { lookups.push(`${route}/${model}`); return route === 'anthropic-oauth' ? { listPricing: catalogPricing } : { pricing: catalogPricing } } })
  const oauth = { ...base, provider: 'anthropic-oauth', model: 'claude-opus-5-5' }
  await store.record({ ...oauth, phase: 'usage', usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 1000000 } })
  await store.record({ ...oauth, phase: 'evidence', evidence: { kind: 'anthropic-oauth', outcome: 'plan-evidence', windows: [] } })
  await store.record({ ...oauth, phase: 'finish', finishReason: 'stop' })
  const snapshot = await store.snapshot('session-one')
  assert.deepEqual(snapshot.totals, [])
  assert.deepEqual(snapshot.sources[0].equivalent, [{ currency: 'USD', amount: '0.206' }])
  assert.deepEqual([snapshot.counts.subscription, snapshot.counts.unpriced], [1, 0])
  await store.close()
  const price = JSON.parse(await readFile(join(directory, 'prices', 'anthropic', 'claude-opus-5-5', 'pi-ai-catalog-2026-09-22.json'), 'utf8'))
  assert.deepEqual([price.provider, price.inputPerMillion, price.source], ['anthropic', '4', 'pi-ai catalog 2026-09-22'])
})

test('catalog prices estimate at read time; nothing derived is written into the fact log', async t => {
  let pricing
  const { store, directory } = await fixture(t, { rateCards: [], pricing: async () => ({ pricing }) })
  const request = { ...base, provider: 'anthropic', model: 'claude-opus-5-5' }
  await store.record({ ...request, phase: 'usage', usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 1000000 } })
  await store.record({ ...request, phase: 'finish' })
  assert.equal((await store.snapshot('session-one')).counts.unpriced, 1)
  pricing = catalogPricing
  store.catalog.clear()
  const later = await store.snapshot('session-one')
  assert.deepEqual(later.totals.map(t => [t.kind, t.amount, t.source]), [['estimated', '0.206', 'pi-ai-catalog-2026-09-22']])
  assert.ok(!(await readFile(sessionFile(directory), 'utf8')).includes('estimated'))
})

test('provider charges replace estimates; the same response reported twice counts once, the newer amount', async t => {
  const { store } = await fixture(t, { rateCards: [{ ...card, provider: 'openrouter' }] })
  const request = { ...base, provider: 'openrouter' }
  await store.record({ ...request, phase: 'usage', usage: { inputTokens: 1000, outputTokens: 200 } })
  const evidence = amount => ({ kind: 'openrouter', responseId: 'gen-fixture', reportedCost: { amount, currency: 'USD', scope: 'openrouter-account' }, outcome: 'reported' })
  await store.record({ ...request, phase: 'evidence', evidence: evidence('0.004') })
  await store.record({ ...request, requestId: 'reconciled', phase: 'evidence', evidence: evidence('0.005') })
  assert.deepEqual((await store.snapshot('session-one')).totals, [{ kind: 'reported', currency: 'USD', scope: 'openrouter-account', connection: 'openrouter-global', amount: '0.005' }])
})

test('pending, failed, incomplete and unpriced are distinct; a request id never changes route', async t => {
  const { store } = await fixture(t, { rateCards: [] })
  await store.record({ ...base, phase: 'start' })
  assert.deepEqual((({ pending, unpriced }) => [pending, unpriced])((await store.snapshot('session-one')).counts), [1, 0])
  await store.record({ ...base, phase: 'finish', finishReason: 'error' })
  await store.record({ ...base, requestId: 'partial', phase: 'usage', usage: { inputTokens: 10, outputTokens: 1 } })
  await store.record({ ...base, requestId: 'partial', phase: 'finish', finishReason: 'aborted' })
  await store.record({ ...base, requestId: 'partial', provider: 'anthropic', phase: 'usage', usage: { inputTokens: 99, outputTokens: 99 } })
  const counts = (await store.snapshot('session-one')).counts
  assert.deepEqual([counts.pending, counts.unpriced, counts.incomplete, counts.failed, counts.requests], [0, 1, 2, 1, 2])
})

test('restart: costs survive; unfinished requests become incomplete; a torn last line is skipped and terminated', async t => {
  const directory = await temp(t)
  const first = open(t, { directory, rateCards: [card], providers })
  await first.record({ ...base, phase: 'usage', usage: { inputTokens: 1000, outputTokens: 0 } })
  await first.close()
  await appendFile(sessionFile(directory), '{"v":1,"t":"usa')
  const second = open(t, { directory, rateCards: [{ ...card, inputPerMillion: '900' }], providers })
  const snapshot = await second.snapshot('session-one')
  assert.deepEqual([snapshot.counts.pending, snapshot.counts.incomplete, snapshot.sources[0].counts, snapshot.persistence], [0, 1, { incomplete: 1 }, 'ok'])
  assert.equal(snapshot.totals[0].amount, '0.9', 'priced with the current card, not a stored estimate')
  await second.record({ ...base, requestId: 'next', phase: 'start' })
  await second.close()
  const text = await readFile(sessionFile(directory), 'utf8')
  assert.ok(text.includes('{"v":1,"t":"usa\n{'), 'the torn line is terminated before the next append')
  assert.equal((await lines(sessionFile(directory)).catch(() => null)), null, 'the torn line itself stays unparsable')
})

const message = (seq, time, provider, model, usage, responseId) => ({ type: 'assistant/message', seq, time, data: { usage,
  message: { role: 'assistant', content: [], source: { kind: 'model', provider, model, ...(responseId ? { replayState: { response: { responseId, responseModel: 'anthropic/claude-opus-5.5' } } } : {}) } } } })
test('history backfill: once per session ever, receipts first, live spans covered, fork-inherited events excluded', async t => {
  const usage = { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 1000000 }
  const reads = [], lookups = []
  const at = iso => Date.parse(iso)
  const events = [
    message(1, at('2025-12-31T00:00:00Z'), 'openrouter', '~anthropic/claude-opus-latest', usage, 'gen-inherited'),
    message(5, at('2025-12-31T10:00:00Z'), 'openrouter', '~anthropic/claude-opus-latest', usage, 'gen-ok'),
    message(6, at('2025-12-31T10:01:00Z'), 'openrouter', '~anthropic/claude-opus-latest', usage, 'gen-missing'),
    message(7, at('2025-12-31T10:02:00Z'), 'anthropic-oauth', 'claude-opus-5-5', usage),
    message(8, at('2025-12-31T10:03:00Z'), 'anthropic', 'claude-opus-5-5', usage),
    message(9, at('2026-01-01T00:00:03Z'), 'openrouter', '~anthropic/claude-opus-latest', usage, 'gen-live'),
    message(10, at('2026-01-02T00:00:00Z'), 'anthropic', 'claude-opus-5-5', usage),
  ]
  const options = { rateCards: [], pricing: async route => route === 'anthropic-oauth' ? { listPricing: catalogPricing } : { pricing: catalogPricing },
    history: async id => { reads.push(id); return { inheritedEventCount: 1, events } },
    responseCost: async (route, id) => { lookups.push(id); if (id === 'gen-ok') return { amount: '0.5', currency: 'USD' }; throw Object.assign(new Error('missing'), { code: 'PROVIDER_ERROR' }) } }
  const { store, directory } = await fixture(t, options)
  // A live request spanning 00:00:00..00:00:04 covers message 9; message 10 (a day later, while the store could not write) is not covered.
  const live = { ...base, provider: 'openrouter', model: '~anthropic/claude-opus-latest' }
  await store.record({ ...live, phase: 'start' })
  await store.record({ ...live, at: '2026-01-01T00:00:04.000Z', phase: 'evidence', evidence: { kind: 'openrouter', responseId: 'gen-live', reportedCost: { amount: '0.25', currency: 'USD', scope: 'openrouter-account' }, outcome: 'reported' } })
  await store.record({ ...live, at: '2026-01-01T00:00:04.000Z', phase: 'finish', finishReason: 'stop' })
  await store.snapshot('session-one'); await settle()
  const snapshot = await store.snapshot('session-one')
  assert.deepEqual(reads, ['session-one'])
  assert.deepEqual(lookups, ['gen-ok', 'gen-missing'])
  const by = Object.fromEntries(snapshot.totals.map(t => [`${t.connection}/${t.kind}`, t.amount]))
  assert.deepEqual(by, { 'openrouter-global/reported': '0.75', 'openrouter-global/estimated': '0.206', 'anthropic-global/estimated': '0.412' })
  assert.deepEqual(snapshot.sources.find(s => s.icon === 'subscription').equivalent, [{ currency: 'USD', amount: '0.206' }], 'subscription history gets its API-price equivalent')
  assert.equal(snapshot.counts.requests, 6, 'live + seqs 5, 6, 7, 8, 10; inherited 1 and covered 9 skipped')
  const records = await lines(sessionFile(directory))
  assert.deepEqual(records.filter(r => r.t === 'request').map(r => r.req), ['history:5', 'history:6', 'history:7', 'history:8', 'history:10'])
  assert.deepEqual((({ through, inheritedEvents, added }) => ({ through, inheritedEvents, added }))(records.at(-1)), { through: 10, inheritedEvents: 1, added: 5 })
  // A new process sees the marker and reads nothing.
  await store.close()
  const again = open(t, { directory, providers, ...options })
  await again.snapshot('session-one'); await settle()
  assert.equal((await again.snapshot('session-one')).counts.requests, 6)
  assert.deepEqual([reads.length, lookups.length], [1, 2])
})

test('the first snapshot waits briefly for its backfill; slow work reports refreshing', async t => {
  const events = [message(3, Date.parse('2025-12-31T00:00:00Z'), 'anthropic', 'claude-opus-5-5', { inputTokens: 1000, outputTokens: 0 })]
  const { store } = await fixture(t, { rateCards: [], pricing: async () => ({ pricing: catalogPricing }), history: async () => ({ events }) })
  assert.equal((await store.snapshot('session-one')).totals[0].amount, '0.004')
  let release
  const gate = new Promise(resolve => { release = resolve })
  const slow = await fixture(t, { rateCards: [], firstLoadWaitMs: 10, pricing: async () => ({ pricing: catalogPricing }), history: async () => { await gate; return { events } } })
  const first = await slow.store.snapshot('session-one')
  assert.deepEqual([first.totals, first.refreshing], [[], true])
  release(); await settle()
  const later = await slow.store.snapshot('session-one')
  assert.deepEqual([later.totals[0].amount, later.refreshing], ['0.004', undefined])
})

test('refresh: an old reading is re-read while displayed; one used since its reading is re-read sooner', async t => {
  let clock = '2026-01-01T00:00:00.000Z', used = 10
  const calls = []
  const { store } = await fixture(t, { refreshAfterMs: 0, usageRefreshMs: 0, firstLoadWaitMs: 50, now: () => clock,
    usage: async route => { calls.push(route); used += 5; return { windows: [{ label: '5h', usedPercent: used }], observedAt: clock, account: { id: 'codex-acct', email: 'user@example.com' } } } })
  const codex = { ...base, sessionId: 'session-codex', provider: 'openai-codex-oauth', model: 'gpt-5.6-terra' }
  let current = (await store.snapshot('session-codex', 'openai-codex-oauth')).sources[0]
  assert.deepEqual([current.requests, current.name, current.quota.windows[0].usedPercent], [0, 'OpenAI', 15])
  await store.record({ ...codex, at: clock, phase: 'usage', usage: { inputTokens: 1, outputTokens: 1 } })
  await store.record({ ...codex, at: clock, phase: 'evidence', evidence: { kind: 'unobserved', outcome: 'unobserved' } })
  await store.record({ ...codex, at: clock, phase: 'finish', finishReason: 'stop' })
  clock = '2026-01-01T00:01:00.000Z'
  current = (await store.snapshot('session-codex')).sources[0]
  assert.equal(current.quota.windows[0].usedPercent, 20)
  assert.equal(calls.length, 2)
})

test('stale only after staleAfterMs', async t => {
  let clock = '2026-01-01T00:10:00.000Z'
  const { store } = await fixture(t, { firstLoadWaitMs: 50, now: () => clock,
    usage: async () => ({ windows: [{ label: '5h', usedPercent: 1 }], observedAt: '2026-01-01T00:00:00.000Z', account: { id: 'a' } }) })
  assert.equal((await store.snapshot('session-idle', 'anthropic-oauth')).sources[0].quota.stale, undefined)
  clock = '2026-01-01T00:21:00.000Z'
  assert.equal((await store.snapshot('session-idle', 'anthropic-oauth')).sources[0].quota.stale, true)
})

test('OAuth evidence on an API-key alias suppresses its estimate; token-like values never reach disk', async t => {
  const { store, directory } = await fixture(t, { rateCards: [{ ...card, provider: 'custom' }] })
  const alias = { ...base, provider: 'custom' }
  await store.record({ ...alias, phase: 'usage', usage: { inputTokens: 10, outputTokens: 10 } })
  assert.equal((await store.snapshot('session-one')).totals[0].kind, 'estimated')
  await store.record({ ...alias, phase: 'evidence', evidence: { kind: 'anthropic-oauth', authKind: 'oauth', outcome: 'unknown', token: 'never-persist-this' } })
  assert.deepEqual((await store.snapshot('session-one')).totals, [])
  await store.close()
  const all = (await readdir(directory, { recursive: true })).filter(name => name.endsWith('.json') || name.endsWith('.jsonl'))
  for (const name of all) assert.ok(!(await readFile(join(directory, name), 'utf8')).includes('never-persist-this'), name)
})

test('file names are safe for any route, model or session id', () => {
  assert.equal(fileName('~anthropic/claude-opus-latest'), '%7eanthropic%2fclaude-opus-latest')
  assert.equal(fileName('..'), '%2e.')
})

test('a write failure marks storage unhealthy but never throws into inference', async t => {
  const directory = await temp(t)
  const store = open(t, { directory, providers })
  await store.ready
  await rm(join(directory, 'sessions'), { recursive: true })
  await writeFile(join(directory, 'sessions'), 'not a directory')
  await store.record({ ...base, phase: 'start' })
  assert.equal((await store.snapshot('session-one')).persistence, 'error')
  await mkdir(join(directory, 'unused'), { recursive: true })
})

test('a local connection is billed in tokens: exact, never unpriced, and a request without usage is no gap', async t => {
  const { store, directory } = await fixture(t, { rateCards: [] })
  const local = { ...base, provider: 'lmstudio', model: 'qwen3.5-4b' }
  await store.record({ ...local, phase: 'usage', usage: { inputTokens: 5000, outputTokens: 500, cacheReadTokens: 2000 } })
  await store.record({ ...local, phase: 'finish', finishReason: 'stop' })
  await store.record({ ...local, requestId: 'request-no-usage', phase: 'finish', finishReason: 'stop' })
  const snapshot = await store.snapshot('session-one')
  assert.deepEqual(snapshot.totals, [{ kind: 'reported', currency: 'TOK', scope: 'local-tokens', connection: 'lmstudio-global', amount: '5500' }])
  assert.deepEqual([snapshot.counts.unpriced, snapshot.sources[0].icon, snapshot.sources[0].name, snapshot.sources[0].requests, snapshot.sources[0].cost, snapshot.sources[0].counts],
    [0, 'local', 'LM Studio', 2, [{ kind: 'reported', currency: 'TOK', amount: '5500' }], undefined])
  await store.close()
  assert.equal(JSON.parse(await readFile(join(directory, 'connections', 'lmstudio-global.json'), 'utf8')).auth, 'local')
})

test('sources: one per connection and model vendor, current first, with its own money, gaps, quota and account', async t => {
  let clock = '2026-01-01T00:10:00.000Z'
  const { store } = await fixture(t, { rateCards: [], now: () => clock, firstLoadWaitMs: 50,
    pricing: async route => route === 'anthropic-oauth' ? { listPricing: catalogPricing } : { pricing: catalogPricing },
    usage: async () => ({ windows: [{ label: '5h', usedPercent: 8 }, { label: '7d', usedPercent: 31 }], observedAt: clock, account: { id: 'acct', email: 'user@example.com', plan: 'claude_team' } }) })
  const at = minute => `2026-01-01T00:0${minute}:00.000Z`
  const router = (req, model, minute) => ({ ...base, requestId: req, provider: 'openrouter', model, at: at(minute) })
  for (const [req, model, minute] of [['r1', '~anthropic/claude-opus-latest', 1], ['r2', 'openai/gpt-4o-mini', 2]]) {
    await store.record({ ...router(req, model, minute), phase: 'usage', usage: { inputTokens: 1000, outputTokens: 0 } })
    await store.record({ ...router(req, model, minute), phase: 'evidence', evidence: { kind: 'openrouter', responseId: `gen-${req}`, reportedCost: { amount: '0.5', currency: 'USD', scope: 'openrouter-account' }, outcome: 'reported' } })
    await store.record({ ...router(req, model, minute), phase: 'finish' })
  }
  await store.record({ ...router('r3', '~anthropic/claude-opus-latest', 3), phase: 'finish', finishReason: 'error' })
  const oauth = { ...base, requestId: 'r4', provider: 'anthropic-oauth', model: 'claude-opus-5-5', at: at(5) }
  await store.record({ ...oauth, phase: 'usage', usage: { inputTokens: 1000, outputTokens: 0 } })
  await store.record({ ...oauth, phase: 'evidence', evidence: { kind: 'anthropic-oauth', outcome: 'plan-evidence', windows: [{ label: '5h', usedPercent: 8 }] } })
  await store.record({ ...oauth, phase: 'finish' })
  await store.snapshot('session-one'); await settle()
  const { sources } = await store.snapshot('session-one')
  assert.deepEqual(sources.map(s => [s.key, s.name, s.icon, s.requests]), [
    ['anthropic-oauth-global/anthropic', 'Anthropic', 'subscription', 1],
    ['openrouter-global/anthropic', 'Anthropic', 'openrouter', 2],
    ['openrouter-global/openai', 'OpenAI', 'openrouter', 1],
  ])
  const [sub, routerAnthropic] = sources
  assert.deepEqual([sub.equivalent, sub.cost, sub.account, sub.quota.windows.map(w => w.usedPercent), sub.model], [[{ currency: 'USD', amount: '0.004' }], undefined, { email: 'user@example.com', plan: 'claude_team' }, [8, 31], 'claude-opus-5-5'])
  assert.deepEqual([routerAnthropic.cost, routerAnthropic.counts, routerAnthropic.connectionLabel], [[{ kind: 'reported', currency: 'USD', amount: '0.5' }], { failed: 1 }, 'OpenRouter'])
  clock = '2026-01-01T01:00:00.000Z'
  assert.equal((await store.snapshot('session-one')).sources[0].quota.stale, true)
})

test('vendor names: router prefixes, plan and region suffixes, local connections by label', async () => {
  const { vendorOf } = await import('../store.mjs')
  assert.deepEqual(vendorOf({ provider: 'openrouter' }, '~x-ai/grok-5'), { id: 'x-ai', name: 'xAI' })
  assert.deepEqual(vendorOf({ provider: 'openai-codex' }), { id: 'openai', name: 'OpenAI' })
  assert.deepEqual(vendorOf({ provider: 'deepseek-official' }), { id: 'deepseek', name: 'DeepSeek' })
  assert.deepEqual(vendorOf({ provider: 'lmstudio', auth: 'local', label: 'LM Studio' }), { id: 'lmstudio', name: 'LM Studio' })
})

test('the /billing report lists the session\'s sources, then every provider but unused local ones; API keys show their last four characters', async t => {
  const hints = []
  const { store } = await fixture(t, { rateCards: [card], keyHint: async route => { hints.push(route); return route === 'openai' ? 'x9f2' : undefined } })
  await store.record({ ...base, phase: 'usage', usage: { inputTokens: 1000, outputTokens: 0 } })
  await store.record({ ...base, phase: 'finish' })
  const report = await store.report('session-one')
  assert.deepEqual(report.sources.map(s => [s.connection, s.name, s.icon, s.requests]), [
    ['openai-global', 'OpenAI', 'api', 1], ['openrouter-global', 'OpenRouter', 'openrouter', 0], ['anthropic-global', 'Anthropic', 'api', 0],
    ['anthropic-oauth-global', 'Anthropic', 'subscription', 0], ['openai-codex-oauth-global', 'OpenAI', 'subscription', 0]])
  assert.deepEqual([report.sources[0].keyHint, report.sources[1].keyHint, report.sources[3].keyHint], ['x9f2', undefined, undefined])
  await store.report('session-one')
  assert.equal(hints.filter(r => r === 'openai').length, 1, 'key hints are cached')
  assert.ok(!report.sources.some(s => s.icon === 'local'), 'an unused local model is left out')
  const local = { ...base, sessionId: 'session-local', provider: 'lmstudio', model: 'qwen3.5-4b' }
  await store.record({ ...local, phase: 'usage', usage: { inputTokens: 1200, outputTokens: 85 } })
  await store.record({ ...local, phase: 'finish' })
  const used = (await store.report('session-local')).sources[0]
  assert.deepEqual([used.icon, used.requests, used.cost], ['local', 1, [{ kind: 'reported', currency: 'TOK', amount: '1285' }]], 'a used local model is listed with its tokens')
})
