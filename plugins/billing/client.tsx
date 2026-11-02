import { useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { CommandRowProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import { IconInfoOutlineRegular, IconWarningOutlineRegular, Tooltip, useAnchoredPosition, useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'
import styles from './client.css'
import { decodeReport, exactTokens, TOKEN_CURRENCY, tokenAmount } from './report.mjs'

type Window = { label: string; usedPercent: number; resetAt?: string | number; windowMinutes?: number }
type Money = { kind?: 'reported' | 'estimated'; currency: string; amount: string }

/** One source: a connection and the vendor of the models it served (OpenRouter's Anthropic models are "Anthropic"). */
export interface BillingSource {
  key: string
  /** Vendor display name, e.g. `Anthropic`, `DeepSeek`, `OpenAI`; a local server's connection name. */
  name: string
  /** How it is billed: a subscription sign-in, an OpenRouter account, another API key, or a local model (free). */
  icon: 'subscription' | 'openrouter' | 'api' | 'local'
  connection?: string
  /** The connection's display name (the route's), e.g. `OpenRouter`, `LM Studio`. */
  connectionLabel?: string
  requests: number
  /** Requested model of the source's latest request. */
  model?: string
  /** Time of the source's latest request. */
  lastAt?: string | number
  /** Money charged (reported) or estimated from token prices, per kind and currency. */
  cost?: Money[]
  /** Subscription usage priced at the provider's per-token API list prices (not charged). */
  equivalent?: { currency: string; amount: string }[]
  /** Subscription account reading. */
  quota?: { at: string | number; stale?: boolean; extra?: boolean; windows: Window[]; credits?: { hasCredits: boolean; unlimited: boolean; balance?: string } }
  account?: { email?: string; name?: string; organization?: string; plan?: string }
  /** Last four characters of the API key this source uses. */
  keyHint?: string
  /** This source's requests that failed (not billed), ended partway, or have no price. */
  counts?: { unpriced?: number; incomplete?: number; failed?: number }
}

export interface BillingSnapshot {
  version: 2
  sessionId: string
  /** Current source first: the connection and vendor of the session's latest request. */
  sources: BillingSource[]
  counts: { requests: number; pending: number }
  persistence: 'ok' | 'error'
  now?: string
  /** The host is still backfilling history or reading subscription usage; poll again soon. */
  refreshing?: boolean
}

const record = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
const text = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= 256
const decimal = (x: unknown): x is string => typeof x === 'string' && x.length <= 80 && /^\d+(?:\.\d+)?$/.test(x)
const count = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0
const timestamp = (x: unknown): x is string | number => (typeof x === 'string' || typeof x === 'number') && Number.isFinite(new Date(x).getTime())
const currency = (x: unknown) => typeof x === 'string' && /^[A-Z]{3}$/.test(x)
const moneyList = (x: unknown, kinds: boolean) => x === undefined || (Array.isArray(x) && x.length <= 16
  && x.every(m => record(m) && currency(m.currency) && decimal(m.amount) && (!kinds || ['reported', 'estimated'].includes(String(m.kind)))))
const window = (w: unknown) => record(w) && text(w.label) && typeof w.usedPercent === 'number' && Number.isFinite(w.usedPercent) && w.usedPercent >= 0 && w.usedPercent <= 100
  && (w.resetAt === undefined || timestamp(w.resetAt)) && (w.windowMinutes === undefined || count(w.windowMinutes))
function validSource(x: unknown): boolean {
  if (!record(x) || !text(x.key) || !text(x.name) || !['subscription', 'openrouter', 'api', 'local'].includes(String(x.icon)) || !count(x.requests)) return false
  if (x.keyHint !== undefined && (typeof x.keyHint !== 'string' || !/^[\x21-\x7e]{4}$/.test(x.keyHint))) return false
  if ([x.connection, x.connectionLabel, x.model].some(v => v !== undefined && !text(v)) || (x.lastAt !== undefined && !timestamp(x.lastAt))) return false
  if (!moneyList(x.cost, true) || !moneyList(x.equivalent, false)) return false
  if (x.counts !== undefined && (!record(x.counts) || !Object.values(x.counts).every(count))) return false
  if (x.account !== undefined && (!record(x.account) || !Object.values(x.account).every(text))) return false
  const q = x.quota
  if (q !== undefined && (!record(q) || !timestamp(q.at) || !Array.isArray(q.windows) || q.windows.length > 16 || !q.windows.every(window)
    || (q.credits !== undefined && (!record(q.credits) || typeof q.credits.hasCredits !== 'boolean' || typeof q.credits.unlimited !== 'boolean' || (q.credits.balance !== undefined && !decimal(q.credits.balance)))))) return false
  return true
}
/** Reject malformed or misaddressed data rather than showing another session's account. */
export function parseSnapshot(value: unknown, sessionId: string): BillingSnapshot | null {
  if (!record(value) || value.version !== 2 || value.sessionId !== sessionId) return null
  if (!Array.isArray(value.sources) || value.sources.length > 32 || !value.sources.every(validSource)) return null
  if (!record(value.counts) || !count(value.counts.requests) || !count(value.counts.pending)) return null
  if (!['ok', 'error'].includes(String(value.persistence)) || (value.now !== undefined && !timestamp(value.now))) return null
  return value as unknown as BillingSnapshot
}

const SYMBOLS: Record<string, string> = { USD: '$', EUR: '€', GBP: '£' }
const prefixOf = (code: string) => SYMBOLS[code] ?? `${code} `

/** Round a decimal string half-up to `places` digits, as an integer scaled by 10^places. */
function scaled(amount: string, places: number): bigint {
  const [whole, fraction = ''] = amount.split('.')
  let value = BigInt(whole!) * 10n ** BigInt(places) + BigInt((fraction + '0'.repeat(places)).slice(0, places) || '0')
  if ((fraction[places] ?? '0') >= '5') value += 1n
  return value
}
/**
 * Display amount in ordinary currency form: two decimals, a leading zero, thousands separators
 * ($0.04, $4.20, $1,024.10). A positive amount below half a cent reads `<$0.01`, never zero.
 * Tokens (local models) are a compact count: `1.2kT`. Display rounding only; the host remains
 * the sole accounting authority.
 */
export function formatAmount(amount: string, code: string): string {
  if (!decimal(amount) || !currency(code)) return '—'
  if (code === TOKEN_CURRENCY) return tokenAmount(amount)
  const prefix = prefixOf(code)
  const value = scaled(amount, 2)
  if (value === 0n && /[1-9]/.test(amount)) return `<${prefix}0.01`
  const whole = (value / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${prefix}${whole}.${(value % 100n).toString().padStart(2, '0')}`
}
/** Full-precision amount for hover titles. */
export function exactAmount(amount: string, code: string): string {
  if (!decimal(amount) || !currency(code)) return '—'
  if (code === TOKEN_CURRENCY) return exactTokens(amount)
  const [whole, fraction = ''] = amount.split('.')
  const trimmed = fraction.replace(/0+$/, '')
  return `${prefixOf(code)}${BigInt(whole!).toString()}${trimmed ? `.${trimmed}` : ''}`
}
/** Exact decimal sum of non-negative decimal strings (no float). */
export function sumAmounts(amounts: string[]): string {
  const places = Math.max(0, ...amounts.map(a => (a.split('.')[1] ?? '').length))
  const total = amounts.reduce((sum, a) => sum + scaled(a, places), 0n)
  if (places === 0) return total.toString()
  const unit = 10n ** BigInt(places)
  const fraction = (total % unit).toString().padStart(places, '0').replace(/0+$/, '')
  return `${total / unit}${fraction ? `.${fraction}` : ''}`
}
/**
 * One amount per currency: reported and estimated parts added; an estimate makes the sum an estimate
 * (`~`, dim) unless it adds less than 1% to the reported part.
 */
export function mergedMoney(parts: Money[]): { currency: string; amount: string; estimated: boolean }[] {
  const byCurrency = new Map<string, Money[]>()
  for (const part of parts) byCurrency.set(part.currency, [...(byCurrency.get(part.currency) ?? []), part])
  return [...byCurrency.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([code, list]) => {
    const guess = list.filter(m => m.kind === 'estimated'), known = list.filter(m => m.kind !== 'estimated')
    const estimated = guess.length > 0 && !(known.length > 0 && scaled(sumAmounts(guess.map(m => m.amount)), 9) * 100n < scaled(sumAmounts(known.map(m => m.amount)), 9))
    return { currency: code, amount: sumAmounts(list.map(m => m.amount)), estimated }
  })
}
const moneyText = (m: { currency: string; amount: string; estimated: boolean }) => `${m.estimated ? '~' : ''}${formatAmount(m.amount, m.currency)}`
function merged(parts: Money[]): ReactNode[] {
  return mergedMoney(parts).map(m => <span key={m.currency} className={m.estimated ? 'deepsea-billing-estimate' : undefined}
    title={`${m.estimated ? 'Partly estimated: ' : ''}${exactAmount(m.amount, m.currency)}`}>{moneyText(m)}</span>)
}
/** A subscription's API-price equivalent: struck through, since nothing was charged; never part of a total. */
const struck = (parts: { currency: string; amount: string }[]): ReactNode => parts.length
  ? parts.map(p => <span key={p.currency} className="deepsea-billing-struck" title={`At API prices, not charged: ${exactAmount(p.amount, p.currency)}`}>{formatAmount(p.amount, p.currency)}</span>)
  : <span className="deepsea-billing-muted">—</span>
/** Nothing spent yet. */
const FREE = formatAmount('0', 'USD')
/** A local model with no token counts yet (never unpriced). */
const NO_TOKENS = formatAmount('0', 'TOK')
/** What a source cost, as shown: struck API price (subscription), merged money (local models in tokens), or `$ —` when unpriced. */
const moneyOf = (source: BillingSource): ReactNode => source.icon === 'subscription' ? struck(source.equivalent?.length ? source.equivalent : source.requests === 0 ? [{ currency: 'USD', amount: '0' }] : [])
  : source.cost?.length ? merged(source.cost) : source.icon === 'local' ? NO_TOKENS : source.requests === 0 ? FREE : <span className="deepsea-billing-muted">$ —</span>

/** Provider plan ids as words: `claude_team` → `Team`, `plus` → `Plus`. */
export const planLabel = (plan: string) => plan.replace(/^claude_/, '').replace(/_/g, ' ').replace(/^./, c => c.toUpperCase())
const percent = (n: number) => `${Math.round(n * 10) / 10}%`
/** Largest unit, rounded: `58m`, `2h` (1h 58m), `6d` (5d 23h). */
export function compactDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.round(minutes / 1440)}d`
}
const shortTime = (at: string | number) => new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
/** Window duration label from the provider label or its duration (300 min → 5h, 10080 min → 7d). */
export function windowLabel(w: { label: string; windowMinutes?: number }): string | undefined {
  if (/^\d+[mhdw]$/i.test(w.label)) return w.label.toLowerCase()
  const minutes = w.windowMinutes
  if (!minutes) return undefined
  if (minutes % 1440 === 0) return `${minutes / 1440}d`
  if (minutes % 60 === 0) return `${minutes / 60}h`
  return `${minutes}m`
}
/** Time until a window resets, omitted when it would just repeat the window's own length (a fresh 5h window, 5h to go). */
const remaining = (w: Window, now: number) => { const left = compactDuration(new Date(w.resetAt!).getTime() - now); return left === windowLabel(w) ? undefined : left }
/** Model id without its route's vendor prefix or alias marker: `~anthropic/claude-opus-latest` → `claude-opus-latest`. */
export const modelName = (model: string) => model.replace(/^~/, '').split('/').pop() || model
/** Provider as shown: OpenRouter's vendors as `OpenRouter / Anthropic`, local servers by their connection. */
const providerLabel = (source: BillingSource) => source.icon === 'openrouter' && source.name !== (source.connectionLabel ?? 'OpenRouter') ? `${source.connectionLabel ?? 'OpenRouter'} / ${source.name}` : source.icon === 'local' ? source.connectionLabel ?? source.name : source.name
/** Card heading: what kind of billing the current source is. */
export const billingTitle = (source: BillingSource) => source.icon === 'subscription' ? `${source.name} plan`
  : source.icon === 'openrouter' ? `${source.connectionLabel ?? 'OpenRouter'} API billing` : source.icon === 'local' ? 'Local model' : `${source.name} API billing`
/** A source's gaps, each shown on its own line under its request count: `↑1 failed`. Local models are never unpriced. */
export const gaps = (source: BillingSource) => ([[source.counts?.failed, 'failed'], [source.counts?.incomplete, 'partial'], [source.icon === 'local' ? 0 : source.counts?.unpriced, 'unpriced']] as [number | undefined, string][])
  .filter(([n]) => (n ?? 0) > 0) as [number, string][]
const fullest = (windows: Window[]) => windows.reduce<Window | undefined>((a, w) => !a || w.usedPercent > a.usedPercent ? w : a, undefined)

/** Exact glyph from ui-model-selection/ModelSelect.tsx RouteIcon(oauth). */
export function OAuthShield() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 1.8 17 4.4v4.7c0 4.2-2.7 7.3-7 9.1-4.3-1.8-7-4.9-7-9.1V4.4l7-2.6Z" fill="none" stroke="currentColor" strokeWidth="1.55" /><circle cx="10" cy="7.2" r="2" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M6.8 13.5c.5-2.1 1.6-3.2 3.2-3.2s2.8 1.1 3.2 3.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
}
/** Exact glyph from ui-model-selection/ModelSelect.tsx RouteIcon(api): token-priced billing. */
export function ApiIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="1.8" y="3" width="16.4" height="14" rx="3" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="m7 7-3 3 3 3m6-6 3 3-3 3m-2.2-7.2-1.6 8.4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
}
/** Exact glyph from ui-model-selection/ModelSelect.tsx RouteIcon(openrouter). */
export function OpenRouterIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2 10h4M6 10c2.5 0 3-4 5.5-4H17M6 10c2.5 0 3 4 5.5 4H17M14.5 3.5 17 6l-2.5 2.5M14.5 11.5 17 14l-2.5 2.5" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" /></svg>
}
/** Laptop glyph for local model servers. */
export function LocalIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3.5" y="4" width="13" height="9" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M1.8 16h16.4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
}
/** Small capital sigma for the total row. */
export function SigmaIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M14.5 4h-9l5 6-5 6h9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
}
const SourceGlyph = ({ icon }: { icon: BillingSource['icon'] }) => icon === 'subscription' ? <OAuthShield /> : icon === 'openrouter' ? <OpenRouterIcon /> : icon === 'local' ? <LocalIcon /> : <ApiIcon />
/** Request-count arrow, set slightly apart from its number. */
const Up = () => <span className="deepsea-billing-up" aria-hidden="true">↑</span>

/** ContextMeter ring geometry: 14px viewBox, r 5.5, 2px stroke. */
const RADIUS = 5.5
const CIRCUMFERENCE = 2 * Math.PI * RADIUS
export function UsageRing({ usedPercent }: { usedPercent: number }) {
  return <svg className="deepsea-billing-ring" viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
    <circle className="deepsea-billing-ring-track" cx="7" cy="7" r={RADIUS} />
    <circle className="deepsea-billing-ring-fill" cx="7" cy="7" r={RADIUS} strokeDasharray={`${CIRCUMFERENCE * usedPercent / 100} ${CIRCUMFERENCE}`} transform="rotate(-90 7 7)" />
  </svg>
}

export interface BillingNote { key: string; level: 'info' | 'danger'; text: string }
/**
 * What the pill and card warn about: the current source's gaps (the card also shows them on its
 * Requests row), storage failure, or an unreachable endpoint. Earlier sources' gaps are history.
 */
export function billingNotes(snapshot: BillingSnapshot | undefined, failed: boolean): BillingNote[] {
  if (!snapshot) return failed ? [{ key: 'unavailable', level: 'danger', text: 'Billing unavailable' }] : []
  const notes: BillingNote[] = snapshot.sources[0] ? gaps(snapshot.sources[0]).map(([n, word]) => ({ key: word, level: 'info', text: `${plural(n, 'request')} ${word}` })) : []
  if (snapshot.persistence === 'error') notes.push({ key: 'persistence', level: 'danger', text: 'Not saved; totals may be partial' })
  return notes
}
/** Full accessible description of the pill: the current source's title and value, then the notes. */
export function pillSummary(snapshot: BillingSnapshot | undefined, failed: boolean): string {
  const current = snapshot?.sources[0]
  if (!current) return failed ? 'Billing unavailable' : 'No requests recorded yet'
  const parts = [billingTitle(current)]
  if (current.icon === 'subscription') {
    const top = current.quota && !current.quota.extra ? fullest(current.quota.windows) : undefined
    parts.push(current.quota?.extra ? 'Extra usage' : top ? `${windowLabel(top) ?? 'Quota'} ${percent(top.usedPercent)} used` : 'Usage unknown')
    if (current.quota?.stale) parts.push('stale')
  } else parts.push(current.cost?.length ? mergedMoney(current.cost).map(moneyText).join(' ') : current.icon === 'local' ? NO_TOKENS : 'Cost unknown')
  if (snapshot!.counts.pending > 0) parts.push(`${plural(snapshot!.counts.pending, 'request')} in flight`)
  return [...parts, ...billingNotes(snapshot, failed).map(n => n.text)].join(' · ')
}

/**
 * The pill shows the current source only. Subscription: its glyph, then the fuller window's label,
 * ContextMeter's ring and percent. Other sources: glyph and money (estimates dim).
 */
export function CurrentPill({ source }: { source?: BillingSource }) {
  if (!source) return <span className="deepsea-billing-group" data-deepsea-billing-group="money"><span className="deepsea-billing-amount deepsea-billing-unknown">$ —</span></span>
  if (source.icon === 'subscription') {
    const quota = source.quota
    if (quota?.extra) return <span className="deepsea-billing-group" data-deepsea-billing-group="quota"><OAuthShield /><span className="deepsea-billing-extra">Extra</span></span>
    const top = quota ? fullest(quota.windows) : undefined
    return <span className={`deepsea-billing-group${quota?.stale ? ' deepsea-billing-stale' : ''}`} data-deepsea-billing-group="quota">
      <OAuthShield />
      {top ? <span className="deepsea-billing-meter">{windowLabel(top) && <span>{windowLabel(top)}</span>}<UsageRing usedPercent={top.usedPercent} /><span>{percent(Math.round(top.usedPercent))}</span></span>
        : <span className="deepsea-billing-unknown">—</span>}
    </span>
  }
  return <span className="deepsea-billing-group" data-deepsea-billing-group="money" data-deepsea-billing-icon={source.icon}>
    <SourceGlyph icon={source.icon} />
    <span className="deepsea-billing-amount">{moneyOf(source)}</span>
  </span>
}

/**
 * The details card (stat-dialog skin): a heading naming the current billing with its rings
 * (subscription) or money on the right; a framed key/value table for the current source; with two or
 * more sources, a table of every source and a total of the money spent; then storage warnings.
 */
export function BillingCard({ sources, notes, now }: { sources: BillingSource[]; notes: BillingNote[]; now: number }) {
  const current = sources[0]!
  const quota = current.icon === 'subscription' ? current.quota : undefined
  const headItems: ReactNode = quota
    ? quota.extra ? <span className="deepsea-billing-extra">Extra</span>
      : quota.windows.map((w, i) => <span key={i} className={`deepsea-billing-head-meter${quota.stale ? ' deepsea-billing-stale' : ''}`} title={`${windowLabel(w) ?? 'Quota'} ${percent(w.usedPercent)} used`}><UsageRing usedPercent={w.usedPercent} />{windowLabel(w) && <span>{windowLabel(w)}</span>}</span>)
    : current.icon === 'subscription' ? <span className="deepsea-billing-muted">—</span> : moneyOf(current)
  const row = (key: string, label: ReactNode, value: ReactNode) => <div className="deepsea-billing-kv" key={key}><dt>{label}</dt><dd>{value}</dd></div>
  // One row per window: "<5h> Quota  [time to reset]  8% ◔"; the reset time is dropped when it equals the window length.
  const quotaRows = quota && !quota.extra ? quota.windows.map((w, i) => row(`w-${i}`, `${windowLabel(w) ?? ''} Quota`.trim(),
    <span className={`deepsea-billing-usage-line${quota.stale ? ' deepsea-billing-stale' : ''}`} title={w.resetAt !== undefined ? `Resets ${shortTime(w.resetAt)}` : undefined}>
      <span className="deepsea-billing-usage-reset">{w.resetAt !== undefined && remaining(w, now)}</span>
      <span className="deepsea-billing-usage-pct">{percent(Math.round(w.usedPercent))}</span>
      <UsageRing usedPercent={w.usedPercent} />
    </span>)) : []
  const account = current.account
  const runs: ReactNode[][] = [
    [row('provider', 'Provider', <span className="deepsea-billing-dt-icon"><SourceGlyph icon={current.icon} />{providerLabel(current)}</span>),
      ...(current.model ? [row('model', 'Model', <span title={current.model}>{modelName(current.model)}</span>)] : [])],
    [...(account?.email ?? account?.name ? [row('account', 'Account', <span title={account?.email && account?.name ? account.name : undefined}>{account?.email ?? account?.name}</span>)] : []),
      ...(account?.organization && !/'s Organization$/.test(account.organization) ? [row('org', 'Organization', account.organization)] : []),
      ...(account?.plan ? [row('plan', 'Plan', planLabel(account.plan))] : []),
      ...(current.keyHint ? [row('key', 'API Key', <span className="deepsea-billing-key">…{current.keyHint}</span>)] : [])],
    [...quotaRows, ...(quota?.extra ? [row('usage', 'Quota', <span className="deepsea-billing-extra">Extra usage</span>)] : []),
      ...(quota && now - new Date(quota.at).getTime() >= 60000 ? [row('updated', 'Updated',
        <span className={quota.stale ? 'deepsea-billing-info' : undefined} title={shortTime(quota.at)}>{compactDuration(now - new Date(quota.at).getTime())} ago</span>)] : []),
      ...(quota?.credits ? [row('credits', 'Credits', quota.credits.unlimited ? 'Unlimited' : quota.credits.balance ?? (quota.credits.hasCredits ? 'Available' : 'None'))] : [])],
    [row('requests', 'Requests', <span className="deepsea-billing-request-lines"><span><Up />{current.requests}</span>
      {gaps(current).map(([n, word]) => <span key={word} className="deepsea-billing-info"><Up />{n} {word}</span>)}</span>),
      row('cost', 'Cost', <span className="deepsea-billing-total-money">{moneyOf(current)}</span>)],
  ].filter(run => run.length)
  const spend = sources.filter(s => s.icon !== 'subscription').flatMap(s => s.cost ?? [])
  const shown = notes.filter(n => n.level === 'danger')
  return <>
    <div className="deepsea-billing-title"><span className="deepsea-billing-title-label">{billingTitle(current)}</span><span className="deepsea-billing-title-items">{headItems}</span></div>
    <div className="deepsea-billing-table">{runs.map((run, i) => <dl key={i} className="deepsea-billing-table-run">{run}</dl>)}</div>
    {sources.length > 1 && <>
      <div className="deepsea-billing-section-rule" />
      <div className="deepsea-billing-table deepsea-billing-totals"><table><tbody>
        {sources.map((source, i) => <tr key={source.key} className={`deepsea-billing-total-row${i === 0 ? ' deepsea-billing-total-current' : ''}`}>
          {/* The glyph already says OpenRouter or local; the row names only the vendor. */}
          <td className="deepsea-billing-total-name"><span className="deepsea-billing-dt-icon"><SourceGlyph icon={source.icon} /><span className="deepsea-billing-total-provider">{source.icon === 'local' ? providerLabel(source) : source.name}</span></span></td>
          <td className="deepsea-billing-source-count"><Up />{source.requests}</td>
          <td><span className="deepsea-billing-total-money">{moneyOf(source)}</span></td>
        </tr>)}
        <tr className="deepsea-billing-total-row deepsea-billing-total-sum">
          <td className="deepsea-billing-total-name"><span className="deepsea-billing-dt-icon"><SigmaIcon /><span className="deepsea-billing-total-provider">Total</span></span></td>
          <td className="deepsea-billing-source-count"><Up />{sources.reduce((n, src) => n + src.requests, 0)}</td>
          <td><span className="deepsea-billing-total-money">{spend.length ? merged(spend) : FREE}</span></td>
        </tr>
      </tbody></table></div>
    </>}
    {shown.length > 0 && <>
      <div className="deepsea-billing-section-rule" />
      <div className="deepsea-billing-notes">{shown.map(n => <div key={n.key} className="deepsea-billing-note-row deepsea-billing-danger"><IconWarningOutlineRegular size={14} /><span>{n.text}</span></div>)}</div>
    </>}
  </>
}

function useVisible(ref: RefObject<HTMLSpanElement>) {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const node = ref.current
    if (!node) return
    let intersects = false
    const update = () => setVisible(intersects && document.visibilityState !== 'hidden' && node.getClientRects().length > 0)
    const observer = new IntersectionObserver(entries => { intersects = entries[0]?.isIntersecting ?? false; update() })
    observer.observe(node)
    document.addEventListener('visibilitychange', update)
    return () => { observer.disconnect(); document.removeEventListener('visibilitychange', update) }
  }, [ref])
  return visible
}

type SnapshotState = { sessionId: string; snapshot?: BillingSnapshot; failed?: boolean; clockOffset?: number }
function useSnapshot(sessionId: string, visible: boolean, running: boolean, route?: string) {
  const [state, setState] = useState<SnapshotState>({ sessionId })
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!visible) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let active: AbortController | undefined
    let failures = 0
    const poll = async () => {
      active = new AbortController()
      const timeout = setTimeout(() => active?.abort(), 15000)
      let refreshing = false
      try {
        const query = `sessionId=${encodeURIComponent(sessionId)}${route ? `&route=${encodeURIComponent(route)}` : ''}`
        const response = await fetch(`api/deepsea-billing/snapshot?${query}`, { signal: active.signal, credentials: 'same-origin', cache: 'no-store' })
        if (!response.ok) throw new Error('Snapshot unavailable')
        const snapshot = parseSnapshot(await response.json(), sessionId)
        if (!snapshot) throw new Error('Invalid snapshot')
        failures = 0
        refreshing = snapshot.refreshing === true
        if (!stopped) setState({ sessionId, snapshot, clockOffset: snapshot.now ? new Date(snapshot.now).getTime() - Date.now() : 0 })
      } catch {
        // Never retain account evidence after an authorization/network failure.
        failures++
        if (!stopped) setState({ sessionId, failed: true })
      } finally {
        clearTimeout(timeout)
        if (!stopped) {
          setNow(Date.now())
          timer = setTimeout(() => { void poll() }, failures ? Math.min(60000, 15000 * 2 ** Math.min(failures - 1, 3)) : refreshing ? 2000 : running ? 5000 : 30000)
        }
      }
    }
    void poll()
    return () => { stopped = true; clearTimeout(timer); active?.abort() }
  }, [sessionId, visible, running, route])
  // Age readings even if the endpoint hangs.
  useEffect(() => {
    if (!visible) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [visible])
  return { state: state.sessionId === sessionId ? state : { sessionId }, now: now + (state.clockOffset ?? 0) }
}

export function BillingStatus({ sessionId, running = false, route }: { sessionId: string; running?: boolean; route?: string }) {
  const rootRef = useRef<HTMLSpanElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const visible = useVisible(rootRef)
  const { state, now } = useSnapshot(sessionId, visible, running, route)
  const snapshot = state.snapshot
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const position = useAnchoredPosition({ open: open && visible, anchorRef: rootRef, panelRef, side: 'top', gap: 8, margin: 12 })
  useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef)
  useEffect(() => { if (!visible) setOpen(false) }, [visible])
  const placed = position !== null
  useEffect(() => {
    if (!open || !placed) return
    panelRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); triggerRef.current?.focus() }
      if (event.key === 'Tab' && panelRef.current?.contains(document.activeElement)) {
        // Non-modal details: return to the trigger, then follow native DOM order.
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [open, placed])
  const failed = state.failed === true
  const notes = billingNotes(snapshot, failed)
  const summary = pillSummary(snapshot, failed)
  const danger = notes.some(n => n.level === 'danger')
  const current = snapshot?.sources[0]
  return <span className="deepsea-billing-root" ref={rootRef}>
    <Tooltip label={summary} side="top" delayMs={200} disabled={open}>
      <button type="button" className="deepsea-billing-pill" ref={triggerRef} aria-label={`Billing: ${summary}`} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={() => setOpen(!open)}>
        <CurrentPill source={current} />
        {notes.length > 0 && <span className={`deepsea-billing-note ${danger ? 'deepsea-billing-danger' : 'deepsea-billing-info'}`} data-deepsea-billing-note={danger ? 'danger' : 'info'}>
          {danger ? <IconWarningOutlineRegular size={14} /> : <IconInfoOutlineRegular size={14} />}
        </span>}
      </button>
    </Tooltip>
    {open && visible && createPortal(<div className="deepsea-billing-panel" role="dialog" aria-label="Billing details" id={panelId} ref={panelRef} tabIndex={-1} style={position ?? { visibility: 'hidden', left: 0, top: 0 }}>
      {current ? <BillingCard sources={snapshot!.sources} notes={notes} now={now} />
        : <div className="deepsea-billing-title"><span className="deepsea-billing-title-label">Billing</span><span className="deepsea-billing-title-items deepsea-billing-muted">{failed ? 'Unavailable' : 'No requests yet'}</span></div>}
    </div>, document.body)}
  </span>
}

type Report = { v: 1; sessionId: string; now: string; persistence: 'ok' | 'error'; sources: BillingSource[] }
/** The /billing result, validated like a snapshot; undefined for an error or any other text. */
export function readReport(text: string | undefined): Report | undefined {
  const value = decodeReport(text) as Report | undefined
  return value && timestamp(value.now) && value.sources.length <= 64 && value.sources.every(validSource) ? value : undefined
}
/**
 * `/billing` in the transcript: the command row, then one card per provider (this session's
 * sources first, then every other provider route), side by side, wrapping at the chat width. The
 * cards are the pill's card for that one source, as of when the command ran.
 */
function BillingCommandCard({ node }: CommandRowProps) {
  const text = node.outcome?.text
  const report = useMemo(() => readReport(text), [text])
  const state = node.outcome === null ? 'running' : node.outcome.kind === 'error' ? 'error' : 'ok'
  const now = report ? new Date(report.now).getTime() : Date.now()
  return <div className="deepsea-billing-command" data-state={state}>
    <div className="deepsea-billing-command-header">
      <span className="deepsea-billing-command-icon">{state === 'error' ? <IconWarningOutlineRegular size={14} /> : <IconCoinOutline />}</span>
      <span className="deepsea-billing-command-title">billing</span>
      {text !== undefined && <><span className="deepsea-billing-command-separator" aria-hidden /><span className="deepsea-billing-command-line">{text.split('\n')[0]}</span></>}
    </div>
    {report && <div className="deepsea-billing-command-cards">
      {report.sources.map(source => <div key={source.key} className="deepsea-billing-sheet" data-used={source.requests > 0 || undefined}>
        <BillingCard sources={[source]} notes={[]} now={now} />
      </div>)}
    </div>}
  </div>
}
/** Coin glyph for the command row. */
function IconCoinOutline() {
  return <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M10 5.9c-.3-.7-1.1-1.1-2-1.1-1.1 0-1.9.6-1.9 1.4 0 1.9 4 1 4 3 0 .8-.9 1.4-2.1 1.4-1 0-1.8-.4-2.1-1.2M8 3.9v8.2" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>
}

function BillingDock(props: PropsRuntime<'conversation.composer.dock'>) {
  const running = props.useSession(s => s.running)
  // The session's selected route (`modelSelection` projection, session-controller): tells the host which
  // subscription account to show for a session with no request recorded yet.
  const useProjection = props.useProjection as unknown as (key: string, select: (value: unknown) => string | undefined) => string | undefined
  const route = useProjection('modelSelection', value => {
    const selection = value as { next?: { provider?: string } | null; lastUsed?: { provider?: string } | null } | undefined
    return selection?.next?.provider ?? selection?.lastUsed?.provider
  })
  // Key reset closes the panel and removes old snapshot state synchronously.
  return <BillingStatus key={props.sessionId} sessionId={props.sessionId} running={running} route={route} />
}

export const name = 'deepsea-billing'
export const inject = ['slots']
export function apply(ctx: Context) {
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.deepseaBilling = ''
    style.textContent = styles
    document.head.appendChild(style)
    return () => style.remove()
  })
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({ name: 'conversation.composer.dock', id: 'deepsea-billing', order: -10 }, BillingDock))
  ctx.slots.inject('conversation.chat.commandview', () => ctx.slots.register({ name: 'conversation.chat.commandview', key: 'billing' }, BillingCommandCard))
}
