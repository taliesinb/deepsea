import test from 'node:test'
import assert from 'node:assert/strict'
import { addAmounts, catalogCard, localTokenCost, priceUsage, validateRateCards } from '../money.mjs'

const card = { provider: 'openai', model: 'fixture-model', currency: 'USD', version: 'fixture-v1', source: 'https://example.com/prices', inputMode: 'exclusive', inputPerMillion: '2', outputPerMillion: '8', cacheReadPerMillion: '0.2', cacheWritePerMillion: '3' }
test('money is exact and cache categories/reasoning are not double-counted', () => {
  assert.equal(addAmounts(['0.1','0.2']), '0.3')
  const usage = { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 2000, reasoningTokens: 80 }
  assert.equal(priceUsage(usage, card).amount, '0.0032')
  assert.equal(priceUsage({ ...usage, inputTokens: 3000 }, { ...card, inputMode: 'inclusive' }), undefined)
  assert.throws(() => validateRateCards([{ ...card, inputMode: 'inclusive' }]))
  assert.equal(priceUsage(usage, { ...card, cacheReadPerMillion: undefined }), undefined)
  assert.equal(priceUsage(usage, { ...card, maxInputTokens: 2000 }), undefined)
  assert.equal(priceUsage({ ...usage, inputTokens: -1 }, card), undefined)
  assert.equal(priceUsage({ inputTokens: 1, outputTokens: 0 }, { ...card, inputPerMillion: '0.000000000000000001' }).amount, '0.000000000000000000000001')
  assert.throws(() => validateRateCards([{ ...card, provider: 'anthropic-oauth' }]))
  assert.throws(() => validateRateCards([{ ...card, inputPerMillion: 2 }]))
})
const catalogPricing = { currency: 'USD', inputPerMillion: '4', outputPerMillion: '20', cacheReadPerMillion: '0.2', cacheWritePerMillion: '5', source: 'pi-ai catalog 2026-09-22' }
test('DSH catalog pricing: tiers select by total input, malformed pricing is rejected', () => {
  const tiered = catalogCard('anthropic', 'm', { ...catalogPricing, tiers: [{ inputTokensAbove: 200000, inputPerMillion: '8', outputPerMillion: '40', cacheReadPerMillion: '0.4', cacheWritePerMillion: '10' }] })
  assert.equal(tiered.version, 'pi-ai-catalog-2026-09-22')
  assert.equal(priceUsage({ inputTokens: 1000, outputTokens: 0 }, tiered).amount, '0.004')
  assert.equal(priceUsage({ inputTokens: 1000, outputTokens: 0, cacheReadTokens: 200000 }, tiered).amount, '0.088')
  for (const bad of [undefined, { ...catalogPricing, currency: 'usd' }, { ...catalogPricing, inputPerMillion: 4 }, { ...catalogPricing, source: 1 }, { ...catalogPricing, tiers: [{ inputTokensAbove: -1, inputPerMillion: '1', outputPerMillion: '1' }] }]) assert.equal(catalogCard('anthropic', 'm', bad), undefined)
})

test('time-of-day cards: peak rates in peak UTC hours on peak days, the off-peak factor otherwise', async () => {
  const { DEFAULT_RATE_CARDS, withDefaultRates } = await import('../default-rates.mjs')
  const [flash] = validateRateCards(DEFAULT_RATE_CARDS)
  // A real recorded DeepSeek request: 239 uncached input, 3 output, 10496 cache hits.
  const usage = { inputTokens: 239, outputTokens: 3, cacheReadTokens: 10496, cacheWriteTokens: 0 }
  assert.equal(priceUsage(usage, flash, '2026-10-05T03:48:08Z').amount, '0.000138276', 'Monday 03:48 UTC is peak')
  assert.equal(priceUsage(usage, flash, '2026-10-05T05:00:00Z').amount, '0.000069138', 'Monday 05:00 UTC is off-peak')
  assert.equal(priceUsage(usage, flash, '2026-10-04T03:48:08Z').amount, '0.000069138', 'Sunday is off-peak')
  assert.equal(priceUsage(usage, flash, '2026-10-05T10:00:00Z').offPeak, true, 'the end hour is exclusive')
  assert.equal(priceUsage(usage, flash), undefined, 'no request time, no price')
  for (const timeOfDay of [{ peakHoursUtc: [[4, 1]], peakDays: [1], offPeakFactor: '0.5' }, { peakHoursUtc: [[1, 4]], peakDays: [7], offPeakFactor: '0.5' }, { peakHoursUtc: [[1, 4]], peakDays: [1], offPeakFactor: 'half' }, { peakHoursUtc: [], peakDays: [1], offPeakFactor: '0.5' }]) {
    assert.throws(() => validateRateCards([{ ...card, timeOfDay }]))
  }
  const merged = withDefaultRates(validateRateCards([{ ...card, provider: 'deepseek-official', model: 'deepseek-flash' }]))
  const official = merged.filter(c => c.provider === 'deepseek-official' && c.model === 'deepseek-flash')
  assert.equal(official.length, 1, 'a configured card replaces the built-in one')
  assert.equal(official[0].version, 'fixture-v1')
  assert.equal(merged.find(c => c.provider === 'deepseek-account' && c.model === 'deepseek-flash').version, 'deepseek-2026-10-05', 'the account route keeps its built-in card')
  assert.ok(merged.some(c => c.model === 'deepseek-v4-pro'))
})

test('local models: one T per processed token (uncached input, cache writes, output); cache reads free', () => {
  assert.deepEqual(localTokenCost({ inputTokens: 5000, outputTokens: 500, cacheReadTokens: 2000, cacheWriteTokens: 100, reasoningTokens: 300 }),
    { kind: 'reported', amount: '5600', currency: 'TOK', scope: 'local-tokens' })
  assert.equal(localTokenCost({ inputTokens: 0, outputTokens: 0 }).amount, '0')
  assert.equal(localTokenCost(undefined), undefined)
  assert.equal(localTokenCost({ inputTokens: -1, outputTokens: 2 }), undefined)
})
