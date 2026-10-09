import { TOKEN_CURRENCY } from './report.mjs'

// Decimal currency arithmetic. Rates and receipts are decimal strings; never sum floats.
const SCALE = 10n ** 24n
export function units(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,11})(?:\.\d{1,24})?$/.test(value)) return undefined
  const [whole, fraction = ''] = value.split('.')
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(24, '0'))
}
export function decimal(value) {
  const whole = value / SCALE
  const fraction = (value % SCALE).toString().padStart(24, '0').replace(/0+$/, '')
  return `${whole}${fraction ? `.${fraction}` : ''}`
}
export function addAmounts(values) {
  let total = 0n
  for (const value of values) {
    const amount = units(value)
    if (amount === undefined) throw new TypeError('Invalid decimal amount')
    total += amount
  }
  return decimal(total)
}
/**
 * Rate factor at a request's time: `timeOfDay` cards hold peak rates and name the peak hours (UTC,
 * [start, end) whole hours) and weekdays (0 = Sunday); outside them `offPeakFactor` applies.
 */
export function timeFactor(card, at) {
  const rule = card.timeOfDay
  if (!rule) return undefined
  const time = new Date(at)
  if (!Number.isFinite(time.getTime())) return undefined
  const peak = rule.peakDays.includes(time.getUTCDay()) && rule.peakHoursUtc.some(([start, end]) => time.getUTCHours() >= start && time.getUTCHours() < end)
  return peak ? undefined : rule.offPeakFactor
}
export function priceUsage(usage, card, at) {
  if (!usage || !card || card.inputMode !== 'exclusive') return undefined
  // A time-dependent card cannot price a request whose time is unknown.
  if (card.timeOfDay && !Number.isFinite(new Date(at).getTime())) return undefined
  const input = usage.inputTokens
  const output = usage.outputTokens
  const read = usage.cacheReadTokens ?? 0
  const write = usage.cacheWriteTokens ?? 0
  if (![input, output, read, write].every(n => Number.isSafeInteger(n) && n >= 0)) return undefined
  const uncached = card.inputMode === 'inclusive' ? input - read - write : input
  const totalInput = card.inputMode === 'inclusive' ? input : input + read + write
  if (uncached < 0 || !Number.isSafeInteger(totalInput) || (card.maxInputTokens !== undefined && totalInput > card.maxInputTokens)) return undefined
  // Input-size tiers (e.g. long-context pricing): the highest exceeded threshold replaces the base rates.
  let rates = card
  for (const tier of card.tiers ?? []) if (totalInput > tier.inputTokensAbove && tier.inputTokensAbove >= (rates.inputTokensAbove ?? -1)) rates = tier
  const pairs = [[uncached, rates.inputPerMillion], [output, rates.outputPerMillion], [read, rates.cacheReadPerMillion], [write, rates.cacheWritePerMillion]]
  let total = 0n
  for (const [count, rate] of pairs) {
    if (count === 0) continue
    const perMillion = units(rate)
    if (perMillion === undefined) return undefined // Missing cache rate isn't zero.
    total += perMillion * BigInt(count) / 1_000_000n
  }
  const factor = timeFactor(card, at)
  if (factor !== undefined) total = total * units(factor) / SCALE
  // Reasoning is already included in output. Hosted tools/modalities aren't priced here.
  return { kind: 'estimated', amount: decimal(total), currency: card.currency, scope: 'model-tokens', pricingVersion: card.version, ...(factor !== undefined ? { offPeak: true } : {}) }
}
/**
 * Local models are billed in tokens: the currency `TOK`, shown as T, one per token the model
 * processed (uncached input, cache writes and output; reasoning is part of output). Cache reads
 * cost nothing. The counts are the model server's own, so the amount is exact, not an estimate.
 */
export function localTokenCost(usage) {
  if (!usage) return undefined
  const counts = [usage.inputTokens, usage.outputTokens, usage.cacheWriteTokens ?? 0]
  if (!counts.every(n => Number.isSafeInteger(n) && n >= 0)) return undefined
  const tokens = counts.reduce((sum, n) => sum + BigInt(n), 0n)
  return { kind: 'reported', amount: decimal(tokens * SCALE), currency: TOKEN_CURRENCY, scope: 'local-tokens' }
}
export function validateRateCards(cards = []) {
  if (!Array.isArray(cards) || cards.length > 256) throw new TypeError('rateCards must be an array of at most 256 entries')
  const seen = new Set()
  return cards.map(card => {
    const allowed = ['provider','model','currency','version','source','inputMode','inputPerMillion','outputPerMillion','cacheReadPerMillion','cacheWritePerMillion','maxInputTokens','timeOfDay']
    if (!card || typeof card !== 'object' || Object.keys(card).some(key => !allowed.includes(key))) throw new TypeError('Invalid rate card fields')
    for (const key of ['provider','model','version']) {
      if (typeof card[key] !== 'string' || !/^[a-zA-Z0-9_.:/~-]{1,160}$/.test(card[key])) throw new TypeError(`Invalid rate card ${key}`)
    }
    if (card.provider.endsWith('-oauth') || card.provider === 'openai-codex') throw new TypeError('OAuth subscriptions cannot use API token rate cards')
    if (!/^[A-Z]{3}$/.test(card.currency ?? '')) throw new TypeError('Rate card needs an ISO currency')
    if (card.inputMode !== 'exclusive') throw new TypeError('DSH usage is disjoint: inputMode must be exclusive')
    if (typeof card.source !== 'string' || card.source.length > 512) throw new TypeError('Rate card must cite its HTTPS pricing source')
    const source = new URL(card.source)
    if (source.protocol !== 'https:' || source.username || source.password || source.search) throw new TypeError('Pricing source must be public HTTPS without credentials or query parameters')
    for (const key of ['inputPerMillion','outputPerMillion','cacheReadPerMillion','cacheWritePerMillion']) {
      if (card[key] === undefined && key.startsWith('cache')) continue
      if (units(card[key]) === undefined || (card[key].split('.')[1]?.length ?? 0) > 18) throw new TypeError(`Invalid decimal rate ${key}`)
    }
    if (card.maxInputTokens !== undefined && (!Number.isSafeInteger(card.maxInputTokens) || card.maxInputTokens < 1)) throw new TypeError('Invalid pricing context limit')
    if (card.timeOfDay !== undefined) {
      const rule = card.timeOfDay
      const hours = Array.isArray(rule?.peakHoursUtc) && rule.peakHoursUtc.length > 0 && rule.peakHoursUtc.every(span => Array.isArray(span) && span.length === 2
        && span.every(hour => Number.isSafeInteger(hour) && hour >= 0 && hour <= 24) && span[0] < span[1])
      const days = Array.isArray(rule?.peakDays) && rule.peakDays.every(day => Number.isSafeInteger(day) && day >= 0 && day <= 6)
      if (!hours || !days || units(rule.offPeakFactor) === undefined || Object.keys(rule).some(key => !['peakHoursUtc', 'peakDays', 'offPeakFactor'].includes(key))) throw new TypeError('Invalid rate card timeOfDay')
    }
    const identity = `${card.provider}/${card.model}`
    if (seen.has(identity)) throw new TypeError('Duplicate model rate card')
    seen.add(identity)
    return Object.freeze({ ...card })
  })
}
/** Rate card from DSH's resolved-model `pricing` (catalog list prices). Not persisted; its version is. */
export function catalogCard(provider, model, pricing) {
  if (!pricing || !/^[A-Z]{3}$/.test(pricing.currency ?? '') || typeof pricing.source !== 'string') return undefined
  const rate = value => value === undefined || units(value) !== undefined
  const rates = r => rate(r.inputPerMillion) && rate(r.outputPerMillion) && r.inputPerMillion !== undefined && r.outputPerMillion !== undefined && rate(r.cacheReadPerMillion) && rate(r.cacheWritePerMillion)
  if (!rates(pricing) || !(pricing.tiers ?? []).every(t => rates(t) && Number.isSafeInteger(t.inputTokensAbove) && t.inputTokensAbove >= 0)) return undefined
  const pick = r => ({ inputPerMillion: r.inputPerMillion, outputPerMillion: r.outputPerMillion,
    ...(r.cacheReadPerMillion !== undefined ? { cacheReadPerMillion: r.cacheReadPerMillion } : {}),
    ...(r.cacheWritePerMillion !== undefined ? { cacheWritePerMillion: r.cacheWritePerMillion } : {}) })
  return Object.freeze({ provider, model, currency: pricing.currency, inputMode: 'exclusive',
    version: pricing.source.replace(/[^a-zA-Z0-9_.:/-]+/g, '-').slice(0, 160), source: pricing.source, ...pick(pricing),
    ...(pricing.tiers?.length ? { tiers: pricing.tiers.map(t => ({ ...pick(t), inputTokensAbove: t.inputTokensAbove })) } : {}) })
}
