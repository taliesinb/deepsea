// Passive fetch capture: observe provider HTTP traffic without changing it.
// Dependency-free; the versioned broker symbol still lets a second subscriber share one wrapper.
import { AsyncLocalStorage } from 'node:async_hooks'
import { types } from 'node:util'

const OWNER = Symbol.for('deepsea.passive-fetch-broker.v1')
function data(value) {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || types.isProxy(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return undefined
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !('value' in descriptors[key]))) return undefined
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]))
}
const native = (Class, key, object) => Object.getOwnPropertyDescriptor(Class.prototype, key).get.call(object)

/**
 * A provider URL as the provider would see it. Under provider simulation
 * (`DSH_PROVIDER_SIMULATOR`, a loopback URL) the harness sends provider
 * requests to `<simulator>/<provider host><path>`; this maps such a URL back
 * to `https://<provider host><path>`, and leaves any other URL alone.
 */
export function providerUrl(text, simulator = process.env.DSH_PROVIDER_SIMULATOR) {
  const base = simulator ? simulator.replace(/\/+$/, '') : ''
  if (!base || !text.startsWith(`${base}/`)) return new URL(text)
  const rest = text.slice(base.length + 1)
  return new URL(`https://${rest}`)
}

/** Read reusable dispatch metadata once, never prompts or one-shot header iterables. */
export function requestKind(input, init) {
  if (types.isProxy(input)) return undefined
  const options = data(init)
  if (!options) return undefined
  const request = input instanceof Request ? input : undefined
  const urlText = request ? native(Request, 'url', request) : typeof input === 'string' ? input
    : input instanceof URL ? native(URL, 'href', input) : undefined
  if (!urlText) return undefined
  const url = providerUrl(urlText)
  const method = options.method ?? (request ? native(Request, 'method', request) : 'GET')
  if (typeof method !== 'string' || method.toUpperCase() !== 'POST' || url.username || url.password) return undefined
  let kind
  if (url.origin === 'https://api.anthropic.com' && url.pathname === '/v1/messages') kind = 'anthropic'
  else if (url.origin === 'https://openrouter.ai' && url.pathname === '/api/v1/chat/completions') kind = 'openrouter'
  else if (url.origin === 'https://chatgpt.com' && url.pathname === '/backend-api/codex/responses') kind = 'openai-codex'
  if (!kind) return undefined
  const raw = options.headers ?? (request ? native(Request, 'headers', request) : undefined)
  if (types.isProxy(raw)) return undefined
  let headers
  if (raw instanceof Headers) {
    if (Object.getPrototypeOf(raw) !== Headers.prototype || [Symbol.iterator, 'get', 'has', 'entries', 'forEach', 'keys', 'values'].some(key => Object.hasOwn(raw, key))) return undefined
    headers = raw
  } else {
    const entries = data(raw)
    if (!entries || Object.values(entries).some(value => typeof value !== 'string')) return undefined
    headers = new Headers(entries)
  }
  const bearer = Headers.prototype.get.call(headers, 'authorization') ?? ''
  if (kind === 'anthropic') {
    if (/^Bearer sk-ant-oat[^\s]*$/i.test(bearer) && !Headers.prototype.has.call(headers, 'x-api-key')) kind = 'anthropic-oauth'
    else return undefined
  }
  if (kind === 'openai-codex' && !/^Bearer \S+$/i.test(bearer)) return undefined
  return Object.freeze({ kind, origin: url.origin, pathname: url.pathname })
}
function responseMeta(response, endpoint) {
  if (types.isProxy(response) || Object.getPrototypeOf(response) !== Response.prototype
    || ['url', 'redirected', 'status', 'headers', 'body'].some(key => Object.hasOwn(response, key))) return undefined
  const url = native(Response, 'url', response)
  // The response comes from the simulator under provider simulation: compare it as the provider's.
  const destination = url ? providerUrl(url) : undefined
  if (native(Response, 'redirected', response) || destination
    && (destination.origin !== endpoint.origin || destination.pathname !== endpoint.pathname)) return undefined
  const headers = native(Response, 'headers', response)
  // Both observers consume the same captured metadata without evaluating user overrides.
  return Object.freeze({ status: native(Response, 'status', response),
    headers: Object.freeze({ get: name => Headers.prototype.get.call(headers, name) }) })
}
const eligible = observer => {
  try { return observer.subscription.active && observer.state?.active() === true } catch { return false }
}
function deliver(observer, method, ...args) {
  if (!eligible(observer)) return
  try {
    const result = observer.state[method]?.(...args)
    if (result?.then) Promise.resolve(result).catch(() => {})
  } catch { /* Observers never alter native inference. */ }
}

/** One wrapper per target/process across independent self-contained package copies.
 * Each acquisition owns a separate ALS scope. run(undefined) clears only that
 * subscriber, so audit's nested unscoped calls cannot erase billing attribution.
 *
 * Scoped state: active(), beginHTTP(endpoint), headers(attempt, endpoint, metadata),
 * evidence(attempt, parsed), and optional bodyTap {key, apply(response,publish)}.
 * Equivalent bodyTap keys share one demand-driven parser and multicast its output.
 * The broker itself never reads a response body or evaluates billing policy.
 */
export function acquirePassiveFetch(target = globalThis) {
  let broker = target[OWNER]
  if (!broker) {
    const original = target.fetch
    broker = { active: true, subscriptions: new Set(), protocol: 1 }
    async function wrapped(input, init) {
      const observers = []
      if (broker.active) {
        for (const subscription of broker.subscriptions) {
          const observer = { subscription, state: subscription.scope.getStore() }
          if (eligible(observer)) observers.push(observer)
        }
      }
      if (!observers.length) return original.call(this, input, init)
      let endpoint
      try { endpoint = requestKind(input, init) } catch { /* Native fetch owns unsupported inputs. */ }
      if (endpoint) for (const observer of observers) {
        try { observer.attempt = observer.state.beginHTTP(endpoint) } catch { /* One bad observer cannot suppress another. */ }
      }
      // Preserve the exact invocation and the native exception, redirect and abort behavior.
      const response = await original.call(this, input, init)
      if (!endpoint || !broker.active) return response
      let meta
      try { meta = responseMeta(response, endpoint) } catch { /* Unsupported native metadata. */ }
      if (!meta) return response
      const interested = observers.filter(observer => observer.attempt !== undefined && eligible(observer))
      for (const observer of interested) deliver(observer, 'headers', observer.attempt, endpoint, meta)
      if (endpoint.kind !== 'openrouter' || meta.status < 200 || meta.status >= 300) return response
      // At most one parser attaches. Audit's header-only observer has no bodyTap.
      const parsers = []
      for (const observer of interested) {
        try {
          const tap = observer.state.bodyTap
          if (typeof tap?.key === 'string' && typeof tap?.apply === 'function') parsers.push({ observer, tap })
        } catch { /* Bad extension metadata must not affect another subscriber. */ }
      }
      const parser = parsers[0]
      if (parser) {
        try {
          return parser.tap.apply(response, evidence => {
            for (const { observer, tap } of parsers) if (tap.key === parser.tap.key) {
              // Parsers publish bounded data, not capabilities. Isolate subscriber mutation.
              try { deliver(observer, 'evidence', observer.attempt, structuredClone(evidence)) } catch { /* Invalid parser output. */ }
            }
          })
        } catch { /* Keep the original response if parser setup fails. */ }
      }
      return response
    }
    broker.wrapped = wrapped
    broker.original = original
    target[OWNER] = broker
    target.fetch = wrapped
  } else if (broker.protocol !== 1 || !(broker.subscriptions instanceof Set)) {
    throw new Error('Incompatible passive fetch broker protocol')
  }
  const subscription = { active: true, scope: new AsyncLocalStorage() }
  broker.subscriptions.add(subscription)
  return {
    run: (state, callback) => subscription.active ? subscription.scope.run(state, callback) : callback(),
    release() {
      if (!subscription.active) return
      subscription.active = false
      subscription.scope.disable()
      broker.subscriptions.delete(subscription)
      if (broker.subscriptions.size) return
      broker.active = false
      if (target.fetch === broker.wrapped) target.fetch = broker.original
      if (target[OWNER] === broker) delete target[OWNER]
      // If an unrelated later wrapper retains ours, it stays an inert passthrough.
    },
  }
}
