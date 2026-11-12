/**
 * @deepsea/tool-wait, browser half: the `wait` tool's chat row.
 *
 * The keyed `tool.call.toolview` entry for `wait` replaces the generic tool
 * card with a 24px row that fills the chat column, the reason taking what the
 * right-aligned group leaves:
 *
 *   [clock] Wait  <reason…>            ▕████░░░░▏ 4s / 10s [Skip] [Abort]
 *
 * Under 400px (a phone) the bar is dropped and the time carries the progress;
 * a settled row has no bar at all.
 * Copy and duration forms come from the `card` section of locale/*.json.
 *
 *   running   the bar fills against the SERVER clock: on mount the row asks
 *             GET ./api/deepsea-wait/status for { startedAt, deadline, now }
 *             and keeps the browser↔server offset, so a phone or another
 *             machine with a skewed clock still draws the right bar (before
 *             the answer arrives: the tool/call event time from the block).
 *             Skip / Abort POST ./api/deepsea-wait/control; the row then waits
 *             for the tool/result event like any other tool row.
 *   settled   no bar, only the verdict: "waited 10s", "skipped after 4s of
 *             10s", "aborted by user …" (error colour); an interrupted turn
 *             (registry ABORTED) reads "interrupted …" (warning colour).
 *             The outcome comes from the result's presentationMeta
 *             ({ deepsea: 'wait', outcome, waitedSeconds, … }) or the error code.
 *
 * Claiming a key suppresses the generic card for EVERY shape of that tool, so
 * the row covers running / ok / every error / missing meta.
 *
 * Job waits (`job_output` with `wait: true`) keep upstream's row, and the
 * keyed `tool.call.status` entry for `job_output` adds the countdown at the
 * right of its head line while the call runs:
 *
 *   [≡] Read job output · bash-12be…                 ▕██░░▏ 1m20s / 2m30s [Skip]
 *
 * It asks GET ./api/deepsea-wait/status for the wait the harness announced
 * (its real deadline, after tool-jobs' default and cap) and shows nothing
 * until the server knows the wait: a plain read, or a wait on a job that has
 * already settled, draws no countdown. Skip POSTs the same control route; the
 * call returns as on timeout and the job keeps running.
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only imports (erased at build time): SlotMap merges for
// 'tool.call.toolview' and the session-scope standard props.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { DisclosureRow, IconClockOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CSSProperties } from 'react'
import { useEffect, useRef, useState } from 'react'
import enLocale from '../../locale/en.json'
import zhLocale from '../../locale/zh.json'
import { formatDuration, formatElapsed } from './format.ts'

/** Dictionary namespace of the row's copy (shared with every plugin, hence the prefix). */
const NS = 'deepsea-tool-wait'
type WaitKey = keyof typeof enLocale.card

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The wait tool's chat row. */
    'deepsea-tool-wait': WaitKey
  }
}

/** English is the key-set source; the Chinese file must have every key (tests/format.test.mjs checks both ways). */
const DICTIONARIES: { en: Record<WaitKey, string>, zh: Record<WaitKey, string> } = { en: enLocale.card, zh: zhLocale.card }

type T = TranslateNS<typeof NS>
type Props = PropsRuntime<'tool.call.toolview'> & PropsLocale<typeof NS>
type StatusProps = PropsRuntime<'tool.call.status'> & PropsLocale<typeof NS>
type Block = Props['block']

/** Mirrors index.js (wire names kept from the plugin's old name, wait). Document-relative (`./api/...`): behind a path-mounting proxy `/api` would escape the mount. */
const STATUS_PATH = './api/deepsea-wait/status'
const CONTROL_PATH = './api/deepsea-wait/control'
/** First and longest delay between asks while the server does not know a job wait yet (its announcement can trail the tool/call event). */
const JOB_STATUS_RETRY_MS = [250, 5000] as const
/** Error code of the user's Abort verdict (wait.mjs USER_ABORTED_WAIT). */
const USER_ABORTED_WAIT = 'USER_ABORTED_WAIT'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSettled(block: Block): block is Extract<Block, { kind: 'tool-result' }> {
  return 'kind' in block
}

function parseArgs(block: Block): { seconds: number | undefined, reason: string } {
  const raw = isSettled(block) ? block.call?.argsRaw : 'argsRaw' in block ? block.argsRaw : undefined  // preparing calls stream arguments
  let parsed: unknown
  try { parsed = typeof raw === 'string' ? JSON.parse(raw) : undefined } catch { parsed = undefined }
  if (!isRecord(parsed)) return { seconds: undefined, reason: '' }
  const seconds = typeof parsed.seconds === 'number' && Number.isFinite(parsed.seconds) && parsed.seconds > 0 ? parsed.seconds : undefined
  const reason = typeof parsed.reason === 'string' ? parsed.reason.trim() : ''
  return { seconds, reason }
}

type Outcome = 'completed' | 'skipped' | 'aborted' | 'interrupted' | 'failed'

interface Settled {
  outcome: Outcome
  /** Seconds that actually passed (from presentationMeta, else the call→result span). */
  waited: number | undefined
  /** First line of a failure the row cannot classify. */
  error: string | undefined
}

function settledOf(block: Extract<Block, { kind: 'tool-result' }>): Settled {
  const meta = block.meta
  const span = block.callTime !== null ? (block.time - block.callTime) / 1000 : undefined
  if (!block.isError && isRecord(meta) && meta.deepsea === 'wait') {
    const waited = typeof meta.waitedSeconds === 'number' ? meta.waitedSeconds : span
    return { outcome: meta.outcome === 'skipped' ? 'skipped' : 'completed', waited, error: undefined }
  }
  if (!block.isError) return { outcome: 'completed', waited: span, error: undefined }
  const code = block.error?.code
  if (code === USER_ABORTED_WAIT) return { outcome: 'aborted', waited: span, error: undefined }
  if (code === 'ABORTED' || code === 'ABORTED_BEFORE_DISPATCH') return { outcome: 'interrupted', waited: span, error: undefined }
  const text = block.content.map(item => item.type === 'text' ? item.text : '').join('\n').trim()
  const first = (text || (block.error ? `${block.error.name}: ${block.error.code}` : 'failed')).split('\n')[0] ?? 'failed'
  return { outcome: 'failed', waited: span, error: first }
}

// ---------------------------------------------------------------- host calls

interface Status { startedAt: number, deadline: number, now: number }

async function fetchStatus(callId: string, sessionId: string): Promise<Status | undefined> {
  try {
    const response = await fetch(`${STATUS_PATH}?callId=${encodeURIComponent(callId)}&sessionId=${encodeURIComponent(sessionId)}`, { credentials: 'same-origin', cache: 'no-store' })
    if (!response.ok) return undefined
    const body: unknown = await response.json()
    if (!isRecord(body) || body.pending !== true) return undefined
    const { startedAt, deadline, now } = body
    if (typeof startedAt !== 'number' || typeof deadline !== 'number' || typeof now !== 'number') return undefined
    return { startedAt, deadline, now }
  } catch {
    return undefined
  }
}

async function control(action: 'skip' | 'abort', callId: string, sessionId: string): Promise<boolean> {
  try {
    const response = await fetch(CONTROL_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, callId, sessionId }),
    })
    return response.ok
  } catch {
    return false
  }
}

// ---------------------------------------------------------------- styles

/** Class prefix of the stylesheet `apply` installs (hover states need real CSS), kept from the plugin's old name (wait). */
const CLS = 'deepsea-wait'
const STYLE_ID = 'deepsea-wait-style'
// DisclosureRow sizes its text area to its content (max-content); the doubled
// class outranks that module rule whatever the stylesheet order, so the row's
// text area spans the column and the end group sits at its right edge. When
// space runs short the bar gives way first (down to 40px; none under 400px),
// then the reason; a failure's message shares the shortage with the reason.
const STYLESHEET = `
.${CLS}-area.${CLS}-area { flex: 1 1 auto; width: auto; min-width: 0; }
.${CLS}-layout.${CLS}-layout { width: 100%; }
.${CLS}-content { container-type: inline-size; display: flex; align-items: center; flex: 1 1 auto; min-width: 0; gap: 8px; margin-left: 8px; font-size: var(--dsh-content-font-size-secondary, 13px); color: var(--dsw-alias-label-secondary); }
.${CLS}-reason { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: 0.8; }
.${CLS}-end { display: flex; align-items: center; flex: 0 1000 auto; gap: 8px; margin-left: auto; white-space: nowrap; }
.${CLS}-end[data-deepsea-wait-outcome='failed'] { flex-shrink: 1; min-width: 0; }
.${CLS}-track { position: relative; flex: 0 1 120px; min-width: 40px; height: 6px; border-radius: 3px; overflow: hidden; background: color-mix(in srgb, currentColor 12%, transparent); }
@container (max-width: 400px) { .${CLS}-track { display: none; } }
.${CLS}-fill { position: absolute; inset: 0 auto 0 0; border-radius: 3px; background: var(--dsw-alias-state-business-primary, #3b82f6); }
.${CLS}-time { flex: none; display: inline-grid; justify-items: end; font-variant-numeric: tabular-nums; white-space: nowrap; opacity: 0.85; }
.${CLS}-time > * { grid-area: 1 / 1; }
.${CLS}-time-widest { visibility: hidden; }
.${CLS}-verdict { flex: none; white-space: nowrap; }
.${CLS}-verdict[data-deepsea-wait-outcome='failed'] { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.${CLS}-verdict[data-deepsea-wait-outcome='aborted'] { color: var(--dsw-alias-state-error-primary, #e5484d); }
.${CLS}-verdict[data-deepsea-wait-outcome='interrupted'] { color: var(--dsw-alias-state-warn-primary, #d97706); }
.${CLS}-buttons { display: inline-flex; flex: none; gap: 4px; }
.${CLS}-button { appearance: none; flex: none; white-space: nowrap; height: 20px; padding: 0 8px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 20%, transparent)); background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: var(--dsh-content-font-size-secondary, 12px); line-height: 18px; cursor: pointer; }
.${CLS}-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, currentColor 8%, transparent)); color: var(--dsw-alias-label-primary); }
.${CLS}-button[data-deepsea-wait-danger]:hover:not(:disabled) { color: var(--dsw-alias-state-error-primary, #e5484d); border-color: var(--dsw-alias-state-error-primary, #e5484d); }
.${CLS}-button:disabled { opacity: 0.5; cursor: default; }
.${CLS}-status { display: flex; align-items: center; gap: 8px; height: calc(24px + var(--dsh-content-font-delta, 0px)); white-space: nowrap; font-size: var(--dsh-content-font-size-secondary, 13px); color: var(--dsw-alias-label-secondary); }
.${CLS}-status .${CLS}-track { flex: none; width: 80px; }
@media (max-width: 640px) { .${CLS}-status .${CLS}-track { display: none; } }
`

// Typed like the shipped ToolRow / DisclosureRow title: the secondary content
// size follows the Settings font-size preference (a fixed 13px would render
// larger than an 11px title).
const ROW_STYLE: CSSProperties = { fontSize: 'var(--dsh-content-font-size-secondary, 13px)', lineHeight: 'calc(24px + var(--dsh-content-font-delta, 0px))' }

// ---------------------------------------------------------------- the row

/** 100 ms ticker while the wait runs; nothing while settled. */
function useTicker(active: boolean): number {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!active) return
    const id = window.setInterval(() => setTick(t => t + 1), 100)
    return () => window.clearInterval(id)
  }, [active])
  return tick
}

function RunningContent({ callId, sessionId, block, seconds, reason, t }: { callId: string, sessionId: string, block: Extract<Block, { argsRaw: string }>, seconds: number | undefined, reason: string, t: T }) {
  // Server-clock anchor: { startedAt, deadline } on the server clock plus the browser→server offset.
  const [anchor, setAnchor] = useState<{ startedAt: number, deadline: number, offset: number } | undefined>(undefined)
  const [busy, setBusy] = useState<'skip' | 'abort' | undefined>(undefined)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    let cancelled = false
    void fetchStatus(callId, sessionId).then((status) => {
      if (cancelled || status === undefined) return
      setAnchor({ startedAt: status.startedAt, deadline: status.deadline, offset: status.now - Date.now() })
    })
    return () => { cancelled = true; mounted.current = false }
  }, [callId, sessionId])
  useTicker(true)

  const requestedMs = anchor !== undefined ? anchor.deadline - anchor.startedAt : (seconds ?? 0) * 1000
  const startedAt = anchor?.startedAt ?? block.time
  const now = Date.now() + (anchor?.offset ?? 0)
  const elapsedMs = Math.max(0, now - startedAt)
  // Hold at 99 % until the result event lands: the bar must never claim "done" before the tool did.
  const fraction = requestedMs > 0 ? Math.min(0.99, elapsedMs / requestedMs) : 0
  const total = requestedMs / 1000
  const totalText = formatDuration(total, t)
  // The clock's widest text, reserved up front so the bar does not shift as digits are added.
  const widest = [total, total - 1].map(at => t('progress', { elapsed: formatElapsed(at, t), total: totalText })).reduce((a, b) => b.length > a.length ? b : a)

  const verdict = (action: 'skip' | 'abort') => {
    if (busy !== undefined) return
    setBusy(action)
    void control(action, callId, sessionId).then(() => { if (mounted.current) setBusy(undefined) })
  }

  return (
    <span className={`${CLS}-content`} data-deepsea-wait-outcome="running">
      {reason !== '' && <span className={`${CLS}-reason`} title={reason}>{reason}</span>}
      <span className={`${CLS}-end`}>
        <span className={`${CLS}-track`} role="progressbar" aria-label={t('progress.aria')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)}>
          <span className={`${CLS}-fill`} style={{ width: `${fraction * 100}%` }} />
        </span>
        <span className={`${CLS}-time`}>
          <span className={`${CLS}-time-widest`} aria-hidden="true">{widest}</span>
          <span>{t('progress', { elapsed: formatElapsed(elapsedMs / 1000, t), total: totalText })}</span>
        </span>
        <span className={`${CLS}-buttons`}>
          <button type="button" className={`${CLS}-button`} disabled={busy !== undefined} onClick={(event) => { event.stopPropagation(); verdict('skip') }}>{t('skip')}</button>
          <button type="button" className={`${CLS}-button`} data-deepsea-wait-danger disabled={busy !== undefined} onClick={(event) => { event.stopPropagation(); verdict('abort') }}>{t('abort')}</button>
        </span>
      </span>
    </span>
  )
}

function verdictText(settled: Settled, requested: number | undefined, t: T): string {
  const waited = settled.waited !== undefined ? formatDuration(settled.waited, t) : undefined
  const total = requested !== undefined ? formatDuration(requested, t) : undefined
  const stopped = (outcome: string): string => waited === undefined ? outcome
    : total === undefined ? t('verdict.after', { outcome, waited })
      : t('verdict.afterOf', { outcome, waited, total })
  switch (settled.outcome) {
    case 'completed': {
      const duration = total ?? waited
      return duration !== undefined ? t('verdict.waited', { duration }) : t('verdict.done')
    }
    case 'skipped': return stopped(t('outcome.skipped'))
    case 'aborted': return stopped(t('outcome.aborted'))
    case 'interrupted': return stopped(t('outcome.interrupted'))
    case 'failed': return settled.error ?? t('verdict.failed')
  }
}

function SettledContent({ block, seconds, reason, t }: { block: Extract<Block, { kind: 'tool-result' }>, seconds: number | undefined, reason: string, t: T }) {
  const settled = settledOf(block)
  return (
    <span className={`${CLS}-content`} data-deepsea-wait-outcome={settled.outcome}>
      {reason !== '' && <span className={`${CLS}-reason`} title={reason}>{reason}</span>}
      <span className={`${CLS}-end`} data-deepsea-wait-outcome={settled.outcome}>
        <span className={`${CLS}-verdict`} data-deepsea-wait-outcome={settled.outcome}>{verdictText(settled, seconds, t)}</span>
      </span>
    </span>
  )
}

/**
 * Leading glyph: the clock alone. The 16px leading box has no room for a
 * StateDot beside it (the pair renders squashed); the row's state is carried
 * by the bar (moving / colour) and the verdict text instead.
 */
const LEADING = <IconClockOutlineRegular size={14} />

const AREA = `${CLS}-area`
const LAYOUT = `${CLS}-layout`

export function WaitRow({ callId, block, sessionId, t }: Props) {
  const { seconds, reason } = parseArgs(block)
  const session = String(sessionId)
  if (!isSettled(block)) {
    // `data-tool` / `data-state` as on the shipped ToolRow.
    return (
      <div style={ROW_STYLE} data-tool="wait" data-state="running">
        <DisclosureRow icon={LEADING} title={t('title')} open={false} expandable={false} onToggle={() => {}}
          contentClassName={AREA} contentLayoutClassName={LAYOUT}
          collapsedContent={'argsRaw' in block ? <RunningContent callId={callId} sessionId={session} block={block} seconds={seconds} reason={reason} t={t} /> : undefined} />
      </div>
    )
  }
  const settled = settledOf(block)
  const state = settled.outcome === 'aborted' || settled.outcome === 'failed' ? 'error' : settled.outcome === 'interrupted' ? 'stopped' : 'ok'
  return (
    <div style={ROW_STYLE} data-tool="wait" data-state={state}>
      <DisclosureRow icon={LEADING} title={t('title')} open={false} expandable={false} onToggle={() => {}}
        contentClassName={AREA} contentLayoutClassName={LAYOUT}
        collapsedContent={<SettledContent block={block} seconds={seconds} reason={reason} t={t} />} />
    </div>
  )
}

// ---------------------------------------------------------------- job waits

/**
 * The countdown and Skip of a running `job_output` wait, in the call's
 * `tool.call.status` cell. Nothing for a plain read, and nothing until the
 * server knows the wait (the root row's status route answers for job waits).
 */
export function JobWaitStatus({ callId, args, sessionId, t }: StatusProps) {
  const waiting = args.value('wait') === true
  const session = String(sessionId)
  const [anchor, setAnchor] = useState<{ startedAt: number, deadline: number, offset: number } | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    if (!waiting) return () => { mounted.current = false }
    let cancelled = false
    let timer: number | undefined
    const ask = async (delay: number): Promise<void> => {
      const status = await fetchStatus(callId, session)
      if (cancelled) return
      if (status !== undefined) {
        setAnchor({ startedAt: status.startedAt, deadline: status.deadline, offset: status.now - Date.now() })
        return
      }
      timer = window.setTimeout(() => { void ask(Math.min(delay * 2, JOB_STATUS_RETRY_MS[1])) }, delay)
    }
    void ask(JOB_STATUS_RETRY_MS[0])
    return () => { cancelled = true; window.clearTimeout(timer); mounted.current = false }
  }, [waiting, callId, session])
  useTicker(anchor !== undefined)
  if (anchor === undefined) return null

  const requestedMs = Math.max(0, anchor.deadline - anchor.startedAt)
  const elapsedMs = Math.min(requestedMs, Math.max(0, Date.now() + anchor.offset - anchor.startedAt))
  // Hold at 99 % until the result event lands, as the wait row does.
  const fraction = requestedMs > 0 ? Math.min(0.99, elapsedMs / requestedMs) : 0
  const total = requestedMs / 1000
  const totalText = formatDuration(total, t)
  const widest = [total, total - 1].map(at => t('progress', { elapsed: formatElapsed(at, t), total: totalText })).reduce((a, b) => b.length > a.length ? b : a)
  const skip = () => {
    if (busy) return
    setBusy(true)
    // The cell stays until the tool/result event ends the call; a failed POST re-enables Skip.
    void control('skip', callId, session).then((ok) => { if (mounted.current && !ok) setBusy(false) })
  }
  return (
    <span className={`${CLS}-status`} data-deepsea-wait-outcome="running" data-deepsea-wait-call={callId}>
      <span className={`${CLS}-track`} role="progressbar" aria-label={t('job.progress.aria')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)}>
        <span className={`${CLS}-fill`} style={{ width: `${fraction * 100}%` }} />
      </span>
      <span className={`${CLS}-time`}>
        <span className={`${CLS}-time-widest`} aria-hidden="true">{widest}</span>
        <span>{t('progress', { elapsed: formatElapsed(elapsedMs / 1000, t), total: totalText })}</span>
      </span>
      <button type="button" className={`${CLS}-button`} disabled={busy} onClick={skip}>{t('skip')}</button>
    </span>
  )
}

// ---------------------------------------------------------------- plugin

export const name = 'deepsea-tool-wait'
export const inject = ['slots', 'locale']

export function apply(ctx: Context): void {
  // Hover/disabled states need a real stylesheet; one <style> per plugin lifetime.
  ctx.effect(() => {
    document.getElementById(STYLE_ID)?.remove()
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = STYLESHEET
    document.head.append(style)
    return () => { style.remove() }
  }, 'tool-wait: stylesheet')

  ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'tool-wait: dictionaries')
  ctx.slots.inject('tool.call.toolview', () =>
    ctx.slots.register({ name: 'tool.call.toolview', key: 'wait', locale: NS }, WaitRow))
  // job_output keeps upstream's row; the countdown is its status cell (harness topic job-wait-release).
  ctx.slots.inject('tool.call.status', () =>
    ctx.slots.register({ name: 'tool.call.status', key: 'job_output', locale: NS }, JobWaitStatus))
}
