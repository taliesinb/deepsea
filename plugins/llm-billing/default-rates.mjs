/**
 * Built-in price lists for routes whose adapter publishes no prices. A configured `rateCards` entry
 * for the same route and model replaces the built-in one. Keep `version` in step with the source page.
 *
 * DeepSeek (DSH's built-in `llm-deepseek` adapter; routes `deepseek-official`, keyed by an API key, and
 * `deepseek-account`, the signed-in DeepSeek Platform account since DSH 0.2 — both billed per token), from
 * https://api-docs.deepseek.com/quick_start/pricing/ as read on 2026-10-05: per 1M tokens, peak rates
 * below; off-peak is half. Peak is 01:00–04:00 and 06:00–10:00 UTC, Monday to Friday; Chinese public
 * holidays are off-peak but not modelled here, so a holiday request is estimated at the peak rate.
 * DeepSeek's cache is automatic: a cache read is a "cache hit", any other input is a "cache miss"
 * (DSH reports no cache writes for it; if it did, they would be billed as misses).
 * `deepseek-v4-flash` is a retired name still accepted and billed at the Flash price.
 */
const DEEPSEEK_SOURCE = 'https://api-docs.deepseek.com/quick_start/pricing/'
const DEEPSEEK_TIME = { peakHoursUtc: [[1, 4], [6, 10]], peakDays: [1, 2, 3, 4, 5], offPeakFactor: '0.5' }
const deepseek = (provider, model, input, cacheHit, output) => ({
  provider, model, currency: 'USD', version: 'deepseek-2026-10-05', source: DEEPSEEK_SOURCE, inputMode: 'exclusive',
  inputPerMillion: input, outputPerMillion: output, cacheReadPerMillion: cacheHit, cacheWritePerMillion: input, timeOfDay: DEEPSEEK_TIME,
})

export const DEFAULT_RATE_CARDS = ['deepseek-official', 'deepseek-account'].flatMap(route => [
  deepseek(route, 'deepseek-flash', '0.3', '0.006', '1.2'),
  deepseek(route, 'deepseek-v4-flash', '0.3', '0.006', '1.2'),
  deepseek(route, 'deepseek-v4-pro', '1.32', '0.044', '3.96'),
])

/** Configured cards first; a built-in card only where no configured card names the same route and model. */
export function withDefaultRates(configured) {
  const named = new Set(configured.map(card => `${card.provider}/${card.model}`))
  return [...configured, ...DEFAULT_RATE_CARDS.filter(card => !named.has(`${card.provider}/${card.model}`))]
}
