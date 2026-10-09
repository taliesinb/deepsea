import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { BillingStore, connectionIdOf } from './store.mjs'
import { validateRateCards } from './money.mjs'
import { withDefaultRates } from './default-rates.mjs'
import { encodeReport } from './report.mjs'
import { installCollector } from './collector.mjs'

export const name = 'deepsea-billing'
export const inject = ['llm']
export const SNAPSHOT_PATH = '/api/deepsea-billing/snapshot'
export function resolveConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['directory','rateCards','staleAfterMs','refreshAfterMs'].includes(key))) throw new TypeError('Invalid billing configuration')
  // The plugin's state directory under the variant's home (LAYOUT.md: $DSH_HOME/plugins/<name>/).
  const directory = input.directory ?? join(resolveDshHome(), 'plugins', 'billing')
  if (typeof directory !== 'string' || !directory || directory.includes('\0')) throw new TypeError('Invalid billing directory')
  const staleAfterMs = input.staleAfterMs ?? 1_200_000
  if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs < 1000 || staleAfterMs > 86_400_000) throw new TypeError('Invalid billing freshness interval')
  const refreshAfterMs = input.refreshAfterMs ?? 300_000
  if (!Number.isSafeInteger(refreshAfterMs) || refreshAfterMs < 60_000 || refreshAfterMs > 86_400_000) throw new TypeError('Invalid billing refresh interval')
  return { directory, staleAfterMs, refreshAfterMs, rateCards: validateRateCards(withDefaultRates(validateRateCards(input.rateCards))) }
}
export const Config = { '~standard': { version: 1, vendor: 'deepsea-billing', validate(input) {
  try { return { value: resolveConfig(input) } }
  catch (error) { return { issues: [{ message: error.message }] } }
} } }
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'vary': 'Cookie' } })

/** DSH authenticates /api before this handler; anyone it admits may read any session, as with transcripts. */
export function snapshotHandler(ledger) {
  return async request => {
    const params = new URL(request.url).searchParams
    const sessionId = params.get('sessionId') ?? ''
    if (!/^session-[a-zA-Z0-9_-]{1,140}$/.test(sessionId)) return json({ error: 'Invalid session' }, 400)
    // Optional selected route: only chooses which subscription account reading a ledger-less session shows.
    const route = params.get('route') ?? undefined
    if (route !== undefined && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(route)) return json({ error: 'Invalid route' }, 400)
    try { return json(await ledger.snapshot(sessionId, route)) } catch { return json({ error: 'Billing unavailable' }, 503) }
  }
}
export function apply(ctx, input) {
  const config = resolveConfig(input)
  // Prices come from DSH's model catalog (`pricing`, and `listPricing` for subscription routes, on
  // resolved model info), route metadata from `listProviders()`, subscription usage from
  // `ctx.llm.subscriptionUsage` (harness topic billing-metadata); each is optional on a harness without it.
  const ledger = new BillingStore({ ...config,
    pricing: async (provider, model) => { const info = await ctx.llm.resolveModelInfo(provider, model); return { pricing: info.pricing, listPricing: info.listPricing } },
    providers: () => { try { return ctx.llm.listProviders() } catch { return [] } },
    // Last four characters of a route's API key, for telling keys apart: the route's settings name the
    // credential (`apiKeyEnv`), the credentials service resolves it; the key itself never leaves here.
    keyHint: async route => {
      const entry = ctx.llm.listConfigurableProviders?.().find(p => p.provider === route)
      const settings = ctx.get?.('settings'), credentials = ctx.get?.('credentials')
      if (!entry || typeof settings?.describe !== 'function' || typeof credentials?.resolve !== 'function') return undefined
      let profile = settings.describe().find(d => d.ns === entry.settingsNs)?.value
      for (const step of entry.settingsPath ?? []) profile = profile?.[step]
      if (typeof profile?.apiKeyEnv !== 'string') return undefined
      const value = (await credentials.resolve(profile.apiKeyEnv))?.value
      return typeof value === 'string' && value.length >= 16 ? value.slice(-4) : undefined
    },
    usage: typeof ctx.llm?.subscriptionUsage === 'function' ? provider => ctx.llm.subscriptionUsage(provider) : undefined,
    // Optional: the session log (session-query) and receipt lookups price requests that predate the ledger.
    history: async sessionId => { const query = ctx.get?.('sessionQuery'); return typeof query?.readSession === 'function' ? query.readSession(sessionId) : undefined },
    responseCost: typeof ctx.llm?.responseCost === 'function' ? (provider, id) => ctx.llm.responseCost(provider, id) : undefined })
  ctx.effect(() => () => ledger.close(), 'billing: durable store')
  // A sign-in (or a refreshed grant) on a subscription route: read its account's quota now, so the
  // footer and /billing show it before the first model request. llm-pi-ai keeps each route's grant
  // at `llm-pi-ai/<route>`; the usage read costs no tokens.
  ctx.on('credentials/record-updated', (key) => {
    if (typeof key !== 'string' || !key.startsWith('llm-pi-ai/')) return
    const route = key.slice('llm-pi-ai/'.length)
    const info = (() => { try { return ctx.llm.listProviders().find(p => p.id === route) } catch { return undefined } })()
    if (info === undefined) return
    ledger.forgetUsage(route)
    if (ledger.connection(connectionIdOf(route), route).auth === 'subscription') ledger.requestUsage(route)
  })
  // A Plan signed in before this server started sends neither event: read every Plan route once the
  // credentials service is up (a read before it finds no credential and sends nothing).
  ctx.inject(['credentials'], () => { void ledger.readPlans() })
  // A sign-in adds its route only after the grant is stored, so the record event above finds no
  // route yet: read the quota of a subscription route when it first appears instead.
  const seenRoutes = new Set((() => { try { return ctx.llm.listProviders().map(p => p.id) } catch { return [] } })())
  ctx.on('llm/adapters-updated', () => {
    let providers
    try { providers = ctx.llm.listProviders() } catch { return }
    for (const info of providers) {
      if (seenRoutes.has(info.id)) continue
      seenRoutes.add(info.id)
      if (info.auth !== 'subscription') continue
      ledger.forgetUsage(info.id)
      ledger.requestUsage(info.id)
    }
  })
  ctx.provide('deepseaBilling', {
    // Trusted in-process extension point; there is deliberately no HTTP ingestion endpoint.
    observe: observation => ledger.record(observation),
    snapshot: sessionId => ledger.snapshot(sessionId),
  })
  installCollector(ctx, observation => { void ledger.record(observation) })
  ctx.inject(['connection'], web => {
    web.effect(() => web.connection.fetch.register({ path: SNAPSHOT_PATH, methods: ['GET'], requestBody: 'buffered', fetch: snapshotHandler(ledger) }), 'billing: snapshot route')
  })
  ctx.inject(['commands'], commands => {
    commands.effect(() => commands.commands.register({
      name: 'billing', description: 'Show billing for this session and every configured provider', recordInput: false,
      handler: async ({ agent, rawInput }) => {
        if (rawInput.trim()) return { kind: 'error', text: 'Usage: /billing' }
        // One line for the generic command row and the transcript, then the JSON report the browser card renders.
        const report = await ledger.report(agent.session.id)
        return { kind: report.persistence === 'ok' ? 'success' : 'error', text: encodeReport(report) }
      },
    }), 'billing: command')
  })
}
