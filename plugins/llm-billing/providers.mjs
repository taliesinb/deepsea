/** Pure, allowlisted provider telemetry. No credentials, prompts, or raw bodies leave here. */
export function tokenUsage(value) {
  if (!value || typeof value !== 'object') return undefined
  const result = {}
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    const count = descriptor && 'value' in descriptor ? descriptor.value : undefined
    if (Number.isSafeInteger(count) && count >= 0) result[key] = count
  }
  return Object.keys(result).length ? result : undefined
}

/** Expand decimal/exponent notation using string operations, never monetary arithmetic. */
export function decimalAmount(value) {
  if (typeof value === 'number') value = String(value)
  if (typeof value !== 'string' || value.length > 96) return undefined
  const match = /^(0|[1-9]\d{0,23})(?:\.(\d{1,24}))?(?:[eE]([+-]?\d{1,2}))?$/.exec(value)
  if (!match) return undefined
  const digits = match[1] + (match[2] ?? '')
  const point = match[1].length + Number(match[3] ?? 0)
  if (point < -24 || point > 24) return undefined
  const whole = (point <= 0 ? '0' : digits.slice(0, point).padEnd(point, '0')).replace(/^0+(?=\d)/, '')
  const fraction = (point <= 0 ? '0'.repeat(-point) + digits : digits.slice(point)).replace(/0+$/, '')
  if (whole.length > 12 || fraction.length > 18) return undefined
  return whole + (fraction ? `.${fraction}` : '')
}

// JSON.parse source context (Node >=22) keeps the exact original monetary lexeme.
// Numeric usage counters remain numbers. No parsed body is retained by the collector.
export function parseTelemetryJSON(text) {
  return JSON.parse(text, (key, value, context) =>
    ['cost', 'upstream_inference_cost'].includes(key) && typeof value === 'number'
      ? (context?.source ?? String(value)) : value)
}
const number = (text, max = Number.MAX_SAFE_INTEGER) => {
  if (typeof text !== 'string' || text.length > 24 || !/^\d+(?:\.\d+)?$/.test(text)) return undefined
  const value = Number(text)
  return Number.isFinite(value) && value <= max ? value : undefined
}
const reset = text => {
  const seconds = number(text, 8_640_000_000_000)
  return seconds === undefined ? undefined : new Date(seconds * 1000).toISOString()
}
const withReset = (window, text) => {
  const at = reset(text)
  return at ? { ...window, resetAt: at } : window
}

/** Header evidence is routing evidence, not a receipt. Based on the standalone audit's classifier. */
export function anthropicEvidence(status, headers) {
  const get = field => headers.get(`anthropic-ratelimit-unified-${field}`)
  const claim = ['five_hour', 'seven_day', 'overage'].includes(get('representative-claim')) ? get('representative-claim') : undefined
  const allowed = ['allowed', 'allowed_warning'].includes(get('status'))
  const accepted = status >= 200 && status < 300
  const outcome = !accepted ? 'rejected' : claim === 'overage' ? 'extra-usage'
    : allowed && ['five_hour', 'seven_day'].includes(claim) ? 'plan-evidence' : 'unknown'
  const windows = []
  for (const label of ['5h', '7d']) {
    const fraction = number(get(`${label}-utilization`), 1)
    if (fraction !== undefined) windows.push(withReset({ label, usedPercent: fraction * 100 }, get(`${label}-reset`)))
  }
  const result = { kind: 'anthropic-oauth', outcome, status, authKind: 'oauth', scope: 'account', windows }
  if (claim) result.claim = claim
  const overage = number(get('overage-utilization'))
  if (overage !== undefined) result.overageUtilization = overage
  return result
}

/** Codex HTTP headers only; WS events are explicitly outside this collector's coverage.
 * Header vocabulary: openai/codex codex-rs/codex-api/src/rate_limits.rs.
 */
export function codexEvidence(status, headers) {
  const windows = []
  for (const label of ['primary', 'secondary']) {
    const prefix = `x-codex-${label}`
    const usedPercent = number(headers.get(`${prefix}-used-percent`), 100)
    if (usedPercent === undefined) continue
    const window = { label, usedPercent }
    const minutes = number(headers.get(`${prefix}-window-minutes`), 5256000)
    if (minutes !== undefined) window.windowMinutes = minutes
    windows.push(withReset(window, headers.get(`${prefix}-reset-at`)))
  }
  const boolean = value => ['true', '1'].includes(value?.toLowerCase()) ? true
    : ['false', '0'].includes(value?.toLowerCase()) ? false : undefined
  const hasCredits = boolean(headers.get('x-codex-credits-has-credits'))
  const unlimited = boolean(headers.get('x-codex-credits-unlimited'))
  const credits = hasCredits !== undefined && unlimited !== undefined ? { hasCredits, unlimited } : undefined
  const balance = decimalAmount(headers.get('x-codex-credits-balance'))
  if (credits && balance !== undefined) credits.balance = balance
  return { kind: 'openai-codex', outcome: status < 200 || status >= 300 ? 'rejected' : windows.length || credits ? 'quota-observed' : 'unknown',
    status, authKind: 'oauth', scope: 'account', transport: 'http', websocket: 'unobserved', windows,
    ...(credits ? { credits } : {}) }
}

/** Extract only native OpenRouter accounting fields, never SDK catalog estimates. */
export function openRouterEvidence(payload) {
  if (!payload || typeof payload !== 'object' || payload.error || !payload.usage) return undefined
  const amount = decimalAmount(payload.usage.cost)
  if (amount === undefined) return undefined
  const result = { kind: 'openrouter', outcome: 'reported',
    reportedCost: { amount, currency: 'USD', scope: 'openrouter-account' } }
  if (typeof payload.id === 'string' && /^gen-[A-Za-z0-9_-]{1,160}$/.test(payload.id)) result.responseId = payload.id
  if (typeof payload.model === 'string' && /^[A-Za-z0-9_.:/-]{1,160}$/.test(payload.model)) result.servedModel = payload.model
  if (typeof payload.usage.is_byok === 'boolean') result.byok = payload.usage.is_byok
  else if (typeof payload.is_byok === 'boolean') result.byok = payload.is_byok
  const upstream = decimalAmount(payload.usage.cost_details?.upstream_inference_cost)
  if (upstream !== undefined) result.upstreamCost = { amount: upstream, currency: 'USD', scope: 'upstream-inference' }
  return result
}

export function unobservedEvidence(provider) {
  return { kind: 'unobserved', outcome: 'unobserved',
    ...(provider === 'openai-codex' || provider === 'openai-codex-oauth'
      ? { transport: 'unobserved', websocket: 'unobserved', reason: 'http-not-observed' }
      : { reason: 'no-supported-http-evidence' }) }
}
