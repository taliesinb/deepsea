import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { catalogCard, decimal, localTokenCost, priceUsage, units } from './money.mjs'

/**
 * Billing store: plain files under one directory, append-only where history matters.
 *
 *   sessions/<session-id>.jsonl          facts for one session, one record per line, never rewritten
 *   sessions/<session-id>.json           derived summary (cache for readers; rebuilt from the .jsonl)
 *   accounts/<provider>-<hash8>/         one billed account (subscription sign-in)
 *     identity.json latest.json          who it is; its current quota reading
 *     quota.jsonl                        every changed quota reading, append-only
 *   connections/<connection-id>.json     what a connection is (provider, auth kind, label, account)
 *   prices/<provider>/<model>/<version>.json   normalized price table with its source
 *
 * Connections: a connection is one set of credentials plus settings. DSH has one per provider route
 * today, so every route maps to the implicit connection `<route>-global`. Multi-login will add
 * connections with their own ids; records already carry the connection id, so nothing else changes.
 *
 * No lock: DSH runs one server per home, and this process serializes appends per file.
 */
export const STORE_VERSION = 1
export const IMPLICIT_CONNECTION_SUFFIX = '-global'
export const connectionIdOf = route => `${route}${IMPLICIT_CONNECTION_SUFFIX}`

const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_.:/~-]{1,160}$/.test(value) && !/sk-|bearer|password|secret/i.test(value) ? value : undefined
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\0-\x1f]/.test(value) ? value : undefined
/** File-name spelling of an identifier: unreserved characters kept, anything else percent-encoded. */
export const fileName = value => value.replace(/[^A-Za-z0-9_.-]/g, c => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`).replace(/^\./, '%2e')
/** Account key: provider plus the first 8 hex digits of SHA-256 over the provider's stable account id. */
export const accountKeyOf = (provider, id) => `${provider}-${createHash('sha256').update(`${provider}:${id}`).digest('hex').slice(0, 8)}`

const USAGE_KEYS = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']
function usageOf(value) {
  if (!value || !Number.isSafeInteger(value.inputTokens) || !Number.isSafeInteger(value.outputTokens)) return undefined
  const result = {}
  for (const key of USAGE_KEYS) {
    if (value[key] === undefined) continue
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) return undefined
    result[key] = value[key]
  }
  return result
}
function chargeOf(value) {
  if (!value || units(value.amount) === undefined || !/^[A-Z]{3}$/.test(value.currency ?? '')) return undefined
  return { amount: value.amount, currency: value.currency, source: value.source === 'openrouter' ? 'openrouter' : 'provider' }
}
function windowsOf(value) {
  if (!Array.isArray(value)) return []
  return value.slice(0, 8).flatMap(window => {
    if (typeof window?.label !== 'string' || !/^[a-zA-Z0-9 _.-]{1,32}$/.test(window.label) || !Number.isFinite(window.usedPercent) || window.usedPercent < 0 || window.usedPercent > 100) return []
    return [{ label: window.label, usedPercent: window.usedPercent,
      ...(Number.isFinite(window.windowMinutes) && window.windowMinutes >= 0 && window.windowMinutes <= 5256000 ? { windowMinutes: window.windowMinutes } : {}),
      ...(timestamp(window.resetAt) ? { resetAt: timestamp(window.resetAt) } : {}) }]
  })
}
/** The signed-in account (display only), with the provider's stable id when known. */
export function identityOf(value) {
  if (!value || typeof value !== 'object') return undefined
  const identity = {}
  for (const key of ['id', 'email', 'name', 'organization', 'plan']) if (text(value[key])) identity[key] = value[key]
  return Object.keys(identity).length ? identity : undefined
}
const OUTCOMES = { 'plan-evidence': 'plan', 'extra-usage': 'extra', plan: 'plan', 'quota-observed': 'quota', quota: 'quota', extra: 'extra',
  unknown: 'unknown', reported: 'unknown', rejected: 'rejected', unobserved: 'unobserved' }
const INCOMPLETE = ['error', 'aborted', 'cancelled', 'incomplete', 'superseded', 'returned']
const QUOTA_KINDS = ['plan', 'quota', 'extra']

/** Atomic whole-file write; writes to one path are serialized so the newest value lands last. */
const fileQueues = new Map()
let temps = 0
function writeJSON(path, value, ready) {
  return queued(path, async () => {
    await ready
    const temp = `${path}.${process.pid}.${++temps}.tmp`
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    await rename(temp, path)
  })
}
/** Append in call order to a file not owned by a session queue (account quota history). */
const appendLine = (path, line, ready) => queued(path, async () => { await ready; await appendFile(path, line, { mode: 0o600 }) })
function queued(path, run) {
  const next = (fileQueues.get(path) ?? Promise.resolve()).then(run, run)
  const settled = next.catch(() => {})
  fileQueues.set(path, settled)
  settled.then(() => { if (fileQueues.get(path) === settled) fileQueues.delete(path) })
  return next
}
async function readJSON(path) {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch { return undefined }
}
async function readLines(path) {
  let data
  try { data = await readFile(path, 'utf8') } catch (error) { if (error.code === 'ENOENT') return { records: [], torn: false, exists: false }; throw error }
  const records = []
  for (const line of data.split('\n')) {
    if (!line) continue
    // A torn or foreign line is skipped, never fatal: the rest of the history stays readable.
    try { const record = JSON.parse(line); if (record && typeof record === 'object') records.push(record) } catch { /* skipped */ }
  }
  return { records, torn: data.length > 0 && !data.endsWith('\n'), exists: true }
}

/** One session's requests, folded from its fact log. */
class SessionState {
  constructor(id) {
    this.id = id
    this.requests = new Map()
    this.backfill = undefined
    this.torn = false
    this.chain = Promise.resolve()
    this.busy = 0
    this.revision = 0
    this.summarized = -1
  }
  apply(record, live = false) {
    if (record.t === 'backfill') { this.backfill = { through: record.through ?? null, inheritedEvents: record.inheritedEvents ?? 0 }; return }
    const req = identifier(record.req)
    if (!req) return
    let request = this.requests.get(req)
    if (record.t === 'request') {
      // A complete request (history backfill or migration) replaces whatever was known.
      request = { req, connection: record.connection, route: record.route, model: record.model, startedAt: record.startedAt ?? record.at, at: record.at,
        ...(record.purpose ? { purpose: record.purpose } : {}), ...(record.usage ? { usage: record.usage } : {}), ...(record.charge ? { charge: record.charge } : {}),
        outcome: record.outcome ?? 'unknown', ...(record.responseId ? { responseId: record.responseId } : {}), ...(record.servedModel ? { servedModel: record.servedModel } : {}),
        ...(record.subscription ? { subscription: true } : {}), finished: true, incomplete: record.incomplete === true, origin: record.origin ?? 'import' }
      this.requests.delete(req)
      this.requests.set(req, request)
      this.revision++
      return
    }
    if (!request) {
      if (record.t !== 'start' && !record.connection) return
      request = { req, connection: record.connection, route: record.route, model: record.model, startedAt: record.at, at: record.at,
        ...(record.purpose ? { purpose: record.purpose } : {}), outcome: 'unobserved', finished: false, incomplete: false, origin: 'live' }
      this.requests.set(req, request)
    }
    request.at = record.at ?? request.at
    if (record.t === 'usage' && record.usage) request.usage = record.usage
    if (record.t === 'evidence') {
      request.outcome = record.outcome ?? request.outcome
      if (record.subscription) request.subscription = true
      if (record.responseId) request.responseId = record.responseId
      if (record.servedModel) request.servedModel = record.servedModel
      if (record.charge) request.charge = record.charge
      if (record.account) request.account = record.account
    }
    if (record.t === 'finish') {
      request.finished = true
      if (INCOMPLETE.includes(record.reason)) request.incomplete = true
    }
    this.revision++
  }
}

export class BillingStore {
  /**
   * @param {object} options
   * @param {string} options.directory - the store root.
   * @param {object[]} [options.rateCards] - configured per-route prices; they win over catalog prices.
   * @param {(route: string, model: string) => Promise<{ pricing?: object, listPricing?: object } | undefined>} [options.pricing]
   * @param {() => { id: string, name: string, catalogProvider?: string, auth?: 'subscription' | 'api-key' }[]} [options.providers]
   * @param {(route: string) => Promise<object | undefined>} [options.usage] - subscription usage reader.
   * @param {(sessionId: string) => Promise<{ events?: object[], inheritedEventCount?: number } | undefined>} [options.history]
   * @param {(route: string, responseId: string) => Promise<{ amount: string, currency: string } | undefined>} [options.responseCost]
   * @param {(route: string) => Promise<string | undefined>} [options.keyHint] - last four characters of a route's API key.
   */
  constructor({ directory, rateCards = [], staleAfterMs = 1_200_000, refreshAfterMs = 300_000, now = () => new Date().toISOString(),
    pricing, providers, usage, usageRetryMs = 300_000, usageRefreshMs = 60_000, history, responseCost, keyHint, firstLoadWaitMs = 5_000, maxSessions = 256 }) {
    Object.assign(this, { directory, cards: rateCards, staleAfterMs, refreshAfterMs, now, pricing, providers, usage, usageRetryMs, usageRefreshMs, history, responseCost, keyHint, firstLoadWaitMs, maxSessions })
    this.keyHints = new Map()
    this.sessions = new Map()
    this.accounts = new Map()
    this.connections = new Map()
    this.pending = new Map() // connection id -> quota reading not yet tied to an identified account
    this.catalog = new Map()
    this.pricesWritten = new Set()
    this.usageAttempts = new Map()
    this.activity = new Map()
    this.backfillWork = new Map()
    this.backfilled = new Set()
    this.persistence = 'ok'
    this.closed = false
    this.writes = new Set()
    this.ready = this.load().catch(() => { this.persistence = 'error' })
  }

  dir(...parts) { return join(this.directory, ...parts) }
  track(promise) {
    this.writes.add(promise)
    return promise.catch(() => { this.persistence = 'error' }).finally(() => this.writes.delete(promise))
  }

  async load() {
    for (const sub of ['sessions', 'accounts', 'connections', 'prices']) await mkdir(this.dir(sub), { recursive: true, mode: 0o700 })
    for (const name of await readdir(this.dir('connections')).catch(() => [])) {
      if (!name.endsWith('.json')) continue
      const value = await readJSON(this.dir('connections', name))
      if (!identifier(value?.id)) continue
      this.connections.set(value.id, value)
      if (value.reading && QUOTA_KINDS.includes(value.reading.kind)) this.pending.set(value.id, { ...value.reading, windows: windowsOf(value.reading.windows) })
    }
    for (const name of await readdir(this.dir('accounts')).catch(() => [])) {
      const identity = await readJSON(this.dir('accounts', name, 'identity.json'))
      const latest = await readJSON(this.dir('accounts', name, 'latest.json'))
      if (!identifier(identity?.key)) continue
      this.accounts.set(identity.key, { key: identity.key, provider: identity.provider, identity: identityOf(identity) ?? {}, firstSeen: identity.firstSeen,
        ...(latest && QUOTA_KINDS.includes(latest.kind) ? { latest: { ...latest, windows: windowsOf(latest.windows) } } : {}),
        signature: latest ? signature(latest) : undefined })
    }
  }

  // ---- connections and accounts ----

  /** What a connection is. Implicit connections are derived from the route and the adapter's route metadata. */
  connection(id, route) {
    const known = this.connections.get(id)
    const info = this.providers?.().find(p => p.id === route)
    const auth = info?.auth ?? known?.auth
    const value = { version: STORE_VERSION, id, route, provider: info?.catalogProvider ?? known?.provider ?? route, ...(auth ? { auth } : {}),
      label: known?.labelSetByUser ? known.label : info?.name ?? known?.label ?? route, implicit: id === connectionIdOf(route),
      ...(known?.account ? { account: known.account } : {}), firstSeen: known?.firstSeen ?? this.now() }
    if (!known || ['provider', 'auth', 'label', 'route'].some(key => known[key] !== value[key])) {
      if (known?.reading) value.reading = known.reading
      this.connections.set(id, value)
      this.track(writeJSON(this.dir('connections', `${fileName(id)}.json`), value))
    }
    return this.connections.get(id)
  }
  bindAccount(connectionId, key) {
    const known = this.connections.get(connectionId)
    if (!known || known.account === key) return
    const value = { ...known, account: key }
    this.connections.set(connectionId, value)
    this.track(writeJSON(this.dir('connections', `${fileName(connectionId)}.json`), value))
  }
  /** Identify (and remember) the account behind a usage reading. */
  account(provider, identity) {
    const id = identity?.id ?? (identity?.email ? `email:${identity.email}` : undefined)
    if (!id) return undefined
    const key = accountKeyOf(provider, id)
    const held = this.accounts.get(key)
    const merged = { ...(held?.identity ?? {}), ...identity }
    if (!held || JSON.stringify(held.identity) !== JSON.stringify(merged)) {
      const account = { key, provider, identity: merged, firstSeen: held?.firstSeen ?? this.now(), ...(held?.latest ? { latest: held.latest } : {}), signature: held?.signature }
      this.accounts.set(key, account)
      // The provider's raw account id stays out of the file: the key is its hash.
      const { id: _raw, ...shown } = merged
      this.track(writeJSON(this.dir('accounts', key, 'identity.json'), { version: STORE_VERSION, key, provider, ...shown, firstSeen: account.firstSeen, lastSeen: this.now() }, this.accountDir(key)))
    }
    return key
  }
  accountDir(key) {
    this.dirs ??= new Map()
    if (!this.dirs.has(key)) this.dirs.set(key, mkdir(this.dir('accounts', key), { recursive: true, mode: 0o700 }))
    return this.dirs.get(key)
  }
  /** Record a quota reading for an account: newest wins; history gets a line only when something changed. */
  quota(key, reading) {
    const account = this.accounts.get(key)
    if (!account || !QUOTA_KINDS.includes(reading.kind)) return
    if (account.latest && Date.parse(account.latest.at) > Date.parse(reading.at)) return
    account.latest = reading
    const sign = signature(reading)
    const changed = sign !== account.signature
    account.signature = sign
    // Queued at call time, so the files take readings in the order they were accepted.
    const ready = this.accountDir(key)
    this.track(writeJSON(this.dir('accounts', key, 'latest.json'), { version: STORE_VERSION, ...reading }, ready))
    if (changed) this.track(appendLine(this.dir('accounts', key, 'quota.jsonl'), `${JSON.stringify({ v: STORE_VERSION, ...reading })}\n`, ready))
  }
  /** A reading for a connection: to its account when identified, else held until a usage read identifies it. */
  reading(connection, reading) {
    if (connection.account) return this.quota(connection.account, reading)
    this.hold(connection.id, reading)
    this.requestUsage(connection.route, connection.id)
  }

  /** Keep a reading with its connection (and on disk) until a usage read names the account. */
  hold(connectionId, reading) {
    const held = this.pending.get(connectionId)
    if (held && Date.parse(held.at) > Date.parse(reading.at)) return
    this.pending.set(connectionId, reading)
    const value = { ...this.connections.get(connectionId), reading }
    this.connections.set(connectionId, value)
    this.track(writeJSON(this.dir('connections', `${fileName(connectionId)}.json`), value))
  }

  /**
   * Forget a route's last usage read, so the next request reads again at once (a sign-in or a
   * refreshed grant: the earlier read may have found no credential).
   */
  forgetUsage(route) {
    if (this.usageAttempts.get(route)?.state !== 'pending') this.usageAttempts.delete(route)
  }

  /**
   * One usage read per route at a time; failures back off; repeats only after `repeatAfterMs`. A read
   * that answers nothing (no sign-in yet, an endpoint without a usage contract) is retried after
   * `usageRefreshMs`, not treated as done: the grant can arrive later.
   */
  requestUsage(route, connectionId = connectionIdOf(route), repeatAfterMs) {
    if (!this.usage || this.closed) return
    const attempt = this.usageAttempts.get(route)
    if (attempt?.state === 'pending') return
    if (attempt?.state === 'failed' && Date.now() < attempt.retryAt) return
    if (attempt?.state === 'done' && !(repeatAfterMs !== undefined && Date.now() - attempt.doneAt >= repeatAfterMs)) return
    // After the store has loaded, so a reading read at startup is not overwritten by the one on disk.
    const promise = this.ready.then(() => this.usage(route)).then(result => {
      // Nothing answered means nothing was sent (no credential, or no usage contract): `unanswered`.
      if (!result) { this.usageAttempts.set(route, { state: 'failed', unanswered: true, retryAt: Date.now() + this.usageRefreshMs }); return }
      this.usageAttempts.set(route, { state: 'done', doneAt: Date.now() })
      const connection = this.connection(connectionId, route)
      const key = this.account(connection.provider, identityOf(result.account))
      if (key) this.bindAccount(connectionId, key)
      const bound = this.connections.get(connectionId)
      const reading = Array.isArray(result.windows) && result.windows.length
        // Codex windows are an account quota, not an Anthropic-style claim that a request was billed to a plan.
        ? { at: timestamp(result.observedAt) ?? this.now(), kind: connection.provider === 'openai-codex' ? 'quota' : 'plan', windows: windowsOf(result.windows),
          source: 'usage-endpoint', connection: connectionId, ...(typeof result.extraUsageEnabled === 'boolean' ? { extraUsageEnabled: result.extraUsageEnabled } : {}) }
        : undefined
      if (!bound?.account) { if (reading) this.hold(connectionId, reading); return }
      const held = this.pending.get(connectionId)
      if (held) {
        this.pending.delete(connectionId)
        this.quota(bound.account, held)
        const { reading: _held, ...value } = this.connections.get(connectionId)
        this.connections.set(connectionId, value)
        this.track(writeJSON(this.dir('connections', `${fileName(connectionId)}.json`), value))
      }
      if (reading) this.quota(bound.account, reading)
    }).catch(error => {
      const seconds = /retry after (\d+)s/.exec(String(error?.message))?.[1]
      this.usageAttempts.set(route, { state: 'failed', retryAt: Date.now() + Math.max(this.usageRetryMs, Number(seconds ?? 0) * 1000) })
    })
    this.usageAttempts.set(route, { state: 'pending', promise })
  }

  /**
   * Read a Plan route's account and windows unless a read holds it back: a read that answered nothing
   * sent nothing, so it does not; a pending, done or failed one keeps the rules above.
   */
  readPlan(route, connectionId = connectionIdOf(route)) {
    if (this.usageAttempts.get(route)?.unanswered) this.usageAttempts.delete(route)
    this.requestUsage(route, connectionId)
  }

  /**
   * Read every Plan route DSH serves whose account has no reading younger than `refreshAfterMs`: a
   * Plan signed in before the server started sends no sign-in event, so nothing else reads it before
   * the first model request.
   */
  async readPlans() {
    await this.ready
    for (const info of this.providers?.() ?? []) {
      if (info.auth !== 'subscription' || this.closed) continue
      const connection = this.connection(connectionIdOf(info.id), info.id)
      const latest = connection.account ? this.accounts.get(connection.account)?.latest : undefined
      if (latest && Date.parse(this.now()) - Date.parse(latest.at) <= this.refreshAfterMs) continue
      this.readPlan(info.id, connection.id)
    }
  }

  // ---- sessions ----

  session(id) {
    let state = this.sessions.get(id)
    if (state) { this.sessions.delete(id); this.sessions.set(id, state); return state }
    state = new SessionState(id)
    this.sessions.set(id, state)
    this.enqueue(state, async () => {
      await this.ready
      const { records, torn } = await readLines(this.dir('sessions', `${fileName(id)}.jsonl`))
      for (const record of records) state.apply(record)
      // A previous process's unfinished request is no longer live; its known usage and cost stay.
      for (const request of state.requests.values()) if (!request.finished) { request.finished = true; request.incomplete = true }
      state.torn = torn
    })
    this.evict()
    return state
  }
  evict() {
    for (const [id, state] of this.sessions) {
      if (this.sessions.size <= this.maxSessions) return
      if (state.busy || [...state.requests.values()].some(r => !r.finished) || this.backfillWork.has(id)) continue
      this.sessions.delete(id)
    }
  }
  /** Run `fn` after everything already queued for this session; one queue per session keeps its file in order. */
  enqueue(state, fn) {
    state.busy++
    state.chain = state.chain.then(fn).catch(() => { this.persistence = 'error' }).finally(() => { state.busy-- })
    return state.chain
  }
  /** Fold records into memory and append them to the session's fact log. Call only from inside the session's queue. */
  async write(state, records) {
    for (const record of records) state.apply(record, true)
    const lines = records.map(record => JSON.stringify({ v: STORE_VERSION, ...record })).join('\n')
    const prefix = state.torn ? '\n' : ''
    state.torn = false
    await this.track(appendFile(this.dir('sessions', `${fileName(state.id)}.jsonl`), `${prefix}${lines}\n`, { mode: 0o600 }))
  }

  /** One collector observation. Must enqueue quickly; never throws into inference. */
  record(observation) {
    if (this.closed) return Promise.resolve()
    const sessionId = identifier(observation?.sessionId), req = identifier(observation?.requestId)
    const route = identifier(observation?.provider), model = identifier(observation?.model), at = timestamp(observation?.at)
    if (!sessionId || !req || !route || !model || !at) return Promise.resolve()
    const state = this.session(sessionId)
    return this.enqueue(state, async () => {
      const request = state.requests.get(req)
      // Never reattribute a request id to another route or model after recording it.
      if (request && (request.route !== route || request.model !== model)) return
      const connection = this.connection(request?.connection ?? connectionIdOf(route), route)
      const records = []
      if (!request) records.push({ t: 'start', at, req, connection: connection.id, route, model, ...(identifier(observation.purpose) ? { purpose: observation.purpose } : {}) })
      const extra = { at, req }
      if (observation.phase === 'usage') {
        const usage = usageOf(observation.usage)
        if (usage) records.push({ ...extra, t: 'usage', usage })
      }
      if (observation.phase === 'evidence') {
        const evidence = observation.evidence ?? {}
        const subscription = evidence.authKind === 'oauth' || ['anthropic-oauth', 'openai-codex'].includes(evidence.kind)
        const charge = evidence.kind === 'openrouter' && evidence.reportedCost ? chargeOf({ ...evidence.reportedCost, source: 'openrouter' }) : undefined
        const outcome = OUTCOMES[evidence.outcome] ?? 'unknown'
        records.push({ ...extra, t: 'evidence', outcome, ...(subscription ? { subscription: true } : {}), ...(Number.isSafeInteger(evidence.status) ? { status: evidence.status } : {}),
          ...(identifier(evidence.responseId) ? { responseId: evidence.responseId } : {}), ...(identifier(evidence.servedModel) ? { servedModel: evidence.servedModel } : {}),
          ...(charge ? { charge } : {}), ...(connection.account ? { account: connection.account } : {}) })
        const windows = windowsOf(evidence.windows)
        if (QUOTA_KINDS.includes(outcome) && (windows.length || outcome === 'extra')) {
          this.reading(connection, { at, kind: outcome, windows, source: 'response-headers', connection: connection.id,
            ...(evidence.kind === 'openai-codex' && typeof evidence.credits?.hasCredits === 'boolean' && typeof evidence.credits?.unlimited === 'boolean'
              ? { credits: { hasCredits: evidence.credits.hasCredits, unlimited: evidence.credits.unlimited, ...(units(evidence.credits.balance) !== undefined ? { balance: evidence.credits.balance } : {}) } } : {}) })
        } else if (subscription && !connection.account) this.requestUsage(route, connection.id)
      }
      if (observation.phase === 'finish') {
        records.push({ ...extra, t: 'finish', reason: identifier(observation.finishReason) ?? 'complete' })
        // Used the account without seeing its reading: the remembered reading is now behind.
        const current = state.requests.get(req)
        if ((connection.auth === 'subscription' || current?.subscription) && (current?.outcome ?? 'unobserved') === 'unobserved' && current?.usage) this.activity.set(route, at)
      }
      if (records.length) await this.write(state, records)
    })
  }

  // ---- prices ----

  /** Charged or list price card for a route/model; cached ten minutes; written once per version for inspection. */
  async card(route, model, basis, provider) {
    if (basis === 'charged') {
      const configured = this.cards.find(card => card.provider === route && card.model === model)
      if (configured) { this.writePrice(provider ?? route, model, configured); return configured }
    }
    if (!this.pricing) return undefined
    const key = `${route}/${model}`
    let hit = this.catalog.get(key)
    if (!hit || Date.now() - hit.at >= 600_000) {
      let info
      try { info = await this.pricing(route, model) } catch { info = undefined }
      hit = { at: Date.now(), charged: catalogCard(route, model, info?.pricing), list: catalogCard(route, model, info?.listPricing) }
      this.catalog.set(key, hit)
    }
    const card = basis === 'charged' ? hit.charged : hit.list
    if (card) this.writePrice(provider ?? route, model, card)
    return card
  }
  writePrice(provider, model, card) {
    const path = this.dir('prices', fileName(provider), fileName(model), `${fileName(card.version)}.json`)
    if (this.pricesWritten.has(path)) return
    this.pricesWritten.add(path)
    this.track((async () => {
      try { await stat(path); return } catch { /* not written yet */ }
      await mkdir(this.dir('prices', fileName(provider), fileName(model)), { recursive: true, mode: 0o700 })
      const { provider: _route, model: _model, ...rates } = card
      await writeJSON(path, { version: STORE_VERSION, provider, model, ...rates, recordedAt: this.now() })
    })())
  }
  /** Estimate for one request at the given basis, trying the requested then the served model. */
  async estimate(request, connection, basis) {
    for (const model of [request.model, request.servedModel]) {
      if (!model) continue
      const card = await this.card(request.route, model, basis, connection.provider)
      const cost = priceUsage(request.usage, card, request.startedAt)
      if (cost) return { ...cost, scope: basis === 'charged' && connection.provider === 'openrouter' ? 'openrouter-tokens' : 'model-tokens' }
    }
    return undefined
  }

  // ---- history backfill and migration ----

  /**
   * Requests in the session log that this store never saw (before it existed, or while it could not
   * write) are recorded once from the log: OpenRouter generations by their receipt, the rest priced
   * at read time. A `backfill` marker makes it once per session ever. Live requests cover the log
   * messages that fall inside their start..finish span; fork-inherited events are the parent's.
   */
  requestBackfill(sessionId) {
    if (!this.history || this.closed || this.backfilled.has(sessionId)) return
    this.backfilled.add(sessionId)
    const state = this.session(sessionId)
    // Live requests cover log messages inside their start..finish span (open-ended while in flight).
    const covering = request => {
      const start = Date.parse(request.startedAt) - 1000
      const end = request.finished ? Date.parse(request.at) + 5000 : Infinity
      return time => start <= time && time <= end
    }
    const covered = (route, time) => [...state.requests.values()].some(r => r.origin === 'live' && r.route === route && covering(r)(time))
    const work = (async () => {
      await state.chain
      if (state.backfill) return
      // The slow part (reading the log, receipt lookups) runs outside the session's queue so live
      // requests keep recording; the final coverage check and append run inside it.
      const log = await this.history(sessionId)
      if (!log || !Array.isArray(log.events)) return
      const inherited = Number.isSafeInteger(log.inheritedEventCount) ? log.inheritedEventCount : 0
      const items = []
      let through = null
      for (const event of log.events.slice(inherited)) {
        if (Number.isSafeInteger(event?.seq)) through = event.seq
        if (event?.type !== 'assistant/message') continue
        const source = event.data?.message?.source
        const route = identifier(source?.provider), model = identifier(source?.model), usage = usageOf(event.data?.usage)
        if (source?.kind !== 'model' || !route || !model || !usage || !Number.isFinite(event.time)) continue
        const req = `history:${event.seq}`
        if (state.requests.has(req) || covered(route, event.time)) continue
        items.push({ req, route, model, usage, time: event.time, at: new Date(event.time).toISOString(),
          responseId: identifier(source.replayState?.response?.responseId), servedModel: identifier(source.replayState?.response?.responseModel) })
      }
      let lookups = 0, stopped = false
      for (const item of items) {
        item.connection = this.connection(connectionIdOf(item.route), item.route)
        if (item.connection.provider !== 'openrouter' || !item.responseId || !this.responseCost || stopped || lookups >= 500) continue
        lookups++
        try { item.charge = chargeOf({ ...(await this.responseCost(item.route, item.responseId)), source: 'openrouter' }) } catch (error) {
          // Rate limits or auth failures stop further lookups; the rest are priced from the catalog.
          if (/RATE_LIMIT|AUTH/.test(String(error?.code))) stopped = true
        }
      }
      await this.enqueue(state, async () => {
        if (state.backfill) return
        const records = items.filter(item => !state.requests.has(item.req) && !covered(item.route, item.time)).map(item => ({
          t: 'request', origin: 'session-log', req: item.req, connection: item.connection.id, route: item.route, model: item.model, at: item.at, startedAt: item.at,
          usage: item.usage, outcome: 'unknown', ...(item.connection.auth === 'subscription' ? { subscription: true } : {}),
          ...(item.responseId ? { responseId: item.responseId } : {}), ...(item.servedModel ? { servedModel: item.servedModel } : {}), ...(item.charge ? { charge: item.charge } : {}) }))
        records.push({ t: 'backfill', at: this.now(), through, inheritedEvents: inherited, added: records.length })
        await this.write(state, records)
      })
    })().catch(() => { /* history unavailable: try again in a later process */ }).finally(() => this.backfillWork.delete(sessionId))
    this.backfillWork.set(sessionId, work)
  }

  // ---- reading ----

  /**
   * The quota reading to show for a session: its connection's account reading (quota is account-wide),
   * or a bare marker so the client shows the right glyph. Asks for a usage read when nothing fresh is known.
   */
  latestFor(state, routeHint, now, request = true) {
    const ordered = [...state.requests.values()].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))
    const last = ordered[ordered.length - 1]
    const route = last?.route ?? identifier(routeHint)
    if (!route) return undefined
    const connection = this.connection(last?.connection ?? connectionIdOf(route), route)
    const subscription = connection.auth === 'subscription' || last?.subscription
    const base = { provider: route, connection: connection.id, model: last?.model ?? 'account', at: last?.at ?? now, kind: last ? last.outcome : 'unobserved', windows: [] }
    if (!subscription) return last ? base : undefined
    const account = connection.account ? this.accounts.get(connection.account) : undefined
    const reading = account?.latest ?? this.pending.get(connection.id)
    if (request) {
      const read = Boolean(reading)
      const aged = read && Date.parse(now) - Date.parse(reading.at) > this.refreshAfterMs
      const used = this.activity.get(route)
      const behind = used !== undefined && read && Date.parse(used) > Date.parse(reading.at)
      if (!read || !account || aged || behind) this.requestUsage(route, connection.id, behind ? this.usageRefreshMs : aged ? this.refreshAfterMs : undefined)
    }
    if (!reading) return { ...base, kind: last?.outcome === 'rejected' ? 'rejected' : 'unobserved' }
    const identity = account?.identity ? (({ id: _id, ...shown }) => shown)(account.identity) : undefined
    return { ...base, at: reading.at, kind: last?.outcome === 'rejected' ? 'rejected' : reading.kind, windows: reading.windows,
      ...(reading.source ? { source: reading.source } : {}), ...(reading.credits ? { credits: reading.credits } : {}),
      ...(account ? { accountKey: account.key } : {}), ...(identity && Object.keys(identity).length ? { account: identity } : {}) }
  }

  async snapshot(sessionId, routeHint) {
    await this.ready
    const state = this.session(sessionId)
    await state.chain
    this.requestBackfill(sessionId)
    const wait = promise => promise ? Promise.race([promise, new Promise(resolve => setTimeout(resolve, this.firstLoadWaitMs).unref?.())]) : undefined
    await wait(this.backfillWork.get(sessionId))
    {
      const peek = this.latestFor(state, routeHint, this.now())
      const attempt = peek && this.usageAttempts.get(peek.provider)
      if (attempt?.state === 'pending') await wait(attempt.promise)
    }
    await state.chain
    const now = this.now()
    const requests = [...state.requests.values()]
    const totals = new Map()
    const counts = { requests: requests.length, pending: 0, unpriced: 0, subscription: 0, incomplete: 0, failed: 0 }
    const priced = []
    for (const request of requests) {
      const connection = this.connection(request.connection, request.route)
      const subscription = connection.auth === 'subscription' || request.subscription || QUOTA_KINDS.includes(request.outcome)
      let cost, local = false
      if (request.charge) cost = { kind: 'reported', amount: request.charge.amount, currency: request.charge.currency, scope: request.charge.source === 'openrouter' ? 'openrouter-account' : 'provider-account' }
      else if (connection.auth === 'local') {
        // A model served on this machine is billed in tokens (money.mjs localTokenCost).
        local = true
        cost = localTokenCost(request.usage)
        if (cost && request.incomplete && units(cost.amount) === 0n) cost = undefined
      }
      else if (!subscription && request.usage) {
        cost = await this.estimate(request, connection, 'charged')
        // pi-ai emits a zero usage placeholder even when no provider usage arrived.
        if (cost && request.incomplete && units(cost.amount) === 0n) cost = undefined
      }
      let list
      if (subscription && request.usage) list = await this.estimate(request, connection, 'list')
      priced.push({ request, connection, subscription, cost, list, local })
    }
    // Reconciliation of the same provider response is not another charge: the last record wins.
    const receipts = new Set()
    const sources = new Map()
    const sourceOf = (request, connection, subscription, local) => {
      const vendor = vendorOf(connection, request.model)
      const key = `${connection.id}/${vendor.id}`
      let source = sources.get(key)
      if (!source) {
        source = { key, name: vendor.name, icon: subscription ? 'subscription' : local ? 'local' : connection.provider === 'openrouter' ? 'openrouter' : 'api',
          connection: connection.id, connectionLabel: connection.label, requests: 0, startedAt: request.startedAt, lastAt: request.at, model: request.model,
          cost: new Map(), equivalent: new Map(), counts: { unpriced: 0, incomplete: 0, failed: 0 } }
        sources.set(key, source)
      }
      source.requests++
      if (request.startedAt > source.startedAt) { source.startedAt = request.startedAt; source.model = request.model }
      if (request.at > source.lastAt) source.lastAt = request.at
      return source
    }
    const add = (map, kind, amount, currency) => {
      const key = `${kind}/${currency}`
      const entry = map.get(key) ?? { kind, currency, units: 0n }
      entry.units += units(amount)
      map.set(key, entry)
    }
    for (const { request, connection, subscription, cost, list, local } of priced.reverse()) {
      const source = sourceOf(request, connection, subscription, local)
      if (list) add(source.equivalent, 'estimated', list.amount, list.currency)
      // Each request counts as one gap at most: failed (no usage, not billed), else partial, else unpriced.
      const gap = !cost && !subscription && !local && request.finished && request.incomplete && !request.usage ? 'failed'
        : request.incomplete ? 'incomplete' : !cost && !subscription && !local && request.finished ? 'unpriced' : undefined
      if (gap) source.counts[gap]++
      if (!request.finished) counts.pending++
      if (request.incomplete) counts.incomplete++
      if (subscription && request.outcome !== 'rejected') counts.subscription++
      if (!cost) {
        // A local request without usage is not counted, and not a gap either.
        if (subscription || local || !request.finished) continue
        if (request.incomplete && !request.usage) counts.failed++
        else counts.unpriced++
        continue
      }
      if (cost.kind === 'reported' && request.responseId) {
        const receipt = `${request.route}/${request.responseId}`
        if (receipts.has(receipt)) continue
        receipts.add(receipt)
      }
      add(source.cost, cost.kind, cost.amount, cost.currency)
      const key = `${connection.id}/${cost.kind}/${cost.currency}/${cost.scope}`
      const total = totals.get(key) ?? { kind: cost.kind, currency: cost.currency, scope: cost.scope, connection: connection.id, units: 0n, sources: new Set() }
      total.units += units(cost.amount)
      if (cost.kind === 'estimated' && cost.pricingVersion) total.sources.add(cost.pricingVersion)
      totals.set(key, total)
    }
    const finish = ({ units: amount, sources, ...rest }) => ({ ...rest, amount: decimal(amount), ...(sources.size === 1 ? { source: [...sources][0] } : {}) })
    const latest = this.latestFor(state, routeHint, now, false)
    // `sources` is what the card shows; `totals` (money by connection, kind and currency) is the
    // session summary for the /billing command and the summary file.
    const snapshot = { version: 2, sessionId, sources: await this.withKeyHints(this.describeSources([...sources.values()], latest, now)),
      totals: [...totals.values()].map(finish), counts, persistence: this.persistence, now,
      ...(this.backfillWork.has(sessionId) || (latest && this.usageAttempts.get(latest.provider)?.state === 'pending') ? { refreshing: true } : {}) }
    this.summarize(state, snapshot)
    return snapshot
  }
  /**
   * The card's source list: one entry per connection and model vendor, the source of the latest
   * request first, then by recency. A subscription source carries its account's quota reading
   * and identity; every source carries its own gaps (only the first source's become warnings).
   */
  describeSources(list, latest, now) {
    const money = map => [...map.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.currency.localeCompare(b.currency)).map(({ units: amount, ...rest }) => ({ ...rest, amount: decimal(amount) }))
    const ordered = list.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    const isStale = at => Date.parse(now) - Date.parse(at) > this.staleAfterMs || Date.parse(now) < Date.parse(at)
    // No request recorded yet but the selected route is a subscription: show its account anyway.
    if (!ordered.length && latest && QUOTA_KINDS.concat('unobserved', 'rejected').includes(latest.kind) && this.connections.get(latest.connection)?.auth === 'subscription') {
      const connection = this.connections.get(latest.connection)
      ordered.push({ key: `${connection.id}/none`, name: vendorOf(connection).name, icon: 'subscription', connection: connection.id, connectionLabel: connection.label,
        requests: 0, cost: new Map(), equivalent: new Map(), counts: {} })
    }
    return ordered.map(source => {
      const { startedAt: _started, cost, equivalent, counts, ...rest } = source
      const out = { ...rest, ...(cost.size ? { cost: money(cost) } : {}), ...(equivalent.size ? { equivalent: money(equivalent).map(({ kind: _kind, ...e }) => e) } : {}),
        ...(Object.values(counts).some(Boolean) ? { counts: Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0)) } : {}) }
      if (source.icon !== 'subscription') return out
      const connection = this.connections.get(source.connection)
      const account = connection?.account ? this.accounts.get(connection.account) : undefined
      const reading = account?.latest ?? this.pending.get(source.connection)
      if (reading) out.quota = { at: reading.at, ...(isStale(reading.at) ? { stale: true } : {}), ...(reading.kind === 'extra' ? { extra: true } : {}),
        windows: reading.windows ?? [], ...(reading.credits ? { credits: reading.credits } : {}) }
      if (account?.identity) {
        const { id: _id, ...shown } = account.identity
        if (Object.keys(shown).length) out.account = shown
      }
      return out
    })
  }
  /** Attach each API-key source's key hint (its last four characters), read through `keyHint` and cached a minute. */
  async withKeyHints(sources) {
    if (!this.keyHint) return sources
    await Promise.all(sources.map(async source => {
      if (source.icon !== 'api' && source.icon !== 'openrouter') return
      const route = this.connections.get(source.connection)?.route
      if (!route) return
      let held = this.keyHints.get(route)
      if (!held || Date.now() - held.at > 60_000) {
        let hint
        try { hint = await this.keyHint(route) } catch { hint = undefined }
        held = { at: Date.now(), hint: typeof hint === 'string' && /^[\x21-\x7e]{4}$/.test(hint) ? hint : undefined }
        this.keyHints.set(route, held)
      }
      if (held.hint) source.keyHint = held.hint
    }))
    return sources
  }

  /**
   * The /billing report: the session's sources (local models with their tokens), then every other
   * provider route DSH serves, with nothing used (subscriptions still show their account's quota,
   * read now if never read). Local models the session never used are left out.
   */
  async report(sessionId, routeHint) {
    const snapshot = await this.snapshot(sessionId, routeHint)
    const used = new Set(snapshot.sources.map(s => s.connection))
    const others = []
    for (const info of this.providers?.() ?? []) {
      const id = connectionIdOf(info.id)
      if (used.has(id)) continue
      const connection = this.connection(id, info.id)
      // An unused local model has no account and nothing to show: not worth a card.
      if (connection.auth === 'local') continue
      const icon = connection.auth === 'subscription' ? 'subscription' : connection.provider === 'openrouter' ? 'openrouter' : 'api'
      if (icon === 'subscription' && !(connection.account && this.accounts.get(connection.account)?.latest) && !this.pending.get(id)) this.readPlan(info.id, id)
      const vendor = vendorOf(connection)
      others.push({ key: `${id}/${vendor.id}`, name: vendor.name, icon, connection: id, connectionLabel: connection.label, requests: 0, startedAt: '',
        cost: new Map(), equivalent: new Map(), counts: {} })
    }
    const pending = [...this.usageAttempts.values()].filter(a => a.state === 'pending').map(a => a.promise)
    if (pending.length) await Promise.race([Promise.allSettled(pending), new Promise(resolve => setTimeout(resolve, this.firstLoadWaitMs).unref?.())])
    const now = this.now()
    const rest = await this.withKeyHints(this.describeSources(others, undefined, now))
    return { v: 1, sessionId, now, persistence: snapshot.persistence, sources: [...snapshot.sources, ...rest] }
  }

  /** Derived per-session summary on disk for people and tools; rewritten when the session changed. */
  summarize(state, snapshot) {
    if (state.summarized === state.revision || !state.requests.size) return
    state.summarized = state.revision
    const { latest: _latest, now: _now, refreshing: _refreshing, staleAfterMs: _stale, ...summary } = snapshot
    this.track(writeJSON(this.dir('sessions', `${fileName(state.id)}.json`), { ...summary, version: STORE_VERSION, computedAt: snapshot.now,
      backfill: state.backfill ?? null }))
  }

  close() {
    if (this.closePromise) return this.closePromise
    this.closed = true
    this.closePromise = (async () => {
      await this.ready
      await Promise.allSettled([...this.sessions.values()].map(state => state.chain))
      await Promise.allSettled([...this.backfillWork.values()])
      await Promise.allSettled([...this.usageAttempts.values()].map(attempt => attempt.promise))
      while (this.writes.size) await Promise.allSettled([...this.writes])
    })()
    return this.closePromise
  }
}

/** Display names of model vendors; ids as pi-ai catalogs and OpenRouter model prefixes spell them. */
const VENDORS = { openrouter: 'OpenRouter', anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google', deepseek: 'DeepSeek', xai: 'xAI', 'x-ai': 'xAI', mistral: 'Mistral', mistralai: 'Mistral',
  meta: 'Meta', 'meta-llama': 'Meta', qwen: 'Qwen', moonshotai: 'Moonshot', zai: 'Z.ai', 'z-ai': 'Z.ai', minimax: 'MiniMax', groq: 'Groq', cerebras: 'Cerebras',
  nvidia: 'NVIDIA', 'github-copilot': 'GitHub Copilot', 'amazon-bedrock': 'Amazon Bedrock', huggingface: 'Hugging Face', fireworks: 'Fireworks', together: 'Together',
  cohere: 'Cohere', perplexity: 'Perplexity', microsoft: 'Microsoft', amazon: 'Amazon', baidu: 'Baidu', 'kimi-coding': 'Moonshot', xiaomi: 'Xiaomi' }
/**
 * The vendor whose model a request used: the model's own prefix behind a router (OpenRouter's
 * `~anthropic/claude-opus-latest` → anthropic), else the connection's catalog provider with its
 * plan or region suffix dropped (`openai-codex` → openai, `deepseek-official` → deepseek).
 */
export function vendorOf(connection, model) {
  if (connection.provider === 'openrouter' && typeof model === 'string' && model.includes('/')) {
    const prefix = model.replace(/^~/, '').split('/')[0].toLowerCase()
    return { id: prefix, name: VENDORS[prefix] ?? titleCase(prefix) }
  }
  const raw = String(connection.provider ?? connection.route ?? '').toLowerCase()
  const id = VENDORS[raw] ? raw : raw.replace(/-(?:oauth|official|codex|coding|cn|token-plan.*)$/, '')
  // An unknown vendor (a custom gateway, a local server) goes by its connection's display name.
  return { id, name: VENDORS[id] ?? connection.label ?? titleCase(id) }
}
const titleCase = id => id.split(/[-_]/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ') || id

/** What makes two quota readings different for the history: kind and each window's percent (0.1) and reset. */
function signature(reading) {
  return JSON.stringify([reading.kind, (reading.windows ?? []).map(w => [w.label, Math.round(w.usedPercent * 10) / 10, w.resetAt ?? null]), reading.extraUsageEnabled ?? null])
}
