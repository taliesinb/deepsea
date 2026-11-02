import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig, snapshotHandler, apply } from '../index.js'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const request = (id = 'session-fixture', headers) => new Request(`http://localhost/api/deepsea-billing/snapshot?sessionId=${encodeURIComponent(id)}`, { headers })
test('snapshot API relies on DSH authentication alone; it validates parameters and hides ledger errors', async () => {
  const handler = snapshotHandler({ snapshot: async (sessionId, route) => ({ sessionId, route, version: 1 }) })
  const ok = await handler(new Request('http://localhost/api/deepsea-billing/snapshot?sessionId=session-fixture&route=anthropic-oauth'))
  assert.equal(ok.status, 200)
  assert.deepEqual(await ok.json(), { sessionId: 'session-fixture', route: 'anthropic-oauth', version: 1 })
  assert.equal((await handler(request('../escape'))).status, 400)
  assert.equal((await handler(new Request('http://localhost/x?sessionId=session-fixture&route=Bad Route'))).status, 400)
  const response = await snapshotHandler({ snapshot: async () => { throw new Error('private detail') } })(request())
  assert.equal(response.status, 503)
  assert.equal((await response.text()).includes('private detail'), false)
})
test('configuration rejects typoed or ambiguous rates', () => {
  assert.throws(() => resolveConfig({ mode: 'audit' }))
  assert.throws(() => resolveConfig({ staleAfterMs: -1 }))
  assert.throws(() => resolveConfig({ rateCards: [{ provider: 'anthropic-oauth' }] }))
  assert.equal(resolveConfig({}).staleAfterMs, 1200000)
  assert.equal(resolveConfig({}).refreshAfterMs, 300000)
  assert.throws(() => resolveConfig({ refreshAfterMs: 1000 }))
})
test('host mounts without OAuth/audit/commands/connection plugins and disposes capture', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'billing-host-'))
  const original = globalThis.fetch, disposers = [], services = new Map()
  const ctx = {
    effect(setup) { const dispose = setup(); disposers.push(dispose); return dispose },
    on() { return () => {} },
    provide(name, service) { services.set(name, service) },
    get(name) { return services.get(name) },
    inject() {},
  }
  try {
    apply(ctx, { directory })
    assert.ok(services.has('deepseaBilling'))
    const snapshot = await services.get('deepseaBilling').snapshot('session-fixture')
    assert.equal(snapshot.persistence, 'ok')
    assert.deepEqual(snapshot.totals, [])
    for (const dispose of disposers.reverse()) await dispose?.()
    assert.equal(globalThis.fetch, original)
  } finally { globalThis.fetch = original; await rm(directory, { recursive: true, force: true }) }
})
test('built-in DeepSeek prices are part of the resolved configuration', () => {
  const cards = resolveConfig({}).rateCards
  assert.deepEqual(cards.filter(c => c.provider === 'deepseek-official').map(c => c.model), ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-pro'])
})
test('a sign-in on a subscription route reads its quota at once, without a model request', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'billing-host-'))
  const disposers = [], services = new Map(), listeners = new Map(), reads = []
  const ctx = {
    effect(setup) { const dispose = setup(); disposers.push(dispose); return dispose },
    on(name, listener) { listeners.set(name, listener); return () => {} },
    provide(name, service) { services.set(name, service) },
    get(name) { return services.get(name) },
    inject() {},
    llm: {
      listProviders: () => [{ id: 'anthropic-oauth', auth: 'subscription', catalogProvider: 'anthropic' }, { id: 'anthropic', auth: 'api-key', catalogProvider: 'anthropic' }],
      subscriptionUsage: async (route) => { reads.push(route); return { windows: [{ label: '5h', usedPercent: 2 }], observedAt: '2026-01-01T00:00:00.000Z', account: { id: 'acct', email: 'user@example.com' } } },
    },
  }
  try {
    apply(ctx, { directory })
    const updated = listeners.get('credentials/record-updated')
    assert.equal(typeof updated, 'function')
    updated('llm-pi-ai/anthropic')   // an API-key route: no usage read
    updated('other-scope/anthropic-oauth')
    updated('llm-pi-ai/anthropic-oauth')
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.deepEqual(reads, ['anthropic-oauth'])
    for (const dispose of disposers.reverse()) await dispose?.()
  } finally { await rm(directory, { recursive: true, force: true }) }
})
test('a subscription route that appears after its sign-in reads its quota when it registers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'billing-host-'))
  const disposers = [], services = new Map(), listeners = new Map(), reads = []
  // The route is added only once the grant is stored, so the record event finds no route yet.
  let providers = [{ id: 'anthropic', auth: 'api-key', catalogProvider: 'anthropic' }]
  const ctx = {
    effect(setup) { const dispose = setup(); disposers.push(dispose); return dispose },
    on(name, listener) { listeners.set(name, listener); return () => {} },
    provide(name, service) { services.set(name, service) },
    get(name) { return services.get(name) },
    inject() {},
    llm: {
      listProviders: () => providers,
      subscriptionUsage: async (route) => { reads.push(route); return { windows: [{ label: '5h', usedPercent: 2 }], observedAt: '2026-01-01T00:00:00.000Z' } },
    },
  }
  try {
    apply(ctx, { directory })
    listeners.get('credentials/record-updated')('llm-pi-ai/anthropic-oauth')
    const appeared = listeners.get('llm/adapters-updated')
    assert.equal(typeof appeared, 'function')
    providers = [...providers, { id: 'anthropic-oauth', auth: 'subscription', catalogProvider: 'anthropic' }, { id: 'zai', auth: 'api-key', catalogProvider: 'zai' }]
    appeared()
    appeared()   // seen once: a later topology change does not read it again
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.deepEqual(reads, ['anthropic-oauth'])
    for (const dispose of disposers.reverse()) await dispose?.()
  } finally { await rm(directory, { recursive: true, force: true }) }
})
test('a Plan signed in before the server started is read once the credentials service is up', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'billing-host-'))
  const disposers = [], services = new Map(), listeners = new Map(), injected = new Map(), reads = []
  const ctx = {
    effect(setup) { const dispose = setup(); disposers.push(dispose); return dispose },
    on(name, listener) { listeners.set(name, listener); return () => {} },
    provide(name, service) { services.set(name, service) },
    get(name) { return services.get(name) },
    inject(names, callback) { injected.set(names.join(), callback) },
    llm: {
      listProviders: () => [{ id: 'anthropic-oauth', auth: 'subscription', catalogProvider: 'anthropic' }, { id: 'openai-codex-oauth', auth: 'subscription', catalogProvider: 'openai-codex' }, { id: 'anthropic', auth: 'api-key', catalogProvider: 'anthropic' }],
      subscriptionUsage: async (route) => { reads.push(route); return { windows: [{ label: '5h', usedPercent: 2 }], observedAt: new Date().toISOString(), account: { id: `acct-${route}`, email: 'user@example.com' } } },
    },
  }
  try {
    apply(ctx, { directory })
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.deepEqual(reads, [], 'nothing before the credentials service')
    injected.get('credentials')(ctx)
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.deepEqual(reads.sort(), ['anthropic-oauth', 'openai-codex-oauth'])
    assert.equal((await readdir(join(directory, 'accounts'))).length, 2, 'both accounts identified')
    for (const dispose of disposers.reverse()) await dispose?.()
  } finally { await rm(directory, { recursive: true, force: true }) }
})
