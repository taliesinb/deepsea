/**
 * The card's pure part: which icon and which short state each row shows,
 * the permission names, and the compact durations. No React, no DOM, so
 * node:test runs it with type stripping (tests/client-model.test.mjs).
 */

/** A row as the card gets it: the result's presentationMeta, or the status route's snapshot. */
export interface Row {
  id: string
  name?: string
  /** The agent's one sentence: what it will do with the permission. */
  justification?: string
  state: string
  status?: string
  already?: boolean
  waitedSeconds?: number
  grantingSince?: number
  grantedAt?: number
}

export type Icon = 'granted' | 'open' | 'closed' | 'checking'

/** Tick for granted, question mark while it may still be granted, cross once it will not be. */
export function iconOf(row: Row): Icon {
  if (row.state === 'granted') return 'granted'
  if (row.state === 'pending' || row.state === 'granting') return 'open'
  if (row.state === 'checking') return 'checking'
  return 'closed'
}

/** Whether a row takes Grant and Deny (while its call runs). */
export function isOpen(row: Row): boolean {
  return row.state === 'pending' || row.state === 'granting'
}

export type StateKey = 'state.checking' | 'state.granted' | 'state.grantedAfter' | 'state.pending' | 'state.switchedOff' | 'state.stale'
  | 'state.notRunning' | 'state.granting' | 'state.grantingStale' | 'state.denied' | 'state.restricted' | 'state.notInstalled'
  | 'state.cancelled' | 'state.notApplicable'

/** Seconds a granted row waited, from the value (waitedSeconds) or the snapshot (grantedAt - grantingSince). */
export function waitedOf(row: Row): number | undefined {
  if (typeof row.waitedSeconds === 'number') return row.waitedSeconds
  if (typeof row.grantedAt === 'number' && typeof row.grantingSince === 'number') return (row.grantedAt - row.grantingSince) / 1000
  return undefined
}

/** The short state's dictionary key. */
export function stateKeyOf(row: Row): StateKey {
  switch (row.state) {
    case 'checking': return 'state.checking'
    case 'granted': return !row.already && waitedOf(row) !== undefined ? 'state.grantedAfter' : 'state.granted'
    case 'pending':
      if (row.status === 'stale') return 'state.stale'
      if (row.status === 'denied') return 'state.switchedOff'
      if (row.status === 'not-running') return 'state.notRunning'
      return 'state.pending'
    case 'granting': return row.status === 'stale' ? 'state.grantingStale' : 'state.granting'
    case 'denied': return 'state.denied'
    case 'unavailable': return row.status === 'restricted' ? 'state.restricted' : 'state.notInstalled'
    case 'not-applicable': return 'state.notApplicable'
    default: return 'state.cancelled'
  }
}

export type NameKey = 'perm.screen-recording' | 'perm.accessibility' | 'perm.microphone' | 'perm.camera' | 'perm.input-monitoring' | 'perm.full-disk-access' | 'perm.automation'
const FIXED = new Set(['screen-recording', 'accessibility', 'microphone', 'camera', 'input-monitoring', 'full-disk-access'])

/** A translate function narrowed to the keys this module uses. */
export type Translate = (key: string, params?: Record<string, string | number>) => string

/** The permission's name in the reader's language; Automation keeps the target app's own name. */
export function nameOf(row: Row, t: Translate): string {
  if (FIXED.has(row.id)) return t(`perm.${row.id}` as NameKey)
  if (row.id.startsWith('automation:')) {
    const app = row.name?.startsWith('Automation: ') ? row.name.slice('Automation: '.length) : row.id.slice('automation:'.length)
    return t('perm.automation', { app })
  }
  return row.name ?? row.id
}

/** Rows before any answer, from the call's arguments (what the model asked for). */
export function rowsFromArgs(argsRaw: unknown, state: string): Row[] {
  let parsed: unknown
  try { parsed = typeof argsRaw === 'string' ? JSON.parse(argsRaw) : undefined } catch { parsed = undefined }
  const list = typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { permissions?: unknown }).permissions)
    ? (parsed as { permissions: unknown[] }).permissions
    : []
  const rows: Row[] = []
  for (const entry of list) {
    if (typeof entry === 'string' && entry.trim() !== '') { rows.push({ id: entry.trim(), state }); continue }
    if (typeof entry !== 'object' || entry === null) continue
    const { permission, justification } = entry as { permission?: unknown, justification?: unknown }
    if (typeof permission !== 'string' || permission.trim() === '') continue
    rows.push({ id: permission.trim(), state, ...typeof justification === 'string' && justification.trim() !== '' ? { justification: justification.trim() } : {} })
  }
  return rows
}

/** Compact durations: `4s`, `2m5s`, `1h5m`. */
export function formatDuration(seconds: number, t: Translate): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0
  const whole = Math.round(seconds)
  if (whole < 60) return t('duration.s', { s: whole })
  const h = Math.floor(whole / 3600)
  const m = Math.floor((whole % 3600) / 60)
  const s = whole % 60
  if (h > 0) return m > 0 ? t('duration.hm', { h, m }) : t('duration.h', { h })
  return s > 0 ? t('duration.ms', { m, s }) : t('duration.m', { m })
}

/** The short state's text. */
export function stateText(row: Row, t: Translate): string {
  const key = stateKeyOf(row)
  if (key === 'state.grantedAfter') return t(key, { duration: formatDuration(waitedOf(row) ?? 0, t) })
  return t(key)
}
