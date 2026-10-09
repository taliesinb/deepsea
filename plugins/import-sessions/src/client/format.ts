/** Small presentation helpers shared by the stages. */
import type { CSSProperties } from 'react'

export const small: CSSProperties = { fontSize: 12, opacity: 0.75 }
export const mono: CSSProperties = { fontFamily: 'var(--dsh-font-mono, ui-monospace, monospace)', fontSize: 12 }
/** Inline code on a dark rounded chip (paths, host names). */
export const codeChip: CSSProperties = { ...mono, background: 'var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.35))', border: '1px solid var(--dsw-alias-border-l4, var(--dsh-color-border, rgba(127,127,127,0.35)))', borderRadius: 5, padding: '1px 6px', whiteSpace: 'nowrap' }
export const dangerColor = 'var(--dsw-alias-state-error-primary, var(--dsh-color-danger, #d9534f))'
export const warningColor = 'var(--dsw-alias-state-warn-primary, var(--dsh-color-warning, #e0a800))'
export const successColor = 'var(--dsw-alias-state-success-primary, var(--dsh-color-success, #3c9a5f))'
export const borderColor = 'var(--dsw-alias-border-l4, var(--dsh-color-border, rgba(127,127,127,0.35)))'
export const brandColor = 'var(--dsw-alias-brand-primary, #4d6bfe)'
export const hoverBg = 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.08))'

/** Collapse the user's home directory to `~` (macOS and Linux homes; Windows left as is). */
export function tildify(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~')
}

/** Last path segment (either separator), or the path itself when it has none. */
export function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return index === -1 ? trimmed : trimmed.slice(index + 1)
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

const dayFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const dayYearFormat = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' })

/**
 * Compact date range: `Mar 3, 14:02–15:10` on one day, `Mar 3 – Mar 5` across
 * days, with the year appended when it is not the current one.
 */
export function dateRangeText(startedAt: number, endedAt: number): string {
  const start = new Date(startedAt)
  const end = new Date(endedAt >= startedAt ? endedAt : startedAt)
  const thisYear = new Date().getFullYear()
  const day = (d: Date): string => (d.getFullYear() === thisYear ? dayFormat : dayYearFormat).format(d)
  // Compact on purpose: the tree column is narrow. Same day → the day alone
  // (the row's title tooltip has the file; the summary has exact times).
  if (sameDay(start, end)) return day(start)
  return `${day(start)} – ${day(end)}`
}

/** `1 session` / `3 sessions`. */
export function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`
}

/** Compact integer with thousands separators (`12,345`). */
export function intText(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value)
}

/** Compact magnitude for token counts: `950`, `48K`, `1.2M`. */
export function compactText(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0'
  if (value < 1000) return String(Math.round(value))
  const units: Array<[number, string]> = [[1e9, 'G'], [1e6, 'M'], [1e3, 'K']]
  for (const [scale, suffix] of units) {
    if (value >= scale) {
      const scaled = value / scale
      return `${scaled >= 10 ? String(Math.round(scaled)) : scaled.toFixed(1).replace(/\.0$/, '')}${suffix}`
    }
  }
  return String(Math.round(value))
}

/** `~48K tok` — the model-visible surface estimate. */
export function tokenText(value: number): string {
  return `~${compactText(value)} tok`
}

/** Megabytes with one decimal for upload progress (`12.4 MB`). */
export function megabytesText(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 1)} MB`
}
