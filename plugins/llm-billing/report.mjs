// The /billing command's result: one readable line, then the JSON report the browser card renders.
// Shared by the host (encode) and the browser half (decode); no DSH imports.

export const REPORT_VERSION = 1

const SYMBOLS = { USD: '$', EUR: '€', GBP: '£' }

/** The token currency: local models are billed one T per token they processed. */
export const TOKEN_CURRENCY = 'TOK'
const TOKEN_UNITS = [[1e3, 'k'], [1e6, 'M'], [1e9, 'B']]
/**
 * A token count, compact: `20T`, `1kT`, `1.2kT`, `154kT`, `1MT`. Whole tokens below a
 * thousand, then at most one decimal (none from 100 up), never `.0`; a count that rounds up to the
 * next unit takes it (999,600 is `1MT`).
 */
export function tokenAmount(value) {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n < 1000) return `${n}T`
  for (const [step, unit] of TOKEN_UNITS) {
    const scaled = n / step
    const shown = Number(scaled.toFixed(scaled >= 100 ? 0 : 1))
    if (shown < 1000 || unit === 'B') return `${shown}${unit}T`
  }
  return '—'
}
/** A token count in full, for hover titles: `1,234T`. */
export function exactTokens(value) {
  const n = Math.round(Number(value))
  return Number.isFinite(n) && n >= 0 ? `${n.toLocaleString('en-US')}T` : '—'
}

/** Two decimals in ordinary form (`$4.20`, `<$0.01`), tokens compact (`1.2kT`); exact decimals stay in the JSON. */
function amount(value, currency) {
  if (currency === TOKEN_CURRENCY) return tokenAmount(value)
  const prefix = SYMBOLS[currency] ?? `${currency} `
  const [whole, fraction = ''] = String(value).split('.')
  let cents = BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2))
  if ((fraction[2] ?? '0') >= '5') cents += 1n
  if (cents === 0n && /[1-9]/.test(fraction)) return `<${prefix}0.01`
  return `${prefix}${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`
}
/** One figure per currency; an estimated part makes it `~`. */
const money = list => {
  const byCurrency = new Map()
  for (const m of list ?? []) {
    const held = byCurrency.get(m.currency) ?? { parts: [], estimated: false }
    held.parts.push(m.amount); held.estimated ||= m.kind === 'estimated'
    byCurrency.set(m.currency, held)
  }
  return [...byCurrency].map(([currency, { parts, estimated }]) => {
    const places = Math.max(0, ...parts.map(p => (p.split('.')[1] ?? '').length))
    const scale = 10n ** BigInt(places)
    const total = parts.reduce((sum, p) => { const [w, f = ''] = p.split('.'); return sum + BigInt(w) * scale + BigInt((f + '0'.repeat(places)).slice(0, places) || '0') }, 0n)
    const text = places ? `${total / scale}.${String(total % scale).padStart(places, '0')}` : String(total)
    return `${estimated ? '~' : ''}${amount(text, currency)}`
  }).join(' ')
}
/** One line per the session's sources: `Anthropic plan 7d 15% · OpenRouter $2.99 · LM Studio 9.7kT`. */
export function reportLine(report) {
  const used = report.sources.filter(s => s.requests > 0)
  const parts = used.map(s => s.icon === 'subscription'
    ? `${s.name} plan ${s.quota?.windows.map(w => `${w.label} ${Math.round(w.usedPercent)}%`).join(' ') || ''}`.trim()
    : `${s.name} ${money(s.cost) || (s.icon === 'local' ? 'local' : 'unpriced')}`)
  const idle = report.sources.length - used.length
  return [...(parts.length ? parts : ['No requests yet']), ...(idle ? [`${idle} other provider${idle === 1 ? '' : 's'}`] : [])].join(' · ')
}
export function encodeReport(report) {
  return `${reportLine(report)}\n${JSON.stringify(report)}`
}
/** The report in a command's text, or undefined for any other text (an error, an older result). */
export function decodeReport(text) {
  if (typeof text !== 'string') return undefined
  const newline = text.indexOf('\n')
  if (newline < 0) return undefined
  try {
    const value = JSON.parse(text.slice(newline + 1))
    return value !== null && typeof value === 'object' && value.v === REPORT_VERSION && Array.isArray(value.sources) ? value : undefined
  } catch { return undefined }
}
